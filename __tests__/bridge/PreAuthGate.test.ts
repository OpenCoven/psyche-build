import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRE_AUTH_LIMITS,
  PRE_AUTH_DEADLINE_MS,
  PRE_AUTH_ERRORS,
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
  closeGraceMs: 500,
};

function transport() {
  const state = { destroyed: 0 };
  return { state, destroy: () => { state.destroyed += 1; } };
}

function peer(initiallyAuthenticated = false) {
  const state = {
    authenticated: initiallyAuthenticated,
    rejections: [] as Array<{ error: unknown; closeCode: number }>,
  };
  return {
    state,
    isAuthenticated: () => state.authenticated,
    reject: (error: unknown, closeCode: number) => { state.rejections.push({ error, closeCode }); },
  };
}

function gate(limits: Partial<PreAuthLimits> = {}) {
  const scheduler = new ManualScheduler();
  return { scheduler, gate: new PreAuthGate({ ...LIMITS, ...limits }, scheduler) };
}

describe("pre-auth limits", () => {
  it("ships conservative defaults", () => {
    expect(DEFAULT_PRE_AUTH_LIMITS).toEqual({
      maxConnections: PRE_AUTH_MAX_CONNECTIONS,
      maxConnectionsPerAddress: PRE_AUTH_MAX_CONNECTIONS_PER_ADDRESS,
      upgradeDeadlineMs: PRE_AUTH_UPGRADE_DEADLINE_MS,
      authDeadlineMs: PRE_AUTH_DEADLINE_MS,
      maxFrameBytes: PRE_AUTH_MAX_FRAME_BYTES,
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
