# Experimental native Build receipt binding

Run `bash protocol-fixtures/psyche-receipt-binding/qualify.sh` from a Build checkout with frozen dependencies installed. The fixture runs on arm64 macOS and x86_64 Linux with Python 3, OpenSSH and Node. Linux uses passwordless sudo for a private network namespace. macOS uses the system sandbox. The script starts from a new private temporary directory, strips inherited credentials, probes IPv4 and IPv6 UDP connectivity to documentation addresses and verifies the SHA-256 of the host's checked-in Psyche archive before extracting or executing its verifier. [Adoption tracker](https://github.com/OpenCoven/psyche-build/issues/253) · [Psyche issuer decision](https://github.com/OpenCoven/psyche/issues/12#issuecomment-7117194956)

The canary sends the producer’s golden launch request through the existing Build lifecycle fixture. Build’s planner allocates a task, its runtime grants a scoped lease, and the approved browser action reaches a synthetic handler that appends one witness. The native fixture uses a local Unix control socket. A second task loses the acknowledgment after its handler appends the witness. The canary reads the original request mapping, native task and action IDs, idempotency key and terminal journal record. It checks the exact bytes of the embedded receipt against the on-disk event and snapshots the native journal before asking the verifier for a decision.

Each test task creates its own disposable issuer and configures its public key as the verifier’s trust policy. The test issuer signs the canonical, flat ASCII binding over the current native receipt, original request and operation references. The canary invokes the unmodified Psyche executable as a child process and checks its exit status, result, code and redispatch flag. After every decision the native journal must still match byte for byte and the independent handler log must still contain exactly one invocation. Only the original approved action can invoke the handler in this flow.

| Observation | Required result |
|---|---|
| Signed terminal native receipt | Verified correlation and one observed handler call |
| Same binding signed with another disposable key | Untrusted issuer |
| Missing signature or missing native receipt | Unknown and recovery required |
| Trusted signature over a conflicting digest | Quarantine disposition, with both the submitted conflict and original signed evidence preserved |
| Lost acknowledgment after the handler ran | Unknown and reconciliation required |
| Fresh process reopens either native journal | Same IDs, receipt bytes, native outcome, effect count and verifier decision |
| Native-only rollback reader with signed evidence and the adapter’s request mapping moved aside | Same receipt and native outcome using only the original Build IDs and journal |

The checked-in archives preserve the exact verifier distributions consumed by the two hosted jobs. Their upstream target, source and SHA-256 are recorded in `pin.json`. Each job retains a bounded JSON-lines transcript containing synthetic IDs, digests, decisions and witness counts. The fixture changes no production state or persisted format. Removing the fixture and its workflow rolls back the experiment. Production key management, live issuance and stable profile activation remain with the upstream and Build owners.
