import type { OrchestrationTaskSubmission } from '../orchestration/types.js';
import type {
  CapabilityLease,
  CapabilityLeaseHistoryEntry,
  LeaseTarget,
  SurfaceCapability,
} from './capabilityLeases.js';
import type { BrowserTabSurface, SurfaceResource } from './surfaces.js';
import type { Approval } from './approvals.js';

export interface LeaseGrant {
  readonly target: LeaseTarget;
  readonly capabilities: readonly SurfaceCapability[];
}

export type PaneNamedKey =
  | 'Enter' | 'Tab' | 'Escape' | 'Backspace'
  | 'Up' | 'Down' | 'Left' | 'Right'
  | 'C-c' | 'C-d';

export type ExistingPaneAction =
  | { kind: 'send_text'; text: string }
  | { kind: 'send_keys'; keys: readonly PaneNamedKey[] }
  | { kind: 'interrupt'; key?: 'C-c' | 'Escape' }
  | { kind: 'focus' }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'close' };

export type PaneCreateAction = {
  kind: 'create'; cwd: string; title?: string; agent?: string; branch?: string;
};

export type PaneAction = ExistingPaneAction | PaneCreateAction;

export interface BrowserSemanticMetadata {
  role?: string;
  name?: string;
  submit?: boolean;
  secret?: boolean;
}

export type BrowserElementAction =
  | { kind: 'click'; elementRef: string; semantic?: BrowserSemanticMetadata }
  | { kind: 'type'; elementRef: string; text: string; append?: boolean; semantic?: BrowserSemanticMetadata }
  | { kind: 'select'; elementRef: string; values: readonly string[]; semantic?: BrowserSemanticMetadata }
  | { kind: 'submit'; elementRef: string; semantic?: BrowserSemanticMetadata }
  | { kind: 'upload'; elementRef: string; path: string; semantic?: BrowserSemanticMetadata }
  | { kind: 'download'; elementRef: string; destination: string; semantic?: BrowserSemanticMetadata }
  | { kind: 'scroll'; elementRef: string; deltaX?: number; deltaY?: number }
  | { kind: 'focus'; elementRef: string; semantic?: BrowserSemanticMetadata };

export type BrowserSurfaceAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'permission_response'; permission: string; origin: string; decision: 'allow' | 'deny' }
  | { kind: 'reload' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'screenshot' }
  | { kind: 'close' };

export type BrowserSemanticAction = BrowserElementAction | BrowserSurfaceAction;

export interface SemanticSnapshot {
  schema: 'psyche.browser.snapshot/v1';
  id: string;
  tabId: string;
  generation: number;
  url: string;
  title: string;
  loading: boolean;
  viewport: { width: number; height: number };
  capturedAt: string;
  nodes: readonly {
    ref: string;
    role: string;
    name: string;
    state?: Readonly<Record<string, boolean | string | number>>;
    value?: { kind: string; value?: string; secret?: boolean };
    bounds?: { x: number; y: number; width: number; height: number };
    actions?: readonly string[];
    children?: readonly string[];
  }[];
  truncated: boolean;
  opaqueFrames: number;
  expiresAt: string;
  screenshot?: Readonly<{ pngBase64: string; width: number; height: number }>;
}

export type ActionReceiptState =
  | 'queued' | 'running' | 'approval_required' | 'succeeded'
  | 'failed' | 'denied' | 'expired' | 'unknown';

export type JournalActionReceiptResource =
  | { kind: 'project'; idDigest: string }
  | { kind: 'pane' | 'browser_tab'; idDigest: string; generation: number };

export interface ActionReceiptBase<Resource> {
  schema: 'psyche.control.receipt/v1';
  actionId: string;
  state: ActionReceiptState;
  resource: Resource;
  createdAt: string;
  taskId?: string;
  actorId?: string;
  leaseId?: string;
  leaseRevision?: number;
  completedAt?: string;
  code?: string;
  sourceDigest?: string;
  sourceBytes?: number;
  resultBytes?: number;
  durationMs?: number;
}

export type ActionReceipt = ActionReceiptBase<LeaseTarget> & {
  message?: string;
  value?: unknown;
};
export type JournalActionReceipt = ActionReceiptBase<JournalActionReceiptResource>;
export type ActionStatusReceipt = ActionReceipt | JournalActionReceipt;

interface AgentSurfaceAuthorization {
  taskId: string;
  leaseId: string;
  leaseRevision: number;
}

interface PaneAuthorization extends AgentSurfaceAuthorization {
  paneId: string;
  generation: number;
}

interface BrowserAuthorization extends AgentSurfaceAuthorization {
  tabId: string;
  generation: number;
}

type PaneActionPayload =
  | (PaneAuthorization & {
      projectId?: never;
      action: ExistingPaneAction;
    })
  | (AgentSurfaceAuthorization & {
      projectId: string;
      paneId?: never;
      generation?: never;
      action: PaneCreateAction;
    });

type BrowserActionPayload = BrowserAuthorization & (
  | { snapshotId: string; action: BrowserElementAction }
  | { snapshotId?: never; action: BrowserSurfaceAction }
);

export type ControlActorKind = 'human' | 'psyche' | 'compatibility';

export interface ControlActor {
  id: string;
  kind: ControlActorKind;
  clientId?: string;
}

export interface CommandBase<K extends string, P> {
  id: string;
  idempotencyKey: string;
  kind: K;
  projectRoot: string;
  actor: ControlActor;
  ownerEpoch: number;
  createdAt: string;
  expiresAt?: string;
  payload: P;
}

export interface PromptEnvelope {
  promptId: string;
  paneId: string;
  taskId?: string;
  harness?: string;
  utf8: string;
  contentHash: string;
  readinessRevision?: string;
  submitMode: 'text' | 'text-and-enter';
  leaseRevision: number;
}

export type ControlCommand =
  | CommandBase<'orchestration.execute', AgentSurfaceAuthorization & { request: OrchestrationTaskSubmission }>
  | CommandBase<'lease.request', {
      taskId: string;
      ttlMs: number;
      grants: readonly LeaseGrant[];
    }>
  | CommandBase<'lease.grant', {
      requestId: string;
    }>
  | CommandBase<'lease.release', {
      taskId: string;
      leaseId: string;
      leaseRevision: number;
    }>
  | CommandBase<'lease.revoke', { leaseId: string }>
  | CommandBase<'pane.observe', PaneAuthorization & { afterSequence?: number }>
  | CommandBase<'pane.action', PaneActionPayload>
  | CommandBase<'browser.inspect', BrowserAuthorization & {
      includeScreenshot?: boolean;
    }>
  | CommandBase<'browser.action', BrowserActionPayload>
  | CommandBase<'browser.script', BrowserAuthorization & {
      source: string;
      args?: unknown;
    }>
  | CommandBase<'approval.resolve', {
      approvalId: string;
      payloadDigest: string;
      decision: 'approve' | 'deny';
    }>
  | CommandBase<'provider.resource.upsert', { resource: BrowserTabSurface }>
  | CommandBase<'provider.resource.remove', { id: string; generation: number }>
  | CommandBase<'pane.spawn', {
      cwd: string;
      agent?: string;
      title?: string;
      prompt?: string;
      branch?: string;
      /** Existing branch or ref from which to create the generated pane branch. */
      startPointBranch?: string;
      /**
       * Attach to a worktree that already exists instead of creating one, so
       * several agents share a branch and files. Carried through from the v0
       * spawn request so the compatibility adapter loses no functionality.
       */
      existingWorktree?: { slug: string; worktreePath: string; branchName: string };
      /** Originating v0 request id, preserved for downstream correlation. */
      requestId?: string;
    }>
  | CommandBase<'pane.prompt', PromptEnvelope>
  | CommandBase<'pane.interrupt', {
      paneId: string;
      key: 'C-c' | 'Escape';
      leaseRevision: number;
    }>
  | CommandBase<'pane.delegate', {
      paneId: string;
      automationActorId: string;
      taskId: string;
      ttlMs: number;
    }>
  | CommandBase<'pane.takeover', { paneId: string }>
  | CommandBase<'pane.input', {
      paneId: string;
      dataBase64: string;
      leaseRevision: number;
    }>
  | CommandBase<'pane.terminal.open', { cwd: string; title?: string }>
  | CommandBase<'pane.resize', { paneId: string; cols: number; rows: number }>
  | CommandBase<'pane.focus', { paneId: string }>
  | CommandBase<'pane.kill', { paneId: string }>
  | CommandBase<'pane.respawn', { paneId: string; cwd: string; command: string }>
  | CommandBase<'pane.conflict.open', {
      sourcePaneId: string;
      targetRepoPath: string;
      targetBranch: string;
      agent?: string;
    }>
  | CommandBase<'pane.option.update', {
      paneId: string;
      option: string;
      value?: string;
    }>
  | CommandBase<'pane.meta.update', { paneId: string; title?: string; agent?: string }>
  | CommandBase<'ritual.launch', {
      projectId: string;
      ritualId: string;
      params: Record<string, string>;
    }>
  | CommandBase<'coven.session.launch', {
      harness: string;
      prompt: string;
      cwd?: string;
      title?: string;
    }>
  | CommandBase<'coven.session.open', { sessionId: string }>
  | CommandBase<'coven.desktop.action', { sessionId: string; action: string }>
  | CommandBase<'coven.capability.execute', {
      sessionId: string;
      capability: string;
      prompt: string;
      provider?: string;
      taskId: string;
      traceId?: string;
      idempotencyKey?: string;
      /**
       * Optional fields carried through from the v0 `CovenCapabilityRequest` so
       * the compatibility adapter loses nothing when routing capability
       * execution through the runtime.
       */
      title?: string;
      state?: Readonly<Record<string, unknown>>;
      attempt?: number;
    }>;

export type ControlCommandInput =
  ControlCommand extends infer Command
    ? Command extends ControlCommand
      ? Omit<Command, 'ownerEpoch' | 'actor'>
      : never
    : never;

export type CommandOutcome =
  | { status: 'rejected'; code: string; message: string }
  | { status: 'succeeded'; value?: unknown }
  | { status: 'failed'; code: string; message: string }
  | { status: 'unknown'; code: string; message: string };

export interface CommandRecord {
  command: ControlCommand;
  outcome: CommandOutcome;
  sequence: number;
}

export interface ControlSnapshotScope {
  taskId?: string;
}

export interface ControlSnapshot {
  ownerEpoch: number;
  sequence: number;
  commands: Record<string, CommandRecord>;
  leases: Record<string, {
    paneId: string;
    actorId: string;
    actorKind: 'human' | 'psyche';
    taskId?: string;
    revision: number;
    expiresAt: string;
  }>;
  resources: readonly SurfaceResource[];
  capabilityLeases: readonly CapabilityLease[];
  leaseHistory?: readonly CapabilityLeaseHistoryEntry[];
  leaseRequests: readonly {
    id: string;
    ownerEpoch: number;
    actorId: string;
    taskId: string;
    status: 'pending' | 'granted' | 'released' | 'revoked';
    createdAt: string;
    ttlMs: number;
    grants: readonly LeaseGrant[];
  }[];
  approvals: readonly Approval[];
  receipts: readonly ActionStatusReceipt[];
}

function isActionReceiptBase<Resource>(
  value: unknown,
  resourceGuard: (resource: unknown) => resource is Resource,
): value is ActionReceiptBase<Resource> {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { schema?: unknown }).schema === 'psyche.control.receipt/v1'
    && typeof (value as { actionId?: unknown }).actionId === 'string'
    && isActionReceiptState((value as { state?: unknown }).state)
    && typeof (value as { createdAt?: unknown }).createdAt === 'string'
    && resourceGuard((value as { resource?: unknown }).resource)
    && optionalString((value as { taskId?: unknown }).taskId)
    && optionalString((value as { actorId?: unknown }).actorId)
    && optionalString((value as { leaseId?: unknown }).leaseId)
    && optionalPositiveInteger((value as { leaseRevision?: unknown }).leaseRevision)
    && optionalString((value as { completedAt?: unknown }).completedAt)
    && optionalString((value as { code?: unknown }).code)
    && optionalString((value as { sourceDigest?: unknown }).sourceDigest)
    && optionalNonNegativeInteger((value as { sourceBytes?: unknown }).sourceBytes)
    && optionalNonNegativeInteger((value as { resultBytes?: unknown }).resultBytes)
    && optionalNonNegativeNumber((value as { durationMs?: unknown }).durationMs)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 1);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

export function isActionReceiptState(value: unknown): value is ActionReceiptState {
  return value === 'queued'
    || value === 'running'
    || value === 'approval_required'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'denied'
    || value === 'expired'
    || value === 'unknown';
}

export function isActionReceiptResource(value: unknown): value is ActionReceipt['resource'] {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      (value as { kind?: unknown }).kind === 'project'
        ? typeof (value as { id?: unknown }).id === 'string'
          && (value as { generation?: unknown }).generation === undefined
        : ((value as { kind?: unknown }).kind === 'pane' || (value as { kind?: unknown }).kind === 'browser_tab')
          && typeof (value as { id?: unknown }).id === 'string'
          && Number.isSafeInteger((value as { generation?: unknown }).generation)
          && ((value as { generation?: unknown }).generation as number) >= 1
    )
  );
}

export function isJournalActionReceiptResource(value: unknown): value is JournalActionReceipt['resource'] {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { idDigest?: unknown }).idDigest === 'string'
    && /^[a-f0-9]{64}$/.test((value as { idDigest: string }).idDigest)
    && (
      (value as { kind?: unknown }).kind === 'project'
        ? (value as { generation?: unknown }).generation === undefined
        : ((value as { kind?: unknown }).kind === 'pane' || (value as { kind?: unknown }).kind === 'browser_tab')
          && Number.isSafeInteger((value as { generation?: unknown }).generation)
          && ((value as { generation?: unknown }).generation as number) >= 1
    )
  );
}

export function isActionReceipt(value: unknown): value is ActionReceipt {
  return isActionReceiptBase(value, isActionReceiptResource)
    && optionalString((value as { message?: unknown }).message);
}

export function isJournalActionReceipt(value: unknown): value is JournalActionReceipt {
  return isActionReceiptBase(value, isJournalActionReceiptResource)
    && !Object.prototype.hasOwnProperty.call(value, 'message')
    && !Object.prototype.hasOwnProperty.call(value, 'value');
}

export function isActionStatusReceipt(value: unknown): value is ActionStatusReceipt {
  return isActionReceipt(value) || isJournalActionReceipt(value);
}
