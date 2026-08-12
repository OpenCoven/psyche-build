import type { PaneSpawnResult, StreamId } from '../../daemon/protocol.js';
import { decodeBase64Payload } from '../../utils/base64.js';
import type { BrowserFileRecord, BrowserSnapshot } from '../../utils/fileBrowser.js';
import type { ReadonlyWorkspaceSnapshot } from '../../workspace/snapshot.js';
import {
  createMobileInspection,
  MobileInspectionError,
  type MobileInspection,
} from './mobileInspection.js';
import type {
  MobileControlRequest,
  MobileControlResponse,
  MobilePaneSpawnRequest,
  MobileTerminalReplayMode,
} from './wireProtocol.js';

export interface MobileAttachedStream {
  streamId: StreamId;
  latestSeq: number;
  hasReplay: boolean;
  replayMode: MobileTerminalReplayMode;
}

export interface MobileControlGatewayOptions {
  workspaceSnapshot: () => {
    workspace: ReadonlyWorkspaceSnapshot;
    sequence: number;
  } | Promise<{
    workspace: ReadonlyWorkspaceSnapshot;
    sequence: number;
  }>;
  /** Subscribes the connection to a pane and returns its replay metadata. */
  attachPane?: (
    context: MobileControlGatewayContext,
    paneId: string,
    sinceSeq?: number,
  ) => Promise<MobileAttachedStream>;
  detachPane?: (connectionId: string, streamId: StreamId) => Promise<void>;
  sendPaneInput?: (
    connectionId: string,
    streamId: StreamId,
    data: Buffer,
  ) => Promise<void>;
  resizePane?: (
    connectionId: string,
    streamId: StreamId,
    cols: number,
    rows: number,
  ) => Promise<void>;
  spawnPane?: (request: MobilePaneSpawnRequest) => Promise<PaneSpawnResult>;
  killPane?: (paneId: string) => Promise<void>;
  updatePaneMeta?: (
    paneId: string,
    meta: { title?: string; agent?: string },
  ) => Promise<void>;
  launchRitual?: (
    projectId: string,
    ritualId: string,
    params: Record<string, string>,
  ) => Promise<void>;
  mobileInspection?: MobileInspection;
  /**
   * Invoked only once a mutation actually changed host state, so a replayed
   * idempotent request does not announce a change that did not happen.
   */
  onWorkspaceChanged?: () => void;
}

export interface MobileControlGatewayContext {
  ownerId: string;
  connectionId: string;
  sendBinary: (streamId: StreamId, sequence: number, payload: Uint8Array) => void;
}

export class MobileControlGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'MobileControlGatewayError';
  }
}

const MAX_REMEMBERED_SPAWNS = 128;

export class MobileControlGateway {
  private readonly spawnByKey = new Map<string, {
    fingerprint: string;
    execution: Promise<PaneSpawnResult>;
  }>();

  private readonly mobileInspection: MobileInspection;

  constructor(private readonly options: MobileControlGatewayOptions) {
    this.mobileInspection = options.mobileInspection ?? createMobileInspection();
  }

  async handle(
    request: MobileControlRequest | { type: string; requestId?: unknown },
    context: MobileControlGatewayContext,
  ): Promise<MobileControlResponse> {
    const requestId = requireRequestId(request);

    switch (request.type) {
      case 'workspace.snapshot': {
        const { workspace, sequence } = await this.options.workspaceSnapshot();
        return {
          type: 'mobile.workspace.snapshot.result',
          requestId,
          sequence,
          workspace,
        };
      }
      case 'panes.attach': {
        const attachPane = this.require(this.options.attachPane, requestId);
        const paneId = requireNonEmpty(field(request, 'id'), 'id', requestId);
        const attached = await attachPane(
          context,
          paneId,
          optionalSequence(field(request, 'sinceSeq'), requestId),
        );
        // The mobile result, not the canonical daemon one: the client needs
        // the stream id and replay mode to route frames and decide whether to
        // append or replace what it already has.
        return {
          type: 'mobile.panes.attach.result',
          requestId,
          id: paneId,
          ...attached,
        };
      }
      case 'panes.detach': {
        const detachPane = this.require(this.options.detachPane, requestId);
        await detachPane(
          context.connectionId,
          requireNonEmpty(field(request, 'streamId'), 'streamId', requestId),
        );
        return { type: 'ack', requestId, ok: true };
      }
      case 'panes.input': {
        const sendPaneInput = this.require(this.options.sendPaneInput, requestId);
        const streamId = requireNonEmpty(field(request, 'streamId'), 'streamId', requestId);
        // Buffer.from(..., 'base64') never throws — it silently drops
        // characters outside the alphabet — so malformed input would otherwise
        // be typed into the user's terminal as mangled bytes.
        const data = decodeBase64Payload(field(request, 'data'));
        if (!data) {
          throw new MobileControlGatewayError(
            'invalid_input',
            'data must be a base64 string',
            requestId,
          );
        }
        await sendPaneInput(context.connectionId, streamId, data);
        return { type: 'ack', requestId, ok: true };
      }
      case 'panes.resize': {
        const resizePane = this.require(this.options.resizePane, requestId);
        const streamId = requireNonEmpty(field(request, 'streamId'), 'streamId', requestId);
        await resizePane(
          context.connectionId,
          streamId,
          requireDimension(field(request, 'cols'), 'cols', requestId),
          requireDimension(field(request, 'rows'), 'rows', requestId),
        );
        return { type: 'ack', requestId, ok: true };
      }
      case 'panes.spawn': {
        const spawnPane = this.require(this.options.spawnPane, requestId);
        const spawn = request as MobilePaneSpawnRequest;
        const key = requireNonEmpty(field(request, 'idempotencyKey'), 'idempotencyKey', requestId);
        const projectId = requireNonEmpty(field(request, 'projectId'), 'projectId', requestId);
        const cwd = requireNonEmpty(field(request, 'cwd'), 'cwd', requestId);

        await this.requireScope(requestId, (workspace) =>
          workspace.projects.some((project) =>
            project.id === projectId
            && (project.root === cwd
              || project.worktrees.some((worktree) => worktree.path === cwd))),
          'launch target is not a published project or worktree');

        const { result, replayed } = await this.runSpawnOnce(
          key,
          requestId,
          spawn,
          () => spawnPane(spawn),
        );
        if (!replayed) this.options.onWorkspaceChanged?.();
        return {
          type: 'panes.spawn.result',
          requestId,
          id: result.id,
          pane: result.pane,
          worktreePath: result.worktreePath,
          branch: result.branch,
        };
      }
      case 'panes.kill': {
        const killPane = this.require(this.options.killPane, requestId);
        const paneId = requireNonEmpty(field(request, 'id'), 'id', requestId);
        await this.requirePublishedPane(requestId, paneId);
        await killPane(paneId);
        this.options.onWorkspaceChanged?.();
        return { type: 'ack', requestId, ok: true };
      }
      case 'panes.meta': {
        const updatePaneMeta = this.require(this.options.updatePaneMeta, requestId);
        const paneId = requireNonEmpty(field(request, 'id'), 'id', requestId);
        const title = optionalString(field(request, 'title'), 'title', requestId);
        const agent = optionalString(field(request, 'agent'), 'agent', requestId);
        if (title === undefined && agent === undefined) {
          throw new MobileControlGatewayError(
            'invalid_control_request',
            'panes.meta needs a title or an agent to change',
            requestId,
          );
        }
        await this.requirePublishedPane(requestId, paneId);
        await updatePaneMeta(paneId, { title, agent });
        this.options.onWorkspaceChanged?.();
        return { type: 'ack', requestId, ok: true };
      }
      case 'rituals.launch': {
        const launchRitual = this.require(this.options.launchRitual, requestId);
        const projectId = requireNonEmpty(field(request, 'projectId'), 'projectId', requestId);
        const ritualId = requireNonEmpty(field(request, 'ritualId'), 'ritualId', requestId);
        const params = requireStringMap(field(request, 'params'), requestId);

        await this.requireScope(
          requestId,
          (workspace) => workspace.projects.some((project) => project.id === projectId),
          'project is not published by this host',
        );

        await launchRitual(projectId, ritualId, params);
        this.options.onWorkspaceChanged?.();
        return { type: 'ack', requestId, ok: true };
      }
      case 'files.list': {
        const paneId = requireNonEmpty(field(request, 'paneId'), 'paneId', requestId);
        const root = await this.requireInspectionRoot(requestId, paneId);
        const snapshot = await this.runInspection(
          requestId,
          () => this.mobileInspection.list(root),
        );
        return {
          type: 'files.list.result',
          requestId,
          paneId,
          snapshot,
        };
      }
      case 'files.read': {
        const paneId = requireNonEmpty(field(request, 'paneId'), 'paneId', requestId);
        const relativePath = requireNonEmpty(field(request, 'path'), 'path', requestId);
        const root = await this.requireInspectionRoot(requestId, paneId);
        const snapshot = await this.runInspection(
          requestId,
          () => this.mobileInspection.list(root),
        );
        const file = this.requireInspectionFile(snapshot, relativePath, requestId);
        if (!file.exists) {
          throw new MobileControlGatewayError(
            'file_deleted',
            'file no longer exists in the selected worktree',
            requestId,
          );
        }
        const preview = await this.runInspection(
          requestId,
          () => this.mobileInspection.readFile({
            root: snapshot.rootPath,
            relativePath: file.path,
          }),
        );
        return {
          type: 'files.read.result',
          requestId,
          paneId,
          path: file.path,
          content: preview.text,
          truncated: preview.truncated,
        };
      }
      case 'files.diff': {
        const paneId = requireNonEmpty(field(request, 'paneId'), 'paneId', requestId);
        const relativePath = requireNonEmpty(field(request, 'path'), 'path', requestId);
        const root = await this.requireInspectionRoot(requestId, paneId);
        const snapshot = await this.runInspection(
          requestId,
          () => this.mobileInspection.list(root),
        );
        const file = this.requireInspectionFile(snapshot, relativePath, requestId);
        const diff = await this.runInspection(
          requestId,
          () => this.mobileInspection.diff(snapshot.rootPath, file.path, file.statusCode),
        );
        return {
          type: 'files.diff.result',
          requestId,
          paneId,
          path: file.path,
          diff,
        };
      }
      case 'hello':
        throw new MobileControlGatewayError(
          'invalid_control_request',
          'nested hello is not a valid mobile control request',
          requestId,
        );
      default:
        throw new MobileControlGatewayError(
          'command_not_supported',
          `mobile control command is not supported yet: ${request.type}`,
          requestId,
        );
    }
  }

  /**
   * One execution per idempotency key. A retry after a dropped reply replays
   * the first outcome rather than spawning a second pane; the same key with a
   * different payload is a client bug and is refused instead of silently
   * returning something the caller did not ask for.
   */
  private async runSpawnOnce(
    key: string,
    requestId: string,
    request: MobilePaneSpawnRequest,
    launch: () => Promise<PaneSpawnResult>,
  ): Promise<{ result: PaneSpawnResult; replayed: boolean }> {
    const fingerprint = spawnFingerprint(request);
    const prior = this.spawnByKey.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new MobileControlGatewayError(
          'idempotency_conflict',
          'idempotency key reused with a different payload',
          requestId,
        );
      }
      return { result: await prior.execution, replayed: true };
    }

    const execution = launch();
    this.spawnByKey.set(key, { fingerprint, execution });
    // Bounded: the map would otherwise grow for the life of the daemon.
    if (this.spawnByKey.size > MAX_REMEMBERED_SPAWNS) {
      const oldest = this.spawnByKey.keys().next().value;
      if (oldest !== undefined) this.spawnByKey.delete(oldest);
    }

    try {
      return { result: await execution, replayed: false };
    } catch (error) {
      // A failure is not an outcome worth replaying — the client must be able
      // to retry the same key once the cause is fixed.
      this.spawnByKey.delete(key);
      throw error;
    }
  }

  /** Nothing mutates a target the workspace does not publish. */
  private async requireScope(
    requestId: string,
    predicate: (workspace: ReadonlyWorkspaceSnapshot) => boolean,
    message: string,
  ): Promise<void> {
    const { workspace } = await this.options.workspaceSnapshot();
    if (!predicate(workspace)) {
      throw new MobileControlGatewayError('unknown_target', message, requestId);
    }
  }

  private requirePublishedPane(requestId: string, paneId: string): Promise<void> {
    return this.requireScope(
      requestId,
      (workspace) => workspace.projects.some((project) =>
        project.projectPanes.some((pane) => pane.id === paneId)
        || project.worktrees.some((worktree) =>
          worktree.panes.some((pane) => pane.id === paneId))),
      'pane is not published by this host',
    );
  }

  private async requireInspectionRoot(requestId: string, paneId: string): Promise<string> {
    const { workspace } = await this.options.workspaceSnapshot();
    for (const project of workspace.projects) {
      for (const worktree of project.worktrees) {
        if (!worktree.panes.some((pane) => pane.id === paneId)) continue;
        if (worktree.missing || worktree.bare || worktree.prunable) break;
        return worktree.path;
      }
    }

    throw new MobileControlGatewayError(
      'unknown_target',
      'pane is not published with an available worktree',
      requestId,
    );
  }

  private requireInspectionFile(
    snapshot: BrowserSnapshot,
    relativePath: string,
    requestId: string,
  ): BrowserFileRecord {
    const file = snapshot.files.find((candidate) => candidate.path === relativePath);
    if (file) return file;
    throw new MobileControlGatewayError(
      'file_not_found',
      'file is not published by the selected worktree',
      requestId,
    );
  }

  private async runInspection<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MobileInspectionError) {
        throw new MobileControlGatewayError(error.code, error.message, requestId);
      }
      throw error;
    }
  }

  /** A command the host did not wire up is unsupported, never a crash. */
  private require<T>(dependency: T | undefined, requestId: string): T {
    if (!dependency) {
      throw new MobileControlGatewayError(
        'command_not_supported',
        'this host does not support terminal streams',
        requestId,
      );
    }
    return dependency;
  }
}

/// Every field here arrives off the wire, so it is read as unknown and
/// validated rather than trusted because the discriminant matched.
function field(request: object, name: string): unknown {
  return (request as Record<string, unknown>)[name];
}

function requireNonEmpty(value: unknown, field: string, requestId: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MobileControlGatewayError(
      'invalid_control_request',
      `${field} must be a non-empty string`,
      requestId,
    );
  }
  return value;
}

function optionalSequence(value: unknown, requestId: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MobileControlGatewayError(
      'invalid_control_request',
      'sinceSeq must be a non-negative integer',
      requestId,
    );
  }
  return value;
}

/// Guards the value that reaches tmux as command text.
function requireDimension(value: unknown, field: string, requestId: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new MobileControlGatewayError(
      'invalid_control_request',
      `${field} must be a positive integer`,
      requestId,
    );
  }
  return value;
}

/// Ritual params reach the host as launch configuration, so a non-string
/// value is refused rather than coerced into one.
function requireStringMap(value: unknown, requestId: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new MobileControlGatewayError(
      'invalid_control_request',
      'params must be an object of strings',
      requestId,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') {
      throw new MobileControlGatewayError(
        'invalid_control_request',
        `params.${key} must be a string`,
        requestId,
      );
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalString(value: unknown, field: string, requestId: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new MobileControlGatewayError(
      'invalid_control_request',
      `${field} must be a string`,
      requestId,
    );
  }
  return value;
}

/**
 * The launch itself, without the envelope. requestId changes on every retry
 * and must not make an otherwise identical launch look different.
 */
function spawnFingerprint(request: MobilePaneSpawnRequest): string {
  const { requestId, idempotencyKey, type, ...launch } = request as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(launch).sort().map((key) => [key, launch[key]]),
  );
}

function requireRequestId(request: { requestId?: unknown }): string {
  if (typeof request.requestId !== 'string' || request.requestId.trim().length === 0) {
    throw new MobileControlGatewayError(
      'invalid_control_request',
      'control requestId must be a non-empty string',
      undefined,
    );
  }
  return request.requestId;
}
