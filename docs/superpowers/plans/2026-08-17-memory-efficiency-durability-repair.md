# Memory Efficiency Durability Repair Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task by task.

**Goal:** Preserve idempotency and recovery while bounding exact outcomes, and
release retired pane buffers after their final subscriber.

**Architecture:** `ControlJournal` owns an atomic hash-addressed exact
`CommandOutcome` sidecar store plus snapshot recovery metadata. `ControlRuntime`
keeps exact outcomes in its bounded 1,000-entry hot cache, tracks dirty exact
outcomes in-process for immediate replay, persists recovery-generated
`command.unknown` outcomes back into the same sidecar path, and forbids
compaction from covering a terminal event until its exact sidecar is durable.
New compaction writes leave the legacy top-level `outcomes` snapshot field
empty while future Task 2 still adds the bounded unresolved-transaction
records. `BridgeDaemon` tracks unpublished streamed panes as retired until the
final stream or subscription detaches.

## File Map

- `src/control/journal.ts`: exact bounded outcome sidecars, strict parsing,
  size and permission validation, and snapshot compatibility.
- `src/control/runtime.ts`: asynchronous cold lookup, dirty exact replay,
  recovery-unknown persistence, surface fail-closed fallback, and compaction
  gating.
- `src/services/bridge/BridgeDaemon.ts`: retired pane ownership.
- `__tests__/controlJournal.test.ts`: exact sidecar hashing, permissions, size
  bounds, and strict parsing.
- `__tests__/controlRuntime.test.ts`: hot-cache eviction deduplication, dirty
  replay, retained-recovery persistence, and missing-sidecar fail-closed
  behavior.
- `__tests__/controlJournalCompaction.test.ts`: restart deduplication after
  eviction and compaction, plus unresolved-command recovery.
- Bridge stream tests and the three related contract documents.

## Task 1: Make exact outcome sidecars gate terminal compaction

### Step 1: Write failing exact-sidecar journal tests

Add journal tests for a separator-heavy Unicode idempotency key that round-trip
through `storeOutcome()` and `loadOutcome()`. Verify the sidecar path is
`.psyche/runtime/outcomes/<sha256(idempotencyKey)>`, the outcomes directory is
`0700`, the final sidecar file is `0600`, and a missing key returns
`undefined`.

Add failing coverage for malformed JSON, original-key mismatch, invalid
`CommandOutcome` shape, and a serialized record larger than
`DURABLE_OUTCOME_RECORD_MAX_BYTES` (`8_781_824` bytes). Those cases must throw
explicitly rather than becoming cache misses.

### Step 2: Write failing runtime durability regressions

In `controlRuntime.test.ts`, add regressions proving:

- a key evicted from the 1,000-entry hot cache still deduplicates from its
  exact sidecar after more than 1,000 later keys;
- a `storeOutcome()` failure after terminal append leaves the exact outcome
  immediately replayable from in-process dirty state, and later compaction may
  not cover that sequence until persistence recovers;
- startup persists a recovery-generated `command.unknown` exact sidecar for a
  retained nonterminal crash-window command; and
- a retained surface terminal event with no exact sidecar fails closed instead
  of reconstructing a generic outcome from redacted journal data.

Keep `controlJournalCompaction.test.ts` focused on the restart and compaction
path: a key older than the hot window must still deduplicate exactly after
compaction and restart.

### Step 3: Run the focused tests and verify the new assertions fail

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: FAIL because exact sidecars, dirty replay, recovery persistence, and
surface fail-closed lookup are not wired yet.

### Step 4: Add the atomic hash-addressed exact outcome store

In `src/control/journal.ts`, add a sidecar directory beside `snapshot.json`
called `outcomes`. Filenames are `sha256(idempotencyKey)` so keys cannot escape
the directory, but each JSON payload still stores both the original
`idempotencyKey` and the exact `CommandOutcome` for collision detection and
replay.

Add `loadOutcome(key): Promise<CommandOutcome | undefined>` and
`storeOutcome(key, outcome): Promise<void>` to both `ControlJournal` and
`CompactableJournal`, and require them in `asCompactable()`.

`storeOutcome()` must:

- create or repair the outcomes directory with `0700` permissions;
- reject any serialized record larger than `DURABLE_OUTCOME_RECORD_MAX_BYTES`
  (`8_781_824` bytes);
- write through a unique temporary file opened with `0600`;
- `fsync()` and close the handle; and
- atomically rename into place.

`loadOutcome()` must return `undefined` only for `ENOENT`. JSON corruption,
key mismatch/hash collision, invalid exact-outcome shape, or an oversized file
must throw explicitly.

### Step 5: Serialize cold lookup and fail closed on unsafe surface fallback

Keep `submit()` returning a `Promise`, but install one pending promise in
`pendingByIdempotencyKey` before awaiting any I/O. The cold path should check
sources in this order:

1. bounded hot exact-outcome cache;
2. dirty in-process exact replay for a just-appended terminal outcome;
3. existing `pendingByIdempotencyKey` entry;
4. retained terminal journal tail;
5. durable exact sidecar; then
6. fresh execution.

Retained non-surface terminal events may reconstruct from complete journal
payloads while they remain retained. Retained surface terminal events are
redacted, so they must load an exact sidecar or fail closed. Any authoritative
hit should repopulate the hot cache before returning.

### Step 6: Publish terminal outcomes crash-safely

For both surface and non-surface terminal paths, enforce this order:

1. append and fsync the terminal journal event;
2. remember the exact outcome in the bounded hot cache immediately;
3. record `{ idempotencyKey, sequence, outcome? }` in `dirtyTerminalOutcomes`;
4. attempt `storeOutcome()`; and
5. clear the dirty entry only after the matching sidecar write succeeds.

If the exact sidecar write fails, surface that error to the caller, but keep the
exact outcome dirty in memory so the next identical retry returns the real prior
result without executing again. Recovery-generated `command.unknown` outcomes
must be persisted through the same exact-sidecar path.

### Step 7: Block compaction until exact sidecars are durable

At startup, retained terminal events should populate hot cache entries from
exact sidecars when available and mark missing sidecars dirty. Before
compaction covers any sequence, call `flushDirtyTerminalOutcomesThrough()` for
that cutoff. If any covered key still lacks authoritative durable replay data,
return early and keep the retained journal event in place.

New compaction writes should also leave the legacy top-level snapshot
`outcomes` field empty. Exact replay is now owned by the sidecars; Task 2 still
adds bounded `openTransactions` without reintroducing exact outcomes as the
authoritative durable source.

### Step 8: Validate Task 1 and update contract docs

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
pnpm run typecheck:tests
```

Update `docs/CONTROL-PLANE.md` and `docs/AGENT-SURFACE-CONTROL.md` to state:

- exact terminal outcomes are durable in bounded-size sidecars and hot only in
  the 1,000-entry cache;
- sidecars use hash-addressed filenames, `0700` directories, and `0600` files;
- a sidecar write failure leaves immediate dirty exact replay available and
  blocks later compaction from covering that terminal key;
- startup persists recovery-generated `command.unknown` exact outcomes; and
- surface retries fail closed when the retained journal tail exists but the
  exact sidecar is missing.

### Step 9: Commit durable exact-outcome idempotency

```bash
git add src/control/journal.ts src/control/runtime.ts \
  __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts \
  __tests__/controlJournalCompaction.test.ts \
  docs/CONTROL-PLANE.md docs/AGENT-SURFACE-CONTROL.md
git commit -m "fix: preserve durable command idempotency" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Preserve unresolved commands through compaction

Add:

```ts
export type DurableOpenTransactionKind =
  | 'command.requested'
  | 'command.accepted'
  | 'command.running';

export interface DurableOpenTransaction {
  readonly sequence: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly kind: DurableOpenTransactionKind;
}
```

Absent `openTransactions` loads as `[]`. Present records require a positive
integer sequence, nonempty IDs, and an allowed kind.

Change both journal interfaces to:

```ts
recoverNonterminalCommands(
  restored?: readonly DurableOpenTransaction[],
): Promise<RuntimeEvent[]>;
```

Load the snapshot before recovery:

```ts
const compactable = asCompactable(opts.journal);
const snapshot = await compactable?.loadSnapshot();
await opts.journal.recoverNonterminalCommands(snapshot?.openTransactions);
const runtime = new ControlRuntime(opts.ownerEpoch, opts.handlers, opts.journal, opts);
```

Reduce the prior snapshot and retained tail by `(commandId, idempotencyKey)`.
Terminal tail events remove open records. Recovery rechecks the current tail
before appending, so repeated calls add at most one `command.unknown`.

Task 1 now leaves the legacy top-level snapshot `outcomes` field empty and uses
exact sidecars for durable replay; do not reintroduce exact outcomes as the
authoritative durable source or copy command envelopes here. Recovery-generated
terminals must continue through the same exact-sidecar path before any later
compaction may cover them.

Tests cover a compacted request recovering once, terminal tail precedence,
same command ID with different keys, invalid records, and durable sidecar
publication for the recovery-generated terminal.

```bash
pnpm vitest --run \
  __tests__/controlJournal.test.ts \
  __tests__/controlJournalCompaction.test.ts
pnpm run typecheck:tests
```

## Task 3: Release retired pane buffers

Add bridge regressions for final control detach, two subscribers, session
close, legacy unsubscribe, and republishing before release.

Add:

```ts
private readonly retiredPaneIds = new Set<string>();

private releaseRetiredPaneIfUnused(paneId: string): void {
  if (!this.retiredPaneIds.has(paneId) || this.isPaneStreamed(paneId)) return;
  this.hub?.forgetPane(paneId);
  this.retiredPaneIds.delete(paneId);
  this.paneSubscribers.delete(paneId);
}
```

Published panes clear retirement. Unpublished streamed panes become retired.
Unpublished unstreamed panes are forgotten immediately. Detach, unsubscribe,
and session close call the helper after removing all references.

```bash
pnpm vitest --run \
  __tests__/bridge/bridgeTerminalStreams.test.ts \
  __tests__/bridge/BridgeDaemon.test.ts
```

Update `docs/BRIDGE-SECURITY.md`.

## Task 4: Validate without publishing

```bash
pnpm exec prettier --check \
  src/control/journal.ts src/control/runtime.ts \
  src/services/bridge/BridgeDaemon.ts \
  __tests__/controlJournal.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlJournalCompaction.test.ts \
  __tests__/bridge/bridgeTerminalStreams.test.ts \
  __tests__/bridge/BridgeDaemon.test.ts \
  docs/CONTROL-PLANE.md docs/AGENT-SURFACE-CONTROL.md docs/BRIDGE-SECURITY.md
pnpm vitest --run \
  __tests__/controlJournal.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlJournalCompaction.test.ts \
  __tests__/bridge/bridgeTerminalStreams.test.ts \
  __tests__/bridge/BridgeDaemon.test.ts
pnpm --filter @opencoven/psyche-vim-core typecheck \
  && pnpm exec tsc --noEmit \
  && pnpm run typecheck:tests
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Do not push or merge from this plan. Publish only after human review.
