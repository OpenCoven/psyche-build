"""Read the frozen fixture request and original Build journal independently of the adapter reply."""
import hashlib
import json
import re
import sys
from pathlib import Path


def member(source, key):
    """Slice one member from a parsed journal object, retaining the original JSON bytes."""
    decoder = json.JSONDecoder()
    token = re.compile(r"\s*")
    pos = token.match(source).end()
    if source[pos] != "{":
        raise ValueError("invalid_native_journal")
    pos += 1
    found = None
    while True:
        pos = token.match(source, pos).end()
        if source[pos] == "}":
            return found
        name, pos = decoder.raw_decode(source, pos)
        pos = token.match(source, pos).end()
        if source[pos] != ":":
            raise ValueError("invalid_native_journal")
        start = token.match(source, pos + 1).end()
        _, pos = decoder.raw_decode(source, start)
        if name == key:
            if found is not None:
                raise ValueError("duplicate_native_journal_field")
            found = source[start:pos]
        pos = token.match(source, pos).end()
        if source[pos] == "}":
            return found
        if source[pos] != ",":
            raise ValueError("invalid_native_journal")
        pos += 1


def read_effects():
    handler = Path("effects")
    native = handler.read_bytes().splitlines(keepends=True) if handler.exists() else []
    ledger = Path("v2-executions.ndjson")
    effects = [json.loads(row) for row in ledger.read_bytes().splitlines()] if ledger.exists() else []
    if native != [b"submit\n"] * len(effects):
        raise ValueError("native_handler_count_mismatch")
    return effects


def read(operation):
    effects = read_effects()
    if operation == {"operation": "effects"}:
        return dict(effects=effects)
    if operation != {"operation": "binding"}:
        raise ValueError("unsupported_observation")
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
    receipt_hex = None
    resolutions = set()
    resolved_receipts = []
    with Path(".psyche/runtime/events.ndjson").open(encoding="utf-8") as journal:
        for line in journal:
            event = json.loads(line)
            payload = event["payload"]
            if event["kind"] == "command.requested" and payload.get("kind") == "approval.resolve":
                resolutions.add(payload["commandId"])
            if payload.get("commandId") in resolutions and payload.get("receipt"):
                resolved_receipts.append(payload["receipt"])
            if payload.get("commandId") != action_id:
                continue
            if event["kind"] == "approval.requested" and payload.get("taskId") == task:
                approvals.append(payload)
            if payload.get("receipt"):
                terminal = payload["receipt"]
                receipt_hex = member(member(line, "payload"), "receipt").encode("utf-8").hex()
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
    if effects and (terminal is None or resolved_receipts.count(terminal) != 1):
        raise ValueError("native_approval_resolution_missing")
    return dict(effects=effects, binding=binding, refusal=refused, request_hex=raw.hex(), state=terminal["state"] if terminal else None,
                receipt_hex=receipt_hex)


if __name__ == "__main__":
    print(json.dumps(read(json.load(sys.stdin))))
