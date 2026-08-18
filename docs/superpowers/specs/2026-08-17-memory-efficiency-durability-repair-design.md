# Memory Efficiency Durability Repair Design

## Problem

PR #165 bounds several host data structures, but three limits currently break
runtime guarantees:

1. evicting an idempotency outcome permits an old retry to execute again;
2. journal compaction can discard an unresolved command before restart
   recovery marks its effect unknown;
3. a closed pane buffer retained for an active stream is not reclaimed when
   the final stream later detaches.

The repair must preserve exact retry and recovery semantics without restoring
unbounded heap growth.

## Decision

### Keep idempotency authoritative on disk

Retain the 1,000-entry in-memory outcome map as a hot cache. Persist every
terminal idempotency outcome as an exact `CommandOutcome` sidecar at:

```text
.psyche/runtime/outcomes/<sha256(idempotencyKey)>
```

Each sidecar stores both the original `idempotencyKey` and the exact
`CommandOutcome`, so hash collisions or mismatched files are detected
explicitly. The outcomes directory is created or repaired with `0700`
permissions, temporary files are opened with `0600`, and publication remains
`write -> fsync -> close -> atomic rename`.

Each sidecar record is bounded by an explicit serialized cap,
`DURABLE_OUTCOME_RECORD_MAX_BYTES` (`8_781_824` bytes). `loadOutcome()` opens
the hashed file, checks its size through the handle, and reads at most
`DURABLE_OUTCOME_RECORD_MAX_BYTES + 1` bytes before parsing so oversized
existing files reject explicitly without an unbounded allocation.
`loadOutcome()` returns `undefined` only for `ENOENT`; corruption, key
mismatch, invalid outcome shapes, or oversized files fail closed.

On a hot-cache miss, `submit()` first consults any in-memory dirty replay and
same-key pending promise, then checks the retained terminal journal tail, then
the durable sidecar, and only on a cold miss consumes fresh-execution capacity
and calls the live handler. A durable retry therefore reaches retained-tail or
sidecar replay even when 256 unrelated fresh executions already occupy the
runtime.

After the terminal journal append succeeds, the runtime immediately remembers
the exact outcome in the hot cache and in dirty replay state before attempting
to persist the sidecar. If that write fails, the original submission surfaces
the durability error, but immediate retries still deduplicate from hot or dirty
state and compaction remains blocked until authoritative exact replay data is
durable. Recovery-generated `command.unknown` outcomes use the same exact
sidecar path before later compaction may cover them. Retained non-surface
terminal events may reconstruct only while their journal payloads remain
complete; retained surface terminal events never reconstruct from redacted
payloads, so a missing exact sidecar fails closed.

### Preserve unresolved transactions through compaction

Extend the journal snapshot with open transaction records containing the
command identity, idempotency key, request sequence, and latest nonterminal
state required by recovery. Compaction derives this set from the previous
snapshot and the journal prefix being covered.

During replay, retained tail events override snapshot state. A terminal tail
event removes the matching open transaction; otherwise startup appends exactly
one `command.unknown` before accepting new commands. This state remains bounded
by the runtime's existing 256 pending-command limit.

### Reclaim retired pane buffers on final release

When a workspace snapshot no longer publishes a pane that still has active
streams, mark the pane as retired and retain its buffer. Every detach,
unsubscribe, and session-close path then checks whether a retired pane has any
remaining subscribers. The final release calls `forgetPane` and removes the
retired marker. Republishing the pane clears retirement without discarding its
live buffer.

## Error Handling

- Durable idempotency lookup failures reject the command explicitly; they never
  fall through to execution.
- A sidecar persistence failure after the terminal journal append surfaces that
  durability error, preserves exact hot/dirty replay, and keeps compaction from
  covering the terminal event.
- A retained surface terminal event without its exact sidecar fails closed
  rather than reconstructing an approximate result.
- Invalid snapshot open-transaction data is treated as journal corruption.
- Pane cleanup remains idempotent so duplicate detach and close events are
  harmless.

## Rejected Alternatives

- Retaining every outcome in memory or one monolithic snapshot restores
  unbounded heap and serialization growth.
- Defining an expiration window changes the published idempotency contract.
- Pinning compaction behind the oldest unresolved command allows one stalled
  effect to make the journal unbounded.
- Re-reading the workspace on every stream teardown adds provider races and
  unnecessary work when retirement can be tracked deterministically.

## Validation

Add regressions proving:

- an idempotency key older than 1,000 outcomes still deduplicates before and
  after restart and compaction, and still replays while fresh-execution
  capacity is full;
- sidecars use `0700`/`0600` permissions, reject malformed, mismatched,
  invalid, or oversized records, and bound existing-file reads before parsing;
- a sidecar write failure surfaces immediately, but exact hot/dirty replay
  remains available and compaction stays blocked until persistence recovers;
- a recovery-generated `command.unknown` is persisted to the exact sidecar
  before later compaction may cover it;
- a retained surface terminal event with a missing exact sidecar fails closed;
- compaction across an unresolved request produces exactly one
  `command.unknown` after restart, while a retained terminal event wins;
- closed pane buffers survive while subscribed and are released after the
  final detach, legacy unsubscribe, or session close;
- multiple subscribers do not trigger early release and republishing cancels
  retirement.

Run the focused control-runtime, journal-compaction, bridge, and pane-stream
tests, then TypeScript source/test type checks and the repository CI matrix.

## Scope

This repair changes only idempotency durability, journal recovery metadata, and
closed-pane buffer ownership. It does not change command protocol shapes,
idempotency expiration semantics, workspace publication, or live pane stream
behavior.
