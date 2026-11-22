# Offline Psyche Build lifecycle canary

From a checkout with the frozen dependencies installed, run `bash protocol-fixtures/psyche-lifecycle/qualify.sh`. The script verifies the producer artifact before execution, confirms network isolation and runs it from an empty directory using a clean environment. The supported qualification hosts are macOS with sandbox-exec and Linux with permission to create an isolated network namespace.

The adapter uses Build’s orchestration planner, control runtime, lease and approval handling, task-owned receipt API and persistent control journal. The synthetic browser handler appends one line per effect and can lose the acknowledgment after writing. Before and after process restart, two independently authenticated ControlClient connections reopen the task-owned receipt over a fixture-local Unix socket. The operator socket uses the default policy and serves only status reads in this canary. The rollback process reads only the original Build identifiers and native journal. No live browser, daemon or user project is exercised. The fixture sidecar stores the synthetic request correlation and original command so the caller can resubmit it after disconnect. Fixture data lives in a temporary directory.

The source and SHA-256 in `pin.json` identify the experimental producer artifact. Rebuild it using the producer’s `profiles/adapter-lifecycle/qualify.sh`, verify the archive and member hashes, then update the artifact and pin together. Removing the fixture and its workflow restores the prior checkout. Product data and release compatibility are outside this experimental canary. [Build compatibility map](../../docs/PSYCHE-COMPATIBILITY-MAP.md) · [Consumer tracker](https://github.com/OpenCoven/psyche-build/issues/253)

To verify the embedded receipt comparator independently, run this command from the Build repository root. It reads the producer source from the kit manifest and hashes the embedded verifier bytes. For this pin, the output is `a6ec0f644c891244200b93eb1def19800981e772 6ee74ca1f7e67b2f1c8f6afacac921318a8121b1cd4eb0f970081f4714bfb3a8`. [Producer checksum](https://github.com/OpenCoven/psyche/blob/a6ec0f644c891244200b93eb1def19800981e772/profiles/receipt-replay/archive.sha256)

```sh
python3 -I -c 'import hashlib,json,zipfile; z=zipfile.ZipFile("protocol-fixtures/psyche-lifecycle/adapter-lifecycle.pyz"); print(json.loads(z.read("manifest.json"))["receipt_source"], hashlib.sha256(z.read("receipt-replay.pyz")).hexdigest())'
```
