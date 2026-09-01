# Support bundle v1

`psyche.diagnostics/v1` is a local-only, inspectable support contract. It is a
bounded snapshot of safe application state, not a transcript, telemetry stream,
or authority source. The schema foundation lives in
`src/diagnostics/supportBundle.ts`; the fixture at
`protocol-fixtures/support-bundle/v1/safe-bundle.json` contains no user data.
The checked-in fixture is deliberately unsigned, `partial`, and marked
`unverified`; it demonstrates shape and redaction only and is never
authentication evidence.

## Contract

Every bundle contains a schema identifier, format version, generation time,
status, safe application provenance, bounded state maps, ordered diagnostic
records, redacted action receipts, collection errors, and redaction/truncation
manifests. The receipt projection vocabulary is derived and explicit:
`pending`, `executing`, `succeeded`, `failed`, `unknown`, and `invalidated`.
A diagnostic bundle reports state; it cannot authorize, retry, or execute an
action. The existing control-plane owner, lease, approval, idempotency, and
receipt contracts remain authoritative.

The compatibility policy rejects an unknown major schema/version and permits a
reader to ignore unknown fields within a supported major version. Receipt
entries are projections of validated `psyche.control.receipt/v1` records: source
states `queued` and `approval_required` map to `pending`, `running` maps to
`executing`, `denied` maps to `failed`, and `expired` maps to `invalidated`.
The projection keeps only bounded authority metadata, SHA-256 digests for
action/task/actor/lease identifiers, and a resource digest; it never copies
receipt messages or values. Project names are omitted; project-relative paths
are retained only when they pass the same bounded, secret-shaped path guard.

Collection state uses the separate bundle status vocabulary
`complete`, `partial`, `unknown`, and `recovery_required`; those values are not
invented as receipt projections when the authoritative control receipt has no
such source state.

Serialization re-normalizes the input at the export boundary, sorts object keys
and deterministic record/receipt collections, and re-applies the payload cap.
`supportBundleDigest` hashes that stable UTF-8 representation, so two bundles
with the same safe facts can be compared without depending on insertion order.

An accounting proof is authenticated only when a caller explicitly supplies a
codec backed by deployment-held key material. Parsing without that codec strips
any proof and returns an unauthenticated projection, downgrading `complete` to
`partial`. Supplying a codec for an unsigned bundle fails closed. Published
fixture keys and test literals are not operational credentials; the legacy
published fixture key is rejected, and fixture generation never signs data.

## Bounds

The v1 implementation enforces the following defaults before serialization:

| Surface | Bound |
| --- | ---: |
| Async collection and normalization deadline | 30 seconds |
| Collector preflight graph | 16,384 values across the collection |
| Diagnostic records | 256 |
| One record | 4 KiB |
| Complete payload | 64 KiB |
| One scalar string | 512 UTF-8 bytes |
| Attribute keys/items | 32 each |
| Attribute nesting | 5 levels |
| Collection error chain | 4 |
| Omitted collection errors | counted in `truncation.errorsOmitted` |
| Action receipts | 64 |
| Raw terminal input | 64 lines / 16K characters per line; never emitted |

When the payload approaches its cap, oldest records are removed, then the
largest state fields and finally receipts. Raw terminal input is omitted during
normalization before payload fitting. The truncation manifest records what was
removed. A collector
timeout, cancellation, or recovery-sensitive failure produces
`recovery_required`; ordinary collector failures produce `partial`. No failed
collector is represented as complete success.

## Threat model and redaction

There are two safety boundaries: input normalization and final deterministic
serialization. Secret-shaped keys, authorization values, bearer/basic tokens,
known API-token formats, PEM material, sensitive assignments, infrastructure URLs,
and absolute paths are redacted or omitted. Prompts, unrestricted terminal or
repository content, diffs, environment maps, and source contents are omitted.
Only explicitly bounded terminal tails, project-relative paths, allowlisted
diagnostic categories, digests, and categorized errors may survive. Provenance
uses a closed application/platform/architecture vocabulary and a bounded
release version. Unknown
top-level fields are omitted and counted. The redaction manifest records
categories and counts, never original values; caller-supplied manifests are not
trusted as evidence.

The support contract intentionally does not capture screenshots, network bodies,
full process arguments, complete file paths, credentials, source contents, or
arbitrary terminal text. `terminalTail` is reserved for a future typed,
enumerated diagnostic-event contract; raw terminal lines are omitted and
counted in the truncation/redaction manifests. The safe fixture is generated
from literal test data only and must remain free of real logs, prompts,
repositories, terminals, and secrets.

## Collection and later surfaces

`collectSupportBundle` accepts named collectors and an `AbortSignal`. It runs
collectors with a shared elapsed-time budget, preflights their complete bounded
input graph, and converts failures into bounded collection errors. The deadline
is cooperative for in-process JavaScript: a collector must yield, and native
bridges must move blocking work off-thread before returning their promise because
the event loop cannot preempt synchronous code. An overrun is still fail-closed
and reported as `recovery_required`. A future CLI
or UI may request a fresh snapshot, display the redacted preview, and offer
copy/clear actions, but it must not silently upload
or execute anything. The later surface must preserve cancellation, timeout,
partial-failure, and `recovery_required` semantics and must show the exact
payload before copying. Empty or malformed collector results, conflicting
singleton sections, collector-count overflow, and normalization overruns are
reported as `recovery_required` rather than being treated as complete data.

The reusable recovery harness in #239 is intentionally separate. Once #239 has
operator-observed cases, those cases may be mapped to fixture-only collector
scenarios without copying private evidence into this schema or its tests.
Graphics facts are optional and non-blocking; unsupported or conflicting
evidence must remain absent or `unknown`.

## Rollback and recovery

This foundation is additive and has no persistence migration. A caller can
stop using the module and discard generated snapshots without changing project
state. If a future persistence adapter is added, it must apply the same
normalization before disk I/O, preserve valid prior records after a corrupt
tail, and surface storage failure as `partial` or `recovery_required` rather
than blocking application startup. A later CLI/UI integration requires its own
focused review for authority, clipboard, and clear-confirmation behavior.
