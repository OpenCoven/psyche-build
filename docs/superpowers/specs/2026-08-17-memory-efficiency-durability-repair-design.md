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
terminal idempotency outcome in an atomic disk-backed cold store keyed by the
idempotency key. On a hot-cache miss, consult the cold store before accepting a
command for execution and repopulate the hot cache when a prior outcome exists.

The cold store is authoritative and append-safe; corrupt or unreadable state
fails closed rather than allowing an effect to execute again. Disk retention is
not silently expired because the control-plane contract promises that retries
never double-execute.

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

- Durable idempotency lookup or persistence failures reject the command
  explicitly; they never fall through to execution.
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
  after restart and compaction;
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
