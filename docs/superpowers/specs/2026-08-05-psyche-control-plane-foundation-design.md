# Psyche Control-Plane Foundation — Design

Date: 2026-08-05
Status: Approved for implementation (foundation slice)
Parent design: `docs/superpowers/specs/2026-08-03-psyche-soul-orchestrator-design.md`
Parent plan: `docs/superpowers/plans/2026-08-03-psyche-host-control-plane.md`

## Goal

Land the trustworthy host boundary for the Psyche soul orchestrator as a set of
pure, self-contained modules under `src/control/`, with **zero runtime behavior
change** to the existing cockpit. This is the first shippable PR of Program A: it
establishes the canonical contracts, single-owner fencing, durable journal, lane
leases, path/pane scope validation, and no-replay prompt dispatch that every
later wiring PR will build on.

This slice is deliberately additive. Nothing here is imported by the daemon,
bridge, MCP, TUI, or cockpit yet. The modules exist, are fully unit-tested, and
are ready to be wired in by a subsequent PR (Program A Tasks 6–11).

## Scope

### In scope (foundation slice — Tasks 1–5 of the parent plan)

1. **Canonical contract** — `src/control/types.ts`, `src/control/protocol.ts`
   - Command/actor/lease/journal/result type definitions.
   - Versioned codec: `decodeControlRequest`, `encodeControlMessage`,
     `CONTROL_PROTOCOL_VERSION`.
   - Stable JSON key ordering on encode; rejects unsupported protocol versions.
   - Checked-in fixtures: `protocol-fixtures/control-v1/command-submit.json`,
     `protocol-fixtures/control-v1/command-result.json`.

2. **Project identity + owner fencing** — `src/control/projectIdentity.ts`,
   `src/control/ownerLock.ts`
   - `canonicalizeProjectRoot()`: fs-canonical (`realpath`) identity, NFC
     normalized on macOS, so symlink aliases map to one project root. Every
     downstream key (owner lock, journal path, endpoint hash, session name,
     welcome identity) is derived from this single canonical value.
   - `acquireOwnerLock()`: exclusive acquisition with monotonic epochs. A second
     live owner fails closed (`already owned`). A dead prior owner is replaced
     and the epoch increments. Concurrent contenders for a stale lock: exactly
     one wins. A provisional lock whose creator died before epoch finalization is
     recovered.

3. **Durable command journal** — `src/control/journal.ts`
   - `ControlJournal.open()`: single-writer NDJSON at `.psyche/runtime/events.ndjson`;
     verifies contiguous sequences and owner epochs; truncates exactly one
     incomplete final line; throws `journal corruption at line N` for any earlier
     malformed line; rebuilds the idempotency index from terminal command events.
   - `append()`: serialized behind one global promise tail so concurrent pane
     queues cannot reorder sequence assignment or file writes; `fsync` per write.
   - `read()`, `findByIdempotencyKey()`, `loadSnapshot()`, `writeSnapshot()`
     (atomic temp-file rename with `coveredSequence`), and
     `recoverNonterminalCommands()` (appends `command.unknown` for every restored
     non-terminal mutation before new commands are accepted).

4. **Lane leases + scope validation** — `src/control/leases.ts`,
   `src/control/scope.ts`
   - `LaneLeaseStore`: per-pane automation leases (`delegate`) and explicit human
     takeover (`takeover`), each bumping a monotonic revision. `assertAutomation`
     and `assertHuman` reject stale revisions (`lease revision mismatch`), wrong
     actor (`lane is controlled by another actor`), and expiry (`lease expired`).
     A human takeover invalidates any prior Psyche automation lease on that lane.
   - `ControlScope.create()`: `realpath`-resolves every path; accepts only the
     canonical project root or a registered worktree contained by it; rejects
     `..`, absolute cross-project paths, and symlink escapes
     (`outside the canonical project`); requires pane/session ids registered to
     the canonical project (`pane is not owned`).

5. **No-replay prompt dispatch** — `src/control/promptDispatch.ts` (module only)
   - `PromptDispatcher.dispatch()`: verifies the prompt `contentHash` against a
     recomputed SHA-256 of the UTF-8 body (`prompt_hash_mismatch` on mismatch);
     dispatches at most once per runtime invocation; maps ambiguous tmux
     acceptance to `status: 'unknown'` (`prompt_dispatch_ambiguous`) rather than a
     silent retry, and other send failures to `status: 'failed'`
     (`prompt_dispatch_failed`).

### Explicitly out of scope for this PR

- The parent plan's **Task 5, Step 4** — modifying `src/daemon/tmuxControl.ts`
  (and its test) to perform exact prompt submission. That is a live-code change
  and is **deferred to the wiring PR** to keep this slice behavior-neutral. This
  PR ships only the pure `promptDispatch.ts` module and its unit test.
- `runtime.ts`, `server.ts`, `client.ts`, `host.ts`, `hostProcess.ts`.
- All `resources/*` adapters, `credentials.ts`, `endpoint.ts`.
- Any rewire of daemon v0, the bridge, MCP, hooks, or the TUI. No changes under
  `src/daemon/`, `src/mcp/`, `src/services/bridge/`, or `src/hooks/`.
- The Psyche model loop, coding-task completion, LLM attention summaries, cloud
  relay, merge automation, and new autonomy profiles (all Program B+).

## Architecture

Each module is a leaf with one clear purpose, a small typed interface, and no
dependency on unfinished parts of the runtime. Dependency direction:

```
types.ts  <-- protocol.ts
types.ts  <-- promptDispatch.ts
projectIdentity.ts  <-- ownerLock.ts
projectIdentity.ts  <-- journal.ts (path derivation)
projectIdentity.ts  <-- scope.ts (canonical containment)
(leases.ts is self-contained)
```

- **types.ts** — the shared vocabulary. No logic, no I/O. Imports
  `OrchestrationTaskRequest` from the existing `src/orchestration/types.ts` for
  the task-bearing command shape.
- **protocol.ts** — pure codec over `types.ts`. Deterministic encode, validated
  decode. No I/O beyond the caller-supplied string.
- **projectIdentity.ts** — the single canonicalization primitive. One async
  function.
- **ownerLock.ts** — the only writer of `.psyche/runtime/owner.lock`. Owns epoch
  monotonicity and fail-closed semantics.
- **journal.ts** — the only writer of `.psyche/runtime/events.ndjson` and
  `snapshot.json`. Single-writer discipline enforced by an internal promise tail.
- **leases.ts** — in-memory lane authority. Deterministic via an injectable
  clock.
- **scope.ts** — path/pane/session containment gate. Read-only fs access
  (`realpath`) for validation.
- **promptDispatch.ts** — pure dispatch-outcome mapper over an injected `send`
  function; hashing is the only computation it owns.

### Data flow (as consumed by later PRs, not wired here)

A command arrives as a versioned envelope → `protocol.decodeControlRequest`
validates it → `scope` validates its paths/panes against the canonical project →
`leases` asserts the actor holds the lane → `journal.append` records the request →
the side effect runs → `journal.append` records the terminal result →
`protocol.encodeControlMessage` returns the result. `promptDispatch` is the
side-effect adapter for prompt-bearing commands. In this PR these modules are
proven independently; the orchestrating `runtime.ts` that chains them is a later
task.

## Error handling

- **Fail closed on ownership:** a second live owner is rejected, never allowed to
  co-write.
- **Fail closed on corruption:** malformed journal lines before the final line
  abort `open()`; only a single trailing partial line is recoverable.
- **Fail closed on scope:** any path that cannot be proven contained is rejected.
- **Fail closed on leases:** stale revision, wrong actor, or expiry all throw.
- **No silent replay:** ambiguous prompt dispatch surfaces as `unknown`, leaving
  the resolution decision to the (later) runtime rather than retrying blindly.

## Testing

TDD per the parent plan: each module ships with a failing test first, then the
implementation. New test files (all under `__tests__/`):

- `controlProtocol.test.ts` — fixture decode, version rejection, stable encode.
- `controlProjectIdentity.test.ts` — symlink alias → one canonical root.
- `controlOwnerLock.test.ts` — second live owner rejected; epoch increment after
  dead owner; single winner among concurrent contenders; provisional-lock
  recovery.
- `controlJournal.test.ts` — monotonic sequence + idempotency restore; trailing
  partial-line truncation; mid-file corruption rejection.
- `controlLeases.test.ts` — revision bump + stale automation rejection;
  human input allowed after takeover.
- `controlScope.test.ts` — cross-project and symlink-escape rejection; owned vs
  unowned pane.
- `controlPromptDispatch.test.ts` — dispatch once; ambiguous → `unknown`.

Fixtures: `protocol-fixtures/control-v1/command-submit.json`,
`protocol-fixtures/control-v1/command-result.json`.

Full validation before the PR opens: `pnpm typecheck`, the full test suite, and
`pnpm build`, plus the focused control tests above. `pnpm smoke` must stay green.

## Acceptance criteria

- Single-owner fencing: a second live owner fails closed.
- Epoch monotonicity: replacing a dead owner increments the epoch; exactly one
  contender wins a stale-lock race.
- Journal idempotency: duplicate idempotency keys resolve to the original
  terminal result; corruption before the final line aborts open.
- No-replay dispatch: a valid prompt dispatches once; ambiguous acceptance maps
  to `unknown`.
- Zero behavior change: no daemon/bridge/MCP/TUI/cockpit file is modified; the
  cockpit, `pnpm smoke`, and the full suite behave exactly as on `main`.
- `pnpm typecheck`, the full test suite, and `pnpm build` are green.

## Commit discipline

One commit per parent-plan task (Tasks 1–5), each with the message from the plan
and the required trailer:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## After this PR

Once merged, the writing-plans workflow produces the wiring plan for Program A
Tasks 6–11 (`runtime.ts`, `server.ts`, `client.ts`, `host.ts`, resource
adapters, and the deferred `tmuxControl.ts` exact-submission change), which
integrates these foundation modules into the live host without changing the
Program A scope boundary.
