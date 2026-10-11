"""Branch table for the production Python stdout envelope."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))

from galatea_ops import _bridge_envelope


def main():
    plain = {"answer": 42}
    assert _bridge_envelope(plain) == {"ok": True, "result": plain}

    normalized = {"ok": True, "result": {"answer": 42}}
    assert _bridge_envelope(normalized) is normalized

    direct_success = {"ok": True, "status": {"rounds": 1}}
    assert _bridge_envelope(direct_success) == {
        "ok": True, "result": {"status": {"rounds": 1}},
    }

    failure = {"ok": False, "error": "invalid input"}
    assert _bridge_envelope(failure) is failure

    malformed = {"ok": "yes", "payload": "must fail closed"}
    assert _bridge_envelope(malformed) == {
        "ok": False,
        "code": "BRIDGE_PROTOCOL",
        "error": "operation returned a non-boolean ok value",
    }
    print("BRIDGE_ENVELOPE_PASS plain, normalized, direct success, error and malformed ok")


if __name__ == "__main__":
    main()
