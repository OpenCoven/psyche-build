/**
 * comux daemon WS protocol (v0).
 *
 * Clients send JSON control frames; binary frames carry PTY IO.
 * A single WS connection can multiplex multiple attached panes via
 * the `streamId` field returned by `panes.attach`.
 */

export const PROTOCOL_VERSION = 0;

export type PaneId = string;
export type StreamId = string;

export interface PaneSummary {
  id: PaneId;
  cwd: string;
  branch?: string;
  agent?: string;
  title?: string;
  lastActivity?: string;
}

export interface ProjectSummary {
  id: string;
  root: string;
  cwd: string;
  title: string;
  autonomyProfile?: string;
}

export type CovenSessionSummary = {
  id: string;
  projectRoot: string;
  cwd?: string;
  harness: string;
  title: string;
  status: 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'killed' | 'orphaned' | 'created' | 'archived';
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type CovenSessionEvent = {
  seq?: number;
  id: string;
  sessionId: string;
  kind: 'output' | 'input' | 'kill' | 'exit' | string;
  payloadJson: string;
  createdAt: string;
};

export type CovenSessionLaunchRequest = {
  harness: string;
  prompt: string;
  cwd?: string;
  title?: string;
};

export type CovenCapabilityRequest = Omit<
  AgenticCapabilityRequest,
  'capability' | 'input' | 'context'
> & {
  capability: AgenticCapabilityRequest['capability'];
  prompt: string;
  title?: string;
  state?: Readonly<Record<string, unknown>>;
  attempt?: number;
  idempotencyKey?: string;
};

export type CovenDesktopUseQuickAction = 'screenshot' | 'inspect' | 'permissions' | 'approve' | 'deny' | 'test';

export type CovenDesktopUseState = {
  sessionId?: string;
  connected: boolean;
  actions?: Array<{ id: string; label: string; status?: string; createdAt?: string; traceId?: string }>;
  currentAction?: { id: string; label: string; status?: string; createdAt?: string; traceId?: string };
  permissions?: Record<string, string>;
  accessibilitySummary?: string;
  screenSummary?: string;
  screenshotPath?: string;
  pendingApproval?: boolean;
  error?: string;
  updatedAt: string;
};

export interface PaneStatusResult {
  id: PaneId;
  exists?: boolean;
  status: string;
  pane?: PaneSummary;
  metadata?: {
    comuxId?: string;
    title?: string;
    agent?: string;
    branch?: string;
    cwd?: string;
    needsAttention?: boolean;
    lastActivity?: string;
  };
}

export type ClientRequest =
  | { type: 'hello'; token: string; clientName?: string }
  | { type: 'projects.list'; requestId: string }
  | { type: 'projects.open'; requestId: string; cwd?: string; title?: string; autonomyProfile?: string }
  | { type: 'panes.list'; requestId: string }
  | { type: 'coven.sessions.list'; requestId: string }
  | { type: 'coven.sessions.launch'; requestId: string; launch: CovenSessionLaunchRequest }
  | { type: 'coven.sessions.open'; requestId: string; id: string }
  | { type: 'coven.capabilities.execute'; requestId: string; sessionId: string; capability: CovenCapabilityRequest }
  | { type: 'coven.desktop.state'; requestId: string; sessionId: string }
  | { type: 'coven.desktop.action'; requestId: string; sessionId: string; action: CovenDesktopUseQuickAction }
  | { type: 'panes.spawn'; requestId: string; cwd: string; branch?: string; agent?: string; title?: string; prompt?: string }
  | { type: 'panes.capture'; requestId: string; id: PaneId; lines?: number }
  | { type: 'panes.status'; requestId: string; id: PaneId }
  | { type: 'panes.attach'; requestId: string; id: PaneId; cols?: number; rows?: number }
  | { type: 'panes.detach'; requestId: string; streamId: StreamId }
  | { type: 'panes.focus'; requestId: string; id?: PaneId; streamId?: StreamId }
  | { type: 'panes.input'; requestId: string; streamId: StreamId; data: string }
  | { type: 'panes.resize'; requestId: string; streamId: StreamId; cols: number; rows: number }
  | { type: 'panes.kill'; requestId: string; id: PaneId }
  | { type: 'panes.meta'; requestId: string; id: PaneId; title?: string; agent?: string };

export type ServerResponse =
  | { type: 'welcome'; protocol: number; serverVersion: string }
  | { type: 'error'; requestId?: string; code: string; message: string }
  | { type: 'ack'; requestId: string; ok: true }
  | { type: 'projects.list.result'; requestId: string; projects: ProjectSummary[] }
  | { type: 'projects.open.result'; requestId: string; project: ProjectSummary }
  | { type: 'panes.list.result'; requestId: string; panes: PaneSummary[] }
  | { type: 'coven.sessions.list.result'; requestId: string; sessions: CovenSessionSummary[] }
  | { type: 'coven.sessions.launch.result'; requestId: string; session: CovenSessionSummary }
  | { type: 'coven.sessions.open.result'; requestId: string; id: PaneId; pane: PaneSummary; session: CovenSessionSummary }
  | { type: 'coven.capabilities.execute.result'; requestId: string; sessionId: string; execution: AgenticCapabilityExecution }
  | { type: 'coven.desktop.state.result'; requestId: string; state: CovenDesktopUseState }
  | { type: 'coven.desktop.action.result'; requestId: string; sessionId: string; action: CovenDesktopUseQuickAction; accepted: boolean }
  | { type: 'panes.spawn.result'; requestId: string; id: PaneId; pane?: PaneSummary; worktreePath?: string; branch?: string }
  | { type: 'panes.capture.result'; requestId: string; id: PaneId; text: string; lines: number }
  | { type: 'panes.status.result'; requestId: string; status: PaneStatusResult }
  | { type: 'panes.attach.result'; requestId: string; streamId: StreamId; id: PaneId }
  | { type: 'panes.stream.exit'; streamId: StreamId; reason: string };

export interface BinaryFrameHeader {
  streamId: StreamId;
}

/**
 * Binary frames are `[1-byte streamId-length][streamId utf8][payload]`.
 * streamId is short (base36), so a 1-byte length prefix is plenty.
 */
export function encodeBinaryFrame(streamId: StreamId, payload: Uint8Array): Buffer {
  const idBytes = Buffer.from(streamId, 'utf8');
  if (idBytes.length > 255) {
    throw new Error('streamId too long');
  }
  const out = Buffer.allocUnsafe(1 + idBytes.length + payload.length);
  out.writeUInt8(idBytes.length, 0);
  idBytes.copy(out, 1);
  Buffer.from(payload).copy(out, 1 + idBytes.length);
  return out;
}

export function decodeBinaryFrame(buf: Buffer): { streamId: StreamId; payload: Buffer } {
  const idLen = buf.readUInt8(0);
  const streamId = buf.subarray(1, 1 + idLen).toString('utf8');
  const payload = buf.subarray(1 + idLen);
  return { streamId, payload };
}
import type {
  AgenticCapabilityExecution,
  AgenticCapabilityRequest,
} from '../orchestration/capabilityRouter.js';
