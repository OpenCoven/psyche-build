import { describe, expect, it, vi } from "vitest";
import { BridgeDaemon } from "../../src/services/bridge/BridgeDaemon";
import { PaneStreamHub } from "../../src/services/bridge/PaneStreamHub";
import { PairingFlow } from "../../src/services/bridge/PairingFlow";
import { WebSocket } from "ws";
import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type PaneSnapshot,
  type Project,
  type Ritual,
} from "../../src/services/bridge/wireProtocol";
import { WORKSPACE_SNAPSHOT_FIXTURE } from "../../protocol-fixtures/fixtures";

// ---------------------------------------------------------------------------
// Fake TokenStore — in-memory, no filesystem I/O
// ---------------------------------------------------------------------------
class FakeTokenStore {
  private records: any[] = [];
  async list() { return this.records.slice(); }
  async issue(clientId: string, clientName: string) {
    const rec = {
      token: "test-token-" + this.records.length,
      clientId, clientName,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.records.push(rec);
    return rec;
  }
  async revoke(token: string) {
    const before = this.records.length;
    this.records = this.records.filter(r => r.token !== token);
    return this.records.length !== before;
  }
  async touch() {}
  async validate(token: string) { return this.records.find(r => r.token === token) ?? null; }
}

// Default no-op stubs for required ritual options
const noopRituals = {
  ritualProvider: (_projectId: string | null) => [],
  launchRitual: async () => {},
};

class NoopPaneStreamHub extends PaneStreamHub {
  override start(): void {}
  override stop(): void {}
  override sendInput(_paneId: string, _data: Buffer): void {}
}

const noopHubFactory = (sessionName: string) => new NoopPaneStreamHub(sessionName);

describe("BridgeDaemon", () => {
  it("passes the active TLS fingerprint to Bonjour publication", async () => {
    const bonjour = {
      publish: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test-host",
      projectName: "psyche",
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      bonjourFactory: () => bonjour,
      ...noopRituals,
      tokenStore: new FakeTokenStore() as any,
    });

    try {
      const started = await daemon.start();

      expect(bonjour.publish).toHaveBeenCalledWith({
        name: "test-host",
        port: started.port,
        serverId: "test-srv",
        fingerprint: started.fingerprint,
      });
    } finally {
      await daemon.stop();
    }
  });

  it("sends a legacy v2 welcome before hello and no duplicate welcome for v2", async () => {
    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore: new FakeTokenStore() as any,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const welcomes: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "welcome") {
          welcomes.push(message);
        }
        if (welcomes.length === 1 && message.type === "welcome") {
          client.send(JSON.stringify({
            type: "hello",
            payload: {
              clientId: "v2-client",
              clientName: "v2",
              protocolVersion: LEGACY_PROTOCOL_VERSION,
              token: null,
            },
          }));
          client.send(JSON.stringify({
            type: "ping",
            payload: { token: "v2-negotiated" },
          }));
        } else if (message.type === "pong") {
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(welcomes).toEqual([{
      type: "welcome",
      payload: {
        serverId: "test-srv",
        serverName: "test",
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        projectName: "psyche",
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      },
    }]);

    client.close();
    await daemon.stop();
  });

  it("sends a negotiated v3 welcome after a v3 hello", async () => {
    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore: new FakeTokenStore() as any,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const welcomes: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type !== "welcome") return;
        welcomes.push(message);
        if (welcomes.length === 1) {
          client.send(JSON.stringify({
            type: "hello",
            payload: {
              clientId: "v3-client",
              clientName: "v3",
              protocolVersion: PROTOCOL_VERSION,
              token: null,
            },
          }));
        } else {
          resolve();
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(welcomes.map((message) => message.payload.protocolVersion)).toEqual([
      LEGACY_PROTOCOL_VERSION,
      PROTOCOL_VERSION,
    ]);
    expect(welcomes.every((message) =>
      JSON.stringify(message.payload.supportedVersions) === JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS)
    )).toBe(true);

    client.close();
    await daemon.stop();
  });

  it("requires authentication before listPanes/listProjects", async () => {
    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => { throw new Error("legacy pane provider should not run"); },
      projectProvider: () => { throw new Error("legacy project provider should not run"); },
      workspaceProvider: () => WORKSPACE_SNAPSHOT_FIXTURE.workspace,
      ...noopRituals,
      tokenStore: new FakeTokenStore() as any,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: null },
        }));
        client.send(JSON.stringify({ type: "listPanes", payload: {} }));
        client.send(JSON.stringify({ type: "listProjects", payload: {} }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (received.filter((x: any) => x.type === "error").length === 2) resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });
    expect(received[0].type).toBe("welcome");
    expect(received.filter((x: any) => x.payload?.code === "not_authenticated")).toHaveLength(2);
    client.close();
    await daemon.stop();
  });

  it.each([LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION])(
    "answers listPanes/listProjects for authenticated hello protocol v%s clients",
    async (protocolVersion) => {
      const tokenStore = new FakeTokenStore() as any;
      const knownToken = `list-test-token-v${protocolVersion}`;
      tokenStore.records = [{
        token: knownToken,
        clientId: "c",
        clientName: "c",
        pairedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }];

      const daemon = new BridgeDaemon({
        serverId: "test-srv",
        serverName: "test",
        projectName: "psyche",
        sessionName: "test-session",
        hubFactory: noopHubFactory,
        paneProvider: () => [{
          id: "%legacy",
          displayName: "Legacy pane",
          kind: "worktree",
          projectId: "legacy-project",
          projectName: "Legacy project",
          worktreePath: "/legacy",
          agent: null,
          status: "idle",
        }],
        projectProvider: () => [{
          id: "legacy-project",
          displayName: "Legacy project",
          attentionCount: 0,
        }],
        workspaceProvider: () => {
          throw new Error("canonical provider should not serve legacy list routes");
        },
        ...noopRituals,
        tokenStore,
      });
      const { port } = await daemon.start();
      const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
      const received: any[] = [];
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => {
          client.send(JSON.stringify({
            type: "hello",
            payload: { clientId: "c", clientName: "c", protocolVersion, token: knownToken },
          }));
          client.send(JSON.stringify({ type: "listPanes", payload: {} }));
          client.send(JSON.stringify({ type: "listProjects", payload: {} }));
        });
        client.on("message", (raw) => {
          const m = JSON.parse(raw.toString("utf8"));
          received.push(m);
          if (m.type === "projectList") resolve();
        });
        client.on("close", (_code, reason) => reject(new Error(`unexpected close: ${reason.toString()}`)));
        client.on("error", reject);
        setTimeout(() => reject(new Error("timeout")), 2000);
      });
      expect(received.find((x: any) => x.type === "paneList").payload).toEqual([
        expect.objectContaining({ id: "%legacy", displayName: "Legacy pane" }),
      ]);
      expect(received.find((x: any) => x.type === "projectList").payload).toEqual([
        {
          id: "legacy-project",
          displayName: "Legacy project",
          attentionCount: 0,
        },
      ]);
      expect([...((daemon as any).listener.activeSessions as Set<any>)][0]?.protocolVersion).toBe(protocolVersion);
      client.close();
      await daemon.stop();
    }
  );

  it("rejects unauthenticated control before invoking the workspace provider", async () => {
    let providerCalls = 0;
    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      workspaceProvider: () => {
        providerCalls += 1;
        return WORKSPACE_SNAPSHOT_FIXTURE.workspace;
      },
      ...noopRituals,
      tokenStore: new FakeTokenStore() as any,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: null },
        }));
        client.send(JSON.stringify({
          type: "control",
          payload: { type: "workspace.snapshot", requestId: "workspace-1" },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "control") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(providerCalls).toBe(0);
    expect(received.find((message) => message.type === "control")).toEqual({
      type: "control",
      payload: {
        type: "error",
        requestId: "workspace-1",
        code: "not_authenticated",
        message: "pair first",
      },
    });

    client.close();
    await daemon.stop();
  });

  it("rejects authenticated v2 control with a protocol mismatch", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "control-v2-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];
    let providerCalls = 0;

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      workspaceProvider: () => {
        providerCalls += 1;
        return WORKSPACE_SNAPSHOT_FIXTURE.workspace;
      },
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: LEGACY_PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "after-hello" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pong") {
          client.send(JSON.stringify({
            type: "control",
            payload: { type: "workspace.snapshot", requestId: "workspace-v2" },
          }));
        }
        if (m.type === "control") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(providerCalls).toBe(0);
    expect(received.find((message) => message.type === "control")).toEqual({
      type: "control",
      payload: {
        type: "error",
        requestId: "workspace-v2",
        code: "protocol_mismatch",
        message: "control requires negotiated protocol v3",
      },
    });

    client.close();
    await daemon.stop();
  });

  it("rejects authenticated v3 control when no gateway is available", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "control-unavailable-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "after-hello" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pong") {
          client.send(JSON.stringify({
            type: "control",
            payload: { type: "workspace.snapshot", requestId: "workspace-unavailable" },
          }));
        }
        if (m.type === "control") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(received.find((message) => message.type === "control")).toEqual({
      type: "control",
      payload: {
        type: "error",
        requestId: "workspace-unavailable",
        code: "control_unavailable",
        message: "workspace control is not available",
      },
    });

    client.close();
    await daemon.stop();
  });

  it("answers authenticated v3 workspace snapshot control requests", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "control-workspace-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const workspace = structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace);
    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      workspaceProvider: async () => workspace,
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "after-hello" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pong") {
          client.send(JSON.stringify({
            type: "control",
            payload: { type: "workspace.snapshot", requestId: "workspace-ok" },
          }));
        }
        if (m.type === "control") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(received.find((message) => message.type === "control")).toEqual({
      type: "control",
      payload: {
        type: "mobile.workspace.snapshot.result",
        requestId: "workspace-ok",
        sequence: 0,
        workspace,
      },
    });

    client.close();
    await daemon.stop();
  });

  it("returns a typed control error with requestId for unsupported v3 control", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "control-unsupported-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      workspaceProvider: () => WORKSPACE_SNAPSHOT_FIXTURE.workspace,
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "after-hello" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pong") {
          client.send(JSON.stringify({
            type: "control",
            payload: {
              type: "actions.start",
              requestId: "unsupported-1",
              paneId: "%3",
              action: "view",
            },
          }));
        }
        if (m.type === "control") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(received.find((message) => message.type === "control")).toEqual({
      type: "control",
      payload: {
        type: "error",
        requestId: "unsupported-1",
        code: "command_not_supported",
        message: "this host does not support remote actions yet",
      },
    });

    client.close();
    await daemon.stop();
  });

  it("routes scoped action requests through the registered live executor", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "control-action-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];
    const daemon = new BridgeDaemon({
      serverId: "server",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      workspaceProvider: () => WORKSPACE_SNAPSHOT_FIXTURE.workspace,
      ...noopRituals,
      tokenStore,
    });
    const calls: unknown[] = [];
    daemon.setActionExecutor(async (input) => {
      calls.push(input);
      return { type: "success", message: "opened" };
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const response = await new Promise<any>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "ready" } }));
      });
      client.on("message", (raw) => {
        const message = JSON.parse(raw.toString("utf8"));
        if (message.type === "pong") {
          client.send(JSON.stringify({
            type: "control",
            payload: {
              type: "actions.start",
              requestId: "action-1",
              paneId: "%3",
              action: "view",
            },
          }));
        }
        if (message.type === "control") resolve(message);
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(response).toEqual({
      type: "control",
      payload: {
        type: "actions.result",
        requestId: "action-1",
        result: { type: "success", message: "opened" },
      },
    });
    expect(calls).toEqual([{ paneId: "%3", actionId: "view" }]);
    client.close();
    await daemon.stop();
  });

  it("surfaces gateway/provider failures as typed control errors", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "control-provider-failure-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      workspaceProvider: async () => {
        throw new Error("workspace exploded");
      },
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "after-hello" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pong") {
          client.send(JSON.stringify({
            type: "control",
            payload: { type: "workspace.snapshot", requestId: "workspace-fail" },
          }));
        }
        if (m.type === "control") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(received.find((message) => message.type === "control")).toEqual({
      type: "control",
      payload: {
        type: "error",
        requestId: "workspace-fail",
        code: "internal_error",
        message: "workspace exploded",
      },
    });

    client.close();
    await daemon.stop();
  });

  it("answers listRituals for authenticated clients", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "ritual-list-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const rituals: Ritual[] = [{
      id: "ritual.solo",
      displayName: "Solo",
      description: "One pane",
      scope: "builtIn",
      projectId: null,
    }];
    let requestedProjectId: string | null | undefined;

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => [],
      projectProvider: () => [],
      ritualProvider: (projectId) => {
        requestedProjectId = projectId;
        return rituals;
      },
      launchRitual: async () => {},
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "listRituals", payload: { projectId: "p1" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "ritualList") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    const ritualList = received.find((x: any) => x.type === "ritualList");
    expect(requestedProjectId).toBe("p1");
    expect(ritualList.payload).toEqual({ projectId: "p1", rituals });

    client.close();
    await daemon.stop();
  });

  it("broadcasts refreshed panes and projects after launchRitual succeeds", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "ritual-launch-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    let panes: PaneSnapshot[] = [{
      id: "%1",
      displayName: "psyche",
      kind: "control",
      projectId: "p1",
      projectName: "psyche",
      worktreePath: null,
      agent: null,
      status: "unknown",
    }];
    let projects: Project[] = [{ id: "p1", displayName: "psyche", attentionCount: 0 }];
    const launchCalls: Array<{ projectId: string; ritualId: string; params: Record<string, string> }> = [];

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => panes,
      projectProvider: () => projects,
      ritualProvider: () => [],
      launchRitual: async (projectId, ritualId, params) => {
        launchCalls.push({ projectId, ritualId, params });
        panes = [...panes, {
          id: "%2",
          displayName: "Ritual pane",
          kind: "worktree",
          projectId,
          projectName: "psyche",
          worktreePath: "/tmp/psyche-worktree",
          agent: "codex",
          status: "working",
        }];
        projects = [{ id: "p1", displayName: "psyche", attentionCount: 1 }];
      },
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({
          type: "launchRitual",
          payload: { projectId: "p1", ritualId: "ritual.solo", params: { branch: "main" } },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "paneListChanged") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(launchCalls).toEqual([
      { projectId: "p1", ritualId: "ritual.solo", params: { branch: "main" } },
    ]);
    expect(received.find((x: any) => x.type === "projectList").payload).toEqual(projects);
    expect(received.find((x: any) => x.type === "paneListChanged").payload).toEqual(panes);

    client.close();
    await daemon.stop();
  });

  it("does not report ritual_failed when post-launch state broadcast fails", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "ritual-broadcast-failure-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];
    let launched = false;

    const daemon = new BridgeDaemon({
      serverId: "test-srv",
      serverName: "test",
      projectName: "psyche",
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      paneProvider: () => {
        throw new Error("pane provider failed");
      },
      projectProvider: () => [],
      ritualProvider: () => [],
      launchRitual: async () => {
        launched = true;
      },
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({
          type: "launchRitual",
          payload: { projectId: "p1", ritualId: "ritual.solo", params: {} },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "error") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(launched).toBe(true);
    expect(received.find((x: any) => x.payload?.code === "ritual_failed")).toBeUndefined();
    expect(received.find((x: any) => x.payload?.code === "state_update_failed")).toBeTruthy();

    client.close();
    await daemon.stop();
  });

  it("closes the connection on protocol version mismatch", async () => {
    const daemon = new BridgeDaemon({
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore: new FakeTokenStore() as any,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];
    const mismatch = `protocol mismatch: client=99 supported=${SUPPORTED_PROTOCOL_VERSIONS.join(",")}`;
    let closeReason = "";
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: 99, token: null },
        }));
      });
      client.on("message", (raw) => {
        received.push(JSON.parse(raw.toString("utf8")));
      });
      client.on("close", (_code, reason) => {
        closeReason = reason.toString();
        resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("expected close")), 2000);
    });
    expect(received).toContainEqual({
      type: "error",
      payload: { code: "closing", message: mismatch },
    });
    expect(closeReason).toBe(mismatch);
    await daemon.stop();
  });

  it("subscribePane delivers snapshot then live tail; unsubscribePane stops", async () => {
    const { PaneOutputBuffer } = await import("../../src/services/bridge/PaneOutputBuffer");
    const buf = new PaneOutputBuffer();
    buf.write(Buffer.from("seed\n"));
    // stub hub that returns our controlled buffer
    const fakeHub: any = {
      start() {}, stop() {}, sendInput() {},
      bufferFor: (_id: string) => buf,
      forgetPane() {},
    };

    // Set up a FakeTokenStore with a known token so hello-with-token authenticates
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "subscribePane-test-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const daemon = new BridgeDaemon({
      serverId: "test", serverName: "test", projectName: "psyche",
      sessionName: "test-session",
      paneProvider: () => [],
      projectProvider: () => [],
      hubFactory: () => fakeHub,
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const { PROTOCOL_VERSION } = await import("../../src/services/bridge/wireProtocol");
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const outputs: any[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({
          type: "subscribePane",
          payload: { paneId: "%1", sinceSeq: null },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "paneOutput") {
          outputs.push(m.payload);
          if (outputs.length === 1) {
            // server has delivered initial snapshot — write more to verify live tail
            buf.write(Buffer.from("live\n"));
          } else if (outputs.length === 2) {
            resolve();
          }
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });
    expect(Buffer.from(outputs[0].data, "base64").toString()).toBe("seed\n");
    expect(Buffer.from(outputs[1].data, "base64").toString()).toBe("live\n");
    client.close();
    await daemon.stop();
  });

  it("serializes messages so subscribePane waits for async hello auth", async () => {
    const { PaneOutputBuffer } = await import("../../src/services/bridge/PaneOutputBuffer");
    const buf = new PaneOutputBuffer();
    buf.write(Buffer.from("seed\n"));
    const fakeHub: any = {
      start() {}, stop() {}, sendInput() {},
      bufferFor: (_id: string) => buf,
      forgetPane() {},
    };

    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "delayed-auth-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];
    const originalValidate = tokenStore.validate.bind(tokenStore);
    tokenStore.validate = async (token: string) => {
      await new Promise(r => setTimeout(r, 25));
      return originalValidate(token);
    };

    const daemon = new BridgeDaemon({
      sessionName: "test-session",
      paneProvider: () => [],
      projectProvider: () => [],
      hubFactory: () => fakeHub,
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({
          type: "subscribePane",
          payload: { paneId: "%1", sinceSeq: null },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "paneOutput") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(received.find((x: any) => x.payload?.code === "not_authenticated")).toBeUndefined();
    expect(Buffer.from(received.find((x: any) => x.type === "paneOutput").payload.data, "base64").toString()).toBe("seed\n");
    client.close();
    await daemon.stop();
  });

  it("replaces duplicate subscribePane listeners for a session", async () => {
    const { PaneOutputBuffer } = await import("../../src/services/bridge/PaneOutputBuffer");
    const buf = new PaneOutputBuffer();
    const fakeHub: any = {
      start() {}, stop() {}, sendInput() {},
      bufferFor: (_id: string) => buf,
      forgetPane() {},
    };
    const tokenStore = new FakeTokenStore() as any;
    const knownToken = "duplicate-subscribe-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "c",
      clientName: "c",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const daemon = new BridgeDaemon({
      sessionName: "test-session",
      paneProvider: () => [],
      projectProvider: () => [],
      hubFactory: () => fakeHub,
      ...noopRituals,
      tokenStore,
    });
    const { port } = await daemon.start();
    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const outputs: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        client.send(JSON.stringify({ type: "subscribePane", payload: { paneId: "%1", sinceSeq: null } }));
        client.send(JSON.stringify({ type: "subscribePane", payload: { paneId: "%1", sinceSeq: null } }));
        client.send(JSON.stringify({ type: "ping", payload: { token: "after-subscribe" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "paneOutput") outputs.push(m.payload);
        if (m.type === "pong" && m.payload.token === "after-subscribe") {
          buf.write(Buffer.from("live\n"));
          setTimeout(resolve, 25);
        }
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(outputs).toHaveLength(1);
    expect(Buffer.from(outputs[0].data, "base64").toString()).toBe("live\n");
    client.close();
    await daemon.stop();
  });

  it("pair flow: open window → connect → receives pairChallenge → submit code → pairAccepted with token", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const pairingFlow = new PairingFlow();
    const daemon = new BridgeDaemon({
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore,
      pairingFlow,
    });
    const { port } = await daemon.start();

    // Open the pair window BEFORE the client connects
    pairingFlow.open();
    const code = pairingFlow.peek()!.code;

    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        // After welcome (and pairChallenge since window is already open), send hello then pair
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "ios-1", clientName: "iPhone", protocolVersion: PROTOCOL_VERSION, token: null },
        }));
        client.send(JSON.stringify({
          type: "pair",
          payload: { code, clientId: "ios-1", clientName: "iPhone" },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pairAccepted") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    expect(received.find((x: any) => x.type === "welcome")).toBeTruthy();
    expect(received.find((x: any) => x.type === "pairChallenge")).toBeTruthy();
    const accepted = received.find((x: any) => x.type === "pairAccepted");
    expect(accepted).toBeTruthy();
    expect(typeof accepted.payload.token).toBe("string");
    expect(accepted.payload.token.length).toBeGreaterThan(0);

    // The token should now be in the store
    const devices = await tokenStore.list();
    expect(devices).toHaveLength(1);

    client.close();
    await daemon.stop();
  });

  it("pairRejected with reason invalid_code when wrong code submitted", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const pairingFlow = new PairingFlow();
    const daemon = new BridgeDaemon({
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore,
      pairingFlow,
    });
    const { port } = await daemon.start();

    // Open a pair window
    pairingFlow.open();

    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "pair",
          payload: { code: "000000", clientId: "ios-1", clientName: "iPhone" },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pairRejected") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    // The actual code won't be "000000" (unless very unlucky), so we expect rejection
    // But if by chance it matched, the test would still pass for wrong-code semantics
    // More robustly: use a clearly wrong code
    const rejected = received.find((x: any) => x.type === "pairRejected");
    expect(rejected).toBeTruthy();
    expect(rejected.payload.reason).toBe("invalid_code");

    client.close();
    await daemon.stop();
  });

  it("pairRejected with reason no_window_open when no pair window is active", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const pairingFlow = new PairingFlow(); // no open() call
    const daemon = new BridgeDaemon({
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore,
      pairingFlow,
    });
    const { port } = await daemon.start();

    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const received: any[] = [];

    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "pair",
          payload: { code: "123456", clientId: "ios-1", clientName: "iPhone" },
        }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        received.push(m);
        if (m.type === "pairRejected") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    const rejected = received.find((x: any) => x.type === "pairRejected");
    expect(rejected).toBeTruthy();
    expect(rejected.payload.reason).toBe("no_window_open");

    client.close();
    await daemon.stop();
  });

  it("revokeDevice closes any live session authenticated with that token", async () => {
    const tokenStore = new FakeTokenStore() as any;
    const pairingFlow = new PairingFlow();
    const daemon = new BridgeDaemon({
      paneProvider: () => [],
      projectProvider: () => [],
      sessionName: "test-session",
      hubFactory: noopHubFactory,
      ...noopRituals,
      tokenStore,
      pairingFlow,
    });
    const { port } = await daemon.start();

    // Pre-seed token store with a known token
    const knownToken = "revoke-test-token";
    tokenStore.records = [{
      token: knownToken,
      clientId: "ios-1",
      clientName: "iPhone",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }];

    const client = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });

    // Authenticate the session; use a ping/pong round-trip to confirm the server
    // has fully processed the hello (which is async due to token.validate)
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "hello",
          payload: { clientId: "ios-1", clientName: "iPhone", protocolVersion: PROTOCOL_VERSION, token: knownToken },
        }));
        // Ping after hello; server processes messages in order so pong means hello is done
        client.send(JSON.stringify({ type: "ping", payload: { token: "sync" } }));
      });
      client.on("message", (raw) => {
        const m = JSON.parse(raw.toString("utf8"));
        if (m.type === "pong" && m.payload.token === "sync") resolve();
      });
      client.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 2000);
    });

    // Now revoke the device — the live session should be closed
    const closed = new Promise<void>((resolve) => {
      client.on("close", () => resolve());
    });

    const revoked = await daemon.revokeDevice(knownToken);
    expect(revoked).toBe(true);

    // Wait for the close event on the client
    await Promise.race([
      closed,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("socket not closed")), 2000)),
    ]);

    // Token should be gone from the store
    const devices = await tokenStore.list();
    expect(devices).toHaveLength(0);

    await daemon.stop();
  });
});
