"""Require every mandatory probe in the transcript retained by the Build workflow."""
import json
from pathlib import Path
import sys


def check(result, pin):
    if result["result"] != "passed" or result["sha256"] != pin:
        raise ValueError("wrong result or pin")
    expected = {}
    def refusal(case, phase, probe, code, count):
        expected[case, phase, probe] = (code, count)
    for probe, code in [("profile_psyche.experimental.adapter-lifecycle.v2.next", "unsupported_version"),
                        ("profile_psyche.experimental.adapter-lifecycle.v2.retired", "unsupported_version"),
                        ("reader_version_0", "incompatible_downgrade"), ("reader_version_3", "incompatible_downgrade"),
                        ("fault_unrecognized", "unsupported_request")]:
        refusal("unknown_input", "first", probe, code, 0)
    refusal("unknown_input", "unrecognized", "unknown_phase", "unsupported_request", 0)
    for case, code in [("agent_approval", "operator_required"), ("cancel", "action_invalidated")]:
        for phase in ("first", "replay", "rollback"):
            refusal(case, phase, "initial" if phase == "first" else "reopen", code, 0)
    for probe, phase in [("request_id", "replay"), ("payload_digest", "replay")]:
        refusal("success", phase, probe, "stale_correlation", 1)
    for case in ("success", "lost_ack"):
        for probe in ("wrong_task_id", "wrong_action_id"):
            refusal(case, "rollback", probe, "stale_correlation", 1)
        for phase in ("replay", "rollback"):
            refusal(case, phase, "downgrade", "incompatible_downgrade", 1)
            refusal(case, phase, "unknown_profile", "unsupported_version", 1)
    rows = result["cases"]
    denials = {(r["case"], r["phase"], r["probe"]): (r["code"], r["executions"]) for r in rows if "code" in r}
    if denials != expected or len(rows) != len(expected) + 6:
        raise ValueError("required lifecycle probe missing or incorrect")
    ids = set()
    for case, state in [("success", "succeeded"), ("lost_ack", "unknown")]:
        group = [r for r in rows if r["case"] == case and "state" in r]
        fields = ("execution_id", "task_id", "action_id", "receipt_sha256", "executions", "state")
        if ([r["phase"] for r in group] != ["first", "replay", "rollback"] or
                len({tuple(r[key] for key in fields) for r in group}) != 1 or
                group[0]["executions"] != 1 or group[0]["state"] != state):
            raise ValueError("invalid terminal lifecycle")
        ids.add(group[0]["execution_id"])
    if len(ids) != 2:
        raise ValueError("independent handler invocations need distinct execution IDs")
    refusals = [r for r in result["controls"] if r.get("outcome") == "rejected"]
    if {r["group"] for r in refusals} != set(range(1, 7)):
        raise ValueError("missing negative control group")
    measured, = [r for r in result["controls"] if "independent_invocations" in r]
    if measured["reported_per_action"] != [1, 1] or measured["independent_invocations"] != 6 or len(set(measured["execution_ids"])) != 6:
        raise ValueError("missing duplicate execution evidence")


if __name__ == "__main__":
    check(json.loads(Path(sys.argv[1]).read_bytes()), sys.argv[2])
