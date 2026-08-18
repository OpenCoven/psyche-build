# Psyche Control-Plane Architecture

Date: 2026-08-09
Status: Current (as of PR #51 — the `panes.meta` cutover)

This document is the consolidated, final-state reference for the Psyche host
control plane. It describes the architecture that exists after the multi-PR
cutover sequence completed: **every daemon mutation flows through a single
journaled authority, and no client — including the daemon's own connection
handler — is a trust boundary.**

For the per-slice history and rationale, see the plans and specs under
`docs/superpowers/`. This file is the durable "how it works now" overview; those
files are the "how we got here" record.

## The core invariant

> Every state-changing daemon operation is submitted to one `ControlRuntime`,
> which validates the owner epoch, enforces lane leases and pane scope, serializes
> per-pane work, journals the transaction durably, and only then drives a single
> concrete handler module to perform the real effect.

Concretely, `Connection.dispatch` in `src/daemon/index.ts` never touches a
mutation effect directly. Read-only operations (list/status/capture/snapshot)
stay direct; every mutation is a `submitControl(buildCommand(...))` call. This is
enforced by source-boundary tests (see [Enforcement](#enforcement)).

## Layers

The control plane is a stack. Requests flow inward toward the authority; effects
flow outward only from the innermost handler module.

```
             ┌─────────────────────────────────────────────────┐
  clients →  │  Transport                                        │
             │  • v0 WebSocket (Connection in src/daemon/index)  │
             │  • Canonical control socket (ControlServer)       │
             └───────────────────────┬─────────────────────────┘
                                     │ submit(command)
             ┌───────────────────────▼─────────────────────────┐
             │  Authority — ControlRuntime (src/control/runtime) │
             │  • owner-epoch check   • idempotency dedup         │
             │  • lane leases         • per-pane serialization    │
             │  • durable journal append (before effect)          │
             └───────────────────────┬─────────────────────────┘
                                     │ handlers.<effect>(payload)
             ┌───────────────────────▼─────────────────────────┐
             │  Effect boundary — createDaemonControlHandlers    │
             │  (src/daemon/controlHandlers.ts)                  │
             │  the ONLY module that calls tmux mutation verbs,  │
             │  spawnBridgePane, and Coven session mutations     │
             └───────────────────────┬─────────────────────────┘
                                     │
             ┌───────────────────────▼─────────────────────────┐
             │  Real effects: tmux, bridge, Coven, desktop       │
             └─────────────────────────────────────────────────┘
```

### 1. Transport

Two transports front the same runtime instance:

- **v0 WebSocket** — the legacy `coven.daemon.v1` connection handled by the
  `Connection` class in `src/daemon/index.ts`. Its `dispatch()` switch translates
  each wire message into a canonical command and calls `submitControl`.
- **Canonical control socket** — `ControlServer` (`src/control/server.ts`),
  mounted alongside the WSS in `runDaemon` (PR #45). It authenticates via the
  credential store (`src/control/credentials.ts`), then submits commands to the
  same `host.runtime`.

Because both transports share one runtime, a mutation from either path passes
through the identical authority checks and lands in the same journal.

### 2. Authority — `ControlRuntime`

`src/control/runtime.ts` is the single authority. `submit(command)`:

1. **Idempotency** — returns the prior `CommandOutcome` for a seen
   `idempotencyKey`, or joins an in-flight one (`pendingByIdempotencyKey`), so a
   retried command never double-executes. The in-memory
   `outcomesByIdempotencyKey` map is a bounded 1,000-entry hot cache; cold
   retries fall back to the retained journal tail and the journal's durable
   hash-addressed exact-outcome sidecar.
2. **Owner epoch** — rejects any command whose `ownerEpoch` is older than the
   current owner (`rejectStaleOwnerEpoch`), fencing out a superseded daemon.
3. **Lease + scope** — validates lane leases (`LaneLeaseStore`,
   `src/control/leases.ts`) and pane scope (`ControlScope`, `src/control/scope.ts`).
4. **Per-pane serialization** — `pane.*` commands are queued per `paneId`
   (`paneQueues`) so effects on one pane run in submission order; the queue can
   be blocked for takeover/delegate handshakes.
5. **Durable journal** — the transaction is appended to the `ControlJournal`
   (`src/control/journal.ts`) *before* the effect is considered committed, so a
   crash mid-flight is recoverable (`recoverNonterminalCommands` on startup).
   After a terminal append, the runtime remembers the exact outcome in memory,
   tracks it as dirty until temp-file fsync, atomic rename, and containing-
   directory fsync succeed, and refuses to compact that terminal key away until
   authoritative durable replay data exists. Terminal journal events also carry
   a SHA-256 digest of the exact `CommandOutcome`, and compaction verifies the
   retained event digest against the durable sidecar before dropping older
   evidence. Non-surface tail events can be reconstructed while they remain
   retained; ordinary surface tail events fail closed when their exact sidecar
   is missing or unverifiable. The one narrow exception is a recovery-generated
   `command.unknown` with `reason: recovered-nonterminal`, which is treated as
   an authoritative exact unknown, replayed from the retained journal, and kept
   dirty until persistence succeeds. Legacy pre-digest surface terminals can
   append a later digest attestation keyed by `(commandId, idempotencyKey)`
   once the exact sidecar is loaded, after which compaction may treat that
   attestation as the integrity source. Fresh execution shares one 256-slot
   durability budget across dirty terminal outcomes and active fresh
   reservations, so no new effect starts unless its terminal could still remain
   replayable if sidecar persistence fails. Once that shared budget is full,
   or compaction is already blocked on durability, new fresh commands are
   rejected with `durability_unavailable` until a later repair/flush succeeds,
   while hot/tail/sidecar retries remain available.
6. **Handler dispatch** — only then does it call the matching `ControlHandlers`
   method to perform the effect and shape the `CommandOutcome`.

Special flows (`pane.takeover`, `pane.delegate`, prompt dispatch via
`PromptDispatcher`) are handled inside the runtime rather than by a plain handler
call, because they coordinate lease ownership and no-replay prompt receipts.

### 3. Effect boundary — daemon control handlers

`createDaemonControlHandlers` (`src/daemon/controlHandlers.ts`) is the **single
module** that reaches real mutation effects. It implements the `ControlHandlers`
interface. Its doc comment is the canonical statement of this boundary: it is the
only place that calls `tmux.sendKeysHex`, `tmux.resizePane`, `tmux.selectPane`,
`tmux.killPane`, `spawnBridgePane`, and the Coven session mutations
(`launchProjectCovenSession`, `openProjectCovenSession`,
`routeProjectCovenSessionCapability`, desktop quick actions).

Commands the daemon does not yet translate return `command_not_supported` rather
than silently succeeding.

### 4. Host wiring & ownership

`createHostControlPlane` (`src/control/host.ts`) ties it together at daemon
startup:

1. `canonicalizeProjectRoot()` — fs-canonical (`realpath`, NFC on macOS) identity,
   so symlink aliases resolve to one project root. Every downstream key (owner
   lock, journal path, endpoint hash, session name) derives from this value.
2. `acquireOwnerLock()` — exclusive acquisition with monotonic epochs. A second
   live owner fails closed; a dead prior owner is replaced. The returned epoch is
   the `ownerEpoch` stamped on every command and checked by the runtime.
3. Open the journal for that epoch, run session bootstrap, and construct the
   `ControlRuntime`. On any failure the owner lock is released so the fence never
   leaks.

The `ControlServer` is mounted after the host plane is created and shares
`host.runtime`. Teardown is sequential (server closes before the host releases
the owner fence) so a successor daemon cannot race the socket bind.

## Command coverage

All of these mutation kinds are routed through the runtime (verified in
`src/daemon/index.ts`):

- **Pane effects:** `pane.spawn`, `pane.resize`, `pane.kill`, `pane.focus`,
  `pane.input`, `pane.takeover`, `pane.meta.update`.
- **Coven / desktop effects:** `coven.session.launch`, `coven.session.open`,
  `coven.capability.execute`, `coven.desktop.action`.

Read-only operations remain direct (and must stay reachable): `panes.list`,
`panes.status`, `panes.capture`, `coven.sessions.list`, `coven.desktop.state`,
`workspace.snapshot`, `projects.*`. Connection-local bookkeeping
(`panes.attach`/`panes.detach`) manages per-connection stream maps, not daemon
state, so it is correctly not a runtime command.

## Behavior-neutrality

The cutover preserved exact v0 wire behavior. Two patterns matter:

- **Outcome mapping.** A handler that throws a plain `Error` (no `.code`) yields a
  runtime `failedOutcome` with `code: 'command_failed'`; `sendControlError` maps
  `command_failed` to the case's fallback wire code (e.g. `meta_failed`,
  `focus_failed`, `kill_failed`). Handlers that attach a `.code` surface it
  directly.
- **Submit rejection vs. failed outcome.** `submit()` can *reject* (not just
  return a failed outcome) if runtime infrastructure fails — e.g. a journal append
  error in the per-pane queued path. Each mutating case wraps its submit in
  try/catch and sends a **correlated** error frame (`{type:'error', requestId,
  code:'…_failed'}`) on rejection, rather than letting the connection-level
  `internal_error` backstop send a frame with no `requestId`. This was the fix in
  PR #51 for `panes.meta`, matching the `pane.kill` sibling.

## Enforcement

Two source-boundary tests in `__tests__/daemon/controlAdapter.test.ts` read
`src/daemon/index.ts` and assert it does not call mutation effects directly:

- **Pane mutations** — a single forbidden pattern:
  `/this\.deps\.tmux\.(sendKeysHex|resizePane|selectPane|killPane)|spawnBridgePane\(|updatePaneMeta\(/`.
  The `updatePaneMeta\(` alternative is part of this same regex (the re-export
  `export { updatePaneMeta } from './bridge.js'` has no paren, so it does not
  match).
- **Coven mutations** — forbids `launchProjectCovenSession(`,
  `openProjectCovenSession(`, `routeProjectCovenSessionCapability(`,
  `buildDesktopUseQuickInput(`, and `this.deps.capabilityRouter`; while asserting
  the read-only `listProjectCovenSessions(` stays reachable.

These tests are the executable form of the core invariant: if a future change
reintroduces a direct-mutation bypass in the dispatch layer, the suite fails.

## Cutover history

| PR | Slice |
| --- | --- |
| Foundation | `src/control/` pure modules: contracts, owner fencing, journal, leases, scope, no-replay prompt dispatch (additive, no callers). |
| Runtime / PR 1 | `ControlRuntime` authority + host wiring. |
| Prompt dispatch / PR 2 | First real mutation (prompt dispatch) routed through the runtime. |
| Control socket / PR 3a | `ControlServer` + credential store built and unit-tested (dormant, no callers). |
| Daemon authority / PR 3b | Relocated effect functions (e.g. `spawnBridgePane`) to break import cycles; routed more mutations. |
| Coven session / PR 3c | Coven-session cutover; completed control-plane wiring. |
| Socket mount / #45 | Mounted `ControlServer` alongside the v0 WSS; canonical transport goes live. |
| `panes.meta` / #51 | Final direct daemon mutation cut over. Zero bypass paths remain. |

Relevant plans and specs:

- `docs/superpowers/specs/2026-08-05-psyche-control-plane-foundation-design.md`
- `docs/superpowers/specs/2026-08-08-control-socket-mount-design.md`
- `docs/superpowers/plans/2026-08-03-psyche-host-control-plane.md`
- `docs/superpowers/plans/2026-08-05-psyche-control-plane-foundation.md`
- `docs/superpowers/plans/2026-08-06-psyche-control-plane-wiring.md`
- `docs/superpowers/plans/2026-08-08-control-socket-mount.md`

## Related docs

- [Bridge security](BRIDGE-SECURITY.md)
- [Coven sessions](COVEN-SESSIONS.md)
