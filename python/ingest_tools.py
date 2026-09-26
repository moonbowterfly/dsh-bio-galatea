"""Ingest local candidate sources into a deterministic JSONL ledger."""
import csv
import glob as globlib
import hashlib
import json
import math
import os
import tempfile


DEFAULT_GLOBS = ["*.pdb", "*.ent", "*.cif", "*.mmcif"]
SUPPORTED_EXTENSIONS = {".pdb", ".ent", ".cif", ".mmcif"}
STRUCTURE_ROLES = {
    "design_backbone", "generator_output", "cofold", "monomer_refold",
    "relaxed", "target", "other",
}
STRUCTURE_FIELDS = (
    "path", "sha256", "role", "predictor", "model", "seed",
    "binder_chain", "target_chains",
)
FIELDS = (
    "design_id", "target_id", "target_sha256", "sequence", "seq_sha1",
    "sequence_group_id", "binder_chain", "generator", "generator_run",
    "backbone_id", "parent_id", "round", "hotspot_set", "raw_scores",
    "source", "source_record_id", "source_batch_id", "source_uid",
    "structures", "provenance", "lineage_root", "lineage_id",
    "lineage_depth", "lineage_status",
)
AA3_TO_1 = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
}


class IngestError(ValueError):
    """Expected input, identity, or ledger validation error."""


def _stable_key(value):
    value = str(value)
    return value.casefold(), value


def _record_key(row):
    return row["target_id"], row["design_id"]


def _sort_record_key(row):
    return _stable_key(row["design_id"]) + _stable_key(row["target_id"])


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _optional_string(value, field):
    if _is_blank(value):
        return None
    if not isinstance(value, str):
        value = str(value)
    value = value.strip()
    return value or None


def _parse_collection(value, field, expected_type):
    if value is None or value == "":
        return expected_type()
    if isinstance(value, expected_type):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            if expected_type is list:
                return [part.strip() for part in value.replace(";", ",").split(",") if part.strip()]
            raise IngestError(f"{field} must be a JSON object")
        if isinstance(parsed, expected_type):
            return parsed
    raise IngestError(f"{field} must be a {expected_type.__name__}")


def _round_value(value):
    if _is_blank(value):
        return None
    if isinstance(value, bool):
        raise IngestError("round must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise IngestError("round must be an integer") from exc
    if isinstance(value, float) and not value.is_integer():
        raise IngestError("round must be an integer")
    if isinstance(value, str) and str(parsed) != value.strip():
        raise IngestError("round must be an integer")
    return parsed


def _as_file_path(value, base_dir=None, kind="structure"):
    path = os.path.expanduser(os.fspath(value))
    if not os.path.isabs(path) and base_dir:
        path = os.path.join(base_dir, path)
    path = os.path.realpath(path)
    if not os.path.isfile(path):
        raise IngestError(f"{kind} file not found: {path}")
    if kind == "structure" and os.path.splitext(path)[1].lower() not in SUPPORTED_EXTENSIONS:
        raise IngestError(f"unsupported structure extension: {path}")
    return path


def _canonical_target_sequence(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise IngestError("target_sequence must be a string")
    canonical = "".join(value.split()).upper()
    return canonical or None


def _target_sha256(raw, args):
    target_sequence = raw.get("target_sequence", args.get("target_sequence"))
    canonical = _canonical_target_sequence(target_sequence)
    supplied = _optional_string(raw.get("target_sha256"), "target_sha256")
    if canonical is not None:
        calculated = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        if supplied and supplied.lower() != calculated:
            raise IngestError("target_sha256 does not match canonical target_sequence")
        return calculated
    if supplied:
        supplied = supplied.lower()
        if len(supplied) != 64 or any(ch not in "0123456789abcdef" for ch in supplied):
            raise IngestError("target_sha256 must be a 64-character SHA256 hex digest")
    return supplied


def _parse_chain_list(value, field):
    if value is None or value == "":
        return None
    if isinstance(value, str):
        values = [part.strip() for part in value.split(",") if part.strip()]
    elif isinstance(value, (list, tuple)):
        values = [str(part).strip() for part in value if str(part).strip()]
    else:
        raise IngestError(f"{field} must be a string or list of chain IDs")
    if len(values) != len(set(values)):
        raise IngestError(f"{field} must contain unique chain IDs")
    return sorted(values, key=_stable_key)


def _numeric_score(value):
    if not isinstance(value, str):
        return value
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return value
    return number if math.isfinite(number) else value


def _score_key(key, namespace):
    key = str(key).strip()
    if not key:
        raise IngestError("raw_scores keys must be non-empty")
    if "." in key:
        return key
    namespace = str(namespace or "source").strip()
    return f"{namespace}.{key}"


def _normalise_score_schema(raw_schema, namespace):
    if raw_schema is None or raw_schema == "":
        return {}
    if not isinstance(raw_schema, dict):
        raise IngestError("score_schema must be an object")
    result = {}
    for key, metadata in raw_schema.items():
        if not isinstance(metadata, dict):
            raise IngestError(f"score_schema entry for {key!r} must be an object")
        direction = metadata.get("direction")
        version = _optional_string(metadata.get("version"), "score_schema.version")
        if direction not in ("higher_better", "lower_better"):
            raise IngestError(f"score_schema direction for {key!r} must be higher_better or lower_better")
        if not version:
            raise IngestError(f"score_schema version for {key!r} is required")
        normalized_key = _score_key(key, namespace)
        item = {"direction": direction, "version": version}
        if normalized_key in result and result[normalized_key] != item:
            raise IngestError(f"conflicting score_schema entries for {normalized_key}")
        result[normalized_key] = item
    return result


def _extract_structure(path, binder_chain=None):
    # Reuse contact_tools' CIF parser so a missing optional occupancy column defaults to 1.0.
    from contact_tools import _parse_model, _protein_residues

    try:
        model = _parse_model(path)
    except Exception as exc:
        raise IngestError(f"could not parse structure {path}: {type(exc).__name__}: {exc}") from exc
    chains = [(str(chain.id), chain, _protein_residues(chain)) for chain in model.get_chains()]
    chains = [entry for entry in chains if entry[2]]
    if not chains:
        raise IngestError(f"structure has no protein chains: {path}")
    if binder_chain is not None:
        matches = [entry for entry in chains if entry[0] == binder_chain]
        if not matches:
            raise IngestError(f"binder chain {binder_chain!r} not found in {path}; available: {[x[0] for x in chains]}")
        selected = matches[0]
    else:
        selected = min(chains, key=lambda entry: (len(entry[2]), _stable_key(entry[0])))
    chain_id, _chain, residues = selected
    sequence = []
    skipped = []
    for residue in residues:
        name = residue.get_resname().strip().upper()
        one_letter = AA3_TO_1.get(name)
        if one_letter is None:
            skipped.append(name)
        else:
            sequence.append(one_letter)
    all_chain_ids = sorted((entry[0] for entry in chains), key=_stable_key)
    return chain_id, "".join(sequence) or None, skipped, all_chain_ids


def _structure_metadata(path, item, defaults, design_id, warnings, sequence=None):
    if isinstance(item, str):
        item = {"path": item}
    if not isinstance(item, dict) or _is_blank(item.get("path")):
        raise IngestError("each structures entry must be a path or object with path")
    path = _as_file_path(item["path"], defaults.get("base_dir"), "structure")
    role = item.get("role") or defaults.get("structure_role")
    if role is None or role == "":
        role = "other"
        warnings.append(f"{design_id}: structure role unresolved; using other for {path}")
    if role not in STRUCTURE_ROLES:
        raise IngestError(f"invalid structure role {role!r}; expected one of {sorted(STRUCTURE_ROLES)}")

    binder_chain = _optional_string(item.get("binder_chain") or defaults.get("binder_chain"), "binder_chain")
    target_chains = _parse_chain_list(item.get("target_chains"), "target_chains")
    need_parse = (role == "target" and target_chains is None) or (role != "target" and
                 (binder_chain is None or target_chains is None or sequence is None))
    parsed_sequence = sequence
    skipped = []
    chain_ids = []
    if need_parse:
        parsed_chain, parsed_sequence, skipped, chain_ids = _extract_structure(path, binder_chain)
        if role != "target" and binder_chain is None:
            binder_chain = parsed_chain
    if role == "target":
        binder_chain = None
        target_chains = target_chains if target_chains is not None else chain_ids
        parsed_sequence = None
    else:
        if binder_chain is None:
            raise IngestError(f"could not resolve binder_chain for {path}")
        if target_chains is None:
            if not chain_ids:
                _chain, _sequence, _skipped, chain_ids = _extract_structure(path, binder_chain)
                skipped.extend(_skipped)
            target_chains = [chain_id for chain_id in chain_ids if chain_id != binder_chain]
    if skipped:
        warnings.append(f"{design_id}: skipped non-standard residues in binder chain {binder_chain}: " +
                        ",".join(sorted(skipped)))
    normalized = {
        "path": path,
        "sha256": _sha256_file(path),
        "role": role,
        "predictor": _optional_string(item.get("predictor") or defaults.get("predictor"), "predictor"),
        "model": _optional_string(item.get("model") or defaults.get("model"), "model"),
        "seed": item.get("seed", defaults.get("seed")),
        "binder_chain": binder_chain,
        "target_chains": sorted(set(target_chains or []), key=_stable_key),
    }
    supplied_hash = item.get("sha256")
    if supplied_hash and str(supplied_hash).lower() != normalized["sha256"]:
        raise IngestError(f"structure sha256 mismatch for {path}")
    if normalized["seed"] is not None and (isinstance(normalized["seed"], bool) or
                                               not isinstance(normalized["seed"], (int, str))):
        raise IngestError("structure seed must be a string, integer, or null")
    return normalized, parsed_sequence


def _normalise_structures(value, defaults, design_id, warnings, sequence=None):
    if value is None or value == "":
        values = []
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            parsed = value
        values = parsed if isinstance(parsed, list) else [parsed]
    elif isinstance(value, (list, tuple)):
        values = list(value)
    else:
        raise IngestError("structures must be a list of paths or structure objects")
    result = []
    sequences = []
    seen_paths = set()
    for item in values:
        normalized, parsed_sequence = _structure_metadata(None, item, defaults, design_id, warnings, sequence)
        if normalized["path"] not in seen_paths:
            result.append(normalized)
            seen_paths.add(normalized["path"])
        if parsed_sequence:
            sequences.append(parsed_sequence)
    return result, (sequence or (sequences[0] if sequences else None))


def _candidate_row(raw, source_type, source_path, source_sha256, args, warnings,
                   scores_path=None, base_dir=None, default_design_id=None):
    if not isinstance(raw, dict):
        raise IngestError("each candidate must be a JSON object")
    design_id = _optional_string(raw.get("design_id") or default_design_id, "design_id")
    if not design_id:
        raise IngestError("missing design_id")
    target_id = _optional_string(raw.get("target_id") or args.get("target_id"), "target_id")
    if not target_id:
        raise IngestError(f"missing target_id for design_id {design_id}")
    generator = _optional_string(raw.get("generator"), "generator")
    generator_run = _optional_string(raw.get("generator_run"), "generator_run")
    source = _optional_string(raw.get("source") or args.get("source") or generator or source_type, "source")
    if not source:
        raise IngestError(f"missing source for design_id {design_id}")
    source_record_id = _optional_string(raw.get("source_record_id"), "source_record_id") or f"{target_id}:{design_id}"

    sequence = _optional_string(raw.get("sequence"), "sequence")
    target_sha256 = _target_sha256(raw, args)
    seq_sha1 = hashlib.sha1(sequence.encode("utf-8")).hexdigest() if sequence is not None else None
    sequence_group_id = hashlib.sha1((target_id + "|" + sequence).encode("utf-8")).hexdigest() if sequence is not None else None
    binder_chain = _optional_string(raw.get("binder_chain") or args.get("binder_chain"), "binder_chain")
    score_namespace = raw.get("score_namespace") or args.get("score_namespace") or generator or source
    raw_scores_input = _parse_collection(raw.get("raw_scores"), "raw_scores", dict)
    raw_scores = {}
    for key, value in raw_scores_input.items():
        raw_scores[_score_key(key, score_namespace)] = _numeric_score(value)

    known = set(FIELDS) | {
        "score_schema", "target_sequence", "score_namespace", "scores",
    }
    for key, value in raw.items():
        if key not in known and not _is_blank(value):
            raw_scores.setdefault(_score_key(key, score_namespace), _numeric_score(value))

    defaults = {
        "base_dir": base_dir,
        "structure_role": args.get("structure_role"),
        "binder_chain": binder_chain,
        "predictor": args.get("predictor"),
        "model": args.get("model"),
        "seed": args.get("seed"),
    }
    structures, sequence = _normalise_structures(raw.get("structures"), defaults, design_id, warnings, sequence)
    if sequence is not None:
        seq_sha1 = hashlib.sha1(sequence.encode("utf-8")).hexdigest()
        sequence_group_id = hashlib.sha1((target_id + "|" + sequence).encode("utf-8")).hexdigest()

    row = {
        "design_id": design_id,
        "target_id": target_id,
        "target_sha256": target_sha256,
        "sequence": sequence,
        "seq_sha1": seq_sha1,
        "sequence_group_id": sequence_group_id,
        "binder_chain": binder_chain or (structures[0]["binder_chain"] if structures else None),
        "generator": generator,
        "generator_run": generator_run,
        "backbone_id": _optional_string(raw.get("backbone_id"), "backbone_id"),
        "parent_id": _optional_string(raw.get("parent_id"), "parent_id"),
        "round": _round_value(raw.get("round")),
        "hotspot_set": _parse_collection(raw.get("hotspot_set"), "hotspot_set", list),
        "raw_scores": raw_scores,
        "source": source,
        "source_record_id": source_record_id,
        "source_batch_id": None,
        "source_uid": f"{source}:{generator_run or ''}:{source_record_id}",
        "structures": structures,
        "provenance": {
            "source_type": source_type,
            "source_path": source_path,
            "source_sha256": source_sha256,
            "scores_path": scores_path,
        },
        "lineage_root": None,
        "lineage_id": None,
        "lineage_depth": None,
        "lineage_status": None,
        "_score_schema": _normalise_score_schema(raw.get("score_schema") or args.get("score_schema"), score_namespace),
    }
    if not all(isinstance(item, str) for item in row["hotspot_set"]):
        raise IngestError("hotspot_set entries must be strings")
    row["hotspot_set"] = list(dict.fromkeys(row["hotspot_set"]))
    if sequence is None:
        row["seq_sha1"] = None
        row["sequence_group_id"] = None
    return row


def _read_candidate_file(path):
    extension = os.path.splitext(path)[1].lower()
    if extension == ".csv":
        with open(path, "r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise IngestError("CSV candidates_file must have a header row")
            return [dict(row) for row in reader]
    if extension == ".jsonl":
        rows = []
        with open(path, "r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise IngestError(f"invalid JSONL at line {line_number}: {exc.msg}") from exc
        return rows
    if extension != ".json":
        raise IngestError("candidates_file extension must be .csv, .json, or .jsonl")
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise IngestError(f"invalid candidates JSON: {exc.msg}") from exc
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data["records"]
    if isinstance(data, dict) and "design_id" in data:
        return [data]
    if isinstance(data, dict):
        rows = []
        for design_id, values in data.items():
            if not isinstance(values, dict):
                raise IngestError("JSON candidate mapping values must be objects")
            row = dict(values)
            row.setdefault("design_id", design_id)
            rows.append(row)
        return rows
    raise IngestError("candidates JSON must be an object or array")


def _read_scores_file(path, scores_key):
    extension = os.path.splitext(path)[1].lower()
    if extension == ".csv":
        with open(path, "r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or scores_key not in reader.fieldnames:
                raise IngestError(f"scores_file CSV must include {scores_key!r} column")
            rows = [dict(row) for row in reader]
    elif extension == ".json":
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                data = json.load(handle)
        except json.JSONDecodeError as exc:
            raise IngestError(f"invalid scores JSON: {exc.msg}") from exc
        if isinstance(data, list):
            rows = data
        elif isinstance(data, dict) and scores_key in data:
            rows = [data]
        elif isinstance(data, dict):
            rows = []
            for design_id, values in data.items():
                if not isinstance(values, dict):
                    raise IngestError("scores JSON mapping values must be objects")
                row = dict(values)
                row.setdefault(scores_key, design_id)
                rows.append(row)
        else:
            raise IngestError("scores JSON must be an object or array")
    else:
        raise IngestError("scores_file extension must be .csv or .json")

    result = {}
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise IngestError(f"scores row {index} must be an object")
        design_id = _optional_string(row.get(scores_key), scores_key)
        if not design_id:
            raise IngestError(f"scores row {index} is missing {scores_key}")
        if design_id in result:
            raise IngestError(f"duplicate scores key: {design_id}")
        result[design_id] = {
            str(key): _numeric_score(value) for key, value in row.items()
            if key != scores_key and not _is_blank(value)
        }
    return result


def _structure_records(items, source_type, source_path, source_sha256, args, warnings):
    rows = []
    for entry in items:
        item = {"path": entry} if isinstance(entry, str) else dict(entry)
        if _is_blank(item.get("path")):
            raise IngestError("each structures entry must be a path or object with path")
        path = _as_file_path(item["path"])
        design_id = _optional_string(item.get("design_id"), "design_id") or os.path.splitext(os.path.basename(path))[0]
        if not design_id:
            raise IngestError(f"could not infer design_id from structure path: {path}")
        explicit_role = item.get("role") or args.get("structure_role")
        if explicit_role is None or explicit_role == "":
            role = "other"
            warnings.append(f"{design_id}: structure role unresolved; using other for {path}")
        else:
            role = explicit_role
        if role not in STRUCTURE_ROLES:
            raise IngestError(f"invalid structure role {role!r}; expected one of {sorted(STRUCTURE_ROLES)}")
        requested_chain = _optional_string(item.get("binder_chain") or args.get("binder_chain"), "binder_chain")
        if role == "target":
            chain, sequence, skipped, chain_ids = None, None, [], _extract_structure(path, None)[3]
            target_chains = _parse_chain_list(item.get("target_chains") or args.get("target_chains"), "target_chains") or chain_ids
        else:
            chain, sequence, skipped, chain_ids = _extract_structure(path, requested_chain)
            target_chains = _parse_chain_list(item.get("target_chains") or args.get("target_chains"), "target_chains")
            if target_chains is None:
                target_chains = [chain_id for chain_id in chain_ids if chain_id != chain]
        if skipped:
            warnings.append(f"{design_id}: skipped non-standard residues in binder chain {chain}: " + ",".join(sorted(skipped)))
        structure_object = {
            "path": path,
            "sha256": _sha256_file(path),
            "role": role,
            "predictor": _optional_string(item.get("predictor") or args.get("predictor"), "predictor"),
            "model": _optional_string(item.get("model") or args.get("model"), "model"),
            "seed": item.get("seed", args.get("seed")),
            "binder_chain": chain,
            "target_chains": sorted(set(target_chains), key=_stable_key),
        }
        raw = {
            "design_id": design_id,
            "target_id": item.get("target_id"),
            "sequence": sequence,
            "binder_chain": chain,
            "structures": [structure_object],
            "source_record_id": item.get("source_record_id") or os.path.splitext(os.path.basename(path))[0],
            "generator": item.get("generator"),
            "generator_run": item.get("generator_run"),
            "backbone_id": item.get("backbone_id"),
            "parent_id": item.get("parent_id"),
            "round": item.get("round"),
            "hotspot_set": item.get("hotspot_set"),
            "raw_scores": item.get("raw_scores"),
            "score_schema": item.get("score_schema"),
            "source": item.get("source"),
        }
        rows.append(_candidate_row(raw, source_type, path, _sha256_file(path), args, warnings,
                                   base_dir=os.path.dirname(path), default_design_id=design_id))
    return rows


def _merge_records(first, later):
    merged = dict(first)
    merged["raw_scores"] = dict(first["raw_scores"])
    for key, value in later["raw_scores"].items():
        merged["raw_scores"].setdefault(key, value)
    by_path = {item["path"]: item for item in first["structures"]}
    for item in later["structures"]:
        by_path.setdefault(item["path"], item)
    merged["structures"] = sorted(by_path.values(), key=lambda item: _stable_key(item["path"]))
    merged["hotspot_set"] = list(dict.fromkeys(first["hotspot_set"] + later["hotspot_set"]))
    return merged


def _validate_existing_ledger(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise IngestError(f"invalid ledger JSONL at line {line_number}: {exc.msg}") from exc
            if not isinstance(row, dict) or set(row) != set(FIELDS):
                raise IngestError(f"ledger row {line_number} does not match ingest schema v0")
            if not isinstance(row.get("design_id"), str) or not row["design_id"].strip() or not isinstance(row.get("target_id"), str) or not row["target_id"].strip():
                raise IngestError(f"ledger row {line_number} is missing design_id or target_id")
            if not isinstance(row.get("structures"), list) or any(not isinstance(item, dict) or set(item) != set(STRUCTURE_FIELDS) for item in row["structures"]):
                raise IngestError(f"ledger row {line_number} structures do not match object schema")
            rows.append(row)
    return rows


def _resolve_lineage(rows):
    by_key = {_record_key(row): row for row in rows}
    by_design = {}
    for row in rows:
        row["lineage_root"] = None
        row["lineage_id"] = None
        row["lineage_depth"] = None
        row["lineage_status"] = None
        by_design.setdefault(row["design_id"], []).append(row)
    parents = {}
    dangling = set()
    warnings = []
    for row in rows:
        key = _record_key(row)
        parent_id = row.get("parent_id")
        if not parent_id:
            parents[key] = None
            continue
        if parent_id == row["design_id"]:
            raise IngestError(f"PARENT_EQUALS_CHILD: {row['target_id']}/{row['design_id']}")
        parent_key = (row["target_id"], parent_id)
        if parent_key in by_key:
            parents[key] = parent_key
            continue
        if by_design.get(parent_id):
            raise IngestError(f"PARENT_TARGET_MISMATCH: {row['target_id']}/{row['design_id']} -> {parent_id}")
        parents[key] = None
        dangling.add(key)
        row["lineage_root"] = None
        row["lineage_id"] = None
        row["lineage_depth"] = None
        row["lineage_status"] = "DANGLING_PARENT"
        warnings.append(f"DANGLING_PARENT:{row['target_id']}/{row['design_id']}->{parent_id}")

    state = {}
    resolved = {}

    def visit(key):
        if state.get(key) == 1:
            row = by_key[key]
            raise IngestError(f"LINEAGE_CYCLE: {row['target_id']}/{row['design_id']}")
        if state.get(key) == 2:
            return resolved[key]
        state[key] = 1
        parent_key = parents[key]
        row = by_key[key]
        if key in dangling:
            value = (None, None, None)
        elif parent_key is None:
            root = row["design_id"]
            lineage_id = hashlib.sha256((row["target_id"] + "|" + root).encode("utf-8")).hexdigest()[:16]
            row["lineage_root"] = root
            row["lineage_id"] = lineage_id
            row["lineage_depth"] = 0
            row["lineage_status"] = "ROOT"
            value = (root, lineage_id, 0)
        else:
            root, lineage_id, depth = visit(parent_key)
            if root is None:
                row["lineage_root"] = None
                row["lineage_id"] = None
                row["lineage_depth"] = None
                row["lineage_status"] = "DANGLING_PARENT"
                warnings.append(f"DANGLING_PARENT:{row['target_id']}/{row['design_id']}->{row['parent_id']}")
                value = (None, None, None)
            else:
                row["lineage_root"] = root
                row["lineage_id"] = lineage_id
                row["lineage_depth"] = depth + 1
                row["lineage_status"] = "RESOLVED"
                value = (root, lineage_id, depth + 1)
        state[key] = 2
        resolved[key] = value
        return value

    for key in sorted(by_key, key=lambda item: _stable_key(item[0]) + _stable_key(item[1])):
        visit(key)
    return list(dict.fromkeys(warnings))


def _canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _batch_id(rows, source_type, primary_path, primary_sha256, scores_sha256, score_schema):
    excluded = {"source_batch_id", "lineage_root", "lineage_id", "lineage_depth", "lineage_status", "_score_schema"}
    manifest_rows = [{key: row[key] for key in FIELDS if key not in excluded} for row in rows]
    manifest = {
        "source_type": source_type,
        "source_path": primary_path,
        "source_sha256": primary_sha256,
        "scores_sha256": scores_sha256,
        "records": manifest_rows,
        "score_schema": score_schema,
    }
    return hashlib.sha256(_canonical_json(manifest).encode("utf-8")).hexdigest()[:16]


def _read_score_sidecar(path):
    if not os.path.exists(path):
        return {"schema_version": "v0", "score_schema_by_batch": {}}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise IngestError(f"invalid score schema sidecar: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("score_schema_by_batch"), dict):
        raise IngestError("score schema sidecar does not match ingest v0")
    return data


def _write_atomic(path, rows):
    parent = os.path.dirname(path) or os.getcwd()
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".galatea-ingest-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            for row in rows:
                record = {key: row[key] for key in FIELDS}
                handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True, allow_nan=False))
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _write_json_atomic(path, value):
    parent = os.path.dirname(path) or os.getcwd()
    os.makedirs(parent, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".galatea-ingest-schema-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _failure(error, ledger_path=None, mode=None, stats=None, warnings=None):
    return {
        "ok": False,
        "ledger_path": ledger_path,
        "mode": mode,
        "stats": stats or {"total_input": 0, "n_new": 0, "n_conflict": 0,
                            "n_written": 0, "conflicts": []},
        "preview": [],
        "warnings": warnings or [],
        "error": str(error),
    }


def run_ingest(args):
    """Read one local source, resolve identities and lineage, and atomically write JSONL."""
    warnings = []
    ledger_path = None
    mode = None
    try:
        if not isinstance(args, dict):
            raise IngestError("args must be an object")
        ledger_value = args.get("ledger")
        if _is_blank(ledger_value):
            raise IngestError("ledger is required")
        ledger_path = os.path.realpath(os.path.expanduser(os.fspath(ledger_value)))
        mode = str(args.get("mode") or "append")
        if mode not in ("append", "replace"):
            raise IngestError("mode must be append or replace")
        on_conflict = str(args.get("on_conflict") or "error")
        if on_conflict not in ("error", "keep_first", "keep_last", "merge"):
            raise IngestError("on_conflict must be error, keep_first, keep_last, or merge")
        structure_role = args.get("structure_role")
        if structure_role is not None and structure_role not in STRUCTURE_ROLES:
            raise IngestError(f"invalid structure_role {structure_role!r}")

        source_names = ("structures", "structs_dir", "candidates_file", "records")
        selected = [name for name in source_names if args.get(name) is not None]
        if len(selected) != 1:
            raise IngestError("provide exactly one source: structures, structs_dir, candidates_file, or records")
        source_type = selected[0]
        if args.get("glob") is not None and source_type != "structs_dir":
            raise IngestError("glob is only valid with structs_dir")

        primary_path = None
        primary_sha256 = None
        scores_path = None
        scores_sha256 = None
        if source_type == "structures":
            values = args.get("structures")
            if not isinstance(values, (list, tuple)) or not values:
                raise IngestError("structures source must be a non-empty list")
            items = []
            for value in values:
                item = {"path": value} if isinstance(value, str) else value
                if not isinstance(item, dict) or _is_blank(item.get("path")):
                    raise IngestError("structures entries must be paths or objects with path")
                path = _as_file_path(item["path"])
                item = dict(item); item["path"] = path
                items.append(item)
            input_rows = _structure_records(items, source_type, None, None, args, warnings)
            manifest_files = [{"path": item["path"], "sha256": _sha256_file(item["path"])} for item in items]
        elif source_type == "structs_dir":
            directory_value = args.get("structs_dir")
            if _is_blank(directory_value):
                raise IngestError("structs_dir is required")
            directory = os.path.realpath(os.path.expanduser(os.fspath(directory_value)))
            if not os.path.isdir(directory):
                raise IngestError(f"structs_dir not found: {directory}")
            patterns = args.get("glob")
            if patterns is None:
                patterns = DEFAULT_GLOBS
            elif isinstance(patterns, str):
                patterns = [patterns]
            if not isinstance(patterns, (list, tuple)) or not patterns or not all(isinstance(item, str) and item for item in patterns):
                raise IngestError("glob must be a non-empty string or list of strings")
            paths = []
            for pattern in patterns:
                paths.extend(globlib.glob(os.path.join(directory, pattern)))
            paths = sorted({os.path.realpath(path) for path in paths if os.path.isfile(path)}, key=_stable_key)
            if not paths:
                raise IngestError(f"no structure files matched in {directory}")
            items = [{"path": path} for path in paths]
            primary_path = directory
            input_rows = _structure_records(items, source_type, None, None, args, warnings)
            manifest_files = [{"path": path, "sha256": _sha256_file(path)} for path in paths]
        elif source_type == "candidates_file":
            candidate_value = args.get("candidates_file")
            if _is_blank(candidate_value):
                raise IngestError("candidates_file is required")
            primary_path = _as_file_path(candidate_value, kind="candidates")
            primary_sha256 = _sha256_file(primary_path)
            raw_rows = _read_candidate_file(primary_path)
            if not raw_rows:
                raise IngestError("candidates_file contains no candidates")
            input_rows = [_candidate_row(row, source_type, primary_path, primary_sha256, args, warnings,
                                         base_dir=os.path.dirname(primary_path)) for row in raw_rows]
            manifest_files = []
        else:
            raw_rows = args.get("records")
            if not isinstance(raw_rows, list) or not raw_rows:
                raise IngestError("records source must be a non-empty list")
            input_rows = [_candidate_row(row, source_type, None, None, args, warnings) for row in raw_rows]
            manifest_files = []

        if not input_rows:
            raise IngestError("source produced no candidates")

        if args.get("scores_file") is not None:
            scores_path = _as_file_path(args["scores_file"], kind="scores")
            if os.path.splitext(scores_path)[1].lower() not in (".csv", ".json"):
                raise IngestError("scores_file extension must be .csv or .json")
            scores_sha256 = _sha256_file(scores_path)
            score_key = _optional_string(args.get("scores_key") or "design_id", "scores_key")
            scores = _read_scores_file(scores_path, score_key)
            for row in input_rows:
                row["provenance"]["scores_path"] = scores_path
                namespace = args.get("scores_namespace") or row["source"] or row.get("generator")
                for key, value in scores.get(row["design_id"], {}).items():
                    row["raw_scores"].setdefault(_score_key(key, namespace), value)

        score_schema = {}
        for row in input_rows:
            row_schema = row.pop("_score_schema", {})
            for key, metadata in row_schema.items():
                if key in score_schema and score_schema[key] != metadata:
                    raise IngestError(f"conflicting score_schema for {key}")
                score_schema[key] = metadata
        score_schema = dict(sorted(score_schema.items(), key=lambda item: _stable_key(item[0])))
        for row in input_rows:
            missing_schema = sorted(set(row["raw_scores"]) - set(score_schema), key=_stable_key)
            if missing_schema:
                raise IngestError(f"score_schema missing entries for raw_scores: {missing_schema}")

        batch_id = _batch_id(input_rows, source_type, primary_path,
                             primary_sha256 or (hashlib.sha256(_canonical_json(manifest_files).encode("utf-8")).hexdigest() if manifest_files else None),
                             scores_sha256, score_schema)
        for row in input_rows:
            row["source_batch_id"] = batch_id

        sidecar_path = ledger_path + ".schema.json"
        if mode == "append":
            current_rows = _validate_existing_ledger(ledger_path)
            sidecar = _read_score_sidecar(sidecar_path)
            if current_rows and not os.path.exists(sidecar_path) and any(row["raw_scores"] for row in current_rows):
                raise IngestError("existing ledger has raw scores but its score schema sidecar is missing")
        else:
            current_rows = []
            sidecar = {"schema_version": "v0", "score_schema_by_batch": {}}

        had_existing = {_record_key(row) for row in current_rows}
        by_key = {}
        conflicts = []
        conflict_count = 0

        def add_record(row, origin):
            nonlocal conflict_count
            key = _record_key(row)
            previous = by_key.get(key)
            if previous is None:
                by_key[key] = row
                return
            conflict_count += 1
            conflicts.append({"target_id": key[0], "design_id": key[1],
                              "source": origin, "reason": "duplicate_candidate_identity"})
            if on_conflict == "keep_last":
                by_key[key] = row
            elif on_conflict == "merge":
                by_key[key] = _merge_records(previous, row)

        for row in current_rows:
            add_record(row, "ledger")
        for row in input_rows:
            add_record(row, source_type)

        final_rows = sorted(by_key.values(), key=_sort_record_key)
        lineage_warnings = _resolve_lineage(final_rows)
        warnings.extend(lineage_warnings)
        input_keys = {_record_key(row) for row in input_rows}
        n_new = len(input_keys - had_existing)
        stats = {
            "total_input": len(input_rows),
            "n_new": n_new,
            "n_conflict": conflict_count,
            "n_written": len(final_rows),
            "conflicts": conflicts,
        }
        result = {
            "ok": not (on_conflict == "error" and conflict_count > 0),
            "ledger_path": ledger_path,
            "mode": mode,
            "stats": stats,
            "preview": final_rows[:3],
            "warnings": list(dict.fromkeys(warnings)),
        }
        if not result["ok"]:
            result["error"] = "candidate identity conflicts found; ledger was not written"
            return result

        batch_schemas = sidecar["score_schema_by_batch"]
        existing_schema = batch_schemas.get(batch_id)
        if existing_schema is not None and existing_schema != score_schema:
            raise IngestError(f"source_batch_id {batch_id} already has a different score_schema")
        batch_schemas[batch_id] = score_schema
        sidecar["score_schema_by_batch"] = dict(sorted(batch_schemas.items(), key=lambda item: item[0]))
        if not args.get("dry_run", False):
            _write_json_atomic(sidecar_path, sidecar)
            _write_atomic(ledger_path, final_rows)
        return result
    except (IngestError, OSError, csv.Error, TypeError, ValueError, json.JSONDecodeError) as exc:
        return _failure(exc, ledger_path, mode, warnings=warnings)
    except Exception as exc:
        return _failure(f"{type(exc).__name__}: {exc}", ledger_path, mode, warnings=warnings)
