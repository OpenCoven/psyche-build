import { describe, expect, it, vi } from "vitest";

import * as stateManagerModule from "../src/shared/StateManager.js";
import type { CovenSessionSummary } from "../src/daemon/protocol.js";
import type { PsychePane } from "../src/types.js";

describe("workspace publication synchronization", () => {
  it("stores live Coven sessions as typed defensive state", () => {
    const stateManager = stateManagerModule.StateManager.getInstance() as unknown as {
      reset(): void;
      updateCovenSessions?: (sessions: readonly CovenSessionSummary[]) => void;
      getCovenSessions?: () => CovenSessionSummary[];
    };
    stateManager.reset();

    expect(typeof stateManager.updateCovenSessions).toBe("function");
    expect(typeof stateManager.getCovenSessions).toBe("function");
    if (!stateManager.updateCovenSessions || !stateManager.getCovenSessions) return;

    expect(stateManager.getCovenSessions()).toEqual([]);
    const sessions = [covenSession()];
    stateManager.updateCovenSessions(sessions);

    const stored = stateManager.getCovenSessions();
    expect(stored).toEqual(sessions);
    expect(stored).not.toBe(sessions);

    stored.length = 0;
    expect(stateManager.getCovenSessions()).toEqual(sessions);
    stateManager.reset();
  });

  it("synchronizes panes and live Coven sessions before the first loaded notification", () => {
    const synchronizeWorkspacePublication = (
      stateManagerModule as Record<string, unknown>
    ).synchronizeWorkspacePublication as (
      stateManager: {
        updatePanes(panes: PsychePane[]): void;
        updateCovenSessions(sessions: readonly CovenSessionSummary[]): void;
      },
      panes: PsychePane[],
      bridgeDaemon: { notifyWorkspaceChanged(): void } | undefined,
      isLoading: boolean,
      covenSessions: readonly CovenSessionSummary[],
      state: stateManagerModule.WorkspacePublicationState,
    ) => stateManagerModule.WorkspacePublicationState;
    expect(typeof synchronizeWorkspacePublication).toBe("function");
    if (typeof synchronizeWorkspacePublication !== "function") return;

    let storedPanes: PsychePane[] = [];
    let storedCovenSessions: CovenSessionSummary[] = [];
    const stateManager = {
      updatePanes: vi.fn((panes: PsychePane[]) => {
        storedPanes = [...panes];
      }),
      updateCovenSessions: vi.fn((sessions: readonly CovenSessionSummary[]) => {
        storedCovenSessions = [...sessions];
      }),
    };
    const observedState: Array<{
      panes: PsychePane[];
      covenSessions: CovenSessionSummary[];
    }> = [];
    const bridgeDaemon = {
      notifyWorkspaceChanged: vi.fn(() => {
        observedState.push({
          panes: [...storedPanes],
          covenSessions: [...storedCovenSessions],
        });
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
    const initialCovenSessions = [covenSession()];
    let publicationState = {
      daemon: bridgeDaemon,
      ready: false,
    };

    publicationState = synchronizeWorkspacePublication(
      stateManager,
      initialPanes,
      bridgeDaemon,
      false,
      initialCovenSessions,
      publicationState,
    ) as typeof publicationState;

    expect(stateManager.updatePanes).toHaveBeenLastCalledWith(initialPanes);
    expect(stateManager.updateCovenSessions).toHaveBeenLastCalledWith(initialCovenSessions);
    expect(publicationState.ready).toBe(true);
    expect(observedState).toEqual([{
      panes: initialPanes,
      covenSessions: initialCovenSessions,
    }]);

    publicationState = synchronizeWorkspacePublication(
      stateManager,
      updatedPanes,
      bridgeDaemon,
      false,
      initialCovenSessions,
      publicationState,
    ) as typeof publicationState;

    expect(publicationState.ready).toBe(true);
    expect(observedState).toEqual([
      {
        panes: initialPanes,
        covenSessions: initialCovenSessions,
      },
      {
        panes: updatedPanes,
        covenSessions: initialCovenSessions,
      },
    ]);
  });

  it("does nothing while loading or without a daemon", () => {
    const synchronizeWorkspacePublication = (
      stateManagerModule as Record<string, unknown>
    ).synchronizeWorkspacePublication as (
      stateManager: {
        updatePanes(panes: PsychePane[]): void;
        updateCovenSessions(sessions: readonly CovenSessionSummary[]): void;
      },
      panes: PsychePane[],
      bridgeDaemon: { notifyWorkspaceChanged(): void } | undefined,
      isLoading: boolean,
      covenSessions: readonly CovenSessionSummary[],
      state: stateManagerModule.WorkspacePublicationState,
    ) => stateManagerModule.WorkspacePublicationState;
    const stateManager = {
      updatePanes: vi.fn(),
      updateCovenSessions: vi.fn(),
    };
    const bridgeDaemon = { notifyWorkspaceChanged: vi.fn() };
    const initialState = { daemon: bridgeDaemon, ready: false };

    synchronizeWorkspacePublication(
      stateManager,
      [],
      bridgeDaemon,
      true,
      [],
      initialState,
    );
    synchronizeWorkspacePublication(
      stateManager,
      [],
      undefined,
      false,
      [],
      initialState,
    );

    expect(stateManager.updatePanes).not.toHaveBeenCalled();
    expect(stateManager.updateCovenSessions).not.toHaveBeenCalled();
    expect(bridgeDaemon.notifyWorkspaceChanged).not.toHaveBeenCalled();
  });
});

function covenSession(): CovenSessionSummary {
  return {
    id: "coven-1",
    projectRoot: "/repo/coven-only",
    cwd: "/repo/coven-only",
    harness: "coven-code",
    title: "Live Coven",
    status: "running",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:01:00.000Z",
  };
}
