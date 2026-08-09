import { describe, expect, it, vi } from "vitest";

import * as stateManagerModule from "../src/shared/StateManager.js";
import type { PsychePane } from "../src/types.js";

describe("workspace publication synchronization", () => {
  it("synchronizes live panes before notifying and skips the initial loaded state", () => {
    const synchronizeWorkspacePublication = (
      stateManagerModule as Record<string, unknown>
    ).synchronizeWorkspacePublication;
    expect(typeof synchronizeWorkspacePublication).toBe("function");
    if (typeof synchronizeWorkspacePublication !== "function") return;

    let storedPanes: PsychePane[] = [];
    const stateManager = {
      updatePanes: vi.fn((panes: PsychePane[]) => {
        storedPanes = [...panes];
      }),
    };
    const observedPanes: PsychePane[][] = [];
    const bridgeDaemon = {
      notifyWorkspaceChanged: vi.fn(() => {
        observedPanes.push([...storedPanes]);
      }),
    };
    const initialPanes = [{
      id: "pane-1",
      slug: "pane-1",
      paneId: "%1",
      prompt: "",
      agentStatus: "idle",
      needsAttention: false,
    }] satisfies PsychePane[];
    const updatedPanes = [{
      ...initialPanes[0],
      agentStatus: "waiting" as const,
      needsAttention: true,
    }] satisfies PsychePane[];
    let publicationState = {
      daemon: bridgeDaemon,
      ready: false,
    };

    publicationState = synchronizeWorkspacePublication(
      stateManager,
      initialPanes,
      bridgeDaemon,
      false,
      publicationState,
    ) as typeof publicationState;

    expect(stateManager.updatePanes).toHaveBeenLastCalledWith(initialPanes);
    expect(bridgeDaemon.notifyWorkspaceChanged).not.toHaveBeenCalled();

    publicationState = synchronizeWorkspacePublication(
      stateManager,
      updatedPanes,
      bridgeDaemon,
      false,
      publicationState,
    ) as typeof publicationState;

    expect(publicationState.ready).toBe(true);
    expect(observedPanes).toEqual([updatedPanes]);
  });
});
