import type { PsychePane } from "../../types.js";
import type { PaneSnapshot } from "./wireProtocol.js";

/**
 * The v2 `listPanes` / `paneListChanged` entry for one TUI pane. Its `id` is
 * the tmux pane id that v2 `subscribePane` and `sendInput` then name, so every
 * pane listed here must also pass the bridge's published-pane scope.
 */
export function toLegacyPaneSnapshot(p: PsychePane): PaneSnapshot {
  let status: PaneSnapshot["status"];
  switch (p.agentStatus) {
    case "working":
    case "analyzing":
      status = "working";
      break;
    case "idle":
      status = "idle";
      break;
    case "waiting":
      status = "waiting";
      break;
    default:
      status = "unknown";
  }
  return {
    id: p.paneId,
    displayName: p.displayName ?? p.slug ?? p.id,
    kind: p.type ?? "worktree",
    projectId: p.projectRoot ?? null,
    projectName: p.projectName ?? null,
    worktreePath: p.worktreePath ?? null,
    agent: p.agent ?? null,
    status,
  };
}
