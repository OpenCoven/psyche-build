import type {
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
} from './types.js';
import type { BrowserTabSurface } from './surfaces.js';
import type { ProviderEffectResult, ProviderPush } from './browserProviderBroker.js';
import { AGENT_CONTROL_LIMITS } from './limits.js';
import { canonicalizeBoundedJson } from './boundedJson.js';
import type {
  ControlCapability,
  ControlPrincipalKind,
  ControlTaskBinding,
} from './credentials.js';
import { normalizeControlTaskId } from './taskIdentity.js';

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
    }
  | ProviderRequest;

export type ProviderRequest =
  | { version: 1; type: 'provider.register'; requestId: string; providerId: string }
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
      type: 'provider.effect.result';
      requestId: string;
      result: ProviderEffectResult;
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
        kind: ControlPrincipalKind;
        capabilities: readonly ControlCapability[];
      };
      taskBinding?: ControlTaskBinding;
    }
  | { version: 1; type: 'ack'; requestId: string; resource?: BrowserTabSurface }
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

export function encodeControlMessage(message: ControlRequest | ControlResponse | ProviderPush): string {
  return stableStringify(message);
}

const MAX_CONTROL_ID_LENGTH = 256;
const MAX_PROJECT_ROOT_LENGTH = 4096;
const CAPABILITIES_BY_KIND: Readonly<Record<
ControlPrincipalKind,
readonly ControlCapability[]
>> = {
  operator: ['read', 'mutate', 'delegate'],
  agent: ['read', 'mutate'],
  compatibility: ['read', 'mutate'],
};

export function decodeControlWelcome(
  raw: string,
): Extract<ControlResponse, { type: 'welcome' }> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid welcome frame');
  }
  if (!isPlainObject(value)) throw new Error('invalid welcome frame');
  const projectRoot = value.projectRoot;
  const ownerEpoch = value.ownerEpoch;
  if (
    value.version !== CONTROL_PROTOCOL_VERSION
    || value.type !== 'welcome'
    || value.requestId !== 'welcome'
    || !isValidProjectRoot(projectRoot)
    || typeof ownerEpoch !== 'number'
    || !Number.isSafeInteger(ownerEpoch)
    || ownerEpoch < 1
  ) {
    throw new Error('invalid welcome frame');
  }

  const principal = value.principal;
  if (
    !isPlainObject(principal)
    || Object.keys(principal).length !== 3
    || !Object.hasOwn(principal, 'id')
    || !Object.hasOwn(principal, 'kind')
    || !Object.hasOwn(principal, 'capabilities')
  ) {
    throw new Error('invalid welcome frame');
  }
  const principalId = principal.id;
  const principalKind = principal.kind;
  const capabilities = principal.capabilities;
  if (
    !isBoundedNonBlankString(principalId, MAX_CONTROL_ID_LENGTH)
    || !isControlPrincipalKind(principalKind)
    || !hasExpectedCapabilities(principalKind, capabilities)
  ) {
    throw new Error('invalid welcome frame');
  }

  let taskBinding: ControlTaskBinding | undefined;
  if (Object.hasOwn(value, 'taskBinding')) {
    const binding = value.taskBinding;
    if (
      !isPlainObject(binding)
      || Object.keys(binding).length !== 1
      || !Object.hasOwn(binding, 'taskId')
    ) {
      throw new Error('invalid welcome frame');
    }
    const taskId = normalizeControlTaskId(binding.taskId);
    if (taskId === undefined) throw new Error('invalid welcome frame');
    taskBinding = { taskId };
  }

  return {
    version: CONTROL_PROTOCOL_VERSION,
    type: 'welcome',
    requestId: 'welcome',
    projectRoot,
    ownerEpoch,
    principal: {
      id: principalId,
      kind: principalKind,
      capabilities: [...capabilities],
    },
    ...(taskBinding === undefined ? {} : { taskBinding }),
  };
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
    case 'provider.register':
      if (!isBoundedString(value.providerId)) throw new Error('invalid provider registration');
      break;
    case 'provider.resource.upsert':
      if (!isBrowserTabResource(value.resource)) throw new Error('invalid provider resource');
      break;
    case 'provider.resource.remove':
      if (!isBoundedString(value.id) || !isGeneration(value.generation)) {
        throw new Error('invalid provider resource removal');
      }
      break;
    case 'provider.effect.result':
      if (!isProviderEffectResult(value.result)) throw new Error('invalid provider effect result');
      break;
    default:
      throw new Error('unsupported control request type');
  }

  return value as ControlRequest;
}

function isBoundedString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isBoundedNonBlankString(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= max;
}

function isValidProjectRoot(value: unknown): value is string {
  return isBoundedNonBlankString(value, MAX_PROJECT_ROOT_LENGTH) && !value.includes('\0');
}

function isControlPrincipalKind(value: unknown): value is ControlPrincipalKind {
  return value === 'operator' || value === 'agent' || value === 'compatibility';
}

function isControlCapability(value: unknown): value is ControlCapability {
  return value === 'read' || value === 'mutate' || value === 'delegate';
}

function hasExpectedCapabilities(
  kind: ControlPrincipalKind,
  value: unknown,
): value is ControlCapability[] {
  if (!Array.isArray(value) || !value.every(isControlCapability)) return false;
  const expected = CAPABILITIES_BY_KIND[kind];
  return value.length === expected.length
    && expected.every((capability) => value.includes(capability));
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isBrowserTabResource(value: unknown): value is BrowserTabSurface {
  if (!isPlainObject(value) || value.kind !== 'browser_tab') return false;
  if (
    !isBoundedString(value.id, 256)
    || !isGeneration(value.generation)
    || !isBoundedString(value.providerId, 256)
    || !isBoundedString(value.webviewLabel, 256)
    || !isBoundedString(value.projectRoot)
    || !isBoundedString(value.worktreeRoot)
    || typeof value.url !== 'string' || value.url.length > 16_384
    || typeof value.title !== 'string' || value.title.length > 4096
    || typeof value.loading !== 'boolean'
    || !isPlainObject(value.viewport)
    || !Number.isSafeInteger(value.viewport.width) || (value.viewport.width as number) < 0
    || !Number.isSafeInteger(value.viewport.height) || (value.viewport.height as number) < 0
  ) return false;
  return true;
}

function isProviderEffectResult(value: unknown): value is ProviderEffectResult {
  if (!isPlainObject(value) || !isBoundedString(value.actionId, 256)) return false;
  const keys = Object.keys(value);
  const exactKeys = (allowed: readonly string[]) => keys.length === allowed.length
    && keys.every((key) => allowed.includes(key));
  switch (value.status) {
    case 'succeeded': {
      if (!exactKeys(value.value === undefined ? ['actionId', 'status'] : ['actionId', 'status', 'value'])) return false;
      if (value.value !== undefined) {
        try {
          canonicalizeBoundedJson(value.value, {
            maxBytes: 4 * 1024 * 1024,
            invalidCode: 'invalid_provider_result',
            sizeCode: 'invalid_provider_result',
            label: 'provider result',
          });
        } catch { return false; }
      }
      return true;
    }
    case 'failed':
      return exactKeys(['actionId', 'status', 'code', 'message'])
        && isBoundedString(value.code, 256) && isBoundedString(value.message, 4096);
    case 'unknown':
      return exactKeys(['actionId', 'status', ...(value.code === undefined ? [] : ['code']),
        ...(value.message === undefined ? [] : ['message'])])
        && (value.code === undefined || isBoundedString(value.code, 256))
        && (value.message === undefined || isBoundedString(value.message, 4096));
    default: return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSurfaceAuthorization(kind: unknown, payload: Record<string, unknown>): void {
  const actionKinds = new Set([
    'pane.observe', 'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
  ]);
  if (kind === 'lease.request') {
    const taskId = normalizeControlTaskId(payload.taskId);
    if (taskId === undefined) throw new Error('invalid surface authorization');
    payload.taskId = taskId;
    return;
  }
  if (kind === 'lease.release' || kind === 'orchestration.execute') {
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
  if (kind === 'browser.script' && payload.args !== undefined) {
    try {
      canonicalizeBoundedJson(payload.args, {
        maxBytes: AGENT_CONTROL_LIMITS.scriptResultBytes,
        invalidCode: 'invalid_browser_script_arguments',
        sizeCode: 'invalid_browser_script_arguments',
        label: 'browser script arguments',
      });
    } catch {
      throw new Error('invalid browser script arguments');
    }
  }
}

function hasTaskLeaseAuthorization(payload: Record<string, unknown>): boolean {
  const taskId = normalizeControlTaskId(payload.taskId);
  if (taskId === undefined) return false;
  payload.taskId = taskId;
  return typeof payload.leaseId === 'string' && payload.leaseId.length > 0
    && Number.isSafeInteger(payload.leaseRevision)
    && (payload.leaseRevision as number) >= 1;
}
