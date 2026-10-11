"""Declared score contracts for rank and loop; no backend authenticity claim."""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal, ROUND_HALF_EVEN

SCORE_CONTRACT_VERSION = "galatea.score_contract.v2"
AGGREGATION_POLICY = "equal_weight_mean.same_scale.higher.v2"
PREDICTOR_META_KEYS = ("model_family", "model_version", "score_metric",
                       "score_version", "direction", "unit")


class ScoreContractError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


def digest(value):
    return "sha256:" + hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _normalize_metadata(meta, predictors):
    if not isinstance(meta, dict):
        raise ScoreContractError("SCHEMA_META_NOT_OBJECT", "predictor_metadata must be an object")
    if any(not isinstance(key, str) or not key.strip() for key in meta):
        raise ScoreContractError("SCHEMA_META_MISMATCH", "predictor metadata keys must be nonempty strings")
    if not predictors or len(predictors) != len(set(predictors)):
        raise ScoreContractError("SCHEMA_META_MISMATCH", "actual predictor keys must be unique and nonempty")
    if set(meta) != set(predictors):
        raise ScoreContractError("SCHEMA_META_MISMATCH",
                                 f"predictor_metadata keys differ from actual keys: expected={sorted(predictors)} provided={sorted(meta)}")
    normalized = {}
    for key in sorted(predictors):
        item = meta[key]
        if not isinstance(item, dict):
            raise ScoreContractError("SCHEMA_META_NOT_OBJECT", f"metadata for {key} must be an object")
        clean = {}
        for field in PREDICTOR_META_KEYS:
            value = item.get(field)
            if not isinstance(value, str) or not value.strip():
                raise ScoreContractError("SCHEMA_META_INCOMPLETE", f"metadata {key}.{field} must be a nonempty string")
            clean[field] = value.strip()
        if clean["direction"] not in ("higher", "lower"):
            raise ScoreContractError("SCHEMA_META_BAD_DIRECTION", f"metadata {key}.direction must be higher or lower")
        if "seed" in item:
            seed = item["seed"]
            if isinstance(seed, bool) or not isinstance(seed, (str, int)) or not str(seed).strip():
                raise ScoreContractError("SCHEMA_META_INCOMPLETE", f"metadata {key}.seed must be a nonempty string or integer")
            clean["seed"] = str(seed).strip()
        if "same_scale" in item:
            if item["same_scale"] is not True:
                raise ScoreContractError("SCHEMA_SCALE_UNDECLARED", f"metadata {key}.same_scale must be true")
            clean["same_scale"] = True
        if len(predictors) > 1 and clean.get("same_scale") is not True:
            raise ScoreContractError("SCHEMA_SCALE_UNDECLARED", "multiple predictors require explicit same_scale=true for each")
        extra = set(item) - set(PREDICTOR_META_KEYS) - {"seed", "same_scale"}
        if extra:
            raise ScoreContractError("SCHEMA_META_UNKNOWN_FIELD", f"metadata {key} has unknown fields {sorted(extra)}")
        normalized[key] = clean
    return normalized


def validate_predictor_metadata(meta, predictors):
    """Return fingerprint, comparability, report; reject unsafe typed averaging."""
    if meta is None:
        return None, "unknown", {
            "contract": SCORE_CONTRACT_VERSION, "comparability": "unknown", "fingerprint": None,
            "metadata_source": "none_legacy", "warning": "legacy scores are not calibrated for cross-round comparison"}
    normalized = _normalize_metadata(meta, list(predictors))
    dimensions = ("model_family", "model_version", "score_metric", "score_version", "direction", "unit")
    if any(len({item[field] for item in normalized.values()}) != 1 for field in dimensions):
        raise ScoreContractError("SCHEMA_INCOMPARABLE", "predictor family/version/metric/score_version/direction/unit differ")
    first = next(iter(normalized.values()))
    if first["direction"] != "higher":
        raise ScoreContractError("SCHEMA_UNSUPPORTED_DIRECTION", "equal-weight mean requires higher direction")
    payload = {"contract": SCORE_CONTRACT_VERSION, "aggregation": AGGREGATION_POLICY,
               "predictors": sorted(predictors), "metadata": normalized}
    fingerprint = digest(payload)
    return fingerprint, "comparable", {
        "contract": SCORE_CONTRACT_VERSION, "comparability": "comparable", "fingerprint": fingerprint,
        "aggregation": AGGREGATION_POLICY, "predictors": sorted(predictors),
        "predictor_metadata": normalized, "metadata_source": "caller_declaration_unverified_backend",
        "backend_authenticity": "not_verified", "n_predictors": len(predictors),
        "family": first["model_family"], "model_version": first["model_version"],
        "metric": first["score_metric"], "score_version": first["score_version"],
        "direction": first["direction"], "unit": first["unit"],
    }


def verify_report(report, actual_predictors):
    if not isinstance(report, dict):
        raise ScoreContractError("SCHEMA_SOURCE_MISSING", "source score contract is missing")
    if report.get("comparability") == "unknown" and report.get("fingerprint") is None:
        if report.get("predictor_metadata") is not None:
            raise ScoreContractError("SCHEMA_SOURCE_TAMPERED", "legacy source carries typed metadata")
        return validate_predictor_metadata(None, actual_predictors)[2]
    if report.get("contract") != SCORE_CONTRACT_VERSION:
        raise ScoreContractError("SCHEMA_SOURCE_TAMPERED", "source contract version differs")
    _, _, expected = validate_predictor_metadata(report.get("predictor_metadata"), actual_predictors)
    for field in ("fingerprint", "comparability", "aggregation", "predictors", "family",
                  "model_version", "metric", "score_version", "direction", "unit"):
        if report.get(field) != expected[field]:
            raise ScoreContractError("SCHEMA_SOURCE_TAMPERED", f"source contract {field} differs from actual scores")
    return expected


COMPARISON_QUANTUM = Decimal("0.000000001")


def comparison_delta(new_score, old_score):
    """Freeze the cross-round numeric policy at nine decimal places, half-even."""
    new = Decimal(str(new_score)).quantize(COMPARISON_QUANTUM, rounding=ROUND_HALF_EVEN)
    old = Decimal(str(old_score)).quantize(COMPARISON_QUANTUM, rounding=ROUND_HALF_EVEN)
    return new - old


def comparison_threshold(value):
    return Decimal(str(value)).quantize(COMPARISON_QUANTUM, rounding=ROUND_HALF_EVEN)
