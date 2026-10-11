"""Deterministic, file-backed iteration planning for protein design campaigns.

The loop op is a decision and bookkeeping layer. It never launches sequence
generation or a remote prediction service. Sequence clusters use
``seq_analysis.cluster_sequences``.

Planning policy (v3):
* score candidates in each round, then convert consensus to a descending,
  tie-aware percentile (average rank / round size; best is 1.0);
* mark a candidate eligible iff QC is not FAIL and its percentile meets the
  requested floor. Ineligible candidates never enter a parent pool;
* target parents = min(max_parents, max(min_parents, cloud_budget_round // 6)),
  bounded by available eligible candidates. Allocate about 60/20/20 percent to
  exploitation / uncertainty / diversity, filling any short pool from the
  remaining eligible candidates;
* uncertainty is population standard deviation across usable predictor scores;
  fewer than two scores gives 0.0 and is reported as a fallback;
* exploit picks at most one candidate per lineage. Lineage follows parent_id
  through prior logged rounds; candidates without a parent start a lineage;
* diversity uses ``cluster_sequences`` first (different clusters rank above
  sequence distance), then greedy max-min prefix identity distance;
* cross-round score comparisons require adjacent rounds, verified declared
  metadata, identical actual candidate coverage and non-FAIL QC. The common
  comparison uses nine-decimal half-even consensus values. Unknown comparisons
  stay null and cannot trigger score-based stopping.

No generated timestamp is included: the same campaign state and params produce
the same plan JSON and response.
"""

import json
import math
import os
import re
import tempfile
from collections import defaultdict
from statistics import mean, median, pstdev


DEFAULT_PARAMS = {
    "cloud_budget_round": 96,
    "max_parents": 16,
    "min_parents": 8,
    "per_parent_local": 32,
    "cloud_per_parent": 6,
    "min_consensus_pctl": 0.50,
    "consensus_promotion_delta": 0.05,
    "max_rounds": 6,
    "consensus_improvement_epsilon": 0.02,
    "promotion_rate_stop_threshold": 0.05,
    "diversity_threshold": 0.8,
}

# R2: new absolute consensus thresholds have independent names. Legacy
# percentile thresholds and WorkBuddy improvement_abs parse but are ignored.
LOOP_POLICY_VERSION = "galatea.loop.v3"
DEPRECATED_PARAMS = {"promotion_delta", "improvement_epsilon", "improvement_abs"}


class LoopInputError(ValueError):
    """A normal, user-correctable loop request or campaign-data error."""


def _is_mapping(value):
    return isinstance(value, dict)


def _nonnegative_int(value, label, *, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise LoopInputError(f"{label} must be an integer >= {minimum}")
    return value


def _finite_number(value, label, *, minimum=None, maximum=None):
    if isinstance(value, bool):
        raise LoopInputError(f"{label} must be a finite number")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise LoopInputError(f"{label} must be a finite number")
    if not math.isfinite(parsed):
        raise LoopInputError(f"{label} must be a finite number")
    if minimum is not None and parsed < minimum:
        raise LoopInputError(f"{label} must be >= {minimum}")
    if maximum is not None and parsed > maximum:
        raise LoopInputError(f"{label} must be <= {maximum}")
    return parsed


def _campaign_dir(value):
    if not isinstance(value, str) or not value.strip() or not os.path.isabs(value):
        raise LoopInputError("campaign_dir must be an absolute path")
    return os.path.abspath(os.path.expanduser(value))


def _paths(campaign_dir):
    return {
        "campaign": os.path.join(campaign_dir, "campaign.json"),
        "rounds": os.path.join(campaign_dir, "rounds"),
        "plans": os.path.join(campaign_dir, "plans"),
    }


def _round_path(campaign_dir, round_id):
    return os.path.join(campaign_dir, "rounds", f"round_{round_id}.json")


def _read_json(path, label):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise LoopInputError(f"{label} not found: {path}")
    except (OSError, json.JSONDecodeError) as exc:
        raise LoopInputError(f"could not read {label} {path}: {exc}")


def _atomic_json(path, value):
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=parent,
            prefix=".galatea-loop-", suffix=".tmp", delete=False,
        ) as handle:
            temp_path = handle.name
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
            handle.write("\n")
        os.replace(temp_path, path)
    except (OSError, TypeError, ValueError) as exc:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
        if isinstance(exc, (TypeError, ValueError)):
            raise LoopInputError(f"campaign data must be JSON-compatible: {exc}")
        raise


def _round_id_from_entry(entry):
    if isinstance(entry, int) and not isinstance(entry, bool):
        return _nonnegative_int(entry, "round index round_id")
    if not _is_mapping(entry):
        raise LoopInputError("campaign rounds index contains an invalid entry")
    return _nonnegative_int(entry.get("round_id"), "round index round_id")


def _load_campaign(campaign_dir, *, required=True):
    path = _paths(campaign_dir)["campaign"]
    if not os.path.isfile(path):
        if required:
            raise LoopInputError(f"campaign not found: {path}")
        return None
    campaign = _read_json(path, "campaign")
    if not _is_mapping(campaign):
        raise LoopInputError(f"campaign must be a JSON object: {path}")
    rounds = campaign.get("rounds", [])
    if not isinstance(rounds, list):
        raise LoopInputError("campaign rounds index must be an array")
    campaign["rounds"] = rounds
    if not _is_mapping(campaign.get("operator_stats", {})):
        raise LoopInputError("campaign operator_stats must be an object")
    campaign.setdefault("operator_stats", {})
    return campaign


def _load_history(campaign_dir, campaign):
    history = []
    seen = set()
    for entry in campaign.get("rounds", []):
        round_id = _round_id_from_entry(entry)
        if round_id in seen:
            raise LoopInputError(f"duplicate round_id in campaign index: {round_id}")
        seen.add(round_id)
        record = _read_json(_round_path(campaign_dir, round_id), f"round {round_id}")
        if not _is_mapping(record) or record.get("round_id") != round_id:
            raise LoopInputError(f"round file {round_id} has an invalid round_id")
        candidates = record.get("candidates")
        if not isinstance(candidates, list):
            raise LoopInputError(f"round {round_id} candidates must be an array")
        if "round_content_sha256" in record:
            from score_contract import digest
            content = {key: value for key, value in record.items() if key != "round_content_sha256"}
            if record["round_content_sha256"] != digest(content):
                raise LoopInputError(f"round {round_id} content hash mismatch")
        history.append(record)
    history.sort(key=lambda item: item["round_id"])
    return history


def _normalize_candidates(raw_candidates):
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise LoopInputError("round.candidates must be a non-empty array")
    seen = set()
    normalized = []
    for index, candidate in enumerate(raw_candidates):
        if not _is_mapping(candidate):
            raise LoopInputError(f"round.candidates[{index}] must be an object")
        item = {str(key): value for key, value in candidate.items()}
        candidate_id = item.get("candidate_id")
        if candidate_id is None or not str(candidate_id).strip():
            raise LoopInputError(f"round.candidates[{index}].candidate_id is required")
        candidate_id = str(candidate_id).strip()
        if candidate_id in seen:
            raise LoopInputError(f"duplicate candidate_id in round: {candidate_id}")
        seen.add(candidate_id)
        item["candidate_id"] = candidate_id

        qc_status = item.get("qc_status", "WARN")
        if qc_status is None or not str(qc_status).strip():
            qc_status = "WARN"
        qc_status = str(qc_status).strip().upper()
        if qc_status not in ("PASS", "WARN", "FAIL"):
            raise LoopInputError(f"candidate {candidate_id!r} qc_status must be PASS, WARN, or FAIL")
        item["qc_status"] = qc_status

        parent_id = item.get("parent_id")
        item["parent_id"] = str(parent_id).strip() if parent_id is not None and str(parent_id).strip() else None
        sequence = item.get("sequence")
        if sequence is not None:
            if not isinstance(sequence, str):
                raise LoopInputError(f"candidate {candidate_id!r} sequence must be a string")
            item["sequence"] = sequence.strip().upper()
        flags = item.get("flags", {})
        if flags is None:
            flags = {}
        if not _is_mapping(flags):
            raise LoopInputError(f"candidate {candidate_id!r} flags must be an object")
        item["flags"] = flags
        normalized.append(item)

    # Raw prediction failures may have no usable score. Keep them as records,
    # without manufacturing consensus zero or promoting them to a typed batch.
    from rank_tools import _extract_scores, _score_map_fields, DEFAULT_SCORE_PREFIX
    for item in normalized:
        if "predictor_metadata" in item or "score_contract" in item or "score_fingerprint" in item:
            raise LoopInputError("candidate-level score declarations are unsupported; use round.predictor_metadata")
        try:
            scores = _extract_scores(item, DEFAULT_SCORE_PREFIX, _score_map_fields({}),
                                     f"candidate {item['candidate_id']!r}")
        except ValueError as exc:
            raise LoopInputError(f"invalid candidate scores: {exc}")
        item["predictor_scores"] = scores
        item["predictor_coverage"] = sorted(scores)
        item["consensus"] = mean(scores.values()) if scores else None
        item["n_scores"] = len(scores)
    return normalized


def _recompute_operator_stats(campaign_dir):
    stats = defaultdict(int)
    plans_dir = _paths(campaign_dir)["plans"]
    if os.path.isdir(plans_dir):
        for name in sorted(os.listdir(plans_dir)):
            if not (name.endswith("_plan.json") or name.endswith("_plan_v3.json")):
                continue
            path = os.path.join(plans_dir, name)
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    plan = json.load(handle)
            except (OSError, json.JSONDecodeError):
                continue
            round_plan = plan.get("round_plan", {}) if _is_mapping(plan) else {}
            for parent in round_plan.get("parents", []) if _is_mapping(round_plan) else []:
                for operator in parent.get("operators", []) if _is_mapping(parent) else []:
                    if _is_mapping(operator) and isinstance(operator.get("op"), str):
                        stats[operator["op"]] += int(operator.get("n", 0))
    return dict(sorted(stats.items()))


def _log(args):
    campaign_dir = _campaign_dir(args.get("campaign_dir"))
    raw_round = args.get("round")
    if not _is_mapping(raw_round):
        raise LoopInputError("round must be an object")
    round_id = _nonnegative_int(raw_round.get("round_id"), "round.round_id")
    candidates = _normalize_candidates(raw_round.get("candidates"))
    if "score_contract" in raw_round or "score_fingerprint" in raw_round:
        raise LoopInputError("round score contract is derived from round.predictor_metadata")
    from score_contract import ScoreContractError, digest, validate_predictor_metadata
    actual_predictors = sorted({key for item in candidates for key in item["predictor_scores"]})
    try:
        contract = validate_predictor_metadata(raw_round.get("predictor_metadata"), actual_predictors)[2]
    except ScoreContractError as exc:
        raise LoopInputError(f"{exc.code}: {exc}")
    for item in candidates:
        complete = bool(item["predictor_scores"]) and set(item["predictor_scores"]) == set(actual_predictors)
        item["comparability"] = ("comparable" if complete else "missing_predictor") if contract["comparability"] == "comparable" else "unknown"
        item["score_fingerprint"] = contract["fingerprint"] if item["comparability"] == "comparable" else None

    existing = _load_campaign(campaign_dir, required=False)
    indexed_rounds = [] if existing is None else existing["rounds"]
    indexed_ids = {_round_id_from_entry(entry) for entry in indexed_rounds}
    target_path = _round_path(campaign_dir, round_id)
    overwrite = args.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise LoopInputError("overwrite must be a boolean")
    if (round_id in indexed_ids or os.path.exists(target_path)) and not overwrite:
        raise LoopInputError(f"round_id {round_id} already exists; set overwrite=true to replace it")

    os.makedirs(_paths(campaign_dir)["rounds"], exist_ok=True)
    record = {
        "round_id": round_id,
        "candidates": candidates,
        "notes": raw_round.get("notes"),
        "score_contract": contract,
        "predictor_metadata": contract.get("predictor_metadata"),
    }
    record["round_content_sha256"] = digest(record)
    _atomic_json(target_path, record)

    campaign = existing or {
        "schema_version": 1,
        "campaign_id": os.path.basename(campaign_dir.rstrip(os.sep)),
        "rounds": [],
        "operator_stats": {},
    }
    indexed_ids.add(round_id)
    campaign["rounds"] = [
        {"round_id": item, "path": f"rounds/round_{item}.json"}
        for item in sorted(indexed_ids)
    ]
    campaign["operator_stats"] = _recompute_operator_stats(campaign_dir)
    _atomic_json(_paths(campaign_dir)["campaign"], campaign)
    return {
        "ok": True,
        "campaign_dir": campaign_dir,
        "round_id": round_id,
        "n_candidates": len(candidates),
        "rounds_total": len(campaign["rounds"]),
    }


def _parse_params(raw):
    if raw is None:
        raw = {}
    if not _is_mapping(raw):
        raise LoopInputError("params must be an object")
    unknown = sorted(set(raw) - set(DEFAULT_PARAMS) - DEPRECATED_PARAMS)
    if unknown:
        raise LoopInputError(f"unknown params: {', '.join(unknown)}")
    params = dict(DEFAULT_PARAMS)
    params.update({key: value for key, value in raw.items() if key in DEFAULT_PARAMS})
    params["deprecated_params_ignored"] = sorted(set(raw) & DEPRECATED_PARAMS)
    for name in ("cloud_budget_round", "max_parents", "min_parents", "per_parent_local", "cloud_per_parent", "max_rounds"):
        minimum = 1 if name in ("max_parents", "min_parents", "per_parent_local", "cloud_per_parent", "max_rounds") else 0
        params[name] = _nonnegative_int(params[name], f"params.{name}", minimum=minimum)
    if params["min_parents"] > params["max_parents"]:
        raise LoopInputError("params.min_parents cannot exceed params.max_parents")
    for name in ("min_consensus_pctl", "diversity_threshold", "promotion_rate_stop_threshold"):
        params[name] = _finite_number(params[name], f"params.{name}", minimum=0.0, maximum=1.0)
    if params["diversity_threshold"] == 0:
        raise LoopInputError("params.diversity_threshold must be > 0")
    for name in ("consensus_promotion_delta", "consensus_improvement_epsilon"):
        params[name] = _finite_number(params[name], f"params.{name}", minimum=0.0)
    return params


def _percentiles(scored):
    values = sorted(item["consensus"] for item in scored)
    count = len(values)
    out = {}
    from bisect import bisect_left, bisect_right
    for item in scored:
        value = item["consensus"]
        first = bisect_left(values, value)
        after = bisect_right(values, value)
        average_rank = ((first + 1) + after) / 2.0
        out[item["candidate_id"]] = average_rank / count
    return out


def _cluster_assignments(items, threshold, *, chronological=False):
    sequenced = [(index, item) for index, item in enumerate(items) if item.get("sequence")]
    if not sequenced:
        return {}, set()
    if chronological:
        ordered = sorted(sequenced, key=lambda pair: (
            pair[1]["round_id"], -(pair[1]["consensus_percentile"] or 0.0), pair[1]["candidate_id"]
        ))
    else:
        ordered = sorted(sequenced, key=lambda pair: (-(pair[1]["consensus_percentile"] or 0.0), pair[1]["candidate_id"]))
    from seq_analysis import cluster_sequences
    result = cluster_sequences([item["sequence"] for _, item in ordered], threshold=threshold)
    if result.get("status") != "ok":
        raise LoopInputError(f"sequence clustering failed: {result.get('error', 'unknown error')}")
    assignments = {}
    representative_keys = set()
    for cluster in result["clusters"]:
        rep_i = cluster["representative_index"]
        rep_item = ordered[rep_i][1]
        representative_keys.add(rep_item["_key"])
        for member_i in cluster["members"]:
            item = ordered[member_i][1]
            assignments[item["_key"]] = cluster["cluster_id"]
    return assignments, representative_keys


def _pair_comparison(old, new):
    """One shared gate for parent, lineage and campaign score comparisons."""
    from score_contract import comparison_delta
    if old is None or new is None:
        return "NO_PAIR", None
    if new["round_id"] != old["round_id"] + 1:
        return "NONADJACENT_ROUNDS", None
    if old.get("qc_status") == "FAIL" or new.get("qc_status") == "FAIL":
        return "QC_FAIL", None
    if old.get("comparability") != "comparable" or new.get("comparability") != "comparable":
        return "UNVERIFIED_SCORE_SCHEMA", None
    if (old.get("score_fingerprint") != new.get("score_fingerprint")
            or old.get("predictor_coverage") != new.get("predictor_coverage")):
        return "INCOMPARABLE_SCORE_SCHEMA", None
    if old.get("consensus") is None or new.get("consensus") is None:
        return "NO_SCORE", None
    return "comparable", comparison_delta(new["consensus"], old["consensus"])


def _prepare_history(history, diversity_threshold, promotion_delta):
    from rank_tools import _extract_scores, _score_map_fields, DEFAULT_SCORE_PREFIX
    from score_contract import ScoreContractError, verify_report, comparison_threshold

    rounds, all_items, by_round_id = [], [], {}
    for record in history:
        round_id = record["round_id"]
        items = []
        for source_item in record["candidates"]:
            item = dict(source_item)
            try:
                scores = _extract_scores(item, DEFAULT_SCORE_PREFIX, _score_map_fields({}),
                                         f"candidate {item['candidate_id']!r}")
            except ValueError as exc:
                raise LoopInputError(f"invalid historical scores: {exc}")
            if "round_content_sha256" in record and scores != item.get("predictor_scores"):
                raise LoopInputError(f"round {round_id} stored predictor scores differ from source")
            item["predictor_scores"] = scores
            item["predictor_coverage"] = sorted(scores)
            item["consensus"] = mean(scores.values()) if scores else None
            item["n_scores"] = len(scores)
            item["uncertainty"] = pstdev(scores.values()) if len(scores) >= 2 else 0.0
            item["round_id"] = round_id
            item["_key"] = (round_id, item["candidate_id"])
            items.append(item)
        actual = sorted({key for item in items for key in item["predictor_scores"]})
        contract = record.get("score_contract") if "round_content_sha256" in record else None
        if contract is not None:
            try:
                contract = verify_report(contract, actual)
            except ScoreContractError as exc:
                raise LoopInputError(f"round {round_id} {exc.code}: {exc}")
        for item in items:
            full = bool(item["predictor_scores"]) and set(item["predictor_scores"]) == set(actual)
            item["comparability"] = ("comparable" if full else "missing_predictor") if contract and contract["comparability"] == "comparable" else "unknown"
            item["score_fingerprint"] = contract["fingerprint"] if item["comparability"] == "comparable" else None
        scored = [item for item in items if item["consensus"] is not None]
        percentiles = _percentiles(scored) if scored else {}
        for item in items:
            item["consensus_percentile"] = percentiles.get(item["candidate_id"])
        round_status = ("UNVERIFIED_SCORE_SCHEMA" if contract is None or contract["comparability"] != "comparable"
                        else "comparable" if all(i["comparability"] == "comparable" for i in items)
                        else "INCOMPARABLE_SCORE_SCHEMA")
        rounds.append({"round_id": round_id, "items": items, "score_contract": contract,
                       "schema_status": round_status})
        all_items.extend(items)
        by_round_id[round_id] = {item["candidate_id"]: item for item in items}

    seq_clusters, new_cluster_roots = _cluster_assignments(all_items, diversity_threshold, chronological=True)
    for item in all_items:
        item["history_cluster"] = seq_clusters.get(item["_key"])
        item["new_cluster"] = item["_key"] in new_cluster_roots

    def find_parent(item):
        parent_id = item.get("parent_id")
        if not parent_id:
            return None
        for prior_id in sorted((rid for rid in by_round_id if rid < item["round_id"]), reverse=True):
            found = by_round_id[prior_id].get(parent_id)
            if found is not None:
                return found
        return None

    def lineage(item):
        visited = set()
        current = item
        while current.get("parent_id"):
            if current["_key"] in visited:
                break
            visited.add(current["_key"])
            parent = find_parent(current)
            if parent is None:
                return f"lineage:external:{current['parent_id']}"
            current = parent
        return f"lineage:r{current['round_id']}:{current['candidate_id']}"

    threshold = comparison_threshold(promotion_delta)
    for item in all_items:
        item["lineage_id"] = lineage(item)
        parent = find_parent(item)
        item["parent_candidate"] = parent
        status, delta = _pair_comparison(parent, item)
        item["promotion_status"] = status
        item["promotion_delta"] = float(delta) if delta is not None else None
        item["promoted"] = bool(delta >= threshold) if status == "comparable" else None

    for row in rounds:
        items = row["items"]
        scored = sorted((i for i in items if i["consensus"] is not None),
                        key=lambda i: (-i["consensus"], i["candidate_id"]))
        eligible = [i for i in scored if i.get("qc_status") != "FAIL" and i["comparability"] == "comparable"]
        row["best_consensus"] = scored[0]["consensus"] if scored else None
        row["median_consensus"] = median(i["consensus"] for i in scored) if scored else None
        row["best_percentile"] = scored[0]["consensus_percentile"] if scored else None
        row["best_candidate_id"] = scored[0]["candidate_id"] if scored else None
        row["best_eligible_item"] = eligible[0] if eligible else None
        row["best_consensus_eligible"] = eligible[0]["consensus"] if eligible else None
        evaluated = [i for i in items if i["promotion_status"] == "comparable"]
        row["promoted_count"] = sum(i["promoted"] is True for i in evaluated)
        row["promotion_denominator"] = len(evaluated)
        row["promotion_unknown_count"] = sum(i["parent_candidate"] is not None and i["promotion_status"] != "comparable" for i in items)
        row["promoted_rate"] = row["promoted_count"] / len(evaluated) if evaluated else None
    return rounds, all_items, find_parent


def _score_schema_status(rounds):
    statuses = {row["schema_status"] for row in rounds}
    if statuses == {"UNVERIFIED_SCORE_SCHEMA"}:
        return "UNVERIFIED_SCORE_SCHEMA"
    if statuses != {"comparable"}:
        return "INCOMPARABLE_SCORE_SCHEMA"
    fingerprints = {row["score_contract"]["fingerprint"] for row in rounds}
    return "comparable" if len(fingerprints) == 1 else "INCOMPARABLE_SCORE_SCHEMA"


def _stop_lineages(rounds, all_items, improvement_epsilon=0.02):
    from score_contract import comparison_threshold
    threshold = comparison_threshold(improvement_epsilon)
    lineage_ids = sorted({item["lineage_id"] for item in all_items})
    stopped = []
    for lineage_id in lineage_ids:
        first_index = next(i for i, row in enumerate(rounds) if any(x["lineage_id"] == lineage_id for x in row["items"]))
        trail = []
        previous = None
        for row in rounds[first_index:]:
            members = [item for item in row["items"] if item["lineage_id"] == lineage_id
                       and item["qc_status"] != "FAIL" and item["comparability"] == "comparable"]
            new_cluster = any(item["new_cluster"] for item in members)
            current = max(members, key=lambda item: (item["consensus"], item["candidate_id"])) if members else None
            status, delta = _pair_comparison(previous, current)
            trail.append({"status": status, "delta": delta, "new_cluster": new_cluster})
            previous = current
        if len(trail) >= 3 and all(point["status"] == "comparable"
                                   and point["delta"] < threshold
                                   and not point["new_cluster"] for point in trail[-2:]):
            stopped.append(lineage_id)
    return stopped


def _campaign_summary(rounds, all_items, params):
    lineage_count = len({item["lineage_id"] for item in all_items})
    high_confidence = sum(
        1 for item in all_items
        if item.get("qc_status", "WARN") != "FAIL"
        and item["consensus_percentile"] is not None
        and item["consensus_percentile"] >= max(params["min_consensus_pctl"], 0.80)
    )
    return {
        "rounds": len(rounds),
        "n_candidates": len(all_items),
        "n_lineages": lineage_count,
        "high_confidence_eligible_candidates": high_confidence,
        "best_per_round": [
            {"round": row["round_id"], "candidate_id": row["best_candidate_id"],
             "consensus": row["best_consensus"], "consensus_percentile": row["best_percentile"]}
            for row in rounds
        ],
        "median_consensus_per_round": [
            {"round": row["round_id"], "consensus": row["median_consensus"]} for row in rounds
        ],
        "promoted_rate_per_round": [
            {"round": row["round_id"], "rate": row["promoted_rate"],
             "promoted": row["promoted_count"], "denominator": row["promotion_denominator"],
             "unknown_pairs": row["promotion_unknown_count"], "n_candidates": len(row["items"])}
            for row in rounds
        ],
        "score_comparison_policy": "consensus_decimal_9_places_half_even",
    }


def _stop_reasons(rounds, all_items, summary, params, schema_status=None):
    from score_contract import comparison_threshold
    reasons = []
    rate_threshold = params["promotion_rate_stop_threshold"]
    rates = [row["promoted_rate"] for row in rounds]
    if len(rates) >= 2 and all(rate is not None and rate < rate_threshold for rate in rates[-2:]):
        reasons.append("promoted_rate_below_threshold_for_2_rounds")
    if len(rounds) >= 3:
        first, second, third = rounds[-3:]
        s1, d1 = _pair_comparison(first["best_eligible_item"], second["best_eligible_item"])
        s2, d2 = _pair_comparison(second["best_eligible_item"], third["best_eligible_item"])
        threshold = comparison_threshold(params["consensus_improvement_epsilon"])
        if s1 == s2 == "comparable" and d1 < threshold and d2 < threshold:
            reasons.append("best_consensus_improvement_below_epsilon_for_2_rounds")
    if summary["high_confidence_eligible_candidates"] >= 100:
        reasons.append("100_high_confidence_eligible_candidates_reached")
    if len(rounds) >= params["max_rounds"]:
        reasons.append("max_rounds_reached")
    return reasons


def _quantile_75(values):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.75 * len(ordered)) - 1)]


def _prefix_distance(a, b):
    from seq_analysis import sequence_identity
    return 1.0 - sequence_identity(a, b)


def _diversity_pick(remaining, slots):
    if slots <= 0 or not remaining:
        return []
    pending = list(remaining)
    chosen = []
    while pending and len(chosen) < slots:
        if not chosen:
            best = max(pending, key=lambda item: (item["consensus_percentile"], item["candidate_id"]))
        else:
            def diversity_key(item):
                distances = []
                for selected in chosen:
                    known_different_cluster = (
                        item.get("round_cluster") is not None
                        and selected.get("round_cluster") is not None
                        and item["round_cluster"] != selected["round_cluster"]
                    )
                    sequence_distance = 0.0
                    if item.get("sequence") and selected.get("sequence"):
                        sequence_distance = _prefix_distance(item["sequence"], selected["sequence"])
                    distances.append((1 if known_different_cluster else 0, sequence_distance))
                min_distance = min(distances)
                return (min_distance[0], min_distance[1], item["consensus_percentile"], item["candidate_id"])
            best = max(pending, key=diversity_key)
        chosen.append(best)
        pending.remove(best)
    return chosen


def _local_operators(total):
    # Largest remainder allocation keeps the default contract exactly 16/8/8.
    weights = [("fixed_interface_solublempnn", "soluble_mpnn", 0.1, 0.50),
               ("anchor_fixed_solublempnn", "soluble_mpnn", 0.12, 0.25),
               ("explore_mpnn", "protein_mpnn", 0.25, 0.25)]
    raw = [total * row[3] for row in weights]
    counts = [math.floor(value) for value in raw]
    left = total - sum(counts)
    order = sorted(range(len(raw)), key=lambda i: (-(raw[i] - counts[i]), i))
    for i in order[:left]:
        counts[i] += 1
    return [
        {"op": op, "model": model, "temperature": temperature, "n": counts[i]}
        for i, (op, model, temperature, _) in enumerate(weights)
    ]


def _find_contact_consensus(item):
    """Return a minimally valid per-candidate consensus payload, or None."""
    if not _is_mapping(item):
        return None
    flags = item.get("flags", {})
    candidates = [item.get("contact_consensus")]
    if _is_mapping(flags):
        candidates.append(flags.get("contact_consensus"))
    for value in candidates:
        if _is_mapping(value) and isinstance(value.get("anchor_residues"), list):
            return value
    return None


def _select_parents(latest_items, params, stop_lineages):
    all_round_clusters, _ = _cluster_assignments(latest_items, params["diversity_threshold"])
    working = []
    fail_count = 0
    below_floor_count = 0
    no_score_count = 0
    for source in latest_items:
        item = dict(source)
        item["round_cluster"] = all_round_clusters.get(item["_key"])
        if item.get("qc_status", "WARN") == "FAIL":
            fail_count += 1
            continue
        if item["consensus_percentile"] is None:
            no_score_count += 1
            continue
        if item["consensus_percentile"] < params["min_consensus_pctl"]:
            below_floor_count += 1
            continue
        working.append(item)
    stopped = [item for item in working if item["lineage_id"] in stop_lineages]
    available = [item for item in working if item["lineage_id"] not in stop_lineages]
    requested = min(
        params["max_parents"],
        max(params["min_parents"], params["cloud_budget_round"] // 6),
    )
    parent_target = min(requested, len(available))
    exploit_slots = math.ceil(parent_target * 0.60)
    uncertainty_slots = math.ceil(parent_target * 0.20)
    q75 = _quantile_75([item["uncertainty"] for item in latest_items])

    ranked = sorted(available, key=lambda item: (-item["consensus_percentile"], item["candidate_id"]))
    exploit_candidates = [item for item in ranked if item["consensus_percentile"] >= 0.80]
    exploit = []
    used_lineages = set()
    for item in exploit_candidates:
        if item["lineage_id"] in used_lineages:
            continue
        exploit.append(item)
        used_lineages.add(item["lineage_id"])
        if len(exploit) >= exploit_slots:
            break

    chosen_keys = {item["_key"] for item in exploit}
    uncertain_candidates = [
        item for item in ranked
        if item["_key"] not in chosen_keys
        and item["consensus_percentile"] >= 0.50
        and item["uncertainty"] >= q75
    ]
    uncertainty = uncertain_candidates[:uncertainty_slots]
    chosen_keys.update(item["_key"] for item in uncertainty)

    diversity_slots = max(0, parent_target - len(exploit) - len(uncertainty))
    diversity_candidates = [item for item in ranked if item["_key"] not in chosen_keys]
    diversity = _diversity_pick(diversity_candidates, diversity_slots)
    chosen_keys.update(item["_key"] for item in diversity)

    selected = [(item, "exploit", ["consensus_percentile_at_least_0.80", "lineage_unique_exploitation"])
                for item in exploit]
    selected.extend((item, "anchor", ["consensus_percentile_at_least_0.50", "uncertainty_at_or_above_q75"])
                    for item in uncertainty)
    selected.extend((item, "explore", ["greedy_max_min_sequence_diversity"])
                    for item in diversity)
    if len(selected) < parent_target:
        fallback = [item for item in ranked if item["_key"] not in chosen_keys]
        for item in fallback[:parent_target - len(selected)]:
            selected.append((item, "explore", ["pool_fill_fallback"]))
    selected.sort(key=lambda row: (-row[0]["consensus_percentile"], row[0]["candidate_id"]))

    local_ops = _local_operators(params["per_parent_local"])
    parents = []
    for item, role, reason_codes in selected:
        notes = []
        contact_consensus = _find_contact_consensus(item)
        if not item.get("structure_path"):
            notes.append("no structure_path: execution should degrade interface-residue freezing; freeze binder residues within 4 A of any target heavy atom when structure input becomes available")
        else:
            notes.append("structure_path is recorded; loop does not inspect it, so confirm binder-target contact residues during execution")
        if contact_consensus is None:
            notes.append("no contact-consensus input: anchor selection cannot enforce contact frequency >= 0.7 and must be marked as degraded")
        else:
            anchor_residues = [str(label).strip() for label in contact_consensus["anchor_residues"]
                               if str(label).strip()]
            status = str(contact_consensus.get("status") or "UNKNOWN").upper()
            if status == "INSUFFICIENT":
                anchor_residues = []
                notes.append("no contact-consensus input: anchor selection cannot enforce contact frequency >= 0.7 and must be marked as degraded")
            else:
                notes.append(
                    f"anchor residues from contact-consensus (n={len(anchor_residues)}, status={status})"
                )
        parent = {
            "candidate_id": item["candidate_id"],
            "role": role,
            "lineage_id": item["lineage_id"],
            "consensus": item["consensus"],
            "consensus_percentile": item["consensus_percentile"],
            "uncertainty": item["uncertainty"],
            "sequence_cluster": item.get("round_cluster"),
            "operators": local_ops,
            "n_local": params["per_parent_local"],
            "n_cloud": params["cloud_per_parent"],
            "reason_codes": reason_codes,
            "operator_notes": notes,
        }
        if contact_consensus is not None:
            parent["anchor_residues"] = anchor_residues
        parents.append(parent)

    warnings = []
    fallback_count = sum(1 for item in latest_items if len(item["predictor_scores"]) < 2)
    if fallback_count:
        warnings.append({"code": "uncertainty_fallback", "n_candidates": fallback_count,
                         "message": "uncertainty is 0.0 for candidates with fewer than two usable predictors"})
    reasons = []
    if len(working) < requested:
        reasons.append("eligible_candidates_below_requested_parent_count")
    if stopped:
        reasons.append("stopped_lineages_excluded")
    if not selected:
        reasons.append("no_available_eligible_parent")
    counts = {"exploitation": len(exploit), "uncertainty": len(uncertainty), "diversity": 0}
    for parent in parents:
        if parent["role"] == "explore":
            counts["diversity"] += 1
    return {
        "parents": parents,
        "requested_parent_count": requested,
        "n_parents": len(parents),
        "eligibility": {
            "n_candidates": len(latest_items),
            "eligible": len(working),
            "excluded_qc_fail": fail_count,
            "excluded_no_score": no_score_count,
            "excluded_below_consensus_percentile": below_floor_count,
            "excluded_stopped_lineages": len(stopped),
            "min_consensus_pctl": params["min_consensus_pctl"],
        },
        "pool_counts": counts,
        "uncertainty_q75": q75,
        "warnings": warnings,
        "reason_codes": reasons,
    }


def _next(args):
    campaign_dir = _campaign_dir(args.get("campaign_dir"))
    params = _parse_params(args.get("params"))
    campaign = _load_campaign(campaign_dir)
    history = _load_history(campaign_dir, campaign)
    if not history:
        raise LoopInputError("cannot plan next round: campaign has no logged rounds")
    rounds, all_items, _ = _prepare_history(history, params["diversity_threshold"],
                                            params["consensus_promotion_delta"])
    schema_status = _score_schema_status(rounds)
    summary = _campaign_summary(rounds, all_items, params)
    stop_lineages = _stop_lineages(rounds, all_items, params["consensus_improvement_epsilon"])
    stop_reasons = _stop_reasons(rounds, all_items, summary, params, schema_status)
    latest = rounds[-1]
    selection = _select_parents(latest["items"], params, set(stop_lineages))
    local_sequences = sum(parent["n_local"] for parent in selection["parents"])
    cloud_predictions = sum(parent["n_cloud"] for parent in selection["parents"])
    round_plan = {
        "round": latest["round_id"] + 1,
        "policy_version": LOOP_POLICY_VERSION,
        "score_schema_status": schema_status,
        "parents": selection["parents"],
        "stop_lineages": stop_lineages,
        "stop_recommended": bool(stop_reasons),
        "stop_reason": stop_reasons,
        "budget": {"local_sequences": local_sequences, "cloud_predictions": cloud_predictions},
        "eligibility": selection["eligibility"],
        "pool_counts": selection["pool_counts"],
        "requested_parent_count": selection["requested_parent_count"],
        "n_parents": selection["n_parents"],
        "selection_reason_codes": selection["reason_codes"],
        "warnings": selection["warnings"],
        "params": params,
    }
    plan_path = os.path.join(_paths(campaign_dir)["plans"], f"round_{latest['round_id'] + 1}_plan_v3.json")
    output = {"ok": True, "round_plan": round_plan, "campaign_summary": summary, "plan_path": plan_path}
    _atomic_json(plan_path, output)
    return output


def _latest_plan(campaign_dir):
    plans_dir = _paths(campaign_dir)["plans"]
    if not os.path.isdir(plans_dir):
        return None
    matches = []
    for name in os.listdir(plans_dir):
        match = re.fullmatch(r"round_(\d+)_plan_v3\.json", name)
        if match:
            matches.append((int(match.group(1)), os.path.join(plans_dir, name)))
    return max(matches, default=(None, None), key=lambda item: item[0])[1]


def _status(args):
    campaign_dir = _campaign_dir(args.get("campaign_dir"))
    campaign = _load_campaign(campaign_dir)
    history = _load_history(campaign_dir, campaign)
    if not history:
        return {"ok": True, "status": {
            "campaign_dir": campaign_dir, "rounds": 0, "n_candidates": 0,
            "n_lineages": 0, "best_per_round": [], "median_consensus_per_round": [],
            "promoted_rate_per_round": [], "latest_plan_path": _latest_plan(campaign_dir),
            "recommendation": "补数据",
        }}
    latest_plan = _latest_plan(campaign_dir)
    saved_plan = _read_json(latest_plan, "latest plan") if latest_plan else None
    planned_round = (saved_plan or {}).get("round_plan", {}) if _is_mapping(saved_plan) else {}
    if (planned_round.get("policy_version") == LOOP_POLICY_VERSION
            and planned_round.get("round") == history[-1]["round_id"] + 1):
        params = _parse_params({key: value for key, value in (planned_round.get("params") or {}).items()
                                if key in DEFAULT_PARAMS})
    else:
        params = _parse_params(None)
    rounds, all_items, _ = _prepare_history(history, params["diversity_threshold"],
                                            params["consensus_promotion_delta"])
    schema_status = _score_schema_status(rounds)
    summary = _campaign_summary(rounds, all_items, params)
    stop = _stop_reasons(rounds, all_items, summary, params, schema_status)
    if not rounds[-1]["items"]:
        recommendation = "补数据"
    elif stop:
        recommendation = "停止"
    else:
        if planned_round.get("round") == rounds[-1]["round_id"] + 1 and planned_round.get("stop_recommended"):
            recommendation = "停止"
        else:
            latest_eligible = sum(
                1 for item in rounds[-1]["items"]
                if item.get("qc_status", "WARN") != "FAIL"
                and item["consensus_percentile"] is not None
                and item["consensus_percentile"] >= params["min_consensus_pctl"]
            )
            recommendation = "补数据" if latest_eligible < params["min_parents"] else "继续"
    return {"ok": True, "status": {
        "campaign_dir": campaign_dir,
        "policy_version": LOOP_POLICY_VERSION,
        "score_schema_status": schema_status,
        **summary,
        "latest_plan_path": latest_plan,
        "recommendation": recommendation,
    }}


def run_loop(args):
    """Dispatch loop ``log``, ``next`` and ``status`` actions."""
    if not _is_mapping(args):
        return {"ok": False, "error": "loop args must be an object"}
    action = args.get("action")
    handlers = {"log": _log, "next": _next, "status": _status}
    if action not in handlers:
        return {"ok": False, "error": "invalid action: expected log, next, or status"}
    try:
        return handlers[action](args)
    except LoopInputError as exc:
        return {"ok": False, "error": str(exc)}
    except OSError as exc:
        return {"ok": False, "error": f"loop filesystem error: {exc}"}
    except ValueError as exc:
        return {"ok": False, "error": f"invalid campaign data: {exc}"}


__all__ = ["LoopInputError", "run_loop"]
