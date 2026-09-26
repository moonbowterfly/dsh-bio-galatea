"""Deterministic, file-backed iteration planning for protein design campaigns.

The loop op is a decision and bookkeeping layer. It never launches sequence
generation or a remote prediction service. Scores use ``rank_tools``' existing
equal-weight, skip-missing consensus; sequence clusters use
``seq_analysis.cluster_sequences``.

Planning policy (v2):
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
* promotion compares child and parent within-round percentiles. Stopping uses
  the last two promotion rates, the last two best-percentile improvements,
  cumulative high-confidence eligible candidates, and max_rounds.

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
    "promotion_delta": 0.05,
    "max_rounds": 6,
    "improvement_epsilon": 0.02,
    "diversity_threshold": 0.8,
}


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

    # Reuse rank_tools' score parsing, skip-missing behavior, and arithmetic mean.
    try:
        from rank_tools import rank_consensus
        ranked = rank_consensus({"candidates": normalized})["ranking"]
    except (ImportError, ValueError, OSError) as exc:
        raise LoopInputError(f"invalid candidate scores: {exc}")
    ranking_by_id = {row["candidate_id"]: row for row in ranked}
    for item in normalized:
        result = ranking_by_id[item["candidate_id"]]
        item["predictor_scores"] = result["predictor_scores"]
        item["consensus"] = result["consensus"]
        item["n_scores"] = result["n_scores"]
    return normalized


def _recompute_operator_stats(campaign_dir):
    stats = defaultdict(int)
    plans_dir = _paths(campaign_dir)["plans"]
    if os.path.isdir(plans_dir):
        for name in sorted(os.listdir(plans_dir)):
            if not name.endswith("_plan.json"):
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
    }
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
    unknown = sorted(set(raw) - set(DEFAULT_PARAMS))
    if unknown:
        raise LoopInputError(f"unknown params: {', '.join(unknown)}")
    params = dict(DEFAULT_PARAMS)
    params.update(raw)
    for name in ("cloud_budget_round", "max_parents", "min_parents", "per_parent_local", "cloud_per_parent", "max_rounds"):
        minimum = 1 if name in ("max_parents", "min_parents", "per_parent_local", "cloud_per_parent", "max_rounds") else 0
        params[name] = _nonnegative_int(params[name], f"params.{name}", minimum=minimum)
    if params["min_parents"] > params["max_parents"]:
        raise LoopInputError("params.min_parents cannot exceed params.max_parents")
    for name in ("min_consensus_pctl", "diversity_threshold"):
        params[name] = _finite_number(params[name], f"params.{name}", minimum=0.0, maximum=1.0)
    if params["diversity_threshold"] == 0:
        raise LoopInputError("params.diversity_threshold must be > 0")
    for name in ("promotion_delta", "improvement_epsilon"):
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
            pair[1]["round_id"], -pair[1]["consensus_percentile"], pair[1]["candidate_id"]
        ))
    else:
        ordered = sorted(sequenced, key=lambda pair: (-pair[1]["consensus_percentile"], pair[1]["candidate_id"]))
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


def _prepare_history(history, diversity_threshold, promotion_delta):
    from rank_tools import rank_consensus

    rounds = []
    all_items = []
    by_round_id = {}
    for record in history:
        round_id = record["round_id"]
        source = record["candidates"]
        ranked = rank_consensus({"candidates": source})["ranking"]
        ranking_by_id = {row["candidate_id"]: row for row in ranked}
        items = []
        for source_item in source:
            row = ranking_by_id[source_item["candidate_id"]]
            item = dict(source_item)
            item["consensus"] = row["consensus"]
            item["predictor_scores"] = row["predictor_scores"]
            item["n_scores"] = row["n_scores"]
            item["uncertainty"] = pstdev(row["predictor_scores"].values()) if len(row["predictor_scores"]) >= 2 else 0.0
            item["round_id"] = round_id
            item["_key"] = (round_id, item["candidate_id"])
            items.append(item)
        percentiles = _percentiles(items)
        for item in items:
            item["consensus_percentile"] = percentiles[item["candidate_id"]]
        rounds.append({"round_id": round_id, "items": items})
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
        prior_rounds = [rid for rid in by_round_id if rid < item["round_id"]]
        for round_id in sorted(prior_rounds, reverse=True):
            found = by_round_id[round_id].get(parent_id)
            if found is not None:
                return found
        return None

    lookup = {item["_key"]: item for item in all_items}

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

    for item in all_items:
        item["lineage_id"] = lineage(item)
        item["parent_candidate"] = find_parent(item)
        item["promoted"] = bool(
            item["parent_candidate"] is not None
            and (
                item["consensus_percentile"] >= item["parent_candidate"]["consensus_percentile"] + promotion_delta
                or (item["consensus_percentile"] >= 0.90 and item["new_cluster"])
            )
        )

    for round_item in rounds:
        items = round_item["items"]
        ordered = sorted(items, key=lambda item: (-item["consensus"], item["candidate_id"]))
        round_item["best_consensus"] = ordered[0]["consensus"]
        round_item["median_consensus"] = median(item["consensus"] for item in items)
        round_item["best_percentile"] = max(item["consensus_percentile"] for item in items)
        round_item["best_candidate_id"] = ordered[0]["candidate_id"]
        round_item["promoted_count"] = sum(1 for item in items if item["promoted"])
        round_item["promoted_rate"] = round_item["promoted_count"] / len(items) if items else 0.0
    return rounds, all_items, find_parent


def _stop_lineages(rounds, all_items):
    lineage_ids = sorted({item["lineage_id"] for item in all_items})
    stopped = []
    for lineage_id in lineage_ids:
        first_index = next(i for i, row in enumerate(rounds) if any(x["lineage_id"] == lineage_id for x in row["items"]))
        best = None
        trail = []
        for row in rounds[first_index:]:
            members = [item for item in row["items"] if item["lineage_id"] == lineage_id]
            new_cluster = any(item["new_cluster"] for item in members)
            if members:
                current = max(item["consensus_percentile"] for item in members)
                delta = None if best is None else current - best
                best = current if best is None else max(best, current)
            else:
                current = best
                delta = 0.0 if best is not None else None
            trail.append({"delta": delta, "new_cluster": new_cluster})
        if len(trail) >= 3:
            recent = trail[-2:]
            if all(point["delta"] is not None and point["delta"] < 0.05 and not point["new_cluster"] for point in recent):
                stopped.append(lineage_id)
    return stopped


def _campaign_summary(rounds, all_items, params):
    lineage_count = len({item["lineage_id"] for item in all_items})
    high_confidence = sum(
        1 for item in all_items
        if item.get("qc_status", "WARN") != "FAIL"
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
             "promoted": row["promoted_count"], "n_candidates": len(row["items"])}
            for row in rounds
        ],
    }


def _stop_reasons(rounds, all_items, summary, params):
    reasons = []
    rates = [row["promoted_rate"] for row in rounds]
    if len(rates) >= 2 and all(rate < 0.05 for rate in rates[-2:]):
        reasons.append("promoted_rate_below_5pct_for_2_rounds")
    bests = [row["best_percentile"] for row in rounds]
    improvements = [bests[i] - bests[i - 1] for i in range(1, len(bests))]
    if len(improvements) >= 2 and all(delta < params["improvement_epsilon"] for delta in improvements[-2:]):
        reasons.append("best_percentile_improvement_below_epsilon_for_2_rounds")
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
    flags = item.get("flags", {})
    return item.get("contact_consensus") is not None or (
        _is_mapping(flags) and flags.get("contact_consensus") is not None
    )


def _select_parents(latest_items, params, stop_lineages):
    all_round_clusters, _ = _cluster_assignments(latest_items, params["diversity_threshold"])
    working = []
    fail_count = 0
    below_floor_count = 0
    for source in latest_items:
        item = dict(source)
        item["round_cluster"] = all_round_clusters.get(item["_key"])
        if item.get("qc_status", "WARN") == "FAIL":
            fail_count += 1
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
    has_contact = any(_find_contact_consensus(item) for item in latest_items)
    for item, role, reason_codes in selected:
        notes = []
        if not item.get("structure_path"):
            notes.append("no structure_path: execution should degrade interface-residue freezing; freeze binder residues within 4 A of any target heavy atom when structure input becomes available")
        else:
            notes.append("structure_path is recorded; loop does not inspect it, so confirm binder-target contact residues during execution")
        if not has_contact:
            notes.append("no contact-consensus input: anchor selection cannot enforce contact frequency >= 0.7 and must be marked as degraded")
        parents.append({
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
        })

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
    rounds, all_items, _ = _prepare_history(history, params["diversity_threshold"], params["promotion_delta"])
    summary = _campaign_summary(rounds, all_items, params)
    stop_lineages = _stop_lineages(rounds, all_items)
    stop_reasons = _stop_reasons(rounds, all_items, summary, params)
    latest = rounds[-1]
    selection = _select_parents(latest["items"], params, set(stop_lineages))
    local_sequences = sum(parent["n_local"] for parent in selection["parents"])
    cloud_predictions = sum(parent["n_cloud"] for parent in selection["parents"])
    round_plan = {
        "round": latest["round_id"] + 1,
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
    plan_path = os.path.join(_paths(campaign_dir)["plans"], f"round_{latest['round_id'] + 1}_plan.json")
    output = {"ok": True, "round_plan": round_plan, "campaign_summary": summary, "plan_path": plan_path}
    _atomic_json(plan_path, output)
    campaign["operator_stats"] = _recompute_operator_stats(campaign_dir)
    _atomic_json(_paths(campaign_dir)["campaign"], campaign)
    return output


def _latest_plan(campaign_dir):
    plans_dir = _paths(campaign_dir)["plans"]
    if not os.path.isdir(plans_dir):
        return None
    matches = []
    for name in os.listdir(plans_dir):
        match = re.fullmatch(r"round_(\d+)_plan\.json", name)
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
    params = _parse_params(None)
    rounds, all_items, _ = _prepare_history(history, params["diversity_threshold"], params["promotion_delta"])
    summary = _campaign_summary(rounds, all_items, params)
    latest_plan = _latest_plan(campaign_dir)
    stop = _stop_reasons(rounds, all_items, summary, params)
    if not rounds[-1]["items"]:
        recommendation = "补数据"
    elif stop:
        recommendation = "停止"
    else:
        last_plan = _read_json(latest_plan, "latest plan") if latest_plan else None
        planned_round = (last_plan or {}).get("round_plan", {}).get("round") if _is_mapping(last_plan) else None
        if planned_round == rounds[-1]["round_id"] + 1 and (last_plan.get("round_plan") or {}).get("stop_recommended"):
            recommendation = "停止"
        else:
            latest_eligible = sum(
                1 for item in rounds[-1]["items"]
                if item.get("qc_status", "WARN") != "FAIL"
                and item["consensus_percentile"] >= params["min_consensus_pctl"]
            )
            recommendation = "补数据" if latest_eligible < params["min_parents"] else "继续"
    return {"ok": True, "status": {
        "campaign_dir": campaign_dir,
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
