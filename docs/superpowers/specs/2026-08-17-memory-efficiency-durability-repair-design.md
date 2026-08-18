# Memory Efficiency Durability Repair Design

## Problem

PR #165 bounds host memory, but three bounds still threaten runtime safety:

1. an old idempotency key can execute again after its exact outcome ages out;
2. compaction can discard unresolved or insufficiently durable terminal
   evidence; and
3. a closed pane buffer retained for a stream is not reclaimed on final
   release.

Task 1 is now implemented around exact durable `CommandOutcome` sidecars. The
earlier compact-marker draft drifted from the approved retry contract by
weakening old-key replay and by treating a terminal outcome as usable only
after sidecar persistence succeeded. The implemented repair instead preserves
exact replay, keeps immediate dirty in-memory replay after a failed sidecar
write, and blocks compaction until the same terminal key has authoritative
durable replay data.

Tasks 2 and 3 remain future work: unresolved-command snapshot recovery and
retired-pane reclamation are still planned separately.

## Decision

### Keep exact outcomes bounded and durable

Retain the 1,000-entry in-memory outcome map as the hot exact-result cache.
Persist every terminal idempotency outcome as an exact JSON sidecar at:

```text
.psyche/runtime/outcomes/<sha256(idempotencyKey)>
```

Each sidecar stores the original `idempotencyKey` plus the exact
`CommandOutcome`, so hash collisions or mismatched files are detected
explicitly. Hash-addressed filenames keep keys from escaping the directory; the
outcomes directory is created or repaired as `0700`, temporary files are opened
as `0600`, and publication remains `write -> fsync -> close -> atomic rename`.

Exact outcomes are accepted durably, but one file still needs a hard ceiling so
one retry record cannot grow without bound. The serialized sidecar limit is
`8_781_824` bytes (`DURABLE_OUTCOME_RECORD_MAX_BYTES`), derived from the
largest bounded screenshot, script-result, and pane-output payloads plus JSON
overhead. `loadOutcome()` returns `undefined` only for `ENOENT`; oversized
files, JSON corruption, original-key mismatch, and invalid `CommandOutcome`
shapes all throw explicitly.

On a hot-cache miss, the runtime installs one pending promise before async
lookup, then checks the retained terminal journal tail and the exact sidecar
before executing anything fresh. Non-surface terminal tail events may
reconstruct from complete journal payloads while they remain retained. Surface
terminal events are redacted and therefore never reconstruct approximately: if
their exact sidecar is missing, the retry fails closed.

New compaction writes leave the legacy top-level snapshot `outcomes` field
empty. Older snapshots may still warm the hot cache during upgrade, but
authoritative exact replay now lives in the sidecars.

### Couple terminal publication to compaction eligibility

Terminal completion now follows this crash-safe order:

1. append and fsync the terminal journal event;
2. immediately remember the exact outcome in the bounded hot map;
3. add `{ idempotencyKey, sequence, outcome? }` to `dirtyTerminalOutcomes`;
4. atomically persist the exact sidecar; and
5. clear the dirty entry only after persistence succeeds for that sequence.

If the sidecar write fails, the original submit surfaces that durability error,
but the runtime keeps the exact outcome dirty in memory so an immediate retry
still deduplicates without re-executing. Startup applies the same rule to
retained terminal events: it loads exact sidecars when present, reconstructs
only non-surface outcomes from complete retained payloads, and marks missing
entries dirty until authoritative sidecar data exists. Recovery-generated
`command.unknown` terminals are then persisted through the same exact-sidecar
path.

Before compaction covers a sequence, the runtime retries every dirty exact
outcome at or below the cutoff. If any covered key still lacks authoritative
durable replay data, compaction returns early and preserves the retained
journal event. A crash at any point therefore leaves either a durable exact
sidecar or a retained terminal journal event that compaction cannot erase.

### Preserve unresolved transactions through compaction

Extend the durable snapshot with bounded open transactions containing only the
sequence, command ID, raw idempotency key, and latest nonterminal kind needed
for restart matching. Tail terminal events override snapshot records. Otherwise
startup appends exactly one `command.unknown` before accepting new commands.
Open transactions remain bounded by the 256 pending-command cap.

This is still Task 2. When it lands, recovery-generated terminal events must
continue using Task 1's exact-sidecar durability path before later compaction
may cover them.

### Reclaim retired pane buffers

When a workspace no longer publishes a pane with active streams, mark it
retired and retain its buffer. Detach, legacy unsubscribe, and session-close
paths call one final-release check after removing their references. The final
release calls `forgetPane` and clears retirement. Republishing clears
retirement without discarding the live buffer.

This remains Task 3.

## Error Handling

- Exact sidecar lookup failures reject fresh execution explicitly; only
  `ENOENT` is treated as absence.
- Exact sidecar persistence failures preserve the appended terminal event and
  exact hot outcome, keep the key dirty, and defer compaction; they do not
  authorize re-execution.
- Oversized, malformed, key-mismatched, or invalid exact sidecars throw
  explicitly.
- A retained surface terminal event without an exact sidecar fails closed
  rather than reconstructing a generic result from redacted journal data.
- Task 1 keeps exact durable replay outside the snapshot sidecar field: new
  snapshots write `outcomes: {}` while Task 2 still adds bounded
  open-transaction evidence.
- Invalid open-transaction snapshot data is journal corruption.
- Pane cleanup is idempotent.

## Rejected Alternatives

- Compact markers or generic unknown placeholders for old keys weaken the
  approved exact-replay contract.
- Reconstructing surface outcomes from redacted terminal journal events can
  silently change user-visible results.
- Clearing a dirty exact outcome after a failed sidecar write permits
  compaction to erase the sole authoritative replay source.
- Persisting exact sidecars with no per-record size cap lets one command create
  an unbounded file.
- Expiring keys changes the no-double-execution contract.
- Pinning compaction behind one unresolved effect allows unbounded journal
  growth; bounded open-transaction records preserve the evidence instead.

## Validation

Regressions prove:

- an idempotency key older than 1,000 exact outcomes still deduplicates from
  its exact sidecar before and after restart and compaction;
- after a terminal append, injected sidecar persistence failure surfaces
  immediately, leaves dirty exact replay available without a second effect,
  makes later compaction defer without deleting the event, and succeeds after
  persistence is restored;
- a retained recovery-generated `command.unknown` is written to an exact
  sidecar before later compaction may cover it;
- a retained surface terminal event with no exact sidecar fails closed instead
  of reconstructing a generic outcome from redacted journal data;
- sidecars use `0700`/`0600` permissions, reject records larger than
  `8_781_824` bytes, and throw on malformed, mismatched, or invalid exact
  outcomes;
- Task 2 will verify unresolved commands recover exactly once; and
- Task 3 will verify retired buffers release only after the final stream or
  subscription.

## Scope

This repair already changes idempotency durability and redacted snapshot
persistence for exact terminal replay. Task 2 will later extend journal
recovery metadata for unresolved commands, and Task 3 will later change
closed-pane buffer ownership. The repair does not change command protocol
shapes, key expiration semantics, workspace publication, or live pane-stream
behavior.
