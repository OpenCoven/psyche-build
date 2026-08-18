# Memory Efficiency Durability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve control-plane idempotency and recovery guarantees while keeping hot runtime state bounded, and reclaim closed-pane buffers after their final subscriber releases them.

**Architecture:** `ControlJournal` owns an atomic hash-addressed completed-key tombstone store plus redacted snapshot recovery metadata. `ControlRuntime` keeps exact outcomes in its bounded 1,000-entry hot cache, tracks tombstone writes in a capped dirty map, and forbids compaction from covering a terminal event until its tombstone is confirmed durable. Journal snapshots carry only redacted state and the at-most-256 unresolved transactions across compaction, while `BridgeDaemon` tracks unpublished streamed panes as retired until the final stream or subscription detaches.

**Tech Stack:** TypeScript, Node.js filesystem promises and crypto, Vitest, NDJSON control journal, WebSocket bridge runtime.

---

## File Map

- Modify `src/control/journal.ts`: durable completed-key tombstones, redacted/open-transaction snapshot schema, strict parsing, and snapshot-aware recovery.
- Modify `src/control/runtime.ts`: asynchronous tombstone lookup, crash-safe terminal ordering, dirty-tombstone retry, compaction gating, and bounded exact outcomes.
- Modify `src/services/bridge/BridgeDaemon.ts`: retired-pane ownership and final-release reclamation.
- Modify `__tests__/controlRuntime.test.ts`: hot-cache eviction still deduplicates.
- Modify `__tests__/controlJournal.test.ts`: tombstone-store, snapshot-redaction, and open-transaction parsing/recovery.
- Modify `__tests__/controlJournalCompaction.test.ts`: tombstone-failure compaction gating, restart deduplication, and unresolved-command recovery.
- Modify `__tests__/bridge/bridgeTerminalStreams.test.ts`: final stream/session release and multiple-subscriber behavior.
- Modify `__tests__/bridge/BridgeDaemon.test.ts`: legacy unsubscribe releases retired buffers.
- Modify `docs/CONTROL-PLANE.md`: durable idempotency and unresolved snapshot semantics.
- Modify `docs/AGENT-SURFACE-CONTROL.md`: durable retry behavior.
- Modify `docs/BRIDGE-SECURITY.md`: bounded pane-buffer lifecycle.

### Task 1: Make completed-key durability gate terminal compaction

**Files:**
- Modify: `src/control/journal.ts`
- Modify: `src/control/runtime.ts:100-340,1520-1680`
- Test: `__tests__/controlJournal.test.ts`
- Test: `__tests__/controlRuntime.test.ts`
- Test: `__tests__/controlJournalCompaction.test.ts`
- Modify: `docs/CONTROL-PLANE.md`
- Modify: `docs/AGENT-SURFACE-CONTROL.md`

- [ ] **Step 1: Write failing compact-tombstone and redaction tests**

Add journal tests for a separator-heavy Unicode idempotency key. Verify the
sidecar filename is the SHA-256 digest, the stored JSON contains only the
schema, digest, and terminal sequence, and neither the raw key nor an exact
outcome sentinel appears on disk:

```ts
it('stores a compact redacted completed-key tombstone', async () => {
  const root = await newRoot();
  const journal = await ControlJournal.open(root, 4);
  const key = '../retry/λ/secret-looking-key';

  await journal.storeCompletedKey(key, 27);

  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  const raw = await readFile(path.join(
    root, '.psyche', 'runtime', 'completed-keys', `${digest}.json`,
  ), 'utf8');
  expect(JSON.parse(raw)).toEqual({
    schema: 'psyche.control.completed-key/v1',
    keyDigest: digest,
    terminalSequence: 27,
  });
  expect(raw).not.toContain(key);
  expect(await journal.hasCompletedKey(key)).toBe(true);
  expect(await journal.hasCompletedKey('../retry/other')).toBe(false);
});
```

Add tests that malformed JSON, a mismatched digest, an invalid schema, and a
non-positive terminal sequence throw rather than becoming cache misses. Add a
snapshot test containing unique command-value, message, typed-value, script,
and raw receipt-resource sentinels; trigger runtime compaction and assert none
appear in `snapshot.json`. The only raw idempotency key allowed in the file is
one inside a bounded `openTransactions` record.

- [ ] **Step 2: Write the failing terminal-ordering and compaction regression**

In `controlRuntime.test.ts`, make tombstone persistence fail for one key after
the handler and terminal append. Assert the original submission still resolves
to the handler's exact successful outcome, the hot retry returns the same
outcome without another effect, and the existing operator-visible error path is
called:

```ts
it('preserves a completed outcome when tombstone persistence fails', async () => {
  const root = await newRoot();
  const journal = await ControlJournal.open(root, 4);
  const effect = vi.fn(async () => ({ paneId: '%7' }));
  handlers.openTerminal = effect;
  vi.spyOn(journal, 'storeCompletedKey').mockRejectedValue(new Error('disk full'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });

  await expect(runtime.submit(openTerminalCommand('idem-dirty')))
    .resolves.toEqual({ status: 'succeeded', value: { paneId: '%7' } });
  await expect(runtime.submit(openTerminalCommand('idem-dirty')))
    .resolves.toEqual({ status: 'succeeded', value: { paneId: '%7' } });
  expect(effect).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining('completed-key durability'),
    expect.any(Error),
  );
});
```

Replace `re-executes a key that fell outside the retained window` in
`controlJournalCompaction.test.ts` with the complete durability regression.
Fail persistence only for `idem-dirty`, allowing later commands to persist
normally:

```ts
it('does not compact a terminal event whose completed key is still dirty', async () => {
  const root = await newRoot();
  const journal = await ControlJournal.open(root, 4);
  const persist = journal.storeCompletedKey.bind(journal);
  let failOriginal = true;
  const store = vi.spyOn(journal, 'storeCompletedKey')
    .mockImplementation(async (key, sequence) => {
      if (key === 'idem-dirty' && failOriginal) throw new Error('injected sidecar failure');
      await persist(key, sequence);
    });
  const effect = vi.fn(async () => ({ applied: true }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const runtime = await ControlRuntime.create({
    ownerEpoch: 4,
    handlers: makeHandlers({ takeover: effect }),
    journal,
  });

  const first = await runtime.submit(takeover('idem-dirty'));
  const terminal = journal.findByIdempotencyKey('idem-dirty');
  expect(terminal?.kind).toBe('command.succeeded');

  for (let index = 0; index < 2_100; index += 1) {
    await runtime.submit(takeover(`idem-later-${index}`));
  }
  await vi.waitFor(() => expect(
    store.mock.calls.filter(([key]) => key === 'idem-dirty').length,
  ).toBeGreaterThan(1));
  await vi.waitFor(() => expect(error.mock.calls.some(([message]) => (
    String(message).includes('deferred compaction')
  ))).toBe(true));

  expect(journal.findByIdempotencyKey('idem-dirty')).toEqual(terminal);
  expect(journal.firstSequence).toBeLessThanOrEqual(terminal!.sequence);
  expect(effect).toHaveBeenCalledTimes(2_101);
  await expect(runtime.submit(takeover('idem-blocked'))).resolves.toMatchObject({
    status: 'rejected',
    code: 'durability_unavailable',
  });

  failOriginal = false;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await runtime.submit(takeover('idem-trigger-retry'));
  await vi.waitFor(() => expect(journal.firstSequence).toBeGreaterThan(terminal!.sequence));

  const reopened = await ControlJournal.open(root, 5);
  const restartedEffect = vi.fn(async () => ({ applied: 'again' }));
  const restarted = await ControlRuntime.create({
    ownerEpoch: 5,
    handlers: makeHandlers({ takeover: restartedEffect }),
    journal: reopened,
  });

  await expect(restarted.submit(takeover('idem-dirty'))).resolves.toEqual({
    status: 'unknown',
    code: 'idempotency_outcome_compacted',
    message: 'command completed previously; its exact outcome is no longer retained',
  });
  expect(restartedEffect).not.toHaveBeenCalled();
  expect(first.status).toBe('succeeded');
});
```

This test must prove all required phases: failure after terminal append,
enough later commands to request compaction, deferred compaction preserving the
terminal event, persistence restoration, successful retry/compaction, restart,
and resubmission without a second effect.

- [ ] **Step 3: Run the focused tests and verify the new assertions fail**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: FAIL because completed-key tombstones, dirty tracking, redacted
snapshots, and compaction gating do not exist.

- [ ] **Step 4: Add the atomic hash-addressed completed-key store**

In `src/control/journal.ts`, add a sidecar directory beside `snapshot.json`:

```ts
const COMPLETED_KEY_SCHEMA = 'psyche.control.completed-key/v1' as const;

interface DurableCompletedKeyRecord {
  readonly schema: typeof COMPLETED_KEY_SCHEMA;
  readonly keyDigest: string;
  readonly terminalSequence: number;
}

function completedKeyDigest(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
}
```

Store `completedKeysPath` on `ControlJournal`, initialize it as
`path.join(runtimeDir, 'completed-keys')`, and add:

```ts
async hasCompletedKey(idempotencyKey: string): Promise<boolean> {
  const digest = completedKeyDigest(idempotencyKey);
  const file = path.join(this.completedKeysPath, `${digest}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<DurableCompletedKeyRecord>;
  if (parsed.schema !== COMPLETED_KEY_SCHEMA
    || parsed.keyDigest !== digest
    || !Number.isInteger(parsed.terminalSequence)
    || Number(parsed.terminalSequence) < 1) {
    throw new Error(`invalid durable completed key: ${file}`);
  }
  return true;
}

async storeCompletedKey(
  idempotencyKey: string,
  terminalSequence: number,
): Promise<void> {
  const digest = completedKeyDigest(idempotencyKey);
  await mkdir(this.completedKeysPath, { recursive: true, mode: 0o700 });
  const target = path.join(this.completedKeysPath, `${digest}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({
      schema: COMPLETED_KEY_SCHEMA,
      keyDigest: digest,
      terminalSequence,
    }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}
```

Validate `terminalSequence` before writing. Clear dirty state only after the
file fsync and atomic rename succeed, matching the journal's existing atomic
publication pattern. Do not persist `CommandOutcome`, raw keys, command
payloads, messages, or receipts in this store.

Extend `CompactableJournal` and `asCompactable` with:

```ts
hasCompletedKey(idempotencyKey: string): Promise<boolean>;
storeCompletedKey(idempotencyKey: string, terminalSequence: number): Promise<void>;
```

- [ ] **Step 5: Serialize cold lookup and bound dirty metadata**

Keep `submit()` synchronous in shape but install the cold lookup promise in
`pendingByIdempotencyKey` before awaiting I/O. Check sources in this order:
bounded hot exact outcome, pending submission, retained terminal tail,
completed-key tombstone, then fresh execution.

```ts
private async submitAfterDurableLookup(command: ControlCommand): Promise<CommandOutcome> {
  const tail = this.journal.findByIdempotencyKey(command.idempotencyKey);
  if (tail && TERMINAL_EVENT_KINDS.has(tail.kind)) {
    const outcome = outcomeFromEvent(tail);
    this.rememberOutcome(command.idempotencyKey, outcome);
    return outcome;
  }
  if (await this.compactable?.hasCompletedKey(command.idempotencyKey)) {
    return {
      status: 'unknown',
      code: 'idempotency_outcome_compacted',
      message: 'command completed previously; its exact outcome is no longer retained',
    };
  }
  if (!await this.reserveCompletedKeySlot(command.idempotencyKey)) {
    return rejectedOutcome(
      'durability_unavailable',
      'completed-key durability is unavailable; refusing a new effect',
    );
  }
  try {
    return await this.submitFresh(command);
  } finally {
    this.completedKeyReservations.delete(command.idempotencyKey);
  }
}
```

Add:

```ts
private readonly dirtyCompletedKeys = new Map<string, number>();
private readonly completedKeyReservations = new Set<string>();
private compactionBlockedByDurability = false;

private async reserveCompletedKeySlot(idempotencyKey: string): Promise<boolean> {
  if (!this.compactable) return true;
  const limit = AGENT_CONTROL_LIMITS.pendingCommands;
  if (this.compactionBlockedByDurability
    || this.dirtyCompletedKeys.size + this.completedKeyReservations.size >= limit) {
    await this.flushDirtyCompletedKeysThrough(Number.POSITIVE_INFINITY);
  }
  if (this.compactionBlockedByDurability && this.dirtyCompletedKeys.size === 0) {
    this.compactionBlockedByDurability = false;
  }
  if (this.compactionBlockedByDurability) return false;
  if (this.dirtyCompletedKeys.size + this.completedKeyReservations.size >= limit) {
    return false;
  }
  this.completedKeyReservations.add(idempotencyKey);
  return true;
}
```

The dirty map stores only the key and terminal sequence. Reserving before
`submitFresh` prevents concurrent effects from all passing a stale size check.
The union of dirty entries and reservations never exceeds the existing 256
pending-command cap; retries remain available even when fresh effects fail
closed at the cap. Once compaction is deferred for a covered dirty key,
`compactionBlockedByDurability` also rejects fresh effects until the pending
write succeeds, bounding journal growth during a persistent failure. Add a
gated-concurrency test that fills all 256 slots with failing tombstone writes,
verifies a 257th fresh effect receives `durability_unavailable`, and verifies a
retry of a terminal key still returns its recorded outcome.

- [ ] **Step 6: Use crash-safe terminal ordering and preserve the real result**

Centralize terminal publication for both surface and non-surface commands:

```ts
private async persistCompletedKey(
  idempotencyKey: string,
  terminalSequence: number,
): Promise<void> {
  const journal = this.compactable;
  if (!journal) return;
  this.completedKeyReservations.delete(idempotencyKey);
  this.dirtyCompletedKeys.set(idempotencyKey, terminalSequence);
  try {
    await journal.storeCompletedKey(idempotencyKey, terminalSequence);
    if (this.dirtyCompletedKeys.get(idempotencyKey) === terminalSequence) {
      this.dirtyCompletedKeys.delete(idempotencyKey);
    }
  } catch (error) {
    console.error(
      `[control-runtime] completed-key durability failed for terminal sequence ${terminalSequence}`,
      error,
    );
  }
}
```

For every terminal path, enforce this exact order:

```ts
const event = await this.journal.append(terminalKindForOutcome(outcome), payload);
this.rememberOutcome(command.idempotencyKey, outcome);
await this.persistCompletedKey(command.idempotencyKey, event.sequence);
this.maybeCompact();
return outcome;
```

Do not throw the tombstone persistence error from `appendTerminal`: the effect
and terminal event already completed. Keep the dirty entry, emit the explicit
operator-visible error, return the real `CommandOutcome`, and let retries read
the hot map or authoritative terminal tail.

- [ ] **Step 7: Retry dirty keys before compaction and on recovery**

Implement:

```ts
private async flushDirtyCompletedKeysThrough(coveredSequence: number): Promise<boolean> {
  const journal = this.compactable;
  if (!journal) return true;
  for (const [key, sequence] of [...this.dirtyCompletedKeys]) {
    if (sequence > coveredSequence) continue;
    await this.persistCompletedKey(key, sequence);
  }
  return ![...this.dirtyCompletedKeys.values()]
    .some((sequence) => sequence <= coveredSequence);
}
```

At startup, replay retained terminal events into the hot exact map. For each
terminal event, call `hasCompletedKey`; if it is absent, add the key and
sequence to `dirtyCompletedKeys` and attempt persistence. A failed
reconstruction does not invalidate the terminal outcome: the event remains
authoritative and ineligible for compaction.

In `compactJournal`, compute `coveredSequence`, then gate all snapshot and
journal mutation:

```ts
if (!await this.flushDirtyCompletedKeysThrough(coveredSequence)) {
  this.compactionBlockedByDurability = true;
  console.error(
    `[control-runtime] deferred compaction through sequence ${coveredSequence}: `
      + 'completed-key durability is pending',
  );
  return;
}
this.compactionBlockedByDurability = false;
```

Only after this returns `true` may the runtime write a snapshot and call
`journal.compact(coveredSequence)`. A terminal event whose tombstone is dirty
must never be represented as compactable merely because its exact outcome was
evicted from the hot map.

- [ ] **Step 8: Remove exact outcomes from durable snapshots**

Delete `outcomes` from `JournalSnapshotFile`, `loadSnapshot`, startup restore,
and compaction writes. Replace `snapshot: ControlSnapshot` with the minimal
allowlisted durable metadata:

```ts
export interface DurableControlSnapshot {
  readonly ownerEpoch: number;
  readonly sequence: number;
}
```

Write only `{ ownerEpoch, sequence }` there. Keep bounded redacted
`JournalActionReceipt` records and the Task 2 open transactions as separate
top-level fields. Do not persist commands, exact outcomes, leases, resources,
approvals, live receipts, command payloads, or effect fields. The open
transaction command ID and raw idempotency key are the sole minimal exception
because restart recovery must match and terminalize in-flight work.

Add a test that writes distinctive secret-looking sentinels into a command
payload, exact outcome, and live receipt, compacts, reads `snapshot.json`, and
asserts those sentinels are absent while the required open transaction remains.

- [ ] **Step 9: Run focused tests and update contract documentation**

Run:

```bash
pnpm vitest --run __tests__/controlJournal.test.ts __tests__/controlRuntime.test.ts __tests__/controlJournalCompaction.test.ts
```

Expected: PASS.

Update `docs/CONTROL-PLANE.md` and `docs/AGENT-SURFACE-CONTROL.md` to state:

- exact outcomes are bounded to the hot map and retained tail;
- compact redacted tombstones permanently prevent old-key re-execution;
- a compacted exact outcome returns `idempotency_outcome_compacted`;
- terminal events cannot be compacted while tombstone persistence is dirty;
- persistence failure is operator-visible but does not misreport an already
  completed command as failed; and
- durable snapshots omit command envelopes and exact outcomes.

- [ ] **Step 10: Commit durable idempotency**

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
    snapshot: {
      ownerEpoch: 4,
      sequence: requested.sequence,
    },
    coveredSequence: requested.sequence,
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
Task 1 has already removed the exact `outcomes` field and replaced runtime
snapshot writes with the explicit redacted durable projection; do not
reintroduce either exact outcomes or command envelopes here.
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
tail so calling recovery twice cannot duplicate terminal events. The startup
completed-key reconstruction from Task 1 must then persist tombstones for
these recovery-generated terminal events before any future compaction may
cover them.

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
