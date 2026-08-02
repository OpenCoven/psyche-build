import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MergeTargetReference } from '../types.js';
import { isAgentName, type PermissionMode } from '../utils/agentLaunch.js';
import { isValidBranchName } from '../utils/git.js';
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
  traceId: string;
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
  const traceId = normalizeRequestTraceId(request?.traceId, taskId);
  const projectRoot = normalizeProjectRoot(request?.projectRoot);
  const cwd = resolveScopedCwd(projectRoot, request?.cwd);
  const prompt = normalizeRequiredString(request?.prompt, 'prompt');
  const title = normalizeOptionalString(request?.title, 'title');
  const startPointBranch = normalizeOptionalBranchName(
    request?.startPointBranch,
    'startPointBranch'
  );
  assertGitCommitRefExists(projectRoot, startPointBranch, 'startPointBranch');
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

  const branchName = normalizeRequiredBranchName(
    value.branchName,
    'existingWorktree.branchName'
  );
  const worktreePath = resolveProjectContainedPath(
    projectRoot,
    normalizeRequiredString(value.worktreePath, 'existingWorktree.worktreePath'),
    'existingWorktree.worktreePath'
  );
  assertExistingWorktreeBranch(projectRoot, worktreePath, branchName);

  return {
    slug: normalizeRequiredString(value.slug, 'existingWorktree.slug'),
    worktreePath,
    branchName,
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
    branchName: validateBranchName(branchName, `mergeTargetChain[${index}].branchName`),
    displayName,
    slug,
    worktreePath: worktreePath
      ? resolveProjectContainedPath(
          projectRoot,
          worktreePath,
          `mergeTargetChain[${index}].worktreePath`
        )
      : undefined,
  };
}

function cloneMergeTargetChain(
  mergeTargetChain: MergeTargetReference[] | undefined
): MergeTargetReference[] | undefined {
  return mergeTargetChain?.map((target) => ({ ...target }));
}

function resolveScopedCwd(projectRoot: string, cwd: OrchestrationTaskRequest['cwd']): string {
  const rawCwd = normalizeOptionalString(cwd, 'cwd');
  return rawCwd ? resolveProjectContainedPath(projectRoot, rawCwd, 'cwd') : projectRoot;
}

function normalizeProjectRoot(value: OrchestrationTaskRequest['projectRoot']): string {
  const projectRoot = path.resolve(normalizeRequiredString(value, 'projectRoot'));
  return resolveExistingDirectoryPath(projectRoot, 'projectRoot');
}

function resolveProjectContainedPath(
  projectRoot: string,
  relativeOrAbsolutePath: string,
  fieldName: string
): string {
  const resolvedPath = path.resolve(projectRoot, relativeOrAbsolutePath);
  const canonicalPath = resolveExistingDirectoryPath(resolvedPath, fieldName);
  assertProjectContainedPath(projectRoot, canonicalPath, fieldName);
  return canonicalPath;
}

function assertProjectContainedPath(
  projectRoot: string,
  resolvedPath: string,
  fieldName: string
): void {
  if (!isPathInsideOrEqual(projectRoot, resolvedPath)) {
    throw new OrchestrationError(
      'project_scope_violation',
      `${fieldName} "${resolvedPath}" resolves outside the project root`
    );
  }
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveExistingPath(targetPath: string, fieldName: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new OrchestrationError(
        'invalid_orchestration_request',
        `${fieldName} "${targetPath}" does not exist`
      );
    }
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} "${targetPath}" could not be resolved`
    );
  }
}

function resolveExistingDirectoryPath(targetPath: string, fieldName: string): string {
  const canonicalPath = resolveExistingPath(targetPath, fieldName);
  assertDirectoryPath(canonicalPath, fieldName);
  return canonicalPath;
}

function assertDirectoryPath(targetPath: string, fieldName: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(targetPath);
  } catch (error) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} "${targetPath}" could not be inspected`,
      error
    );
  }

  if (stats.isDirectory()) {
    return;
  }

  const receivedType = stats.isFile() ? 'a file' : 'a non-directory path';
  throw new OrchestrationError(
    'invalid_orchestration_request',
    `${fieldName} "${targetPath}" must be a directory, not ${receivedType}`
  );
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
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

function normalizeRequiredBranchName(value: unknown, fieldName: string): string {
  return validateBranchName(normalizeRequiredString(value, fieldName), fieldName);
}

function normalizeOptionalBranchName(value: unknown, fieldName: string): string | undefined {
  const branchName = normalizeOptionalString(value, fieldName);
  return branchName ? validateBranchName(branchName, fieldName) : undefined;
}

function validateBranchName(branchName: string, fieldName: string): string {
  if (!isValidBranchName(branchName) || !isGitBranchName(branchName)) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} must be a valid git branch name`
    );
  }
  return branchName;
}

function isGitBranchName(branchName: string): boolean {
  try {
    execFileSync('git', ['check-ref-format', '--branch', branchName], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function assertGitCommitRefExists(
  projectRoot: string,
  refName: string | undefined,
  fieldName: string
): void {
  if (!refName) {
    return;
  }

  try {
    execFileSync(
      'git',
      ['-C', projectRoot, 'rev-parse', '--verify', '--end-of-options', `${refName}^{commit}`],
      { stdio: 'ignore' }
    );
  } catch (error) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `${fieldName} "${refName}" does not exist in projectRoot`,
      error
    );
  }
}

function assertExistingWorktreeBranch(
  projectRoot: string,
  worktreePath: string,
  branchName: string
): void {
  if (!getCanonicalGitWorktreePaths(projectRoot).has(worktreePath)) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `existingWorktree.worktreePath "${worktreePath}" is not a git worktree in projectRoot`
    );
  }

  const checkedOutBranch = getGitWorktreeBranch(worktreePath, branchName);
  if (checkedOutBranch !== branchName) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `existingWorktree.branchName "${branchName}" does not match checked out branch "${checkedOutBranch}" at "${worktreePath}"`
    );
  }
}

function getCanonicalGitWorktreePaths(projectRoot: string): Set<string> {
  let rawOutput: string;
  try {
    rawOutput = execFileSync(
      'git',
      ['-C', projectRoot, 'worktree', 'list', '--porcelain'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
  } catch (error) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `projectRoot "${projectRoot}" is not a git repository`,
      error
    );
  }

  const worktreePaths = new Set<string>();
  for (const line of rawOutput.split('\n')) {
    if (!line.startsWith('worktree ')) {
      continue;
    }

    const listedPath = line.slice('worktree '.length).trim();
    if (!listedPath) {
      continue;
    }

    try {
      worktreePaths.add(fs.realpathSync.native(listedPath));
    } catch {
      worktreePaths.add(path.resolve(listedPath));
    }
  }

  return worktreePaths;
}

function getGitWorktreeBranch(worktreePath: string, expectedBranchName: string): string {
  try {
    return execFileSync(
      'git',
      ['-C', worktreePath, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();
  } catch (error) {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      `existingWorktree.worktreePath "${worktreePath}" is detached or not a git worktree for branch "${expectedBranchName}"`,
      error
    );
  }
}

function normalizeRequestTraceId(value: unknown, taskId: string): string {
  if (value === undefined) return taskId;
  if (typeof value !== 'string') {
    throw new OrchestrationError(
      'invalid_orchestration_request',
      'traceId must be a string when provided'
    );
  }

  return value.trim() || taskId;
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
