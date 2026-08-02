import type { PsychePane, MergeTargetReference } from '../types.js';
import type { AgentName, PermissionMode } from '../utils/agentLaunch.js';

export const ORCHESTRATION_LANE_MODES = [
  'isolated-worktree',
  'shared-worktree',
  'terminal',
  'coven-session',
] as const;

export type OrchestrationLaneMode = typeof ORCHESTRATION_LANE_MODES[number];

export interface ExistingWorktreeRef {
  slug: string;
  worktreePath: string;
  branchName: string;
}

export interface OrchestrationLaneRequest {
  id: string;
  mode: OrchestrationLaneMode;
  agent?: AgentName;
  harness?: string;
  existingWorktree?: ExistingWorktreeRef;
  permissionMode?: PermissionMode;
}

export interface OrchestrationTaskRequest {
  taskId: string;
  traceId?: string;
  projectRoot: string;
  cwd?: string;
  prompt: string;
  title?: string;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
  concurrency?: number;
  lanes: OrchestrationLaneRequest[];
}

export interface OrchestrationLanePlan extends OrchestrationLaneRequest {
  taskId: string;
  traceId: string;
  index: number;
  projectRoot: string;
  cwd: string;
  prompt: string;
  title?: string;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
}

export interface OrchestrationTaskPlan {
  taskId: string;
  traceId: string;
  projectRoot: string;
  cwd: string;
  concurrency: number;
  lanes: OrchestrationLanePlan[];
}

export interface OrchestrationLaneResultBase {
  id: string;
  startedAt: string;
  completedAt: string;
}

export interface OrchestrationLaneSuccess extends OrchestrationLaneResultBase {
  status: 'completed';
  pane?: PsychePane;
  sessionId?: string;
}

export interface OrchestrationLaneFailure extends OrchestrationLaneResultBase {
  status: 'failed';
  error: { code: OrchestrationErrorCode; message: string };
}

export type OrchestrationLaneResult =
  | OrchestrationLaneSuccess
  | OrchestrationLaneFailure;

export type OrchestrationTaskResultStatus = 'completed' | 'partial' | 'failed';

export interface OrchestrationTaskResult {
  taskId: string;
  traceId: string;
  status: OrchestrationTaskResultStatus;
  startedAt: string;
  completedAt: string;
  lanes: OrchestrationLaneResult[];
}

export const ORCHESTRATION_ERROR_CODES = [
  'invalid_orchestration_request',
  'project_scope_violation',
  'unsupported_lane_mode',
  'unsupported_agent',
  'capability_provider_unavailable',
  'capability_not_supported',
  'capability_contract_violation',
  'lane_execution_failed',
  'orchestration_persistence_failed',
] as const;

export type OrchestrationErrorCode = typeof ORCHESTRATION_ERROR_CODES[number];

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  public readonly cause: unknown;

  constructor(code: OrchestrationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
