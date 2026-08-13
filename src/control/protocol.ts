import type {
  ActionReceipt,
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
    }
  | {
      version: 1;
      type: 'action.status';
      requestId: string;
      actionId: string;
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
    default:
      throw new Error('unsupported control request type');
  }

  return value as ControlRequest;
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
  if (kind === 'pane.observe' && 'afterSequence' in payload && !isAuthorityInteger(payload.afterSequence)) return false;
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
  if (kind === 'browser.script' && typeof payload.source !== 'string') return false;
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
      && action.keys.every((key) => typeof key === 'string' && PANE_NAMED_KEYS.has(key));
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

const PANE_NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d',
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

const SURFACE_CAPABILITIES: ReadonlySet<string> = new Set([
  'pane.observe', 'pane.input', 'pane.interrupt', 'pane.focus', 'pane.resize',
  'pane.create', 'pane.close', 'browser.inspect', 'browser.screenshot',
  'browser.navigate', 'browser.interact', 'browser.history', 'browser.close',
  'browser.script',
]);
