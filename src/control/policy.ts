import type { SurfaceCapability } from './capabilityLeases.js';
import type { BrowserSemanticAction, PaneAction } from './types.js';

export interface PolicyClassification {
  readonly decision: 'allow' | 'approval';
  readonly capability: SurfaceCapability;
}

declare const canonicalElementSemanticsBrand: unique symbol;
export interface CanonicalElementSemantics {
  readonly role?: string;
  readonly submit?: boolean;
  readonly submitMethod?: string;
  readonly submitDestination?: string;
  readonly secret?: boolean;
  readonly [canonicalElementSemanticsBrand]: true;
}

export interface CanonicalElementSemanticsInput {
  readonly role?: string;
  readonly submit?: boolean;
  readonly submitMethod?: string;
  readonly submitDestination?: string;
  readonly secret?: boolean;
}

export interface BrowserPolicyAction {
  readonly kind: BrowserSemanticAction['kind'];
  readonly semantic?: CanonicalElementSemantics;
}

const canonicalSemantics = new WeakSet<object>();

const POLICY = {
  paneInput: Object.freeze({ decision: 'allow', capability: 'pane.input' }),
  paneInterrupt: Object.freeze({ decision: 'allow', capability: 'pane.interrupt' }),
  paneFocus: Object.freeze({ decision: 'allow', capability: 'pane.focus' }),
  paneResize: Object.freeze({ decision: 'allow', capability: 'pane.resize' }),
  paneCreate: Object.freeze({ decision: 'allow', capability: 'pane.create' }),
  paneClose: Object.freeze({ decision: 'approval', capability: 'pane.close' }),
  browserInteract: Object.freeze({ decision: 'allow', capability: 'browser.interact' }),
  browserInteractApproval: Object.freeze({ decision: 'approval', capability: 'browser.interact' }),
  browserNavigate: Object.freeze({ decision: 'allow', capability: 'browser.navigate' }),
  browserHistory: Object.freeze({ decision: 'allow', capability: 'browser.history' }),
  browserScreenshot: Object.freeze({ decision: 'allow', capability: 'browser.screenshot' }),
  browserClose: Object.freeze({ decision: 'approval', capability: 'browser.close' }),
  browserScript: Object.freeze({ decision: 'approval', capability: 'browser.script' }),
} as const satisfies Record<string, PolicyClassification>;

export function createCanonicalElementSemantics(
  input: CanonicalElementSemanticsInput,
): CanonicalElementSemantics {
  assertPlainDataObject(input);
  const keys = Object.keys(input);
  if (keys.some((key) => !['role', 'submit', 'submitMethod', 'submitDestination', 'secret'].includes(key))) {
    return capabilityDenied(input);
  }
  if (
    (input.role !== undefined && typeof input.role !== 'string')
    || (input.submit !== undefined && typeof input.submit !== 'boolean')
    || (input.submitMethod !== undefined && (typeof input.submitMethod !== 'string' || input.submitMethod.length > 16))
    || (input.submitDestination !== undefined && (typeof input.submitDestination !== 'string' || input.submitDestination.length > 2_048))
    || (input.secret !== undefined && typeof input.secret !== 'boolean')
  ) {
    return capabilityDenied(input);
  }
  const semantic = Object.freeze({
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.submit === undefined ? {} : { submit: input.submit }),
    ...(input.submitMethod === undefined ? {} : { submitMethod: input.submitMethod }),
    ...(input.submitDestination === undefined ? {} : { submitDestination: input.submitDestination }),
    ...(input.secret === undefined ? {} : { secret: input.secret }),
  }) as CanonicalElementSemantics;
  canonicalSemantics.add(semantic);
  return semantic;
}

export function classifyPaneAction(action: PaneAction): PolicyClassification {
  if (!isAction(action)) return capabilityDenied(action);
  switch (action.kind) {
    case 'send_text':
    case 'send_keys':
      return POLICY.paneInput;
    case 'interrupt':
      return POLICY.paneInterrupt;
    case 'focus':
      return POLICY.paneFocus;
    case 'resize':
      return POLICY.paneResize;
    case 'create':
      return POLICY.paneCreate;
    case 'close':
      return POLICY.paneClose;
    default:
      return assertNever(action);
  }
}

export function classifyBrowserAction(action: BrowserPolicyAction): PolicyClassification {
  if (!isAction(action)) return capabilityDenied(action);
  if (action.semantic !== undefined && !isCanonicalSemantics(action.semantic)) {
    return capabilityDenied(action.semantic);
  }
  switch (action.kind) {
    case 'click':
      if (!isCanonicalSemantics(action.semantic) || typeof action.semantic.submit !== 'boolean') {
        return capabilityDenied(action.semantic);
      }
      return action.semantic.submit ? POLICY.browserInteractApproval : POLICY.browserInteract;
    case 'type':
      if (!isCanonicalSemantics(action.semantic) || typeof action.semantic.secret !== 'boolean') {
        return capabilityDenied(action.semantic);
      }
      return action.semantic.secret ? POLICY.browserInteractApproval : POLICY.browserInteract;
    case 'select':
    case 'scroll':
    case 'focus':
      return POLICY.browserInteract;
    case 'submit':
    case 'upload':
    case 'download':
    case 'permission_response':
      return POLICY.browserInteractApproval;
    case 'navigate':
      return POLICY.browserNavigate;
    case 'reload':
    case 'back':
    case 'forward':
      return POLICY.browserHistory;
    case 'screenshot':
      return POLICY.browserScreenshot;
    case 'close':
      return POLICY.browserClose;
    default:
      return assertNever(action.kind);
  }
}

export function classifyBrowserScript(): PolicyClassification {
  return POLICY.browserScript;
}

function isCanonicalSemantics(value: unknown): value is CanonicalElementSemantics {
  return typeof value === 'object' && value !== null && canonicalSemantics.has(value);
}

function assertPlainDataObject(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value
    || typeof value !== 'object'
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string')
    || Object.getOwnPropertyNames(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
    })
  ) {
    return capabilityDenied(value);
  }
}

function assertNever(action: never): never {
  return capabilityDenied(action);
}

function capabilityDenied(action: unknown): never {
  void action;
  throw Object.assign(new Error('action kind is not authorized by policy'), {
    code: 'capability_denied' as const,
  });
}

function isAction(value: unknown): value is { readonly kind: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { kind?: unknown }).kind === 'string';
}
