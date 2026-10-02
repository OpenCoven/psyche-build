import { describe, expect, it } from "vitest";
import type { PsychePane } from "../../src/types";
import { toLegacyPaneSnapshot } from "../../src/services/bridge/legacyPaneSnapshot";
import { createTuiWorkspaceProvider } from "../../src/workspace/tuiSnapshot";
import { publishedTmuxBackedPaneIds } from "../../src/workspace/snapshot";

/**
 * v2 `listPanes` serves the legacy pane provider, while v2 `subscribePane` and
 * `sendInput` are scoped to the workspace snapshot (#503). The TUI builds both
 * from the same `StateManager` panes; this pins that every pane v2 lists is one
 * v2 will then accept, so the scope never strands a listed pane.
 */
function pane(overrides: Partial<PsychePane> & Pick<PsychePane, "id" | "paneId">): PsychePane {
  return { slug: overrides.id, prompt: "", ...overrides } as PsychePane;
}

const PRIMARY = "/repo/primary";

const PANES: PsychePane[] = [
  pane({ id: "worktree", paneId: "%1", type: "worktree", projectRoot: PRIMARY, worktreePath: `${PRIMARY}/.worktrees/a` }),
  pane({ id: "shell", paneId: "%2", type: "shell" }),
  pane({ id: "other-project", paneId: "%3", type: "worktree", projectRoot: "/repo/other", projectName: "other", worktreePath: "/repo/other/.worktrees/b" }),
  pane({ id: "desktop-use", paneId: "%4", type: "desktop-use" }),
  pane({ id: "hidden", paneId: "%5", type: "shell", hidden: true }),
  pane({ id: "outside-worktree", paneId: "%6", type: "worktree", worktreePath: "/elsewhere/x" }),
  pane({ id: "coven-linked", paneId: "%7", type: "shell", covenSession: { id: "cs-1" } }),
  pane({ id: "untyped", paneId: "%8" }),
];

describe("v2 pane listing stays inside the v2 pane scope", () => {
  it("publishes every TUI pane the legacy list advertises", async () => {
    const provider = createTuiWorkspaceProvider({
      primaryProjectRoot: PRIMARY,
      primaryProjectName: "primary",
      panes: () => PANES,
      loadWorktrees: () => [],
    });
    const published = publishedTmuxBackedPaneIds(await provider());
    const listed = PANES.map(toLegacyPaneSnapshot).map((snapshot) => snapshot.id);

    expect(listed).toHaveLength(PANES.length);
    expect(listed.filter((id) => !published.has(id))).toEqual([]);
  });
});
