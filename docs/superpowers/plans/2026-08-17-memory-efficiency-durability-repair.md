# Memory Efficiency Durability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve control-plane idempotency and recovery guarantees while keeping hot runtime state bounded, and reclaim closed-pane buffers after their final subscriber releases them.

**Architecture:** `ControlJournal` owns an atomic hash-addressed outcome store and snapshot recovery metadata; `ControlRuntime` keeps its 1,000-entry hot cache but consults durable outcomes before execution. Journal snapshots carry the at-most-256 unresolved transactions across compaction, while `BridgeDaemon` tracks unpublished streamed panes as retired until the final stream or subscription detaches.

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

Add journal tests that store and reload an outcome under a key containing path
separators and Unicode, verify the original key is checked after hashing, and
verify malformed sidecar JSON rejects rather than returning `undefined`.

```ts
it('stores outcomes by hashed idempotency key and reloads them', async () => {
  const root = await newRoot();
  const journal = await ControlJournal.open(root, 4);
  const outcome = { status: 'succeeded', value: { revision: 7 } } as const;

  await journal.storeOutcome('../retry/λ', outcome);

  expect(await journal.loadOutcome('../retry/λ')).toEqual(outcome);
  expect(await journal.loadOutcome('../retry/other')).toBeUndefined();
});
```

Replace the compaction test named
`re-executes a key that fell outside the retained window` with a test that
submits `idem-dropped`, writes enough later outcomes to evict it from the hot
map, compacts, restarts, and asserts the old outcome is returned without a new
journal sequence.

Add `mkdtemp`/`rm`, `tmpdir`, `path`, and `ControlJournal` imports to
`controlRuntime.test.ts`, then use the real durable journal:

```ts
it('checks durable outcomes after the hot idempotency window evicts a key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-runtime-idempotency-'));
  try {
    const journal = await ControlJournal.open(root, 4);
    const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });
    const first = await runtime.submit(command({
      id: 'old-key',
      idempotencyKey: 'old-key',
    }) as ControlCommand);
    for (let index = 0; index <= 1_000; index += 1) {
      await runtime.submit(command({
        id: `new-key-${index}`,
        idempotencyKey: `new-key-${index}`,
      }) as ControlCommand);
    }
    const sequenceBefore = journal.sequence;

    expect(await runtime.submit(command({
      id: 'old-key-retry',
      idempotencyKey: 'old-key',
    }) as ControlCommand)).toEqual(first);
    expect(journal.sequence).toBe(sequenceBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: FAIL because `ControlJournal.loadOutcome` and `storeOutcome` do not
exist and an evicted key currently executes again.

- [ ] **Step 3: Add the atomic hash-addressed outcome store**

In `src/control/journal.ts`, add an outcome directory beside `snapshot.json`:

```ts
interface DurableOutcomeRecord {
  readonly idempotencyKey: string;
  readonly outcome: CommandOutcome;
}

function outcomeFileName(idempotencyKey: string): string {
  return `${createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')}.json`;
}
```

Store `outcomesPath` on `ControlJournal`, initialize it as
`path.join(runtimeDir, 'outcomes')`, and add:

```ts
async loadOutcome(idempotencyKey: string): Promise<CommandOutcome | undefined> {
  const file = path.join(this.outcomesPath, outcomeFileName(idempotencyKey));
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<DurableOutcomeRecord>;
  if (parsed.idempotencyKey !== idempotencyKey || !isCommandOutcome(parsed.outcome)) {
    throw new Error(`invalid durable control outcome: ${file}`);
  }
  return parsed.outcome;
}

async storeOutcome(idempotencyKey: string, outcome: CommandOutcome): Promise<void> {
  await mkdir(this.outcomesPath, { recursive: true, mode: 0o700 });
  const target = path.join(this.outcomesPath, outcomeFileName(idempotencyKey));
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ idempotencyKey, outcome }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}
```

Implement `isCommandOutcome` by accepting only the four existing statuses and
their required fields. Do not coerce malformed data or treat it as a cache miss:

```ts
function isCommandOutcome(value: unknown): value is CommandOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (candidate.status === 'succeeded') return true;
  return (
    candidate.status === 'failed'
    || candidate.status === 'unknown'
    || candidate.status === 'rejected'
  ) && typeof candidate.code === 'string'
    && typeof candidate.message === 'string';
}
```

Extend `CompactableJournal` with:

```ts
loadOutcome(idempotencyKey: string): Promise<CommandOutcome | undefined>;
storeOutcome(idempotencyKey: string, outcome: CommandOutcome): Promise<void>;
```

Require these methods in `asCompactable`.

- [ ] **Step 4: Serialize cold lookup with pending-command deduplication**

Keep `submit()` synchronous in shape but place the cold lookup inside the
promise installed in `pendingByIdempotencyKey`:

```ts
submit(command: ControlCommand): Promise<CommandOutcome> {
  this.pruneInactiveResourceQueues();
  const prior = this.outcomesByIdempotencyKey.get(command.idempotencyKey);
  if (prior) return Promise.resolve(prior);

  const pending = this.pendingByIdempotencyKey.get(command.idempotencyKey);
  if (pending) return pending;
  if (this.pendingByIdempotencyKey.size >= AGENT_CONTROL_LIMITS.pendingCommands) {
    return Promise.resolve(rejectedOutcome(
      'runtime_busy',
      'control runtime pending command capacity exceeded',
    ));
  }

  const execution = this.submitAfterDurableLookup(command).finally(() => {
    this.pendingByIdempotencyKey.delete(command.idempotencyKey);
  });
  this.pendingByIdempotencyKey.set(command.idempotencyKey, execution);
  return execution;
}

private async submitAfterDurableLookup(command: ControlCommand): Promise<CommandOutcome> {
  const tail = this.journal.findByIdempotencyKey(command.idempotencyKey);
  if (tail && TERMINAL_EVENT_KINDS.has(tail.kind)) {
    const outcome = outcomeFromEvent(tail);
    this.rememberOutcome(command.idempotencyKey, outcome);
    return outcome;
  }
  const durable = await this.compactable?.loadOutcome(command.idempotencyKey);
  if (durable) {
    this.rememberOutcome(command.idempotencyKey, durable);
    return durable;
  }
  return this.submitFresh(command);
}
```

After each terminal journal append, call
`await this.compactable?.storeOutcome(command.idempotencyKey, outcome)` before
`rememberOutcome`. This keeps terminal journal publication ordered before the
sidecar and makes a sidecar failure explicit. The tail lookup prevents a retry
from executing again if sidecar publication failed after the terminal event.

- [ ] **Step 5: Run focused tests and update contract documentation**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: PASS.

Update `docs/CONTROL-PLANE.md` and `docs/AGENT-SURFACE-CONTROL.md` to state that
the 1,000-entry map is a hot cache, all terminal keys remain authoritative in
the disk-backed store, and lookup/storage errors fail closed.

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
