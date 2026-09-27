"""Deterministic, label-agnostic cross-target budget allocation (G7 v0).

This module assigns an integer campaign budget to targets. It does not select
sequences and does not read wet-lab labels. Output files are stable across
processes and use only the Python standard library.
"""

import csv
import hashlib
import io
import json
import math
import os
import tempfile
from collections.abc import Mapping


SCHEMA_VERSION = "budget.v0"
HANDOFF_SCHEMA_VERSION = "galatea-handoff-v0"
WEIGHT_EXPONENT = 0.5
PRESETS = {
    "balanced": {"floor_fraction": 0.20, "exploit_fraction": 0.65, "reserve_fraction": 0.15},
    "global-best-affinity": {"floor_fraction": 0.15, "exploit_fraction": 0.70, "reserve_fraction": 0.15},
    "multi-target-aggregate": {"floor_fraction": 0.30, "exploit_fraction": 0.55, "reserve_fraction": 0.15},
    "per-target-coverage-heavy": {"floor_fraction": 0.45, "exploit_fraction": 0.40, "reserve_fraction": 0.15},
}
OPTIONAL_TARGET_FIELDS = (
    "n_eligible", "n_backbones", "n_contact_clusters", "pilot_attempts", "pilot_passes", "uncertainty",
)
COUNT_FIELDS = ("n_eligible", "n_backbones", "n_contact_clusters", "pilot_attempts", "pilot_passes")
CONFIG_KEYS = {
    "total_budget", "preset", "floor_fraction", "exploit_fraction", "reserve_fraction",
    "class_rule", "soft_threshold", "hard_threshold", "q_threshold", "contact_cap_requested",
    "portfolio_v1_validated", "reserve_fallback",
}
ALLOCATION_FIELDS = (
    "target_id", "r_tilde", "weight", "class", "uncertainty", "floor_q", "exploit_q",
    "reserve_q", "K_t", "q_density", "bb_cap_recommended", "bb_cap_reason",
    "contact_cluster_feasible", "flags", "reason_codes",
)


class BudgetInputError(ValueError):
    """Expected, user-correctable input or configuration error."""


def _stable_id(value):
    return value


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _canonical_json(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise BudgetInputError(f"config must be JSON-serializable: {exc}")


def _blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _read_targets(path):
    if not isinstance(path, str) or not path.strip():
        raise BudgetInputError("targets must be a non-empty file path")
    resolved = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(resolved):
        raise BudgetInputError(f"targets file not found: {resolved}")
    with open(resolved, "rb") as handle:
        raw_bytes = handle.read()
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise BudgetInputError(f"targets file must be UTF-8: {exc}")

    suffix = os.path.splitext(resolved)[1].lower()
    if suffix == ".csv":
        reader = csv.reader(io.StringIO(text, newline=""))
        try:
            fields = next(reader)
        except StopIteration:
            raise BudgetInputError("target CSV must have a header row")
        if not fields:
            raise BudgetInputError("target CSV must have a header row")
        for field in ("target_id", *OPTIONAL_TARGET_FIELDS):
            if fields.count(field) > 1:
                raise BudgetInputError(f"target CSV contains duplicate column {field}")
        rows = []
        known_fields = ("target_id", *OPTIONAL_TARGET_FIELDS)
        field_indexes = {field: index for index, field in enumerate(fields) if field in known_fields}
        for values in reader:
            if not values or all(not value.strip() for value in values):
                continue
            # Ignore extra/unknown cells, including any label-like columns. Only
            # fields in the G7 target contract are accessed below.
            rows.append({
                field: values[index] if index < len(values) else ""
                for field, index in field_indexes.items()
            })
    elif suffix == ".jsonl":
        fields = set()
        rows = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise BudgetInputError(f"invalid target JSONL at line {line_number}: {exc.msg}")
            if not isinstance(row, Mapping):
                raise BudgetInputError(f"target JSONL line {line_number} must be an object")
            if any(not isinstance(key, str) for key in row):
                raise BudgetInputError(f"target JSONL line {line_number} contains a non-string field name")
            known = {key: row[key] for key in ("target_id", *OPTIONAL_TARGET_FIELDS) if key in row}
            fields.update(known)
            rows.append(known)
    elif suffix == ".json":
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise BudgetInputError(f"invalid target JSON: {exc.msg}")
        if not isinstance(value, list) or any(not isinstance(row, Mapping) for row in value):
            raise BudgetInputError("target JSON must contain an array of objects")
        for index, row in enumerate(value, start=1):
            if any(not isinstance(key, str) for key in row):
                raise BudgetInputError(f"target row {index} contains a non-string field name")
        known_fields = ("target_id", *OPTIONAL_TARGET_FIELDS)
        rows = [{key: row[key] for key in known_fields if key in row} for row in value]
        fields = set().union(*(row.keys() for row in rows)) if rows else set()
    else:
        raise BudgetInputError("targets file extension must be .csv, .jsonl, or .json")

    if "target_id" not in fields:
        raise BudgetInputError("target table is missing required column target_id")
    if not rows:
        raise BudgetInputError("target table is empty")
    return rows, set(fields), resolved, raw_bytes


def _parse_count(value, field, target_id):
    if _blank(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise BudgetInputError(f"target {target_id!r} {field} must be an integer >= 0")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise BudgetInputError(f"target {target_id!r} {field} must be an integer >= 0")
    if isinstance(value, str) and str(parsed) != value.strip():
        raise BudgetInputError(f"target {target_id!r} {field} must be an integer >= 0")
    if parsed < 0:
        raise BudgetInputError(f"target {target_id!r} {field} must be an integer >= 0")
    return parsed


def _parse_uncertainty(value, target_id):
    if _blank(value):
        return None
    if isinstance(value, bool):
        raise BudgetInputError(f"target {target_id!r} uncertainty must be a finite number")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise BudgetInputError(f"target {target_id!r} uncertainty must be a finite number")
    if not math.isfinite(parsed):
        raise BudgetInputError(f"target {target_id!r} uncertainty must be a finite number")
    return 0.0 if parsed == 0.0 else parsed


def _normalize_targets(rows, fields, warnings):
    normalized = []
    seen = set()
    missing_optional = [field for field in OPTIONAL_TARGET_FIELDS if field not in fields]
    for field in missing_optional:
        warnings.append(f"optional target column missing: {field}")

    missing_counts = {field: 0 for field in OPTIONAL_TARGET_FIELDS}
    for index, source in enumerate(rows, start=1):
        target_id = source.get("target_id")
        if not isinstance(target_id, str) or not target_id.strip():
            raise BudgetInputError(f"target row {index} target_id must be a non-empty string")
        target_id = target_id.strip()
        if target_id in seen:
            raise BudgetInputError(f"duplicate target_id: {target_id}")
        seen.add(target_id)
        target = {"target_id": target_id}
        for field in COUNT_FIELDS:
            target[field] = _parse_count(source.get(field), field, target_id)
            if target[field] is None:
                missing_counts[field] += 1
        target["uncertainty"] = _parse_uncertainty(source.get("uncertainty"), target_id)
        if target["uncertainty"] is None:
            missing_counts["uncertainty"] += 1
        attempts = target["pilot_attempts"] or 0
        passes = target["pilot_passes"] or 0
        if passes > attempts:
            raise BudgetInputError(f"target {target_id!r} pilot_passes cannot exceed pilot_attempts")
        target["pilot_attempts"] = attempts
        target["pilot_passes"] = passes
        target["r_tilde"] = (passes + 1) / (attempts + 2)
        target["weight"] = math.sqrt(target["r_tilde"])
        normalized.append(target)

    for field in OPTIONAL_TARGET_FIELDS:
        if field not in fields:
            continue
        if missing_counts[field]:
            warnings.append(f"{field} missing for {missing_counts[field]} target(s); dependent feasibility/reporting is partial")
    return sorted(normalized, key=lambda item: _stable_id(item["target_id"]))


def _finite_number(value, name, minimum=None, maximum=None):
    if isinstance(value, bool):
        raise BudgetInputError(f"config.{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise BudgetInputError(f"config.{name} must be a finite number")
    if not math.isfinite(number):
        raise BudgetInputError(f"config.{name} must be a finite number")
    if minimum is not None and number < minimum or maximum is not None and number > maximum:
        raise BudgetInputError(f"config.{name} must be between {minimum} and {maximum}")
    return 0.0 if number == 0.0 else number


def _load_config(raw_config):
    if isinstance(raw_config, Mapping):
        raw = dict(raw_config)
        if any(not isinstance(key, str) for key in raw):
            raise BudgetInputError("config object keys must be strings")
        return raw, _sha256(_canonical_json(raw).encode("utf-8"))
    if isinstance(raw_config, str) and raw_config.strip():
        path = os.path.abspath(os.path.expanduser(raw_config))
        if not os.path.isfile(path):
            raise BudgetInputError(f"config file not found: {path}")
        with open(path, "rb") as handle:
            raw_bytes = handle.read()
        try:
            value = json.loads(raw_bytes.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BudgetInputError(f"cannot read config JSON: {exc}")
        if not isinstance(value, Mapping) or any(not isinstance(key, str) for key in value):
            raise BudgetInputError("config JSON must contain an object with string keys")
        return dict(value), _sha256(raw_bytes)
    if raw_config is None:
        return {}, _sha256(b"{}")
    raise BudgetInputError("config must be an inline object or JSON file path")


def _effective_config(raw):
    if not isinstance(raw, Mapping):
        raise BudgetInputError("config must be an object")
    warnings = []
    unknown = sorted((str(key) for key in raw if key not in CONFIG_KEYS))
    if unknown:
        warnings.append("unknown config keys ignored: " + ", ".join(unknown))
    missing = [key for key in ("total_budget",) if key not in raw]
    if missing:
        raise BudgetInputError("config.total_budget is required")
    total_budget = raw["total_budget"]
    if isinstance(total_budget, bool) or not isinstance(total_budget, int) or total_budget < 1:
        raise BudgetInputError("config.total_budget must be an integer >= 1")

    preset = raw.get("preset", "balanced")
    if not isinstance(preset, str) or preset not in PRESETS:
        raise BudgetInputError("config.preset must be balanced, global-best-affinity, multi-target-aggregate, or per-target-coverage-heavy")
    fractions = [raw.get(key) for key in ("floor_fraction", "exploit_fraction", "reserve_fraction")]
    provided = [value is not None for value in fractions]
    if any(provided) and not all(provided):
        raise BudgetInputError("floor_fraction, exploit_fraction, and reserve_fraction must be provided together")
    if all(provided):
        floor_fraction, exploit_fraction, reserve_fraction = [
            _finite_number(value, key, minimum=0.0, maximum=1.0)
            for value, key in zip(fractions, ("floor_fraction", "exploit_fraction", "reserve_fraction"))
        ]
        fraction_sum = math.fsum([floor_fraction, exploit_fraction, reserve_fraction])
        if abs(fraction_sum - 1.0) > 1e-9:
            raise BudgetInputError("floor_fraction + exploit_fraction + reserve_fraction must equal 1 within 1e-9")
        if fraction_sum != 1.0:
            floor_fraction /= fraction_sum
            exploit_fraction /= fraction_sum
            reserve_fraction /= fraction_sum
    else:
        selected = PRESETS[preset]
        floor_fraction = selected["floor_fraction"]
        exploit_fraction = selected["exploit_fraction"]
        reserve_fraction = selected["reserve_fraction"]

    class_rule = raw.get("class_rule", "tercile")
    if class_rule not in ("tercile", "absolute"):
        raise BudgetInputError("config.class_rule must be tercile or absolute")
    soft_threshold = raw.get("soft_threshold")
    hard_threshold = raw.get("hard_threshold")
    if class_rule == "absolute":
        if soft_threshold is None or hard_threshold is None:
            raise BudgetInputError("config.soft_threshold and config.hard_threshold are required for absolute class_rule")
        soft_threshold = _finite_number(soft_threshold, "soft_threshold", minimum=0.0, maximum=1.0)
        hard_threshold = _finite_number(hard_threshold, "hard_threshold", minimum=0.0, maximum=1.0)
        if hard_threshold > soft_threshold:
            raise BudgetInputError("config.hard_threshold must be <= config.soft_threshold")
    else:
        soft_threshold = None
        hard_threshold = None

    q_threshold = _finite_number(raw.get("q_threshold", 5), "q_threshold", minimum=0.0)
    contact_requested = raw.get("contact_cap_requested", True)
    portfolio_v1_validated = raw.get("portfolio_v1_validated", False)
    if not isinstance(contact_requested, bool):
        raise BudgetInputError("config.contact_cap_requested must be a boolean")
    if not isinstance(portfolio_v1_validated, bool):
        raise BudgetInputError("config.portfolio_v1_validated must be a boolean")
    reserve_fallback = raw.get("reserve_fallback", "weighted")
    if reserve_fallback not in ("weighted", "even"):
        raise BudgetInputError("config.reserve_fallback must be weighted or even")

    config = {
        "total_budget": total_budget,
        "preset": preset,
        "floor_fraction": floor_fraction,
        "exploit_fraction": exploit_fraction,
        "reserve_fraction": reserve_fraction,
        "class_rule": class_rule,
        "soft_threshold": soft_threshold,
        "hard_threshold": hard_threshold,
        "q_threshold": q_threshold,
        "contact_cap_requested": contact_requested,
        "portfolio_v1_validated": portfolio_v1_validated,
        "reserve_fallback": reserve_fallback,
        "weight_exponent": WEIGHT_EXPONENT,
    }
    return config, warnings


def _classify(targets, config):
    if config["class_rule"] == "absolute":
        for target in targets:
            if target["r_tilde"] >= config["soft_threshold"]:
                target["class"] = "soft"
            elif target["r_tilde"] <= config["hard_threshold"]:
                target["class"] = "hard"
            else:
                target["class"] = "uncertain"
        return
    data = [target for target in targets if target["pilot_attempts"] > 0]
    for target in targets:
        target["class"] = "uncertain"
    if len(data) < 3:
        return
    ranked = sorted(data, key=lambda item: (-item["r_tilde"], _stable_id(item["target_id"])))
    tail = (len(ranked) + 2) // 3
    for target in ranked[:tail]:
        target["class"] = "soft"
    for target in ranked[-tail:]:
        target["class"] = "hard"


def _floor_positive(value):
    return math.floor(value + 1e-9)


def _even_allocation(targets, pool, tie_key):
    result = {target["target_id"]: 0 for target in targets}
    if not targets or pool <= 0:
        return result
    ordered = sorted(targets, key=tie_key)
    base, remainder = divmod(pool, len(ordered))
    for target in ordered:
        result[target["target_id"]] = base
    for target in ordered[:remainder]:
        result[target["target_id"]] += 1
    return result


def _weighted_allocation(targets, pool):
    result = {target["target_id"]: 0 for target in targets}
    if not targets or pool <= 0:
        return result
    ordered = sorted(targets, key=lambda item: _stable_id(item["target_id"]))
    weight_sum = math.fsum(item["weight"] for item in ordered)
    if weight_sum <= 0.0:
        raise AssertionError("shrinkage weights must sum to a positive value")
    ideals = {item["target_id"]: pool * item["weight"] / weight_sum for item in ordered}
    whole = {target_id: _floor_positive(ideal) for target_id, ideal in ideals.items()}
    remainder = pool - sum(whole[target_id] for target_id in sorted(whole))
    if remainder < 0 or remainder > len(ordered):
        raise AssertionError("largest-remainder allocation produced an invalid remainder")
    fractional = {
        target_id: max(0.0, ideals[target_id] - whole[target_id])
        for target_id in ideals
    }
    tie_break = {item["target_id"]: item["r_tilde"] for item in ordered}
    ranked = sorted(
        ordered,
        key=lambda item: (-fractional[item["target_id"]], -tie_break[item["target_id"]], item["target_id"]),
    )
    for item in ordered:
        result[item["target_id"]] = whole[item["target_id"]]
    for item in ranked[:remainder]:
        result[item["target_id"]] += 1
    return result


def _allocate(targets, config, warnings, flags):
    total_budget = config["total_budget"]
    target_count = len(targets)
    if target_count == 0:
        raise BudgetInputError("target table must contain at least one target")
    if total_budget < target_count:
        ranked = sorted(targets, key=lambda item: (-item["r_tilde"], item["target_id"]))
        assigned = {target["target_id"]: 0 for target in targets}
        for target in ranked[:total_budget]:
            assigned[target["target_id"]] = 1
        for target in targets:
            target["floor_q"] = assigned[target["target_id"]]
            target["exploit_q"] = 0
            target["reserve_q"] = 0
            target["K_t"] = assigned[target["target_id"]]
        flags.append("BUDGET_BELOW_TARGET_COUNT")
        warnings.append("total_budget is below target count; only the top-ranked targets receive one slot each")
        pools = {"floor_pool": total_budget, "exploit_pool": 0, "reserve_pool": 0,
                 "shares": {"floor": 1.0, "exploit": 0.0, "reserve": 0.0}}
        return pools

    floor_pool = _floor_positive(config["floor_fraction"] * total_budget)
    exploit_pool = _floor_positive(config["exploit_fraction"] * total_budget)
    reserve_pool = total_budget - floor_pool - exploit_pool
    if reserve_pool < 0:
        raise AssertionError("floor and exploit pools exceed total budget")

    floor_allocation = _even_allocation(
        targets, floor_pool,
        lambda item: (-item["r_tilde"], item["target_id"]),
    )
    exploit_allocation = _weighted_allocation(targets, exploit_pool)

    reserve_targets = [target for target in targets if target["class"] in ("hard", "uncertain")]
    fallback_used = not reserve_targets
    if reserve_targets:
        reserve_allocation = _even_allocation(
            reserve_targets, reserve_pool,
            lambda item: (item["r_tilde"], item["target_id"]),
        )
        for target in targets:
            reserve_allocation.setdefault(target["target_id"], 0)
    elif config["reserve_fallback"] == "weighted":
        reserve_allocation = _weighted_allocation(targets, reserve_pool)
    else:
        reserve_allocation = _even_allocation(targets, reserve_pool, lambda item: item["target_id"])
    if fallback_used:
        flags.append("RESERVE_FALLBACK_USED")

    for target in targets:
        target["floor_q"] = floor_allocation[target["target_id"]]
        target["exploit_q"] = exploit_allocation[target["target_id"]]
        target["reserve_q"] = reserve_allocation[target["target_id"]]
        target["K_t"] = target["floor_q"] + target["exploit_q"] + target["reserve_q"]
    if sum(target["K_t"] for target in targets) != total_budget:
        raise AssertionError("allocated per-target quotas do not sum to total_budget")
    shares = {
        "floor": floor_pool / total_budget,
        "exploit": exploit_pool / total_budget,
        "reserve": reserve_pool / total_budget,
    }
    return {
        "floor_pool": floor_pool,
        "exploit_pool": exploit_pool,
        "reserve_pool": reserve_pool,
        "shares": shares,
        "reserve_eligible": sorted((item["target_id"] for item in reserve_targets)),
        "fallback_used": fallback_used,
    }


def _cap_feasibility(targets, config, warnings, global_flags, global_reasons):
    bb = {}
    contact = {}
    for target in targets:
        target_flags = target.setdefault("flags", [])
        target_reasons = target.setdefault("reason_codes", [])
        target_id = target["target_id"]
        count = target["n_backbones"]
        if count is None:
            target["bb_cap_recommended"] = None
            target["bb_cap_reason"] = None
            bb[target_id] = {"cap": None, "reason": None}
        elif count == 0 and target["K_t"] > 0:
            target["bb_cap_recommended"] = None
            target["bb_cap_reason"] = "CAP_RELAXED_INFEASIBLE"
            target_reasons.append("CAP_RELAXED_INFEASIBLE")
            bb[target_id] = {"cap": None, "reason": "CAP_RELAXED_INFEASIBLE"}
        elif 2 * count < target["K_t"]:
            cap = math.ceil(target["K_t"] / count)
            target["bb_cap_recommended"] = cap
            target["bb_cap_reason"] = "CAP_RELAXED_INFEASIBLE"
            target_reasons.append("CAP_RELAXED_INFEASIBLE")
            bb[target_id] = {"cap": cap, "reason": "CAP_RELAXED_INFEASIBLE"}
        else:
            target["bb_cap_recommended"] = 2
            target["bb_cap_reason"] = None
            bb[target_id] = {"cap": 2, "reason": None}

        clusters = target["n_contact_clusters"]
        if config["contact_cap_would_enable"]:
            if clusters is None:
                target["contact_cluster_feasible"] = None
                contact[target_id] = {"feasible": None, "cap_recommended": None, "reason": None}
            elif clusters >= target["K_t"]:
                target["contact_cluster_feasible"] = True
                contact[target_id] = {"feasible": True, "cap_recommended": 1, "reason": None}
            else:
                target["contact_cluster_feasible"] = False
                target_reasons.append("CAP_RELAXED_INFEASIBLE")
                contact[target_id] = {"feasible": False, "cap_recommended": 2,
                                      "reason": "CAP_RELAXED_INFEASIBLE"}
        else:
            target["contact_cluster_feasible"] = None
            contact[target_id] = {"feasible": None, "cap_recommended": None, "reason": None}

        target_flags[:] = sorted(set(target_flags))
        target_reasons[:] = sorted(set(target_reasons))
        global_flags.extend(target_flags)
        global_reasons.extend(target_reasons)
    return bb, contact


def _atomic_write(path, data):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    descriptor, temp_path = tempfile.mkstemp(prefix=".budget-", suffix=".tmp", dir=directory)
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


def _csv_cell(value):
    if value is None:
        return ""
    if isinstance(value, float):
        if value == 0.0:
            return "0"
        return format(value, ".17g")
    if isinstance(value, (Mapping, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return value


def _allocation_csv(targets):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=ALLOCATION_FIELDS, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for target in sorted(targets, key=lambda item: item["target_id"]):
        row = dict(target)
        n_eligible = target["n_eligible"]
        if n_eligible is not None and n_eligible > 0:
            row["q_density"] = target["K_t"] / n_eligible
        else:
            row["q_density"] = None
        row["flags"] = target.get("flags", [])
        row["reason_codes"] = target.get("reason_codes", [])
        writer.writerow({key: _csv_cell(row.get(key)) for key in ALLOCATION_FIELDS})
    return stream.getvalue().encode("utf-8")


def _json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def run_budget(args):
    """Allocate a total campaign budget across targets and write four audit artifacts."""
    try:
        if not isinstance(args, Mapping):
            raise BudgetInputError("budget args must be an object")
        if not isinstance(args.get("out"), str) or not args["out"].strip():
            raise BudgetInputError("out is required and must be a directory path")
        raw_config, config_hash = _load_config(args.get("config"))
        config, config_warnings = _effective_config(raw_config)
        warnings = list(config_warnings)
        rows, fields, targets_path, targets_bytes = _read_targets(args.get("targets"))
        targets = _normalize_targets(rows, fields, warnings)
        _classify(targets, config)

        total_budget = config["total_budget"]
        target_count = len(targets)
        q_density = total_budget / target_count
        density_mode = "low" if q_density <= config["q_threshold"] else "normal"
        contact_would_enable = (
            config["contact_cap_requested"]
            and q_density <= config["q_threshold"]
            and config["preset"] != "global-best-affinity"
        )
        config["density_mode"] = density_mode
        config["contact_cap_would_enable"] = contact_would_enable

        global_flags = []
        global_reasons = []
        tiers = _allocate(targets, config, warnings, global_flags)
        for target in targets:
            target["flags"] = []
            target["reason_codes"] = []
            n_eligible = target["n_eligible"]
            if n_eligible is not None and target["K_t"] > n_eligible:
                target["flags"].append("QUOTA_EXCEEDS_POOL")
            if n_eligible == 0 and target["K_t"] > 0:
                warnings.append(f"q_density undefined for {target['target_id']}: n_eligible is zero")

        if "reserve_eligible" not in tiers:
            tiers["reserve_eligible"] = []
            tiers["fallback_used"] = False
        bb_caps, contact_feasibility = _cap_feasibility(
            targets, config, warnings, global_flags, global_reasons,
        )
        flags = sorted(set(global_flags + [flag for target in targets for flag in target["flags"]]))
        reason_codes = sorted(set(global_reasons + [code for target in targets for code in target["reason_codes"]]))
        warnings = list(dict.fromkeys(warnings))

        achievable_total = sum(
            min(target["K_t"], target["n_eligible"])
            if target["n_eligible"] is not None else target["K_t"]
            for target in targets
        )
        per_target = {target["target_id"]: target["K_t"] for target in targets}
        class_lists = {
            name: sorted((target["target_id"] for target in targets if target["class"] == name))
            for name in ("soft", "uncertain", "hard")
        }
        summary = {
            "schema_version": SCHEMA_VERSION,
            "config": config,
            "totals": {
                "n_targets": target_count,
                "total_budget": total_budget,
                "q_density": q_density,
                "density_mode": density_mode,
            },
            "tiers": {
                "floor_pool": tiers["floor_pool"],
                "exploit_pool": tiers["exploit_pool"],
                "reserve_pool": tiers["reserve_pool"],
                "shares": tiers["shares"],
            },
            "allocation": {"per_target": per_target},
            "classes": class_lists,
            "feasibility": {
                "bb_cap": {"per_target": bb_caps},
                "contact_cap": {
                    "requested": config["contact_cap_requested"],
                    "would_enable": contact_would_enable,
                    "effective": contact_would_enable and config["portfolio_v1_validated"],
                    "q_threshold": config["q_threshold"],
                    "portfolio_v1_validated": config["portfolio_v1_validated"],
                    "feasibility": {"per_target": contact_feasibility},
                    "notes": ["production enablement requires external portfolio-v1 validation (R4 condition 1)"],
                },
            },
            "reserve": {
                "eligible": tiers["reserve_eligible"],
                "fallback_used": tiers["fallback_used"],
            },
            "achievable_total": achievable_total,
            "warnings": warnings,
            "flags": flags,
            "reason_codes": reason_codes,
        }

        handoff = {
            "schema_version": HANDOFF_SCHEMA_VERSION,
            "total": total_budget,
            "contact_cap": 1 if summary["feasibility"]["contact_cap"]["effective"] else "off",
            "targets": per_target,
            "density_mode": density_mode,
        }
        payloads = {
            "budget_allocation.csv": _allocation_csv(targets),
            "budget_summary.json": _json_bytes(summary),
            "portfolio_handoff.json": _json_bytes(handoff),
        }
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "inputs": {
                "targets_sha256": _sha256(targets_bytes),
                "config_sha256": config_hash,
            },
            "outputs": {name: _sha256(payloads[name]) for name in sorted(payloads)},
        }
        payloads["budget_manifest.json"] = _json_bytes(manifest)
        output_dir = os.path.abspath(os.path.expanduser(args["out"]))
        for name, data in payloads.items():
            _atomic_write(os.path.join(output_dir, name), data)
        return {
            "ok": True,
            "result": {
                "out": output_dir,
                "files": {name: os.path.join(output_dir, name) for name in payloads},
                "summary": summary,
                "manifest": manifest,
            },
        }
    except BudgetInputError as exc:
        return {"ok": False, "error": str(exc), "reason_code": "INVALID_INPUT"}
    except OSError as exc:
        return {"ok": False, "error": str(exc), "reason_code": "IO_ERROR"}


__all__ = ["BudgetInputError", "run_budget"]
