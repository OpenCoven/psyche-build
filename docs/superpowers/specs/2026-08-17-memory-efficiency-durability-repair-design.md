# Memory Efficiency Durability Repair Design

## Problem

PR #165 bounds host memory, but three bounds still threaten runtime safety:

1. an old idempotency key can execute again after its exact outcome ages out;
2. compaction can discard unresolved or insufficiently durable terminal
   evidence; and
3. a closed pane buffer retained for a stream is not reclaimed on final
   release.

Commit `b3899e0e` already established
`.psyche/runtime/outcomes/<sha256(idempotencyKey)>` plus
`ControlJournal.loadOutcome()` and `storeOutcome()`. Upgrade safety therefore
requires keeping that exact-outcome store authoritative in place. Task 1 does
not redesign snapshots or introduce compact tombstones; instead it adds digest
integrity, bounded dirty-durability tracking, and a compatibility attestation
path for retained pre-digest surface terminals.

## Decision

### Keep one compatible outcome namespace

Keep the existing path and hash:

```text
.psyche/runtime/outcomes/<sha256(idempotencyKey)>
```

`loadOutcome()` accepts only the exact b389 record,
`{ idempotencyKey, outcome }`. `storeOutcome()` continues to publish that exact
record. Existing b389 records need no migration and remain authoritative
immediately after upgrade. Corrupt, mismatched, unreadable, or unknown records
fail closed before a fresh effect can run.

The hot exact cache remains capped at 1,000. Dirty exact-outcome persistence is
bounded to 256 keys; once that budget is exhausted, fresh effects reject with
`durability_unavailable` until a later successful flush drains the dirty set.
Retained pre-digest surface terminals can append a later digest attestation
keyed by `(commandId, idempotencyKey)` so they restart safely and become
compactable without exposing exact surface values in the journal.

### Keep exact sidecar publication fail-closed

Publication keeps the existing exact sidecar path and writes only
`{ idempotencyKey, outcome }`. The helper first validates `.psyche`, `runtime`,
and `outcomes` component-by-component with `lstat`, rejecting symlinks,
junctions, and non-directories. It then writes a unique same-directory
temporary file, fsyncs and closes it, and atomically renames it over the
hashed destination.

To narrow directory-swap races, publication captures a stable outcomes
directory identity (real path plus available device/inode metadata) and
revalidates it before temp-file creation, after temp-file creation, before the
destination rename, and after the rename. Reads use the same identity checks,
plus bounded size checks and bounded handle reads, so oversized or swapped
files fail closed without unbounded allocation.

The same fail-closed identity validation also guards the existing snapshot and
journal replacement paths used during compaction.

### Gate compaction without changing the completed outcome

Terminal handling is:

1. append and fsync the terminal journal event;
2. put the exact outcome in the bounded hot cache;
3. move the reserved slot to bounded dirty state containing key, terminal
   sequence, and exact outcome;
4. durably publish the exact record; and
5. clear dirty state only after file and directory durability succeeds.

Persistence failure is operator-visible but does not replace or reject an
effect that already completed. The real exact outcome remains retryable from
the hot cache or retained terminal event. Dirty exact outcomes are bounded to
the same 256-command durability budget as pending executions; once that budget
is exhausted, only already-known retries remain available and fresh effects
fail closed with `durability_unavailable` until a later flush succeeds.

Before compaction covers a terminal event, the runtime:

1. flushes dirty exact records through the proposed cutoff;
2. verifies that every covered terminal key still has an exact sidecar whose
   SHA-256 digest matches either the terminal event itself or a later digest
   attestation keyed by `(commandId, idempotencyKey)`; and
3. only then compacts the journal.

Any failed flush, digest verification, or attestation lookup aborts the whole attempt, retains the terminal
event, sets `compactionBlockedByDurability`, and rejects new effects with
`durability_unavailable` until a later reservation successfully flushes the
dirty work. Retries already answerable from hot state, the journal tail, or
the sidecar remain available.

Startup scans retained terminal events. A missing sidecar becomes dirty only
when the retained event can be reconstructed exactly; otherwise startup fails
closed. A
retained pre-digest surface terminal with a valid exact sidecar appends a
bounded digest attestation before later compaction may cover it. Legacy
`snapshot.outcomes` keys no longer warm the hot cache: without the exact
sidecar they fail closed.
Existing b389 records load directly even when their terminal journal events
were already compacted.

### Task 2 will keep snapshots redacted while preserving open transactions

Task 2 will reduce snapshots to owner epoch, covered sequence, bounded
redacted receipt records, and bounded open transactions. It will omit exact
outcomes, command envelopes, live resources, effect data, messages, typed
values, and scripts.

Task 2 open transactions will contain only sequence, command ID, raw
idempotency key, and latest nonterminal kind. The raw key will remain the
narrow exception needed for restart matching. Tail terminal events will
override snapshot records. Otherwise startup will append exactly one
`command.unknown` before accepting new commands. Open transactions will remain
bounded by the 256 pending-command cap, and recovery-generated terminal events
will use the same sidecar durability gate.

### Task 3 will reclaim retired pane buffers

Task 3 will mark a pane retired once a workspace no longer publishes it but
streams still reference its buffer. Detach, legacy unsubscribe, and
session-close paths will call one final-release check after removing their
references. The final release will call `forgetPane` and clear retirement.
Republishing will clear retirement without discarding the live buffer.

## Error Handling

- Outcome lookup errors reject fresh execution.
- Outcome persistence errors preserve the exact completed outcome and terminal
  evidence, remain dirty, log clearly, and defer compaction.
- Sidecar identity, permission, or bounded-read validation failures are treated
  as persistence/replay failures.
- Invalid open-transaction snapshot data is journal corruption.
- Pane cleanup is idempotent.

## Rejected Alternatives

- A separate `.psyche/runtime/completed-keys` store is upgrade-unsafe.
- Bulk migration is unnecessary when the existing hashed path already names the
  authoritative exact record.
- Replacing exact sidecars with compact/tombstone records would silently weaken
  retry semantics for commands whose exact prior result must remain replayable.
- Clearing dirty state before exact sidecar publication completes can erase the
  only authoritative replay evidence.
- Reporting metadata failure as command failure misstates an effect that
  already happened and encourages unsafe retries.
- Expiring keys changes the no-double-execution contract.
- Pinning compaction behind one unresolved effect allows unbounded journal
  growth; bounded open-transaction records preserve the evidence instead.

## Validation

Regressions prove:

- a manually written b389-format sidecar with no retained terminal event is
  loaded after upgrade and a real `pane.terminal.open` handler is not invoked;
- exact records share one hashed path, bounded reads reject oversized files,
  and corrupt variants fail closed;
- temp write, temp fsync, close, rename, and directory-identity checks occur
  in order, including fail-closed behavior for symlink swaps and non-regular
  files;
- the sidecar-failing dirty command runs first and reaches terminal sequence 2,
  then 999 successful fillers reach sequence 2,000 without compaction;
- one successful trigger reaches sequence 2,002, computes cutoff 1,002, fails
  while flushing or verifying a covered terminal key, retains its terminal
  evidence, and blocks only subsequent fresh effects;
- after persistence is restored, the blocked-state reservation retry flushes
  the dirty outcome and the recovery trigger requests compaction; restart
  replays the original exact outcome and its effect count remains one;
- retained pre-digest surface terminals append a digest attestation before they
  can be compacted, while missing sidecars or unverifiable digests stay
  fail-closed;
- legacy `snapshot.outcomes` entries do not warm the hot cache and require the
  exact sidecar for replay;
- dirty durability backlog is capped at 256 keys, so fresh effects reject with
  `durability_unavailable` once exact replay can no longer be kept
  authoritative, but known retries still replay;
- unresolved commands recover exactly once;
- Task 2 will bound unresolved-command snapshot state without changing this
  Task 1 exact-outcome model; and
- retired buffers release only after the final stream or subscription.

## Scope

This repair changes idempotency durability, journal recovery metadata, and
closed-pane buffer ownership. Task 2 will address unresolved-command snapshot
persistence separately. It does not change command protocol shapes, key
expiration semantics, workspace publication, or live pane-stream behavior.
