import type {
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
} from './types.js';

export const CONTROL_PROTOCOL_VERSION = 1;

export type ControlRequest =
  | {
      version: 1;
      type: 'hello';
      requestId: 'hello';
      token: string;
      clientName: string;
      projectRoot: string;
    }
  | {
      version: 1;
      type: 'command.submit';
      requestId: string;
      command: ControlCommandInput;
    }
  | {
      version: 1;
      type: 'state.get';
      requestId: string;
    }
  | {
      version: 1;
      type: 'events.read';
      requestId: string;
      afterSequence: number;
      limit?: number;
    };

export type ControlResponse =
  | {
      version: 1;
      type: 'welcome';
      requestId: 'welcome';
      projectRoot: string;
      ownerEpoch: number;
      principal: {
        id: string;
        kind: 'operator' | 'agent' | 'compatibility';
        capabilities: readonly string[];
      };
    }
  | { version: 1; type: 'ack'; requestId: string }
  | {
      version: 1;
      type: 'command.result';
      requestId: string;
      commandId: string;
      outcome: CommandOutcome;
    }
  | {
      version: 1;
      type: 'state.result';
      requestId: string;
      snapshot: ControlSnapshot;
    }
  | {
      version: 1;
      type: 'events.result';
      requestId: string;
      events: unknown[];
      nextSequence: number;
      gap: boolean;
    }
  | {
      version: 1;
      type: 'error';
      requestId?: string;
      code: string;
      message: string;
    };

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return current;
  });
}

export function encodeControlMessage(message: ControlRequest | ControlResponse): string {
  return stableStringify(message);
}

export function decodeControlRequest(raw: string): ControlRequest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid control request envelope');
  }
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw new Error(`unsupported control protocol version: ${String(value.version)}`);
  }
  if (typeof value.type !== 'string' || typeof value.requestId !== 'string') {
    throw new Error('invalid control request envelope');
  }

  switch (value.type) {
    case 'hello':
      if (
        typeof value.token !== 'string'
        || typeof value.clientName !== 'string'
        || typeof value.projectRoot !== 'string'
      ) {
        throw new Error('invalid hello request');
      }
      break;
    case 'command.submit': {
      const command = value.command;
      if (
        !isPlainObject(command)
        || !isPlainObject(command.payload)
        || typeof command.id !== 'string'
        || typeof command.idempotencyKey !== 'string'
        || typeof command.kind !== 'string'
        || typeof command.projectRoot !== 'string'
        || typeof command.createdAt !== 'string'
        || !Number.isFinite(Date.parse(command.createdAt))
        || ('expiresAt' in command
          && (typeof command.expiresAt !== 'string' || !Number.isFinite(Date.parse(command.expiresAt))))
      ) {
        throw new Error('invalid command.submit payload');
      }
      validateSurfaceAuthorization(command.kind, command.payload);
      break;
    }
    case 'state.get':
      break;
    case 'events.read':
      if (
        typeof value.afterSequence !== 'number'
        || !Number.isInteger(value.afterSequence)
        || value.afterSequence < 0
        || ('limit' in value && typeof value.limit !== 'number')
      ) {
        throw new Error('invalid events.read request');
      }
      break;
    default:
      throw new Error('unsupported control request type');
  }

  return value as ControlRequest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSurfaceAuthorization(kind: unknown, payload: Record<string, unknown>): void {
  const actionKinds = new Set([
    'pane.observe', 'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
  ]);
  if (kind === 'lease.release') {
    if (!hasTaskLeaseAuthorization(payload)) throw new Error('invalid surface authorization');
    return;
  }
  if (!actionKinds.has(String(kind))) return;
  if (!hasTaskLeaseAuthorization(payload)) throw new Error('invalid surface authorization');
  if (kind === 'pane.action' && isPlainObject(payload.action) && payload.action.kind === 'create') {
    if (typeof payload.projectId !== 'string') throw new Error('invalid surface authorization');
    return;
  }
  if (!Number.isSafeInteger(payload.generation) || (payload.generation as number) < 1) {
    throw new Error('invalid surface authorization');
  }
  if (kind === 'pane.observe' || kind === 'pane.action') {
    if (typeof payload.paneId !== 'string') throw new Error('invalid surface authorization');
  } else if (typeof payload.tabId !== 'string') {
    throw new Error('invalid surface authorization');
  }
}

function hasTaskLeaseAuthorization(payload: Record<string, unknown>): boolean {
  return typeof payload.taskId === 'string' && payload.taskId.length > 0
    && typeof payload.leaseId === 'string' && payload.leaseId.length > 0
    && Number.isSafeInteger(payload.leaseRevision)
    && (payload.leaseRevision as number) >= 1;
}
