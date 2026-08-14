import type {
  ActionReceipt,
  CommandOutcome,
  ControlCommandInput,
  ControlSnapshot,
  BrowserSemanticAction,
} from './types.js';
import { isPaneNamedKey } from './types.js';
import type { BrowserTabSurface } from './surfaces.js';
import { SURFACE_CAPABILITIES as CANONICAL_SURFACE_CAPABILITIES } from './capabilityLeases.js';
import { AGENT_CONTROL_LIMITS } from './limits.js';

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
  | {
      version: 1;
      type: 'action.status';
      requestId: string;
      actionId: string;
    }
  | {
      version: 1;
      type: 'provider.register';
      requestId: string;
      providerId: string;
    }
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
      type: 'provider.effect.started';
      requestId: string;
      actionId: string;
      tabId: string;
      generation: number;
      invocationId: string;
      documentToken: string;
    }
  | {
      version: 1;
      type: 'provider.effect.executing';
      requestId: string;
      actionId: string;
      tabId: string;
      generation: number;
      invocationId: string;
      documentToken: string;
    }
  | {
      version: 1;
      type: 'provider.effect.result';
      requestId: string;
      result: ProviderEffectResult;
    };

export type BrowserProviderOperation =
  | { kind: 'inspect'; includeScreenshot?: boolean }
  | { kind: 'resolve'; snapshotId: string; elementRef: string; actionKind: 'click' | 'type' | 'select' | 'submit' | 'upload' | 'download' | 'scroll' | 'focus' }
  | { kind: 'action'; action: BrowserSemanticAction; snapshotId?: string; expectedRisk?: {
      documentId: string; submit: boolean | null; formId: string | null; secret: boolean | null;
    } }
  | { kind: 'script_context' }
  | { kind: 'script'; source: string; args?: unknown; expectedContext: {
      documentId: string; documentToken: string; navigationEpoch: number; navigationUrl: string;
    } };

export type ProviderEffectResult =
  | { actionId: string; status: 'succeeded'; value?: unknown }
  | { actionId: string; status: 'failed'; code: string; message: string; durationMs?: number }
  | { actionId: string; status: 'timed_out_pending'; code: 'action_timeout'; message: string; durationMs?: number }
  | { actionId: string; status: 'unknown_pending'; code: 'effect_unknown'; message: string; ambiguous: true; durationMs?: number }
  | { actionId: string; status: 'unknown'; code: string; message: string; ambiguous: true; durationMs?: number };

export type ProviderPush =
  | {
      version: 1;
      type: 'provider.effect.request';
      requestId: string;
      actionId: string;
      tabId: string;
      generation: number;
      operation: BrowserProviderOperation;
    }
  | {
      version: 1;
      type: 'provider.effect.cancel';
      requestId: string;
      actionId: string;
      reason: 'timeout';
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
  | { version: 1; type: 'provider.resource.result'; requestId: string; resource: BrowserTabSurface }
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
        || !isNonemptyString(command.id)
        || !isNonemptyString(command.idempotencyKey)
        || !isNonemptyString(command.kind)
        || !isNonemptyString(command.projectRoot)
        || !isNonemptyString(command.createdAt)
        || ('expiresAt' in command && typeof command.expiresAt !== 'string')
        || (NEW_COMMAND_KINDS.has(command.kind) && !exactKeys(
          command,
          ['createdAt', 'id', 'idempotencyKey', 'kind', 'payload', 'projectRoot'],
          ['expiresAt'],
        ))
        || !validAgentControlPayload(command.kind, command.payload)
      ) {
        throw new Error('invalid command.submit payload');
      }
      break;
    }
    case 'state.get':
      if (!exactKeys(value, ['requestId', 'type', 'version'])) throw new Error('invalid state.get request');
      break;
    case 'events.read':
      if (
        !exactKeys(value, ['afterSequence', 'requestId', 'type', 'version'], ['limit'])
        || typeof value.afterSequence !== 'number'
        || !Number.isSafeInteger(value.afterSequence)
        || value.afterSequence < 0
        || ('limit' in value && (!isAuthorityInteger(value.limit) || value.limit === 0))
      ) {
        throw new Error('invalid events.read request');
      }
      break;
    case 'action.status':
      if (
        !exactKeys(value, ['actionId', 'requestId', 'type', 'version'])
        || !isNonemptyString(value.actionId)
      ) throw new Error('invalid action.status request');
      break;
    case 'provider.register':
      if (!exactKeys(value, ['providerId', 'requestId', 'type', 'version']) || !isNonemptyString(value.providerId)) {
        throw new Error('invalid provider.register request');
      }
      break;
    case 'provider.resource.upsert':
      if (!exactKeys(value, ['requestId', 'resource', 'type', 'version']) || !validBrowserResource(value.resource)) {
        throw new Error('invalid provider.resource.upsert request');
      }
      break;
    case 'provider.resource.remove':
      if (!exactKeys(value, ['generation', 'id', 'requestId', 'type', 'version'])
        || !isNonemptyString(value.id) || !isAuthorityInteger(value.generation)) {
        throw new Error('invalid provider.resource.remove request');
      }
      break;
    case 'provider.effect.result':
      if (!exactKeys(value, ['requestId', 'result', 'type', 'version']) || !validProviderEffectResult(value.result)) {
        throw new Error('invalid provider.effect.result request');
      }
      break;
    case 'provider.effect.started':
    case 'provider.effect.executing':
      if (!exactKeys(value, ['actionId', 'documentToken', 'generation', 'invocationId', 'requestId', 'tabId', 'type', 'version'])
        || !isNonemptyString(value.actionId) || !isNonemptyString(value.tabId)
        || !isAuthorityInteger(value.generation) || !isNonemptyString(value.invocationId)
        || !isNonemptyString(value.documentToken)) {
        throw new Error('invalid provider.effect.started request');
      }
      break;
    default:
      throw new Error('unsupported control request type');
  }

  return value as ControlRequest;
}

function validBrowserResource(value: unknown): value is BrowserTabSurface {
  if (!isPlainObject(value)) return false;
  return exactKeys(value, [
    'generation', 'id', 'kind', 'loading', 'projectRoot', 'providerId',
    'title', 'url', 'viewport', 'webviewLabel', 'worktreeRoot',
  ]) && value.kind === 'browser_tab'
    && isNonemptyString(value.id) && isNonemptyString(value.providerId)
    && isNonemptyString(value.projectRoot) && isNonemptyString(value.worktreeRoot)
    && isNonemptyString(value.webviewLabel) && typeof value.url === 'string'
    && typeof value.title === 'string' && typeof value.loading === 'boolean'
    && isAuthorityInteger(value.generation) && isPlainObject(value.viewport)
    && exactKeys(value.viewport, ['height', 'width'])
    && isAuthorityInteger(value.viewport.width) && isAuthorityInteger(value.viewport.height);
}

export function validProviderEffectResult(value: unknown): value is ProviderEffectResult {
  if (!isPlainObject(value) || !isNonemptyString(value.actionId) || !isNonemptyString(value.status)) return false;
  if (value.status === 'succeeded') return exactKeys(value, ['actionId', 'status'], ['value']);
  const durationValid = value.durationMs === undefined
    || (typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= 5_000);
  if (value.status === 'failed') return exactKeys(value, ['actionId', 'code', 'message', 'status'], ['durationMs'])
    && durationValid && isNonemptyString(value.code) && value.code !== 'effect_unknown'
    && (value.code !== 'action_timeout' || value.durationMs === AGENT_CONTROL_LIMITS.scriptTimeoutMs)
    && typeof value.message === 'string';
  if (value.status === 'timed_out_pending') {
    return exactKeys(value, ['actionId', 'code', 'message', 'status'], ['durationMs'])
      && value.durationMs === AGENT_CONTROL_LIMITS.scriptTimeoutMs
      && value.code === 'action_timeout' && typeof value.message === 'string';
  }
  return (value.status === 'unknown' || value.status === 'unknown_pending')
    && exactKeys(value, ['actionId', 'ambiguous', 'code', 'message', 'status'], ['durationMs'])
    && durationValid && value.ambiguous === true && value.code === 'effect_unknown'
    && typeof value.message === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAuthorityInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function isResumableCursor(value: unknown): value is number {
  return isAuthorityInteger(value) && value < Number.MAX_SAFE_INTEGER;
}

const LEASE_AUTHORIZED_KINDS = new Set([
  'lease.release', 'pane.observe', 'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
]);
const NEW_COMMAND_KINDS = new Set([
  'lease.request', 'lease.grant', 'lease.release', 'lease.revoke',
  'pane.observe', 'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
  'approval.resolve', 'provider.resource.upsert', 'provider.resource.remove',
]);
const RESOURCE_GENERATION_KINDS = new Set([
  'pane.observe', 'browser.inspect', 'browser.action', 'browser.script', 'provider.resource.remove',
]);

function validAgentControlPayload(kind: string, payload: Record<string, unknown>): boolean {
  const payloadShape = NEW_PAYLOAD_SHAPES[kind];
  if (payloadShape && !exactKeys(payload, payloadShape.required, payloadShape.optional)) return false;
  if (LEASE_AUTHORIZED_KINDS.has(kind)) {
    if (
      !isNonemptyString(payload.leaseId)
      || !isNonemptyString(payload.taskId)
      || !isAuthorityInteger(payload.leaseRevision)
    ) return false;
  }
  if (RESOURCE_GENERATION_KINDS.has(kind) && !isAuthorityInteger(payload.generation)) return false;
  if (kind === 'pane.observe' && !isNonemptyString(payload.paneId)) return false;
  if (kind === 'pane.observe' && 'afterSequence' in payload && !isResumableCursor(payload.afterSequence)) return false;
  if (kind === 'pane.action') {
    if (!isPlainObject(payload.action) || !validPaneAction(payload.action)) return false;
    if (payload.action.kind === 'create') {
      if (!exactKeys(payload, ['action', 'leaseId', 'leaseRevision', 'projectId', 'taskId']) || !isNonemptyString(payload.projectId)) return false;
    } else if (!exactKeys(payload, ['action', 'generation', 'leaseId', 'leaseRevision', 'paneId', 'taskId'])
      || !isNonemptyString(payload.paneId) || !isAuthorityInteger(payload.generation)) return false;
  }
  if (
    (kind === 'browser.inspect' || kind === 'browser.action' || kind === 'browser.script')
    && !isNonemptyString(payload.tabId)
  ) return false;
  if (kind === 'browser.inspect' && 'includeScreenshot' in payload && typeof payload.includeScreenshot !== 'boolean') return false;
  if (kind === 'browser.script') {
    if (typeof payload.source !== 'string') return false;
    if ('args' in payload && !validCanonicalScriptArgs(payload.args)) return false;
  }
  if (kind === 'browser.action') {
    if (!isPlainObject(payload.action) || !validBrowserAction(payload.action)) return false;
    const element = BROWSER_ELEMENT_ACTIONS.has(String(payload.action.kind));
    if (!exactKeys(
      payload,
      element
        ? ['action', 'generation', 'leaseId', 'leaseRevision', 'snapshotId', 'tabId', 'taskId']
        : ['action', 'generation', 'leaseId', 'leaseRevision', 'tabId', 'taskId'],
    )) return false;
    if (element) {
      if (!isNonemptyString(payload.snapshotId) || !isNonemptyString(payload.action.elementRef)) return false;
    }
  }
  if (kind === 'lease.request') {
    return isNonemptyString(payload.taskId)
      && isAuthorityInteger(payload.ttlMs)
      && validGrants(payload.grants);
  }
  if (kind === 'lease.grant') {
    return isNonemptyString(payload.requestId)
      && isNonemptyString(payload.actorId)
      && isNonemptyString(payload.taskId)
      && isAuthorityInteger(payload.ttlMs)
      && validGrants(payload.grants);
  }
  if (kind === 'lease.revoke') return isNonemptyString(payload.leaseId);
  if (kind === 'approval.resolve') {
    return isNonemptyString(payload.approvalId)
      && isNonemptyString(payload.payloadDigest)
      && (payload.decision === 'approve' || payload.decision === 'deny');
  }
  if (kind === 'provider.resource.upsert') {
    return isPlainObject(payload.resource)
      && exactKeys(payload.resource, [
        'generation', 'id', 'kind', 'loading', 'projectRoot', 'providerId',
        'title', 'url', 'viewport', 'webviewLabel', 'worktreeRoot',
      ])
      && isNonemptyString(payload.resource.id)
      && payload.resource.kind === 'browser_tab'
      && isNonemptyString(payload.resource.providerId)
      && isNonemptyString(payload.resource.webviewLabel)
      && isAuthorityInteger(payload.resource.generation)
      && isNonemptyString(payload.resource.projectRoot)
      && isNonemptyString(payload.resource.worktreeRoot)
      && typeof payload.resource.url === 'string'
      && typeof payload.resource.title === 'string'
      && typeof payload.resource.loading === 'boolean'
      && isPlainObject(payload.resource.viewport)
      && exactKeys(payload.resource.viewport, ['height', 'width'])
      && isAuthorityInteger(payload.resource.viewport.width)
      && isAuthorityInteger(payload.resource.viewport.height);
  }
  if (kind === 'provider.resource.remove') return isNonemptyString(payload.id);
  return true;
}

function validCanonicalScriptArgs(value: unknown): boolean {
  if (!isCanonicalJsonValue(value)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= AGENT_CONTROL_LIMITS.scriptArgsBytes;
  } catch {
    return false;
  }
}

function isCanonicalJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  if (Array.isArray(value)) {
    if (keys.some((key) => typeof key !== 'string'
      || (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !('value' in descriptor) || !isCanonicalJsonValue(descriptor.value, seen)) return false;
    }
  } else {
    for (const key of keys) {
      const descriptor = descriptors[String(key)];
      if (!descriptor?.enumerable || !('value' in descriptor) || !isCanonicalJsonValue(descriptor.value, seen)) return false;
    }
  }
  seen.delete(value);
  return true;
}

const NEW_PAYLOAD_SHAPES: Record<string, { required: readonly string[]; optional?: readonly string[] }> = {
  'lease.request': { required: ['grants', 'taskId', 'ttlMs'] },
  'lease.grant': { required: ['actorId', 'grants', 'requestId', 'taskId', 'ttlMs'] },
  'lease.release': { required: ['leaseId', 'leaseRevision', 'taskId'] },
  'lease.revoke': { required: ['leaseId'] },
  'pane.observe': { required: ['generation', 'leaseId', 'leaseRevision', 'paneId', 'taskId'], optional: ['afterSequence'] },
  'browser.inspect': { required: ['generation', 'leaseId', 'leaseRevision', 'tabId', 'taskId'], optional: ['includeScreenshot'] },
  'browser.script': { required: ['generation', 'leaseId', 'leaseRevision', 'source', 'tabId', 'taskId'], optional: ['args'] },
  'approval.resolve': { required: ['approvalId', 'decision', 'payloadDigest'] },
  'provider.resource.upsert': { required: ['resource'] },
  'provider.resource.remove': { required: ['generation', 'id'] },
};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return false;
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return false;
  const keys = Object.keys(value);
  const accepted = new Set([...allowed, ...optional]);
  return allowed.every((key) => keys.includes(key)) && keys.every((key) => accepted.has(key));
}

function validPaneAction(action: Record<string, unknown>): boolean {
  switch (action.kind) {
    case 'send_text': return exactKeys(action, ['kind', 'text']) && typeof action.text === 'string';
    case 'send_keys': return exactKeys(action, ['kind', 'keys']) && Array.isArray(action.keys)
      && action.keys.every(isPaneNamedKey);
    case 'interrupt': return exactKeys(action, ['kind'], ['key']) && (!('key' in action) || action.key === 'C-c' || action.key === 'Escape');
    case 'focus':
    case 'close': return exactKeys(action, ['kind']);
    case 'resize': return exactKeys(action, ['cols', 'kind', 'rows']) && isAuthorityInteger(action.cols) && isAuthorityInteger(action.rows);
    case 'create': return exactKeys(action, ['cwd', 'kind'], ['agent', 'branch', 'title']) && isNonemptyString(action.cwd)
      && ['agent', 'branch', 'title'].every((key) => !(key in action) || typeof action[key] === 'string');
    default: return false;
  }
}

function validBrowserAction(action: Record<string, unknown>): boolean {
  if ('semantic' in action && !validSemantic(action.semantic)) return false;
  const semanticOptional = ['semantic'];
  switch (action.kind) {
    case 'click':
    case 'focus':
    case 'submit': return exactKeys(action, ['elementRef', 'kind'], semanticOptional) && isNonemptyString(action.elementRef);
    case 'type': return exactKeys(action, ['elementRef', 'kind', 'text'], ['append', 'semantic'])
      && isNonemptyString(action.elementRef) && typeof action.text === 'string'
      && (!('append' in action) || typeof action.append === 'boolean');
    case 'select': return exactKeys(action, ['elementRef', 'kind', 'values'], semanticOptional)
      && isNonemptyString(action.elementRef) && Array.isArray(action.values) && action.values.every((value) => typeof value === 'string');
    case 'upload': return exactKeys(action, ['elementRef', 'kind', 'path'], semanticOptional)
      && isNonemptyString(action.elementRef) && isNonemptyString(action.path);
    case 'download': return exactKeys(action, ['destination', 'elementRef', 'kind'], semanticOptional)
      && isNonemptyString(action.elementRef) && isNonemptyString(action.destination);
    case 'scroll': return exactKeys(action, ['elementRef', 'kind'], ['deltaX', 'deltaY']) && isNonemptyString(action.elementRef)
      && ['deltaX', 'deltaY'].every((key) => !(key in action) || typeof action[key] === 'number' && Number.isFinite(action[key]));
    case 'navigate': return exactKeys(action, ['kind', 'url']) && isNonemptyString(action.url);
    case 'permission_response': return exactKeys(action, ['decision', 'kind', 'origin', 'permission'])
      && isNonemptyString(action.origin) && isNonemptyString(action.permission) && (action.decision === 'allow' || action.decision === 'deny');
    case 'reload':
    case 'back':
    case 'forward':
    case 'screenshot':
    case 'close': return exactKeys(action, ['kind']);
    default: return false;
  }
}

function validSemantic(value: unknown): boolean {
  if (!isPlainObject(value) || !exactKeys(value, [], ['name', 'role', 'secret', 'submit'])) return false;
  return ['name', 'role'].every((key) => !(key in value) || typeof value[key] === 'string')
    && ['secret', 'submit'].every((key) => !(key in value) || typeof value[key] === 'boolean');
}

const BROWSER_ELEMENT_ACTIONS = new Set([
  'click', 'type', 'select', 'submit', 'upload', 'download', 'scroll', 'focus',
]);

function validGrants(value: unknown): boolean {
  return Array.isArray(value) && value.every((grant) => (
    isPlainObject(grant)
    && exactKeys(grant, ['capabilities', 'target'])
    && Array.isArray(grant.capabilities)
    && grant.capabilities.every((capability) => (
      typeof capability === 'string' && SURFACE_CAPABILITIES.has(capability)
    ))
    && isPlainObject(grant.target)
    && exactTargetKeys(grant.target)
    && (grant.target.kind === 'project' || grant.target.kind === 'pane' || grant.target.kind === 'browser_tab')
    && isNonemptyString(grant.target.id)
    && (grant.target.kind === 'project'
      ? !('generation' in grant.target)
      : isAuthorityInteger(grant.target.generation))
  ));
}

function exactTargetKeys(target: Record<string, unknown>): boolean {
  const expected = target.kind === 'project'
    ? ['id', 'kind']
    : ['generation', 'id', 'kind'];
  const actual = Object.keys(target).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const SURFACE_CAPABILITIES: ReadonlySet<string> = new Set(CANONICAL_SURFACE_CAPABILITIES);
