import type { StreamId } from '../../daemon/protocol.js';
import { decodeBase64Payload } from '../../utils/base64.js';
import type { ReadonlyWorkspaceSnapshot } from '../../workspace/snapshot.js';
import type {
  MobileControlRequest,
  MobileControlResponse,
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

export class MobileControlGateway {
  constructor(private readonly options: MobileControlGatewayOptions) {}

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
