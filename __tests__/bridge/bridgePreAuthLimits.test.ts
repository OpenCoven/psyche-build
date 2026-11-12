import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import { WebSocket } from "ws";
import { BridgeDaemon } from "../../src/services/bridge/BridgeDaemon";
import { PaneStreamHub } from "../../src/services/bridge/PaneStreamHub";
import {
  PAIR_CODE_LENGTH,
  PAIR_MAX_ATTEMPTS,
  PAIR_WINDOW_MS,
  PairingFlow,
} from "../../src/services/bridge/PairingFlow";
import {
  DEFAULT_PRE_AUTH_LIMITS,
  PRE_AUTH_ERRORS,
  type PreAuthLimits,
} from "../../src/services/bridge/PreAuthGate";
import type { WSSListener } from "../../src/services/bridge/WSSListener";
import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
} from "../../src/services/bridge/wireProtocol";
import { CLIENT_FIXTURES, SERVER_FIXTURES } from "../../protocol-fixtures/fixtures";
import { LogService } from "../../src/services/LogService";
import { ManualScheduler } from "../helpers/manualScheduler";

/**
 * Pre-authentication resource limits on the LAN bridge listener (#556).
 *
 * The listener binds 0.0.0.0 and is advertised over Bonjour, so every host on
 * the network can open a connection to it. These tests drive a real TLS
 * listener over real sockets; only the clock is the test's, so a deadline
 * elapses when the test says so and never by sleeping.
 */

const LIMITS: PreAuthLimits = {
  maxConnections: 6,
  maxConnectionsPerAddress: 3,
  upgradeDeadlineMs: 1_000,
  authDeadlineMs: 60_000,
  maxFrameBytes: 1_024,
  closeGraceMs: 500,
};

/** Text that must never come back in a pre-authentication error. */
const MARKER = "MARKER-7f3a9c";

class CountingTokenStore {
  private records: any[] = [];
  private blocked: Promise<void> | null = null;
  validateCalls = 0;
  issueCalls = 0;
  touchCalls = 0;
  /** Calls that have returned to the daemon, blocked or not. */
  settledCalls = 0;
  /** Hold every later `issue` and `validate` open until the returned release runs. */
  block(): () => void {
    let release!: () => void;
    this.blocked = new Promise<void>((resolve) => { release = resolve; });
    return () => { this.blocked = null; release(); };
  }
  register(token: string) {
    this.records.push({ token, clientId: "c", clientName: "c", pairedAt: "", lastSeenAt: "" });
  }
  async list() { return this.records.slice(); }
  async issue(clientId: string, clientName: string) {
    this.issueCalls += 1;
    await this.blocked;
    this.settledCalls += 1;
    const rec = {
      token: `test-token-${this.records.length}`,
      clientId,
      clientName,
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.records.push(rec);
    return rec;
  }
  async revoke(token: string) {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.token !== token);
    return this.records.length !== before;
  }
  async touch() { this.touchCalls += 1; }
  async validate(token: string) {
    this.validateCalls += 1;
    await this.blocked;
    this.settledCalls += 1;
    return this.records.find((r) => r.token === token) ?? null;
  }
}

/** Let the daemon run whatever it had waiting on a store call that just returned. */
async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
}

class NoopHub extends PaneStreamHub {
  override start(): void {}
  override stop(): void {}
  override async sendInput(): Promise<void> {}
}

let running: BridgeDaemon[] = [];
let sockets: Array<{ destroy?: () => void; terminate?: () => void }> = [];
let daemonCounter = 0;

afterEach(async () => {
  for (const s of sockets) {
    try { s.terminate?.(); s.destroy?.(); } catch { /* already gone */ }
  }
  sockets = [];
  await Promise.all(running.map((d) => d.stop().catch(() => {})));
  running = [];
  vi.restoreAllMocks();
});

async function startDaemon(limits: Partial<PreAuthLimits> | "defaults" = {}) {
  const scheduler = new ManualScheduler();
  const pairing = new PairingFlow();
  const tokens = new CountingTokenStore();
  daemonCounter += 1;
  const daemon = new BridgeDaemon({
    serverId: "test-srv",
    serverName: `pre-auth-${daemonCounter}`,
    projectName: "psyche",
    sessionName: "test-session",
    hubFactory: (name: string) => new NoopHub(name),
    paneProvider: () => [],
    projectProvider: () => [],
    ritualProvider: () => [],
    launchRitual: async () => {},
    bonjourFactory: () => ({ publish() {}, async stop() {} }),
    tokenStore: tokens as any,
    pairingFlow: pairing,
    ...(limits === "defaults"
      ? {}
      : { listenerOptions: { preAuth: { ...LIMITS, ...limits }, scheduler } }),
  } as any);
  running.push(daemon);
  const { port } = await daemon.start();
  const listener = (daemon as any).listener as WSSListener;
  return { daemon, port, pairing, tokens, scheduler, listener };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

type Client = Awaited<ReturnType<typeof connect>>;

/** Open a WebSocket that must be admitted, and collect what the server sends. */
async function connect(port: number, host = "127.0.0.1") {
  const socket = new WebSocket(`wss://${host}:${port}`, { rejectUnauthorized: false });
  sockets.push(socket);
  const messages: any[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString("utf8"))));
  socket.on("close", (code, reason) => closes.push({ code, reason: reason.toString("utf8") }));
  socket.on("error", () => { /* surfaced through `closes` */ });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const client = {
    socket,
    messages,
    closes,
    send: (msg: unknown) => socket.send(JSON.stringify(msg)),
    until: (predicate: () => boolean, label: string) =>
      waitFor(predicate, `${label}; saw ${JSON.stringify(messages)}`),
    errors: () => messages.filter((m) => m.type === "error"),
    /** Proves the socket is still served: every earlier frame has been handled. */
    async roundTrip(token: string) {
      client.send({ type: "ping", payload: { token } });
      await client.until(
        () => messages.some((m) => m.type === "pong" && m.payload?.token === token),
        `pong ${token}`,
      );
    },
  };
  await client.until(() => messages.some((m) => m.type === "welcome"), "welcome");
  return client;
}

/** Attempt a WebSocket connection and report whether the listener admitted it. */
async function attempt(port: number, host = "127.0.0.1"): Promise<"admitted" | "refused"> {
  const socket = new WebSocket(`wss://${host}:${port}`, { rejectUnauthorized: false });
  sockets.push(socket);
  return await new Promise((resolve) => {
    socket.once("open", () => resolve("admitted"));
    socket.once("error", () => resolve("refused"));
  });
}

async function authenticate(client: Client, pairing: PairingFlow, id = "c") {
  const w = pairing.open();
  client.send({
    type: "hello",
    payload: { clientId: id, clientName: id, protocolVersion: PROTOCOL_VERSION, token: null },
  });
  client.send({ type: "pair", payload: { code: w.code, clientId: id, clientName: id } });
  await client.until(() => client.messages.some((m) => m.type === "pairAccepted"), "pairAccepted");
  return client.messages.find((m) => m.type === "pairAccepted").payload.token as string;
}

/** A TCP connection that never speaks TLS. */
async function idleTcp(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  const state = { closed: false };
  socket.on("close", () => { state.closed = true; });
  socket.on("error", () => { /* a reset is the expected ending */ });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return { socket, state };
}

/**
 * A peer that completes the WebSocket upgrade by hand and then never answers
 * anything — including the close handshake a well-behaved client completes.
 */
async function silentWebSocketPeer(port: number) {
  const socket = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false });
  sockets.push(socket);
  const state = { closed: false, received: Buffer.alloc(0) };
  socket.on("data", (chunk: Buffer) => { state.received = Buffer.concat([state.received, chunk]); });
  socket.on("close", () => { state.closed = true; });
  socket.on("error", () => { /* a reset is the expected ending */ });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });
  socket.write([
    "GET / HTTP/1.1",
    "Host: 127.0.0.1",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"));
  await waitFor(() => state.received.includes("101 Switching Protocols"), "upgrade response");
  return { socket, state };
}

/** A non-loopback IPv4 address of this host, if it has one. */
function secondLocalAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

describe("LAN bridge authentication deadline", () => {
  it("closes a connection that has not authenticated when the deadline expires", async () => {
    const { port, scheduler, listener } = await startDaemon();
    const client = await connect(port);

    scheduler.advance(LIMITS.authDeadlineMs - 1);
    await client.roundTrip("still-served");
    expect(client.closes).toEqual([]);

    scheduler.advance(1);
    await client.until(() => client.closes.length > 0, "deadline close");
    expect(client.errors()).toEqual([{ type: "error", payload: PRE_AUTH_ERRORS.deadline }]);
    expect(client.closes[0]).toEqual({ code: 1008, reason: PRE_AUTH_ERRORS.deadline.message });
    await waitFor(() => listener.unauthenticatedConnectionCount === 0, "slot released");
  });

  it("applies the deadline to a peer that said hello but never authenticated", async () => {
    const { port, scheduler } = await startDaemon();
    const client = await connect(port);
    client.send({
      type: "hello",
      payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: "not-a-token" },
    });
    await client.until(() => client.errors().some((m) => m.payload.code === "invalid_token"), "invalid_token");

    scheduler.advance(LIMITS.authDeadlineMs);
    await client.until(() => client.closes.length > 0, "deadline close");
    expect(client.closes[0].code).toBe(1008);
  });

  it("leaves an authenticated session open past the deadline", async () => {
    const { port, scheduler, pairing } = await startDaemon();
    const client = await connect(port);
    await authenticate(client, pairing);

    scheduler.advance(LIMITS.authDeadlineMs * 3);
    await client.roundTrip("after-deadline");
    expect(client.closes).toEqual([]);
    expect(client.errors()).toEqual([]);
    // Nothing is left armed for a connection that authenticated.
    expect(scheduler.pending).toBe(0);
  });

  it("does not leave a device token valid when the deadline closes the connection mid-pairing", async () => {
    // The token is written while the connection is being closed, so the peer
    // never receives it. A credential nobody holds must not stay accepted.
    const { port, scheduler, pairing, tokens, listener } = await startDaemon();
    const client = await connect(port);
    const [session] = [...listener.activeSessions];
    const window = pairing.open();
    const release = tokens.block();

    client.send({ type: "pair", payload: { code: window.code, clientId: "c", clientName: "c" } });
    await waitFor(() => tokens.issueCalls === 1, "token issue started");
    scheduler.advance(LIMITS.authDeadlineMs);
    await client.until(() => client.closes.length > 0, "deadline close");
    release();
    await waitFor(() => tokens.settledCalls === 1, "token issue finished");
    await settle();

    expect(await tokens.list()).toEqual([]);
    expect(session.state).toBe("unauthenticated");
    expect(session.token).toBeNull();
    expect(client.messages.some((m) => m.type === "pairAccepted")).toBe(false);
  });

  it("does not authenticate a connection the deadline closed during the token lookup", async () => {
    const { port, scheduler, tokens, listener } = await startDaemon();
    tokens.register("known-token");
    const client = await connect(port);
    const [session] = [...listener.activeSessions];
    const release = tokens.block();

    client.send({
      type: "hello",
      payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: "known-token" },
    });
    await waitFor(() => tokens.validateCalls === 1, "token lookup started");
    scheduler.advance(LIMITS.authDeadlineMs);
    await client.until(() => client.closes.length > 0, "deadline close");
    release();
    await waitFor(() => tokens.settledCalls === 1, "token lookup finished");
    await settle();

    expect(session.state).toBe("unauthenticated");
    expect(session.token).toBeNull();
    expect(tokens.touchCalls).toBe(0);
    // The device's credential is untouched: it reconnects and authenticates.
    expect(await tokens.list()).toHaveLength(1);
  });

  it("drops a TCP connection that never starts TLS at the upgrade deadline", async () => {
    const { port, scheduler, listener } = await startDaemon();
    const idle = await idleTcp(port);
    await waitFor(() => listener.unauthenticatedConnectionCount === 1, "tcp connection tracked");

    scheduler.advance(LIMITS.upgradeDeadlineMs - 1);
    expect(listener.unauthenticatedConnectionCount).toBe(1);
    scheduler.advance(1);
    await waitFor(() => idle.state.closed, "idle tcp connection dropped");
    await waitFor(() => listener.unauthenticatedConnectionCount === 0, "slot released");
  });

  it("drops a TLS connection that never upgrades to a WebSocket at the upgrade deadline", async () => {
    const { port, scheduler, listener } = await startDaemon();
    const socket = tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false });
    sockets.push(socket);
    let closed = false;
    socket.on("close", () => { closed = true; });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("secureConnect", () => resolve()));
    expect(listener.unauthenticatedConnectionCount).toBe(1);

    scheduler.advance(LIMITS.upgradeDeadlineMs);
    await waitFor(() => closed, "tls-only connection dropped");
  });

  it("drops a peer that ignores the close handshake once the grace has passed", async () => {
    const { port, scheduler, listener } = await startDaemon();
    const peer = await silentWebSocketPeer(port);

    scheduler.advance(LIMITS.authDeadlineMs);
    await waitFor(
      () => peer.state.received.includes(PRE_AUTH_ERRORS.deadline.message),
      "deadline error frame",
    );
    // The error has been delivered and the peer has not answered the close:
    // the connection is still up, held only by the grace timer.
    expect(peer.state.closed).toBe(false);
    expect(listener.unauthenticatedConnectionCount).toBe(1);

    scheduler.advance(LIMITS.closeGraceMs);
    await waitFor(() => peer.state.closed, "silent peer dropped");
    await waitFor(() => listener.unauthenticatedConnectionCount === 0, "slot released");
  });
});

describe("LAN bridge unauthenticated connection cap", () => {
  it("refuses connections beyond the per-address cap and keeps serving the ones it admitted", async () => {
    const { port, listener } = await startDaemon();
    const admitted: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) admitted.push(await connect(port));

    expect(await attempt(port)).toBe("refused");
    expect(await attempt(port)).toBe("refused");

    expect(listener.unauthenticatedConnectionCount).toBe(LIMITS.maxConnectionsPerAddress);
    for (const [i, client] of admitted.entries()) {
      await client.roundTrip(`admitted-${i}`);
      expect(client.closes).toEqual([]);
    }
  });

  it("refuses connections beyond the global cap", async () => {
    const { port } = await startDaemon({ maxConnections: 2, maxConnectionsPerAddress: 2 });
    await connect(port);
    await connect(port);
    expect(await attempt(port)).toBe("refused");
  });

  it("counts connections that have not finished TLS or the upgrade", async () => {
    // Otherwise the cap is bypassed by simply not speaking: a thousand idle
    // TCP connections would cost the host a thousand sockets.
    const { port, listener } = await startDaemon();
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) await idleTcp(port);
    await waitFor(
      () => listener.unauthenticatedConnectionCount === LIMITS.maxConnectionsPerAddress,
      "idle connections tracked",
    );
    expect(await attempt(port)).toBe("refused");
  });

  it("does not count authenticated sessions, and leaves them undisturbed while refusing others", async () => {
    const { port, pairing, listener } = await startDaemon();
    const paired: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress + 1; i += 1) {
      const client = await connect(port);
      await authenticate(client, pairing, `device-${i}`);
      paired.push(client);
    }
    expect(listener.unauthenticatedConnectionCount).toBe(0);

    // The full unauthenticated allowance is still available on top of them.
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) await connect(port);
    expect(await attempt(port)).toBe("refused");

    for (const [i, client] of paired.entries()) {
      await client.roundTrip(`paired-${i}`);
      expect(client.closes).toEqual([]);
      expect(client.errors()).toEqual([]);
    }
    expect(listener.activeSessions.size).toBe(LIMITS.maxConnectionsPerAddress * 2 + 1);
  });

  it("admits connections again once a held slot is released", async () => {
    const { port, listener } = await startDaemon();
    const held: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) held.push(await connect(port));
    expect(await attempt(port)).toBe("refused");

    held[0].socket.close();
    await waitFor(
      () => listener.unauthenticatedConnectionCount === LIMITS.maxConnectionsPerAddress - 1,
      "slot released",
    );
    const next = await connect(port);
    await next.roundTrip("after-release");
    expect(await attempt(port)).toBe("refused");
  });

  it("admits connections again once the deadline clears the cap", async () => {
    const { port, scheduler, listener } = await startDaemon();
    const held: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) held.push(await connect(port));
    expect(await attempt(port)).toBe("refused");

    scheduler.advance(LIMITS.authDeadlineMs);
    await waitFor(() => held.every((client) => client.closes.length > 0), "held connections closed");
    await waitFor(() => listener.unauthenticatedConnectionCount === 0, "slots released");

    const next = await connect(port);
    await next.roundTrip("after-deadline");
  });

  it("admits a connection again once an unauthenticated peer authenticates", async () => {
    const { port, pairing } = await startDaemon();
    const held: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) held.push(await connect(port));
    expect(await attempt(port)).toBe("refused");

    await authenticate(held[0], pairing);
    const next = await connect(port);
    await next.roundTrip("after-authentication");
  });

  it.skipIf(!secondLocalAddress())(
    "keeps a second remote address connectable while the first is at its cap",
    async () => {
      const second = secondLocalAddress()!;
      const { port } = await startDaemon();
      for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) await connect(port);
      expect(await attempt(port)).toBe("refused");

      // Connecting to the host's own LAN address makes that address the peer.
      const other = await connect(port, second);
      await other.roundTrip("second-address");
      expect(await attempt(port)).toBe("refused");
    },
  );

  it("logs refusals a bounded number of times and never the peer's address", async () => {
    const warn = vi.spyOn(LogService.getInstance(), "warn").mockImplementation(() => {});
    const { port, listener } = await startDaemon();
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) await connect(port);

    const refusedAttempts = 20;
    for (let i = 0; i < refusedAttempts; i += 1) expect(await attempt(port)).toBe("refused");
    await waitFor(() => listener.refusedConnectionCount === refusedAttempts, "refusals counted");

    const lines = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("refused an unauthenticated connection"));
    // The 1st, 2nd, 4th, 8th and 16th refusal: five lines for twenty refusals.
    expect(lines).toHaveLength(5);
    // And a refusal raises nothing else: no transport-error line per reset.
    expect(warn.mock.calls).toHaveLength(lines.length);
    expect(lines[0]).toBe("bridge refused an unauthenticated connection (address_cap); 1 refused since start");
    for (const line of lines) expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("spends none of the pairing attempt budget on refused or expired connections", async () => {
    const { port, pairing, scheduler } = await startDaemon();
    const window = pairing.open();
    const held: Client[] = [];
    for (let i = 0; i < LIMITS.maxConnectionsPerAddress; i += 1) held.push(await connect(port));
    for (let i = 0; i < 5; i += 1) expect(await attempt(port)).toBe("refused");
    scheduler.advance(LIMITS.authDeadlineMs);
    await waitFor(() => held.every((client) => client.closes.length > 0), "held connections closed");

    expect(pairing.attemptsRemaining()).toBe(PAIR_MAX_ATTEMPTS);
    expect(pairing.peek()).toEqual(window);
  });
});

describe("LAN bridge pre-authentication frames", () => {
  it("rejects a frame above the pre-auth bound and processes nothing queued behind it", async () => {
    const { port, pairing, listener } = await startDaemon();
    const window = pairing.open();
    const wrong = window.code === "000000" ? "111111" : "000000";
    const client = await connect(port);

    client.send({ type: "ping", payload: { token: MARKER.repeat(LIMITS.maxFrameBytes) } });
    client.send({ type: "pair", payload: { code: wrong, clientId: "c", clientName: "c" } });

    await client.until(() => client.closes.length > 0, "oversized-frame close");
    await waitFor(() => listener.activeSessions.size === 0, "session removed");
    expect(client.errors()).toEqual([{ type: "error", payload: PRE_AUTH_ERRORS.frameTooLarge }]);
    // 1009 = "message too big" per RFC 6455, as for the transport-level cap.
    expect(client.closes[0]).toEqual({ code: 1009, reason: PRE_AUTH_ERRORS.frameTooLarge.message });
    expect(JSON.stringify(client.messages)).not.toContain(MARKER);
    // The pairing guess that followed the rejected frame was never evaluated.
    expect(client.messages.some((m) => m.type === "pairRejected")).toBe(false);
    expect(pairing.attemptsRemaining()).toBe(PAIR_MAX_ATTEMPTS);
  });

  it("accepts a frame exactly at the pre-auth bound", async () => {
    const { port } = await startDaemon();
    const client = await connect(port);
    const envelope = JSON.stringify({ type: "ping", payload: { token: "" } });
    const token = "x".repeat(LIMITS.maxFrameBytes - Buffer.byteLength(envelope));
    client.send({ type: "ping", payload: { token } });
    await client.until(() => client.messages.some((m) => m.type === "pong"), "pong");
    expect(client.closes).toEqual([]);
  });

  it("applies the wider transport cap to a session once it has authenticated", async () => {
    const { port, pairing } = await startDaemon();
    const client = await connect(port);
    await authenticate(client, pairing);

    await client.roundTrip("y".repeat(LIMITS.maxFrameBytes * 8));
    expect(client.closes).toEqual([]);
    expect(client.errors()).toEqual([]);
  });

  it("measures a frame when it is handled, so one queued behind the authenticating frame is served", async () => {
    const { port, pairing, tokens } = await startDaemon();
    const first = await connect(port);
    const token = await authenticate(first, pairing);
    expect(tokens.validateCalls).toBe(0);

    const client = await connect(port);
    const big = "z".repeat(LIMITS.maxFrameBytes * 4);
    client.send({
      type: "hello",
      payload: { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token },
    });
    client.send({ type: "ping", payload: { token: big } });
    await client.until(
      () => client.messages.some((m) => m.type === "pong" && m.payload.token === big),
      "pong for the large frame",
    );
    expect(client.closes).toEqual([]);
  });

  it("answers an undecodable pre-auth frame with a fixed error that echoes nothing", async () => {
    const { port } = await startDaemon();
    const client = await connect(port);

    client.socket.send(`{"type":"${MARKER}","payload":null}`);
    client.socket.send(`not json ${MARKER}`);
    client.socket.send(JSON.stringify({ type: 7, payload: { note: MARKER } }));
    await client.until(() => client.errors().length === 3, "three parse errors");

    for (const error of client.errors()) {
      expect(error).toEqual({ type: "error", payload: PRE_AUTH_ERRORS.malformedFrame });
    }
    expect(JSON.stringify(client.messages)).not.toContain(MARKER);
    // A malformed frame is answered, not fatal: the socket is still served.
    await client.roundTrip("after-malformed");
  });
});

describe("LAN bridge hello handling", () => {
  const validHello = { clientId: "c", clientName: "c", protocolVersion: PROTOCOL_VERSION, token: null };

  it.each([
    ["a numeric clientId", { ...validHello, clientId: 42 }],
    ["an oversized clientId", { ...validHello, clientId: MARKER.repeat(40) }],
    ["an object clientName", { ...validHello, clientName: { [MARKER]: MARKER } }],
    ["a string protocolVersion", { ...validHello, protocolVersion: MARKER }],
    ["an object protocolVersion", { ...validHello, protocolVersion: { [MARKER]: 3 } }],
    ["an object token", { ...validHello, token: { [MARKER]: true } }],
    ["an empty payload", {}],
  ])("rejects a hello with %s using one fixed error and closes", async (_label, payload) => {
    const { port, tokens, listener } = await startDaemon();
    const client = await connect(port);

    client.send({ type: "hello", payload });
    await client.until(() => client.closes.length > 0, "hello rejection close");

    expect(client.errors()).toEqual([{ type: "error", payload: PRE_AUTH_ERRORS.helloRejected }]);
    expect(client.closes[0]).toEqual({ code: 1008, reason: PRE_AUTH_ERRORS.helloRejected.message });
    expect(JSON.stringify(client.messages)).not.toContain(MARKER);
    expect(tokens.validateCalls).toBe(0);
    await waitFor(() => listener.unauthenticatedConnectionCount === 0, "slot released");
  });

  it("rejects a repeated hello before authentication without a second token lookup", async () => {
    const { port, tokens } = await startDaemon();
    const client = await connect(port);

    client.send({ type: "hello", payload: { ...validHello, token: "guess-1" } });
    await client.until(() => client.errors().some((m) => m.payload.code === "invalid_token"), "invalid_token");
    expect(tokens.validateCalls).toBe(1);

    client.send({ type: "hello", payload: { ...validHello, token: `guess-2-${MARKER}` } });
    await client.until(() => client.closes.length > 0, "repeated hello close");

    expect(client.errors().at(-1)).toEqual({ type: "error", payload: PRE_AUTH_ERRORS.helloRejected });
    expect(client.closes[0].code).toBe(1008);
    expect(tokens.validateCalls).toBe(1);
    expect(JSON.stringify(client.messages)).not.toContain(MARKER);
  });

  it("rejects a repeated hello on an authenticated session without changing or closing it", async () => {
    const { port, pairing, tokens, listener } = await startDaemon();
    const client = await connect(port);
    await authenticate(client, pairing, "original");
    const [session] = [...listener.activeSessions];

    client.send({
      type: "hello",
      payload: { clientId: "imposter", clientName: "imposter", protocolVersion: LEGACY_PROTOCOL_VERSION, token: "guess" },
    });
    await client.until(() => client.errors().length === 1, "repeated hello rejection");
    await client.roundTrip("still-authenticated");

    expect(client.errors()).toEqual([{ type: "error", payload: PRE_AUTH_ERRORS.helloRejected }]);
    expect(client.closes).toEqual([]);
    expect(session.state).toBe("authenticated");
    expect(session.clientId).toBe("original");
    expect(session.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(tokens.validateCalls).toBe(0);
  });

  it("keeps the set of pre-auth refusals closed", () => {
    // Malformed and repeated hellos share `helloRejected`, so a peer cannot
    // tell which check it failed. A new entry here is a new thing a peer is
    // told, and should be a deliberate addition.
    expect(Object.keys(PRE_AUTH_ERRORS).sort()).toEqual(
      ["deadline", "frameTooLarge", "helloRejected", "malformedFrame"],
    );
  });
});

describe("LAN bridge wire contract under the pre-auth limits", () => {
  it("runs with the default limits unless a test overrides them", async () => {
    const { listener } = await startDaemon("defaults");
    expect(listener.preAuthLimits).toEqual(DEFAULT_PRE_AUTH_LIMITS);
  });

  it("answers every pre-authentication client fixture exactly as before", async () => {
    const { port } = await startDaemon("defaults");

    const hello = await connect(port);
    hello.send(CLIENT_FIXTURES.hello);
    await hello.roundTrip("after-hello");
    expect(hello.messages.filter((m) => m.type !== "pong")).toEqual([
      expect.objectContaining({ type: "welcome", payload: expect.objectContaining({ protocolVersion: 2 }) }),
      { type: "error", payload: { code: "invalid_token", message: "token not recognized" } },
    ]);

    const helloNoToken = await connect(port);
    helloNoToken.send(CLIENT_FIXTURES.hello_noToken);
    await helloNoToken.roundTrip("after-hello-no-token");
    expect(helloNoToken.messages.filter((m) => m.type !== "pong").map((m) => m.type)).toEqual(["welcome"]);

    const ping = await connect(port);
    ping.send(CLIENT_FIXTURES.ping);
    await ping.until(() => ping.messages.some((m) => m.type === "pong"), "pong");
    expect(ping.messages.at(-1)).toEqual({ type: "pong", payload: CLIENT_FIXTURES.ping.payload });

    const pair = await connect(port);
    pair.send(CLIENT_FIXTURES.pair);
    await pair.until(() => pair.messages.some((m) => m.type === "pairRejected"), "pairRejected");
    expect(pair.messages.at(-1)).toEqual({ type: "pairRejected", payload: { reason: "no_window_open" } });

    for (const client of [hello, helloNoToken, ping, pair]) expect(client.closes).toEqual([]);
  });

  it("still negotiates v3 from a v3 hello", async () => {
    const { port } = await startDaemon("defaults");
    const client = await connect(port);
    client.send({ ...CLIENT_FIXTURES.hello_noToken, payload: { ...CLIENT_FIXTURES.hello_noToken.payload, protocolVersion: PROTOCOL_VERSION } });
    await client.until(
      () => client.messages.filter((m) => m.type === "welcome").length === 2,
      "v3 welcome",
    );
    expect(client.messages.filter((m) => m.type === "welcome").map((m) => m.payload.protocolVersion))
      .toEqual([LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION]);
  });

  it("reports every limit through the existing error message shape", () => {
    const fixtureKeys = Object.keys(SERVER_FIXTURES.error.payload).sort();
    expect(SERVER_MESSAGE_TYPES).toContain(SERVER_FIXTURES.error.type);
    for (const [name, error] of Object.entries(PRE_AUTH_ERRORS)) {
      expect(Object.keys(error).sort(), name).toEqual(fixtureKeys);
      expect(typeof error.code, name).toBe("string");
      expect(typeof error.message, name).toBe("string");
      // The message doubles as the close reason, which RFC 6455 caps at 123 bytes.
      expect(Buffer.byteLength(error.message), name).toBeLessThanOrEqual(123);
    }
  });

  it("leaves the pairing attempt budget as it was", () => {
    expect(PAIR_MAX_ATTEMPTS).toBe(5);
    expect(PAIR_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(PAIR_CODE_LENGTH).toBe(6);
  });
});
