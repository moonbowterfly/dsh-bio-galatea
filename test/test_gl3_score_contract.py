"""R2 GL-3 production JSON bridge, source contract and CSV round-trip tests."""
import copy
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


def call(op, args):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
    run = subprocess.run([sys.executable, "-B", str(BRIDGE)],
                         input=json.dumps({"op": op, "args": args}), text=True,
                         encoding="utf-8", capture_output=True, env=env)
    assert run.returncode == 0, (run.returncode, run.stderr)
    return json.loads(run.stdout)


def metadata(**change):
    value = {"model_family": "af2", "model_version": "1", "score_metric": "confidence",
             "score_version": "1", "direction": "higher", "unit": "score", "same_scale": True}
    value.update(change)
    return value


def rank_args(rows=None, meta=None):
    return {"candidates": rows or [
        {"candidate_id": "a", "scores": {"p1": 0.9, "p2": 0.8}},
        {"candidate_id": "b", "scores": {"p1": 0.7, "p2": 0.6}}],
        "predictor_metadata": meta if meta is not None else {"p1": metadata(), "p2": metadata()}}


def expect_error(response, code):
    assert response["ok"] is False, response
    assert response.get("code") == code, response
    assert "ranking" not in response and "result" not in response, response


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    good = call("rank.consensus", rank_args())
    assert good["ok"] is True
    result = good["result"]
    assert result["score_contract"]["comparability"] == "comparable"
    assert result["score_contract"]["fingerprint"].startswith("sha256:")
    assert [row["predictor_coverage"] for row in result["ranking"]] == [["p1", "p2"]] * 2
    assert result["ranking"][0]["candidate_id"] == "a"
    for field, changed in [
        ("model_family", "boltz"), ("model_version", "2"), ("score_metric", "other"),
        ("score_version", "2"), ("unit", "angstrom"), ("direction", "lower")]:
        pair = {"p1": metadata(), "p2": metadata(**{field: changed})}
        expect_error(call("rank.consensus", rank_args(meta=pair)), "SCHEMA_INCOMPARABLE")
    expect_error(call("rank.consensus", rank_args(meta={"p1": metadata(direction="lower"),
                                                         "p2": metadata(direction="lower")})),
                 "SCHEMA_UNSUPPORTED_DIRECTION")
    expect_error(call("rank.consensus", rank_args(meta={"p1": metadata(), "p2": metadata(model_family=["af2"])})),
                 "SCHEMA_META_INCOMPLETE")
    expect_error(call("rank.consensus", rank_args(meta={"p1": metadata(), "p2": metadata(model_family="  ")})),
                 "SCHEMA_META_INCOMPLETE")
    expect_error(call("rank.consensus", rank_args(meta={"p1": metadata()})), "SCHEMA_META_MISMATCH")
    expect_error(call("rank.consensus", rank_args(meta={"p1": metadata(same_scale=False),
                                                         "p2": metadata()})), "SCHEMA_SCALE_UNDECLARED")
    partial = rank_args(rows=[{"candidate_id": "a", "scores": {"p1": 0.9, "p2": 0.8}},
                              {"candidate_id": "b", "scores": {"p1": 0.7}}])
    expect_error(call("rank.consensus", partial), "SCHEMA_COVERAGE_MISMATCH")
    legacy = call("rank.consensus", {"candidates": [{"candidate_id": "a", "scores": {"p1": 0.9}},
                                                     {"candidate_id": "b", "scores": {"p1": 0.7, "p2": 0.5}}]})
    assert legacy["ok"] is True and legacy["result"]["score_contract"]["comparability"] == "unknown"
    assert legacy["result"]["score_contract"]["fingerprint"] is None
    assert [row["candidate_id"] for row in legacy["result"]["ranking"]] == ["a", "b"]

    with tempfile.TemporaryDirectory(prefix="galatea-gl3-", dir=TEMP_ROOT) as folder:
        root = pathlib.Path(folder)
        csv1 = root / "typed1.csv"
        typed1 = call("rank.consensus", dict(rank_args(), output_csv=str(csv1)))
        assert typed1["ok"] is True
        sidecar1 = pathlib.Path(str(csv1) + ".score-contract.json")
        assert csv1.exists() and sidecar1.exists()
        reread = call("rank.consensus", {"csv_path": str(csv1)})
        assert reread["ok"] is True
        assert reread["result"]["score_contract"]["fingerprint"] == typed1["result"]["score_contract"]["fingerprint"]
        csv2 = root / "typed2.csv"
        other = rank_args(rows=[{"candidate_id": "c", "scores": {"p1": 0.4, "p2": 0.3}}],
                          meta={"p1": metadata(model_version="2"), "p2": metadata(model_version="2")})
        typed2 = call("rank.consensus", dict(other, output_csv=str(csv2)))
        assert typed2["ok"] is True
        target = root / "aggregate.csv"
        target.write_text("ORIGINAL\n", encoding="utf-8")
        old_hash = sha(target)
        expect_error(call("rank.aggregate", {"batches": [{"batch_id": "x", "result": typed1["result"]},
                                                         {"batch_id": "y", "result": typed2["result"]}],
                                             "output_csv": str(target), "overwrite": True}), "SCHEMA_INCOMPARABLE")
        assert sha(target) == old_hash
        expect_error(call("rank.aggregate", {"batches": [{"result": typed1["result"]},
                                                         {"candidates": [{"candidate_id": "legacy", "scores": {"p1": 0.1}}]}],
                                             "output_csv": str(target), "overwrite": True}), "SCHEMA_TYPED_LEGACY_MIX")
        assert sha(target) == old_hash
        expect_error(call("rank.aggregate", {"batches": [{"result": typed1["result"]}],
                                             "predictor_metadata": {"p1": metadata(), "p2": metadata()},
                                             "output_csv": str(target), "overwrite": True}), "SCHEMA_SOURCE_OVERRIDE")
        assert sha(target) == old_hash
        valid = call("rank.aggregate", {"batches": [{"batch_id": "x", "result": typed1["result"]},
                                                    {"batch_id": "y", "csv_path": str(csv1)}],
                                        "output_csv": str(target), "overwrite": True})
        assert valid["ok"] is True and valid["result"]["summary"]["n_candidates"] == 4
        assert len(valid["result"]["batches"]) == 2
        assert call("rank.consensus", {"csv_path": str(target)})["ok"] is True
        old_result = copy.deepcopy(legacy["result"])
        old_result.pop("score_contract")
        old_result.pop("ranking_sha256")
        old_aggregate = call("rank.aggregate", {"batches": [{"result": old_result}],
                                                "output_csv": str(root / "old.csv")})
        assert old_aggregate["ok"] is True
        assert old_aggregate["result"]["score_contract"]["comparability"] == "unknown"
        missing_contract = copy.deepcopy(typed1["result"])
        missing_contract.pop("score_contract")
        expect_error(call("rank.aggregate", {"batches": [{"result": missing_contract}],
                                             "output_csv": str(target), "overwrite": True}), "SCHEMA_SOURCE_MISSING")
        legacy_csv = root / "legacy.csv"
        assert call("rank.consensus", {"candidates": [{"candidate_id": "z", "scores": {"p1": 0.2}}],
                                       "output_csv": str(legacy_csv)})["ok"] is True
        pathlib.Path(str(legacy_csv) + ".score-contract.json").unlink()
        expect_error(call("rank.consensus", {"csv_path": str(legacy_csv),
                                             "predictor_metadata": {"p1": metadata()}}), "SCHEMA_SOURCE_OVERRIDE")
        source = copy.deepcopy(typed1["result"])
        source["score_contract"]["fingerprint"] = "sha256:" + "0" * 64
        expect_error(call("rank.aggregate", {"batches": [{"result": source}],
                                             "output_csv": str(target), "overwrite": True}), "SCHEMA_SOURCE_TAMPERED")
        source = copy.deepcopy(typed1["result"])
        source["ranking"][0]["predictor_scores"]["p1"] = 0.1
        expect_error(call("rank.aggregate", {"batches": [{"result": source}],
                                             "output_csv": str(target), "overwrite": True}), "SCHEMA_SOURCE_TAMPERED")
        assert target.exists()
        rollback_csv = root / "rollback.csv"
        rollback_csv.write_text("ORIGINAL_ROLLBACK\n", encoding="utf-8")
        rollback_hash = sha(rollback_csv)
        pathlib.Path(str(rollback_csv) + ".score-contract.json").mkdir()
        failed_write = call("rank.consensus", dict(rank_args(), output_csv=str(rollback_csv), overwrite=True))
        assert failed_write["ok"] is False and sha(rollback_csv) == rollback_hash
        sidecar = json.loads(sidecar1.read_text(encoding="utf-8"))
        sidecar["score_contract"]["model_version"] = "forged"
        sidecar1.write_text(json.dumps(sidecar), encoding="utf-8")
        expect_error(call("rank.consensus", {"csv_path": str(csv1)}), "SCHEMA_SOURCE_TAMPERED")
        sidecar1.write_text(json.dumps(typed1["result"]["score_contract"]), encoding="utf-8")
        bad_csv = call("rank.consensus", {"csv_path": str(csv1)})
        assert bad_csv["ok"] is False
        # Recreate valid sidecar, then alter the bound CSV bytes.
        csv1.unlink()
        sidecar1.unlink()
        typed1 = call("rank.consensus", dict(rank_args(), output_csv=str(csv1)))
        csv1.write_bytes(csv1.read_bytes() + b"\n")
        assert call("rank.consensus", {"csv_path": str(csv1)})["ok"] is False
        assert call("rank.consensus", dict(rank_args(), output_csv=str(root)))["ok"] is False
    print("GL3_R2_PASS bridge dimensions, coverage, provenance, CSV roundtrip and tamper")


if __name__ == "__main__":
    main()
