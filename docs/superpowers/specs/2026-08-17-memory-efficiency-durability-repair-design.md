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
requires evolving that store in place. A second completed-key directory would
make an existing b389-format compacted outcome invisible and could re-execute
its command.

The current sidecar write fsyncs the temporary file and renames it, but does
not fsync the containing directory. Rename alone is not a durability
acknowledgement.

## Decision

### Keep one compatible outcome namespace

Keep the existing path and hash:

```text
.psyche/runtime/outcomes/<sha256(idempotencyKey)>
```

`loadOutcome()` accepts a strict union:

- the exact b389 record, `{ idempotencyKey, outcome }`; or
- a versioned compact record containing the key digest, terminal sequence, and
  the fixed `unknown` outcome with code `idempotency_outcome_compacted`.

`storeOutcome()` continues to publish exact outcomes. Compaction rewrites an
exact record at the same path to the compact record before removing its
terminal event. Existing b389 records need no migration and remain
authoritative immediately after upgrade. Corrupt, mismatched, unreadable, or
unknown records fail closed before a fresh effect can run.

The hot exact cache remains capped at 1,000. Exact sidecar records are bounded
by the fixed 2,000-event compaction trigger plus at most 256 dirty or reserved
publications; after successful compaction, only the retained 1,000-event tail
remains exact. Older keys retain only compact outcomes.

### Make atomic publication crash durable

One injected publication helper serves exact outcomes and compact rewrites. It
does not resolve until:

1. required directories exist;
2. each newly created directory entry has been published by fsyncing its
   parent;
3. a unique same-directory temporary file is written completely;
4. the temporary file is fsynced and closed;
5. it is atomically renamed over the hashed destination; and
6. the outcomes directory is fsynced.

A rename followed by directory-fsync failure remains a failed publication.
The runtime keeps the terminal record dirty and compaction cannot cover it.
Tests use an injectable recording seam to verify ordering without depending on
whether the test platform supports opening directories. Production uses the
repository/platform directory-sync implementation; an unsupported platform
returns an error rather than silently weakening durability.

The same durable-replacement primitive publishes `snapshot.json` and compacted
`events.ndjson`. Snapshot publication fsyncs the runtime directory before
journal compaction starts. Journal replacement fsyncs it before retained
in-memory state changes or compaction reports success.

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
the hot cache or retained terminal event.

Before compaction covers a terminal event, the runtime:

1. flushes dirty exact records through the proposed cutoff;
2. rewrites each covered exact record to a compact outcome at the same path;
3. durably writes the redacted snapshot; and
4. compacts the journal.

Any failed flush or rewrite aborts the whole attempt, retains the terminal
event, sets `compactionBlockedByDurability`, and rejects new effects with
`durability_unavailable` until a later reservation successfully flushes the
dirty work. Retries already answerable from hot state, the journal tail, or
the sidecar remain available.

Startup scans retained terminal events. A missing sidecar becomes dirty and is
reconstructed from the retained event; lookup corruption aborts startup.
Existing b389 records load directly even when their terminal journal events
were already compacted.

### Keep snapshots redacted while preserving open transactions

Snapshots contain only owner epoch, covered sequence, bounded redacted receipt
records, and bounded open transactions. They omit exact outcomes, command
envelopes, live resources, effect data, messages, typed values, and scripts.

An open transaction contains only sequence, command ID, raw idempotency key,
and latest nonterminal kind. The raw key is the narrow exception needed for
restart matching. Tail terminal events override snapshot records. Otherwise
startup appends exactly one `command.unknown` before accepting new commands.
Open transactions remain bounded by the 256 pending-command cap, and
recovery-generated terminal events use the same sidecar durability gate.

### Reclaim retired pane buffers

When a workspace no longer publishes a pane with active streams, mark it
retired and retain its buffer. Detach, legacy unsubscribe, and session-close
paths call one final-release check after removing their references. The final
release calls `forgetPane` and clears retirement. Republishing clears
retirement without discarding the live buffer.

## Error Handling

- Outcome lookup errors reject fresh execution.
- Outcome persistence errors preserve the exact completed outcome and terminal
  evidence, remain dirty, log clearly, and defer compaction.
- Directory-sync failure is persistence failure even after rename.
- Invalid open-transaction snapshot data is journal corruption.
- Pane cleanup is idempotent.

## Rejected Alternatives

- A separate `.psyche/runtime/completed-keys` store is upgrade-unsafe.
- Bulk migration is unnecessary when the existing path can parse both shapes.
- Indefinite exact outcomes violate bounded exact retention.
- Clearing dirty state before directory fsync can erase the only durable
  idempotency evidence.
- Reporting metadata failure as command failure misstates an effect that
  already happened and encourages unsafe retries.
- Expiring keys changes the no-double-execution contract.
- Pinning compaction behind one unresolved effect allows unbounded journal
  growth; bounded open-transaction records preserve the evidence instead.

## Validation

Regressions prove:

- a manually written b389-format sidecar with no retained terminal event is
  loaded after upgrade and a real `pane.terminal.open` handler is not invoked;
- exact and compact records share one hashed path and corrupt variants fail
  closed;
- temp write, temp fsync, close, rename, and directory fsync occur in order,
  including parent fsync for a newly created outcomes directory;
- directory-fsync failure leaves terminal evidence ineligible for compaction;
- 999 successful terminal commands reach sequence 1,998, one dirty command
  reaches sequence 2,000, one trigger attempts compaction, the terminal event
  remains, and blocked submissions execute no effects;
- after persistence is restored, flush and compaction succeed, restart returns
  the compact outcome, and the original command's effect count remains one;
- unresolved commands recover exactly once;
- snapshots contain no exact or sensitive values except raw keys in bounded
  open transactions; and
- retired buffers release only after the final stream or subscription.

## Scope

This repair changes idempotency durability, journal recovery metadata, redacted
snapshot persistence, and closed-pane buffer ownership. It does not change
command protocol shapes, key expiration semantics, workspace publication, or
live pane-stream behavior.
