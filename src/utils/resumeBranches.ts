import { exec, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import path from 'path';
import type { PsychePane } from '../types.js';
import type { AgentName } from './agentLaunch.js';
import { triggerHook } from './hooks.js';
import { getOrphanedWorktrees, isValidBranchName } from './git.js';
import { createPane } from './paneCreation.js';
import { shellQuote } from './promptStore.js';
import { SettingsManager } from './settingsManager.js';
import { writeWorktreeMetadata } from './worktreeMetadata.js';
import { derivePaneSlug } from './slug.js';
import { acquireProjectWorktreeLifecycleLease } from '../services/WorktreeOperationLease.js';
import {
  runGitMutationWithSupervisor,
  type GitMutationSupervisorLease,
} from '../services/GitMutationSupervisor.js';

const REMOTE_FALLBACK = 'origin';
const RESUME_SCAN_EXCLUDED_DIRS = new Set([
  '.psyche',
  '.git',
  'node_modules',
  'vendor',
  '.pnpm',
  '.next',
  'dist',
  'build',
  'coverage',
]);

export interface ResumableBranchCandidate {
  branchName: string;
  slug?: string;
  path?: string;
  lastModified?: Date;
  hasUncommittedChanges: boolean;
  hasWorktree: boolean;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
  isRemote: boolean;
}

interface ResumableBranchRecord extends ResumableBranchCandidate {
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
}

interface WorkspaceRepoState {
  repoPath: string;
  relativePath: string;
  remoteName: string;
  hasLocalBranch: boolean;
  hasRemoteBranch: boolean;
}

export interface ResumeBranchWorkspaceOptions {
  branchName: string;
  agent: AgentName;
  projectRoot: string;
  existingPanes: PsychePane[];
  sessionConfigPath?: string;
  sessionProjectRoot?: string;
  persistReusedPane: (pane: PsychePane) => Promise<void>;
}

export interface ResumableBranchScanOptions {
  includeRemoteBranches?: boolean;
}

function runGitText(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): string {
  const command = `git ${args.map((arg) => shellQuote(arg)).join(' ')}`;

  try {
    return execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch (error) {
    if (options.silent) {
      return '';
    }
    throw error;
  }
}

async function runGitTextAsync(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): Promise<string> {
  const command = `git ${args.map((arg) => shellQuote(arg)).join(' ')}`;

  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          if (options.silent) {
            resolve('');
            return;
          }
          reject(error);
          return;
        }

        resolve(stdout.trim());
      }
    );
  });
}

function runGit(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): void {
  const command = `git ${args.map((arg) => shellQuote(arg)).join(' ')}`;

  try {
    execSync(command, {
      cwd,
      stdio: 'pipe',
    });
  } catch (error) {
    if (!options.silent) {
      throw error;
    }
  }
}

async function runGitAsync(
  cwd: string,
  args: string[],
  options: { silent?: boolean } = {}
): Promise<void> {
  await runGitTextAsync(cwd, args, options);
}

async function runGitMutationAsync(
  cwd: string,
  args: string[],
  leases: readonly GitMutationSupervisorLease[],
  options: { silent?: boolean } = {},
): Promise<void> {
  try {
    const result = await runGitMutationWithSupervisor({ cwd, args, leases });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr
          || `git ${args.join(' ')} failed with exit code ${result.exitCode ?? 'unknown'}`,
      );
    }
  } catch (error) {
    if (options.silent) {
      return;
    }
    throw error;
  }
}

function isGitRepoRoot(dirPath: string): boolean {
  const gitPath = path.join(dirPath, '.git');
  if (!fs.existsSync(gitPath)) {
    return false;
  }

  try {
    return fs.statSync(gitPath).isDirectory() || fs.statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

function discoverWorkspaceRepos(projectRoot: string): string[] {
  const discovered = new Set<string>([projectRoot]);

  const walk = (dirPath: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (RESUME_SCAN_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);
      if (isGitRepoRoot(fullPath)) {
        discovered.add(fullPath);
      }

      walk(fullPath);
    }
  };

  walk(projectRoot);

  return Array.from(discovered).sort((left, right) => left.length - right.length);
}

function listLocalBranches(repoPath: string): Set<string> {
  const output = runGitText(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function getCurrentBranchName(repoPath: string): string {
  return runGitText(repoPath, ['branch', '--show-current'], { silent: true }) || 'main';
}

function getPreferredRemoteName(repoPath: string): string {
  const upstream = runGitText(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { silent: true }
  );
  if (upstream.includes('/')) {
    return upstream.split('/')[0];
  }

  const currentBranch = getCurrentBranchName(repoPath);
  if (currentBranch && currentBranch !== 'HEAD') {
    const configuredRemote = runGitText(
      repoPath,
      ['config', `branch.${currentBranch}.remote`],
      { silent: true }
    );
    if (configuredRemote) {
      return configuredRemote;
    }
  }

  return REMOTE_FALLBACK;
}

function listRemoteBranches(repoPath: string, remoteName: string): Set<string> {
  const output = runGitText(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== `${remoteName}/HEAD`)
      .map((line) => (
        line.startsWith(`${remoteName}/`) ? line.slice(remoteName.length + 1) : line
      ))
      .filter(Boolean)
  );
}

function fetchRemoteBranches(repoPath: string, remoteName: string): void {
  runGit(
    repoPath,
    ['fetch', '--prune', remoteName],
    { silent: true }
  );
}

function compareCandidates(
  left: ResumableBranchCandidate,
  right: ResumableBranchCandidate
): number {
  if (left.path && right.path) {
    const leftTime = left.lastModified?.getTime() ?? 0;
    const rightTime = right.lastModified?.getTime() ?? 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
  } else if (left.path) {
    return -1;
  } else if (right.path) {
    return 1;
  }

  return left.branchName.localeCompare(right.branchName);
}

export function getResumableBranches(
  projectRoot: string,
  activePaneSlugs: string[],
  options: ResumableBranchScanOptions = {}
): ResumableBranchCandidate[] {
  const includeRemoteBranches = options.includeRemoteBranches ?? true;
  const candidates = new Map<string, ResumableBranchRecord>();

  for (const worktree of getOrphanedWorktrees(projectRoot, activePaneSlugs)) {
    candidates.set(worktree.branch, {
      branchName: worktree.branch,
      slug: worktree.slug,
      path: worktree.path,
      lastModified: worktree.lastModified,
      hasUncommittedChanges: worktree.hasUncommittedChanges,
      hasWorktree: true,
      isRemote: false,
      hasLocalBranch: true,
      hasRemoteBranch: false,
    });
  }

  for (const repoPath of discoverWorkspaceRepos(projectRoot)) {
    const localBranches = listLocalBranches(repoPath);
    let remoteBranches = new Set<string>();
    if (includeRemoteBranches) {
      const remoteName = getPreferredRemoteName(repoPath);
      fetchRemoteBranches(repoPath, remoteName);
      remoteBranches = listRemoteBranches(repoPath, remoteName);
    }
    const branchNames = new Set<string>([
      ...Array.from(localBranches),
      ...Array.from(remoteBranches),
    ]);

    for (const branchName of branchNames) {
      const existing = candidates.get(branchName);
      if (existing) {
        existing.hasWorktree ||= false;
        existing.hasLocalBranch ||= localBranches.has(branchName);
        existing.hasRemoteBranch ||= remoteBranches.has(branchName);
        continue;
      }

      candidates.set(branchName, {
        branchName,
        hasUncommittedChanges: false,
        hasWorktree: false,
        isRemote: false,
        hasLocalBranch: localBranches.has(branchName),
        hasRemoteBranch: remoteBranches.has(branchName),
      });
    }
  }

  return Array.from(candidates.values())
    .map((candidate) => ({
      branchName: candidate.branchName,
      slug: candidate.slug,
      path: candidate.path,
      lastModified: candidate.lastModified,
      hasUncommittedChanges: candidate.hasUncommittedChanges,
      hasWorktree: candidate.hasWorktree,
      hasLocalBranch: candidate.hasLocalBranch,
      hasRemoteBranch: candidate.hasRemoteBranch,
      isRemote: !candidate.hasWorktree && !candidate.hasLocalBranch && candidate.hasRemoteBranch,
    }))
    .sort(compareCandidates);
}

async function getWorkspaceBranchStatesAsync(
  projectRoot: string,
  branchName: string
): Promise<WorkspaceRepoState[]> {
  const repoStates: WorkspaceRepoState[] = [];

  for (const repoPath of discoverWorkspaceRepos(projectRoot)) {
    const remoteName = await getPreferredRemoteNameAsync(repoPath);
    const localBranches = await listLocalBranchesAsync(repoPath);
    const remoteBranches = await listRemoteBranchesAsync(repoPath, remoteName);

    repoStates.push({
      repoPath,
      relativePath: repoPath === projectRoot ? '' : path.relative(projectRoot, repoPath),
      remoteName,
      hasLocalBranch: localBranches.has(branchName),
      hasRemoteBranch: remoteBranches.has(branchName),
    });
  }

  return repoStates;
}

async function refreshRemoteBranchStateAsync(
  state: WorkspaceRepoState,
  branchName: string,
  leases: readonly GitMutationSupervisorLease[],
): Promise<void> {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  await runGitMutationAsync(
    state.repoPath,
    ['fetch', '--prune', state.remoteName],
    leases,
    { silent: true }
  );

  state.hasRemoteBranch = (
    await listRemoteBranchesAsync(state.repoPath, state.remoteName)
  ).has(branchName);
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

function hasReusableWorktreeForBranch(
  worktreeRootPath: string,
  branchName: string
): boolean {
  const rootGitPath = path.join(worktreeRootPath, '.git');
  if (fs.existsSync(rootGitPath)) {
    return getCurrentBranchName(worktreeRootPath) === branchName;
  }

  const stack = [worktreeRootPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (RESUME_SCAN_EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentPath, entry.name);
      const gitPath = path.join(fullPath, '.git');
      if (fs.existsSync(gitPath)) {
        try {
          const gitStat = fs.statSync(gitPath);
          if (gitStat.isFile() && getCurrentBranchName(fullPath) === branchName) {
            return true;
          }
        } catch {
          // Ignore unreadable nested worktrees and keep scanning.
        }
      }

      stack.push(fullPath);
    }
  }

  return false;
}

function getAvailableSlug(
  branchName: string,
  projectRoot: string,
  existingPanes: PsychePane[]
): string {
  const worktreesDir = path.join(projectRoot, '.psyche', 'worktrees');
  const reserved = new Set(existingPanes.map((pane) => pane.slug));
  const baseSlug = derivePaneSlug(branchName, 'branch');
  let candidate = baseSlug;
  let attempt = 0;

  while (
    reserved.has(candidate)
    || (
      fs.existsSync(path.join(worktreesDir, candidate))
      && !hasReusableWorktreeForBranch(path.join(worktreesDir, candidate), branchName)
    )
  ) {
    attempt += 1;
    const hashSuffix = shortHash(`${branchName}:${attempt}`);
    candidate = `${baseSlug}-${hashSuffix}`;
  }

  return candidate;
}

async function getBranchUpstreamAsync(repoPath: string, branchName: string): Promise<string> {
  return runGitTextAsync(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branchName}@{upstream}`],
    { silent: true }
  );
}

async function getBranchDivergenceAsync(
  repoPath: string,
  localRef: string,
  remoteRef: string
): Promise<{ ahead: number; behind: number }> {
  const output = await runGitTextAsync(
    repoPath,
    ['rev-list', '--left-right', '--count', `${localRef}...${remoteRef}`],
    { silent: true }
  );
  const [aheadText = '0', behindText = '0'] = output.split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10);
  const behind = Number.parseInt(behindText, 10);

  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

async function getCheckedOutWorktreePathAsync(
  repoPath: string,
  branchName: string
): Promise<string | null> {
  const output = await runGitTextAsync(
    repoPath,
    ['worktree', 'list', '--porcelain'],
    { silent: true }
  );
  if (!output) {
    return null;
  }

  let currentWorktree: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktree = line.slice('worktree '.length).trim();
      continue;
    }

    if (line === `branch refs/heads/${branchName}`) {
      return currentWorktree;
    }

    if (!line.trim()) {
      currentWorktree = null;
    }
  }

  return null;
}

async function ensureLocalBranchAsync(
  state: WorkspaceRepoState,
  branchName: string,
  worktreePath: string,
  leases: readonly GitMutationSupervisorLease[],
): Promise<void> {
  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }

  await refreshRemoteBranchStateAsync(state, branchName, leases);
  state.hasLocalBranch = (await listLocalBranchesAsync(state.repoPath)).has(branchName);

  if (state.hasRemoteBranch) {
    const remoteRef = `${state.remoteName}/${branchName}`;

    if (state.hasLocalBranch) {
      const upstream = await getBranchUpstreamAsync(state.repoPath, branchName);
      if (upstream !== remoteRef) {
        await runGitMutationAsync(
          state.repoPath,
          ['branch', `--set-upstream-to=${remoteRef}`, branchName],
          leases,
          { silent: true }
        );
      }

      const { ahead, behind } = await getBranchDivergenceAsync(
        state.repoPath,
        branchName,
        remoteRef
      );
      if (behind > 0 && ahead === 0) {
        const checkedOutWorktreePath = await getCheckedOutWorktreePathAsync(
          state.repoPath,
          branchName
        );
        if (checkedOutWorktreePath) {
          if (path.resolve(checkedOutWorktreePath) === path.resolve(worktreePath)) {
            return;
          }

          const repoLabel = state.relativePath || '.';
          throw new Error(
            `Branch ${branchName} in ${repoLabel} is already checked out at ${checkedOutWorktreePath}; reopen that worktree instead of recreating it.`
          );
        }

        await runGitMutationAsync(
          state.repoPath,
          ['branch', '-f', branchName, remoteRef],
          leases,
        );
      } else if (ahead > 0 && behind > 0) {
        const repoLabel = state.relativePath || '.';
        throw new Error(
          `Branch ${branchName} in ${repoLabel} has diverged from ${remoteRef}; refusing to overwrite local commits while opening the workspace.`
        );
      }

      return;
    }

    await runGitMutationAsync(
      state.repoPath,
      ['branch', '--track', branchName, remoteRef],
      leases,
    );
    state.hasLocalBranch = true;
    return;
  }

  if (state.hasLocalBranch) {
    return;
  }

  const defaultBranch = await getMainBranchForRepoAsync(state.repoPath);
  await runGitMutationAsync(
    state.repoPath,
    ['branch', branchName, defaultBranch],
    leases,
  );
  state.hasLocalBranch = true;
}

async function getMainBranchForRepoAsync(repoPath: string): Promise<string> {
  const originHead = await runGitTextAsync(
    repoPath,
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { silent: true }
  );
  if (originHead.startsWith('refs/remotes/origin/')) {
    return originHead.slice('refs/remotes/origin/'.length);
  }

  try {
    await runGitAsync(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/main']);
    return 'main';
  } catch {
    // Continue to master fallback.
  }

  try {
    await runGitAsync(repoPath, ['show-ref', '--verify', '--quiet', 'refs/heads/master']);
    return 'master';
  } catch {
    return (await getCurrentBranchNameAsync(repoPath)) || 'main';
  }
}

async function createWorktreeAsync(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  leases: readonly GitMutationSupervisorLease[],
): Promise<void> {
  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    return;
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await runGitMutationAsync(
    repoPath,
    ['worktree', 'add', worktreePath, branchName],
    leases,
  );
}

async function listLocalBranchesAsync(repoPath: string): Promise<Set<string>> {
  const output = await runGitTextAsync(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

async function getCurrentBranchNameAsync(repoPath: string): Promise<string> {
  return (await runGitTextAsync(
    repoPath,
    ['branch', '--show-current'],
    { silent: true }
  )) || 'main';
}

async function getPreferredRemoteNameAsync(repoPath: string): Promise<string> {
  const upstream = await runGitTextAsync(
    repoPath,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { silent: true }
  );
  if (upstream.includes('/')) {
    return upstream.split('/')[0];
  }

  const currentBranch = await getCurrentBranchNameAsync(repoPath);
  if (currentBranch && currentBranch !== 'HEAD') {
    const configuredRemote = await runGitTextAsync(
      repoPath,
      ['config', `branch.${currentBranch}.remote`],
      { silent: true }
    );
    if (configuredRemote) {
      return configuredRemote;
    }
  }

  return REMOTE_FALLBACK;
}

async function listRemoteBranchesAsync(
  repoPath: string,
  remoteName: string
): Promise<Set<string>> {
  const output = await runGitTextAsync(
    repoPath,
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    { silent: true }
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== `${remoteName}/HEAD`)
      .map((line) => (
        line.startsWith(`${remoteName}/`) ? line.slice(remoteName.length + 1) : line
      ))
      .filter(Boolean)
  );
}

async function triggerChildWorktreeHook(
  projectRoot: string,
  branchName: string,
  slug: string,
  worktreePath: string,
  agent: AgentName
): Promise<void> {
  await triggerHook('worktree_created', projectRoot, undefined, {
    PSYCHE_SLUG: slug,
    PSYCHE_PROMPT: 'No initial prompt',
    PSYCHE_AGENT: agent,
    PSYCHE_WORKTREE_PATH: worktreePath,
    PSYCHE_BRANCH: branchName,
  });
}

export async function resumeBranchWorkspace(
  options: ResumeBranchWorkspaceOptions
): Promise<{ pane: PsychePane }> {
  const {
    branchName,
    agent,
    projectRoot,
    existingPanes,
    sessionConfigPath,
    sessionProjectRoot,
    persistReusedPane,
  } = options;

  if (!agent) {
    throw new Error(`An agent must be selected before opening ${branchName}`);
  }

  // This lease spans every workspace repository, including nested child
  // worktrees. It is intentionally acquired before branch creation and held
  // through createPane's durable registry write so cleanup cannot interleave
  // between a resumed root/child worktree and its pane record.
  const lifecycleLease = await acquireProjectWorktreeLifecycleLease({
    projectRoot,
    operation: 'resume',
  });
  const mutationLeases: GitMutationSupervisorLease[] = [{
    lockDir: lifecycleLease.lockDir,
    leaseNonce: lifecycleLease.nonce,
    preparePendingGitMutation: lifecycleLease.preparePendingGitMutation,
  }];
  try {
    const workspaceStates = await getWorkspaceBranchStatesAsync(projectRoot, branchName);
    const slug = getAvailableSlug(branchName, projectRoot, existingPanes);
    const rootWorktreePath = path.join(projectRoot, '.psyche', 'worktrees', slug);
    const settings = new SettingsManager(projectRoot).getSettings();

    for (const state of workspaceStates) {
      const worktreePath = state.relativePath
        ? path.join(rootWorktreePath, state.relativePath)
        : rootWorktreePath;
      await ensureLocalBranchAsync(
        state,
        branchName,
        worktreePath,
        mutationLeases,
      );
    }

    for (const state of workspaceStates) {
      const worktreePath = state.relativePath
        ? path.join(rootWorktreePath, state.relativePath)
        : rootWorktreePath;
      await createWorktreeAsync(
        state.repoPath,
        worktreePath,
        branchName,
        mutationLeases,
      );
      writeWorktreeMetadata(worktreePath, {
        ...(agent && !state.relativePath ? { agent } : {}),
        permissionMode: state.relativePath ? undefined : settings.permissionMode,
        branchName: branchName !== slug ? branchName : undefined,
      });
    }

    const creation = await createPane(
      {
        prompt: '',
        agent,
        existingWorktree: {
          slug,
          worktreePath: rootWorktreePath,
          branchName,
        },
        projectName: path.basename(projectRoot),
        existingPanes,
        projectRoot,
        sessionConfigPath,
        sessionProjectRoot,
        persistReusedPane,
        projectLifecycleLease: lifecycleLease,
      },
      [agent]
    );

    if (creation.needsAgentChoice) {
      throw new Error('Agent selection is required to resume this branch');
    }

    for (const state of workspaceStates) {
      if (!state.relativePath) {
        continue;
      }
      await triggerChildWorktreeHook(
        state.repoPath,
        branchName,
        slug,
        path.join(rootWorktreePath, state.relativePath),
        agent
      );
    }

    return {
      pane: creation.pane,
    };
  } finally {
    await lifecycleLease.release();
  }
}
