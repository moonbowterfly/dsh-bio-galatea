"""Deterministic, label-agnostic campaign coverage audit and rescue planning."""

import csv
import hashlib
import io
import json
import math
import os
import tempfile
from collections import Counter
from collections.abc import Mapping


SCHEMA_VERSION = "coverage.v0"
DEFAULT_COLUMNS = {
    "design_id": "design_id",
    "target_id": "target_id",
    "generator": "generator",
    "backbone": "backbone_id",
    "contact": "contact_cluster_id",
    "lineage": "lineage_id",
    "pose": "pose_cluster_id",
    "score": "consensus_score",
}
DEFAULTS = {
    "out": None,
    "rescue": False,
    "min_generators": 2,
    "min_contact_families": 2,
    "unconsumed_min_count": 2,
    "unconsumed_min_share": 0.10,
    "max_actions": 200,
    "columns": DEFAULT_COLUMNS,
}
CONFIG_KEYS = set(DEFAULTS)
AUDIT_DIMENSIONS = (
    ("generator", "n_generators"),
    ("backbone", "n_backbones"),
    ("contact", "n_contact_families"),
)
MONITOR_DIMENSIONS = (
    ("lineage", "n_lineages"),
    ("pose", "n_pose_clusters"),
)
CSV_FIELDS = (
    "target_id",
    "n_candidates",
    "n_selected",
    "K_t",
    "n_generators_pool",
    "n_backbones_pool",
    "n_contact_families_pool",
    "n_generators_sel",
    "n_backbones_sel",
    "n_contact_families_sel",
    "flags",
    "warnings",
)


class CoverageInputError(ValueError):
    """Expected campaign coverage input/configuration error."""


def _blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _stable_unique(values):
    return sorted(set(values))


def _json_bytes(value):
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise CoverageInputError(f"value is not JSON serializable: {exc}")
    return (text + "\n").encode("utf-8")


def _atomic_write(path, payload):
    directory = os.path.dirname(path)
    descriptor, temp_path = tempfile.mkstemp(prefix=".coverage-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _resolve_file(path, label):
    if not isinstance(path, str) or not path.strip():
        raise CoverageInputError(f"{label} must be a non-empty file path")
    resolved = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(resolved):
        raise CoverageInputError(f"{label} file not found: {resolved}")
    return resolved


def _read_bytes(path, label):
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except OSError as exc:
        raise CoverageInputError(f"cannot read {label}: {exc}")
    try:
        return raw, raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise CoverageInputError(f"{label} must be UTF-8: {exc}")


def _filtered_csv_rows(text, path, wanted, label):
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(reader)
    except StopIteration:
        raise CoverageInputError(f"{label} CSV must have a header row")
    names = [name.strip() for name in header]
    if any(not name for name in names):
        raise CoverageInputError(f"{label} CSV contains an empty column name")
    if len(names) != len(set(names)):
        raise CoverageInputError(f"{label} CSV contains duplicate column names")
    positions = {name: index for index, name in enumerate(names) if name in wanted}
    rows = []
    try:
        for line_number, values in enumerate(reader, start=2):
            if len(values) > len(names):
                raise CoverageInputError(
                    f"{label} CSV line {line_number} has more values than its header"
                )
            row = {}
            for name, index in positions.items():
                row[name] = values[index] if index < len(values) else None
            rows.append(row)
    except csv.Error as exc:
        raise CoverageInputError(f"invalid {label} CSV: {exc}")
    # Only allowlisted fields are retained. Other columns, including labels, are discarded.
    return rows, set(names)


def _read_object_rows(path, wanted, label, extensions=(".csv", ".jsonl")):
    resolved = _resolve_file(path, label)
    raw, text = _read_bytes(resolved, label)
    suffix = os.path.splitext(resolved)[1].lower()
    if suffix == ".csv" and ".csv" in extensions:
        rows, fields = _filtered_csv_rows(text, resolved, wanted, label)
    elif suffix == ".jsonl" and ".jsonl" in extensions:
        rows = []
        fields = set()
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise CoverageInputError(
                    f"invalid {label} JSONL at line {line_number}: {exc.msg}"
                )
            if not isinstance(value, Mapping):
                raise CoverageInputError(f"{label} JSONL line {line_number} must be an object")
            fields.update(key for key in value if isinstance(key, str) and key in wanted)
            # Do not retain unknown fields from JSONL objects.
            rows.append({key: value.get(key) for key in wanted if key in value})
    else:
        allowed = ", ".join(sorted(extensions))
        raise CoverageInputError(f"{label} file extension must be one of {allowed}")
    return rows, fields, resolved, raw


def _load_config(raw_config):
    if raw_config is None:
        raw = {}
        source = {"kind": "defaults"}
        raw_bytes = _json_bytes(raw)
    elif isinstance(raw_config, Mapping):
        raw = dict(raw_config)
        try:
            raw_bytes = json.dumps(
                raw, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise CoverageInputError(f"config must be JSON serializable: {exc}")
        source = {"kind": "inline"}
    elif isinstance(raw_config, str) and raw_config.strip():
        path = _resolve_file(raw_config, "config")
        raw_file, text = _read_bytes(path, "config")
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise CoverageInputError(f"invalid config JSON: {exc.msg}")
        if not isinstance(value, Mapping):
            raise CoverageInputError("config JSON must contain an object")
        raw = dict(value)
        raw_bytes = raw_file
        source = {"kind": "file", "path": path}
    else:
        raise CoverageInputError("config must be an object or JSON file path")
    return raw, source, raw_bytes


def _integer(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise CoverageInputError(f"config.{name} must be an integer >= {minimum}")
    return value


def _effective_config(raw):
    if not isinstance(raw, Mapping):
        raise CoverageInputError("config must be an object")
    warnings = []
    unknown = _stable_unique(str(key) for key in raw if key not in CONFIG_KEYS)
    if unknown:
        warnings.append("UNKNOWN_CONFIG_KEYS_IGNORED:" + ",".join(unknown))

    config = dict(DEFAULTS)
    config["columns"] = dict(DEFAULT_COLUMNS)
    config.update({key: value for key, value in raw.items() if key in CONFIG_KEYS})
    if not isinstance(config.get("out"), str) or not config["out"].strip():
        raise CoverageInputError("config.out is required and must be a directory path")
    config["out"] = os.path.abspath(os.path.expanduser(config["out"]))
    if not isinstance(config.get("rescue"), bool):
        raise CoverageInputError("config.rescue must be a boolean")
    for key in ("min_generators", "min_contact_families", "max_actions"):
        config[key] = _integer(config.get(key), key, minimum=0)
    config["unconsumed_min_count"] = _integer(
        config.get("unconsumed_min_count"), "unconsumed_min_count", minimum=1
    )
    share = config.get("unconsumed_min_share")
    if isinstance(share, bool) or not isinstance(share, (int, float)):
        raise CoverageInputError("config.unconsumed_min_share must be a number between 0 and 1")
    share = float(share)
    if not math.isfinite(share) or share < 0 or share > 1:
        raise CoverageInputError("config.unconsumed_min_share must be a number between 0 and 1")
    config["unconsumed_min_share"] = 0.0 if share == 0 else share

    raw_columns = config.get("columns")
    if not isinstance(raw_columns, Mapping):
        raise CoverageInputError("config.columns must be an object")
    column_unknown = _stable_unique(str(key) for key in raw_columns if key not in DEFAULT_COLUMNS)
    if column_unknown:
        warnings.append("UNKNOWN_COLUMN_KEYS_IGNORED:" + ",".join(column_unknown))
    columns = dict(DEFAULT_COLUMNS)
    for key, value in raw_columns.items():
        if key not in DEFAULT_COLUMNS:
            continue
        if not isinstance(value, str) or not value.strip():
            raise CoverageInputError(f"config.columns.{key} must be a non-empty string")
        columns[key] = value.strip()
    config["columns"] = columns
    return config, warnings


def _required_value(row, key, label, row_number):
    value = row.get(key)
    if _blank(value):
        raise CoverageInputError(f"{label} row {row_number} is missing {key}")
    if not isinstance(value, str):
        raise CoverageInputError(f"{label} row {row_number} {key} must be a string")
    return value.strip()


def _normal_dimension(value):
    if _blank(value):
        return None
    return str(value).strip() or None


def _read_candidates(path, columns):
    wanted = set(columns.values())
    rows, fields, resolved, raw = _read_object_rows(path, wanted, "candidates")
    design_field = columns["design_id"]
    target_field = columns["target_id"]
    if design_field not in fields:
        raise CoverageInputError(f"candidate table is missing required column {design_field}")
    if target_field not in fields:
        raise CoverageInputError(f"candidate table is missing required column {target_field}")

    candidates = []
    seen = set()
    invalid_score_count = 0
    for row_number, source in enumerate(rows, start=1):
        design_id = _required_value(source, design_field, "candidate", row_number)
        target_id = _required_value(source, target_field, "candidate", row_number)
        if design_id in seen:
            raise CoverageInputError(f"duplicate design_id: {design_id}")
        seen.add(design_id)
        candidate = {"design_id": design_id, "target_id": target_id}
        for dimension in ("generator", "backbone", "contact", "lineage", "pose"):
            field = columns[dimension]
            candidate[dimension] = _normal_dimension(source.get(field)) if field in fields else None
        score_field = columns["score"]
        score = None
        if score_field in fields and not _blank(source.get(score_field)):
            if isinstance(source[score_field], bool):
                invalid_score_count += 1
            else:
                try:
                    parsed = float(source[score_field])
                    if math.isfinite(parsed):
                        score = 0.0 if parsed == 0.0 else parsed
                    else:
                        invalid_score_count += 1
                except (TypeError, ValueError):
                    invalid_score_count += 1
        candidate["score"] = score
        candidates.append(candidate)
    return candidates, fields, resolved, raw, invalid_score_count


def _read_selection(path, columns):
    design_field = columns["design_id"]
    target_field = columns["target_id"]
    resolved = _resolve_file(path, "selection")
    raw, text = _read_bytes(resolved, "selection")
    suffix = os.path.splitext(resolved)[1].lower()
    if suffix == ".json":
        try:
            values = json.loads(text)
        except json.JSONDecodeError as exc:
            raise CoverageInputError(f"invalid selection JSON: {exc.msg}")
        if not isinstance(values, list):
            raise CoverageInputError("selection JSON must contain an array of design_id strings")
        records = []
        for index, value in enumerate(values, start=1):
            if not isinstance(value, str) or not value.strip():
                raise CoverageInputError(f"selection JSON item {index} must be a non-empty string")
            records.append({"design_id": value.strip(), "target_id": None})
        return records, {design_field}, resolved, raw
    rows, fields, resolved, raw = _read_object_rows(
        path, {design_field, target_field, "design_id", "target_id"}, "selection"
    )
    selection_design_field = "design_id" if "design_id" in fields else design_field
    selection_target_field = "target_id" if "target_id" in fields else target_field
    if selection_design_field not in fields:
        raise CoverageInputError(
            f"selection table is missing required column design_id (or mapped {design_field})"
        )
    records = []
    for row_number, row in enumerate(rows, start=1):
        design_id = _required_value(row, selection_design_field, "selection", row_number)
        target_id = (
            _normal_dimension(row.get(selection_target_field))
            if selection_target_field in fields else None
        )
        records.append({"design_id": design_id, "target_id": target_id})
    return records, fields, resolved, raw


def _parse_quota_value(value, target_id):
    if isinstance(value, bool):
        raise CoverageInputError(f"quota K_t for {target_id} must be an integer >= 0")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, str) and value.strip().isdigit():
        parsed = int(value.strip())
    else:
        raise CoverageInputError(f"quota K_t for {target_id} must be an integer >= 0")
    if parsed < 0:
        raise CoverageInputError(f"quota K_t for {target_id} must be an integer >= 0")
    return parsed


def _read_quota(path):
    if path is None:
        return {}, None, None
    resolved = _resolve_file(path, "quota")
    raw, text = _read_bytes(resolved, "quota")
    suffix = os.path.splitext(resolved)[1].lower()
    if suffix == ".json":
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise CoverageInputError(f"invalid quota JSON: {exc.msg}")
        if not isinstance(value, Mapping):
            raise CoverageInputError("quota JSON must map target_id to K_t")
        quotas = {}
        for target_id, count in value.items():
            if not isinstance(target_id, str) or not target_id.strip():
                raise CoverageInputError("quota target_id must be a non-empty string")
            target_id = target_id.strip()
            if target_id in quotas:
                raise CoverageInputError(f"duplicate quota target_id: {target_id}")
            quotas[target_id] = _parse_quota_value(count, target_id)
    elif suffix == ".csv":
        rows, fields = _filtered_csv_rows(text, resolved, {"target_id", "K_t"}, "quota")
        if "target_id" not in fields or "K_t" not in fields:
            raise CoverageInputError("quota CSV requires target_id and K_t columns")
        quotas = {}
        for row_number, row in enumerate(rows, start=2):
            target_id = _required_value(row, "target_id", "quota", row_number)
            if target_id in quotas:
                raise CoverageInputError(f"duplicate quota target_id: {target_id}")
            quotas[target_id] = _parse_quota_value(row.get("K_t"), target_id)
    else:
        raise CoverageInputError("quota file extension must be .csv or .json")
    return quotas, resolved, raw


def _counts(rows, dimension, available):
    if not available:
        return None
    return len({row[dimension] for row in rows if row.get(dimension) is not None})


def _audit(candidates, fields, selection_records, selection_present, quotas, config, warnings):
    columns = config["columns"]
    pool_by_id = {row["design_id"]: row for row in candidates}
    pool_by_target = {}
    for row in candidates:
        pool_by_target.setdefault(row["target_id"], []).append(row)

    selection_ids = set()
    selection_targets = set()
    selection_duplicate_ids = set()
    selection_target_conflicts = set()
    selection_conflict_targets = set()
    declared_targets = {}
    for record in selection_records:
        design_id = record["design_id"]
        declared_target = record.get("target_id")
        if design_id in selection_ids:
            selection_duplicate_ids.add(design_id)
        selection_ids.add(design_id)
        candidate = pool_by_id.get(design_id)
        if declared_target:
            prior = declared_targets.get(design_id)
            if prior is not None and prior != declared_target:
                selection_target_conflicts.add(design_id)
            declared_targets[design_id] = declared_target
            if candidate is None:
                selection_targets.add(declared_target)
            elif declared_target != candidate["target_id"]:
                selection_target_conflicts.add(design_id)
                selection_conflict_targets.add(candidate["target_id"])

    if selection_duplicate_ids:
        warnings.append("DUPLICATE_SELECTION_IDS_COLLAPSED")
    if selection_target_conflicts:
        warnings.append("SELECTION_TARGET_CONFLICTS_POOL_WINS")
    unknown_ids = _stable_unique(selection_ids - set(pool_by_id))
    selected_by_target = {}
    if selection_present:
        for design_id in selection_ids:
            candidate = pool_by_id.get(design_id)
            if candidate is not None:
                selected_by_target.setdefault(candidate["target_id"], set()).add(design_id)

    targets = _stable_unique(
        [row["target_id"] for row in candidates]
        + list(selection_targets)
        + list(quotas)
    )
    missing_dimension_warnings = []
    for dimension in ("generator", "backbone", "contact", "lineage", "pose"):
        if columns[dimension] not in fields:
            warning = f"MISSING_COLUMN_{dimension.upper()}"
            warnings.append(warning)
            missing_dimension_warnings.append(warning)
    if config["rescue"] and columns["score"] not in fields:
        warnings.append("MISSING_COLUMN_SCORE")
        missing_dimension_warnings.append("MISSING_COLUMN_SCORE")
    dimension_available = {
        dimension: columns[dimension] in fields
        for dimension in ("generator", "backbone", "contact", "lineage", "pose")
    }

    unconsumed = []
    per_target = {}
    audit_rows = []
    for target_id in targets:
        pool_rows = pool_by_target.get(target_id, [])
        selected_ids_for_target = selected_by_target.get(target_id, set())
        selected_rows = [pool_by_id[design_id] for design_id in sorted(selected_ids_for_target)]
        effective_rows = selected_rows if selection_present else pool_rows
        n_selected = len(selected_rows) if selection_present else None
        quota = quotas.get(target_id)
        flags = []
        target_warnings = list(missing_dimension_warnings)
        if target_id in selection_conflict_targets:
            target_warnings.append("SELECTION_TARGET_CONFLICTS_POOL_WINS")

        if not pool_rows and (target_id in selection_targets or target_id in quotas):
            flags.append("ZERO_CANDIDATES")
        for dimension, prefix in AUDIT_DIMENSIONS:
            if dimension_available[dimension] and len(effective_rows) >= 2:
                if _counts(effective_rows, dimension, True) == 1:
                    flags.append({
                        "generator": "SINGLE_GENERATOR",
                        "backbone": "SINGLE_BACKBONE_FAMILY",
                        "contact": "SINGLE_CONTACT_FAMILY",
                    }[dimension])
        if selection_present and quota is not None and quota >= 1 and len(selected_rows) < quota:
            flags.append("QUOTA_UNDERFILLED")
        if selection_present and quota is not None and len(selected_rows) > quota:
            flags.append("QUOTA_EXCEEDED")

        if selection_present and dimension_available["generator"] and pool_rows:
            generator_counts = Counter(
                row["generator"] for row in pool_rows if row.get("generator") is not None
            )
            selected_generators = {
                row["generator"] for row in selected_rows if row.get("generator") is not None
            }
            for generator in sorted(generator_counts):
                count = generator_counts[generator]
                share = count / len(pool_rows)
                if (
                    count >= config["unconsumed_min_count"]
                    and share >= config["unconsumed_min_share"]
                    and generator not in selected_generators
                ):
                    unconsumed.append([target_id, generator, count, share])
                    flags.append("GENERATOR_UNCONSUMED")

        flags = _stable_unique(flags)
        target_warnings = _stable_unique(target_warnings)
        per_target_counts = {
            "n_candidates": len(pool_rows),
            "n_selected": n_selected,
            "K_t": quota,
        }
        for dimension, count_key in AUDIT_DIMENSIONS + MONITOR_DIMENSIONS:
            available = dimension_available[dimension]
            per_target_counts[f"{count_key}_pool"] = _counts(pool_rows, dimension, available)
            per_target_counts[f"{count_key}_sel"] = _counts(
                effective_rows, dimension, available
            )
        per_target[target_id] = {
            **per_target_counts,
            "flags": flags,
            "warnings": target_warnings,
        }
        audit_rows.append({
            "target_id": target_id,
            "n_candidates": len(pool_rows),
            "n_selected": n_selected,
            "K_t": quota,
            "n_generators_pool": per_target_counts["n_generators_pool"],
            "n_backbones_pool": per_target_counts["n_backbones_pool"],
            "n_contact_families_pool": per_target_counts["n_contact_families_pool"],
            "n_generators_sel": per_target_counts["n_generators_sel"],
            "n_backbones_sel": per_target_counts["n_backbones_sel"],
            "n_contact_families_sel": per_target_counts["n_contact_families_sel"],
            "flags": flags,
            "warnings": target_warnings,
        })

    for target in per_target.values():
        target["flags"] = _stable_unique(target["flags"])
    unconsumed.sort(key=lambda item: (item[0], item[1]))
    all_flags = _stable_unique(
        flag for target in per_target.values() for flag in target["flags"]
    )
    n_selected_total = (
        sum(target["n_selected"] or 0 for target in per_target.values())
        if selection_present else None
    )
    n_underfilled = sum(
        "QUOTA_UNDERFILLED" in target["flags"] for target in per_target.values()
    )
    n_exceeded = sum(
        "QUOTA_EXCEEDED" in target["flags"] for target in per_target.values()
    )
    summary = {
        "schema_version": SCHEMA_VERSION,
        "config": config,
        "totals": {
            "n_targets": len(targets),
            "n_candidates_total": len(candidates),
            "n_selected_total": n_selected_total,
            "n_quota_underfilled": n_underfilled,
            "n_quota_exceeded": n_exceeded,
        },
        "targets": {"per_target": per_target},
        "unconsumed_generators": unconsumed,
        "fragility": {
            "zero_coverage": [
                target_id for target_id in targets
                if "ZERO_CANDIDATES" in per_target[target_id]["flags"]
            ],
            "single_generator": [
                target_id for target_id in targets
                if "SINGLE_GENERATOR" in per_target[target_id]["flags"]
            ],
            "single_contact_family": [
                target_id for target_id in targets
                if "SINGLE_CONTACT_FAMILY" in per_target[target_id]["flags"]
            ],
            "single_backbone_family": [
                target_id for target_id in targets
                if "SINGLE_BACKBONE_FAMILY" in per_target[target_id]["flags"]
            ],
        },
        "selection_unknown_ids": unknown_ids,
        "warnings": _stable_unique(warnings),
        "flags": all_flags,
    }
    return summary, audit_rows, pool_by_id, pool_by_target, selected_by_target


def _score_sort_key(candidate, descending):
    score = candidate.get("score")
    design_id = candidate["design_id"]
    if descending:
        return (score is None, -(score if score is not None else 0.0), design_id)
    return (score if score is not None else float("-inf"), design_id)


def _rescue(candidates, targets, pool_by_id, pool_by_target, selected_by_target,
            quotas, config, dimension_available):
    actions = []
    unresolvable = []
    warnings = []
    selected = {target_id: set(ids) for target_id, ids in selected_by_target.items()}
    halted = False

    def record_unresolvable(target_id, check, reason_code):
        item = {"target_id": target_id, "check": check, "reason_code": reason_code}
        if item not in unresolvable:
            unresolvable.append(item)

    def limit_reached():
        nonlocal halted
        if len(actions) >= config["max_actions"]:
            if "MAX_ACTIONS_REACHED" not in warnings:
                warnings.append("MAX_ACTIONS_REACHED")
            halted = True
            return True
        return False

    for target_id in targets:
        if halted:
            break
        pool_rows = pool_by_target.get(target_id, [])
        selected_ids = selected.setdefault(target_id, set())
        quota = quotas.get(target_id)

        if quota is not None:
            while len(selected_ids) < quota:
                available = [row for row in pool_rows if row["design_id"] not in selected_ids]
                if not available:
                    record_unresolvable(target_id, "quota", "QUOTA_POOL_EXHAUSTED")
                    break
                if limit_reached():
                    break
                candidate = min(available, key=lambda row: _score_sort_key(row, True))
                selected_ids.add(candidate["design_id"])
                actions.append({
                    "action": "ADD",
                    "target_id": target_id,
                    "add_design_id": candidate["design_id"],
                    "replace_design_id": None,
                    "reason_code": "QUOTA_UNDERFILLED",
                })
            if halted:
                break

        # Diversity only applies to a non-empty selected set. A target with no
        # quota and no selected rows has a budget target of zero.
        if not selected_ids:
            continue

        for dimension, minimum, reason_code, check in (
            ("contact", config["min_contact_families"],
             "SINGLE_CONTACT_FAMILY", "contact"),
            ("generator", config["min_generators"],
             "SINGLE_GENERATOR", "generator"),
        ):
            if not dimension_available[dimension] or minimum == 0:
                continue
            while True:
                selected_rows = [pool_by_id[design_id] for design_id in sorted(selected_ids)]
                counts = Counter(
                    row[dimension] for row in selected_rows
                    if row.get(dimension) is not None
                )
                if len(counts) >= minimum:
                    break
                if limit_reached():
                    break
                uncovered = [
                    row for row in pool_rows
                    if row.get(dimension) is not None
                    and row[dimension] not in counts
                    and row["design_id"] not in selected_ids
                ]
                repeated = [
                    row for row in selected_rows
                    if row.get(dimension) is not None and counts[row[dimension]] >= 2
                ]
                if not uncovered or not repeated:
                    alternative = (
                        "NO_ALTERNATIVE_CONTACT_FAMILY"
                        if dimension == "contact" else "NO_ALTERNATIVE_GENERATOR"
                    )
                    record_unresolvable(target_id, check, alternative)
                    break
                incoming = min(uncovered, key=lambda row: _score_sort_key(row, True))
                outgoing = min(repeated, key=lambda row: _score_sort_key(row, False))
                selected_ids.remove(outgoing["design_id"])
                selected_ids.add(incoming["design_id"])
                actions.append({
                    "action": "REPLACE",
                    "target_id": target_id,
                    "add_design_id": incoming["design_id"],
                    "replace_design_id": outgoing["design_id"],
                    "reason_code": reason_code,
                })
            if halted:
                break
        if halted:
            break

    return {
        "schema_version": SCHEMA_VERSION,
        "actions": actions,
        "unresolvable": unresolvable,
        "counts": {
            "add": sum(action["action"] == "ADD" for action in actions),
            "replace": sum(action["action"] == "REPLACE" for action in actions),
            "unresolvable": len(unresolvable),
        },
        "warnings": _stable_unique(warnings),
    }


def _audit_csv(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream, fieldnames=CSV_FIELDS, extrasaction="ignore", lineterminator="\n"
    )
    writer.writeheader()
    for row in rows:
        value = dict(row)
        value["flags"] = ";".join(value.get("flags", []))
        value["warnings"] = ";".join(value.get("warnings", []))
        writer.writerow({
            key: "" if value.get(key) is None else value.get(key)
            for key in CSV_FIELDS
        })
    return stream.getvalue().encode("utf-8")


def _rescue_csv(plan):
    fields = ("action", "target_id", "add_design_id", "replace_design_id", "reason_code")
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    for action in plan["actions"]:
        writer.writerow({
            key: "" if action.get(key) is None else action.get(key)
            for key in fields
        })
    return stream.getvalue().encode("utf-8")


def run_coverage(args):
    """Audit campaign coverage and optionally write a deterministic rescue plan."""
    try:
        if not isinstance(args, Mapping):
            raise CoverageInputError("coverage args must be an object")
        raw_config, config_source, config_bytes = _load_config(args.get("config"))
        config, warnings = _effective_config(raw_config)
        if config["rescue"] and args.get("selection") is None:
            raise CoverageInputError("selection is required when config.rescue is true")

        candidates, candidate_fields, candidate_path, candidate_bytes, invalid_scores = (
            _read_candidates(args.get("candidates"), config["columns"])
        )
        if invalid_scores:
            warnings.append(f"INVALID_SCORE_VALUES:{invalid_scores}")

        selection_records = []
        selection_present = args.get("selection") is not None
        selection_path = None
        selection_bytes = None
        if selection_present:
            selection_records, _, selection_path, selection_bytes = _read_selection(
                args["selection"], config["columns"]
            )
        quotas, quota_path, quota_bytes = _read_quota(args.get("quota"))

        summary, audit_rows, pool_by_id, pool_by_target, selected_by_target = _audit(
            candidates, candidate_fields, selection_records, selection_present,
            quotas, config, warnings,
        )
        dimension_available = {
            dimension: config["columns"][dimension] in candidate_fields
            for dimension in ("generator", "backbone", "contact", "lineage", "pose")
        }

        rescue_plan = None
        if config["rescue"]:
            targets = list(summary["targets"]["per_target"])
            rescue_plan = _rescue(
                candidates, targets, pool_by_id, pool_by_target, selected_by_target,
                quotas, config, dimension_available,
            )
            rescue_warnings = rescue_plan.pop("warnings", [])
            summary["warnings"] = _stable_unique(
                list(summary["warnings"]) + list(rescue_warnings)
            )

        output_payloads = {
            "coverage_audit.csv": _audit_csv(audit_rows),
            "coverage_summary.json": _json_bytes(summary),
        }
        if rescue_plan is not None:
            output_payloads["rescue_plan.json"] = _json_bytes(rescue_plan)
            output_payloads["rescue_plan.csv"] = _rescue_csv(rescue_plan)

        config_hash = _sha256(config_bytes)
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "inputs": {
                "candidates": {"path": candidate_path, "sha256": _sha256(candidate_bytes)},
                "selection": (
                    {"path": selection_path, "sha256": _sha256(selection_bytes)}
                    if selection_present else None
                ),
                "quota": (
                    {"path": quota_path, "sha256": _sha256(quota_bytes)}
                    if quota_path is not None else None
                ),
                "config": {
                    **config_source,
                    "sha256": config_hash,
                    "effective": config,
                },
            },
            "outputs": {
                name: _sha256(output_payloads[name]) for name in sorted(output_payloads)
            },
        }
        output_payloads["coverage_manifest.json"] = _json_bytes(manifest)

        os.makedirs(config["out"], exist_ok=True)
        for name in sorted(output_payloads):
            _atomic_write(os.path.join(config["out"], name), output_payloads[name])
        files = {
            name: os.path.join(config["out"], name) for name in sorted(output_payloads)
        }
        result = {
            "out": config["out"],
            "files": files,
            "summary": summary,
            "manifest": manifest,
        }
        if rescue_plan is not None:
            result["rescue"] = rescue_plan["counts"]
        return {"ok": True, "result": result}
    except CoverageInputError as exc:
        return {"ok": False, "error": str(exc), "reason_code": "INVALID_INPUT"}
    except OSError as exc:
        return {"ok": False, "error": str(exc), "reason_code": "IO_ERROR"}


__all__ = ["CoverageInputError", "run_coverage"]
