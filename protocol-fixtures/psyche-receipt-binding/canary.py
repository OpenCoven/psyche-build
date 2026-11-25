"""Black-box receipt binding for one explicitly admitted Build fixture operation."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


ISSUER = "psyche-receipt-issuer"
NAMESPACE = "psyche.build-receipt-binding.v1"
PROFILE = "psyche.experimental.adapter-lifecycle.v1"


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def canonical(record):
    # All keys and values in this flat fixture binding are printable ASCII strings.
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode("ascii")


def run(argv, *, cwd, data=None):
    return subprocess.run(argv, cwd=cwd, input=data, capture_output=True, check=True, timeout=60).stdout


def require(condition, message):
    if not condition:
        raise ValueError(message)


class NativeAction:
    def __init__(self, directory, node, fixture, request, ambiguous):
        self.cwd = directory
        directory.mkdir()
        self.node = [node, "--import", fixture.parents[1] / "node_modules/tsx/dist/loader.mjs"]
        self.fixture = fixture
        self.request = request
        self.ambiguous = ambiguous
        envelope = dict(phase="first", profile=PROFILE, reader_version=1,
                        request_hex=request.hex(), request_id=json.loads(request)["request_id"])
        if ambiguous:
            envelope["fault"] = "lost_ack"
        require(not (directory / "effects").exists(), "fixture must begin without a witness")
        response = json.loads(run([*self.node, fixture / "adapter.mts"], cwd=directory, data=json.dumps(envelope).encode()))
        admission = json.loads((directory / "fixture-binding.json").read_bytes())
        action = admission["action"]
        self.task = action["payload"]["taskId"]
        self.action = action["id"]
        self.key = action["idempotencyKey"]
        require(admission["requestId"] == envelope["request_id"] and admission["requestDigest"] == digest(request),
                "original request differs from native admission")
        self.receipt = self.read_receipt(response)
        self.state = json.loads(self.receipt)["state"]
        self.journal_before = self.journal.read_bytes()
        self.check_unchanged()

    @property
    def journal(self):
        return self.cwd / ".psyche/runtime/events.ndjson"

    def check_unchanged(self):
        witness = (self.cwd / "effects").read_bytes()
        require(witness == b"submit\n", "expected exactly one native handler invocation")
        journal = self.journal.read_bytes()
        require(journal == self.journal_before, "native journal changed after the action")
        return {"task_id": self.task, "action_id": self.action, "native_state": self.state,
                "native_effects": len(witness.splitlines()), "receipt_digest": digest(self.receipt),
                "journal_digest": digest(journal)}

    def read_receipt(self, response):
        require(response["action_id"] == self.action and response["task_id"] == self.task, "native reader correlation mismatch")
        state = "unknown" if self.ambiguous else "succeeded"
        require(response["state"] == state, "unexpected native disposition")
        for line in reversed(self.journal.read_bytes().splitlines()):
            event = json.loads(line)
            payload = event["payload"]
            if payload.get("commandId") != self.action or "receipt" not in payload:
                continue
            receipt = payload["receipt"]
            require((receipt["actionId"], receipt["taskId"], receipt["state"], payload["idempotencyKey"])
                    == (self.action, self.task, state, self.key), "unexpected terminal journal record")
            # The fixture's native adapter returns bytes. Verify the exact slice in the stored
            # event, including property order, formatting and escape sequences, before signing.
            wire = bytes.fromhex(response["receipt_hex"])
            token = b'"receipt":' + wire
            require(line.count(token) == 1 and json.loads(wire) == receipt, "native receipt bytes differ")
            start = line.index(token) + len(b'"receipt":')
            return line[start:start + len(wire)]
        raise ValueError("native receipt absent")

    def reopen(self):
        response = json.loads(run([*self.node, self.fixture / "reopen.mts", self.task, self.action], cwd=self.cwd))
        wire = self.read_receipt(response)
        self.check_unchanged()
        require(wire == self.receipt, "restart changed original native receipt")
        return wire


def verify(executable, work, native, label, context, receipt, binding, signature, expected):
    paths = ["allowed_signers", context, "request.json", receipt, binding, signature]
    # A verifier decision cannot reach native dispatch. The only child here is the published verifier.
    result = subprocess.run([executable, *paths], cwd=work, capture_output=True, timeout=15)
    decision = json.loads(result.stdout)
    require(decision == {"result": expected[0], "code": expected[1], "redispatch": False}, f"{label}: {decision}")
    require((result.returncode == 0) == (expected[0] == "verified") and result.returncode >= 0,
            f"{label}: unexpected verifier exit {result.returncode}")
    print(json.dumps({"case": label, "decision": decision, **native.check_unchanged()}))


def sign(work, filename, binding, key):
    (work / filename).write_bytes(canonical(binding))
    run(["ssh-keygen", "-q", "-Y", "sign", "-n", NAMESPACE, "-f", key, filename], cwd=work)
    return filename + ".sig"


def scenario(root, node, fixture, kit, ambiguous):
    lane = root / ("lost-ack" if ambiguous else "success")
    lane.mkdir()
    verifier = kit / "bin/verify-build-binding"
    request = (kit / "golden/request.json").read_bytes()
    native = NativeAction(lane / "native", node, fixture, request, ambiguous)
    work = lane / "evidence"
    work.mkdir()
    for key in ("trusted", "other"):
        run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "disposable-canary", "-f", key], cwd=work)
    (work / "allowed_signers").write_bytes(ISSUER.encode() + b" " + (work / "trusted.pub").read_bytes())
    (work / "request.json").write_bytes(request)
    (work / "receipt.bin").write_bytes(native.receipt)
    context = dict(task_id=native.task, action_id=native.action, idempotency_key=native.key,
                   outcome={"succeeded": "terminal", "unknown": "ambiguous"}[native.state])
    (work / "context.json").write_bytes(canonical(context))
    binding = dict(context, schema_version="psyche.build_receipt_binding.v1", issuer=ISSUER,
                   request_id=json.loads(request)["request_id"], request_digest=digest(request),
                   receipt_digest=digest(native.receipt))
    signature = sign(work, "binding.json", binding, "trusted")
    retained = {name: (work / name).read_bytes() for name in ("binding.json", signature, "receipt.bin", "context.json")}
    valid = ("unknown", "reconciliation_required") if ambiguous else ("verified", "binding_verified")

    def check(case, expected, *, context="context.json", receipt="receipt.bin", record="binding.json", sig=signature):
        verify(verifier, work, native, case, context, receipt, record, sig, expected)

    name = "lost_ack" if ambiguous else "terminal"
    check(name, valid)
    if not ambiguous:
        wrong_sig = sign(work, "wrong.json", binding, "other")
        check("wrong_signer", ("denied", "untrusted_issuer"), sig=wrong_sig)
        check("missing_signature", ("unknown", "recovery_required"), sig="absent.sig")
        check("missing_receipt", ("unknown", "recovery_required"), receipt="absent.bin")
        conflict = dict(binding, receipt_digest=digest(native.receipt + b"\n"))
        conflict_sig = sign(work, "conflict.json", conflict, "trusted")
        check("authenticated_conflict", ("quarantine", "conflicting_evidence"), record="conflict.json", sig=conflict_sig)
        quarantine = work / "quarantine"
        quarantine.mkdir()
        for filename in ("conflict.json", conflict_sig):
            contents = (work / filename).read_bytes()
            (work / filename).rename(quarantine / filename)
            retained["quarantine/" + filename] = contents
    (work / "reopened.bin").write_bytes(native.reopen())
    check(name + "_restart", valid, receipt="reopened.bin")
    # Move even the profile inputs out of sight of the original native-only reader.
    archive = work.rename(lane / "retained")
    native.reopen()
    require(all((archive / name).read_bytes() == original for name, original in retained.items()), "retained evidence changed")
    print(json.dumps({"case": name + "_rollback", **native.check_unchanged()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("kit", type=Path)
    parser.add_argument("node", type=Path)
    args = parser.parse_args()
    fixture = Path(__file__).resolve().parent.parent / "psyche-lifecycle"
    for ambiguous in (False, True):
        scenario(Path.cwd(), args.node, fixture, args.kit.resolve(), ambiguous)
