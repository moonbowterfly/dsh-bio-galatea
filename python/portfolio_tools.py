"""Deterministic, label-agnostic constrained portfolio selection.

The selector has three ordered phases: hard eligibility, per-target coverage,
then global competition.  It intentionally uses only the Python standard
library so results are stable across processes and do not depend on optional
analysis packages.
"""

import csv
import hashlib
import io
import json
import math
import os
import tempfile
from collections.abc import Mapping


SCHEMA_VERSION = "portfolio.v0"
DEFAULTS = {
    "total_slots": 500,
    "min_targets": 5,
    "per_target_min": 0,
    "per_target_max": None,
    "max_per_backbone": 2,
    "max_per_lineage": None,
    "max_per_pose_cluster": None,
    "max_per_sequence_cluster": None,
    "max_per_contact_cluster": None,
    "high_risk_fraction_max": 0.10,
    "exact_sequence_max_per_target": 1,
    "require_fields": [],
    "rank_key": "consensus_percentile",
    "dry_run": False,
}
CONFIG_KEYS = set(DEFAULTS)
DIMENSIONS = (
    ("backbone_id", "max_per_backbone", "backbone"),
    ("lineage_id", "max_per_lineage", "lineage"),
    ("pose_cluster_id", "max_per_pose_cluster", "pose_cluster"),
    ("sequence_cluster_id", "max_per_sequence_cluster", "sequence_cluster"),
    ("contact_cluster_id", "max_per_contact_cluster", "contact_cluster"),
)
OPTIONAL_CAP_FIELDS = tuple(field for field, _, _ in DIMENSIONS) + (
    "sequence_group_id", "expression_risk",
)
OUTPUT_FIELDS = (
    "global_slot", "target_slot", "selection_reason", "constraint_state",
    "nearest_selected", "same_lineage_count", "same_backbone_count", "same_pose_count",
)


class PortfolioError(ValueError):
    """Expected portfolio input/configuration error."""


def _blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _stable_text(value):
    value = str(value)
    return value.casefold(), value


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def _canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _read_candidates(path):
    if not isinstance(path, str) or not path.strip():
        raise PortfolioError("candidates must be a non-empty file path")
    resolved = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(resolved):
        raise PortfolioError(f"candidate file not found: {resolved}")
    with open(resolved, "rb") as handle:
        raw_bytes = handle.read()
    suffix = os.path.splitext(resolved)[1].lower()
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise PortfolioError(f"candidate file must be UTF-8: {exc}")
    if suffix == ".csv":
        reader = csv.DictReader(io.StringIO(text, newline=""))
        if not reader.fieldnames:
            raise PortfolioError("candidate CSV must have a header row")
        fields = [str(name) for name in reader.fieldnames]
        rows = [dict(row) for row in reader]
    elif suffix == ".jsonl":
        fields = None
        rows = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise PortfolioError(f"invalid JSONL at line {line_number}: {exc.msg}")
            if not isinstance(row, Mapping):
                raise PortfolioError(f"JSONL line {line_number} must be an object")
            rows.append(dict(row))
    elif suffix == ".json":
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise PortfolioError(f"invalid JSON: {exc.msg}")
        if not isinstance(value, list) or any(not isinstance(row, Mapping) for row in value):
            raise PortfolioError("JSON candidates must be an array of objects")
        fields = None
        rows = [dict(row) for row in value]
    else:
        raise PortfolioError("candidates file extension must be .csv, .jsonl, or .json")
    if not rows:
        raise PortfolioError("candidate table is empty")
    for index, row in enumerate(rows, start=1):
        if any(not isinstance(key, str) for key in row):
            raise PortfolioError(f"candidate row {index} contains a non-string field name")
    if fields is None:
        fields = sorted({key for row in rows for key in row}, key=_stable_text)
    if "design_id" not in fields:
        raise PortfolioError("candidate table is missing required column design_id")
    if "target_id" not in fields:
        raise PortfolioError("candidate table is missing required column target_id")
    return rows, fields, resolved, raw_bytes


def _load_config(raw_config):
    if raw_config is None:
        return {}, []
    if isinstance(raw_config, Mapping):
        return dict(raw_config), []
    if isinstance(raw_config, str) and raw_config.strip():
        path = os.path.abspath(os.path.expanduser(raw_config))
        if not os.path.isfile(path):
            raise PortfolioError(f"config file not found: {path}")
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                value = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise PortfolioError(f"cannot read config JSON: {exc}")
        if not isinstance(value, Mapping):
            raise PortfolioError("config JSON must contain an object")
        return dict(value), []
    raise PortfolioError("config must be an inline object or JSON file path")


def _integer(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise PortfolioError(f"config.{name} must be an integer >= {minimum}")
    return value


def _optional_cap(value, name, default=None, minimum=0):
    if value is None:
        return default
    return _integer(value, name, minimum=minimum)


def _number(value, name, minimum=None, maximum=None):
    if isinstance(value, bool):
        raise PortfolioError(f"config.{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise PortfolioError(f"config.{name} must be a finite number")
    if not math.isfinite(number):
        raise PortfolioError(f"config.{name} must be a finite number")
    if minimum is not None and number < minimum or maximum is not None and number > maximum:
        raise PortfolioError(f"config.{name} must be between {minimum} and {maximum}")
    return 0.0 if number == 0.0 else number


def _effective_config(raw):
    if not isinstance(raw, Mapping):
        raise PortfolioError("config must be an object")
    warnings = []
    unknown = sorted((str(key) for key in raw if key not in CONFIG_KEYS), key=_stable_text)
    if unknown:
        warnings.append("unknown config keys ignored: " + ", ".join(unknown))
    config = dict(DEFAULTS)
    config.update({key: value for key, value in raw.items() if key in CONFIG_KEYS})
    config["total_slots"] = _integer(config["total_slots"], "total_slots")
    config["min_targets"] = _integer(config["min_targets"], "min_targets")
    config["per_target_min"] = _integer(config["per_target_min"], "per_target_min")
    config["per_target_max"] = _optional_cap(config["per_target_max"], "per_target_max")
    if config["per_target_max"] == 0:
        config["per_target_max"] = None
    config["max_per_backbone"] = _optional_cap(config["max_per_backbone"], "max_per_backbone", default=2)
    if config["max_per_backbone"] == 0:
        config["max_per_backbone"] = None
    config["max_per_lineage"] = _optional_cap(config["max_per_lineage"], "max_per_lineage")
    for key in ("max_per_pose_cluster", "max_per_sequence_cluster", "max_per_contact_cluster"):
        config[key] = _optional_cap(config[key], key)
        if config[key] == 0:
            config[key] = None
    config["high_risk_fraction_max"] = _number(
        config["high_risk_fraction_max"], "high_risk_fraction_max", minimum=0.0, maximum=1.0)
    config["exact_sequence_max_per_target"] = _integer(
        config["exact_sequence_max_per_target"], "exact_sequence_max_per_target")
    required = config["require_fields"]
    if not isinstance(required, list) or any(not isinstance(item, str) or not item.strip() for item in required):
        raise PortfolioError("config.require_fields must be an array of non-empty strings")
    config["require_fields"] = sorted(set(item.strip() for item in required), key=_stable_text)
    if config["rank_key"] not in ("consensus_percentile", "consensus_score"):
        raise PortfolioError("config.rank_key must be consensus_percentile or consensus_score")
    if not isinstance(config["dry_run"], bool):
        raise PortfolioError("config.dry_run must be a boolean")
    return config, warnings


def _candidate_number(row, key, design_id, allow_missing=True):
    raw = row.get(key)
    if _blank(raw):
        if allow_missing:
            return None
        raise PortfolioError(f"candidate {design_id!r} is missing {key}")
    if isinstance(raw, bool):
        raise PortfolioError(f"candidate {design_id!r} {key} must be a finite number")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise PortfolioError(f"candidate {design_id!r} {key} must be a finite number")
    if not math.isfinite(value):
        raise PortfolioError(f"candidate {design_id!r} {key} must be a finite number")
    return 0.0 if value == 0.0 else value


def _optional_id(row, key):
    value = row.get(key)
    if _blank(value):
        return None
    return str(value).strip()


def _midranks(rows):
    by_target = {}
    for row in rows:
        if row["consensus_score"] is not None:
            by_target.setdefault(row["target_id"], []).append(row["consensus_score"])
    results = {}
    for target_id in sorted(by_target, key=_stable_text):
        scores = sorted(by_target[target_id])
        size = len(scores)
        for row in rows:
            if row["target_id"] != target_id or row["consensus_score"] is None:
                continue
            score = row["consensus_score"]
            lower = 0
            equal = 0
            for other in scores:
                if other < score:
                    lower += 1
                elif other == score:
                    equal += 1
            # Midrank percentile is (n_less + 0.5 * n_equal) / n_target.
            results[row["design_id"]] = (lower + 0.5 * equal) / size
    return results


def _normalize_rows(rows, fields, config, warnings):
    if "design_id" not in fields:
        raise PortfolioError("candidate table is missing required column design_id")
    normalized = []
    seen = set()
    for index, source in enumerate(rows, start=1):
        row = dict(source)
        design_id = row.get("design_id")
        target_id = row.get("target_id")
        if not isinstance(design_id, str) or not design_id.strip():
            raise PortfolioError(f"candidate row {index} design_id must be a non-empty string")
        if not isinstance(target_id, str) or not target_id.strip():
            raise PortfolioError(f"candidate {design_id!r} target_id must be a non-empty string")
        if design_id in seen:
            raise PortfolioError(f"duplicate design_id: {design_id}")
        seen.add(design_id)
        row["design_id"] = design_id
        row["target_id"] = target_id
        score = _candidate_number(row, "consensus_score", design_id)
        percentile = _candidate_number(row, "consensus_percentile", design_id)
        if percentile is not None and not 0.0 <= percentile <= 1.0:
            raise PortfolioError(f"candidate {design_id!r} consensus_percentile must be between 0 and 1")
        sequence = row.get("sequence")
        if not _blank(sequence) and not isinstance(sequence, str):
            raise PortfolioError(f"candidate {design_id!r} sequence must be a string")
        group_id = _optional_id(row, "sequence_group_id")
        if group_id is None and isinstance(sequence, str) and sequence.strip():
            # Keep this formula identical to ingest_tools.py: target + "|" + sequence.
            group_id = hashlib.sha1((target_id + "|" + sequence).encode("utf-8")).hexdigest()
        row["_sequence_group_id"] = group_id
        row["_consensus_score"] = score
        row["_consensus_percentile"] = percentile
        row["_rankable"] = percentile is not None or score is not None
        for field, _, _ in DIMENSIONS:
            row["_" + field] = _optional_id(row, field)
        row["_expression_risk"] = _optional_id(row, "expression_risk")
        row["_qc_status"] = "WARN" if _blank(row.get("qc_status")) else str(row.get("qc_status")).strip().upper()
        row["_missing_required"] = [
            field for field in config["require_fields"] if field not in row or _blank(row.get(field))
        ]
        normalized.append(row)

    derived = _midranks(normalized)
    for row in normalized:
        if row["_consensus_percentile"] is None:
            if row["design_id"] in derived:
                row["_consensus_percentile"] = derived[row["design_id"]]
            elif row["_consensus_score"] is not None:
                row["_consensus_percentile"] = 1.0
            else:
                row["_rankable"] = False
        row["consensus_percentile"] = row["_consensus_percentile"]
        row["consensus_score"] = row["_consensus_score"]
        if row["_sequence_group_id"] is not None:
            row["sequence_group_id"] = row["_sequence_group_id"]
    for field in OPTIONAL_CAP_FIELDS:
        if field == "sequence_group_id":
            missing = sum(row["_sequence_group_id"] is None for row in normalized)
        elif field == "expression_risk":
            missing = sum(row["_expression_risk"] is None for row in normalized)
        else:
            missing = sum(row["_" + field] is None for row in normalized)
        if missing:
            warnings.append(f"{field} missing for {missing} candidate(s); that dimension cap is inactive for those candidates")
    if any(not row["_rankable"] for row in normalized):
        warnings.append("candidates without consensus_percentile and consensus_score are not rankable")
    return normalized


def _sort_key(row, rank_key="consensus_percentile"):
    score = row["_consensus_score"]
    percentile = row["_consensus_percentile"]
    primary = percentile if rank_key == "consensus_percentile" else score
    if primary is None:
        primary = percentile if percentile is not None else score
    return (
        -(primary if primary is not None else float("-inf")),
        -(percentile if percentile is not None else float("-inf")),
        -(score if score is not None else float("-inf")),
        row["design_id"],
    )


def _cap_map(config, eligible_target_count, target_slots):
    lineage_config = config["max_per_lineage"]
    lineage_cap = (
        max(2, math.ceil(0.05 * (config["per_target_max"] or target_slots)))
        if lineage_config is None else (None if lineage_config == 0 else lineage_config)
    )
    caps = {
        "per_target_max": config["per_target_max"],
        "backbone": config["max_per_backbone"],
        "lineage": lineage_cap,
        "pose_cluster": config["max_per_pose_cluster"],
        "sequence_cluster": config["max_per_sequence_cluster"],
        "contact_cluster": config["max_per_contact_cluster"],
        "high_risk": math.floor(config["high_risk_fraction_max"] * config["total_slots"]),
        "exact_sequence": config["exact_sequence_max_per_target"] or None,
    }
    return caps


def _count_key(dimension, row):
    if dimension == "per_target_max":
        return row["target_id"]
    if dimension == "high_risk":
        return "HIGH_RISK" if _is_high_risk(row) else None
    if dimension == "exact_sequence":
        group = row["_sequence_group_id"]
        return (row["target_id"], group) if group is not None else None
    field = {
        "backbone": "_backbone_id",
        "lineage": "_lineage_id",
        "pose_cluster": "_pose_cluster_id",
        "sequence_cluster": "_sequence_cluster_id",
        "contact_cluster": "_contact_cluster_id",
    }.get(dimension)
    if field is None:
        return None
    value = row[field]
    return value


def _is_high_risk(row):
    value = row["_expression_risk"]
    return value is not None and value.casefold() == "high_risk"


def _violations(row, selected, config, caps):
    counts = {}
    for dimension in ("per_target_max", "backbone", "lineage", "pose_cluster", "sequence_cluster",
                      "contact_cluster", "exact_sequence", "high_risk"):
        cap = caps[dimension]
        if cap is None:
            continue
        if dimension == "high_risk" and not _is_high_risk(row):
            continue
        key = _count_key(dimension, row)
        if key is None:
            continue
        count = sum(1 for other in selected if _count_key(dimension, other) == key)
        counts[dimension] = count
    violations = []
    for dimension in ("per_target_max", "backbone", "lineage", "pose_cluster", "sequence_cluster",
                      "contact_cluster", "exact_sequence", "high_risk"):
        cap = caps[dimension]
        if cap is None or dimension not in counts:
            continue
        if counts[dimension] >= cap:
            violations.append(dimension)
    return violations


def _row_label(row, dimension):
    return {
        "per_target_max": "per_target_max",
        "backbone": "backbone",
        "lineage": "lineage",
        "pose_cluster": "pose_cluster",
        "sequence_cluster": "sequence_cluster",
        "contact_cluster": "contact_cluster",
        "exact_sequence": "exact_sequence",
        "high_risk": "high_risk",
    }[dimension]


def _warning_once(warnings, message):
    if message not in warnings:
        warnings.append(message)


def _json_cell(value):
    if value is None:
        return ""
    if isinstance(value, (Mapping, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return value


def _atomic_write(path, data):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    descriptor, temp_path = tempfile.mkstemp(prefix=".portfolio-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def _csv_bytes(fields, rows):
    import io
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: _json_cell(row.get(key)) for key in fields})
    return stream.getvalue().encode("utf-8")


def _hhi(selected, field, warnings):
    if not selected or any(row.get(field) is None for row in selected):
        _warning_once(warnings, f"safety HHI for {field.removeprefix('_')} unavailable because selected values are missing")
        return None, None
    counts = {}
    for row in selected:
        if field == "target_id":
            key = row[field]
        elif field == "_expression_risk":
            key = row[field].casefold()
        else:
            key = row[field]
        counts[key] = counts.get(key, 0) + 1
    n = len(selected)
    hhi = math.fsum((counts[key] / n) ** 2 for key in sorted(counts, key=lambda item: _stable_text(repr(item))))
    return hhi, (1.0 / hhi if hhi else None)


def _nearest_selected(row, selected_same_target):
    if not selected_same_target:
        return None
    row_pctl = row["_consensus_percentile"]
    has_cluster = row["_pose_cluster_id"] is not None or row["_contact_cluster_id"] is not None
    ranked = []
    for other in selected_same_target:
        same_cluster = (
            (row["_pose_cluster_id"] is not None and row["_pose_cluster_id"] == other["_pose_cluster_id"])
            or (row["_contact_cluster_id"] is not None and row["_contact_cluster_id"] == other["_contact_cluster_id"])
        )
        delta = abs(row_pctl - other["_consensus_percentile"])
        ranked.append((0 if (same_cluster or not has_cluster) else 1, delta, other["design_id"]))
    return min(ranked)[2]


def _constraint_state(row, selected, config, caps):
    state = {"caps": {}, "counts_after_selection": {}}
    entries = (
        ("per_target", "per_target_max"), ("backbone", "backbone"), ("lineage", "lineage"),
        ("pose_cluster", "pose_cluster"), ("sequence_cluster", "sequence_cluster"),
        ("contact_cluster", "contact_cluster"), ("exact_sequence", "exact_sequence"),
        ("high_risk", "high_risk"),
    )
    for label, dimension in entries:
        key = _count_key(dimension, row)
        if dimension == "high_risk":
            count = sum(1 for item in selected if _is_high_risk(item))
        else:
            count = None if key is None else sum(1 for item in selected if _count_key(dimension, item) == key)
        state["caps"][label] = caps[dimension]
        state["counts_after_selection"][label] = count
    return json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def run_portfolio(args):
    """Select a deterministic, constrained portfolio from a local candidate table."""
    try:
        if not isinstance(args, Mapping):
            raise PortfolioError("portfolio args must be an object")
        if not isinstance(args.get("out"), str) or not args["out"].strip():
            raise PortfolioError("out is required and must be a directory path")
        rows, fields, input_path, input_bytes = _read_candidates(args.get("candidates"))
        if any(field in fields for field in OUTPUT_FIELDS):
            raise PortfolioError("candidate table contains reserved portfolio output columns")
        raw_config, warnings = _load_config(args.get("config"))
        config, config_warnings = _effective_config(raw_config)
        warnings.extend(config_warnings)
        if not config["dry_run"] and not isinstance(args.get("out"), str):
            raise PortfolioError("out must be a directory path")

        normalized = _normalize_rows(rows, fields, config, warnings)
        if not any(row["_rankable"] for row in normalized):
            raise PortfolioError("all candidates are not rankable")
        stage0_rejected = {}
        eligible = []
        for row in normalized:
            if row["_qc_status"] == "FAIL":
                stage0_rejected[row["design_id"]] = "qc_fail"
            elif row["_missing_required"]:
                stage0_rejected[row["design_id"]] = "missing_required_field"
            elif not row["_rankable"]:
                stage0_rejected[row["design_id"]] = "not_rankable"
            else:
                eligible.append(row)

        # Exact sequence duplicates are hard-ineligible at the default cap of one.
        exact_cap = config["exact_sequence_max_per_target"]
        if exact_cap == 1:
            best_by_group = {}
            for row in sorted(eligible, key=lambda item: _sort_key(item, config["rank_key"])):
                group = _count_key("exact_sequence", row)
                if group is None:
                    continue
                if group in best_by_group:
                    stage0_rejected[row["design_id"]] = "duplicate_sequence"
                else:
                    best_by_group[group] = row
            eligible = [row for row in eligible if row["design_id"] not in stage0_rejected]

        targets_with_candidates = sorted({row["target_id"] for row in eligible}, key=_stable_text)
        if config["min_targets"] > len(targets_with_candidates):
            return {"ok": False, "error": f"min_targets ({config['min_targets']}) exceeds eligible target count ({len(targets_with_candidates)})"}

        n_targets = len(targets_with_candidates)
        target_slots = config["per_target_max"] or math.ceil(config["total_slots"] / n_targets) if n_targets else 0
        caps = _cap_map(config, n_targets, target_slots)
        config_effective = dict(config)
        config_effective["max_per_lineage"] = caps["lineage"] if config["max_per_lineage"] is None else config["max_per_lineage"]
        config_effective["derived"] = {
            "stage1_floor": max(config["per_target_min"], 1) if config["min_targets"] > 0 else config["per_target_min"],
            "max_per_lineage_rule": "explicit" if raw_config.get("max_per_lineage") is not None else "max(2, ceil(0.05 * est_target_slots))",
            "est_target_slots": target_slots,
            "max_high_risk": caps["high_risk"],
        }
        config_hash = _sha256_bytes(_canonical_json(config_effective).encode("utf-8"))

        eligible_by_target = {}
        for row in eligible:
            eligible_by_target.setdefault(row["target_id"], []).append(row)
        for target_id in eligible_by_target:
            eligible_by_target[target_id].sort(key=lambda item: _sort_key(item, config["rank_key"]))
        target_order = sorted(eligible_by_target, key=lambda target: (-len(eligible_by_target[target]), _stable_text(target)))

        selected = []
        selected_ids = set()
        selection_reason = {}
        target_counts = {}
        cap_skip_counts = {"coverage_floor": {}, "global_competition": {}}
        cap_skip_reason = {}
        stage_stats = {
            "coverage_floor": {"attempted": 0, "selected": 0, "blocked": 0},
            "global_competition": {"attempted": 0, "selected": 0, "blocked": 0},
        }
        floor = max(config["per_target_min"], 1) if config["min_targets"] > 0 else config["per_target_min"]

        def try_select(row, stage):
            stage_stats[stage]["attempted"] += 1
            violations = _violations(row, selected, config, caps)
            if violations:
                stage_stats[stage]["blocked"] += 1
                counts = cap_skip_counts[stage]
                for dimension in violations:
                    counts[dimension] = counts.get(dimension, 0) + 1
                cap_skip_reason[row["design_id"]] = violations[0]
                return False
            selected.append(row)
            selected_ids.add(row["design_id"])
            selection_reason[row["design_id"]] = "coverage_floor" if stage == "coverage_floor" else "global_competition"
            target_counts[row["target_id"]] = target_counts.get(row["target_id"], 0) + 1
            stage_stats[stage]["selected"] += 1
            return True

        if floor > 0:
            for target_id in target_order:
                for row in eligible_by_target[target_id]:
                    if target_counts.get(target_id, 0) >= floor or len(selected) >= config["total_slots"]:
                        break
                    try_select(row, "coverage_floor")

        remaining = sorted(
            (row for row in eligible if row["design_id"] not in selected_ids),
            key=lambda item: _sort_key(item, config["rank_key"]),
        )
        for row in remaining:
            if len(selected) >= config["total_slots"]:
                break
            try_select(row, "global_competition")

        selected_ids = {row["design_id"] for row in selected}
        rejected = dict(stage0_rejected)
        for row in eligible:
            if row["design_id"] in selected_ids:
                continue
            if len(selected) >= config["total_slots"]:
                rejected[row["design_id"]] = "slots_filled"
            else:
                dimension = cap_skip_reason.get(row["design_id"])
                rejected[row["design_id"]] = "cap_blocked:" + (_row_label(row, dimension) if dimension else "constraints")

        if any(count < floor for target, count in ((target, target_counts.get(target, 0)) for target in target_order)):
            for target in target_order:
                count = target_counts.get(target, 0)
                if count < floor:
                    _warning_once(warnings, f"coverage floor shortfall for {target}: selected {count}, floor {floor}")
        n_targets_selected = len(target_counts)
        flags = []
        if n_targets_selected < config["min_targets"]:
            flags.append("min_targets_not_met")
            _warning_once(warnings, f"min_targets not met: selected {n_targets_selected} targets, required {config['min_targets']}")
        slots_shortfall = max(0, config["total_slots"] - len(selected))
        if slots_shortfall:
            _warning_once(warnings, f"slots shortfall: requested {config['total_slots']}, selected {len(selected)}")

        selected_counts = {}
        for row in selected:
            target_id = row["target_id"]
            selected_counts[target_id] = selected_counts.get(target_id, 0) + 1
        safety = {}
        target_hhi, target_n_eff = _hhi(
            [{"target_id": row["target_id"]} for row in selected], "target_id", warnings)
        safety["target_hhi"] = target_hhi
        safety["target_n_eff"] = target_n_eff
        for label, field in (
            ("backbone", "_backbone_id"), ("lineage", "_lineage_id"), ("pose_cluster", "_pose_cluster_id"),
            ("sequence_cluster", "_sequence_cluster_id"), ("contact_cluster", "_contact_cluster_id"),
            ("exact_sequence", "_sequence_group_id"), ("risk", "_expression_risk"),
        ):
            hhi, n_eff = _hhi(selected, field, warnings)
            safety[label + "_hhi"] = hhi
            safety[label + "_n_eff"] = n_eff

        summary = {
            "schema_version": SCHEMA_VERSION,
            "config": config_effective,
            "counts": {
                "input": len(normalized), "eligible": len(eligible), "selected": len(selected),
                "rejected": len(rejected), "slots_shortfall": slots_shortfall,
            },
            "coverage": {
                "n_targets_selected": n_targets_selected,
                "per_target": {key: selected_counts[key] for key in sorted(selected_counts, key=_stable_text)},
            },
            "stage_stats": stage_stats,
            "cap_skip_counts": {
                stage: {key: counts[key] for key in sorted(counts, key=_stable_text)}
                for stage, counts in cap_skip_counts.items()
            },
            "safety": safety,
            "warnings": warnings,
            "flags": flags,
        }

        if config["dry_run"]:
            return {"ok": True, "result": {"summary": summary, "config_sha256": config_hash, "written": False}}

        output_dir = os.path.abspath(os.path.expanduser(args["out"]))
        output_fields = list(fields)
        derived_output_fields = []
        if "sequence_group_id" not in output_fields:
            output_fields.append("sequence_group_id")
            derived_output_fields.append("sequence_group_id")
        if "consensus_percentile" not in output_fields:
            output_fields.append("consensus_percentile")
            derived_output_fields.append("consensus_percentile")
        output_fields.extend(OUTPUT_FIELDS)
        selected_rows = []
        target_slots_assigned = {}
        for global_slot, row in enumerate(selected, start=1):
            target_id = row["target_id"]
            target_slots_assigned[target_id] = target_slots_assigned.get(target_id, 0) + 1
            same_target = [item for item in selected if item["target_id"] == target_id]
            lineage = row["_lineage_id"]
            backbone = row["_backbone_id"]
            pose = row["_pose_cluster_id"]
            output = {key: row.get(key) for key in fields}
            for field in derived_output_fields:
                output[field] = row.get(field)
            output.update({
                "global_slot": global_slot,
                "target_slot": target_slots_assigned[target_id],
                "selection_reason": selection_reason[row["design_id"]],
                "constraint_state": _constraint_state(row, selected[:global_slot], config, caps),
                "nearest_selected": _nearest_selected(row, [item for item in selected[:global_slot - 1] if item["target_id"] == target_id]),
                "same_lineage_count": None if lineage is None else sum(1 for item in selected if item["_lineage_id"] == lineage),
                "same_backbone_count": None if backbone is None else sum(1 for item in selected if item["_backbone_id"] == backbone),
                "same_pose_count": None if pose is None else sum(1 for item in selected if item["_pose_cluster_id"] == pose),
            })
            selected_rows.append(output)
        rejected_rows = [
            {"design_id": row["design_id"], "target_id": row["target_id"], "rejection_reason": rejected[row["design_id"]]}
            for row in normalized if row["design_id"] in rejected
        ]
        rejected_fields = ["design_id", "target_id", "rejection_reason"]
        selected_bytes = _csv_bytes(output_fields, selected_rows)
        rejected_bytes = _csv_bytes(rejected_fields, rejected_rows)
        summary_bytes = (json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
        payload = {
            "portfolio_selected.csv": selected_bytes,
            "portfolio_rejected.csv": rejected_bytes,
            "portfolio_summary.json": summary_bytes,
        }
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "input": {"sha256": _sha256_bytes(input_bytes)},
            "config_sha256": config_hash,
            "outputs": {name: _sha256_bytes(payload[name]) for name in sorted(payload, key=_stable_text)},
        }
        manifest_bytes = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
        for name, data in payload.items():
            _atomic_write(os.path.join(output_dir, name), data)
        _atomic_write(os.path.join(output_dir, "portfolio_manifest.json"), manifest_bytes)
        return {
            "ok": True,
            "result": {
                "summary": summary,
                "out": output_dir,
                "files": {name: os.path.join(output_dir, name) for name in (*payload, "portfolio_manifest.json")},
                "manifest": manifest,
                "written": True,
            },
        }
    except (PortfolioError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


__all__ = ["PortfolioError", "run_portfolio"]
