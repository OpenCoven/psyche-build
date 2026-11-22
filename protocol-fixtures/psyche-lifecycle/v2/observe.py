"""Read the frozen fixture request and original Build journal independently of the adapter reply."""
import hashlib
import json
from pathlib import Path


def read():
    saved = json.loads(Path("v2-binding.json").read_bytes())
    engine = json.loads(Path("fixture-binding.json").read_bytes())
    action = engine["action"]
    task = action["payload"]["taskId"]
    action_id = action["id"]
    raw = bytes.fromhex(saved["request_hex"])
    request = json.loads(raw)
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    if (engine["requestId"], engine["requestDigest"]) != (request["request_id"], digest):
        raise ValueError("persisted_request_mismatch")
    approvals = []
    terminal = None
    with Path(".psyche/runtime/events.ndjson").open(encoding="utf-8") as journal:
        for line in journal:
            event = json.loads(line)
            payload = event["payload"]
            if payload.get("commandId") != action_id:
                continue
            if event["kind"] == "approval.requested" and payload.get("taskId") == task:
                approvals.append(payload)
            if payload.get("receipt"):
                terminal = payload["receipt"]
    if len(approvals) != 1:
        raise ValueError("native_approval_missing")
    approval = approvals[0]
    binding = dict(request_id=request["request_id"], request_digest=digest, attempt_id=request["attempt_id"],
                   task_id=task, action_id=action_id, approval_id=approval["approvalId"], approval_digest=approval["payloadDigest"])
    if saved["binding"] != binding:
        raise ValueError("native_binding_mismatch")
    if terminal and (terminal["taskId"], terminal["actionId"]) != (task, action_id):
        raise ValueError("native_receipt_mismatch")
    refused = None
    marker = Path("v2-refusal")
    if marker.exists():
        record = json.loads(marker.read_bytes())
        key = hashlib.sha256(record["outcomeId"].encode()).hexdigest()
        stored = json.loads((Path(".psyche/runtime/outcomes") / key).read_bytes())
        if stored["idempotencyKey"] != record["outcomeId"] or stored["outcome"]["code"] != record["code"]:
            raise ValueError("native_refusal_mismatch")
        refused = stored["outcome"]["code"]
    return dict(binding=binding, refusal=refused, request_hex=raw.hex(), state=terminal["state"] if terminal else None,
                receipt_hex=json.dumps(terminal, ensure_ascii=False, separators=(",", ":")).encode().hex() if terminal else None)


if __name__ == "__main__":
    print(json.dumps(read()))
