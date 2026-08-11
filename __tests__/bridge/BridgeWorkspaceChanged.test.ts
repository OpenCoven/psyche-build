import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_SNAPSHOT_FIXTURE } from "../../protocol-fixtures/fixtures";
import { BridgeDaemon } from "../../src/services/bridge/BridgeDaemon";
import { LogService } from "../../src/services/LogService";
import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../src/services/bridge/wireProtocol";

function workspaceAtRevision(revision: number) {
  return {
    ...structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace),
    revision,
  };
}

function createSession(
  state: "authenticated" | "unauthenticated",
  protocolVersion: typeof LEGACY_PROTOCOL_VERSION | typeof PROTOCOL_VERSION,
) {
  return {
    state,
    protocolVersion,
    clientId: "client-1",
    token: "token-1",
    connectionId: "connection-1",
    send: vi.fn(),
    sendBinary: vi.fn(),
  };
}

function createDaemon(
  workspaceProvider?: () => ReturnType<typeof workspaceAtRevision> | Promise<ReturnType<typeof workspaceAtRevision>>,
) {
  return new BridgeDaemon({
    serverId: "server-1",
    serverName: "test",
    projectName: "psyche",
    sessionName: "test-session",
    paneProvider: () => [],
    projectProvider: () => [],
    workspaceProvider,
    ritualProvider: () => [],
    launchRitual: async () => {},
  });
}

function installSessions(daemon: BridgeDaemon, sessions: any[]) {
  (daemon as any).listener = {
    activeSessions: new Set(sessions),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BridgeDaemon workspace change broadcasts", () => {
  it("increments once for a new revision, ignores repeats, and increments once for a later revision", async () => {
    let workspace = workspaceAtRevision(1);
    const provider = vi.fn(() => workspace);
    const session = createSession("authenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(provider);
    installSessions(daemon, [session]);

    await (daemon as any).broadcastWorkspaceChanged();
    await (daemon as any).broadcastWorkspaceChanged();
    workspace = workspaceAtRevision(2);
    await (daemon as any).broadcastWorkspaceChanged();

    expect(provider).toHaveBeenCalledTimes(3);
    expect(session.send.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "workspaceChanged",
        payload: {
          revision: 1,
          sequence: 1,
          workspace: workspaceAtRevision(1),
        },
      },
      {
        type: "workspaceChanged",
        payload: {
          revision: 2,
          sequence: 2,
          workspace: workspaceAtRevision(2),
        },
      },
    ]);
    expect((daemon as any).workspaceSequence).toBe(2);
  });

  it("serializes concurrent notifications without duplicate or reordered events", async () => {
    const revisions = [
      workspaceAtRevision(1),
      workspaceAtRevision(1),
      workspaceAtRevision(2),
    ];
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const provider = vi.fn(async () => {
      const call = calls++;
      if (call === 0) await firstRead;
      return revisions[call]!;
    });
    const session = createSession("authenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(provider);
    installSessions(daemon, [session]);

    const broadcasts = [
      (daemon as any).broadcastWorkspaceChanged(),
      (daemon as any).broadcastWorkspaceChanged(),
      (daemon as any).broadcastWorkspaceChanged(),
    ];
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    releaseFirst();
    await Promise.all(broadcasts);

    expect(session.send.mock.calls.map(([message]) => ({
      revision: message.payload.revision,
      sequence: message.payload.sequence,
    }))).toEqual([
      { revision: 1, sequence: 1 },
      { revision: 2, sequence: 2 },
    ]);
    expect((daemon as any).workspaceSequence).toBe(2);
  });

  it("coalesces a burst of public notifications into one pending rescan", async () => {
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const provider = vi.fn(async () => {
      const call = calls++;
      if (call === 0) {
        await firstRead;
        return workspaceAtRevision(1);
      }
      return workspaceAtRevision(2);
    });
    const session = createSession("authenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(provider);
    installSessions(daemon, [session]);

    daemon.notifyWorkspaceChanged();
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

    for (let index = 0; index < 25; index += 1) {
      daemon.notifyWorkspaceChanged();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() => {
      expect(provider).toHaveBeenCalledTimes(2);
      expect(session.send).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(provider).toHaveBeenCalledTimes(2);
    expect(session.send.mock.calls.map(([message]) => ({
      revision: message.payload.revision,
      sequence: message.payload.sequence,
    }))).toEqual([
      { revision: 1, sequence: 1 },
      { revision: 2, sequence: 2 },
    ]);
  });

  it("sends workspaceChanged only to authenticated protocol-v3 sessions", async () => {
    const authenticatedV3 = createSession("authenticated", PROTOCOL_VERSION);
    const authenticatedV2 = createSession("authenticated", LEGACY_PROTOCOL_VERSION);
    const unauthenticatedV3 = createSession("unauthenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(() => workspaceAtRevision(1));
    installSessions(daemon, [authenticatedV3, authenticatedV2, unauthenticatedV3]);

    await (daemon as any).broadcastWorkspaceChanged();

    expect(authenticatedV3.send).toHaveBeenCalledOnce();
    expect(authenticatedV2.send).not.toHaveBeenCalled();
    expect(unauthenticatedV3.send).not.toHaveBeenCalled();
  });

  it("reports the current sequence in a snapshot response after a broadcast", async () => {
    const workspace = workspaceAtRevision(4);
    const session = createSession("authenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(() => workspace);
    installSessions(daemon, [session]);

    await (daemon as any).broadcastWorkspaceChanged();
    session.send.mockClear();
    await (daemon as any).handleControl(session, {
      type: "workspace.snapshot",
      requestId: "snapshot-after-change",
    });

    expect(session.send).toHaveBeenCalledWith({
      type: "control",
      payload: {
        type: "mobile.workspace.snapshot.result",
        requestId: "snapshot-after-change",
        sequence: 1,
        workspace,
      },
    });
  });

  it("serializes snapshots with broadcasts so workspace and sequence stay consistent", async () => {
    let providerCalls = 0;
    let markSnapshotReadStarted!: () => void;
    const snapshotReadStarted = new Promise<void>((resolve) => {
      markSnapshotReadStarted = resolve;
    });
    let releaseSnapshotRead!: () => void;
    const snapshotReadRelease = new Promise<void>((resolve) => {
      releaseSnapshotRead = resolve;
    });
    const oldWorkspace = workspaceAtRevision(4);
    oldWorkspace.projects[0]!.title = "old workspace";
    const newWorkspace = workspaceAtRevision(5);
    newWorkspace.projects[0]!.title = "new workspace";
    const provider = vi.fn(async () => {
      const call = providerCalls++;
      if (call === 0) {
        markSnapshotReadStarted();
        await snapshotReadRelease;
        return oldWorkspace;
      }
      return newWorkspace;
    });
    const session = createSession("authenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(provider);
    installSessions(daemon, [session]);

    const snapshotRequest = (daemon as any).handleControl(session, {
      type: "workspace.snapshot",
      requestId: "snapshot-race",
    });
    await snapshotReadStarted;

    const broadcast = (daemon as any).broadcastWorkspaceChanged();
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider).toHaveBeenCalledTimes(1);
    expect((daemon as any).workspaceSequence).toBe(0);

    releaseSnapshotRead();
    await Promise.all([snapshotRequest, broadcast]);

    expect(session.send.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "control",
        payload: {
          type: "mobile.workspace.snapshot.result",
          requestId: "snapshot-race",
          sequence: 0,
          workspace: oldWorkspace,
        },
      },
      {
        type: "workspaceChanged",
        payload: {
          revision: 5,
          sequence: 1,
          workspace: newWorkspace,
        },
      },
    ]);
  });

  it("logs rejected provider reads without producing an unhandled rejection", async () => {
    const providerError = new Error("workspace unavailable");
    const daemon = createDaemon(async () => {
      throw providerError;
    });
    installSessions(daemon, []);
    const logError = vi.spyOn(LogService.getInstance(), "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      expect(() => daemon.notifyWorkspaceChanged()).not.toThrow();
      await vi.waitFor(() => {
        expect(logError).toHaveBeenCalledWith(
          "bridge workspace change broadcast failed: workspace unavailable",
          "BridgeDaemon",
          undefined,
          providerError,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("runs one pending rescan after a provider error without an unhandled rejection", async () => {
    const providerError = new Error("workspace unavailable");
    let rejectFirst!: () => void;
    const firstRead = new Promise<void>((_resolve, reject) => {
      rejectFirst = () => reject(providerError);
    });
    let calls = 0;
    const provider = vi.fn(async () => {
      const call = calls++;
      if (call === 0) {
        await firstRead;
      }
      return workspaceAtRevision(1);
    });
    const session = createSession("authenticated", PROTOCOL_VERSION);
    const daemon = createDaemon(provider);
    installSessions(daemon, [session]);
    const logError = vi.spyOn(LogService.getInstance(), "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      daemon.notifyWorkspaceChanged();
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
      for (let index = 0; index < 10; index += 1) {
        daemon.notifyWorkspaceChanged();
      }

      rejectFirst();
      await vi.waitFor(() => {
        expect(provider).toHaveBeenCalledTimes(2);
        expect(session.send).toHaveBeenCalledOnce();
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(provider).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenCalledTimes(1);
      expect(session.send).toHaveBeenCalledWith({
        type: "workspaceChanged",
        payload: {
          revision: 1,
          sequence: 1,
          workspace: workspaceAtRevision(1),
        },
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
