"""Check each adapter response against Build's native effect witness and journal."""
import json
from pathlib import Path
import subprocess
import sys


def effect_count():
    witness = Path("effects")
    rows = witness.read_bytes().splitlines() if witness.exists() else []
    if any(row != b"submit" for row in rows):
        raise ValueError("unexpected native effect witness")
    return len(rows)


def verify_receipt(response):
    with Path(".psyche/runtime/events.ndjson").open(encoding="utf-8") as journal:
        receipt = None
        for line in journal:
            payload = json.loads(line)["payload"]
            if payload.get("commandId") == response["action_id"] and payload.get("receipt"):
                receipt = payload["receipt"]
    if receipt is None or receipt["taskId"] != response["task_id"] or receipt["state"] != response["state"]:
        raise ValueError("native terminal receipt does not match the adapter binding")
    wire = json.dumps(receipt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if wire != bytes.fromhex(response["receipt_hex"]):
        raise ValueError("adapter receipt differs from the native journal")


def main():
    request = sys.stdin.buffer.read()
    before = effect_count()
    child = subprocess.run(sys.argv[1:], input=request, stdout=subprocess.PIPE, check=True)
    response = json.loads(child.stdout)
    after = effect_count()
    if response["executions"] != after:
        raise ValueError("reported count differs from native handler invocations")
    if "receipt_hex" in response:
        verify_receipt(response)
    first_effect = json.loads(request)["phase"] == "first" and "receipt_hex" in response
    if after - before != int(first_effect):
        raise ValueError("unexpected native handler invocation count for this phase")
    sys.stdout.buffer.write(child.stdout)


if __name__ == "__main__":
    main()
