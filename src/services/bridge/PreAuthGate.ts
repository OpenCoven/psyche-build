import { PAIR_WINDOW_MS } from "./PairingFlow.js";
import type { BridgeError } from "./wireProtocol.js";

/**
 * Pre-authentication resource limits for the LAN bridge listener.
 *
 * The listener binds 0.0.0.0 and is advertised over Bonjour, so any host on
 * the network can open a connection before it has proved anything. Until a
 * connection authenticates, how many sockets it may hold, for how long, and
 * how large a frame it may send are bounded here. An authenticated session
 * is outside these limits entirely and is never closed, counted, or refused
 * by them.
 */

/** Unauthenticated connections tolerated at once, across every address. */
export const PRE_AUTH_MAX_CONNECTIONS = 32;

/**
 * Unauthenticated connections tolerated at once from one remote address.
 *
 * A paired device authenticates within one round trip, so in normal use an
 * address holds a slot for milliseconds. The only long-lived legitimate holder
 * is a device waiting to be paired; four leaves room for that plus reconnects.
 */
export const PRE_AUTH_MAX_CONNECTIONS_PER_ADDRESS = 4;

/**
 * How long an accepted TCP connection has to become a WebSocket.
 *
 * TLS and the HTTP upgrade take a client milliseconds. Without this, a peer
 * that connects and never speaks holds its slot for the full authentication
 * deadline below.
 */
export const PRE_AUTH_UPGRADE_DEADLINE_MS = 10_000;

/**
 * How long an accepted connection has to authenticate, measured from accept.
 *
 * Pairing is the one legitimate reason to sit unauthenticated: the user reads
 * a code off the host and types it on the device. So the deadline is one
 * pairing window — a connection made as the window opens can use all of it,
 * and no unauthenticated connection outlives it.
 */
export const PRE_AUTH_DEADLINE_MS = PAIR_WINDOW_MS;

/**
 * Largest frame handled for a connection that has not authenticated.
 *
 * The frames a peer may send before authenticating are `hello`, `pair`, and
 * `ping`: a few short strings each. The transport cap (1 MiB) exists for
 * pastes and control requests, which only an authenticated session can send.
 */
export const PRE_AUTH_MAX_FRAME_BYTES = 4 * 1024;

/**
 * How long a rejected peer has to complete the close handshake before its
 * socket is destroyed. A peer that ignores the close frame would otherwise
 * keep its slot for the WebSocket library's own, much longer, close timeout.
 */
export const PRE_AUTH_CLOSE_GRACE_MS = 2_000;

/** Bounds on the `hello` fields the host stores for a session. */
export const HELLO_MAX_FIELD_CHARS = 256;
export const HELLO_MAX_TOKEN_CHARS = 512;

export interface PreAuthLimits {
  maxConnections: number;
  maxConnectionsPerAddress: number;
  upgradeDeadlineMs: number;
  authDeadlineMs: number;
  maxFrameBytes: number;
  closeGraceMs: number;
}

export const DEFAULT_PRE_AUTH_LIMITS: Readonly<PreAuthLimits> = Object.freeze({
  maxConnections: PRE_AUTH_MAX_CONNECTIONS,
  maxConnectionsPerAddress: PRE_AUTH_MAX_CONNECTIONS_PER_ADDRESS,
  upgradeDeadlineMs: PRE_AUTH_UPGRADE_DEADLINE_MS,
  authDeadlineMs: PRE_AUTH_DEADLINE_MS,
  maxFrameBytes: PRE_AUTH_MAX_FRAME_BYTES,
  closeGraceMs: PRE_AUTH_CLOSE_GRACE_MS,
});

/**
 * The transport-level frame cap, which no pre-auth bound may exceed. It lives
 * here so the limits can be validated without importing the listener; the
 * listener re-exports it as `MAX_CLIENT_FRAME_BYTES`, where its rationale is.
 */
export const TRANSPORT_MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The only things a peer is told when a pre-authentication limit refuses it.
 *
 * Each is a constant: nothing the peer sent, and nothing about the host, is
 * ever interpolated. They travel in the existing `error` message, and the
 * message doubles as the WebSocket close reason, so each must stay within the
 * 123 bytes RFC 6455 allows a close reason.
 */
export const PRE_AUTH_ERRORS = Object.freeze({
  deadline: Object.freeze({ code: "auth_timeout", message: "authentication deadline exceeded" }),
  frameTooLarge: Object.freeze({
    code: "frame_too_large",
    message: "frame exceeds the pre-authentication limit",
  }),
  helloRejected: Object.freeze({ code: "invalid_hello", message: "hello rejected" }),
  malformedFrame: Object.freeze({ code: "parse_failed", message: "frame rejected" }),
} satisfies Record<string, BridgeError>);

/** WebSocket close codes used for pre-authentication rejections (RFC 6455). */
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_MESSAGE_TOO_BIG = 1009;

/** Timer source; injectable so a test decides when a deadline elapses. */
export interface PreAuthScheduler {
  setTimeout(run: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Timers that never keep the process alive: a pending deadline must not hold
 * the TUI open after the user has quit.
 */
export const systemPreAuthScheduler: PreAuthScheduler = {
  setTimeout(run, delayMs) {
    const handle = setTimeout(run, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function requirePositiveInteger(name: keyof PreAuthLimits, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid pre-auth limit ${name}: expected a positive integer`);
  }
}

/**
 * Merge overrides onto the defaults and refuse a configuration that would
 * quietly mean "no limit". Failing to construct is the safe outcome: the
 * bridge does not start rather than start unbounded.
 */
export function resolvePreAuthLimits(overrides: Partial<PreAuthLimits> = {}): PreAuthLimits {
  const limits: PreAuthLimits = { ...DEFAULT_PRE_AUTH_LIMITS, ...overrides };
  for (const name of Object.keys(DEFAULT_PRE_AUTH_LIMITS) as Array<keyof PreAuthLimits>) {
    requirePositiveInteger(name, limits[name]);
  }
  if (limits.maxConnectionsPerAddress > limits.maxConnections) {
    throw new Error("invalid pre-auth limit maxConnectionsPerAddress: exceeds maxConnections");
  }
  if (limits.upgradeDeadlineMs > limits.authDeadlineMs) {
    throw new Error("invalid pre-auth limit upgradeDeadlineMs: exceeds authDeadlineMs");
  }
  if (limits.maxFrameBytes > TRANSPORT_MAX_FRAME_BYTES) {
    throw new Error("invalid pre-auth limit maxFrameBytes: exceeds the transport frame cap");
  }
  return limits;
}

/**
 * The address a connection is counted under, or null if the socket has none
 * (it was reset before it could be inspected).
 *
 * An IPv4 peer reaching a dual-stack listener is reported as `::ffff:a.b.c.d`;
 * folding that onto the IPv4 form stops one host being counted as two.
 */
export function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function isBoundedString(value: unknown, minChars: number, maxChars: number): value is string {
  return typeof value === "string" && value.length >= minChars && value.length <= maxChars;
}

/**
 * True when a `hello` payload has the shape the wire contract gives it.
 *
 * A hello is the first thing an unauthenticated peer says, and its fields are
 * stored on the session and reflected in a close reason. Version negotiation
 * is separate: a well-formed hello may still name a version this host does
 * not speak.
 */
export function isWellFormedHello(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  const hello = payload as Record<string, unknown>;
  return isBoundedString(hello.clientId, 1, HELLO_MAX_FIELD_CHARS)
    && isBoundedString(hello.clientName, 0, HELLO_MAX_FIELD_CHARS)
    && typeof hello.protocolVersion === "number"
    && (hello.token === null
      || hello.token === undefined
      || isBoundedString(hello.token, 0, HELLO_MAX_TOKEN_CHARS));
}

/** The socket under a connection, as far as the gate needs to know it. */
export interface PreAuthTransport {
  /** Drop the connection immediately, without a close handshake. */
  destroy(): void;
}

/** The session on a connection once it has become a WebSocket. */
export interface PreAuthPeer {
  isAuthenticated(): boolean;
  /** Send one fixed error, then begin closing with `closeCode`. */
  reject(error: BridgeError, closeCode: number): void;
}

/** Which cap refused a connection. Carries nothing about the peer. */
export type PreAuthRefusal = "connection_cap" | "address_cap";

/** Told of each refusal and the running total, so the host can log it. */
export type PreAuthRefusalObserver = (reason: PreAuthRefusal, refusedTotal: number) => void;

/** One accepted connection, from TCP accept until its socket closes. */
export interface PreAuthConnection {
  readonly address: string;
}

interface TrackedConnection extends PreAuthConnection {
  transport: PreAuthTransport;
  peer: PreAuthPeer | null;
  upgradeTimer: unknown;
  authTimer: unknown;
  graceTimer: unknown;
  rejected: boolean;
}

/**
 * Admission and deadlines for connections that have not authenticated.
 *
 * Every accepted TCP connection is tracked from accept — before TLS, before
 * the WebSocket upgrade — because a connection that never speaks costs a
 * socket just the same. Counts are derived from the live set on every
 * question rather than kept in a counter, so there is no counter to drift
 * when a socket ends on a path nobody anticipated.
 */
export class PreAuthGate {
  private readonly connections = new Set<TrackedConnection>();
  private disposed = false;
  private refusedTotal = 0;

  constructor(
    private readonly limits: PreAuthLimits,
    private readonly scheduler: PreAuthScheduler = systemPreAuthScheduler,
    private readonly onRefused?: PreAuthRefusalObserver,
  ) {}

  /** Connections a cap has refused since this gate was created. */
  get refusedCount(): number {
    return this.refusedTotal;
  }

  /** Unauthenticated connections currently held, across every address. */
  get unauthenticatedCount(): number {
    let count = 0;
    for (const connection of this.connections) {
      if (!this.isAuthenticated(connection)) count += 1;
    }
    return count;
  }

  /** Unauthenticated connections currently held from one address. */
  unauthenticatedCountFor(address: string): number {
    let count = 0;
    for (const connection of this.connections) {
      if (connection.address === address && !this.isAuthenticated(connection)) count += 1;
    }
    return count;
  }

  /**
   * Admit a newly accepted connection, or return null when a cap refuses it.
   * A refused connection is not tracked and arms nothing; the caller drops it.
   */
  admit(address: string, transport: PreAuthTransport): PreAuthConnection | null {
    if (this.disposed) return null;
    // The per-address cap is reported first: it names the likelier cause, one
    // device holding its own allowance, over the network-wide one.
    if (this.unauthenticatedCountFor(address) >= this.limits.maxConnectionsPerAddress) {
      return this.refuse("address_cap");
    }
    if (this.unauthenticatedCount >= this.limits.maxConnections) {
      return this.refuse("connection_cap");
    }

    const connection: TrackedConnection = {
      address,
      transport,
      peer: null,
      upgradeTimer: null,
      authTimer: null,
      graceTimer: null,
      rejected: false,
    };
    this.connections.add(connection);
    connection.upgradeTimer = this.scheduler.setTimeout(
      () => this.onUpgradeDeadline(connection),
      this.limits.upgradeDeadlineMs,
    );
    connection.authTimer = this.scheduler.setTimeout(
      () => this.onAuthDeadline(connection),
      this.limits.authDeadlineMs,
    );
    return connection;
  }

  /** The connection completed the WebSocket upgrade and now has a session. */
  attach(handle: PreAuthConnection, peer: PreAuthPeer): void {
    const connection = this.tracked(handle);
    if (!connection) return;
    connection.peer = peer;
    this.clear(connection, "upgradeTimer");
  }

  /**
   * The peer has been sent a rejection and asked to close. Give it the grace
   * period to do so, then drop it whether or not it cooperated.
   */
  rejected(handle: PreAuthConnection): void {
    const connection = this.tracked(handle);
    if (!connection || connection.rejected) return;
    connection.rejected = true;
    this.clear(connection, "upgradeTimer");
    this.clear(connection, "authTimer");
    connection.graceTimer = this.scheduler.setTimeout(() => {
      connection.graceTimer = null;
      connection.transport.destroy();
    }, this.limits.closeGraceMs);
  }

  /** The connection's socket has closed. Safe to call more than once. */
  release(handle: PreAuthConnection): void {
    const connection = this.tracked(handle);
    if (!connection) return;
    this.clearAll(connection);
    this.connections.delete(connection);
  }

  /**
   * Stop admitting, cancel every timer, and drop every connection that has
   * not authenticated: with its timers gone, nothing else would. An
   * authenticated session is left to its owner, which can tell it why.
   */
  dispose(): void {
    this.disposed = true;
    for (const connection of this.connections) {
      this.clearAll(connection);
      if (!this.isAuthenticated(connection)) connection.transport.destroy();
    }
  }

  private refuse(reason: PreAuthRefusal): null {
    this.refusedTotal += 1;
    this.onRefused?.(reason, this.refusedTotal);
    return null;
  }

  private onUpgradeDeadline(connection: TrackedConnection): void {
    connection.upgradeTimer = null;
    if (connection.peer) return;
    this.clear(connection, "authTimer");
    connection.transport.destroy();
  }

  private onAuthDeadline(connection: TrackedConnection): void {
    connection.authTimer = null;
    if (this.isAuthenticated(connection)) return;
    if (!connection.peer) {
      connection.transport.destroy();
      return;
    }
    connection.peer.reject(PRE_AUTH_ERRORS.deadline, CLOSE_POLICY_VIOLATION);
    this.rejected(connection);
  }

  private isAuthenticated(connection: TrackedConnection): boolean {
    return connection.peer?.isAuthenticated() ?? false;
  }

  private tracked(handle: PreAuthConnection): TrackedConnection | null {
    const connection = handle as TrackedConnection;
    return this.connections.has(connection) ? connection : null;
  }

  private clear(connection: TrackedConnection, timer: "upgradeTimer" | "authTimer" | "graceTimer"): void {
    if (connection[timer] === null) return;
    this.scheduler.clearTimeout(connection[timer]);
    connection[timer] = null;
  }

  private clearAll(connection: TrackedConnection): void {
    this.clear(connection, "upgradeTimer");
    this.clear(connection, "authTimer");
    this.clear(connection, "graceTimer");
  }
}
