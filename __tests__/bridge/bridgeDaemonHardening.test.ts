import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BridgeDaemon, LEGACY_PANE_SCOPE_TTL_MS } from "../../src/services/bridge/BridgeDaemon";
import { PaneStreamHub } from "../../src/services/bridge/PaneStreamHub";
import { PairingFlow, PAIR_MAX_ATTEMPTS } from "../../src/services/bridge/PairingFlow";
import { MAX_CLIENT_FRAME_BYTES } from "../../src/services/bridge/WSSListener";
import { PROTOCOL_VERSION } from "../../src/services/bridge/wireProtocol";
import { WORKSPACE_SNAPSHOT_FIXTURE } from "../../protocol-fixtures/fixtures";

/**
 * Hardening tests for the LAN-facing bridge daemon.
 *
 * This listener binds 0.0.0.0 and advertises itself over Bonjour, and it runs
 * inside the psyche TUI process — so a crash here takes the user's whole
 * session with it, and a successful pair grants pane input, i.e. commands in
 * the user's terminals.
 */

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

/** Records what would have reached tmux, without touching a real session. */
class RecordingHub extends PaneStreamHub {
  readonly inputs: Array<{ paneId: string; data: Buffer }> = [];
  override start(): void {}
  override stop(): void {}
  override async sendInput(paneId: string, data: Buffer): Promise<void> {
    this.inputs.push({ paneId, data });
  }
}

let running: BridgeDaemon[] = [];
let clients: WebSocket[] = [];
let daemonCounter = 0;

afterEach(async () => {
  for (const c of clients) {
    try { c.close(); } catch { /* already gone */ }
  }
  clients = [];
  await Promise.all(running.map((d) => d.stop().catch(() => {})));
  running = [];
});

function startDaemon(overrides: Record<string, unknown> = {}) {
  const hub = new RecordingHub("test-session");
  const pairing = new PairingFlow();
  daemonCounter += 1;
  const daemon = new BridgeDaemon({
    serverId: "test-srv",
    serverName: `test-${daemonCounter}`,
    projectName: "psyche",
    sessionName: "test-session",
    hubFactory: () => hub,
    // The legacy pane list is what v2 publishes when no workspace snapshot is
    // wired, so the ids the tests below drive must appear in it.
    paneProvider: () => [{ id: "%1" }, { id: "%4" }],
    projectProvider: () => [],
    ritualProvider: () => [],
    launchRitual: async () => {},
    tokenStore: new FakeTokenStore() as any,
    pairingFlow: pairing,
    ...overrides,
  } as any);
  running.push(daemon);
  return { daemon, hub, pairing };
}

/** Connect, collect every server message, and expose a send helper. */
async function connect(port: number) {
  const socket = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  clients.push(socket);
  const messages: any[] = [];
  const closes: Array<{ code: number }> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString("utf8"))));
  socket.on("close", (code) => closes.push({ code }));
  socket.on("error", () => { /* surfaced through `closes` */ });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    socket,
    messages,
    closes,
    send: (msg: unknown) => socket.send(JSON.stringify(msg)),
    /** Wait until `predicate` holds over the collected messages, or time out. */
    async until(predicate: () => boolean, label: string, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${label}; saw ${JSON.stringify(messages)}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

async function authenticate(client: Awaited<ReturnType<typeof connect>>, pairing: PairingFlow) {
  const w = pairing.open();
  client.send({
    type: "hello",
    payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: null },
  });
  client.send({ type: "pair", payload: { code: w.code, clientId: "c", clientName: "c" } });
  await client.until(() => client.messages.some((m) => m.type === "pairAccepted"), "pairAccepted");
}

describe("bridge daemon pairing brute force", () => {
  it("rejects the window after PAIR_MAX_ATTEMPTS wrong codes and says why", async () => {
    const { daemon, pairing } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);

    const w = pairing.open();
    const wrong = w.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < PAIR_MAX_ATTEMPTS; i++) {
      client.send({ type: "pair", payload: { code: wrong, clientId: "c", clientName: "c" } });
    }
    await client.until(
      () => client.messages.filter((m) => m.type === "pairRejected").length === PAIR_MAX_ATTEMPTS,
      "all pair rejections",
    );

    const rejections = client.messages.filter((m) => m.type === "pairRejected");
    expect(rejections.slice(0, -1).every((m) => m.payload.reason === "invalid_code")).toBe(true);
    expect(rejections.at(-1).payload.reason).toBe("too_many_attempts");
    expect(pairing.isOpen()).toBe(false);

    // The real code no longer works either — the host must re-open the window.
    client.send({ type: "pair", payload: { code: w.code, clientId: "c", clientName: "c" } });
    await client.until(
      () => client.messages.filter((m) => m.type === "pairRejected").length === PAIR_MAX_ATTEMPTS + 1,
      "post-exhaustion rejection",
    );
    expect(client.messages.some((m) => m.type === "pairAccepted")).toBe(false);
  });
});

describe("bridge daemon pane input validation", () => {
  it("never forwards a pane id that would inject a tmux command", async () => {
    const { daemon, hub, pairing } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({
      type: "sendInput",
      payload: {
        paneId: "%1'\nrun-shell 'touch /tmp/psyche-pwned'",
        data: Buffer.from("whoami\r").toString("base64"),
      },
    });
    await client.until(
      () => client.messages.some((m) => m.payload?.code === "invalid_pane"),
      "invalid_pane error",
    );
    expect(hub.inputs).toEqual([]);
  });

  it("rejects non-string input data instead of throwing into the transport", async () => {
    const { daemon, hub, pairing } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({ type: "sendInput", payload: { paneId: "%1", data: { evil: true } } });
    await client.until(
      () => client.messages.some((m) => m.payload?.code === "invalid_input"),
      "invalid_input error",
    );
    expect(hub.inputs).toEqual([]);
  });

  it("rejects malformed base64 rather than typing mangled bytes into the pane", async () => {
    // Buffer.from(..., 'base64') drops characters outside the alphabet instead
    // of throwing, so this used to reach the terminal as silent garbage.
    const { daemon, hub, pairing } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    for (const data of ["!!!!", "zz z", "bHM", "ab==cd"]) {
      client.send({ type: "sendInput", payload: { paneId: "%1", data } });
    }
    await client.until(
      () => client.messages.filter((m) => m.payload?.code === "invalid_input").length === 4,
      "four invalid_input errors",
    );
    expect(hub.inputs).toEqual([]);
  });

  it("still forwards well-formed input", async () => {
    const { daemon, hub, pairing } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({
      type: "sendInput",
      payload: { paneId: "%4", data: Buffer.from("ls\r").toString("base64") },
    });
    await client.until(() => hub.inputs.length === 1, "forwarded input");
    expect(hub.inputs[0].paneId).toBe("%4");
    expect(hub.inputs[0].data.toString("utf8")).toBe("ls\r");
  });

  it("rejects a subscription to a malformed pane id", async () => {
    // Subscribing allocates a replay buffer keyed by the id, so garbage ids
    // must not be accepted just because they never reach tmux directly.
    const { daemon, pairing } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({ type: "subscribePane", payload: { paneId: "%1\nkill-server" } });
    await client.until(
      () => client.messages.some((m) => m.payload?.code === "invalid_pane"),
      "invalid_pane error",
    );
  });

  it("drops input from an unauthenticated session", async () => {
    const { daemon, hub } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);

    client.send({
      type: "sendInput",
      payload: { paneId: "%4", data: Buffer.from("ls\r").toString("base64") },
    });
    client.send({ type: "ping", payload: { token: "probe" } });
    // The pong proves the sendInput frame was already processed and ignored.
    await client.until(() => client.messages.some((m) => m.type === "pong"), "pong");
    expect(hub.inputs).toEqual([]);
  });
});

/** A tmux pane the fixture workspace publishes. */
const PUBLISHED_PANE = "%3";
/** Well-formed tmux pane ids the fixture workspace does not publish. */
const UNPUBLISHED_PANES = ["%999", "%1"];
/** The fixture publishes this pane, but it is a Coven session, not tmux. */
const NON_TMUX_PANE = "coven:review";

function startScopedDaemon() {
  let workspace: any = structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace);
  const started = startDaemon({ workspaceProvider: () => workspace });
  return {
    ...started,
    setWorkspace(next: any) { workspace = next; },
    workspace: () => workspace,
  };
}

function withoutPane(workspace: any, paneId: string) {
  const next = structuredClone(workspace);
  for (const project of next.projects) {
    project.projectPanes = project.projectPanes.filter((pane: any) => pane.id !== paneId);
    for (const worktree of project.worktrees) {
      worktree.panes = worktree.panes.filter((pane: any) => pane.id !== paneId);
    }
  }
  return next;
}

/** Proves every earlier frame on the socket has been handled. */
async function drain(client: Awaited<ReturnType<typeof connect>>, token: string) {
  client.send({ type: "ping", payload: { token } });
  await client.until(
    () => client.messages.some((m) => m.type === "pong" && m.payload?.token === token),
    `pong ${token}`,
  );
}

function scopeErrors(client: Awaited<ReturnType<typeof connect>>) {
  return client.messages.filter((m) => m.type === "error" && m.payload?.code === "unknown_pane");
}

/**
 * Issue #503: tmux pane ids are server-global, so a v2 frame naming a
 * well-formed id outside the published workspace would otherwise reach a
 * shell Psyche Build never created. v2 must apply the v3 published-pane scope.
 */
describe("bridge daemon v2 pane scope", () => {
  it("refuses input to a well-formed pane the workspace does not publish", async () => {
    const { daemon, hub, pairing } = startScopedDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    for (const paneId of [...UNPUBLISHED_PANES, NON_TMUX_PANE]) {
      client.send({
        type: "sendInput",
        payload: { paneId, data: Buffer.from("whoami\r").toString("base64") },
      });
    }
    await drain(client, "after-input");

    expect(hub.inputs).toEqual([]);
    // The non-tmux id fails the shape check first; the tmux-shaped ones fail scope.
    expect(scopeErrors(client)).toHaveLength(UNPUBLISHED_PANES.length);
  });

  it("refuses a subscription to a well-formed pane the workspace does not publish", async () => {
    const { daemon, hub, pairing } = startScopedDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    for (const paneId of UNPUBLISHED_PANES) {
      client.send({ type: "subscribePane", payload: { paneId, sinceSeq: null } });
    }
    await drain(client, "after-subscribe");

    expect(scopeErrors(client)).toHaveLength(UNPUBLISHED_PANES.length);
    // No replay buffer was allocated for the refused ids.
    expect(hub.bufferedPaneIds()).toEqual([]);
    expect((daemon as any).paneSubscribers.size).toBe(0);
  });

  it("answers with a bounded error that leaks neither internals nor the pane list", async () => {
    const { daemon, pairing } = startScopedDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({
      type: "sendInput",
      payload: { paneId: "%999", data: Buffer.from("x").toString("base64") },
    });
    await client.until(() => scopeErrors(client).length === 1, "unknown_pane error");

    const [error] = scopeErrors(client);
    expect(error).toEqual({
      type: "error",
      payload: { code: "unknown_pane", message: "pane is not published by this host" },
    });
    const text = JSON.stringify(error);
    expect(text).not.toContain(PUBLISHED_PANE);
    expect(text).not.toContain("%9");
    expect(text).not.toMatch(/Error|stack|at \w/);
  });

  it("fails closed with the same bounded error when the workspace cannot be read", async () => {
    const { daemon, hub, pairing } = startDaemon({
      workspaceProvider: () => { throw new Error("secret internal path /Users/someone/x"); },
    });
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({
      type: "sendInput",
      payload: { paneId: PUBLISHED_PANE, data: Buffer.from("ls\r").toString("base64") },
    });
    client.send({ type: "subscribePane", payload: { paneId: PUBLISHED_PANE, sinceSeq: null } });
    await drain(client, "after-failure");

    expect(hub.inputs).toEqual([]);
    expect(scopeErrors(client)).toHaveLength(2);
    expect(JSON.stringify(client.messages)).not.toContain("secret internal path");
  });

  it("still serves a pane the workspace publishes", async () => {
    const { daemon, hub, pairing } = startScopedDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    hub.bufferFor(PUBLISHED_PANE).write(Buffer.from("seed\n"));
    client.send({ type: "subscribePane", payload: { paneId: PUBLISHED_PANE, sinceSeq: null } });
    client.send({
      type: "sendInput",
      payload: { paneId: PUBLISHED_PANE, data: Buffer.from("ls\r").toString("base64") },
    });
    await client.until(() => hub.inputs.length === 1, "forwarded input");
    await client.until(
      () => client.messages.some((m) => m.type === "paneOutput" && m.payload.paneId === PUBLISHED_PANE),
      "replayed output",
    );

    expect(hub.inputs[0]).toEqual({ paneId: PUBLISHED_PANE, data: Buffer.from("ls\r") });
    expect(scopeErrors(client)).toEqual([]);
  });

  it("refuses a pane once the workspace stops publishing it", async () => {
    const { daemon, hub, pairing, setWorkspace, workspace } = startScopedDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    client.send({
      type: "sendInput",
      payload: { paneId: PUBLISHED_PANE, data: Buffer.from("one").toString("base64") },
    });
    await client.until(() => hub.inputs.length === 1, "input while published");

    // The host announces every pane change (synchronizeWorkspacePublication);
    // the un-announced case is bounded by the scope TTL, tested separately.
    setWorkspace(withoutPane(workspace(), PUBLISHED_PANE));
    daemon.notifyWorkspaceChanged();
    client.send({
      type: "sendInput",
      payload: { paneId: PUBLISHED_PANE, data: Buffer.from("two").toString("base64") },
    });
    client.send({ type: "subscribePane", payload: { paneId: PUBLISHED_PANE, sinceSeq: null } });
    await drain(client, "after-unpublish");

    expect(hub.inputs.map((input) => input.data.toString("utf8"))).toEqual(["one"]);
    expect(scopeErrors(client)).toHaveLength(2);
  });

  it("scopes to the legacy pane list when no workspace snapshot is wired", async () => {
    const { daemon, hub, pairing } = startDaemon({ paneProvider: () => [{ id: "%4" }] });
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    for (const paneId of ["%4", "%5"]) {
      client.send({
        type: "sendInput",
        payload: { paneId, data: Buffer.from("ls\r").toString("base64") },
      });
    }
    await drain(client, "after-legacy");

    expect(hub.inputs.map((input) => input.paneId)).toEqual(["%4"]);
    expect(scopeErrors(client)).toHaveLength(1);
  });
});

/** A workspace provider that counts reads and can hold one open on demand. */
function gatedWorkspace() {
  let workspace: any = structuredClone(WORKSPACE_SNAPSHOT_FIXTURE.workspace);
  let gate: Promise<void> | null = null;
  let release: () => void = () => {};
  let held = 0;
  let reads = 0;
  return {
    provider: async () => {
      reads += 1;
      if (gate) {
        held += 1;
        await gate;
      }
      return workspace;
    },
    hold() { gate = new Promise<void>((r) => { release = r; }); },
    release() { const r = release; gate = null; r(); },
    held: () => held,
    reads: () => reads,
    set(next: any) { workspace = next; },
    get: () => workspace,
  };
}

async function settle(daemon: BridgeDaemon) {
  await (daemon as any).workspaceOperationQueue;
  await new Promise((r) => setTimeout(r, 30));
}

describe("bridge daemon v2 pane scope races", () => {
  for (const frame of ["sendInput", "subscribePane"] as const) {
    for (const ending of ["revoke", "close"] as const) {
      it(`drops a ${frame} whose session ends (${ending}) during the scope check`, async () => {
        const ws = gatedWorkspace();
        const { daemon, hub, pairing } = startDaemon({ workspaceProvider: ws.provider });
        const { port } = await daemon.start();
        const client = await connect(port);
        await authenticate(client, pairing);
        const token = client.messages.find((m) => m.type === "pairAccepted").payload.token;

        ws.hold();
        client.send(frame === "sendInput"
          ? { type: "sendInput", payload: { paneId: PUBLISHED_PANE, data: Buffer.from("rm -rf ~\r").toString("base64") } }
          : { type: "subscribePane", payload: { paneId: PUBLISHED_PANE, sinceSeq: null } });
        await client.until(() => ws.held() > 0, "scope check in flight");

        if (ending === "revoke") {
          expect(await daemon.revokeDevice(token)).toBe(true);
        } else {
          client.socket.close();
        }
        const sessions = (daemon as any).listener.activeSessions as Set<unknown>;
        await client.until(() => sessions.size === 0, "session torn down");
        ws.release();
        await settle(daemon);

        expect(hub.inputs).toEqual([]);
        expect((daemon as any).paneSubscribers.size).toBe(0);
        expect(hub.bufferedPaneIds()).toEqual([]);
      });
    }
  }
});

describe("bridge daemon v2 pane scope cache", () => {
  it("does not read a workspace snapshot per keystroke once the scope is warm", async () => {
    const ws = gatedWorkspace();
    const { daemon, hub, pairing } = startDaemon({ workspaceProvider: ws.provider });
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);

    daemon.notifyWorkspaceChanged();
    await settle(daemon);
    const warm = ws.reads();
    expect(warm).toBeGreaterThan(0);

    for (const key of ["l", "s", "\r"]) {
      client.send({ type: "sendInput", payload: { paneId: PUBLISHED_PANE, data: Buffer.from(key).toString("base64") } });
    }
    await client.until(() => hub.inputs.length === 3, "three keystrokes");
    expect(ws.reads()).toBe(warm);
  });

  it("applies an unpublish on the next workspace refresh", async () => {
    const ws = gatedWorkspace();
    const { daemon, hub, pairing } = startDaemon({ workspaceProvider: ws.provider });
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);
    daemon.notifyWorkspaceChanged();
    await settle(daemon);

    ws.set(withoutPane(ws.get(), PUBLISHED_PANE));
    daemon.notifyWorkspaceChanged();
    client.send({ type: "sendInput", payload: { paneId: PUBLISHED_PANE, data: Buffer.from("x").toString("base64") } });
    await drain(client, "after-refresh");

    expect(hub.inputs).toEqual([]);
    expect(scopeErrors(client)).toHaveLength(1);
  });

  it("re-reads the workspace once the cached scope ages out, even without a notification", async () => {
    const ws = gatedWorkspace();
    const { daemon, hub, pairing } = startDaemon({ workspaceProvider: ws.provider });
    const { port } = await daemon.start();
    const client = await connect(port);
    await authenticate(client, pairing);
    daemon.notifyWorkspaceChanged();
    await settle(daemon);

    ws.set(withoutPane(ws.get(), PUBLISHED_PANE));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + LEGACY_PANE_SCOPE_TTL_MS + 1);
    try {
      client.send({ type: "sendInput", payload: { paneId: PUBLISHED_PANE, data: Buffer.from("x").toString("base64") } });
      await drain(client, "after-expiry");
    } finally {
      clock.mockRestore();
    }

    expect(hub.inputs).toEqual([]);
    expect(scopeErrors(client)).toHaveLength(1);
  });
});

describe("bridge daemon transport resilience", () => {
  it("survives an error event on a client socket instead of crashing psyche", async () => {
    const { daemon } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await client.until(() => client.messages.some((m) => m.type === "welcome"), "welcome");

    // `ws` emits 'error' on abrupt peer resets. Without a listener, EventEmitter
    // rethrows and takes down the whole process.
    const sessions = [...(daemon as any).listener.activeSessions];
    expect(sessions).toHaveLength(1);
    expect(() => sessions[0].ctx.socket.emit("error", new Error("simulated reset")))
      .not.toThrow();
  });

  it("caps client frames rather than buffering an arbitrary payload", async () => {
    const { daemon } = startDaemon();
    const { port } = await daemon.start();
    const client = await connect(port);
    await client.until(() => client.messages.some((m) => m.type === "welcome"), "welcome");

    client.socket.send(JSON.stringify({
      type: "ping",
      payload: { token: "x".repeat(MAX_CLIENT_FRAME_BYTES + 1024) },
    }));

    await client.until(() => client.closes.length > 0, "oversized-frame close");
    // 1009 = "message too big" per RFC 6455.
    expect(client.closes[0].code).toBe(1009);
  });
});
