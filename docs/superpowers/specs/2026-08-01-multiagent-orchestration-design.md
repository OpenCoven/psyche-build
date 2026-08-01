# Multiagent Orchestration Rewrite Design

**Status:** Approved for autonomous implementation  
**Date:** 2026-08-01

## Goal

Make comux's multiagent behavior one coherent system instead of a collection of
TUI-only launch loops, daemon-specific pane spawning, partially stubbed MCP
tools, and an unmerged capability-routing seam.

The rewrite is successful when:

1. A single typed task request can launch one or many agent lanes.
2. Each lane declares whether it uses an isolated worktree, an existing
   worktree, a plain terminal, or a Coven-managed session.
3. TUI, daemon, and MCP callers use the same orchestration service and receive
   the same structured result and errors.
4. Agent startup and prompt delivery use one implementation for every
   registered agent.
5. Partial multi-lane failures are explicit, successful lanes remain usable,
   and failed lane resources are cleaned up.
6. Provider capability routing is optional, session-scoped, fail-closed, and
   unable to replace authoritative project, worktree, session, or harness
   identity.
7. Documentation describes the implemented behavior without obsolete A/B-only
   terminology or stubbed feature claims.

## Current State

comux already has the required primitives, but orchestration is fragmented:

- `createPane()` owns worktree creation, hooks, pane layout, and the most
  complete agent launch path.
- `usePaneCreation()` implements multi-select fan-out, concurrency, persistence,
  cleanup scheduling, and status messages inside a React hook.
- `attachAgentToWorktree()` duplicates pane setup and calls an older launch
  helper that supports only Claude, Codex, and OpenCode.
- `spawnBridgePane()` provides a separate daemon path with different behavior.
- MCP advertises create and kill tools, but both are stubs.
- The `feat/psyche-capability-seam` branch adds a useful provider-neutral
  capability router, but it is not connected to a shared execution model.
- Public docs alternate between A/B pairs, arbitrary multi-select launches,
  shared-worktree collaboration, and future orchestration claims.

## Approaches Considered

### 1. Shared orchestration core with backend adapters

Create a typed core that validates requests, expands lanes, coordinates
bounded concurrency, delegates resource work to injected backends, and returns
structured results. Existing tmux/worktree and Coven functions become backend
adapters. TUI, daemon, and MCP become transport adapters.

This is the recommended approach. It removes duplicated policy while preserving
the reliable implementation and avoiding a risky rewrite of tmux, git, or
Coven internals.

### 2. Make Coven the only orchestration runtime

Route every agent through Coven and reduce comux to a cockpit. This would
produce a clean long-term authority boundary, but it would break comux's
standalone promise, require upstream APIs that are not stable in this
repository, and make local pane/worktree workflows depend on Coven.

### 3. Keep separate surfaces and extract selected helpers

Share prompt delivery and agent registry utilities while leaving TUI, daemon,
and MCP orchestration independent. This is lower risk initially, but it keeps
different validation, concurrency, persistence, and error behavior. It does
not satisfy a comprehensive rewrite.

## Architecture

### Orchestration core

Add `src/orchestration/` as the policy layer:

- `types.ts` defines task, lane, result, trace, and error contracts.
- `planner.ts` validates a task and expands it into deterministic lane plans.
- `orchestrator.ts` executes lane plans with bounded concurrency and stable
  result ordering.
- `capabilityRouter.ts` provides optional provider-neutral task refinement.
- `localPaneBackend.ts` adapts existing pane/worktree primitives.

The core does not import React, Ink, WebSocket, MCP framing, or popup code.
Transport-specific status copy and UI decisions remain outside it.

### Task request

An orchestration request contains:

- stable `taskId` and optional `traceId`;
- project root and optional cwd;
- prompt and optional display title;
- one or more lane requests;
- optional start-point branch and merge target chain;
- optional capability refinement request;
- optional concurrency limit.

Each lane contains:

- stable lane id;
- agent or terminal selection;
- execution mode: `isolated-worktree`, `shared-worktree`, `terminal`, or
  `coven-session`;
- optional existing worktree identity;
- optional permission mode.

The planner rejects duplicate lane ids, unknown agents, missing shared
worktrees, unsafe paths, invalid concurrency, and incompatible fields before
starting resources.

### Execution result

The orchestrator returns a task result containing:

- task and trace identity;
- ordered per-lane results;
- status: `completed`, `partial`, or `failed`;
- created pane, worktree, branch, or Coven session identity;
- structured lane errors;
- start and completion timestamps.

Multi-lane execution is intentionally not transactional. If one lane fails,
successful lanes remain available for inspection. The failed lane must clean
up resources it created before reporting failure.

### Local pane backend

Refactor the current complete `createPane()` path rather than replacing it.
The backend will:

1. resolve and validate project scope;
2. create or reuse the requested worktree;
3. create and lay out the tmux pane;
4. run lifecycle hooks;
5. launch the selected agent through one shared launcher;
6. return the complete `ComuxPane`.

Shared-worktree attachments use the same backend with an existing-worktree
lane. This removes the current duplicate attach implementation.

The backend accepts persistence callbacks so the TUI can batch-save all lanes,
while daemon and MCP callers can persist through the same config helpers.

### Agent launching

`agentLaunch.ts` remains the registry and command-building authority. Replace
the partial `launchAgentInPane()` implementation with the generic launch path
currently embedded in `createPane()`, including:

- prompt-file transport with safe inline fallback;
- positional, option, stdin, and send-keys transports;
- per-agent permission flags;
- Codex hooks;
- Gemini trust setup;
- Claude workspace trust handling.

New worktree lanes and shared-worktree lanes must call this same function.

### Capability routing

Integrate the provider-neutral router from `feat/psyche-capability-seam` with
these constraints:

- `coven-native` remains the default pass-through strategy.
- `psyche` is a registration point, not a bundled implementation.
- explicit unavailable or unsupported providers fail closed.
- provider output may refine prompt, title, state, and state delta.
- provider output cannot replace project root, cwd, lane mode, worktree,
  session id, or harness.
- session-scoped routes execute only for live Coven sessions.
- traces include provider, tool calls, deltas, evaluations, attempts, and
  idempotency identity.

Capability refinement happens before lane execution. For a Coven session
request, the authoritative session is fetched and validated before routing.

### Transport adapters

#### TUI

`usePaneCreation()` will translate UI selections into an orchestration request,
display progress, save successful panes once, schedule worktree pruning, and
render partial-failure status. It will not own fan-out policy.

The attach-agent flow will submit shared-worktree lanes instead of directly
constructing panes.

#### Daemon

Add task execution request/result messages to the authenticated protocol.
Retain existing `panes.spawn` compatibility by translating it to a one-lane
task. Add capability execution using the shared router and scoped Coven
session lookup.

#### MCP

Replace the create-pane stub with a task-oriented tool that accepts one or more
lanes. Keep `comux_create_pane` as a compatibility alias for a one-lane task.
Wire pane termination to the existing bounded daemon/config behavior rather
than advertising a stub. Tool results return structured JSON.

## State and Compatibility

`ComuxPane` remains the persisted pane record. Add optional orchestration
metadata only where needed:

- task id;
- lane id;
- trace id;
- execution mode.

Existing config files without these fields continue to load. Existing TUI
shortcuts and single-agent creation remain behavior-compatible. `panes.spawn`
and `comux_create_pane` remain available as compatibility entry points.

No migration is required for Coven's session store or launch payload.

## Error Handling

Use a shared `OrchestrationError` with stable codes for invalid requests,
scope violations, unsupported agents or modes, provider failures, resource
creation failures, and persistence failures.

Rules:

- validate the complete plan before creating the first lane;
- never silently fall back from an explicitly selected provider or agent;
- never launch an agent in the main checkout after worktree failure;
- clean up a failed lane's pane and newly created worktree;
- preserve successful sibling lanes and report `partial`;
- log full internal errors while returning bounded user-facing messages;
- do not swallow config persistence failures after resources are created.

## Documentation Rewrite

Rewrite the public multiagent documentation around four concepts:

1. **Task** — one requested outcome.
2. **Lane** — one agent or terminal execution path.
3. **Isolation mode** — separate worktrees, shared worktree, terminal, or
   Coven-managed session.
4. **Integration** — inspect, compare, merge, PR, archive, or clean up.

Update:

- root README;
- product spec;
- multi-agent guide;
- workflows;
- core concepts;
- Coven sessions guide;
- MCP usage documentation;
- docs navigation text where terminology appears.

Remove A/B-specific claims unless presented as a two-lane example. Clearly
label Coven and Psyche as optional integrations and distinguish implemented
features from extension points.

## Testing and Validation

### Unit tests

- task validation and deterministic lane expansion;
- bounded concurrency and stable result ordering;
- complete, partial, and failed task outcomes;
- no provider fallback and authority-field protection;
- generic launch behavior for every prompt transport;
- shared-worktree lane behavior and sibling slug generation;
- compatibility translations for TUI, daemon, and MCP requests.

### Integration tests

- daemon task dispatch with injected backends;
- one-lane `panes.spawn` compatibility;
- session-scoped capability routing;
- MCP tools list and task execution responses;
- config persistence for orchestration metadata.

### Repository checks

Run:

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm run smoke:pack
```

The final review must also search for stale `STUB`, `A/B pair`, and
`wiring in progress` claims and inspect the diff for duplicated orchestration
policy.

## Implementation Sequence

1. Land and harden capability-routing contracts.
2. Add orchestration types, planner, and coordinator with injected backends.
3. Centralize generic agent launch and shared-worktree execution.
4. Adapt TUI creation and attachment flows.
5. Add daemon task messages and compatibility translation.
6. Wire MCP task creation and pane termination.
7. Rewrite public documentation.
8. Run targeted and full validation, then remove obsolete code paths.
