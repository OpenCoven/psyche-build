# Multiagent Orchestration — Progress Tracker

> **Parent plan:** `docs/superpowers/plans/2026-08-01-multiagent-orchestration.md`
> **Updated:** 2026-08-17

## Status Summary

| Task | Description | Status | Artifacts |
|------|-------------|--------|-----------|
| 1 | Orchestration contracts (types, planner) | **Done** | `src/orchestration/types.ts`, `planner.ts`, `__tests__/orchestrationPlanner.test.ts` |
| 2 | Bounded-concurrency coordinator | **Done** | `src/orchestration/orchestrator.ts`, `__tests__/orchestrator.test.ts` |
| 3 | Capability routing | **Partial** | `src/orchestration/capabilityRouter.ts`, `__tests__/capabilityRouter.test.ts` exist; daemon protocol frames and `capabilityDispatch.test.ts` missing |
| 4 | Local lane backend | **Partial** | `src/orchestration/localPaneBackend.ts` exists; no `__tests__/localPaneBackend.test.ts`; `agentLaunch.ts` generic launcher refactor unverified |
| 5 | TUI adapters & hook rewrites | **Partial** | `src/orchestration/adapters.ts`, `__tests__/orchestrationAdapters.test.ts` exist; `usePaneCreation`, `useInputHandling`, `attachAgent` rewrites unverified |
| 6 | Daemon task execution | **Not started** | No `__tests__/daemon/orchestrationDispatch.test.ts`, no protocol frames |
| 7 | MCP tool wiring | **Partial** | `__tests__/mcpServer.test.ts` exists; real tool implementations unclear |
| 8 | Documentation rewrite | **Not started** | — |
| 9 | Full validation & cleanup | **Not started** | — |

## Extra Artifacts (not in original plan)

These files exist but were not explicitly called for in the 9-task plan:

- `src/orchestration/bridgePaneBackend.ts` — bridge adapter for daemon-controlled panes
- `src/orchestration/covenSessionBackend.ts` — Coven-managed session lane backend

## Remaining Work

### Wave A — Independent, parallelizable

These tasks have no cross-dependencies and can run in isolated worktrees simultaneously:

1. **Task 3 completion** — daemon capability wiring (protocol frames, `capabilityDispatch.test.ts`, bridge session routing)
2. **Task 4 completion** — `localPaneBackend.test.ts`, verify `agentLaunch.ts` generic launcher
3. **Task 5 verification** — confirm hook rewrites (`usePaneCreation`, `useInputHandling`, `attachAgent`) route through orchestrator; fix if not

### Wave B — Depends on Wave A

4. **Task 6** — daemon orchestration dispatch (depends on tasks 3-5 being solid)
5. **Task 7 completion** — MCP real tool implementations (depends on task 6 protocol)

### Wave C — Depends on Wave B

6. **Task 8** — documentation rewrite (depends on all interfaces being final)
7. **Task 9** — full validation and cleanup (depends on everything)

## Beads

Epic and child issues tracked under the `psyche-` prefix in the local beads database.
