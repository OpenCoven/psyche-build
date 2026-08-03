# Psyche Soul Orchestrator Design

**Status:** Approved for autonomous planning  
**Date:** 2026-08-03

## Goal

Make Psyche the singular orchestrator through which a human operator can
develop software across many visible terminal lanes without surrendering
authority, observability, or recovery.

Psyche is the virtual "soul": it holds intent, plans work, watches execution,
decides when to continue, and explains the state of the whole effort. The
daemon is the nervous system: it owns authoritative runtime state, validates
commands, journals events, and controls tmux, worktrees, and optional Coven
sessions. Terminals and agent processes remain the body that performs work.

The design succeeds when one Psyche agent can:

1. Submit a goal and deterministically create one or more task lanes.
2. Observe lane output, status, attention, and lifecycle changes without
   relying on unbounded polling.
3. Send safe, attributable, idempotent input to the intended lane.
4. Continue, pause, interrupt, or cancel work according to an explicit
   autonomy policy.
5. Recover its task model after daemon or client restart without silently
   recreating or deleting resources.
6. Yield control immediately when the human operator intervenes.
7. Prove every decision and mutation through a bounded, replayable event
   journal.
8. Use the same control contract from the TUI, desktop app, MCP, iOS, and
   future relay clients.

## Existing Foundation

Psyche Build already has the correct execution primitives:

- typed task and lane contracts;
- deterministic planning and bounded-concurrency orchestration;
- isolated-worktree, shared-worktree, terminal, and Coven-session lanes;
- one generic agent launcher;
- daemon APIs for listing, capturing, attaching, sending input, resizing,
  focusing, killing, and spawning panes;
- tmux control-mode output streaming;
- two overlapping host protocols whose mutating paths must be converged before
  adding another controller;
- TUI-only status, attention, and notification services;
- MCP tools for task fan-out, pane creation, pane capture, pane termination,
  rituals, and worktrees;
- an approved unified-protocol, policy-engine, and event-journal direction in
  the native iOS/cloud terminal design.

The missing piece is not another launcher. It is a durable supervisory runtime
that joins these primitives into one resumable control loop.

## Approaches Considered

### 1. Let the Psyche agent drive tmux directly

Expose pane capture and raw send-keys tools, then let the model infer state from
terminal text.

This is fast to prototype but too brittle as the primary architecture. Raw
terminal output is not a lifecycle contract, retries can duplicate input, two
controllers can type concurrently, and restart recovery depends on guessing
from scrollback.

### 2. Make Coven the mandatory orchestration authority

Represent every lane as a Coven session and use Coven's ledger and lifecycle as
the only runtime.

This gives a strong managed-session model but breaks Psyche Build's standalone
promise, excludes ordinary tmux terminals, and couples local cockpit behavior
to a separately versioned runtime.

### 3. Add a daemon-centric soul runtime

Keep tmux, worktrees, and Coven as execution providers. Add a durable,
transport-independent supervisory runtime inside the Psyche daemon. The
Psyche agent interacts with typed tasks, commands, events, approvals, and
leases rather than shelling out to tmux directly.

This is the selected approach. It reuses the implemented orchestration core,
matches the approved unified-protocol direction, preserves standalone use, and
creates a clean seam for desktop, mobile, MCP, and cloud relay clients.

## Architecture

```text
Human operator
      |
      v
Psyche agent (intent, planning, synthesis, explanation)
      |
      v
Soul runtime (task state machine, policy, leases, reconciliation)
      |
      +---- command bus ----> orchestration core / pane controller / Coven
      |
      +<--- event journal --- tmux output / lifecycle / attention / approvals
      |
      v
TUI, desktop, MCP, iOS, and relay adapters
```

### Authority boundary

The Psyche agent is cognitive but not authoritative. It may propose plans and
commands, but the soul runtime decides whether a command is valid under the
current project scope, task ownership, lease, expected state, autonomy profile,
and approval policy.

One long-lived host daemon process is the sole owner of the soul runtime,
journal, policy engine, and mutable terminal control. MCP runs as a client of
that daemon rather than constructing an in-process orchestrator. The TUI,
desktop bridge, mobile bridge, current daemon v0 protocol, and future relay all
invoke the same host owner through one internal protocol. Compatibility
adapters may translate messages but cannot mutate tmux, worktrees, config, or
Coven sessions directly.

The host owner acquires an operating-system lock for the project runtime and
records an owner epoch. A second process may serve read-only cached data, but it
must reject mutations. Takeover requires proving the previous owner is dead,
acquiring the lock, incrementing the epoch, restoring the journal, and
reconciling live resources before accepting commands.

Git, tmux, and Coven remain authoritative for their own resources. The journal
records what the daemon observed and requested; it does not pretend cached
state is live.

### Soul runtime

Add `src/soul/` as a transport-independent domain layer:

- `types.ts` defines goals, tasks, commands, events, approvals, leases, and
  snapshots.
- `runtime.ts` owns the task state machine and command dispatch.
- `policy.ts` classifies and authorizes operations.
- `leases.ts` prevents conflicting terminal controllers.
- `journal.ts` appends events and restores snapshots.
- `reconcile.ts` compares journal state with tmux, Psyche config, worktrees,
  and Coven.
- `attention.ts` converts runtime and terminal signals into structured
  attention events.
- `agentLoop.ts` hosts a provider-neutral Psyche continuation loop.

The domain layer does not import WebSocket, MCP framing, React, Ink, Swift, or
Cloudflare code.

## Provisioning and Task Models

The existing `Orchestrator` is a provisioning coordinator. Its `completed`,
`partial`, and `failed` results mean that requested panes, worktrees, or Coven
sessions were or were not created. They do not describe whether coding work
succeeded.

The soul runtime introduces a separate `SoulTask` lifecycle. A `SoulTask`
references the provisioning task and lane identities that embody it, but never
reuses provisioning status as work status. Provisioning results produce
`task.resourcesReady`, `task.resourcesPartial`, or `task.resourcesFailed`
events that drive the durable task transition.

A goal is durable operator intent. The Psyche agent decomposes it into tasks.
Each task contains:

- stable goal, task, trace, and optional parent-task identities;
- project root and optional scoped cwd;
- objective and success criteria;
- lane requests and expected outputs;
- autonomy profile;
- current state and reason;
- creation, update, and terminal timestamps;
- last acknowledged event sequence;
- optional approval and blocker references.

Task states are:

```text
proposed -> planned -> provisioning -> running <-> waiting
   |          |             |             |
   |          |             v             v
   |          |           blocked <---- paused
   |          |             |             ^
   |          |             v             |
   +----------+---------> cancelling <-----+
                              |
                              v
                          cancelled

running/waiting/blocked/paused -> completed | failed
any non-terminal state -> unknown -> reconciled prior state | failed | cancelled
```

`pausing` and `cancelling` are represented as command outcomes while the task
remains in its current state; the task enters `paused` or `cancelled` only when
the runtime has fenced further automation and recorded the transition.
`stale` and `orphaned` describe resource health, not task state. Reconciliation
may move a task to `unknown` when resource truth is ambiguous.

Terminal states are immutable except for appended annotations. Transitions are
explicit events. A task cannot become completed merely because a pane is idle;
completion requires declared success evidence or an operator decision.

Command outcomes are a separate state machine:

```text
requested -> rejected
requested -> accepted -> running -> succeeded | failed | unknown
```

An `unknown` command must reconcile or receive an operator resolution. It is
never automatically retried.

## Typed Command Bus

Psyche controls runtime resources through typed commands, not arbitrary tmux
strings. Initial commands are:

- `task.submit`
- `task.pause`
- `task.resume`
- `task.cancel`
- `lane.create`
- `lane.sendPrompt`
- `lane.interrupt`
- `lane.takeover`
- `lane.focus`
- `lane.resize`
- `lane.close`
- `approval.resolve`
- `runtime.reconcile`

Every mutation includes:

- command id and idempotency key;
- goal, task, and trace identity;
- expected project, pane, session, and lease identity;
- expected state or revision when applicable;
- policy classification;
- actor identity;
- creation and expiry timestamps.

The daemon records `command.requested`, then either `command.rejected` or
`command.accepted`, followed by running and terminal success, failure, or
unknown outcome. Unknown outcomes must reconcile or be resolved by the
operator; they are not retried automatically.

Raw terminal bytes remain available only as a low-level attached-terminal
operation. The Psyche agent normally uses `lane.sendPrompt` or
`lane.interrupt`, whose semantics and retry behavior are testable.

`lane.sendPrompt` uses a prompt envelope containing:

- stable prompt id and idempotency key;
- exact UTF-8 bytes and content hash;
- target pane, harness, task, lease, and owner epoch;
- expected readiness revision;
- transport and submit mode;
- creation and expiry timestamps.

The intent is journaled before dispatch. A duplicate idempotency key returns
the recorded dispatch outcome and never types the prompt again. Tmux
acceptance proves only that bytes were submitted to tmux. Delivery is
`confirmed` only when a harness-level receipt or turn marker references the
prompt. Generic terminals and harnesses without receipts report `dispatched`
or `unknown`; after a crash or ambiguous disconnect, Psyche must request
operator resolution and must not replay the prompt, Enter, or control bytes.

## Controller Leases and Human Preemption

Each mutable lane has at most one automation lease:

- leases name the actor, task, pane, revision, acquisition time, and expiry;
- commands must present the current lease revision;
- leases renew only while the owning task is live;
- disconnect does not grant another controller permission to replay ambiguous
  input;
- a runtime-observed human takeover or human input through the protocol revokes
  or suspends the automation lease before accepting more automation input;
- the operator can pause or revoke Psyche globally or per task;
- human commands always take precedence over model continuation.

This prevents two agents, two clients, or a reconnecting client from typing
into the same terminal concurrently.

Tmux does not expose arbitrary keystrokes entered by a separately attached
local client. Therefore the runtime cannot promise to detect every out-of-band
human keystroke immediately. The supported fencing guarantee is:

1. interactive clients invoke `lane.takeover` before enabling input;
2. any human input received through the protocol implicitly performs takeover;
3. accepted takeover revokes the automation lease and drains the serialized
   automation input queue;
4. automation remains suspended until the operator explicitly delegates again.

The TUI and desktop clients must use this path before interactive input.
Out-of-band direct tmux attachment is reported as an unsafe bypass in delegated
mode; Psyche does not claim collision-free automation when clients bypass the
host owner.

## Autonomy Policy

Projects select one of three profiles:

| Profile | Behavior |
|---|---|
| `observe` | Psyche may read state and explain it, but cannot mutate runtime resources. |
| `guided` | Psyche may propose commands; each mutation requires operator approval. |
| `delegated` | Psyche may perform reversible, task-scoped commands within declared bounds. |

Even under `delegated`, merge, push, PR creation, branch/worktree deletion,
credential use, publishing, policy changes, and other external or destructive
actions require an explicit approval challenge. The relay or a capability
provider can never broaden host policy.

Policy decisions are events with the matched rule and bounded explanation.
There is no silent fallback from a rejected command to raw send-keys.

## Event Journal

The daemon writes an append-only per-project journal under `.psyche/runtime/`.
The first implementation uses newline-delimited JSON plus atomic JSON
snapshots, avoiding a new native database dependency in the Node 18 package.
The project lock and owner epoch fence the sole writer.

Each event has:

- monotonic sequence;
- event id, timestamp, schema version, and project identity;
- goal, task, trace, lane, pane, session, command, and actor references when
  applicable;
- event kind and bounded payload;
- causation and correlation ids.

Core event families are:

- goal and task transitions;
- command lifecycle;
- lane and process lifecycle;
- terminal output cursor and gap metadata;
- attention and completion evidence;
- lease acquisition, renewal, preemption, and expiry;
- approval request and resolution;
- reconciliation findings;
- policy decisions;
- runtime errors.

Terminal transcripts are not copied wholesale into the journal. The journal
stores bounded summaries, hashes, byte/sequence cursors, and explicit snapshots
only when required for recovery. This preserves local-first privacy and
prevents unbounded growth.

Snapshots compact task, lease, approval, and cursor state. Startup loads the
latest valid snapshot, replays later events, and then reconciles with live
resources.

Journal writes append a complete line, flush it before exposing success, and
advance snapshot metadata only after the snapshot is atomically renamed and
its covered sequence is durable. Startup truncates only an incomplete final
line; corruption earlier in the journal stops mutation and preserves the
files for recovery.

## Event-Driven Attention

Move attention detection behind a reusable headless interface. The pipeline
combines:

1. deterministic lifecycle signals from tmux and Coven;
2. output activity and quiescence windows;
3. prompt/permission markers from known harnesses;
4. process exit and pane disappearance;
5. optional bounded LLM analysis for human-readable summaries.

The deterministic classification is authoritative. LLM output may improve the
title, summary, or proposed next action, but cannot manufacture completion or
approval.

The daemon publishes structured events such as `lane.working`,
`lane.waiting`, `lane.attention`, `lane.exited`, and `lane.outputGap`.
Clients subscribe from a sequence cursor instead of each implementing their
own polling loop.

## Psyche Agent Loop

The provider-neutral loop operates as follows:

1. Read the goal, current snapshot, pending approvals, and new events.
2. Produce a bounded plan or continuation proposal.
3. Convert the proposal into typed commands.
4. Submit commands to the soul runtime.
5. Wait on events rather than repeatedly capturing every pane.
6. When attention arrives, inspect bounded output or diffs and decide whether
   to continue, block, complete, or request operator input.
7. Record a checkpoint with evidence and the single next action.
8. Yield immediately on policy denial, human preemption, ambiguous execution,
   or exhausted retry budget.

Provider output cannot replace project, worktree, pane, session, actor, lease,
or policy identity supplied by the runtime.

## Unified Protocol

Define one canonical, versioned host protocol with owned schemas, capability
negotiation, request ids, idempotency keys, owner epochs, and explicit
compatibility rules. It has four surfaces:

- request/response commands;
- ordered server events with replay cursors;
- byte-oriented terminal streams;
- approval challenges and resolutions.

The protocol exposes task, command, journal, lease, and reconciliation
operations. The current daemon v0, mobile bridge v2, and MCP tools become
compatibility adapters. They must call the long-lived host owner instead of
bypassing it for mutations.

All control events share one per-project sequence domain. Terminal byte streams
use independent per-stream byte sequences and reference the current owner
epoch. Version negotiation must reject unsupported mutation semantics rather
than silently downgrade. The v0 and v2 adapters can be retired only after the
TUI, desktop, mobile, and MCP callers pass the same protocol fixtures and no
direct mutating imports remain.

MCP remains useful as the agent-facing adapter, but gains task status, event
read, prompt send, interrupt, approval, and cancellation tools. It does not
become the source of truth.

## Recovery and Reconciliation

On daemon startup or explicit reconcile:

1. restore the latest valid snapshot and replay later events;
2. enumerate configured panes, live tmux panes, worktrees, and Coven sessions;
3. bind resources only when identity and project scope match;
4. mark missing or contradictory resources as stale, orphaned, or unknown;
5. expire abandoned leases;
6. emit reconciliation findings;
7. require approval before recreating or deleting anything.

Restart recovery never silently resends terminal input. Commands left in an
accepted or running state become `unknown` until live state proves the result.

## Data and Privacy

- Runtime state is project-local by default.
- Full terminal transcripts are not journaled by default.
- Events and logs redact secrets and infrastructure URLs.
- Project-root and worktree containment apply to every command.
- Bounded retention and compaction prevent the journal from growing forever.
- Future cloud relay transports encrypted protocol frames and cannot authorize
  commands rejected by the host.

## Failure Handling

- Invalid commands fail before side effects.
- Duplicate idempotency keys return the original outcome.
- A lease mismatch fails closed.
- Input disconnect after an unacknowledged send produces an unknown outcome,
  not success.
- Slow event consumers receive an explicit gap plus a fresh snapshot.
- Journal corruption stops mutation, preserves the damaged files, and reports
  a recovery action.
- Psyche agent failure does not stop terminal lanes.
- Daemon failure does not kill tmux or Coven processes.
- Successful sibling lanes remain usable when one lane fails.

## Delivery Programs

The work is intentionally split into two independently shippable
implementation plans. Program A must land before Program B begins.

### Program A: Canonical host control plane

#### Checkpoint A0: Host ownership and protocol contracts

Define the canonical protocol, project lock, owner epoch, sequencing domains,
provisioning-versus-work identity mapping, command outcomes, prompt envelopes,
and compatibility fixtures.

#### Checkpoint A1: Command journal and safe terminal control

Define task, command, event, approval, lease, and snapshot contracts. Add the
single-writer journal, replay, compaction, idempotency records, and corruption
handling. Implement serialized input, prompt dispatch outcomes, explicit
takeover, and lease fencing.

#### Checkpoint A2: Mutation convergence

Route daemon v0, mobile bridge v2, MCP, TUI, and desktop mutations through the
host owner. Remove direct mutation bypasses and prove compatibility with the
existing pane, worktree, and Coven behavior.

Program A is complete when one host owner exclusively controls mutations,
duplicate prompts cannot be replayed, runtime-observed human takeover fences
automation, and every client uses the same protocol contract.

### Program B: Durable Psyche supervision

#### Checkpoint B1: Task runtime and reconciliation

Implement the complete `SoulTask` state machine, policy engine, approvals,
startup reconciliation, resource health, and operator resolution of unknown
outcomes.

#### Checkpoint B2: Headless attention and events

Extract deterministic attention classification from the TUI, publish ordered
events, add replay subscriptions, and converge client attention state.

#### Checkpoint B3: Psyche continuation loop

Add the provider-neutral agent loop, bounded context assembly, typed command
generation, checkpointing, retry budgets, and human preemption behavior.

#### Checkpoint B4: Dogfood and client convergence

Route the TUI and desktop cockpit through the shared task/event surfaces,
preserve compatibility adapters, and prove one Psyche agent can supervise a
multi-lane development task end to end.

Cloud relay and managed cloud workspaces remain separate follow-on milestones.

## Validation Loop

Each checkpoint in both programs must complete this loop:

1. Add contract tests before implementation.
2. Implement through injected adapters, not real global state.
3. Run focused unit and protocol tests.
4. Run real-tmux integration tests in a temporary Git repository and isolated
   tmux server.
5. Exercise duplicate delivery, daemon restart, event-gap recovery, lease
   conflict, human preemption, partial lane failure, and journal corruption.
6. Run:

   ```sh
   pnpm run typecheck
   pnpm test
   pnpm run build
   pnpm smoke
   npm pack --dry-run
   ```

7. Review the diff for bypasses around policy, journal, or project scope.
8. Update the durable goal with evidence and the next single action.

The final end-to-end proof is:

1. Start Psyche in a temporary project.
2. Submit one goal that creates at least two isolated agent lanes.
3. Observe both through ordered events.
4. Let Psyche send a continuation prompt to one waiting lane.
5. Invoke takeover, type manually into that lane, and verify automation is
   fenced before the human input is accepted.
6. Restart the daemon and restore task, cursor, approval, and lease state
   without replaying input.
7. Complete one lane, fail the other, and report a truthful partial result.
8. Attempt a destructive action and verify an explicit approval challenge.
9. Cancel the goal and verify processes and worktrees remain governed by the
   declared cleanup policy.

## Non-Goals

- Replacing tmux, Git worktrees, or Coven.
- Giving an LLM direct unbounded shell authority.
- Automatic merge, push, publication, or deletion approval.
- Uploading full source trees or terminal transcripts by default.
- Requiring cloud connectivity.
- Building a second orchestration core for desktop or mobile clients.
