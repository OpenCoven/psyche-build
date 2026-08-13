import type { SurfaceCapability } from './capabilityLeases.js';
import type {
  BrowserSemanticAction,
  BrowserSemanticMetadata,
  PaneAction,
} from './types.js';

export interface PolicyClassification {
  readonly decision: 'allow' | 'approval';
  readonly capability: SurfaceCapability;
}

export interface BrowserPolicyAction {
  readonly kind: BrowserSemanticAction['kind'];
  readonly semantic?: BrowserSemanticMetadata;
}

declare const browserRiskContextBrand: unique symbol;
export type BrowserResolvedRiskContext = (
  | {
      readonly source: 'canonical_snapshot';
      readonly actionKind: 'click';
      readonly submit: boolean;
    }
  | {
      readonly source: 'canonical_snapshot';
      readonly actionKind: 'type';
      readonly secret: boolean;
    }
) & { readonly [browserRiskContextBrand]: true };

export type CanonicalSnapshotRiskNode =
  | { readonly actionKind: 'click'; readonly submit: boolean }
  | { readonly actionKind: 'type'; readonly secret: boolean };

export interface BrowserPolicyAuthority {
  readonly resolveFromCanonicalSnapshot: (
    node: CanonicalSnapshotRiskNode,
  ) => BrowserResolvedRiskContext;
  readonly classifyBrowserAction: (
    action: BrowserSemanticAction,
    risk?: BrowserResolvedRiskContext,
  ) => PolicyClassification;
}

const authorityClassifiers = new WeakMap<
  BrowserPolicyAuthority,
  BrowserPolicyAuthority['classifyBrowserAction']
>();

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

export function createBrowserPolicyAuthority(): BrowserPolicyAuthority {
  const trustedContexts = new WeakSet<object>();
  const resolveFromCanonicalSnapshot = (
    node: CanonicalSnapshotRiskNode,
  ): BrowserResolvedRiskContext => {
    if (!node || typeof node !== 'object') return capabilityDenied(node);
    let context: BrowserResolvedRiskContext;
    if (node.actionKind === 'click' && typeof node.submit === 'boolean') {
      context = Object.freeze({
        source: 'canonical_snapshot', actionKind: 'click', submit: node.submit,
      }) as BrowserResolvedRiskContext;
    } else if (node.actionKind === 'type' && typeof node.secret === 'boolean') {
      context = Object.freeze({
        source: 'canonical_snapshot', actionKind: 'type', secret: node.secret,
      }) as BrowserResolvedRiskContext;
    } else {
      return capabilityDenied(node);
    }
    trustedContexts.add(context);
    return context;
  };
  const authority: BrowserPolicyAuthority = Object.freeze({
    resolveFromCanonicalSnapshot,
    classifyBrowserAction: (
      action: BrowserSemanticAction,
      risk?: BrowserResolvedRiskContext,
    ) => classifyBrowserActionWithTrust(action, risk, trustedContexts),
  });
  authorityClassifiers.set(authority, authority.classifyBrowserAction);
  return authority;
}

export function classifyBrowserAction(action: BrowserPolicyAction): PolicyClassification;
export function classifyBrowserAction(
  action: BrowserSemanticAction,
  risk: BrowserResolvedRiskContext | undefined,
  authority: BrowserPolicyAuthority,
): PolicyClassification;
export function classifyBrowserAction(
  action: BrowserPolicyAction,
  risk?: BrowserResolvedRiskContext,
  authority?: BrowserPolicyAuthority,
): PolicyClassification {
  if (authority !== undefined || risk !== undefined) {
    const classify = authority && authorityClassifiers.get(authority);
    if (!classify) return capabilityDenied(authority);
    return classify(action as BrowserSemanticAction, risk);
  }
  return classifyBrowserActionDirect(action);
}

function classifyBrowserActionDirect(action: BrowserPolicyAction): PolicyClassification {
  if (!isAction(action)) return capabilityDenied(action);
  switch (action.kind) {
    case 'click':
      return action.semantic?.submit === true
        ? POLICY.browserInteractApproval
        : POLICY.browserInteract;
    case 'type':
      return action.semantic?.secret === true
        ? POLICY.browserInteractApproval
        : POLICY.browserInteract;
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

function classifyBrowserActionWithTrust(
  action: BrowserSemanticAction,
  risk: BrowserResolvedRiskContext | undefined,
  trustedContexts: WeakSet<object>,
): PolicyClassification {
  if (!isAction(action)) return capabilityDenied(action);
  switch (action.kind) {
    case 'click': {
      if (!isTrustedClickRisk(risk, trustedContexts)) return capabilityDenied(risk);
      return risk.submit
        ? POLICY.browserInteractApproval
        : POLICY.browserInteract;
    }
    case 'type': {
      if (!isTrustedTypeRisk(risk, trustedContexts)) return capabilityDenied(risk);
      return risk.secret
        ? POLICY.browserInteractApproval
        : POLICY.browserInteract;
    }
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
      return assertNever(action);
  }
}

export function classifyBrowserScript(): PolicyClassification {
  return POLICY.browserScript;
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

function isTrustedClickRisk(
  value: unknown,
  trustedContexts: WeakSet<object>,
): value is Extract<BrowserResolvedRiskContext, { actionKind: 'click' }> {
  return typeof value === 'object'
    && value !== null
    && trustedContexts.has(value)
    && (value as { source?: unknown }).source === 'canonical_snapshot'
    && (value as { actionKind?: unknown }).actionKind === 'click'
    && typeof (value as { submit?: unknown }).submit === 'boolean';
}

function isTrustedTypeRisk(
  value: unknown,
  trustedContexts: WeakSet<object>,
): value is Extract<BrowserResolvedRiskContext, { actionKind: 'type' }> {
  return typeof value === 'object'
    && value !== null
    && trustedContexts.has(value)
    && (value as { source?: unknown }).source === 'canonical_snapshot'
    && (value as { actionKind?: unknown }).actionKind === 'type'
    && typeof (value as { secret?: unknown }).secret === 'boolean';
}
