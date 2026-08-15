import type {
  ActionReceipt,
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
  BrowserSemanticAction,
} from './types.js';
__OURS__

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
      taskId?: string;
    }
  | {
      version: 1;
      type: 'events.read';
      requestId: string;
      afterSequence: number;
      limit?: number;
__OURS__
  | {
      version: 1;
      type: 'provider.resource.upsert';
      requestId: string;
      resource: BrowserTabSurface;
    }
  | {
      version: 1;
      type: 'provider.resource.remove';
      requestId: string;
      id: string;
      generation: number;
    }
  | {
      version: 1;
__OURS__
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
      taskBinding?: {
        taskId: string;
        subjectId: string;
      };
    }
__OURS__
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
      type: 'action.status.result';
      requestId: string;
      actionId: string;
      receipt?: ActionReceipt;
    }
  | {
      version: 1;
      type: 'error';
      requestId?: string;
      code: string;
      message: string;
    }
  | ProviderPush;

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

export function encodeControlMessage(message: ControlRequest | ControlResponse | ProviderPush): string {
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
  if (typeof value.type !== 'string' || !isNonemptyString(value.requestId)) {
    throw new Error('invalid control request envelope');
  }

  switch (value.type) {
    case 'hello':
      if (
        !exactKeys(value, ['clientName', 'projectRoot', 'requestId', 'token', 'type', 'version'])
        || value.requestId !== 'hello'
        || typeof value.token !== 'string'
        || typeof value.clientName !== 'string'
        || typeof value.projectRoot !== 'string'
      ) {
        throw new Error('invalid hello request');
      }
      break;
    case 'command.submit': {
      const command = value.command;
      if (
        !exactKeys(value, ['command', 'requestId', 'type', 'version'])
        || !isPlainObject(command)
        || !isPlainObject(command.payload)
__OURS__
      ) {
        throw new Error('invalid command.submit payload');
      }
      validateSurfaceAuthorization(command.kind, command.payload);
      break;
    }
    case 'state.get':
__OURS__
      break;
    case 'events.read':
      if (
        !exactKeys(value, ['afterSequence', 'requestId', 'type', 'version'], ['limit'])
        || typeof value.afterSequence !== 'number'
        || !Number.isSafeInteger(value.afterSequence)
        || value.afterSequence < 0
__OURS__
      ) {
        throw new Error('invalid events.read request');
      }
      break;
__OURS__
      break;
    default:
      throw new Error('unsupported control request type');
  }

  return value as ControlRequest;
}

__OURS__
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

__OURS__
