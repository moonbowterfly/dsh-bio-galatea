"""R2 GL-2 production JSON bridge tests for log, status and next."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile

BRIDGE = pathlib.Path(__file__).resolve().parents[1] / "python" / "galatea_ops.py"
TEMP_ROOT = pathlib.Path(os.environ.get("GALATEA_TEST_TMP", tempfile.gettempdir()))
TEMP_ROOT.mkdir(parents=True, exist_ok=True)
META1 = {"p1": {"model_family": "proxy", "model_version": "1", "score_metric": "proxy",
                "score_version": "1", "direction": "higher", "unit": "score"}}


def bridge(args):
    run = subprocess.run([sys.executable, "-B", str(BRIDGE)],
                         input=json.dumps({"op": "loop", "args": args}), capture_output=True,
                         text=True, encoding="utf-8",
                         env=dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1"))
    assert run.returncode == 0, (run.returncode, run.stderr)
    result = json.loads(run.stdout)
    assert result["ok"] is True, result
    assert "result" in result, result
    return result["result"]


def candidate(name, score, parent=None, qc="PASS", scores=None):
    result = {"candidate_id": name, "parent_id": parent, "qc_status": qc,
              "sequence": "ACDEFGHIKLMNPQRSTVWY" * 2}
    result["scores"] = scores if scores is not None else {"p1": score}
    return result


def log(campaign, index, candidates, metadata=None):
    round_value = {"round_id": index, "candidates": candidates}
    if metadata is not None:
        round_value["predictor_metadata"] = metadata
    return bridge({"action": "log", "campaign_dir": str(campaign), "round": round_value})


def nxt(campaign, params=None):
    args = {"action": "next", "campaign_dir": str(campaign)}
    if params is not None:
        args["params"] = params
    return bridge(args)["round_plan"]


def status(campaign):
    return bridge({"action": "status", "campaign_dir": str(campaign)})["status"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def no_score_stops(plan):
    return not any("promoted_rate" in reason or "best_consensus" in reason
                   for reason in plan["stop_reason"])


def main():
    with tempfile.TemporaryDirectory(prefix="galatea-gl2-", dir=TEMP_ROOT) as folder:
        root = pathlib.Path(folder)
        legacy = root / "legacy"
        for i in range(3):
            log(legacy, i, [candidate(f"a{i}", 0.9, f"a{i-1}" if i else None)])
        p = nxt(legacy)
        assert p["score_schema_status"] == "UNVERIFIED_SCORE_SCHEMA"
        assert p["stop_lineages"] == [] and p["n_parents"] == 1 and no_score_stops(p)
        rates = status(legacy)["promoted_rate_per_round"]
        assert all(row["rate"] is None and row["denominator"] == 0 for row in rates)
        # Caller-edited campaign fingerprint alone never creates a typed source.
        cp = legacy / "campaign.json"
        before = json.loads(cp.read_text(encoding="utf-8"))
        before["score_schema"] = {"fingerprint": "sha256:fp"}
        cp.write_text(json.dumps(before), encoding="utf-8")
        assert nxt(legacy)["score_schema_status"] == "UNVERIFIED_SCORE_SCHEMA"

        diverse_legacy = root / "diverse_legacy"
        for i in range(3):
            row = candidate(f"a{i}", 0.95, f"a{i-1}" if i else None)
            row["sequence"] = ("A" * 40, "C" * 40, "D" * 40)[i]
            log(diverse_legacy, i, [row])
        assert no_score_stops(nxt(diverse_legacy))
        assert nxt(diverse_legacy)["stop_lineages"] == []
        assert all(entry["rate"] is None for entry in status(diverse_legacy)["promoted_rate_per_round"])

        rising = root / "rising"
        for i, score in enumerate((0.3, 0.6, 0.9)):
            log(rising, i, [candidate(f"a{i}", score, f"a{i-1}" if i else None)], META1)
        round_path = rising / "rounds" / "round_1.json"
        stored = json.loads(round_path.read_text(encoding="utf-8"))
        assert stored["predictor_metadata"] == META1
        assert stored["candidates"][0]["predictor_coverage"] == ["p1"]
        assert stored["candidates"][0]["score_fingerprint"].startswith("sha256:")
        old_round_hash = sha(round_path)
        old_plan = rising / "plans" / "round_3_plan.json"
        old_plan.parent.mkdir(exist_ok=True)
        old_plan.write_text("OLD_POLICY_DO_NOT_TOUCH", encoding="utf-8")
        old_plan_hash = sha(old_plan)
        p = nxt(rising)
        assert p["policy_version"] == "galatea.loop.v3" and p["score_schema_status"] == "comparable"
        assert p["stop_lineages"] == [] and no_score_stops(p)
        assert p["n_parents"] == 1 and old_plan_hash == sha(old_plan) and old_round_hash == sha(round_path)
        assert (rising / "plans" / "round_3_plan_v3.json").exists()
        assert status(rising)["score_schema_status"] == p["score_schema_status"]

        flat = root / "flat"
        for i in range(3):
            log(flat, i, [candidate(f"a{i}", 0.9, f"a{i-1}" if i else None)], META1)
        p = nxt(flat)
        assert "best_consensus_improvement_below_epsilon_for_2_rounds" in p["stop_reason"]
        assert "promoted_rate_below_threshold_for_2_rounds" in p["stop_reason"]
        assert p["stop_lineages"] and p["n_parents"] == 0

        boundary = root / "boundary"
        for i, score in enumerate((0.80, 0.82, 0.84)):
            log(boundary, i, [candidate(f"a{i}", score, f"a{i-1}" if i else None)], META1)
        p = nxt(boundary, {"consensus_promotion_delta": 0.02, "consensus_improvement_epsilon": 0.02})
        assert no_score_stops(p), p["stop_reason"]
        assert [r["rate"] for r in status(boundary)["promoted_rate_per_round"]] == [None, 1.0, 1.0]
        assert status(boundary)["recommendation"] != "停止"

        # One of twenty valid parent-child pairs promotes: exactly 5%, not below 5%.
        rate = root / "rate"
        for rd in range(3):
            rows = [candidate(f"x{rd}_{i}", 0.5 + (0.1 * rd if i == 0 else 0),
                              f"x{rd-1}_{i}" if rd else None) for i in range(20)]
            log(rate, rd, rows, META1)
        p = nxt(rate)
        assert "promoted_rate_below_threshold_for_2_rounds" not in p["stop_reason"]
        assert [r["rate"] for r in status(rate)["promoted_rate_per_round"]] == [None, 0.05, 0.05]

        meta2 = {k: dict(v, same_scale=True) for k, v in META1.items()}
        meta2["p2"] = dict(meta2["p1"])
        partial = root / "partial"
        log(partial, 0, [candidate("a0", 0.5, scores={"p1": 0.5, "p2": 0.5})], meta2)
        log(partial, 1, [candidate("a1", 0.7, "a0", scores={"p1": 0.7}),
                         candidate("b1", 0.4, scores={"p1": 0.4, "p2": 0.4})], meta2)
        p = nxt(partial)
        assert p["score_schema_status"] == "INCOMPARABLE_SCORE_SCHEMA"
        assert status(partial)["promoted_rate_per_round"][-1]["rate"] is None
        assert status(partial)["promoted_rate_per_round"][-1]["unknown_pairs"] == 1
        assert no_score_stops(p)

        changed = root / "changed"
        alt = {"p1": dict(META1["p1"], model_version="2")}
        for i in range(3):
            log(changed, i, [candidate(f"a{i}", 0.9, f"a{i-1}" if i else None)],
                META1 if i == 0 else alt)
        p = nxt(changed)
        assert p["score_schema_status"] == "INCOMPARABLE_SCORE_SCHEMA" and no_score_stops(p)
        assert p["stop_lineages"] == []

        for dimension in ("model_family", "score_metric"):
            campaign = root / ("changed_" + dimension)
            altered = {"p1": dict(META1["p1"], **{dimension: "other"})}
            log(campaign, 0, [candidate("a0", 0.9)], META1)
            log(campaign, 1, [candidate("a1", 0.9, "a0")], altered)
            log(campaign, 2, [candidate("a2", 0.9, "a1")], altered)
            assert nxt(campaign)["score_schema_status"] == "INCOMPARABLE_SCORE_SCHEMA"
            assert no_score_stops(nxt(campaign))

        gap = root / "gap"
        log(gap, 0, [candidate("a0", 0.9)], META1)
        log(gap, 2, [candidate("a2", 0.9, "a0")], META1)
        log(gap, 3, [candidate("a3", 0.9, "a2")], META1)
        assert no_score_stops(nxt(gap))
        assert nxt(gap)["stop_lineages"] == []

        fail = root / "fail"
        log(fail, 0, [candidate("a0", 0.3)], META1)
        log(fail, 1, [candidate("a1", 0.4, "a0"), candidate("bad", 0.99, qc="FAIL")], META1)
        log(fail, 2, [candidate("a2", 0.5, "a1", qc="FAIL")], META1)
        p = nxt(fail)
        assert p["score_schema_status"] == "comparable" and no_score_stops(p)
        assert status(fail)["promoted_rate_per_round"][-1]["rate"] is None
        assert p["n_parents"] == 0

        all_fail = root / "all_fail"
        for i in range(3):
            log(all_fail, i, [candidate(f"a{i}", 0.99, f"a{i-1}" if i else None, qc="FAIL")], META1)
        all_fail_plan = nxt(all_fail)
        assert no_score_stops(all_fail_plan) and all_fail_plan["n_parents"] == 0
        assert all(row["rate"] is None for row in status(all_fail)["promoted_rate_per_round"])

        missing_lineage = root / "missing_lineage"
        log(missing_lineage, 0, [candidate("a0", 0.9)], META1)
        log(missing_lineage, 1, [candidate("b1", 0.9)], META1)
        log(missing_lineage, 2, [candidate("a2", 0.9, "a0")], META1)
        assert nxt(missing_lineage)["stop_lineages"] == []
        assert all(row["rate"] is None for row in status(missing_lineage)["promoted_rate_per_round"])

        custom = root / "custom"
        for i, score in enumerate((0.3, 0.4, 0.5)):
            log(custom, i, [candidate(f"a{i}", score, f"a{i-1}" if i else None)], META1)
        p = nxt(custom, {"consensus_improvement_epsilon": 0.5})
        assert "best_consensus_improvement_below_epsilon_for_2_rounds" in p["stop_reason"]
        s = status(custom)
        assert s["recommendation"] == "停止" and s["policy_version"] == p["policy_version"]
        assert s["score_schema_status"] == p["score_schema_status"]
        maxround = root / "maxround"
        for i in range(6):
            log(maxround, i, [candidate(f"a{i}", 0.9)], None)
        assert "max_rounds_reached" in nxt(maxround)["stop_reason"]
    print("GL2_R2_PASS typed log, unified pair gate, boundaries, status/next and old-file preservation")


if __name__ == "__main__":
    main()
