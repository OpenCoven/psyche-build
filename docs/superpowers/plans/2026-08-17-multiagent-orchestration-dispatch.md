# Multiagent Orchestration — Parallel Dispatch Prompt

> **Epic:** `psyche-cel` — Multiagent orchestration completion
> **Parent plan:** `docs/superpowers/plans/2026-08-01-multiagent-orchestration.md`
> **Progress tracker:** `docs/superpowers/plans/2026-08-17-multiagent-orchestration-progress.md`

This prompt is designed for an orchestrating agent to dispatch three waves of parallel work using isolated git worktrees. Each wave's agents run concurrently; waves execute sequentially because later waves depend on earlier results.

---

## Pre-flight

Before dispatching any wave, the orchestrator must:

1. Verify the repo is clean on `main` (or the implementation branch).
2. Run `pnpm run typecheck && pnpm vitest --run` as a baseline — record any pre-existing failures.
3. Read the full plan at `docs/superpowers/plans/2026-08-01-multiagent-orchestration.md` for authoritative step-by-step instructions per task.
4. Confirm signing is configured: `git config --get user.signingkey` and `git config --get gpg.format` must both return values. All commits must use `-S`.

---

## Wave A — Three parallel agents (no cross-dependencies)

Launch three agents simultaneously, each in its own worktree branching from `main`.

### Agent A1: Daemon Capability Wiring (Task 3 completion)

**Bead:** `psyche-cel.1`
**Worktree branch:** `feat/orchestration-capability-wiring`

**Prompt:**

```
You are completing Task 3 of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 3, starting at "## Task 3: Land and Harden Capability Routing").

ALREADY DONE: src/orchestration/capabilityRouter.ts and __tests__/capabilityRouter.test.ts exist and pass. Do not recreate them. Your job is the REMAINING steps:

1. Add session-scoped daemon routing to src/daemon/bridge.ts (Step 5 of Task 3):
   - Add LIVE_CAPABILITY_SESSION_STATUSES set
   - Validate capability, provider, task id, prompt, attempt, session id, project root, cwd, and live status before routing

2. Add authenticated protocol frames to src/daemon/protocol.ts (Step 6):
   - coven.capabilities.execute request frame
   - coven.capabilities.execute.result response frame
   - Construct one router per daemon, register native + optional injected strategies

3. Create __tests__/daemon/capabilityDispatch.test.ts with tests asserting:
   - Successful capability execution through the daemon
   - Rejection of requests for unavailable providers
   - Rejection of requests for non-live sessions
   - Contract violation detection

4. Update src/daemon/index.ts to wire the router construction

5. Run and pass: pnpm vitest --run __tests__/capabilityRouter.test.ts __tests__/daemon/bridge.test.ts __tests__/daemon/capabilityDispatch.test.ts && pnpm run typecheck

Commit with -S: "feat: add scoped capability routing"
Update bead: bd update psyche-cel.1 --status done
```

### Agent A2: Local Backend Tests & Launcher Refactor (Task 4 completion)

**Bead:** `psyche-cel.2`
**Worktree branch:** `feat/orchestration-local-backend`

**Prompt:**

```
You are completing Task 4 of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 4, starting at "## Task 4: Centralize Agent Startup and Local Lane Execution").

ALREADY DONE: src/orchestration/localPaneBackend.ts exists. Your job is to verify/complete the REMAINING pieces:

1. Check src/utils/agentLaunch.ts — does it export the generic launchAgentInPane() with injected tmux/prompt dependencies as described in Step 3? If not, implement it. The function must:
   - Accept all agent types through a single code path
   - Support send-keys and stdin prompt transports
   - Handle Codex hook wrapping, Gemini folder trust, prompt token creation
   - Accept an injected tmuxService for testability

2. Check src/utils/paneCreation.ts — does createPane() delegate to launchAgentInPane() as described in Step 4? If not, refactor it. Remove duplicated command construction.

3. Create __tests__/localPaneBackend.test.ts testing:
   - Translation of isolated-worktree lanes to pane creation
   - Translation of shared-worktree lanes with existing worktree refs
   - Terminal lane creation (skipAgentSelection)
   - Rejection of coven-session lanes
   - Orchestration metadata stamped on result panes

4. Extend __tests__/agentLaunch.test.ts with injected dependency tests:
   - buildInitialPromptCommand for each agent + permission mode
   - getPromptTransport per agent
   - launchAgentInPane per transport type

5. Run and pass: pnpm vitest --run __tests__/agentLaunch.test.ts __tests__/localPaneBackend.test.ts __tests__/agentSession.test.ts && pnpm run typecheck

Commit with -S: "refactor: unify local agent lane startup"
Update bead: bd update psyche-cel.2 --status done
```

### Agent A3: TUI Hook Rewrites Verification (Task 5 completion)

**Bead:** `psyche-cel.3`
**Worktree branch:** `feat/orchestration-tui-adapters`

**Prompt:**

```
You are completing Task 5 of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 5, starting at "## Task 5: Adapt TUI Multi-Launch and Shared-Worktree Flows").

ALREADY DONE: src/orchestration/adapters.ts and __tests__/orchestrationAdapters.test.ts exist. Your job is to verify/complete the REMAINING hook rewrites:

1. Check src/hooks/usePaneCreation.ts — does it route through Orchestrator + buildMultiAgentTaskRequest() as described in Step 3? The hook must:
   - Replace any hook-owned worker loop with orchestrator.execute()
   - Persist all successful panes once
   - Schedule pruning once per project root
   - Map completed/partial/failed to current status messages
   If the hook still uses old direct-launch paths, rewrite it.

2. Check src/hooks/useInputHandling.ts — does the attach flow build shared-worktree requests as described in Step 4? It must:
   - Build a shared-worktree request from selected pane + agents
   - Execute with the local backend
   - Save successful panes once, report failed agents by lane id
   If it still uses old paths, rewrite it.

3. Check src/utils/attachAgent.ts — is it reduced to sibling-slug generation + compatibility wrapper as described in Step 4? It must:
   - Submit one shared-worktree lane (not duplicate tmux split/layout/title/hook/launch/focus logic)
   If it still has the old inline logic, refactor it.

4. Ensure __tests__/orchestrationAdapters.test.ts covers:
   - buildMultiAgentTaskRequest with deduplication
   - buildSharedWorktreeTaskRequest
   - buildSinglePaneTaskRequest

5. Run and pass: pnpm vitest --run __tests__/attachAgent.test.ts __tests__/orchestrationAdapters.test.ts __tests__/newPanePopup.test.tsx __tests__/useInputHandling.inlineRename.test.tsx && pnpm run typecheck

Commit with -S: "refactor: route TUI launches through orchestrator"
Update bead: bd update psyche-cel.3 --status done
```

---

## Wave A Merge Gate

After all three Wave A agents complete:

1. Merge branches in order: `feat/orchestration-capability-wiring`, `feat/orchestration-local-backend`, `feat/orchestration-tui-adapters` into the implementation branch.
2. Resolve any merge conflicts (likely in `daemon/bridge.ts` or `daemon/index.ts`).
3. Run full validation: `pnpm run typecheck && pnpm vitest --run`.
4. Fix any integration failures before proceeding to Wave B.

---

## Wave B — Two parallel agents (depend on Wave A)

### Agent B1: Daemon Orchestration Dispatch (Task 6)

**Bead:** `psyche-cel.4`
**Worktree branch:** `feat/orchestration-daemon-dispatch`

**Prompt:**

```
You are implementing Task 6 of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 6, starting at "## Task 6: Add Daemon Task Execution and Compatibility").

This task depends on completed tasks 3, 4, and 5 — all their code is on the current branch.

1. Add protocol frames to src/daemon/protocol.ts (Step 2):
   - orchestration.execute request frame (with OrchestrationTaskRequest)
   - orchestration.execute.result response frame (with OrchestrationTaskResult)

2. Extend DaemonOptions with optional lane backends and capability strategies (Step 3):
   - Construct default local backend once
   - Pass orchestrator through ConnectionDeps

3. Implement dispatchOrchestrationRequest() in src/daemon/bridge.ts (Step 4):
   - Accept orchestration.execute, return orchestration.execute.result
   - Translate panes.spawn to buildSinglePaneTaskRequest() for backwards compatibility
   - Return first successful lane using existing result shape
   - Map structured errors through bridgeErrorCode()/bridgeErrorMessage()

4. Create __tests__/daemon/orchestrationDispatch.test.ts (Step 1):
   - Test direct orchestration dispatch with mock orchestrator
   - Test panes.spawn translation to single lane
   - Test cwd-outside-project-root rejection

5. Run and pass: pnpm vitest --run __tests__/daemon/bridge.test.ts __tests__/daemon/orchestrationDispatch.test.ts __tests__/daemon/capabilityDispatch.test.ts && pnpm run typecheck

Commit with -S: "feat: expose orchestration through daemon"
Update bead: bd update psyche-cel.4 --status done
```

### Agent B2: MCP Tool Wiring (Task 7)

**Bead:** `psyche-cel.5`
**Worktree branch:** `feat/orchestration-mcp-tools`

**Prompt:**

```
You are implementing Task 7 of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 7, starting at "## Task 7: Wire MCP Creation and Termination").

This task depends on the daemon protocol frames from Task 6. If orchestration.execute frames are not yet in protocol.ts, add them yourself (they will be reconciled at merge).

1. Extract handleMcpRequest() from src/mcp/server.ts (Step 1):
   - Export it for testing
   - Keep runMcpServer() as newline framing only
   - Inject McpOrchestrationDeps: task execution, pane listing, capture, termination

2. Implement real MCP tools (Step 4):
   - comux_execute_task: accept task_id, project_root, prompt, lanes[], concurrency; delegate to orchestrator
   - comux_create_pane: translate prompt/agent/worktree/branch/project_root to one isolated or shared lane
   - comux_kill_pane: validate pane id, kill tmux pane, remove pane record; do NOT delete worktrees or branches

3. Update tool registry (Step 2):
   - tools/list must include: comux_list_panes, comux_execute_task, comux_create_pane, comux_kill_pane, comux_get_pane_output, comux_list_rituals, comux_list_worktrees
   - No description may contain "STUB" or "wiring in progress"

4. Update __tests__/mcpServer.test.ts (Steps 2-3):
   - Assert tool registry contents
   - Assert comux_execute_task delegates to injected executor with normalized task
   - Assert comux_create_pane translates to one-lane task
   - Assert comux_kill_pane validates then kills

5. Run and pass: pnpm vitest --run __tests__/mcpServer.test.ts __tests__/daemon/bridge.test.ts && pnpm run typecheck

Commit with -S: "feat: wire MCP orchestration tools"
Update bead: bd update psyche-cel.5 --status done
```

---

## Wave B Merge Gate

After both Wave B agents complete:

1. Merge `feat/orchestration-daemon-dispatch` first (protocol frames), then `feat/orchestration-mcp-tools`.
2. Resolve any conflicts in `daemon/protocol.ts` or `daemon/bridge.ts`.
3. Run full validation: `pnpm run typecheck && pnpm vitest --run`.

---

## Wave C — Sequential (depends on everything)

### Agent C1: Documentation Rewrite (Task 8)

**Bead:** `psyche-cel.6`
**Worktree branch:** `feat/orchestration-docs`

**Prompt:**

```
You are implementing Task 8 of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 8, starting at "## Task 8: Rewrite Multiagent Documentation").

All implementation is complete. Your job is documentation only — do not modify source code.

1. Replace the public model everywhere (Step 1):
   - Task = one requested outcome
   - Lane = one agent or terminal working on that task
   - Isolation mode = isolated-worktree | shared-worktree | terminal | coven-session
   - Integration = inspect, compare, merge, PR, archive, or clean up

2. Rewrite multi-agent guide in docs site content (Step 2):
   Structure as: launch isolated lanes → A/B comparison example → attach shared worktree → bounded concurrency / partial failure → daemon/MCP orchestration → Coven/capability providers → explicit result integration

3. Correct capability and MCP claims (Step 3):
   - Coven-native is default capability provider
   - Psyche is optional registration point
   - MCP task creation and pane termination are implemented
   - Pane termination does not delete worktrees or branches

4. Remove stale claims (Step 4):
   Run: rg -n -i 'STUB|wiring in progress|A/B pair|coming in the next|future Psyche' README.md docs src/mcp/server.ts
   Fix anything found.

5. Build docs: pnpm --dir docs run build

Files: README.md, docs/PRODUCT-SPEC.md, docs/COVEN-SESSIONS.md, docs/src/content/core-concepts.js, docs/src/content/multi-agent.js, docs/src/content/workflows.js, docs/src/content/features.js, docs/src/content/introduction.js

Commit with -S: "docs: rewrite multiagent orchestration guide"
Update bead: bd update psyche-cel.6 --status done
```

### Agent C2: Full Validation & Cleanup (Task 9)

**Bead:** `psyche-cel.7`
**Worktree branch:** (run on implementation branch directly, no worktree)

**Prompt:**

```
You are running Task 9 — final validation — of the multiagent orchestration plan.

Read the full task spec: docs/superpowers/plans/2026-08-01-multiagent-orchestration.md (Task 9, starting at "## Task 9: Full Validation and Cleanup").

Run each validation step in order. Fix any failures before proceeding to the next step.

1. Orchestration-focused tests:
   pnpm vitest --run __tests__/orchestrationPlanner.test.ts __tests__/orchestrator.test.ts __tests__/capabilityRouter.test.ts __tests__/localPaneBackend.test.ts __tests__/orchestrationAdapters.test.ts __tests__/daemon/orchestrationDispatch.test.ts __tests__/daemon/capabilityDispatch.test.ts __tests__/mcpServer.test.ts __tests__/agentLaunch.test.ts __tests__/attachAgent.test.ts

2. Typecheck: pnpm run typecheck

3. Full test suite: pnpm test

4. Build: pnpm run build && pnpm --dir docs run build

5. Package validation: pnpm run smoke:pack

6. Stale path scan:
   rg -n 'createPanesForAgents|attachAgentToWorktree|launchAgentInPane|panes.spawn|comux_create_pane|wiring in progress|STUB' src __tests__ docs README.md
   Expect: one generic launchAgentInPane(), TUI uses orchestration adapters, panes.spawn and comux_create_pane exist only as compatibility adapters, no stub claims.

7. Diff check:
   git --no-pager diff --check
   git status --short
   git --no-pager log --oneline --decorate -12

If any step required fixes, commit with -S: "fix: complete orchestration validation"
Then: bd update psyche-cel.7 --status done
Then: bd update psyche-cel --status done
```

---

## Orchestrator Checklist

- [ ] Pre-flight baseline passes
- [ ] Wave A: dispatch agents A1, A2, A3 in parallel worktrees
- [ ] Wave A merge gate: integrate, resolve conflicts, validate
- [ ] Wave B: dispatch agents B1, B2 in parallel worktrees
- [ ] Wave B merge gate: integrate, resolve conflicts, validate
- [ ] Wave C1: documentation rewrite
- [ ] Wave C2: final validation and cleanup
- [ ] Epic `psyche-cel` closed with all children done
- [ ] PR created against `main`
