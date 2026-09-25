"""Deterministic candidate ranking helpers for dsh-bio-galatea.

The rank v1 contract deliberately has no learned fusion: a candidate's
``consensus`` is the ordinary, equal-weight arithmetic mean of its usable
predictor scores.  This module uses only the Python standard library so that
ranking remains available even when the optional structure/design runtimes are
not installed.
"""

import csv
import json
import math
import os
import tempfile
from collections.abc import Mapping, Sequence
from statistics import mean, median


DEFAULT_SCORE_PREFIX = "ipsae_min_"
SCORE_MAP_FIELDS = ("scores", "predictor_scores", "predictors", "predictions")
ID_FIELDS = ("candidate_id", "id", "uuid", "name", "sequence_id")
TIERS = ("strong", "medium", "weak", "reject")
COMPUTED_FIELDS = {
    "rank",
    "candidate_id",
    "consensus",
    "n_scores",
    "min_score",
    "max_score",
    "tier",
    "predictor_scores",
    "batch_id",
}


class RankInputError(ValueError):
    """A normal, user-correctable rank input error.

    ``galatea_ops.py`` catches this class and returns the bridge's structured
    ``ok:false`` response instead of treating an ordinary bad table as a code
    failure.
    """


def tier_for(consensus):
    """Return the task-book tier for one consensus score."""
    if consensus >= 0.73:
        return "strong"
    if consensus >= 0.65:
        return "medium"
    if consensus >= 0.2:
        return "weak"
    return "reject"


def _is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _parse_score(value, context):
    """Parse a usable score, returning ``None`` for a missing predictor.

    The benchmark's dataframe mean skips missing values.  Blank/null cells and
    NaN therefore mean "this predictor is unavailable for this candidate";
    infinities and other non-numeric values are input errors.
    """
    if _is_blank(value):
        return None
    if isinstance(value, bool):
        raise RankInputError(f"{context} must be a numeric score, not a boolean")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise RankInputError(f"{context} must be a finite numeric score")
    if math.isnan(parsed):
        return None
    if not math.isfinite(parsed):
        raise RankInputError(f"{context} must be a finite numeric score")
    return 0.0 if parsed == 0.0 else parsed


def _as_score_map(value, context):
    """Accept a JSON object or a CSV cell containing one JSON object."""
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return {}
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            raise RankInputError(f"{context} must be a JSON object of predictor scores")
    if not isinstance(value, Mapping):
        raise RankInputError(f"{context} must be an object of predictor scores")
    return value


def _add_score(scores, predictor, value, context):
    name = str(predictor).strip()
    if not name:
        raise RankInputError(f"{context} has an empty predictor name")
    parsed = _parse_score(value, f"{context}.{name}")
    if parsed is None:
        return
    if name in scores:
        if scores[name] != parsed:
            raise RankInputError(
                f"{context} provides conflicting values for predictor {name!r}"
            )
        return
    scores[name] = parsed


def _score_map_fields(args):
    fields = list(SCORE_MAP_FIELDS)
    extra = args.get("score_field")
    if extra is None:
        return fields
    if not isinstance(extra, str) or not extra.strip():
        raise RankInputError("score_field must be a non-empty string when provided")
    extra = extra.strip()
    if extra not in fields:
        fields.insert(0, extra)
    return fields


def _extract_scores(row, score_prefix, map_fields, context):
    scores = {}
    for key, value in row.items():
        if str(key).startswith(score_prefix):
            _add_score(scores, key, value, context)
    for field in map_fields:
        if field not in row or _is_blank(row[field]):
            continue
        for predictor, value in _as_score_map(row[field], f"{context}.{field}").items():
            _add_score(scores, predictor, value, context)
    return dict(sorted(scores.items()))


def _score_prefix(args):
    prefix = args.get("score_prefix", DEFAULT_SCORE_PREFIX)
    if not isinstance(prefix, str) or not prefix:
        raise RankInputError("score_prefix must be a non-empty string")
    return prefix


def _candidate_id(row, index, id_column):
    if id_column is not None:
        if id_column not in row or _is_blank(row[id_column]):
            raise RankInputError(f"candidate row {index + 1} is missing id_column {id_column!r}")
        return str(row[id_column])
    for field in ID_FIELDS:
        if field in row and not _is_blank(row[field]):
            return str(row[field])
    return f"candidate_{index + 1:06d}"


def _parse_existing_consensus(row, context):
    """Read a prior consensus result when aggregate receives a ranked CSV."""
    consensus = _parse_score(row.get("consensus"), f"{context}.consensus")
    if consensus is None:
        return None

    raw_n = row.get("n_scores", 1)
    try:
        n_scores = int(float(raw_n))
    except (TypeError, ValueError):
        raise RankInputError(f"{context}.n_scores must be a positive integer")
    if n_scores < 1 or float(raw_n) != n_scores:
        raise RankInputError(f"{context}.n_scores must be a positive integer")

    min_score = _parse_score(row.get("min_score", consensus), f"{context}.min_score")
    max_score = _parse_score(row.get("max_score", consensus), f"{context}.max_score")
    if min_score is None or max_score is None:
        raise RankInputError(f"{context} has incomplete prior consensus statistics")
    if min_score > max_score:
        raise RankInputError(f"{context}.min_score cannot exceed max_score")
    return consensus, n_scores, min_score, max_score


def _metadata(row, score_prefix, map_fields):
    out = {}
    for key, value in row.items():
        name = str(key)
        if name.startswith(score_prefix) or name in map_fields or name in COMPUTED_FIELDS:
            continue
        out[name] = value
    return out


def _rank_rows(candidates, args, allow_existing_consensus=False):
    """Normalize rows and apply one stable, global descending ranking."""
    score_prefix = _score_prefix(args)
    map_fields = _score_map_fields(args)
    id_column = args.get("id_column")
    if id_column is not None and (not isinstance(id_column, str) or not id_column):
        raise RankInputError("id_column must be a non-empty string when provided")

    staged = []
    predictor_coverage = {}
    for index, raw in enumerate(candidates):
        if not isinstance(raw, Mapping):
            raise RankInputError(f"candidate row {index + 1} must be an object")
        row = {str(key): value for key, value in raw.items()}
        candidate_id = _candidate_id(row, index, id_column)
        context = f"candidate {candidate_id!r}"
        scores = _extract_scores(row, score_prefix, map_fields, context)

        if scores:
            consensus = mean(scores.values())
            n_scores = len(scores)
            min_score = min(scores.values())
            max_score = max(scores.values())
            for predictor in scores:
                predictor_coverage[predictor] = predictor_coverage.get(predictor, 0) + 1
        elif allow_existing_consensus:
            prior = _parse_existing_consensus(row, context)
            if prior is None:
                raise RankInputError(f"{context} has no usable predictor scores")
            consensus, n_scores, min_score, max_score = prior
        else:
            raise RankInputError(f"{context} has no usable predictor scores")

        normalized = _metadata(row, score_prefix, map_fields)
        normalized.update({
            "candidate_id": candidate_id,
            "consensus": consensus,
            "n_scores": n_scores,
            "min_score": min_score,
            "max_score": max_score,
            "tier": tier_for(consensus),
            "predictor_scores": scores,
        })
        staged.append((consensus, index, normalized))

    if not staged:
        raise RankInputError("candidate table is empty")

    # Python's sort is stable; the input ordinal makes that stability explicit
    # even when rows arrived through a mapping or through multiple batches.
    staged.sort(key=lambda item: (-item[0], item[1]))
    ranking = []
    for rank, (_, _, row) in enumerate(staged, start=1):
        row["rank"] = rank
        ranking.append(row)
    return ranking, predictor_coverage


def _summary(ranking, predictor_coverage):
    values = [row["consensus"] for row in ranking]
    tiers = {tier: 0 for tier in TIERS}
    for row in ranking:
        tiers[row["tier"]] += 1
    return {
        "n_candidates": len(ranking),
        "total_scores": sum(row["n_scores"] for row in ranking),
        "predictors": sorted(predictor_coverage),
        "predictor_coverage": dict(sorted(predictor_coverage.items())),
        "consensus_min": min(values),
        "consensus_max": max(values),
        "consensus_mean": mean(values),
        "consensus_median": median(values),
        "tier_counts": tiers,
    }


def _parse_json_candidates(value, label):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise RankInputError(f"{label} must be JSON candidates, not a plain string")

    if isinstance(value, Mapping):
        # A single normal candidate object is convenient for one-row callers.
        keys = {str(key) for key in value}
        if (keys & set(ID_FIELDS)) or (keys & set(SCORE_MAP_FIELDS)) or any(
            key.startswith(DEFAULT_SCORE_PREFIX) for key in keys
        ):
            return [dict(value)]

        # Also accept {candidate_id: {predictor: score, ...}} as a compact JSON
        # table.  A nested mapping without an explicit score container is treated
        # as that candidate's score map.
        rows = []
        for candidate_id, score_or_row in value.items():
            if not isinstance(score_or_row, Mapping):
                raise RankInputError(f"{label}[{candidate_id!r}] must be an object")
            item = {str(key): val for key, val in score_or_row.items()}
            if not any(str(key).startswith(DEFAULT_SCORE_PREFIX) for key in item) and not any(
                field in item for field in SCORE_MAP_FIELDS
            ):
                item = {"scores": item}
            item.setdefault("candidate_id", str(candidate_id))
            rows.append(item)
        return rows

    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise RankInputError(f"{label} must be an array of candidate objects")
    return list(value)


def _read_csv(path, label="csv_path"):
    if not isinstance(path, str) or not path.strip():
        raise RankInputError(f"{label} must be a non-empty file path")
    resolved = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(resolved):
        raise RankInputError(f"CSV file not found: {resolved}")
    try:
        with open(resolved, "r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames:
                raise RankInputError(f"CSV file has no header: {resolved}")
            rows = list(reader)
    except OSError as exc:
        raise RankInputError(f"could not read CSV file {resolved}: {exc}")
    if not rows:
        raise RankInputError(f"CSV file has no candidate rows: {resolved}")
    return rows, resolved


def _find_input(args):
    inline = []
    for key in ("candidates", "rows", "input_json"):
        if key in args and args[key] is not None:
            inline.append((key, args[key]))

    paths = []
    for key in ("csv_path", "csv", "input_csv"):
        if key in args and args[key] is not None:
            paths.append((key, args[key]))

    if "input" in args and args["input"] is not None:
        if isinstance(args["input"], str):
            paths.append(("input", args["input"]))
        else:
            inline.append(("input", args["input"]))

    if len(inline) + len(paths) != 1:
        raise RankInputError("provide exactly one candidate source: candidates JSON or csv_path")
    if inline:
        label, value = inline[0]
        return _parse_json_candidates(value, label), {"kind": "json"}
    label, path = paths[0]
    rows, resolved = _read_csv(path, label)
    return rows, {"kind": "csv", "csv_path": resolved}


def rank_consensus(args):
    """Rank one candidate table using the fixed equal-weight consensus rule.

    Args accepts exactly one source: ``candidates`` (JSON array/object) or
    ``csv_path`` (UTF-8 CSV with headers).  Flat columns matching
    ``score_prefix`` and nested score maps such as ``scores`` are both accepted.
    """
    if not isinstance(args, Mapping):
        raise RankInputError("rank.consensus args must be an object")
    candidates, input_info = _find_input(args)
    ranking, coverage = _rank_rows(candidates, args)
    return {
        "algorithm": "equal_weight_mean",
        "score_prefix": _score_prefix(args),
        "input": input_info,
        "ranking": ranking,
        "summary": _summary(ranking, coverage),
    }


def _batch_source(batch, index):
    default_id = f"batch_{index + 1:03d}"
    if isinstance(batch, str):
        rows, resolved = _read_csv(batch, f"batches[{index}]")
        return default_id, rows, {"kind": "csv", "csv_path": resolved}
    if isinstance(batch, Sequence) and not isinstance(batch, (str, bytes, bytearray)):
        return default_id, list(batch), {"kind": "json"}
    if not isinstance(batch, Mapping):
        raise RankInputError(f"batches[{index}] must be an object, candidate list, or CSV path")

    batch_id = batch.get("batch_id", batch.get("batch", batch.get("name", default_id)))
    if _is_blank(batch_id):
        raise RankInputError(f"batches[{index}].batch_id must not be blank")
    batch_id = str(batch_id)

    source = batch.get("result") if isinstance(batch.get("result"), Mapping) else batch
    if "ranking" in source and source["ranking"] is not None:
        return batch_id, _parse_json_candidates(source["ranking"], f"batches[{index}].ranking"), {"kind": "ranking"}

    candidate_keys = [(key, source[key]) for key in ("candidates", "rows", "input_json")
                      if key in source and source[key] is not None]
    path_keys = [(key, source[key]) for key in ("csv_path", "csv", "input_csv")
                 if key in source and source[key] is not None]
    if len(candidate_keys) + len(path_keys) != 1:
        raise RankInputError(
            f"batches[{index}] must provide exactly one of candidates/ranking or csv_path"
        )
    if candidate_keys:
        key, value = candidate_keys[0]
        return batch_id, _parse_json_candidates(value, f"batches[{index}].{key}"), {"kind": "json"}
    key, value = path_keys[0]
    rows, resolved = _read_csv(value, f"batches[{index}].{key}")
    return batch_id, rows, {"kind": "csv", "csv_path": resolved}


def _csv_value(value):
    if value is None:
        return ""
    if isinstance(value, (Mapping, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return value


def _write_ranking_csv(ranking, output_csv, overwrite):
    if not isinstance(output_csv, str) or not output_csv.strip():
        raise RankInputError("output_csv must be a non-empty file path")
    resolved = os.path.abspath(os.path.expanduser(output_csv))
    if os.path.isdir(resolved):
        raise RankInputError(f"output_csv is a directory: {resolved}")
    if os.path.exists(resolved) and not overwrite:
        raise RankInputError(
            f"output_csv already exists: {resolved} (set overwrite=true to replace it)"
        )

    parent = os.path.dirname(resolved)
    try:
        os.makedirs(parent, exist_ok=True)
    except OSError as exc:
        raise RankInputError(f"could not create output directory {parent}: {exc}")

    fixed_columns = [
        "rank", "candidate_id", "batch_id", "consensus", "n_scores",
        "min_score", "max_score", "tier", "predictor_scores",
    ]
    extra_columns = sorted({
        str(key) for row in ranking for key in row
        if str(key) not in fixed_columns
    })
    fieldnames = fixed_columns + extra_columns

    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="", delete=False,
            dir=parent, prefix=".galatea-rank-", suffix=".tmp",
        ) as handle:
            temp_path = handle.name
            writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
            writer.writeheader()
            for row in ranking:
                writer.writerow({key: _csv_value(row.get(key)) for key in fieldnames})
        os.replace(temp_path, resolved)
        temp_path = None
    except OSError as exc:
        raise RankInputError(f"could not write output_csv {resolved}: {exc}")
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.unlink(temp_path)
            except OSError:
                pass
    return resolved


def rank_aggregate(args):
    """Combine separately produced batches, re-rank globally, and write CSV.

    Each batch is a ``{batch_id, candidates}`` object, a ``{batch_id,
    csv_path}`` object, a previous consensus result containing ``ranking``, a
    raw candidate list, or a CSV path.  Batch-local ranks are deliberately not
    used: each candidate is ranked once across the complete merged table.
    """
    if not isinstance(args, Mapping):
        raise RankInputError("rank.aggregate args must be an object")
    batches = args.get("batches")
    if isinstance(batches, str):
        try:
            batches = json.loads(batches)
        except json.JSONDecodeError:
            raise RankInputError("batches must be an array, not a plain string")
    if not isinstance(batches, Sequence) or isinstance(batches, (str, bytes, bytearray)) or not batches:
        raise RankInputError("batches must be a non-empty array")

    output_csv = args.get("output_csv", args.get("out_csv"))
    overwrite = args.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise RankInputError("overwrite must be a boolean when provided")

    merged = []
    coverage = {}
    batch_info = []
    for index, batch in enumerate(batches):
        batch_id, candidates, source_info = _batch_source(batch, index)
        batch_rows, batch_coverage = _rank_rows(candidates, args, allow_existing_consensus=True)
        for row in batch_rows:
            row["batch_id"] = batch_id
            merged.append(row)
        for predictor, count in batch_coverage.items():
            coverage[predictor] = coverage.get(predictor, 0) + count
        batch_info.append({"batch_id": batch_id, **source_info, "n_candidates": len(batch_rows)})

    # Do not average batch means or reuse a batch-local rank.  Reuse the same
    # stable global ordering rule on the fully concatenated candidate table.
    merged.sort(key=lambda row: (-row["consensus"], row["batch_id"], row["candidate_id"]))
    for rank, row in enumerate(merged, start=1):
        row["rank"] = rank

    resolved_output = _write_ranking_csv(merged, output_csv, overwrite)
    duplicate_ids = sorted({
        row["candidate_id"] for row in merged
        if sum(other["candidate_id"] == row["candidate_id"] for other in merged) > 1
    })
    return {
        "algorithm": "equal_weight_mean",
        "score_prefix": _score_prefix(args),
        "n_batches": len(batch_info),
        "batches": batch_info,
        "output_csv": resolved_output,
        "ranking": merged,
        "summary": {
            **_summary(merged, coverage),
            "duplicate_candidate_ids": duplicate_ids,
        },
    }


__all__ = ["RankInputError", "rank_consensus", "rank_aggregate", "tier_for"]
