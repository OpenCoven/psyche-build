# Psyche Control-Plane Wiring Plan

**Status:** Draft
**Depends on:** `feat/control-foundation` (PR #35) merged to `main`
**Design:** `docs/superpowers/specs/2026-08-05-psyche-control-plane-foundation-design.md`
**Parent plan:** `docs/superpowers/plans/2026-08-03-psyche-host-control-plane.md` (Tasks 5-tail, 6, 7)

## Purpose

The foundation PR shipped the pure `src/control/` modules (contract, codec, owner
fence, journal, leases, scope, prompt dispatch) with **zero runtime behavior
change** — nothing imports them yet. This plan wires those modules into the live
daemon so the Psyche host boundary actually governs pane control, and it clears
the review findings that were deliberately deferred from the foundation slice.

Unlike the foundation slice, **this work IS behavior-changing.** Every step must
preserve existing daemon/MCP/bridge behavior for current clients (v0 protocol)
while routing all pane mutations through the control runtime as the single
authority. The Rust/daemon authority principle holds: clients never become the
trust boundary.

## Guiding constraints

- **Additive-then-cutover per surface.** Introduce the runtime path behind the
  existing entry points, prove parity with tests, then remove the direct-mutation
  path. Never leave two authorities live for the same mutation.
- **Behavior parity gate.** `pnpm test`, `pnpm smoke`, and `pnpm build` stay green
  at every PR boundary. The 3 known-failing macOS release-tooling tests
  (`appStoreConnect`, `releaseWorkflow` — BSD `stat '%Lp'`) are pre-existing and
  out of scope.
- **Single owner.** The daemon acquires the `ownerLock` fence at startup and
  threads its `ownerEpoch` into every command. Stale-epoch commands are rejected
  before any side effect.
- **No-replay.** Every mutation carries an idempotency key; the journal
  deduplicates so a client retry never double-submits.
- **TDD + subagent-driven.** Each task: implementer -> spec review -> code-quality
  review -> TDD fixes -> plan sync. Use `pnpm` only (never `npm`).

## Slice sequencing (three shippable PRs)

The parent plan's Tasks 6-7 are too large for one review. Split into three PRs,
each independently mergeable and behavior-safe:

### PR 1 — Host runtime (parent Task 6) + deferred foundation findings

**Goal:** stand up `ControlRuntime` as the in-process authority that owns the
journal, leases, scope, and prompt dispatch, driving injected handler spies. No
daemon wiring yet — the runtime is exercised only by unit tests, so this PR is
still behavior-neutral for live clients.

**Files (create unless noted):**
- `src/control/runtime.ts` — `ControlRuntime.create({ ownerEpoch, handlers, journal })`;
  `submit(command)` with idempotency dedup, stale-epoch rejection, lease
  revoke-before-human-input, scope enforcement, prompt dispatch integration.
- `src/control/host.ts` — host lifecycle wrapper (fence acquire/release, journal
  open, runtime construction).
- `src/control/resources/panes.ts`, `resources/coven.ts`,
  `resources/sessionBootstrap.ts` — resource registries the runtime consults.
- Modify `src/orchestration/bridgePaneBackend.ts`,
  `covenSessionBackend.ts`, `localPaneBackend.ts` — expose the handler surface
  the runtime calls, without changing their current callers yet.
- `__tests__/controlRuntime.test.ts` — the parent-plan runtime spec (idempotency,
  stale epoch, automation-revoke-before-human, scope rejection).

**Deferred foundation findings folded in here (they belong to the runtime layer):**
- Protocol decode: full request-variant schema validation (foundation Task 1
  deferral) — validate every `ControlCommand` variant payload, not just
  `command.submit`.
- OwnerLock: orphaned candidate-dir reaping + PID-reuse false-positive handling
  (foundation Task 2 deferral) — the host runtime owns lock lifecycle, so harden
  it here.
- Types: add `actorKind` to `ControlSnapshot.leases` value type (final-review
  Minor) so snapshots can surface human-vs-automation control.

**Behavior impact:** none for live clients (runtime not yet on the daemon path).

### PR 2 — Prompt dispatch cutover (parent Task 5-tail)

**Goal:** route real prompt submission through `PromptDispatcher` at the tmux
boundary — the one live-code change deferred from the foundation slice.

**Files:**
- Modify `src/services/tmuxControl.ts` — add acknowledged control-mode submission
  that computes the content hash, calls the dispatcher, and maps
  `dispatched/confirmed/failed/unknown` onto the existing send path. `unknown`
  (ambiguous acceptance) must NOT auto-retry.
- Modify `__tests__/services/tmuxControl.test.ts` — parity + ambiguity tests.

**Behavior impact:** prompt sends now integrity-checked and no-replay-safe;
externally observable behavior for a well-formed prompt is unchanged.

### PR 3 — Daemon + client exposure (parent Task 7)

**Goal:** make the daemon translate its v0 protocol messages into control
commands submitted to the runtime, and remove all direct pane-mutation calls from
`Connection.dispatch`. This is the authority cutover.

**Files (create unless noted):**
- `src/control/endpoint.ts` — project-scoped canonical endpoint (socket path).
- `src/control/server.ts` — control server bound to the runtime.
- `src/control/client.ts` — in-process/socket client used by the daemon adapter.
- `src/control/credentials.ts` — endpoint credential handshake.
- Modify `src/daemon/index.ts` — translate `panes.input` -> `pane.takeover` +
  `pane.input`; `panes.spawn` -> `pane.spawn`; `panes.kill` -> `pane.kill`; etc.
- `__tests__/controlClient.test.ts`, `__tests__/controlCredentials.test.ts`,
  `__tests__/daemon/controlAdapter.test.ts` — translation + the source-boundary
  assertion that `Connection.dispatch` contains no direct
  `tmux.sendKeysHex|resizePane|selectPane|killPane` or `spawnBridgePane(` calls.

**Behavior impact:** all pane mutations now flow through the single authority.
v0 clients keep working; the daemon becomes a translation adapter.

## Out of scope (later parent-plan tasks, separate plans)

Parent Tasks 8-11 are NOT in this plan:
- Task 8 — mobile bridge v2 -> adapter
- Task 9 — MCP -> agent-facing control adapter
- Task 10 — TUI provisioning through the host owner
- Task 11 — restart/takeover/compatibility proof

Also out of scope: the Psyche model loop, task completion, LLM summaries, cloud
relay, merge automation (Program B onward).

## Validation (every PR)

1. `pnpm typecheck` -> clean
2. Focused new suite for the PR -> all pass
3. `pnpm test` -> no regressions beyond the 3 pre-existing macOS failures
4. `pnpm smoke` -> pass
5. `pnpm build` -> pass
6. Final whole-PR code review before merge

## Risks

- **Double-authority window.** Mitigation: additive-then-cutover per surface;
  the PR-3 source-boundary assertion mechanically forbids leftover direct
  mutations.
- **Owner-fence startup ordering.** The daemon must acquire the fence before
  accepting connections; a failed acquire must fail startup loudly, not fall back
  to unfenced mutation.
- **v0 translation gaps.** Every v0 message type needs an explicit mapping test;
  an unmapped type must reject, not silently no-op.
