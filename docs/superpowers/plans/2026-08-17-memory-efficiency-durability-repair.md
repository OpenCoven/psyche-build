# Memory Efficiency Durability Repair Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task by task.

**Goal:** Preserve idempotency and recovery while bounding exact outcomes, and
release retired pane buffers after their final subscriber.

**Architecture:** Evolve the existing
`.psyche/runtime/outcomes/<sha256>` files to hold either b389 exact outcomes or
compact outcomes. All replacement writes use temp-file fsync, atomic rename,
and containing-directory fsync. `ControlRuntime` retains exact outcomes in its
bounded cache, keeps failed publications dirty, and prevents compaction from
covering a terminal event until the same sidecar path is durable. Redacted
snapshots preserve only receipts and unresolved transactions. `BridgeDaemon`
tracks unpublished streamed panes until final release.

## File Map

- `src/control/journal.ts`: compatible outcome records, durable publication,
  redacted snapshots, and open transactions.
- `src/control/runtime.ts`: dirty outcome retry, compaction gate, compact
  outcomes, and recovery.
- `src/services/bridge/BridgeDaemon.ts`: retired pane ownership.
- `__tests__/controlJournal.test.ts`: compatibility and fsync ordering.
- `__tests__/controlRuntime.test.ts`: terminal outcome behavior.
- `__tests__/controlJournalCompaction.test.ts`: upgrade and fail-closed
  regressions.
- Bridge stream tests and the three related contract documents.

## Task 1: Evolve the existing outcome sidecar

### Step 1: Add a b389 upgrade regression

In `__tests__/controlJournalCompaction.test.ts`, keep the existing no-argument
`makeHandlers(): ControlHandlers`. Add this supported command helper:

```ts
function openTerminalCommand(
  idempotencyKey: string,
  ownerEpoch = 4,
): ControlCommand {
  return {
    id: `cmd-${idempotencyKey}-${ownerEpoch}`,
    idempotencyKey,
    kind: 'pane.terminal.open',
    projectRoot: '/repo',
    actor: { id: 'human-1', kind: 'human' },
    ownerEpoch,
    createdAt: '2026-08-17T20:00:00.000Z',
    payload: { cwd: '/repo', title: idempotencyKey },
  };
}
```

Extend the file's imports with `writeFile` and `createHash`. Write the exact
unversioned record produced by `b3899e0e` to the existing hash path:

```ts
it('loads a compacted b389 outcome without re-executing its key', async () => {
  const root = await newRoot();
  const key = 'idem-b389-upgrade';
  const outcome = {
    status: 'succeeded',
    value: { paneId: '%legacy' },
  } as const;
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  const outcomes = path.join(root, '.psyche', 'runtime', 'outcomes');
  await mkdir(outcomes, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(outcomes, digest),
    JSON.stringify({ idempotencyKey: key, outcome }),
    { encoding: 'utf8', mode: 0o600 },
  );

  const journal = await ControlJournal.open(root, 5);
  const handlers = makeHandlers();
  const effect = vi.fn(async () => ({ paneId: '%executed-again' }));
  handlers.openTerminal = effect;
  const runtime = await ControlRuntime.create({
    ownerEpoch: 5,
    handlers,
    journal,
  });

  await expect(runtime.submit(openTerminalCommand(key, 5))).resolves.toEqual(outcome);
  expect(effect).not.toHaveBeenCalled();
  expect(journal.sequence).toBe(0);
});
```

This test starts with no retained terminal event, so it proves the existing
b389 sidecar alone prevents re-execution. Do not add another completed-key
directory or lookup.

### Step 2: Parse exact and compact records at the same path

Keep the current b389 `StoredOutcomeRecord`. Add:

```ts
const COMPACTED_OUTCOME = Object.freeze({
  status: 'unknown',
  code: 'idempotency_outcome_compacted',
  message: 'command completed previously; its exact outcome is no longer retained',
}) satisfies CommandOutcome;

const COMPACTED_OUTCOME_SCHEMA = 'psyche.control.outcome/v2' as const;

interface StoredCompactedOutcomeRecord {
  readonly schema: typeof COMPACTED_OUTCOME_SCHEMA;
  readonly keyDigest: string;
  readonly terminalSequence: number;
  readonly outcome: typeof COMPACTED_OUTCOME;
}
```

`loadOutcome(key)` accepts either the exact b389 record or this compact record.
Validate the raw key for exact records and the SHA-256 digest for compact
records. Unknown schemas, invalid sequences, mismatches, malformed JSON, and
oversized files throw.

Keep `storeOutcome(key, outcome)` for exact records. Add:

```ts
compactOutcome(
  idempotencyKey: string,
  terminalSequence: number,
): Promise<void>;
```

It reads and validates the current file, then replaces that same path with the
compact record. Missing or corrupt source state fails closed. Repeating a valid
compact rewrite is idempotent. Add the method to `CompactableJournal` and
`asCompactable`.

### Step 3: Add a durable publication seam

Use a narrow seam that can record ordering in tests:

```ts
export interface OutcomePublicationHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface OutcomeDirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface OutcomeFileOperations {
  createDirectory(directoryPath: string, mode: number): Promise<boolean>;
  openTemporary(filePath: string, mode: number): Promise<OutcomePublicationHandle>;
  openDirectory(directoryPath: string): Promise<OutcomeDirectoryHandle>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}
```

The Node implementation creates `.psyche`, `runtime`, and `outcomes` one
component at a time. `createDirectory` returns whether it created the entry.
After creating a component, fsync its parent directory before using the child.

Both exact and compact publication must perform:

```text
open temporary
write complete JSON
sync temporary
close temporary
rename temporary -> hashed destination
open outcomes directory
sync outcomes directory
close outcomes directory
resolve
```

Do not swallow an unsupported directory-open or directory-sync error. The
runtime must fail closed rather than acknowledge weaker persistence.

Recording tests assert the exact order, parent sync when `outcomes` is new,
rejection after a post-rename directory-sync failure, same destination for
exact and compact records, and best-effort temp cleanup without masking the
primary error.

Use the same replacement primitive in `writeSnapshot()` and `compact()`.
Their rename is not successful until `.psyche/runtime` is fsynced.
`compact()` updates `events`, `firstRetainedSequence`, and the index only after
that sync.

### Step 4: Preserve the completed result when metadata persistence fails

Add bounded state in `ControlRuntime`:

```ts
interface DirtyOutcome {
  readonly terminalSequence: number;
  readonly outcome: CommandOutcome;
}

private readonly dirtyOutcomes = new Map<string, DirtyOutcome>();
private readonly outcomeReservations = new Set<string>();
private compactionBlockedByDurability = false;
```

Dirty entries plus reservations cannot exceed
`AGENT_CONTROL_LIMITS.pendingCommands`.

For every terminal path:

```text
append and fsync terminal event
remember exact hot outcome
move reservation to dirtyOutcomes
attempt storeOutcome
clear the matching dirty entry only after storeOutcome resolves
request compaction
return the exact outcome
```

Catch `storeOutcome()` failure after the terminal append. Log the durability
failure, retain dirty state, and return the exact outcome. Do not reject the
submission or replace its outcome with a metadata error.

Update the existing runtime regression using its real module-level
`handlers.openTerminal` and `openTerminalCommand()`:

```ts
it('preserves a completed outcome when sidecar persistence fails', async () => {
  const root = await newJournalRoot('control-runtime');
  const effect = vi.fn(async () => ({ paneId: '%7' }));
  handlers.openTerminal = effect;
  const journal = await ControlJournal.open(root, 4);
  vi.spyOn(journal, 'storeOutcome').mockRejectedValue(new Error('disk full'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const runtime = await ControlRuntime.create({ ownerEpoch: 4, handlers, journal });

  await expect(submit(runtime, openTerminalCommand('idem-dirty', 'dirty-1')))
    .resolves.toEqual({ status: 'succeeded', value: { paneId: '%7' } });
  await expect(submit(runtime, openTerminalCommand('idem-dirty', 'dirty-2')))
    .resolves.toEqual({ status: 'succeeded', value: { paneId: '%7' } });
  expect(effect).toHaveBeenCalledTimes(1);
  expect(error.mock.calls.some(([message]) => (
    String(message).includes('outcome durability')
  ))).toBe(true);
});
```

### Step 5: Gate compaction and bound exact records

`flushDirtyOutcomesThrough(cutoff)` retries dirty exact records at or below the
cutoff. Startup scans retained terminal events after recovery. A missing
sidecar becomes dirty using `outcomeFromEvent(event)` and its sequence; lookup
errors abort startup.

Before a fresh effect, reservation checks retry dirty records whenever
`compactionBlockedByDurability` is set. If they remain dirty, return:

```ts
rejectedOutcome(
  'durability_unavailable',
  'outcome durability is unavailable; refusing a new effect',
);
```

`compactJournal()` must:

1. compute the cutoff;
2. flush dirty exact records through it;
3. derive terminal keys from retained events after previous snapshot coverage
   through the cutoff;
4. call `compactOutcome(key, terminalSequence)` for each;
5. on any failure, set `compactionBlockedByDurability`, log deferred
   compaction, and return without writing a snapshot or journal;
6. durably write the redacted snapshot; and
7. compact only after all earlier steps succeed.

This bounds exact disk outcomes by the fixed 2,000-event trigger plus at most
256 dirty/reserved publications. After compaction, only the retained
1,000-event tail remains exact.

### Step 6: Add the deterministic fail-closed regression

In `controlJournalCompaction.test.ts`, use `makeHandlers()` and the supported
`pane.terminal.open` handler:

```ts
it('blocks new effects while a covered terminal outcome is not durable', async () => {
  const root = await newRoot();
  const journal = await ControlJournal.open(root, 4);
  const originalStore = journal.storeOutcome.bind(journal);
  let failDirty = false;
  vi.spyOn(journal, 'storeOutcome').mockImplementation(async (key, outcome) => {
    if (key === 'idem-dirty' && failDirty) {
      throw new Error('injected outcome persistence failure');
    }
    await originalStore(key, outcome);
  });

  const dirtyEffect = vi.fn();
  const handlers = makeHandlers();
  const openTerminalEffect = vi.fn(async (
    payload: Parameters<ControlHandlers['openTerminal']>[0],
  ) => {
    if (payload.title === 'idem-dirty') dirtyEffect();
    return { paneId: `%${payload.title}` };
  });
  handlers.openTerminal = openTerminalEffect;
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const runtime = await ControlRuntime.create({
    ownerEpoch: 4,
    handlers,
    journal,
  });

  for (let index = 0; index < 999; index += 1) {
    await runtime.submit(openTerminalCommand(`idem-fill-${index}`));
  }
  expect(journal.sequence).toBe(1_998);

  failDirty = true;
  await expect(runtime.submit(openTerminalCommand('idem-dirty')))
    .resolves.toMatchObject({ status: 'succeeded' });
  const terminal = journal.findByIdempotencyKey('idem-dirty');
  expect(terminal?.kind).toBe('command.succeeded');
  expect(terminal?.sequence).toBe(2_000);
  expect(dirtyEffect).toHaveBeenCalledTimes(1);

  await runtime.submit(openTerminalCommand('idem-compaction-trigger'));
  await vi.waitFor(() => expect(error.mock.calls.some(([message]) => (
    String(message).includes('deferred compaction')
  ))).toBe(true));

  expect(journal.findByIdempotencyKey('idem-dirty')).toEqual(terminal);
  expect(journal.firstSequence).toBeLessThanOrEqual(terminal!.sequence);
  expect((runtime as unknown as {
    compactionBlockedByDurability: boolean;
  }).compactionBlockedByDurability).toBe(true);

  const callsBeforeBlocked = openTerminalEffect.mock.calls.length;
  await expect(runtime.submit(openTerminalCommand('idem-blocked'))).resolves.toMatchObject({
    status: 'rejected',
    code: 'durability_unavailable',
  });
  expect(openTerminalEffect).toHaveBeenCalledTimes(callsBeforeBlocked);
  expect(dirtyEffect).toHaveBeenCalledTimes(1);

  failDirty = false;
  await expect(runtime.submit(openTerminalCommand('idem-recovery-trigger')))
    .resolves.toMatchObject({ status: 'succeeded' });
  await vi.waitFor(() => expect(
    journal.firstSequence,
  ).toBeGreaterThan(terminal!.sequence));

  const reopened = await ControlJournal.open(root, 5);
  const restartedHandlers = makeHandlers();
  const restartedEffect = vi.fn(async (
    payload: Parameters<ControlHandlers['openTerminal']>[0],
  ) => {
    if (payload.title === 'idem-dirty') dirtyEffect();
    return { paneId: '%executed-after-restart' };
  });
  restartedHandlers.openTerminal = restartedEffect;
  const restarted = await ControlRuntime.create({
    ownerEpoch: 5,
    handlers: restartedHandlers,
    journal: reopened,
  });

  await expect(restarted.submit(openTerminalCommand('idem-dirty', 5))).resolves.toEqual({
    status: 'unknown',
    code: 'idempotency_outcome_compacted',
    message: 'command completed previously; its exact outcome is no longer retained',
  });
  expect(restartedEffect).not.toHaveBeenCalled();
  expect(dirtyEffect).toHaveBeenCalledTimes(1);
}, 120_000);
```

Only one command crosses the compaction threshold. No filler loop continues
after durability blocks compaction.

### Step 7: Redact snapshots

Replace the persisted client `ControlSnapshot` with:

```ts
export interface DurableControlSnapshot {
  readonly ownerEpoch: number;
  readonly sequence: number;
}

export interface JournalSnapshotFile {
  readonly snapshot: DurableControlSnapshot;
  readonly coveredSequence: number;
  readonly receiptRecords: DurableReceiptRecord[];
  readonly openTransactions: DurableOpenTransaction[];
}
```

`loadSnapshot()` tolerates a legacy `outcomes` field but does not restore it;
the next snapshot omits it. The existing sidecar is authoritative.

Add sentinels for command value, message, typed value, script, and raw receipt
resource. After compaction, none may appear in `snapshot.json`. Raw
idempotency keys are allowed only in bounded `openTransactions`.

### Step 8: Validate Task 1

```bash
pnpm vitest --run \
  __tests__/controlJournal.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlJournalCompaction.test.ts
pnpm run typecheck:tests
```

Update `docs/CONTROL-PLANE.md` and `docs/AGENT-SURFACE-CONTROL.md` with the
single-path upgrade contract, full fsync sequence, bounded exact outcomes,
compacted `unknown` result, and fail-closed compaction behavior.

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
```

Publishing, merging, and PR-state changes are outside this plan.
