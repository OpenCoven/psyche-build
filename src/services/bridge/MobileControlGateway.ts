import type { StreamId } from '../../daemon/protocol.js';
import type { ReadonlyWorkspaceSnapshot } from '../../workspace/snapshot.js';
import type {
  MobileControlRequest,
  MobileControlResponse,
} from './wireProtocol.js';

export interface MobileControlGatewayOptions {
  workspaceProvider: () => ReadonlyWorkspaceSnapshot | Promise<ReadonlyWorkspaceSnapshot>;
  workspaceSequence: () => number;
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
    _context: MobileControlGatewayContext,
  ): Promise<MobileControlResponse> {
    const requestId = requireRequestId(request);

    switch (request.type) {
      case 'workspace.snapshot':
        return {
          type: 'mobile.workspace.snapshot.result',
          requestId,
          sequence: this.options.workspaceSequence(),
          workspace: await this.options.workspaceProvider(),
        };
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
