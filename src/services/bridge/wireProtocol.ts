/**
 * wireProtocol.ts — TypeScript mirror of PsycheCore wire protocol.
 *
 * Legacy v2 fields and message names remain byte-identical to the Swift
 * encoders in native/ios/PsycheCore/Sources/PsycheCore/Protocol/BridgeMessages.swift.
 * Protocol v3 adds top-level `control` and `workspaceChanged` envelopes around
 * the canonical daemon control/workspace messages without removing the legacy
 * bridge messages.
 *
 * Encoding rules (matching Swift's BridgeCoder):
 *   - dateEncodingStrategy = .iso8601  → Date fields are ISO-8601 strings on the wire.
 *   - outputFormatting = [.sortedKeys] → Object keys emitted in sorted (lexicographic) order.
 *   - Swift Data                       → base64-encoded string by default via JSONEncoder.
 *
 * `seq` values are Swift UInt64. JS number is safe up to 2^53, which is
 * sufficient at any realistic pane-output rate, so the TS mirror uses `number`.
 */

import type {
  ClientRequest as DaemonClientRequest,
  PaneLaunchRequest,
  ServerResponse as DaemonServerResponse,
  StreamId,
} from '../../daemon/protocol.js';
import type { ActionOption, ActionResult, PaneAction } from '../../actions/types.js';
import type { BrowserSnapshot } from '../../utils/fileBrowser.js';
import type {
  ReadonlyWorkspaceSnapshot,
} from '../../workspace/snapshot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LEGACY_PROTOCOL_VERSION = 2;
export const PROTOCOL_VERSION = 3;
export const SUPPORTED_PROTOCOL_VERSIONS = [LEGACY_PROTOCOL_VERSION, PROTOCOL_VERSION] as const;
export type SupportedProtocolVersion = typeof SUPPORTED_PROTOCOL_VERSIONS[number];
export const BONJOUR_SERVICE_TYPE = "_psyche._tcp";

export function isSupportedProtocolVersion(value: unknown): value is SupportedProtocolVersion {
  return typeof value === "number"
    && Number.isInteger(value)
    && (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(value);
}

// ---------------------------------------------------------------------------
// Shared legacy v2 types
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
// Legacy v2 client message payloads
// ---------------------------------------------------------------------------

export interface HelloPayload {
  clientId: string;
  clientName: string;
  protocolVersion: SupportedProtocolVersion;
  token: string | null;
  invite?: string;
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
// Legacy v2 message unions
// ---------------------------------------------------------------------------

export type LegacyClientMessage =
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

export interface WelcomePayload {
  serverId: string;
  serverName: string;
  protocolVersion: SupportedProtocolVersion;
  projectName: string | null;
  supportedVersions?: readonly SupportedProtocolVersion[];
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

export type LegacyServerMessage =
  | { type: "welcome"; payload: WelcomePayload }
  | { type: "paneList"; payload: PaneSnapshot[] }
  | { type: "paneListChanged"; payload: PaneSnapshot[] }
  | { type: "projectList"; payload: Project[] }
  | { type: "paneOutput"; payload: PaneOutputPayload }
  | { type: "ritualList"; payload: RitualListPayload }
  | { type: "attention"; payload: AttentionEvent }
  | { type: "pairChallenge"; payload: PairChallengePayload }
  | { type: "pairAccepted"; payload: { token: string } }
  | { type: "authAccepted"; payload: { token: string } }
  | { type: "pairRejected"; payload: { reason: string } }
  | { type: "pong"; payload: { token: string } }
  | { type: "error"; payload: BridgeError };

// ---------------------------------------------------------------------------
// Protocol v3 mobile control envelopes
// ---------------------------------------------------------------------------

export type MobilePaneCreateKind = 'agent' | 'terminal' | 'coven-session';
export type MobileTerminalReplayMode = 'append' | 'replace';

type CanonicalMobileControlRequest = Extract<
  DaemonClientRequest,
  {
    type:
      | 'workspace.snapshot'
      | 'panes.detach'
      | 'panes.input'
      | 'panes.resize'
      | 'panes.kill'
      | 'panes.meta';
  }
>;

type CanonicalMobileControlResponse = Extract<
  DaemonServerResponse,
  { type: 'ack' | 'panes.spawn.result' | 'panes.stream.exit' | 'error' }
>;

export type MobilePaneSpawnRequest = {
  type: 'panes.spawn';
  requestId: string;
  idempotencyKey: string;
  kind: MobilePaneCreateKind;
  projectId: string;
} & PaneLaunchRequest;

export type MobileRitualLaunchRequest = {
  type: 'rituals.launch';
  requestId: string;
  projectId: string;
  ritualId: string;
  params?: Record<string, string>;
};

export type MobilePaneAttachRequest = {
  type: 'panes.attach';
  requestId: string;
  id: string;
  cols?: number;
  rows?: number;
  sinceSeq?: number;
};

export type MobileFilesListRequest = {
  type: 'files.list';
  requestId: string;
  paneId: string;
};

export type MobileFilesReadRequest = {
  type: 'files.read';
  requestId: string;
  paneId: string;
  path: string;
};

export type MobileFilesDiffRequest = {
  type: 'files.diff';
  requestId: string;
  paneId: string;
  path: string;
};

export type MobileActionInteractionResponse =
  | { type: 'confirm' }
  | { type: 'choice'; optionId: string }
  | { type: 'input'; value: string }
  | { type: 'cancel' };

export type MobileActionsStartRequest = {
  type: 'actions.start';
  requestId: string;
  paneId: string;
  action: PaneAction;
};

export type MobileActionsRespondRequest = {
  type: 'actions.respond';
  requestId: string;
  sessionId: string;
  response: MobileActionInteractionResponse;
};

export interface MobileActionReviewData {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  files: string[];
  aiFailed?: boolean;
}

export type MobileActionOption = Pick<ActionOption, 'id' | 'label' | 'description' | 'danger' | 'default'>;

export interface SerializedMobileActionResult {
  type: ActionResult['type'];
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  options?: MobileActionOption[];
  placeholder?: string;
  defaultValue?: string;
  inputMaxVisibleLines?: number;
  progress?: number;
  targetPaneId?: string;
  reviewData?: MobileActionReviewData;
  data?: Record<string, string>;
  relatedFiles?: string[];
  dismissable?: boolean;
}

export type MobileWorkspaceSnapshotResult = {
  type: 'mobile.workspace.snapshot.result';
  requestId: string;
  sequence: number;
  workspace: ReadonlyWorkspaceSnapshot;
};

export type MobilePaneAttachResult = {
  type: 'mobile.panes.attach.result';
  requestId: string;
  streamId: StreamId;
  id: string;
  latestSeq: number;
  hasReplay: boolean;
  replayMode: MobileTerminalReplayMode;
};

export type MobileFilesListResult = {
  type: 'files.list.result';
  requestId: string;
  paneId: string;
  snapshot: BrowserSnapshot;
};

export type MobileFilesReadResult = {
  type: 'files.read.result';
  requestId: string;
  paneId: string;
  path: string;
  content: string;
  truncated: boolean;
};

export type MobileFilesDiffResult = {
  type: 'files.diff.result';
  requestId: string;
  paneId: string;
  path: string;
  diff: string;
};

export type MobileActionsResult = {
  type: 'actions.result';
  requestId: string;
  sessionId?: string;
  result: SerializedMobileActionResult;
};

export interface WorkspaceChangedPayload {
  revision: number;
  sequence: number;
  workspace: ReadonlyWorkspaceSnapshot;
}

export type MobileControlRequest =
  | CanonicalMobileControlRequest
  | MobilePaneSpawnRequest
  | MobilePaneAttachRequest
  | MobileFilesListRequest
  | MobileFilesReadRequest
  | MobileFilesDiffRequest
  | MobileActionsStartRequest
  | MobileActionsRespondRequest
  | MobileRitualLaunchRequest;

export type MobileControlResponse =
  | CanonicalMobileControlResponse
  | MobileWorkspaceSnapshotResult
  | MobilePaneAttachResult
  | MobileFilesListResult
  | MobileFilesReadResult
  | MobileFilesDiffResult
  | MobileActionsResult;

export type ClientMessage = LegacyClientMessage | { type: 'control'; payload: MobileControlRequest };

export type ServerMessage =
  | LegacyServerMessage
  | { type: 'control'; payload: MobileControlResponse }
  | { type: 'workspaceChanged'; payload: WorkspaceChangedPayload };

// ---------------------------------------------------------------------------
// Runtime type lists
// ---------------------------------------------------------------------------

export const MOBILE_CONTROL_REQUEST_TYPES = [
  'workspace.snapshot',
  'panes.detach',
  'panes.input',
  'panes.resize',
  'panes.kill',
  'panes.meta',
  'panes.spawn',
  'panes.attach',
  'files.list',
  'files.read',
  'files.diff',
  'actions.start',
  'actions.respond',
  'rituals.launch',
] as const;

export const MOBILE_CONTROL_RESPONSE_TYPES = [
  'ack',
  'panes.spawn.result',
  'panes.stream.exit',
  'error',
  'mobile.workspace.snapshot.result',
  'mobile.panes.attach.result',
  'files.list.result',
  'files.read.result',
  'files.diff.result',
  'actions.result',
] as const;

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
  'control',
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
  "authAccepted",
  "pairRejected",
  "pong",
  "error",
  'control',
  'workspaceChanged',
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
const _mobileControlRequestTypesMatchUnion: MutuallyExhaustive<
  MobileControlRequest['type'],
  typeof MOBILE_CONTROL_REQUEST_TYPES[number]
> = true;
const _mobileControlResponseTypesMatchUnion: MutuallyExhaustive<
  MobileControlResponse['type'],
  typeof MOBILE_CONTROL_RESPONSE_TYPES[number]
> = true;
void _clientTypesMatchUnion;
void _serverTypesMatchUnion;
void _mobileControlRequestTypesMatchUnion;
void _mobileControlResponseTypesMatchUnion;

// ---------------------------------------------------------------------------
// stableStringify — mirrors Swift's .sortedKeys output formatting.
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

  return obj as ClientMessage;
}

/**
 * Binary frames are
 * `[1-byte streamId-length][streamId utf8][8-byte big-endian sequence][payload]`.
 */
export function encodeMobileBinaryFrame(
  streamId: StreamId,
  sequence: number,
  payload: Uint8Array,
): Buffer {
  const idBytes = Buffer.from(streamId, 'utf8');
  if (idBytes.length === 0) {
    throw new Error('streamId must not be empty');
  }
  if (idBytes.length > 255) {
    throw new Error('streamId too long');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('sequence must be a non-negative safe integer');
  }

  const out = Buffer.allocUnsafe(1 + idBytes.length + 8 + payload.length);
  out.writeUInt8(idBytes.length, 0);
  idBytes.copy(out, 1);
  out.writeBigUInt64BE(BigInt(sequence), 1 + idBytes.length);
  Buffer.from(payload).copy(out, 1 + idBytes.length + 8);
  return out;
}
