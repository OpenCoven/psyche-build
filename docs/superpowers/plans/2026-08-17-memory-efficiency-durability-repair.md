# Memory Efficiency Durability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve control-plane idempotency and recovery guarantees while keeping hot runtime state bounded, and reclaim closed-pane buffers after their final subscriber releases them.

**Architecture:** `ControlJournal` owns an atomic hash-addressed exact-outcome
store with bounded existing-file reads plus snapshot recovery metadata;
`ControlRuntime` keeps its 1,000-entry hot cache, remembers dirty terminal
outcomes immediately, and replays durable results before consuming
fresh-execution capacity. Journal snapshots carry the at-most-256 unresolved
transactions across compaction, while `BridgeDaemon` tracks unpublished
streamed panes as retired until the final stream or subscription detaches.

**Tech Stack:** TypeScript, Node.js filesystem promises and crypto, Vitest, NDJSON control journal, WebSocket bridge runtime.

---

## File Map

- Modify `src/control/journal.ts`: durable outcome sidecar storage, open-transaction snapshot schema, strict parsing, and snapshot-aware recovery.
- Modify `src/control/runtime.ts`: asynchronous cold outcome lookup, terminal outcome persistence, and compaction of unresolved transactions.
- Modify `src/services/bridge/BridgeDaemon.ts`: retired-pane ownership and final-release reclamation.
- Modify `__tests__/controlRuntime.test.ts`: hot-cache eviction still deduplicates.
- Modify `__tests__/controlJournal.test.ts`: outcome-store and open-transaction parsing/recovery.
- Modify `__tests__/controlJournalCompaction.test.ts`: restart deduplication and unresolved-command recovery across compaction.
- Modify `__tests__/bridge/bridgeTerminalStreams.test.ts`: final stream/session release and multiple-subscriber behavior.
- Modify `__tests__/bridge/BridgeDaemon.test.ts`: legacy unsubscribe releases retired buffers.
- Modify `docs/CONTROL-PLANE.md`: durable idempotency and unresolved snapshot semantics.
- Modify `docs/AGENT-SURFACE-CONTROL.md`: durable retry behavior.
- Modify `docs/BRIDGE-SECURITY.md`: bounded pane-buffer lifecycle.

### Task 1: Make idempotency durable beyond the hot cache

**Files:**
- Modify: `src/control/journal.ts`
- Modify: `src/control/runtime.ts:100-340,1520-1615`
- Test: `__tests__/controlJournal.test.ts`
- Test: `__tests__/controlRuntime.test.ts`
- Test: `__tests__/controlJournalCompaction.test.ts`
- Modify: `docs/CONTROL-PLANE.md`
- Modify: `docs/AGENT-SURFACE-CONTROL.md`

- [ ] **Step 1: Write failing durable-outcome tests**

Add journal tests that:

- store and reload an exact outcome for a separator-heavy Unicode key from the
  hashed sidecar path;
- return `undefined` only for a missing sidecar;
- reject malformed JSON, original-key mismatch, invalid outcome shape, and
  oversized serialized records;
- verify the outcomes directory is `0700`, each sidecar file is `0600`, and an
  oversized existing sidecar written directly to disk is rejected by
  `loadOutcome()` with the explicit durable-outcome size error.

Replace the compaction regression that expected re-execution outside the
retained window with one that evicts an old key from the hot cache, compacts,
restarts, and proves the exact prior outcome still replays from the retained
tail or sidecar without new durable-key events.

Use a real `ControlJournal` in runtime tests and add regressions that prove:

- one pending promise is installed before async cold lookup so concurrent
  identical retries do not race into duplicate execution;
- a sidecar write failure surfaces immediately, but the exact outcome remains
  replayable from hot/dirty state and compaction waits until persistence
  recovers;
- recovery-generated `command.unknown` outcomes are written to the same exact
  sidecar path before later compaction may cover them;
- a retained surface terminal event without its exact sidecar fails closed
  instead of reconstructing an approximate result from redacted journal data;
- an old durable key still replays when 256 unrelated fresh executions already
  occupy the pending-command capacity.

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: FAIL because `ControlJournal.loadOutcome` and `storeOutcome` do not
exist, exact sidecar validation is absent, and evicted retries still either
re-execute or hit capacity before durable replay.

- [ ] **Step 3: Add the atomic hash-addressed outcome store**

In `src/control/journal.ts`, add `.psyche/runtime/outcomes/<sha256(idempotencyKey)>`
beside `snapshot.json`. Persist records as:

```ts
interface DurableOutcomeRecord {
  readonly idempotencyKey: string;
  readonly outcome: CommandOutcome;
}
```

Keep filenames hash-addressed so raw keys cannot escape the directory, but
store the original key inside each record so collisions or mismatches are
detected explicitly.

Add an explicit serialized ceiling,
`DURABLE_OUTCOME_RECORD_MAX_BYTES` (`8_781_824` bytes), derived from the
existing control-surface size bounds. `loadOutcome()` must open the hashed
path, inspect its size through the handle, and read at most
`DURABLE_OUTCOME_RECORD_MAX_BYTES + 1` bytes before parsing so oversized
existing files reject explicitly without an unbounded allocation.
`loadOutcome()` returns `undefined` only for `ENOENT`; malformed JSON, key
mismatch, invalid `CommandOutcome` shape, or oversized files throw.

`storeOutcome()` creates or repairs the outcomes directory with `0700`
permissions, writes through a unique same-directory temporary file with mode
`0600`, fsyncs, closes, and atomically renames. Extend `CompactableJournal`
and `asCompactable` with required `loadOutcome()` / `storeOutcome()` methods.

- [ ] **Step 4: Serialize cold lookup with pending-command deduplication**

Keep `submit()` synchronous in shape, but install one promise in
`pendingByIdempotencyKey` before any async cold lookup so concurrent identical
submissions deduplicate through retained-tail lookup, sidecar replay, and any
later fresh execution.

On a hot miss, the lookup order is:

1. exact hot-cache replay;
2. exact dirty in-memory replay from a prior terminal write failure;
3. same-key pending promise;
4. retained terminal journal tail;
5. durable exact sidecar; then
6. fresh execution.

Only step 6 consumes the bounded `AGENT_CONTROL_LIMITS.pendingCommands`
capacity. Track actual fresh executions separately from lookup bookkeeping so a
durable retry can still replay while 256 unrelated fresh executions are
running.

After each terminal journal append, remember the exact outcome immediately in
the hot cache and dirty replay state, then attempt
`storeOutcome(idempotencyKey, outcome)`. If the sidecar write fails, surface
that durability error, but keep the outcome replayable and leave compaction
blocked until the same key has authoritative durable replay data. Startup must
persist recovery-generated `command.unknown` outcomes through the same exact
sidecar path. Retained surface terminal events never reconstruct from redacted
journal payloads; if their exact sidecar is missing, fail closed instead of
approximating the prior result.

- [ ] **Step 5: Run focused tests and update contract documentation**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: PASS.

Update `docs/CONTROL-PLANE.md` and `docs/AGENT-SURFACE-CONTROL.md` to state that
the 1,000-entry map is only a hot cache, exact sidecars remain authoritative,
serialized outcomes are size-bounded, retained surface terminals require their
exact sidecars, durable replay happens before fresh-execution capacity checks,
and lookup/storage failures fail closed.

- [ ] **Step 6: Commit durable idempotency**

```bash
git add src/control/journal.ts src/control/runtime.ts \
  __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts \
  __tests__/controlJournalCompaction.test.ts \
  docs/CONTROL-PLANE.md docs/AGENT-SURFACE-CONTROL.md
git commit -m "fix: preserve durable command idempotency" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Preserve unresolved commands through journal compaction

**Files:**
- Modify: `src/control/journal.ts:170-470`
- Modify: `src/control/runtime.ts:279-302,1636-1655,2250-2340`
- Test: `__tests__/controlJournal.test.ts`
- Test: `__tests__/controlJournalCompaction.test.ts`
- Modify: `docs/CONTROL-PLANE.md`

- [ ] **Step 1: Write failing compaction recovery tests**

Add this test to `controlJournalCompaction.test.ts`, reusing its existing
`makeHandlers`, `newRoot`, and `ControlRuntime` setup:

```ts
it('recovers a requested command compacted into the snapshot exactly once', async () => {
  const root = await newRoot();
  const journal = await ControlJournal.open(root, 4);
  const runtime = await ControlRuntime.create({
    ownerEpoch: 4,
    handlers: makeHandlers(),
    journal,
  });
  const requested = await journal.append('command.requested', {
    commandId: 'cmd-open',
    idempotencyKey: 'idem-open',
  });
  await journal.writeSnapshot({
    snapshot: runtime.snapshot(),
    coveredSequence: requested.sequence,
    outcomes: {},
    receiptRecords: [],
    openTransactions: [{
      sequence: requested.sequence,
      commandId: 'cmd-open',
      idempotencyKey: 'idem-open',
      kind: 'command.requested',
    }],
  });
  await journal.compact(requested.sequence);

  const reopened = await ControlJournal.open(root, 5);
  const snapshot = await reopened.loadSnapshot();
  await reopened.recoverNonterminalCommands(snapshot?.openTransactions);
  await reopened.recoverNonterminalCommands(snapshot?.openTransactions);

  expect(reopened.read(0).filter((event) => event.kind === 'command.unknown')).toHaveLength(1);
});
```

Also test that a terminal tail event removes the snapshot record and that
transactions sharing a command ID but using different idempotency keys remain
independent.

- [ ] **Step 2: Run tests and verify recovery loses compacted requests**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: FAIL because snapshots have no `openTransactions` and recovery reads
only retained events.

- [ ] **Step 3: Add the bounded open-transaction snapshot schema**

In `src/control/journal.ts` add:

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

Add `openTransactions: DurableOpenTransaction[]` to `JournalSnapshotFile`.
`loadSnapshot()` must default an absent field to `[]` for pre-repair snapshots,
but throw `invalid control journal snapshot open transaction` if a present
entry lacks an integer positive sequence, non-empty command/idempotency key, or
allowed kind.

Change the journal interface to:

```ts
recoverNonterminalCommands(
  restored?: readonly DurableOpenTransaction[],
): Promise<RuntimeEvent[]>;
```

- [ ] **Step 4: Merge snapshot transactions with the retained tail**

Add a helper used by both compaction and recovery:

```ts
const OPEN_COMMAND_KINDS = new Set<DurableOpenTransactionKind>([
  'command.requested',
  'command.accepted',
  'command.running',
]);
const TERMINAL_COMMAND_KINDS = new Set([
  'command.succeeded',
  'command.failed',
  'command.unknown',
  'command.rejected',
]);

function reduceOpenTransactions(
  restored: readonly DurableOpenTransaction[],
  events: readonly ControlEvent[],
): DurableOpenTransaction[] {
  const open = new Map<string, DurableOpenTransaction>();
  for (const record of restored) {
    open.set(commandTransactionKey(record.commandId, record.idempotencyKey), record);
  }
  for (const event of events) {
    const commandId = typeof event.payload.commandId === 'string'
      ? event.payload.commandId
      : undefined;
    const idempotencyKey = typeof event.payload.idempotencyKey === 'string'
      ? event.payload.idempotencyKey
      : undefined;
    if (!commandId || !idempotencyKey) continue;
    const key = commandTransactionKey(commandId, idempotencyKey);
    if (TERMINAL_COMMAND_KINDS.has(event.kind)) open.delete(key);
    else if (OPEN_COMMAND_KINDS.has(event.kind)) {
      open.set(key, {
        sequence: event.sequence,
        commandId,
        idempotencyKey,
        kind: event.kind as DurableOpenTransactionKind,
      });
    }
  }
  return [...open.values()].sort((left, right) => left.sequence - right.sequence);
}
```

In `ControlRuntime.create`, load the snapshot before recovery:

```ts
const compactable = asCompactable(opts.journal);
const snapshot = await compactable?.loadSnapshot();
await opts.journal.recoverNonterminalCommands(snapshot?.openTransactions);
const runtime = new ControlRuntime(opts.ownerEpoch, opts.handlers, opts.journal, opts);
```

Remove the later duplicate snapshot load.

In `compactJournal`, compute only through the cutoff:

```ts
const prefix = journal.read(previous?.coveredSequence ?? 0)
  .filter((event) => event.sequence <= coveredSequence);
const openTransactions = reduceOpenTransactions(
  previous?.openTransactions ?? [],
  prefix,
);
```

Write `openTransactions` with the snapshot. Recovery calls
`reduceOpenTransactions(restored, this.events)` and appends one
`command.unknown` per remaining record. Before appending, re-check the current
tail so calling recovery twice cannot duplicate terminal events.

- [ ] **Step 5: Run recovery tests and document the snapshot invariant**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: PASS.

Update `docs/CONTROL-PLANE.md` to state that compaction snapshots retain all
unresolved transactions, bounded by the 256 pending-command cap, and startup
terminalizes them as `command.unknown` before accepting commands.

- [ ] **Step 6: Commit unresolved-transaction durability**

```bash
git add src/control/journal.ts src/control/runtime.ts \
  __tests__/controlJournal.test.ts __tests__/controlJournalCompaction.test.ts \
  docs/CONTROL-PLANE.md
git commit -m "fix: retain unresolved commands through compaction" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Release retired pane buffers after final detach

**Files:**
- Modify: `src/services/bridge/BridgeDaemon.ts:450-490,781-885`
- Test: `__tests__/bridge/bridgeTerminalStreams.test.ts`
- Test: `__tests__/bridge/BridgeDaemon.test.ts`
- Modify: `docs/BRIDGE-SECURITY.md`

- [ ] **Step 1: Write failing stream-lifecycle tests**

Extend `bridgeTerminalStreams.test.ts`:

```ts
it('releases a retired pane after its final control stream detaches', async () => {
  const { daemon, hub } = createDaemon();
  const session = createSession();
  install(daemon, [session]);
  hub.bufferFor(PUBLISHED_PANE).write(Buffer.from('output\n'));
  const attached = await attach(daemon, session);
  dropPaneFromWorkspace(daemon, PUBLISHED_PANE);
  await (daemon as any).broadcastWorkspaceChanged();

  await control(daemon, session, {
    type: 'panes.detach',
    requestId: 'detach-retired',
    streamId: attached.streamId,
  });

  expect(hub.bufferedPaneIds()).not.toContain(PUBLISHED_PANE);
});
```

Add tests for two streams where the first detach retains the buffer and the
second releases it, session close releasing a retired pane, a legacy
`unsubscribePane` releasing the final subscription, and republishing a retired
pane before detach preserving its buffer.

- [ ] **Step 2: Run bridge tests and verify buffers remain**

Run:

```bash
pnpm vitest --run __tests__/bridge/bridgeTerminalStreams.test.ts __tests__/bridge/BridgeDaemon.test.ts
```

Expected: FAIL because teardown removes subscriptions but never calls
`forgetPane`.

- [ ] **Step 3: Track retirement and centralize final-release cleanup**

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

Change `reclaimClosedPaneBuffers`:

```ts
for (const paneId of this.hub.bufferedPaneIds()) {
  if (hasPublishedTmuxBackedPane(workspace, paneId)) {
    this.retiredPaneIds.delete(paneId);
    continue;
  }
  if (this.isPaneStreamed(paneId)) {
    this.retiredPaneIds.add(paneId);
    continue;
  }
  this.hub.forgetPane(paneId);
  this.retiredPaneIds.delete(paneId);
  this.paneSubscribers.delete(paneId);
}
```

After deleting a control stream in `detachPaneStream`, call
`releaseRetiredPaneIfUnused(stream.paneId)`. In `unsubscribePane`, call it
after `dropPaneSubscriber`. In `onSessionClose`, collect all stream and legacy
subscription pane IDs before clearing them, then call the helper once per
collected ID after all teardown maps and subscriber sets are updated.

- [ ] **Step 4: Run bridge tests and update resource-bounding documentation**

Run:

```bash
pnpm vitest --run __tests__/bridge/bridgeTerminalStreams.test.ts __tests__/bridge/BridgeDaemon.test.ts
```

Expected: PASS.

Update `docs/BRIDGE-SECURITY.md` to state that each pane buffer is capped, a
closed pane may remain while streamed, and final stream/subscription release
reclaims it deterministically.

- [ ] **Step 5: Commit pane-buffer lifecycle repair**

```bash
git add src/services/bridge/BridgeDaemon.ts \
  __tests__/bridge/bridgeTerminalStreams.test.ts \
  __tests__/bridge/BridgeDaemon.test.ts docs/BRIDGE-SECURITY.md
git commit -m "fix: release retired pane buffers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Validate and publish the repaired PR

**Files:**
- Verify all files modified by Tasks 1-3.

- [ ] **Step 1: Run formatting and focused tests**

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
```

Expected: formatting check and all focused tests PASS.

- [ ] **Step 2: Run complete non-generating TypeScript validation**

```bash
pnpm --filter @opencoven/psyche-vim-core typecheck \
  && pnpm exec tsc --noEmit \
  && pnpm run typecheck:tests
```

Expected: all three commands exit successfully.

- [ ] **Step 3: Review the final branch delta**

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, a clean worktree, and only the PR plus repair
commits.

- [ ] **Step 4: Push and wait for the complete PR matrix**

```bash
git push origin perf/memory-efficiency
gh pr checks 165 --repo OpenCoven/psyche-build --watch --interval 10
```

Expected: TypeScript/Rust, macOS, Windows, Ubuntu, iOS, and Vercel all PASS.

- [ ] **Step 5: Obtain required approval or explicit administrator override, merge, and clean up**

After the final review confirms no findings, merge through GitHub using the
repository-required approval. Use `--admin` only after explicit user approval.
Then fetch/prune, fast-forward `main`, remove this worktree, delete the local
branch, and verify there are no remaining open PRs.
