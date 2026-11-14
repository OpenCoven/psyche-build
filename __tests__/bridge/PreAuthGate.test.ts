import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRE_AUTH_LIMITS,
  PRE_AUTH_DEADLINE_MS,
  PRE_AUTH_ERRORS,
  PRE_AUTH_MAX_BUFFERED_BYTES,
  PRE_AUTH_MAX_INBOUND_BYTES,
  PRE_AUTH_MAX_LOOKUP_BYTES,
  PRE_AUTH_MAX_TRANSPORT_BYTES,
  PRE_AUTH_TRANSPORT_POLL_MS,
  PRE_AUTH_MAX_CONNECTIONS,
  PRE_AUTH_MAX_CONNECTIONS_PER_ADDRESS,
  PRE_AUTH_MAX_FRAME_BYTES,
  PRE_AUTH_UPGRADE_DEADLINE_MS,
  PreAuthGate,
  isWellFormedHello,
  normalizeRemoteAddress,
  resolvePreAuthLimits,
  type PreAuthLimits,
} from "../../src/services/bridge/PreAuthGate";
import { PAIR_WINDOW_MS } from "../../src/services/bridge/PairingFlow";
import { Session } from "../../src/services/bridge/Session";
import { MAX_CLIENT_FRAME_BYTES } from "../../src/services/bridge/WSSListener";
import { CLIENT_FIXTURES } from "../../protocol-fixtures/fixtures";
import { ManualScheduler } from "../helpers/manualScheduler";

/**
 * Policy tests for pre-authentication admission on the LAN bridge (#556).
 *
 * The gate holds no sockets, so the properties that need more than one remote
 * address — which a loopback test cannot produce on every host — are proved
 * here. `bridgePreAuthLimits.test.ts` proves the same limits on a real socket.
 */

const LIMITS: PreAuthLimits = {
  maxConnections: 5,
  maxConnectionsPerAddress: 2,
  upgradeDeadlineMs: 1_000,
  authDeadlineMs: 60_000,
  maxFrameBytes: 512,
  maxBufferedBytes: 2_048,
  maxInboundBytes: 4_096,
  maxTransportBytes: 8_192,
  maxLookupBytes: 65_536,
  closeGraceMs: 500,
};

function transport() {
  const state = { destroyed: 0, bytesRead: 0 };
  return { state, destroy: () => { state.destroyed += 1; }, bytesRead: () => state.bytesRead };
}

function peer(initiallyAuthenticated = false) {
  const state = {
    authenticated: initiallyAuthenticated,
    wasAuthenticated: initiallyAuthenticated,
    authenticating: false,
    open: true,
    rejections: [] as Array<{ error: unknown; closeCode: number }>,
    drops: [] as string[],
  };
  return {
    state,
    isAuthenticated: () => state.authenticated,
    // Latches, as the real session does when its state is set.
    wasAuthenticated: () => { state.wasAuthenticated ||= state.authenticated; return state.wasAuthenticated; },
    drop: (reason: string) => { state.drops.push(reason); },
    isAuthenticating: () => state.authenticating,
    isOpen: () => state.open,
    reject: (error: unknown, closeCode: number) => { state.rejections.push({ error, closeCode }); },
  };
}

function gate(limits: Partial<PreAuthLimits> = {}) {
  const scheduler = new ManualScheduler();
  const drops: string[] = [];
  return {
    scheduler,
    drops,
    gate: new PreAuthGate({ ...LIMITS, ...limits }, scheduler, undefined, (reason) => drops.push(reason)),
  };
}

describe("pre-auth limits", () => {
  it("ships conservative defaults", () => {
    expect(DEFAULT_PRE_AUTH_LIMITS).toEqual({
      maxConnections: PRE_AUTH_MAX_CONNECTIONS,
      maxConnectionsPerAddress: PRE_AUTH_MAX_CONNECTIONS_PER_ADDRESS,
      upgradeDeadlineMs: PRE_AUTH_UPGRADE_DEADLINE_MS,
      authDeadlineMs: PRE_AUTH_DEADLINE_MS,
      maxFrameBytes: PRE_AUTH_MAX_FRAME_BYTES,
      maxBufferedBytes: PRE_AUTH_MAX_BUFFERED_BYTES,
      maxInboundBytes: PRE_AUTH_MAX_INBOUND_BYTES,
      maxTransportBytes: PRE_AUTH_MAX_TRANSPORT_BYTES,
      maxLookupBytes: PRE_AUTH_MAX_LOOKUP_BYTES,
      closeGraceMs: expect.any(Number),
    });
    expect(Object.isFrozen(DEFAULT_PRE_AUTH_LIMITS)).toBe(true);
    expect(PRE_AUTH_MAX_CONNECTIONS_PER_ADDRESS).toBeLessThan(PRE_AUTH_MAX_CONNECTIONS);
    expect(PRE_AUTH_UPGRADE_DEADLINE_MS).toBeLessThan(PRE_AUTH_DEADLINE_MS);
    expect(PRE_AUTH_MAX_FRAME_BYTES).toBeLessThan(MAX_CLIENT_FRAME_BYTES);
  });

  it("sets the deadline no shorter than one pairing window", () => {
    // Pairing is the one legitimate reason to sit unauthenticated: the user
    // reads a code off the host and types it. A connection made at or after
    // the moment a window opens can use all of that window. One made earlier
    // is still closed at its own deadline, which this does not prevent.
    expect(PRE_AUTH_DEADLINE_MS).toBeGreaterThanOrEqual(PAIR_WINDOW_MS);
  });

  it("fits every pre-authentication client fixture inside the frame bound", () => {
    for (const name of ["hello", "hello_noToken", "pair", "ping"] as const) {
      const bytes = Buffer.byteLength(JSON.stringify(CLIENT_FIXTURES[name]), "utf8");
      expect(bytes, name).toBeLessThanOrEqual(PRE_AUTH_MAX_FRAME_BYTES);
    }
  });

  it("merges overrides onto the defaults", () => {
    expect(resolvePreAuthLimits({ maxConnections: 7 })).toEqual({
      ...DEFAULT_PRE_AUTH_LIMITS,
      maxConnections: 7,
    });
    expect(resolvePreAuthLimits()).toEqual(DEFAULT_PRE_AUTH_LIMITS);
  });

  it.each([
    ["a zero connection cap", { maxConnections: 0 }],
    ["a fractional per-address cap", { maxConnectionsPerAddress: 1.5 }],
    ["a per-address cap above the global cap", { maxConnections: 2, maxConnectionsPerAddress: 3 }],
    ["a negative deadline", { authDeadlineMs: -1 }],
    ["an unbounded deadline", { authDeadlineMs: Number.POSITIVE_INFINITY }],
    ["an upgrade deadline beyond the auth deadline", { upgradeDeadlineMs: 10, authDeadlineMs: 5 }],
    ["a zero frame bound", { maxFrameBytes: 0 }],
    ["a frame bound above the transport cap", { maxFrameBytes: MAX_CLIENT_FRAME_BYTES + 1 }],
    ["a NaN grace", { closeGraceMs: Number.NaN }],
    ["a zero outbound buffer bound", { maxBufferedBytes: 0 }],
    ["a zero inbound budget", { maxInboundBytes: 0 }],
    ["a zero transport budget", { maxTransportBytes: 0 }],
    ["a lookup allowance smaller than the transport budget", { maxTransportBytes: 8_192, maxLookupBytes: 8_191 }],
    ["a transport budget smaller than the inbound budget", { maxInboundBytes: 4_096, maxTransportBytes: 4_095 }],
  ])("refuses to start with %s", (_label, override) => {
    // A limit that silently means "no limit" is the failure this change
    // exists to remove, so a bad configuration must not construct.
    expect(() => resolvePreAuthLimits(override)).toThrow(/pre-auth limit/);
  });
});

describe("normalizeRemoteAddress", () => {
  it("treats an IPv4-mapped IPv6 address as its IPv4 address", () => {
    // Otherwise one host reaches the per-address cap twice by alternating forms.
    expect(normalizeRemoteAddress("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeRemoteAddress("::FFFF:192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeRemoteAddress("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeRemoteAddress("fe80::1")).toBe("fe80::1");
  });

  it("returns null when the socket has no remote address", () => {
    expect(normalizeRemoteAddress(undefined)).toBeNull();
    expect(normalizeRemoteAddress("")).toBeNull();
  });
});

describe("PreAuthGate admission", () => {
  it("caps unauthenticated connections per remote address without touching other addresses", () => {
    const { gate: g } = gate();
    expect(g.admit("10.0.0.1", transport())).not.toBeNull();
    expect(g.admit("10.0.0.1", transport())).not.toBeNull();
    expect(g.admit("10.0.0.1", transport())).toBeNull();

    // A second device on the network is not affected by the first one's cap.
    expect(g.admit("10.0.0.2", transport())).not.toBeNull();
    expect(g.unauthenticatedCountFor("10.0.0.1")).toBe(2);
    expect(g.unauthenticatedCountFor("10.0.0.2")).toBe(1);
    expect(g.unauthenticatedCount).toBe(3);
  });

  it("caps unauthenticated connections globally across addresses", () => {
    const { gate: g } = gate();
    for (const address of ["10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.2", "10.0.0.3"]) {
      expect(g.admit(address, transport()), address).not.toBeNull();
    }
    // 10.0.0.3 holds one of its two slots; the global cap is what refuses it.
    expect(g.unauthenticatedCountFor("10.0.0.3")).toBe(1);
    expect(g.admit("10.0.0.3", transport())).toBeNull();
    expect(g.admit("10.0.0.4", transport())).toBeNull();
    expect(g.unauthenticatedCount).toBe(5);
  });

  it("does not count authenticated connections against either cap", () => {
    const { gate: g } = gate();
    const peers = [];
    for (let i = 0; i < 5; i += 1) {
      const connection = g.admit("10.0.0.1", transport());
      expect(connection, `connection ${i}`).not.toBeNull();
      const p = peer();
      g.attach(connection!, p);
      p.state.authenticated = true;
      peers.push(p);
    }
    expect(g.unauthenticatedCount).toBe(0);
    expect(g.admit("10.0.0.1", transport())).not.toBeNull();
    // Admission never calls back into a peer it is not rejecting.
    expect(peers.every((p) => p.state.rejections.length === 0)).toBe(true);
  });

  it("counts a connection again once it stops being authenticated", () => {
    // A revoked session drops back to unauthenticated while its socket closes.
    const { gate: g } = gate({ maxConnectionsPerAddress: 1 });
    const connection = g.admit("10.0.0.1", transport())!;
    const p = peer();
    g.attach(connection, p);
    p.state.authenticated = true;
    expect(g.admit("10.0.0.1", transport())).not.toBeNull();

    p.state.authenticated = false;
    expect(g.unauthenticatedCountFor("10.0.0.1")).toBe(2);
    expect(g.admit("10.0.0.1", transport())).toBeNull();
  });

  it("frees a slot on release and tolerates a repeated release", () => {
    const { gate: g, scheduler } = gate({ maxConnectionsPerAddress: 1 });
    const connection = g.admit("10.0.0.1", transport())!;
    expect(g.admit("10.0.0.1", transport())).toBeNull();

    g.release(connection);
    g.release(connection);
    expect(g.unauthenticatedCount).toBe(0);
    expect(scheduler.pending).toBe(0);
    expect(g.admit("10.0.0.1", transport())).not.toBeNull();
  });

  it("reports which cap refused a connection, and how many it has refused", () => {
    const refusals: Array<[string, number]> = [];
    const scheduler = new ManualScheduler();
    const g = new PreAuthGate(
      { ...LIMITS, maxConnections: 3, maxConnectionsPerAddress: 2 },
      scheduler,
      (reason, total) => refusals.push([reason, total]),
    );
    g.admit("10.0.0.1", transport());
    g.admit("10.0.0.1", transport());
    g.admit("10.0.0.1", transport());
    g.admit("10.0.0.2", transport());
    g.admit("10.0.0.3", transport());

    expect(refusals).toEqual([["address_cap", 1], ["connection_cap", 2]]);
    expect(g.refusedCount).toBe(2);
  });

  it("does not let a refused connection consume a slot or a timer", () => {
    const { gate: g, scheduler } = gate({ maxConnectionsPerAddress: 1 });
    g.admit("10.0.0.1", transport());
    const armed = scheduler.pending;
    for (let i = 0; i < 50; i += 1) expect(g.admit("10.0.0.1", transport())).toBeNull();
    expect(scheduler.pending).toBe(armed);
    expect(g.unauthenticatedCount).toBe(1);
  });
});

describe("PreAuthGate deadlines", () => {
  it("destroys a connection that never becomes a WebSocket at the upgrade deadline", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    g.admit("10.0.0.1", t);

    scheduler.advance(LIMITS.upgradeDeadlineMs - 1);
    expect(t.state.destroyed).toBe(0);
    scheduler.advance(1);
    expect(t.state.destroyed).toBe(1);
  });

  it("gives an upgraded connection until the authentication deadline, then rejects it", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const p = peer();
    g.attach(g.admit("10.0.0.1", t)!, p);

    scheduler.advance(LIMITS.authDeadlineMs - 1);
    expect(p.state.rejections).toEqual([]);
    expect(t.state.destroyed).toBe(0);

    scheduler.advance(1);
    expect(p.state.rejections).toEqual([{ error: PRE_AUTH_ERRORS.deadline, closeCode: 1008 }]);
    // The peer gets a moment to read the error and complete the close...
    expect(t.state.destroyed).toBe(0);
    // ...and is dropped regardless once the grace has passed.
    scheduler.advance(LIMITS.closeGraceMs);
    expect(t.state.destroyed).toBe(1);
  });

  it("measures the authentication deadline from accept, not from the upgrade", () => {
    const { gate: g, scheduler } = gate();
    const p = peer();
    const connection = g.admit("10.0.0.1", transport())!;
    scheduler.advance(LIMITS.upgradeDeadlineMs - 1);
    g.attach(connection, p);

    scheduler.advance(LIMITS.authDeadlineMs - LIMITS.upgradeDeadlineMs);
    expect(p.state.rejections).toEqual([]);
    scheduler.advance(1);
    expect(p.state.rejections).toHaveLength(1);
  });

  it("leaves an authenticated connection alone at the deadline, with nothing armed afterwards", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const p = peer();
    g.attach(g.admit("10.0.0.1", t)!, p);
    p.state.authenticated = true;

    scheduler.advance(LIMITS.authDeadlineMs * 3);
    expect(p.state.rejections).toEqual([]);
    expect(t.state.destroyed).toBe(0);
    expect(scheduler.pending).toBe(0);
  });

  it("drops a rejected connection after the grace even if it authenticated nothing", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const connection = g.admit("10.0.0.1", t)!;
    g.attach(connection, peer());

    g.rejected(connection);
    g.rejected(connection);
    scheduler.advance(LIMITS.closeGraceMs - 1);
    expect(t.state.destroyed).toBe(0);
    scheduler.advance(1);
    expect(t.state.destroyed).toBe(1);
    // The deadline that would have fired later was cancelled with it.
    expect(scheduler.pending).toBe(0);
  });

  it("drops an unresponsive connection at once, with no grace", () => {
    // A peer that is not reading cannot be told anything; waiting only lets
    // more of its replies queue.
    const { gate: g, scheduler } = gate();
    const t = transport();
    const connection = g.admit("10.0.0.1", t)!;
    g.attach(connection, peer());

    g.drop(connection);
    expect(t.state.destroyed).toBe(1);
    expect(scheduler.pending).toBe(0);
  });

  it("holds no timer once a connection is released", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const p = peer();
    const connection = g.admit("10.0.0.1", t)!;
    g.attach(connection, p);
    g.release(connection);

    expect(scheduler.pending).toBe(0);
    scheduler.advance(LIMITS.authDeadlineMs * 2);
    expect(p.state.rejections).toEqual([]);
    expect(t.state.destroyed).toBe(0);
  });

  it("clears every timer and drops every unauthenticated connection on dispose", () => {
    const { gate: g, scheduler } = gate();
    const idle = transport();
    const unpaired = transport();
    const paired = transport();
    const pairedPeer = peer();
    g.admit("10.0.0.1", idle);
    g.attach(g.admit("10.0.0.2", unpaired)!, peer());
    g.attach(g.admit("10.0.0.3", paired)!, pairedPeer);
    pairedPeer.state.authenticated = true;

    g.dispose();
    expect(scheduler.pending).toBe(0);
    expect(idle.state.destroyed).toBe(1);
    // With its timers cancelled, nothing else would ever drop this one.
    expect(unpaired.state.destroyed).toBe(1);
    // An authenticated session is closed by its owner, which can say why.
    expect(paired.state.destroyed).toBe(0);
    expect(g.admit("10.0.0.4", transport())).toBeNull();
  });
});

describe("Session outbound bound before authentication", () => {
  function socket(bufferedAmount: number) {
    return { readyState: 1, bufferedAmount, send: vi.fn(), close: vi.fn() };
  }
  const pong = { type: "pong" as const, payload: { token: "t" } };

  it("stops sending to an unauthenticated peer whose replies are not being read", () => {
    const ws = socket(2_049);
    const onDrop = vi.fn();
    const session = new Session({
      socket: ws as any,
      remoteAddress: "10.0.0.1",
      preAuth: { maxBufferedBytes: 2_048, maxInboundBytes: 4_096, onRejected: vi.fn(), onDrop },
    });

    session.send(pong);
    session.send(pong);
    expect(ws.send).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledTimes(1);
    // Refused, so frames it already queued are not handled either.
    expect(session.rejected).toBe(true);
  });

  it("sends while the unread backlog is within the bound", () => {
    const ws = socket(2_048);
    const onDrop = vi.fn();
    const session = new Session({
      socket: ws as any,
      remoteAddress: "10.0.0.1",
      preAuth: { maxBufferedBytes: 2_048, maxInboundBytes: 4_096, onRejected: vi.fn(), onDrop },
    });

    session.send(pong);
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("never applies the bound to an authenticated session", () => {
    const ws = socket(50 * 1024 * 1024);
    const onDrop = vi.fn();
    const session = new Session({
      socket: ws as any,
      remoteAddress: "10.0.0.1",
      preAuth: { maxBufferedBytes: 2_048, maxInboundBytes: 4_096, onRejected: vi.fn(), onDrop },
    });
    session.state = "authenticated";

    session.send(pong);
    session.sendBinary("stream", 1, new Uint8Array([1]));
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(onDrop).not.toHaveBeenCalled();
    expect(session.rejected).toBe(false);
  });
});

describe("Session backlog checks at the edges", () => {
  function socket(bufferedAmount: number, readyState = 1) {
    return { readyState, bufferedAmount, send: vi.fn(), close: vi.fn() };
  }
  function session(ws: ReturnType<typeof socket>) {
    const preAuth = {
      maxBufferedBytes: 2_048, maxInboundBytes: 4_096, maxLookupBytes: 65_536, onRejected: vi.fn(), onDrop: vi.fn(),
    };
    return { preAuth, session: new Session({ socket: ws as any, remoteAddress: "10.0.0.1", preAuth }) };
  }

  it("checks the backlog on inbound traffic, where the library replies below the session", () => {
    const { session: s, preAuth } = session(socket(2_049));
    expect(s.dropIfUnresponsive()).toBe(true);
    expect(s.dropIfUnresponsive()).toBe(true);
    expect(preAuth.onDrop).toHaveBeenCalledTimes(1);
    expect(s.rejected).toBe(true);
  });

  it("does not drop on inbound traffic within the bound, or once authenticated", () => {
    const within = session(socket(2_048));
    expect(within.session.dropIfUnresponsive()).toBe(false);

    const paired = session(socket(50 * 1024 * 1024));
    paired.session.state = "authenticated";
    expect(paired.session.dropIfUnresponsive()).toBe(false);
    expect(paired.preAuth.onDrop).not.toHaveBeenCalled();
  });

  it("does not judge the backlog of a socket that is already closing", () => {
    // A revoked device is demoted while its socket closes; what is still
    // queued for it was earned while it was authenticated.
    const closing = session(socket(50 * 1024 * 1024, 2));
    expect(closing.session.dropIfUnresponsive()).toBe(false);
    expect(closing.preAuth.onDrop).not.toHaveBeenCalled();
  });

  it("sends the closing reason to an authenticated session however much is queued for it", () => {
    const ws = socket(50 * 1024 * 1024);
    const { session: s, preAuth } = session(ws);
    s.state = "authenticated";

    s.close("revoked by host");
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      type: "error",
      payload: { code: "closing", message: "revoked by host" },
    });
    expect(ws.close).toHaveBeenCalledWith(1000, "revoked by host");
    expect(preAuth.onDrop).not.toHaveBeenCalled();
    expect(s.rejected).toBe(false);
    expect(s.state).toBe("unauthenticated");
  });

  it("drops a peer once it has sent more than the inbound budget, whether or not it reads", () => {
    const { session: s, preAuth } = session(socket(0));
    expect(s.noteInbound(4_096)).toBe(false);
    expect(preAuth.onDrop).not.toHaveBeenCalled();

    expect(s.noteInbound(1)).toBe(true);
    expect(s.noteInbound(1_000)).toBe(true);
    expect(preAuth.onDrop).toHaveBeenCalledTimes(1);
    expect(preAuth.onDrop).toHaveBeenCalledWith("inbound_budget");
    expect(s.rejected).toBe(true);
  });

  it("holds an authenticated session to no inbound budget, and does not judge a closing socket", () => {
    const paired = session(socket(0));
    paired.session.state = "authenticated";
    expect(paired.session.noteInbound(50 * 1024 * 1024)).toBe(false);
    expect(paired.preAuth.onDrop).not.toHaveBeenCalled();

    const closing = session(socket(0, 2));
    expect(closing.session.noteInbound(50 * 1024 * 1024)).toBe(false);
    expect(closing.preAuth.onDrop).not.toHaveBeenCalled();
  });

  it("does not judge a peer by the inbound budget while its token is being looked up", () => {
    // The lookup is asynchronous. A device with a valid token that sends on
    // without waiting is still unauthenticated when those bytes arrive.
    const { session: s, preAuth } = session(socket(0));
    s.authenticating = true;
    expect(s.noteInbound(50_000)).toBe(false);
    expect(preAuth.onDrop).not.toHaveBeenCalled();

    // The lookup ends without authenticating it: what it sent now counts.
    s.authenticating = false;
    expect(s.noteInbound(0)).toBe(true);
    expect(preAuth.onDrop).toHaveBeenCalledWith("inbound_budget");
  });

  it("holds it to a larger allowance during the lookup, not to none", () => {
    // Frames behind the hello wait for the lookup, so what arrives meanwhile
    // is held. A lookup that never ended would otherwise hold without limit.
    const { session: s, preAuth } = session(socket(0));
    s.authenticating = true;
    expect(s.noteInbound(65_536)).toBe(false);
    expect(s.noteInbound(1)).toBe(true);
    expect(preAuth.onDrop).toHaveBeenCalledWith("inbound_budget");
  });

  it("remembers that a session was authenticated after it is demoted to close", () => {
    const ws = socket(0);
    const { session: s } = session(ws);
    expect(s.wasAuthenticated).toBe(false);
    s.state = "authenticated";
    s.close("revoked by host");
    expect(s.state).toBe("unauthenticated");
    expect(s.wasAuthenticated).toBe(true);
  });

  it("can be dropped from outside, once, and handles nothing afterwards", () => {
    const { session: s, preAuth } = session(socket(0));
    s.dropFor("transport_budget");
    s.dropFor("transport_budget");
    expect(preAuth.onDrop).toHaveBeenCalledTimes(1);
    expect(preAuth.onDrop).toHaveBeenCalledWith("transport_budget");
    expect(s.rejected).toBe(true);
  });

  it("does not count what an authenticated session sends", () => {
    const { session: s, preAuth } = session(socket(0));
    s.state = "authenticated";
    s.noteInbound(50 * 1024 * 1024);
    s.state = "unauthenticated";
    expect(s.noteInbound(1)).toBe(false);
    expect(preAuth.onDrop).not.toHaveBeenCalled();
  });

  it("says which bound a drop was for", () => {
    const { session: s, preAuth } = session(socket(2_049));
    expect(s.dropIfUnresponsive()).toBe(true);
    expect(preAuth.onDrop).toHaveBeenCalledWith("unread_replies");
  });

  it("drops at once, with no grace, when a rejection finds the peer already over the bound", () => {
    const ws = socket(2_049);
    const { session: s, preAuth } = session(ws);

    s.reject(PRE_AUTH_ERRORS.helloRejected, 1008);
    expect(ws.send).not.toHaveBeenCalled();
    expect(preAuth.onDrop).toHaveBeenCalledTimes(1);
  });
});

describe("isWellFormedHello", () => {
  const valid = { clientId: "ios-device-1", clientName: "Psyche for iPhone", protocolVersion: 3, token: null };

  it("accepts the hello fixtures the clients actually send", () => {
    expect(isWellFormedHello(CLIENT_FIXTURES.hello.payload)).toBe(true);
    expect(isWellFormedHello(CLIENT_FIXTURES.hello_noToken.payload)).toBe(true);
    expect(isWellFormedHello(valid)).toBe(true);
    // An omitted token is the same as a null one.
    expect(isWellFormedHello({ clientId: "c", clientName: "c", protocolVersion: 2 })).toBe(true);
    // An unsupported version is well formed; version negotiation refuses it.
    expect(isWellFormedHello({ ...valid, protocolVersion: 99 })).toBe(true);
  });

  it.each([
    ["a missing clientId", { ...valid, clientId: undefined }],
    ["an empty clientId", { ...valid, clientId: "" }],
    ["a numeric clientId", { ...valid, clientId: 7 }],
    ["an oversized clientId", { ...valid, clientId: "c".repeat(257) }],
    ["an object clientName", { ...valid, clientName: { toString: "x" } }],
    ["an oversized clientName", { ...valid, clientName: "n".repeat(257) }],
    ["a string protocolVersion", { ...valid, protocolVersion: "3" }],
    ["a missing protocolVersion", { ...valid, protocolVersion: undefined }],
    ["an object token", { ...valid, token: { $ne: null } }],
    ["a numeric token", { ...valid, token: 0 }],
    ["an oversized token", { ...valid, token: "t".repeat(513) }],
  ])("rejects %s", (_label, payload) => {
    expect(isWellFormedHello(payload)).toBe(false);
  });
});

describe("pre-auth transport budget", () => {
  // Not everything a peer sends reaches the WebSocket parser: TLS has
  // messages of its own, which the TLS layer answers by itself. The bytes on
  // the wire are the only count that sees them, and nothing raises an event
  // for them, so the gate looks at intervals.
  it("drops a connection whose transport has carried more than the budget, upgraded or not", () => {
    const { gate: g, scheduler, drops } = gate();
    const silent = transport();
    const upgraded = transport();
    const upgradedPeer = peer();
    g.admit("10.0.0.1", silent);
    g.attach(g.admit("10.0.0.2", upgraded)!, upgradedPeer);

    silent.state.bytesRead = 8_192;
    upgraded.state.bytesRead = 8_192;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect([silent.state.destroyed, upgraded.state.destroyed]).toEqual([0, 0]);

    silent.state.bytesRead = 8_193;
    upgraded.state.bytesRead = 8_193;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect([silent.state.destroyed, upgraded.state.destroyed]).toEqual([1, 1]);
    // A connection with a session is dropped through it, so the session
    // stops handling frames at once; one without is reported by the gate.
    expect(drops).toEqual(["transport_budget"]);
    expect(upgradedPeer.state.drops).toEqual(["transport_budget"]);
    expect(scheduler.pending).toBe(0);
  });

  it("stops looking for good once a connection has authenticated, even after it is demoted to close", () => {
    const { gate: g, scheduler, drops } = gate();
    const t = transport();
    const p = peer(true);
    g.attach(g.admit("10.0.0.1", t)!, p);

    // The host closes it: demoted, closing, megabytes already received.
    p.state.authenticated = false;
    p.state.open = false;
    t.state.bytesRead = 50 * 1024 * 1024;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS * 4 + LIMITS.closeGraceMs);
    expect(t.state.destroyed).toBe(0);
    expect(p.state.drops).toEqual([]);
    expect(drops).toEqual([]);
  });

  it("gives a never-authenticated connection that begins to close the short grace, and keeps looking meanwhile", () => {
    // A peer can start a close whenever it likes. Left to the WebSocket
    // library, a closing connection is held for that library's own, much
    // longer, timeout, and nothing above the transport hears from it again.
    const graced = transport();
    const flooding = transport();
    const gracedPeer = peer();
    const floodingPeer = peer();
    const { gate: g, scheduler } = gate();
    g.attach(g.admit("10.0.0.1", graced)!, gracedPeer);
    g.attach(g.admit("10.0.0.2", flooding)!, floodingPeer);
    gracedPeer.state.open = false;
    floodingPeer.state.open = false;

    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect([graced.state.destroyed, flooding.state.destroyed]).toEqual([0, 0]);

    flooding.state.bytesRead = 8_193;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect(flooding.state.destroyed).toBe(1);
    expect(floodingPeer.state.drops).toEqual(["transport_budget"]);
    expect(graced.state.destroyed).toBe(0);

    scheduler.advance(LIMITS.closeGraceMs);
    expect(graced.state.destroyed).toBe(1);
    expect(gracedPeer.state.drops).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it("keeps looking at a rejected connection until its grace ends", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const p = peer();
    const connection = g.admit("10.0.0.1", t)!;
    g.attach(connection, p);
    g.rejected(connection);

    t.state.bytesRead = 8_193;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect(t.state.destroyed).toBe(1);
    expect(p.state.drops).toEqual(["transport_budget"]);
    expect(scheduler.pending).toBe(0);
  });

  it("holds a connection to the lookup allowance, not the budget, while its token is looked up", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const p = peer();
    g.attach(g.admit("10.0.0.1", t)!, p);

    p.state.authenticating = true;
    t.state.bytesRead = 65_536;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS * 4);
    expect(t.state.destroyed).toBe(0);

    // The lookup ends without authenticating it: the budget applies again.
    p.state.authenticating = false;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect(t.state.destroyed).toBe(1);
    expect(p.state.drops).toEqual(["transport_budget"]);
  });

  it("drops a connection that passes the lookup allowance during the lookup", () => {
    const { gate: g, scheduler } = gate();
    const t = transport();
    const p = peer();
    g.attach(g.admit("10.0.0.1", t)!, p);

    p.state.authenticating = true;
    t.state.bytesRead = 65_537;
    scheduler.advance(PRE_AUTH_TRANSPORT_POLL_MS);
    expect(t.state.destroyed).toBe(1);
    expect(p.state.drops).toEqual(["transport_budget"]);
  });

  it("stops looking once the connection is released", () => {
    const { gate: g, scheduler } = gate();
    g.release(g.admit("10.0.0.1", transport())!);
    expect(scheduler.pending).toBe(0);
  });
});
