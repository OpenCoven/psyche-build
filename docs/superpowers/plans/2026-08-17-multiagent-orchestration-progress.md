# Multiagent Orchestration — Progress Tracker

> **Parent plan:** `docs/superpowers/plans/2026-08-01-multiagent-orchestration.md`
> **Updated:** 2026-08-19

## Status Summary

| Task | Description | Status | Artifacts |
|------|-------------|--------|-----------|
| 1 | Orchestration contracts (types, planner) | **Done** | `src/orchestration/types.ts`, `planner.ts`, `__tests__/orchestrationPlanner.test.ts` |
| 2 | Bounded-concurrency coordinator | **Done** | `src/orchestration/orchestrator.ts`, `__tests__/orchestrator.test.ts` |
| 3 | Capability routing | **Partial** | `src/orchestration/capabilityRouter.ts`, `__tests__/capabilityRouter.test.ts` exist; daemon protocol frames and `capabilityDispatch.test.ts` missing |
| 4 | Local lane backend | **Partial** | `src/orchestration/localPaneBackend.ts` exists; no `__tests__/localPaneBackend.test.ts`; `agentLaunch.ts` generic launcher refactor unverified |
| 5 | TUI adapters & hook rewrites | **Partial** | `src/orchestration/adapters.ts`, `__tests__/orchestrationAdapters.test.ts` exist; `usePaneCreation`, `useInputHandling`, `attachAgent` rewrites unverified |
| 6 | Daemon task execution | **Done** | `orchestration.execute`/`.execute.result` frames (`src/daemon/protocol.ts`), `dispatchOrchestrationRequest` (`src/daemon/bridge.ts`), `DaemonOptions`/`ConnectionDeps` orchestrator injection (`src/daemon/index.ts`), `__tests__/daemon/orchestrationDispatch.test.ts` (7 tests). Landed via `b5f569ea` + #169. |
| 7 | MCP tool wiring | **Done** | `handleMcpRequest` extracted with `McpDeps`/`setMcpDeps` injection (`src/mcp/server.ts`); real `psyche_*` tools (execute_task, create_pane, kill_pane, list_panes, get_pane_output, list_rituals, list_worktrees) + compat aliases; `__tests__/mcpServer.test.ts` asserts registry, no STUB descriptions, and `kill_pane` performs no worktree/branch deletion. |
| 8 | Documentation rewrite | **Not started** | — |
| 9 | Full validation & cleanup | **Not started** | — |

## Extra Artifacts (not in original plan)

These files exist but were not explicitly called for in the 9-task plan:

- `src/orchestration/bridgePaneBackend.ts` — bridge adapter for daemon-controlled panes
- `src/orchestration/covenSessionBackend.ts` — Coven-managed session lane backend

## Remaining Work

Waves A and B are complete (Tasks 3–7 done; beads `psyche-cel.1`–`psyche-cel.5` closed). Only Wave C remains.

### Wave A — Complete

1. **Task 3** — daemon capability wiring — **Done**
2. **Task 4** — local backend tests & launcher refactor — **Done**
3. **Task 5** — TUI adapters & hook rewrites — **Done**

### Wave B — Complete

4. **Task 6** — daemon orchestration dispatch — **Done** (`psyche-cel.4`)
5. **Task 7** — MCP real tool implementations — **Done** (`psyche-cel.5`)

### Wave C — Depends on Wave B

6. **Task 8** — documentation rewrite (`psyche-cel.6`) — depends on all interfaces being final
7. **Task 9** — full validation and cleanup (`psyche-cel.7`) — depends on everything

## Beads

Epic and child issues tracked under the `psyche-` prefix in the local beads database.
