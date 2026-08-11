# Research-Grade Diagnostics and Copyable Agent Report Design

## Problem

Psyche currently exposes failures through transient status text, terminal annotations, panel errors, and a boot-error screen. Those surfaces help a person notice a problem, but they do not preserve a coherent timeline or produce an evidence package that can be shared with a coding agent. Native failures can be separated from their frontend symptom, hard exits can erase the useful context, and manually copying terminal output risks omitting decisive state or exposing credentials.

Psyche needs a local, structured diagnostic journal and an inspect-before-copy report that is useful for agentic patching without becoming telemetry or a general session recorder.

## Goals

- Preserve ordered, structured application evidence across restarts.
- Correlate frontend actions with native operations and record durations and outcomes.
- Produce a deterministic, versioned report suitable for both human reading and machine parsing.
- Let the user inspect the exact redacted report before copying it.
- Include enough runtime, workspace, session, and bounded terminal context to reproduce and patch failures.
- Bound retention, field sizes, report sizes, and disk usage.
- Keep collection local and make diagnostic failures non-fatal.

## Non-Goals

- Uploading telemetry, crash reports, or support bundles.
- Recording prompts, complete terminal transcripts, source contents, diffs, or full environment maps.
- Replacing macOS unified logging or building a general log viewer.
- Capturing performance profiles, screenshots, network bodies, or arbitrary process output.
- Automatically sending a report to an agent or opening an issue.

## Architecture

### Native diagnostic journal

Add a focused Rust diagnostics module under the Tauri application. It owns:

- the versioned event and report schemas;
- sequence, run, and operation identifiers;
- timestamp and monotonic-duration handling;
- field normalization, size limits, and redaction;
- an in-memory ring buffer;
- rotating JSONL persistence in the Tauri application-data directory;
- retention cleanup and corrupt-tail recovery;
- snapshot assembly and truncation accounting.

Initialize the journal during Tauri setup and expose it as managed application state. Journal initialization or persistence failure must not prevent Psyche from starting. When persistence is unavailable, the journal continues in memory and adds a collector warning to snapshots.

Persist structured events as one JSON object per line. Each event contains at least:

- schema version;
- monotonically increasing sequence number;
- wall-clock timestamp;
- run ID and optional operation/correlation ID;
- severity;
- component and event name;
- outcome and optional duration;
- sanitized, bounded attributes;
- truncation and redaction counts where applicable.

The journal retains at most seven days or 25 MiB across rotated files, whichever bound is reached first. Cleanup runs at startup and after rotation. The current file must tolerate a partial final line so an interrupted write does not invalidate earlier events.

### Tauri command surface

Expose three commands:

- `diagnostics_record` accepts a typed frontend event and records it after native validation and redaction.
- `diagnostics_snapshot` accepts bounded transient UI context and produces the complete redacted report preview.
- `diagnostics_clear` clears persisted diagnostic files and the in-memory ring buffer after UI confirmation.

Native operations record events at their owning seams. Frontend invocations generate an operation ID and record start/outcome/duration. Commands where deeper native evidence is useful accept that optional diagnostic context so native events share the same operation ID. This should be introduced through a small invocation wrapper rather than scattered ad hoc logging calls.

### Frontend diagnostics module

Keep diagnostics logic out of the existing application shell by adding a small frontend diagnostics module following the native editor/session bundle pattern. It owns:

- frontend event normalization and the diagnostic invocation wrapper;
- browser error and unhandled-rejection capture;
- current terminal-tail extraction;
- drawer state and report-preview rendering;
- clipboard and clear-log interactions.

The main shell supplies active project, worktree, session, and terminal objects through a narrow interface. The diagnostics module must not read file buffers, editor contents, diffs, prompts, browser page contents, or arbitrary local storage.

## Data Collection

### Persisted evidence

Persist sanitized structured metadata for:

- application startup, ready state, and clean-shutdown intent;
- frontend exceptions and unhandled promise rejections;
- PTY start, ready, exit, stop, and failure lifecycle;
- filesystem, Git, worktree, browser, and session operation outcomes;
- panel-load and report-collection failures;
- diagnostic rotation, degradation, recovery, and clear operations.

Routine high-volume payloads such as PTY bytes are not journaled. Success events should remain concise; error events may include bounded sanitized messages and error chains.

### Snapshot-only evidence

When the drawer opens, request a fresh snapshot. Collect but do not persist:

- app/build version, macOS version, architecture, and available WebView/runtime versions;
- active project and selected worktree paths normalized relative to the home directory;
- branch, HEAD SHA, upstream, ahead/behind counts, and changed file names;
- active session names, kinds, states, commands by executable name only, and exit information;
- the last 200 normalized terminal lines or 64 KiB, whichever is smaller.

Terminal context comes from the active terminal buffer at snapshot time. It is not a continuously persisted transcript. ANSI control sequences and unstable screen-control artifacts are removed before redaction and inclusion.

Snapshot collection is best-effort. A failed Git, runtime, session, or terminal collector becomes a structured `collection_errors` entry instead of failing the entire report.

## Redaction and Privacy

Apply redaction before any event reaches disk and apply it again while assembling the snapshot. The two passes are independent safety boundaries.

Redaction covers:

- secret-shaped keys such as token, secret, password, credential, authorization, cookie, and private key;
- bearer and basic authorization values;
- common API-key and access-token formats;
- PEM private-key blocks and multiline credential blobs;
- URLs containing user information or sensitive query parameters;
- shell-style sensitive environment assignments;
- explicitly known sensitive values available to the diagnostic call without enumerating the environment.

Replace a recognized home-directory prefix with `~`. Preserve project-relative paths and dirty file names because they materially help an agent locate a patch. Bound attribute names, values, event sizes, terminal lines, and error-chain depth before storage.

The preview must state that source contents, diffs, prompts, full transcripts, and complete environment values are excluded. Reports include redaction and truncation counters so absence of detail is observable rather than ambiguous.

## Report Format

The clipboard payload is readable Markdown followed by a fenced, versioned JSON representation of the same report. The Markdown summary includes:

- report schema and generation time;
- application and runtime information;
- workspace and Git state;
- session state;
- recent errors and ordered diagnostic evidence;
- bounded terminal tail;
- collection failures;
- redaction and truncation accounting.

The JSON payload uses a stable schema identifier such as `psyche.diagnostics/v1`. Ordering is deterministic so two reports can be compared meaningfully. The final report has a hard byte cap. When the cap is approached, remove oldest informational events first, then shorten terminal context, while preserving errors, collection failures, schema metadata, and accurate truncation counts.

## User Experience

Add a persistent `Diagnostics` action to the titlebar beside the existing status and browser controls. Activating it opens a right-aligned overlay drawer without replacing the current terminal, editor, or side panel.

Opening the drawer generates a fresh redacted report before showing the preview. The drawer contains:

- title and close control;
- `Fresh snapshot · redacted locally` status;
- compact health, evidence-size, workspace, and redaction summary cards;
- a scrollable plain-text preview showing exactly what will be copied;
- a primary `Copy report` action;
- a secondary `Clear logs` action;
- a concise exclusion notice.

Copying uses the available secure clipboard API. Success temporarily changes the primary action to `Copied`; failure keeps the preview open and shows an actionable error. Clearing logs requires confirmation, does not touch workspace data, and refreshes the drawer to an empty-journal snapshot after completion.

The drawer traps focus while open, supports Escape to close, restores focus to the titlebar action, exposes status changes through an ARIA live region, and remains usable at the smallest supported window size.

## Failure and Crash Semantics

Diagnostic recording must never block the UI on disk I/O or crash the app. Write and rotation failures degrade to the in-memory ring and appear as collector warnings.

Record a run-start marker and clean-shutdown intent. If a later startup finds a run without a clean marker, report that the prior run may have ended unexpectedly; do not claim a confirmed crash. Register frontend global error handlers and a Rust panic hook to capture bounded final evidence when possible. Release panic behavior and abrupt process termination mean this capture is best-effort.

If the journal contains a corrupt or partial trailing record, retain valid preceding records, quarantine or skip only the invalid tail, and record recovery in the next snapshot.

## Testing

Follow test-driven development for each behavior.

Rust unit tests cover:

- event validation and deterministic serialization;
- sequence ordering and correlation fields;
- secret redaction, including adversarial multiline fixtures;
- field, event, journal, terminal, and final-report caps;
- rotation, seven-day/25-MiB retention, and cleanup;
- partial/corrupt-tail recovery;
- in-memory degradation after persistence failure;
- clean/unclean run markers;
- deterministic Markdown and JSON report generation;
- best-effort collector failures and truncation accounting.

Frontend tests cover:

- invocation start/outcome/duration recording;
- terminal-buffer normalization and bounds;
- browser error and rejected-promise capture;
- drawer focus, Escape, preview, loading, copied, clipboard-error, clear-confirmation, and empty states;
- exclusion of editor, diff, prompt, browser-content, and local-storage data;
- Tauri command registration and titlebar integration.

Add a native integration smoke test that records representative frontend/native events, builds a snapshot, verifies redaction, and clears the journal in an isolated temporary application-data directory.

Before committing implementation, run the focused tests and the repository validation surface:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm smoke`
- `pnpm smoke:pack`
- native Rust formatting, checks, and tests under `native/macos/psyche-build-tauri/src-tauri`

## Rollout

Ship diagnostics enabled by default because collection is local, bounded, and excludes content-heavy surfaces. Do not add telemetry consent or network configuration. Schema versioning allows future report readers to distinguish format changes. Any later upload/share integration requires a separate design and explicit user authorization.
