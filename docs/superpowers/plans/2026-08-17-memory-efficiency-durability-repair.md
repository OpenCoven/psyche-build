# Memory Efficiency Durability Repair Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task by task.

**Goal:** Preserve idempotency and recovery while bounding exact outcomes, and
release retired pane buffers after their final subscriber.

**Architecture:** Keep the existing
`.psyche/runtime/outcomes/<sha256>` files as authoritative exact-outcome
records. `ControlRuntime` retains exact outcomes in its bounded hot cache,
caps dirty durability failures at 256 keys, appends bounded digest
attestations for retained pre-digest surface terminals, and prevents
compaction from covering a terminal event until an exact sidecar both loads and
matches either the terminal digest or that later attestation. Legacy
`snapshot.outcomes` keys remain fail-closed markers only. Task 2 will cover
open-transaction snapshot work; Task 3 covers retired pane buffers.

## File Map

- `src/control/journal.ts`: exact outcome records, durable publication, and
  retained-journal compatibility helpers.
- `src/control/runtime.ts`: dirty outcome retry, digest attestation,
  compaction gating, and recovery.
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
it('loads a legacy b389 exact outcome without re-executing its key', async () => {
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

### Step 2: Validate bounded exact records at the same path

Keep the current b389 `StoredOutcomeRecord` only:

```ts
interface StoredOutcomeRecord {
  readonly idempotencyKey: string;
  readonly outcome: CommandOutcome;
}
```

`loadOutcome(key)` uses the existing hashed path, bounded file-size checks, and
bounded handle reads. It rejects malformed JSON, key mismatches, invalid
outcome shapes, oversized files, symlink/non-regular entries, and directory
identity swaps. `storeOutcome(key, outcome)` continues to publish that exact
record only; Task 1 does not add a compact/tombstone sidecar format.

### Step 3: Harden exact sidecar publication

`ControlJournal.open()` creates `.psyche`, `runtime`, and `outcomes`
component-by-component with restrictive modes and `lstat` validation so
repository-controlled symlinks or non-directories are rejected before use.

`storeOutcome()` publishes exact sidecars with:

```text
validate stable outcomes directory identity
open unique same-directory temp file (0600)
write complete JSON
fsync temp file
close temp file
revalidate directory identity
rename temp file -> hashed destination
revalidate directory identity again
```

`loadOutcome()` applies the same containment checks around `lstat`, bounded
open, bounded read, and post-read validation. Existing directories keep their
current mode; newly created private directories use `0700`.

### Step 4: Keep exact replay authoritative during failures and upgrades

For every terminal path, append the journal event first, remember the exact
outcome in the bounded hot cache immediately, mark it dirty in memory, then try
to persist the exact sidecar. Recovery-generated `command.unknown` outcomes use
the same persistence path.

Startup and retained-tail replay verify exact sidecars against the terminal
event digest. When a retained pre-digest surface terminal still has a valid
exact sidecar, startup appends a bounded `command.outcome.attested` digest
record keyed by `(commandId, idempotencyKey)` so later compaction can trust the
sidecar without exposing the exact surface value. Legacy `snapshot.outcomes`
entries no longer warm the hot cache; without the exact sidecar they fail
closed.

### Step 5: Gate compaction and bound exact records

`flushDirtyOutcomesThrough(cutoff)` retries dirty exact records at or below the
cutoff. Startup scans retained terminal events after recovery. A missing
sidecar becomes dirty only when retained reconstruction is provably exact;
surface or unknown replay without an exact sidecar aborts startup.

Before a fresh effect, retry dirty records whenever the 256-entry dirty budget
is full. If the backlog cannot be drained, return:

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
4. require `loadOutcome(key)` to succeed for every covered terminal key and
   verify the exact sidecar digest against either the terminal event itself or
   a matching later attestation;
5. on any failure, set `compactionBlockedByDurability`, log deferred
   compaction, and return without writing a snapshot or journal;
6. durably write the current snapshot representation; and
7. compact only after all earlier steps succeed.

This bounds exact disk outcomes by the fixed 2,000-event trigger plus at most
256 dirty tracked failures. After compaction, authoritative exact sidecars
still replay old keys while the retained 1,000-event tail remains available
for cold lookup compatibility.

### Step 6: Add the deterministic fail-closed regression

In `controlJournalCompaction.test.ts`, cover:

- durable replay after hot-cache eviction, compaction, and restart;
- covered-terminal compaction aborts when exact sidecars are missing,
  unreadable, or digest-mismatched;
- retained pre-digest surface terminals gaining an attestation before they can
  be compacted; and
- the 256-entry dirty durability cap rejecting fresh effects without
  re-executing known retries.

### Step 7: Defer snapshot redesign to Task 2

Task 1 keeps the current snapshot structure. The only compatibility change here
is that legacy `snapshot.outcomes` values no longer seed the runtime hot cache;
exact sidecars and retained journal verification remain authoritative.

### Step 8: Validate Task 1

```bash
pnpm vitest --run \
  __tests__/controlJournal.test.ts \
  __tests__/controlRuntime.test.ts \
  __tests__/controlJournalCompaction.test.ts
pnpm run typecheck:tests
```

Update `docs/CONTROL-PLANE.md` and `docs/AGENT-SURFACE-CONTROL.md` with the
single-path exact-sidecar contract, digest attestation compatibility,
256-entry dirty durability bound, and fail-closed replay/compaction behavior.

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
