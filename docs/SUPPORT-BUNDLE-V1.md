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

There are two safety boundaries: input normalization and final deterministic serialization. Secret-shaped keys, authorization values, bearer/basic tokens, known API-token formats, PEM material, sensitive assignments, infrastructure URLs, and absolute paths are redacted or omitted. Prompts, unrestricted terminal or repository content, diffs, environment maps, and source contents are omitted. Only project-relative paths, allowlisted diagnostic categories, digests, and categorized errors may survive; arbitrary terminal text is always omitted. Provenance uses a closed application/platform/architecture vocabulary and a bounded release version. Unknown top-level fields are omitted and counted. The redaction manifest records categories and counts, never original values; caller-supplied manifests are not trusted as evidence.

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

## `psyche support-bundle`

The first production surface over this contract. It is read-only with respect
to application state: it runs bounded collectors, serializes one bundle, and
either writes it into the project or prints it.

```
psyche support-bundle [--project <path>] [--out <file>] [--stdout]
```

Without `--out`, the bundle lands in
`<project>/.psyche/runtime/support-bundles/psyche-support-<UTC stamp>-<digest
prefix>.json` and the newest ten are retained. `--stdout` writes nothing to
disk. A write failure exits 1 and says the bundle was collected, so an operator
can rerun with `--stdout` rather than lose it.

Writing is deliberate about the destination. The file is created exclusively at
`0600` under a random temporary name and renamed into place: `writeFile`'s
`mode` applies only when it creates the path, so writing straight to the target
would inherit a pre-existing file's permissions and would follow a pre-existing
symlink out of the directory. Exclusive creation refuses both, and `rename`
replaces a symlink at the destination rather than following it.

Retention deletes files, so it is doubly guarded: a candidate must match the
exact `psyche-support-<UTC stamp>-<12 hex>.json` pattern **and** parse as a
bundle carrying this schema. A file a person named that way is left alone and
counted as a retention failure, which the summary reports rather than
swallowing. The bundle just written is never a candidate at any retention
value. Two concurrent runs in one directory can still each prune beyond the
limit; the newest bundle always survives, so this costs an older snapshot
rather than the one just collected.

`--out` is a single-file export to a directory the command does not own, so
retention is disabled there entirely — pruning an arbitrary directory could
remove another project's or another tool's files.

The command holds no control-plane authority, so its provenance is always
`verification: 'unverified'` and its bundles cannot reach `complete`. That is
the honest state for an operator-invoked snapshot; it is not a defect to
"fix" by manufacturing a capability.

Collectors currently report platform, release, architecture, a project
identity digest, project-config presence, outstanding recovery state —
worktree recovery markers and quarantined recovery files, which raise the
bundle status to `recovery_required` — plus pane lifecycle, updater, and
installed-provider state.

`lifecycle` carries the persisted pane count and whether a pane layout exists.
`updater` carries whether auto-update is effectively enabled — `AutoUpdater`
defaults an absent section to enabled and disables only on an explicit `false`,
so the bundle reports that behaviour rather than the literal config — whether an
update was cached as available, and whether that cache was computed for the
running build:
`state: 'stale'` means `cachedCurrentVersion` no longer matches, which is the
one place this application compares persisted state against the running
version. Both read persisted state only. Neither starts a process, probes tmux,
or needs a running server, because a bundle must be collectable from an
installation that is not working.

Both sections resolve from one bounded read of the project config, shared
between them: `readProjectPaneConfig` parses the whole file with no size bound
and no interruptible parse, and a bundle must not be the thing that hangs on a
corrupt installation. A config over 1 MiB is not parsed at all.

A config that exists but fails the schema gate, or exceeds that read bound —
corrupt, or written by a newer Psyche — reports `lifecycle.state` and
`updater.state` as `unavailable` while
`persistence.projectConfig` still reports `available`. The pair is what carries
the meaning: the file is there and this version cannot read it. One unreadable
config does not fail the whole collection.

`providers` reports how many of the agent registry's providers have an
executable present (`count`), how many the registry knows (`items`), and
`capability: 'available'` when at least one was found or `'missing'` when none
was. It never names which providers were found, where, or by what command.

The survey reads the filesystem only. The desktop app resolves an agent by
running `$SHELL -i -c "command -v …"`, which starts an interactive shell per
agent, sources the user's rc files, and cannot be cancelled; the bundle does
not. Instead it checks each registry entry's absolute common install paths and
then each absolute entry of the command's own `PATH` for a regular executable
file. Empty and relative `PATH` entries are ignored so the answer does not
depend on the working directory. The collector receives the search path from
the CLI already split and never reads the environment itself, so no
environment value reaches the bundle through it.

Two limits follow, and the section is not evidence beyond them:

- An executable on disk is not a working provider. It may still fail at
  launch, and an agent CLI that fails inside a live shell has no product
  classification yet (#199).
- The command's `PATH` can differ from the interactive login shell the app
  uses, so `count` can disagree with what the app's picker shows in either
  direction. `capability: 'missing'` means nothing was found where the bundle
  looked, not that the app cannot launch an agent.

`PATH` entries are normalized, including a trailing separator, before
duplicates are removed, so `/usr/bin` and `/usr/bin/` cost one search.

The survey checks at most 512 candidate locations. When that budget is
exhausted before all candidates are checked, the survey reports
`state: 'partial'`, so its `count` is a lower bound rather than a checked
absence. A survey whose candidates fit the budget exactly is not partial. The budget is spent in registry order, and each provider costs
its common paths plus one candidate per `PATH` entry until it is found. A long
`PATH` therefore makes `partial` common, and the providers late in the registry
are the ones left unchecked.

Cancellation is checked before each candidate and again after its filesystem
checks finish, so an abort during the last candidate still rejects. A single
filesystem check already in flight, such as one stalled on an unresponsive network mount, cannot be
interrupted; the collection deadline still bounds the bundle, and the overrun
is reported as `recovery_required`. On cancellation the collector rejects
instead of reporting a zero count, and the collection turns that into
`collection_timeout_or_cancelled` and `recovery_required`.

The CLI does not collect graphics, receipt or terminal facts; those sections remain empty rather than fabricated. The application surface below adds a bounded native graphics projection and explicit category accounting.

## Application Help action

Help → Create support bundle reuses the v1 TypeScript collection, normalization, serialization and store interface. Its native filesystem adapter preserves the existing filename ownership, retention, permission and cancellation policies using descriptor-relative, no-follow operations; the CLI keeps its existing export behavior. The desktop package embeds a generated worker, so this path needs neither a source checkout nor an installed Psyche CLI. It uses the application's existing Node.js executable lookup and fails visibly if the supported Node prerequisite is unavailable. A supervised headless instance of the native executable performs Node discovery, filesystem setup, descriptor-relative persistence, verification and reveal preparation. It launches the embedded Node worker directly without a shell, with an explicit environment allowlist; inherited Node injection settings are excluded. The worker source is static public code; project and diagnostic input travel over stdin. It never starts an agent/provider, uploads data, or grants control-plane authority.

Only the trusted main WebView may start, inspect, cancel or reveal an export. Native project authority must already admit the canonical project; the job retains its original project lease until it finishes. There is one active job, and stale job identifiers cannot control a newer job. A project switch does not redirect an export. Reveal revalidates the open project, owned destination, file permissions and SHA-256 rather than accepting a caller-chosen path. Symlinked runtime directories are refused before collection and checked again before writing. On macOS, reveal carries a native file-reference URL verified against the still-open inspected descriptor directly to Finder; it does not resolve the original pathname again. If that identity cannot be established, reveal fails visibly.

| Category | Application accounting |
| --- | --- |
| Provenance | Build source SHA, release, platform and architecture; always unverified |
| Persistence | Bounded project recovery/config-presence metadata; does not claim a native workspace snapshot |
| Providers | Existing bounded filesystem survey only; no provider is executed |
| Lifecycle | Bounded pane count from the main application snapshot; not an authority source |
| Updater | Current native updater setting/state; no update check is started |
| Graphics | Runtime WebView engine; acceleration and broader GPU qualification remain unknown |
| Receipts | Explicitly omitted: this integration has no authoritative receipt-owner projection |
| Terminal | Explicitly omitted: raw terminal content is never collected |

Unavailable native projections are explicitly omitted, and omission records are included in the v1 diagnostic records. The UI shows collection/cancellation progress, failure guidance, redaction/omission counts, category accounting, truncation and retention warnings, and a local reveal action. Exported provenance remains unverified and cannot reach `complete`. A bundle requiring recovery is displayed as such even when its file was saved.

Cancellation is cooperative until the store's atomic rename commit point. Before commit, cancellation removes the temporary file and reports cancelled; after commit, it returns the saved file. A native worker timeout, crash or invalid output without a verified terminal result is `recovery_required`, because it is not proof that no file was written. The existing 30-second collection deadline, 64 KiB payload cap, `0600` exclusive temporary-file creation and ten-bundle retention remain in force; the complete helper operation has a 35-second budget, a two-second cancellation grace period and a one-second reap allowance. The parent terminates the helper process group, releases the project lease and reports recovery if verification cannot finish. An unreaped helper fences further attempts so retries cannot accumulate blocked workers. Native admission uses an already-open exact project key, cached runtime facts and a nonblocking updater snapshot; unavailable snapshots are omitted. Native retention scans at most 4,096 directory entries and reports a retention warning if that bound is reached. Ordinary write failures preserve prior bundles and show safe guidance without copying exception text or personal paths.

Source tests and standalone-worker execution do not establish packaged-app acceptance. #476 requires observation of the actual Help action and resulting file on an immutable local package, retained under #474; that observation does not establish release, signing, distribution or broader support acceptance.

The project identity digest hashes the canonical project root, resolved the way
the recovery readers resolve it, so one project reached through a symlink
digests to one identity rather than one per spelling of its path.

The recovery scan is bounded and cancellable like the rest of collection: at
most 256 files, none larger than 64 KiB, stopping on the collector's abort
signal. A file over that size is quarantined unread, and a scan that hits its
bound reports `state: 'partial'` so partial counts are not read as a whole
directory. `psyche recover` passes no bounds, because the operator surface must
report everything.

Collector fields must use the contract's closed key and value vocabulary. A key
outside `SAFE_STATE_KEYS`, or a string outside `SAFE_DIAGNOSTIC_VALUES`, is
dropped during normalization and counted in `redaction.omittedFields` — the
bundle still serializes, so a collector with the wrong vocabulary silently
reports nothing. Tests assert `omittedFields === 0` for the shipped collectors
to keep that failure visible.

## Rollback and recovery

This foundation is additive and has no persistence migration. A caller can
stop using the module and discard generated snapshots without changing project
state; `psyche support-bundle` writes only into its own runtime directory.
If a future persistence adapter is added, it must apply the same
normalization before disk I/O, preserve valid prior records after a corrupt
tail, and surface storage failure as `partial` or `recovery_required` rather
than blocking application startup. A later CLI/UI integration requires its own
focused review for authority, clipboard, and clear-confirmation behavior.

Native retention atomically claims each selected leaf into a private unpredictable quarantine before its final ownership check. Unknown replacement contents are restored without overwriting a newer leaf; if restoration is unavailable, their contents remain in a hidden `.retention-*` directory and the saved result reports a retention warning. The helper installs parent-disappearance supervision before Node discovery or filesystem work, for both creation and reveal, and retains it through child cleanup. Native persistence acknowledgements have a separate bounded input budget; malformed, oversized or closed broker input always settles the pending operation.
