/**
 * wireProtocol.ts — TypeScript mirror of PsycheCore v2 wire protocol.
 *
 * Field names and JSON shape are byte-identical to the Swift encoders in:
 *   native/shared/PsycheCore/Sources/PsycheCore/Messages.swift
 *
 * Encoding rules (matching Swift's BridgeCoder):
 *   - dateEncodingStrategy = .iso8601  → Date fields are ISO-8601 strings on the wire.
 *   - outputFormatting = [.sortedKeys] → Object keys emitted in sorted (lexicographic) order.
 *   - Swift Data                       → base64-encoded string by default via JSONEncoder.
 *
 * `seq` (PaneOutput) is Swift UInt64. JS number is safe up to 2^53, which is
 * sufficient at any realistic pane-output rate, so we use `number` rather than
 * `bigint` here.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 2;
export const BONJOUR_SERVICE_TYPE = "_psyche._tcp";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type PaneStatus = "working" | "idle" | "waiting" | "unknown";

export interface Project {
  id: string;
  displayName: string;
  attentionCount: number;
}

export interface PaneSnapshot {
  id: string;
  displayName: string;
  kind: string;
  projectId: string | null;
  projectName: string | null;
  worktreePath: string | null;
  agent: string | null;
  status: PaneStatus;
}

export interface AttentionEvent {
  paneId: string;
  reason: PaneStatus;
  summary: string | null;
  /** ISO-8601 string (Swift Date encoded with .iso8601 strategy) */
  timestamp: string;
}

export interface Ritual {
  id: string;
  displayName: string;
  description: string | null;
  scope: "builtIn" | "project";
  projectId: string | null;
}

// ---------------------------------------------------------------------------
// Client message payloads
// ---------------------------------------------------------------------------

export interface HelloPayload {
  clientId: string;
  clientName: string;
  protocolVersion: number;
  token: string | null;
}

export interface SendInputPayload {
  paneId: string;
  /** base64-encoded string (Swift Data encoded by JSONEncoder) */
  data: string;
}

export interface SubscribePanePayload {
  paneId: string;
  /** Swift UInt64? → number | null */
  sinceSeq: number | null;
}

export interface ListRitualsPayload {
  projectId: string | null;
}

export interface LaunchRitualPayload {
  projectId: string;
  ritualId: string;
  params: Record<string, string>;
}

export interface PairRequestPayload {
  code: string;
  clientId: string;
  clientName: string;
}

// ---------------------------------------------------------------------------
// Client message union
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: "hello"; payload: HelloPayload }
  | { type: "listPanes"; payload: Record<string, never> }
  | { type: "sendInput"; payload: SendInputPayload }
  | { type: "focusPane"; payload: { paneId: string } }
  | { type: "ping"; payload: { token: string } }
  | { type: "listProjects"; payload: Record<string, never> }
  | { type: "subscribePane"; payload: SubscribePanePayload }
  | { type: "unsubscribePane"; payload: { paneId: string } }
  | { type: "listRituals"; payload: ListRitualsPayload }
  | { type: "launchRitual"; payload: LaunchRitualPayload }
  | { type: "pair"; payload: PairRequestPayload };

// ---------------------------------------------------------------------------
// Server message payloads
// ---------------------------------------------------------------------------

export interface WelcomePayload {
  serverId: string;
  serverName: string;
  protocolVersion: number;
  projectName: string | null;
  // NOTE: no `serverFingerprint` field — not in the Swift struct.
}

export interface PaneOutputPayload {
  paneId: string;
  /** base64-encoded string (Swift Data encoded by JSONEncoder) */
  data: string;
  /** Swift UInt64 — JS number safe up to 2^53 */
  seq: number;
}

export interface RitualListPayload {
  projectId: string | null;
  rituals: Ritual[];
}

export interface PairChallengePayload {
  /** ISO-8601 string (Swift Date encoded with .iso8601 strategy) */
  expiresAt: string;
  codeLength: number;
}

export interface BridgeError {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Server message union
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "welcome"; payload: WelcomePayload }
  | { type: "paneList"; payload: PaneSnapshot[] }
  | { type: "paneListChanged"; payload: PaneSnapshot[] }
  | { type: "projectList"; payload: Project[] }
  | { type: "paneOutput"; payload: PaneOutputPayload }
  | { type: "ritualList"; payload: RitualListPayload }
  | { type: "attention"; payload: AttentionEvent }
  | { type: "pairChallenge"; payload: PairChallengePayload }
  | { type: "pairAccepted"; payload: { token: string } }
  | { type: "pairRejected"; payload: { reason: string } }
  | { type: "pong"; payload: { token: string } }
  | { type: "error"; payload: BridgeError };

// ---------------------------------------------------------------------------
// Runtime type lists
//
// The unions above are erased at runtime, so the contract test cannot iterate
// them directly. These arrays make the set enumerable, and the assertions below
// make them impossible to forget: adding a union member without adding it here
// (or vice versa) is a compile error, not a silently under-covered test.
// ---------------------------------------------------------------------------

export const CLIENT_MESSAGE_TYPES = [
  "hello",
  "listPanes",
  "sendInput",
  "focusPane",
  "ping",
  "listProjects",
  "subscribePane",
  "unsubscribePane",
  "listRituals",
  "launchRitual",
  "pair",
] as const;

export const SERVER_MESSAGE_TYPES = [
  "welcome",
  "paneList",
  "paneListChanged",
  "projectList",
  "paneOutput",
  "ritualList",
  "attention",
  "pairChallenge",
  "pairAccepted",
  "pairRejected",
  "pong",
  "error",
] as const;

/** Compile error if the array and the union ever disagree, in either direction. */
type MutuallyExhaustive<A extends string, B extends string> =
  [Exclude<A, B> | Exclude<B, A>] extends [never] ? true : never;

const _clientTypesMatchUnion: MutuallyExhaustive<
  ClientMessage["type"],
  typeof CLIENT_MESSAGE_TYPES[number]
> = true;
const _serverTypesMatchUnion: MutuallyExhaustive<
  ServerMessage["type"],
  typeof SERVER_MESSAGE_TYPES[number]
> = true;
void _clientTypesMatchUnion;
void _serverTypesMatchUnion;

// ---------------------------------------------------------------------------
// stableStringify — mirrors Swift's .sortedKeys output formatting.
//
// JSON.stringify with a replacer that sorts object keys lexicographically.
// Arrays are left in their original order (JSON.stringify handles them as-is).
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a ServerMessage to a JSON string with stable (sorted) key order,
 * matching Swift's BridgeCoder encoder with `.sortedKeys` output formatting.
 */
export function encodeServerMessage(msg: ServerMessage): string {
  return stableStringify(msg);
}

/**
 * Parse a raw JSON string into a ClientMessage.
 * Throws a descriptive error if the input is not valid JSON, missing `type`,
 * or missing `payload`.
 */
export function decodeClientMessage(raw: string): ClientMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`wireProtocol: invalid JSON: ${String(e)}`);
  }

  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("wireProtocol: message must be a JSON object");
  }

  const record = obj as Record<string, unknown>;

  if (typeof record["type"] !== "string") {
    throw new Error(
      `wireProtocol: missing or non-string 'type' field (got ${JSON.stringify(record["type"])})`
    );
  }

  if (
    record["payload"] === null ||
    typeof record["payload"] !== "object" ||
    Array.isArray(record["payload"])
  ) {
    throw new Error(
      `wireProtocol: missing or non-object 'payload' field for type '${record["type"]}'`
    );
  }

  // We trust the caller to send the right payload shape for each type.
  // Structural validation beyond type+payload can be layered on top.
  return obj as ClientMessage;
}
