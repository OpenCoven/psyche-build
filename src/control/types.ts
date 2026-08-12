import type { OrchestrationTaskRequest } from '../orchestration/types.js';
import type {
  LeaseTarget,
  SurfaceCapability,
} from './capabilityLeases.js';
import type { SurfaceResource } from './surfaces.js';

export interface LeaseGrant {
  readonly target: LeaseTarget;
  readonly capabilities: readonly SurfaceCapability[];
}

export type ExistingPaneAction =
  | { kind: 'send_text'; text: string }
  | { kind: 'send_keys'; keys: readonly string[] }
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
}

export interface ActionReceipt {
  schema: 'psyche.control.receipt/v1';
  actionId: string;
  state:
    | 'queued' | 'running' | 'approval_required' | 'succeeded'
    | 'failed' | 'denied' | 'expired' | 'unknown';
  resource: LeaseTarget;
  createdAt: string;
  completedAt?: string;
  code?: string;
  message?: string;
  value?: unknown;
}

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
  | CommandBase<'orchestration.execute', { request: OrchestrationTaskRequest }>
  | CommandBase<'lease.request', {
      taskId: string;
      ttlMs: number;
      grants: readonly LeaseGrant[];
    }>
  | CommandBase<'lease.grant', {
      requestId: string;
      actorId: string;
      taskId: string;
      ttlMs: number;
      grants: readonly LeaseGrant[];
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
  | CommandBase<'provider.resource.upsert', { resource: SurfaceResource }>
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
}
