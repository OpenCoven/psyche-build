import path from 'node:path';
import type { MergeTargetReference } from '../types.js';
import { isAgentName, type PermissionMode } from '../utils/agentLaunch.js';
import {
  ORCHESTRATION_LANE_MODES,
  OrchestrationError,
  type ExistingWorktreeRef,
  type OrchestrationLaneMode,
  type OrchestrationLanePlan,
  type OrchestrationLaneRequest,
  type OrchestrationTaskPlan,
  type OrchestrationTaskRequest,
} from './types.js';

const MAX_ORCHESTRATION_CONCURRENCY = 4;
const SUPPORTED_LANE_MODES = new Set<string>(ORCHESTRATION_LANE_MODES);
const SUPPORTED_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set([
  '',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]);

interface NormalizedTaskFields {
  taskId: string;
  traceId?: string;
  projectRoot: string;
  cwd: string;
  prompt: string;
  title?: string;
  startPointBranch?: string;
  mergeTargetChain?: MergeTargetReference[];
}

export function planOrchestrationTask(
  request: OrchestrationTaskRequest
): OrchestrationTaskPlan {
  const taskId = normalizeRequiredString(request?.taskId, 'taskId');
  const traceId = normalizeOptionalString(request?.traceId, 'traceId');
  const projectRoot = path.resolve(normalizeRequiredString(request?.projectRoot, 'projectRoot'));
  const cwd = resolveScopedCwd(projectRoot, request?.cwd);
  const prompt = normalizeRequiredString(request?.prompt, 'prompt');
  const title = normalizeOptionalString(request?.title, 'title');
  const startPointBranch = normalizeOptionalString(
    request?.startPointBranch,
    'startPointBranch'
  );
  const mergeTargetChain = normalizeMergeTargetChain(
    request?.mergeTargetChain,
    projectRoot
  );

  if (!Array.isArray(request?.lanes) || request.lanes.length === 0) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'orchestration requires at least one lane'
    );
  }

  const taskFields: NormalizedTaskFields = {
    taskId,
    traceId,
    projectRoot,
    cwd,
    prompt,
    title,
    startPointBranch,
    mergeTargetChain,
  };

  const seenLaneIds = new Set<string>();
  const lanes = request.lanes.map((lane, index) => {
    const plan = normalizeLanePlan(lane, index, taskFields);
    if (seenLaneIds.has(plan.id)) {
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `duplicate lane id "${plan.id}" in orchestration request`
      );
    }
    seenLaneIds.add(plan.id);
    return plan;
  });

  return {
    taskId,
    traceId,
    projectRoot,
    cwd,
    concurrency: normalizeConcurrency(request?.concurrency, lanes.length),
    lanes,
  };
}

function normalizeLanePlan(
  lane: OrchestrationLaneRequest,
  index: number,
  taskFields: NormalizedTaskFields
): OrchestrationLanePlan {
  const laneId = normalizeRequiredString(lane?.id, 'lane id');
  const mode = normalizeLaneMode(lane?.mode, laneId);
  const agent = normalizeAgent(lane?.agent);
  const harness = normalizeOptionalString(lane?.harness, 'harness');
  const existingWorktree = normalizeExistingWorktreeRef(
    lane?.existingWorktree,
    taskFields.projectRoot
  );
  const permissionMode = normalizePermissionMode(lane?.permissionMode);

  if (mode === 'shared-worktree' && !existingWorktree) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `shared-worktree lane "${laneId}" requires an existing worktree reference`
    );
  }

  if (mode === 'coven-session' && !harness) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `coven-session lane "${laneId}" requires a harness`
    );
  }

  return {
    id: laneId,
    mode,
    agent,
    harness,
    existingWorktree,
    permissionMode,
    index,
    ...taskFields,
    mergeTargetChain: cloneMergeTargetChain(taskFields.mergeTargetChain),
  };
}

function normalizeLaneMode(
  value: OrchestrationLaneRequest['mode'],
  laneId: string
): OrchestrationLaneMode {
  const mode = normalizeRequiredString(value, 'lane mode');
  if (!SUPPORTED_LANE_MODES.has(mode)) {
    throw new OrchestrationError(
      'unsupported_lane_mode',
      `unsupported lane mode "${mode}" for lane "${laneId}"`
    );
  }
  return mode as OrchestrationLaneMode;
}

function normalizeAgent(value: OrchestrationLaneRequest['agent']) {
  if (value === undefined) return undefined;
  const agent = normalizeRequiredString(value, 'agent');
  if (!isAgentName(agent)) {
    throw new OrchestrationError('unsupported_agent', `unsupported agent "${agent}"`);
  }
  return agent;
}

function normalizeExistingWorktreeRef(
  value: OrchestrationLaneRequest['existingWorktree'],
  projectRoot: string
): ExistingWorktreeRef | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'existingWorktree must be an object'
    );
  }

  return {
    slug: normalizeRequiredString(value.slug, 'existingWorktree.slug'),
    worktreePath: path.resolve(
      projectRoot,
      normalizeRequiredString(value.worktreePath, 'existingWorktree.worktreePath')
    ),
    branchName: normalizeRequiredString(
      value.branchName,
      'existingWorktree.branchName'
    ),
  };
}

function normalizePermissionMode(
  value: OrchestrationLaneRequest['permissionMode']
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'permissionMode must be a string when provided'
    );
  }

  const permissionMode = value.trim() as PermissionMode;
  if (!SUPPORTED_PERMISSION_MODES.has(permissionMode)) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `unsupported permissionMode "${value}"`
    );
  }
  return permissionMode;
}

function normalizeMergeTargetChain(
  value: OrchestrationTaskRequest['mergeTargetChain'],
  projectRoot: string
): MergeTargetReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'mergeTargetChain must be an array when provided'
    );
  }

  return value.map((target, index) => normalizeMergeTargetReference(target, index, projectRoot));
}

function normalizeMergeTargetReference(
  value: MergeTargetReference,
  index: number,
  projectRoot: string
): MergeTargetReference {
  if (!value || typeof value !== 'object') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `mergeTargetChain[${index}] must be an object`
    );
  }

  const branchName = normalizeRequiredString(
    value.branchName,
    `mergeTargetChain[${index}].branchName`
  );
  const displayName = normalizeOptionalString(
    value.displayName,
    `mergeTargetChain[${index}].displayName`
  );
  const slug = normalizeOptionalString(value.slug, `mergeTargetChain[${index}].slug`);
  const worktreePath = normalizeOptionalString(
    value.worktreePath,
    `mergeTargetChain[${index}].worktreePath`
  );

  return {
    branchName,
    displayName,
    slug,
    worktreePath: worktreePath ? path.resolve(projectRoot, worktreePath) : undefined,
  };
}

function cloneMergeTargetChain(
  mergeTargetChain: MergeTargetReference[] | undefined
): MergeTargetReference[] | undefined {
  return mergeTargetChain?.map((target) => ({ ...target }));
}

function resolveScopedCwd(projectRoot: string, cwd: OrchestrationTaskRequest['cwd']): string {
  const rawCwd = normalizeOptionalString(cwd, 'cwd');
  const resolvedCwd = rawCwd ? path.resolve(projectRoot, rawCwd) : projectRoot;

  if (!isPathInsideOrEqual(projectRoot, resolvedCwd)) {
    throw new OrchestrationError(
      'project_scope_violation',
      `cwd "${resolvedCwd}" resolves outside the project root`
    );
  }

  return resolvedCwd;
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} must be a non-empty string`
    );
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} must be a non-empty string`
    );
  }
  return normalized;
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} must be a string when provided`
    );
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeConcurrency(value: unknown, laneCount: number): number {
  const requested = value === undefined ? laneCount : value;
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'concurrency must be a positive integer'
    );
  }

  return Math.min(requested, laneCount, MAX_ORCHESTRATION_CONCURRENCY);
}
