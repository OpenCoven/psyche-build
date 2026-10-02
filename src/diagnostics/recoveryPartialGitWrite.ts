/**
 * Partial Git write for the #199 recovery harness (#475 gate 2).
 *
 * `interrupted-git-mutation` kills the cleanup owner between handing off to Git
 * and Git answering. This module puts the fault *inside* Git's own write:
 * each disposable worktree carries a committed `locked/` directory made
 * read-only before removal. `git worktree remove` passes its cleanliness check
 * (permissions are not content), starts deleting, unlinks `locked/sub/payload`
 * (its own directory is writable), then fails to unlink `locked/sub` and
 * `locked/keep` because their parent is read-only. Git then deletes the
 * registration anyway and exits non-zero. Nothing is timed and Git is never
 * replaced or simulated: the fault is a filesystem permission, and Git's own
 * code is what writes partway and stops.
 *
 * Two worktrees cover both ways the product meets that state:
 *
 *   - `control` is removed by the real cleanup queue, so the product observes
 *     its own supervised Git failing mid-write;
 *   - `retained` is removed by a bare `git worktree remove` standing in for an
 *     owner that died before it could look. The real queue meets it on its
 *     next cleanup attempt.
 *
 * Before the retries the read-only directories are made writable again, so a
 * product that "reconciled" by deleting what remained would succeed and fail
 * the preservation invariant instead of being stopped by the injected fault.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';

import {
  assertRecoveryCleanupEnvironment,
  awaitCleanupQuiescence,
  cleanupWorker,
} from './recoveryCleanup.js';
import { listWorktreeRecoveryMarkers } from '../services/WorktreeRecoveryMarker.js';

export interface PartialGitWriteObservation {
  /**
   * Positive control: in both worktrees Git deleted part of the tree, failed,
   * and left the directory behind. False means the fault never landed inside
   * Git's write (for example under root, where a read-only directory does not
   * stop deletion), so nothing else here was exercised.
   */
  readonly partialWriteLanded: boolean;
  /** The product's own failed removal published recovery_required. */
  readonly flaggedByFailedRemoval: boolean;
  /** A later cleanup attempt published recovery_required for the other one. */
  readonly detectedOnNextAttempt: boolean;
  /** Each marker names exactly its half-removed worktree. */
  readonly markersNameWorktrees: boolean;
  readonly markersCarryInstructions: boolean;
  /** A retry behind the marker was refused and published no second marker. */
  readonly retryBlockedByMarker: boolean;
  /** Every file Git left behind is byte-identical after every retry. */
  readonly remainingFilesPreserved: boolean;
  /** Neither branch was deleted or moved. */
  readonly branchesUnchanged: boolean;
}

const WORKTREES = ['control', 'retained'] as const;
type WorktreeName = (typeof WORKTREES)[number];

/** The caller owns `projectRoot`. Read-only directories are restored before return. */
export async function observePartialGitWrite(
  projectRoot: string,
): Promise<PartialGitWriteObservation> {
  assertRecoveryCleanupEnvironment(process.env);
  const home = path.join(projectRoot, 'home');
  const tmux = path.join(projectRoot, 'tmux');
  await mkdir(home);
  await mkdir(tmux);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    TMUX: '',
    TMUX_TMPDIR: tmux,
  };
  const run = (cwd: string, args: string[]): { ok: boolean; output: string } => {
    try {
      const output = execFileSync('git', args, {
        cwd, env, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 64 * 1024,
      });
      return { ok: true, output: output.trim() };
    } catch {
      return { ok: false, output: '' };
    }
  };
  const git = (cwd: string, ...args: string[]): string => {
    const result = run(cwd, args);
    if (!result.ok) throw new Error('Partial Git write fixture Git command failed');
    return result.output;
  };
  const commit = ['-c', 'user.name=Recovery Harness', '-c', 'user.email=recovery@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet'];

  git(projectRoot, 'init', '--quiet');
  git(projectRoot, ...commit, '--allow-empty', '-m', 'fixture');

  const worktreePath = (name: WorktreeName) => path.join(projectRoot, '.psyche', 'worktrees', name);
  const lockedDir = (name: WorktreeName) => path.join(worktreePath(name), 'locked');
  const payload = (name: WorktreeName) => path.join(lockedDir(name), 'sub', 'payload.txt');
  const survivor = (name: WorktreeName) => path.join(lockedDir(name), 'keep.txt');
  const branchBefore = new Map<WorktreeName, string>();
  const survivorBefore = new Map<WorktreeName, Buffer>();

  for (const name of WORKTREES) {
    const worktree = worktreePath(name);
    git(projectRoot, 'worktree', 'add', '--quiet', '-b', name, worktree);
    await mkdir(path.join(lockedDir(name), 'sub'), { recursive: true });
    await writeFile(path.join(worktree, 'readme.txt'), 'deletable\n');
    await writeFile(payload(name), 'deleted by Git before it fails\n');
    const keep = Buffer.from(`only remaining copy in ${name}\n`);
    await writeFile(survivor(name), keep);
    survivorBefore.set(name, keep);
    git(worktree, 'add', '--all');
    git(worktree, ...commit, '-m', `files for ${name}`);
    branchBefore.set(name, git(projectRoot, 'rev-parse', `refs/heads/${name}`));
  }

  const restoreWritable = async () => {
    for (const name of WORKTREES) {
      if (existsSync(lockedDir(name))) await chmod(lockedDir(name), 0o700);
    }
  };

  try {
    for (const name of WORKTREES) await chmod(lockedDir(name), 0o500);

    // An owner that died before it could inspect what Git left: the fixture runs
    // Git itself and the product only meets the result on its next attempt.
    const bareRemoval = run(projectRoot, ['worktree', 'remove', worktreePath('retained')]);

    // The product's own supervised removal of the other worktree.
    const first = cleanupWorker(projectRoot, 'control', env);
    let firstFinished = false;
    try {
      const exit = await first.done;
      firstFinished = exit.code === 0 && exit.finished;
    } finally {
      await first.stop();
    }

    const landed = (name: WorktreeName) => existsSync(worktreePath(name))
      && existsSync(survivor(name))
      && !existsSync(payload(name));
    const partialWriteLanded = !bareRemoval.ok && landed('retained') && landed('control');

    const readMarkers = () => listWorktreeRecoveryMarkers(projectRoot);
    const afterFirst = await readMarkers();
    const flaggedByFailedRemoval = firstFinished
      && afterFirst.length === 1
      && afterFirst[0]?.worktreePath === worktreePath('control');

    // From here on nothing stops a deletion except the product's own decision.
    await restoreWritable();

    const next = cleanupWorker(projectRoot, 'retained', env);
    let nextFinished = false;
    try {
      const exit = await next.done;
      nextFinished = exit.code === 0 && exit.finished;
    } finally {
      await next.stop();
    }
    const afterNext = await readMarkers();
    const detectedOnNextAttempt = nextFinished
      && afterNext.length === 2
      && afterNext.some((marker) => marker.worktreePath === worktreePath('retained'));

    const retry = cleanupWorker(projectRoot, 'control', env);
    let retryBlocked = false;
    try {
      const exit = await retry.done;
      retryBlocked = exit.code === 0 && exit.finished && exit.markerBlocked;
    } finally {
      await retry.stop();
    }
    await awaitCleanupQuiescence(projectRoot);
    const afterRetry = await readMarkers();

    const expectedPaths = new Set(WORKTREES.map(worktreePath));
    const markersNameWorktrees = afterRetry.length === 2
      && afterRetry.every((marker) => expectedPaths.has(marker.worktreePath)
        && marker.projectRoot === projectRoot
        && marker.operation === 'cleanup')
      && new Set(afterRetry.map((marker) => marker.worktreePath)).size === 2;
    const markersCarryInstructions = afterRetry.length === 2
      && afterRetry.every((marker) => marker.operatorInstructions.includes(marker.id)
        && marker.reason.includes('partially removed'));

    let remainingFilesPreserved = true;
    for (const name of WORKTREES) {
      const bytes = existsSync(survivor(name)) ? await readFile(survivor(name)) : undefined;
      remainingFilesPreserved &&= bytes?.equals(survivorBefore.get(name)!) === true;
    }
    const branchesUnchanged = WORKTREES.every((name) => (
      git(projectRoot, 'for-each-ref', '--format=%(objectname)', `refs/heads/${name}`)
        === branchBefore.get(name)
    ));

    return {
      partialWriteLanded,
      flaggedByFailedRemoval,
      detectedOnNextAttempt,
      markersNameWorktrees,
      markersCarryInstructions,
      retryBlockedByMarker: retryBlocked && afterRetry.length === 2,
      remainingFilesPreserved,
      branchesUnchanged,
    };
  } finally {
    // A read-only directory would make the caller's disposal fail.
    await restoreWritable();
  }
}
