import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BridgeDaemon } from "../../src/services/bridge/BridgeDaemon";
import { PaneStreamHub } from "../../src/services/bridge/PaneStreamHub";
import { PairingFlow, PAIR_MAX_ATTEMPTS } from "../../src/services/bridge/PairingFlow";
import { MAX_CLIENT_FRAME_BYTES } from "../../src/services/bridge/WSSListener";
import { PROTOCOL_VERSION } from "../../src/services/bridge/wireProtocol";

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
  override sendInput(paneId: string, data: Buffer): void {
    this.inputs.push({ paneId, data });
  }
}

let running: BridgeDaemon[] = [];
let clients: WebSocket[] = [];

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
  const daemon = new BridgeDaemon({
    serverId: "test-srv",
    serverName: "test",
    projectName: "psyche",
    sessionName: "test-session",
    hubFactory: () => hub,
    paneProvider: () => [],
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
