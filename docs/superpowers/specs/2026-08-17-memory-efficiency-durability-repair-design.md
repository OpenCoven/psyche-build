# Memory Efficiency Durability Repair Design

## Problem

PR #165 bounds several host data structures, but three limits currently break
runtime guarantees:

1. evicting an idempotency outcome permits an old retry to execute again;
2. journal compaction can discard an unresolved command before restart
   recovery marks its effect unknown;
3. a closed pane buffer retained for an active stream is not reclaimed when
   the final stream later detaches.

The initial repair plan also ordered terminal handling unsafely: it appended a
terminal event, persisted completed-key metadata, and only then updated the hot
outcome map. If metadata persistence failed, a later compaction could snapshot
the hot map without that outcome and discard the only terminal evidence.

The repair must preserve retry and recovery safety without restoring unbounded
heap growth or persisting unredacted command results in snapshots.

## Decision

### Keep exact outcomes bounded and completed keys durable

Retain the 1,000-entry in-memory outcome map as the bounded exact-result cache.
Persist a compact, redacted completed-key tombstone for every terminal
idempotency key in an atomic hash-addressed sidecar. Tombstones contain only
the schema version, key digest, and terminal journal sequence; they do not
contain command payloads, result values, error messages, receipts, or raw
idempotency keys.

On a hot-cache miss, first consult the retained journal tail. A terminal tail
event remains authoritative and reconstructs the exact outcome. If the tail no
longer contains the event, consult the completed-key tombstone. A tombstone
prevents re-execution and returns a stable `unknown` outcome with code
`idempotency_outcome_compacted`, explaining that the command completed but its
exact result aged out of bounded retention. An absent tombstone is a normal
cold miss; corrupt or unreadable tombstone state fails closed before a fresh
effect can execute.

Snapshots use a dedicated redacted durable projection containing only owner
epoch, covered sequence, bounded redacted receipt records, and bounded open
transactions. They never serialize the hot exact-outcome map, command
envelopes, live resource state, or effect data. Durable compact tombstones
provide old-key replay protection; the retained journal tail provides recent
exact outcomes.

### Couple terminal publication to compaction eligibility

Terminal completion follows this crash-safe, retryable order:

1. append and fsync the terminal journal event;
2. immediately remember the exact outcome in the bounded hot map;
3. add `{ idempotencyKey, terminalSequence }` to an in-memory
   `dirtyCompletedKeys` map;
4. atomically persist the compact completed-key tombstone;
5. remove the dirty entry only after persistence succeeds for the same
   terminal sequence.

The dirty map stores only compact metadata, not another unbounded copy of exact
outcomes. Later commands may continue while a small number of keys are dirty,
so a transient per-key failure does not stop the runtime before compaction is
needed. Before starting a fresh effect, the runtime reserves one completed-key
slot; terminal append atomically transfers that reservation into the dirty
map. Dirty entries plus reservations are capped at the existing 256
pending-command limit, including concurrent submissions. At the cap, or after
compaction is first deferred by a covered dirty key, the runtime retries
pending writes and fails closed for new effects until durability recovers.
This prevents a persistent metadata failure from making the journal grow
without bound. Retries that can be answered from the hot map, terminal journal
tail, or durable tombstone remain available. A tombstone write failure is
logged through the existing operator-visible error path; it does not replace
an already completed command's outcome with a failed submission.

Compaction must call `flushDirtyCompletedKeysThrough(coveredSequence)` before
writing a snapshot or dropping events. It retries every dirty tombstone whose
terminal sequence is at or below the proposed cutoff and aborts or defers the
entire compaction if any remains dirty. Therefore no terminal event is eligible
for compaction until its completed-key tombstone is confirmed durable.

After restart, journal replay is authoritative. Every retained terminal event
repopulates the bounded hot cache and is checked against the tombstone store;
a missing tombstone is reconstructed as dirty and retried before that event
can be covered by compaction. A crash at any point therefore leaves either a
durable tombstone or a retained terminal journal event that compaction cannot
erase.

### Preserve unresolved transactions through compaction

Extend the redacted journal snapshot with open transaction records containing
only the command identity, raw idempotency key required for retry matching,
request sequence, and latest nonterminal state required by recovery.
Compaction derives this bounded set from the previous snapshot and the journal
prefix being covered; no command payload or effect data is copied.

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

- Completed-key lookup failures reject fresh execution explicitly.
- Completed-key persistence failures preserve the appended terminal event and
  exact hot outcome, keep the key dirty, log an operator-visible durability
  error, and defer compaction; they do not report the completed effect as a
  command failure.
- Snapshot files contain only allowlisted redacted state and bounded
  open-transaction evidence; completed-key tombstones remain in their separate
  compact sidecar.
- Invalid snapshot open-transaction data is treated as journal corruption.
- Pane cleanup remains idempotent so duplicate detach and close events are
  harmless.

## Rejected Alternatives

- Persisting exact outcomes indefinitely in sidecars or snapshots violates the
  bounded exact-outcome and redacted-snapshot requirements.
- Clearing a dirty completed key after a failed write permits compaction to
  erase the sole idempotency evidence.
- Returning a command failure after its effect and terminal event completed
  misreports reality and encourages unsafe retries.
- Defining an expiration window changes the published no-double-execution
  contract.
- Pinning compaction behind the oldest unresolved in-flight command allows one
  stalled effect to make the journal unbounded; bounded open-transaction
  snapshot records preserve that evidence instead.
- Re-reading the workspace on every stream teardown adds provider races and
  unnecessary work when retirement can be tracked deterministically.

## Validation

Add regressions proving:

- an idempotency key older than 1,000 exact outcomes is blocked by its compact
  tombstone before and after restart and compaction;
- after a terminal append, injected tombstone persistence failure keeps the
  exact outcome retryable, makes later compaction defer without deleting the
  event, and succeeds after persistence is restored; after restart,
  resubmitting the original key does not execute the effect again;
- compaction across an unresolved request produces exactly one
  `command.unknown` after restart, while a retained terminal event wins;
- durable snapshots contain no exact outcome values, command envelopes, or
  unredacted receipt data; raw idempotency keys appear only in the bounded
  open-transaction records needed for recovery;
- closed pane buffers survive while subscribed and are released after the
  final detach, legacy unsubscribe, or session close;
- multiple subscribers do not trigger early release and republishing cancels
  retirement.

Run the focused control-runtime, journal-compaction, bridge, and pane-stream
tests, then TypeScript source/test type checks and the repository CI matrix.

## Scope

This repair changes only idempotency durability, journal recovery metadata,
redacted snapshot persistence, and closed-pane buffer ownership. It does not
change command protocol shapes, idempotency expiration semantics, workspace
publication, or live pane stream behavior.
