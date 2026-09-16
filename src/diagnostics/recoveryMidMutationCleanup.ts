/**
 * Mid-mutation cleanup interruption for the #199 recovery harness.
 *
 * The existing `interrupted-cleanup-owner` scenario terminates the real
 * cleanup queue *before* any Git mutation can begin, which is the safe
 * boundary. This module terminates it at the dangerous one: after the Git
 * mutation supervisor has claimed every participating lease, recorded its
 * pending mutation, and handed a live Git process group its PID, but before
 * Git reports a result.
 *
 * What "mid-flight" means here, stated exactly so a passing run cannot be read
 * as more than it is: the product has completed its half of the handoff and is
 * waiting on Git. A shim on `PATH` holds the destructive `git worktree remove`
 * at its first instruction so that window can be hit deterministically, then
 * execs the real Git binary. Git itself is never replaced or simulated, and no
 * product code is mocked. This does not prove interruption *after* Git has
 * begun writing to the object store or the worktree administrative files;
 * that needs a fault injected inside Git, not around it.
 *
 * When the interrupted mutation cannot be confirmed finished, the observation
 * asks its caller to retain the disposable workspace instead of deleting it:
 * a live Git process may still be operating inside, and deleting it would both
 * destroy the evidence and pull the ground out from under that process. This
 * mirrors `RecoveryCleanupRetentionError` in the pre-Git scenario.
 *
 * The invariant that matters is that the worktree never ends up half-removed:
 * either it is gone and Git no longer lists it, or it is present and Git still
 * lists it. A directory removed while the registration survives — or the
 * reverse — is the state that silently loses a user's only copy of work.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertRecoveryCleanupEnvironment,
  awaitCleanupQuiescence,
  cleanupWorker,
} from './recoveryCleanup.js';
import {
  acquireProjectWorktreeLifecycleLease,
} from '../services/WorktreeOperationLease.js';

/** Bounded wait for the shim to report the supervised mutation is live. */
const MUTATION_START_TIMEOUT_MS = 20_000;
const MUTATION_POLL_INTERVAL_MS = 20;
/** The supervisor terminates with SIGTERM then SIGKILL, each bounded at 2s. */
const ORPHAN_EXIT_TIMEOUT_MS = 10_000;

export interface MidMutationCleanupObservation {
  /**
   * Positive control on the injection. False means the supervised Git mutation
   * never became live, so the owner was not killed mid-flight and the
   * remaining fields describe some other boundary.
   */
  readonly mutationObservedInFlight: boolean;
  /** The owner died by signal rather than completing its queue. */
  readonly ownerKilledDuringMutation: boolean;
  /**
   * The worktree is either fully removed and unregistered, or fully present
   * and still registered. A half-removed worktree fails this.
   */
  readonly worktreeStateSelfConsistent: boolean;
  /** No Git process from the interrupted mutation outlived the interruption. */
  readonly mutationLeftNoOrphan: boolean;
  /** A contender can take the project lifecycle lease once the queue is idle. */
  readonly projectLeaseRecovered: boolean;
  /** The branch the interrupted worktree pointed at is unchanged. */
  readonly branchUnchanged: boolean;
  /** The only copy of uncommitted work in the main project is byte-identical. */
  readonly workPreserved: boolean;
  /**
   * The interrupted mutation could not be confirmed finished, so the caller
   * must retain the workspace rather than delete it. A Git process may still
   * be operating inside it, and the unsafe state is itself the evidence a
   * diagnosis would need.
   */
  readonly retentionRequired: boolean;
}

/**
 * Builds a disposable repository, lets the real cleanup queue reach its
 * destructive Git mutation, kills the owner there, and reports what survived.
 * The caller owns `projectRoot`.
 */
export async function observeMidMutationCleanup(
  projectRoot: string,
): Promise<MidMutationCleanupObservation> {
  assertRecoveryCleanupEnvironment(process.env);

  const home = path.join(projectRoot, 'home');
  const tmux = path.join(projectRoot, 'tmux');
  const shimDir = path.join(projectRoot, 'shim');
  await mkdir(home);
  await mkdir(tmux);
  await mkdir(shimDir);

  const startedMarker = path.join(projectRoot, 'mutation-started');
  const releaseMarker = path.join(projectRoot, 'mutation-release');
  await writeGitShim({ shimDir, startedMarker, releaseMarker });

  const env: NodeJS.ProcessEnv = {
    // The shim must win resolution for the supervised mutation, which the
    // supervisor launches as `exec git` through `/bin/sh`.
    PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
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

  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: projectRoot,
        // Fixture setup uses the real binary directly; only the cleanup queue
        // runs through the shim.
        env: { ...env, PATH: process.env.PATH },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      }).trim();
    } catch {
      throw new Error('Mid-mutation cleanup fixture Git command failed');
    }
  };

  git('init', '--quiet');
  git(
    '-c', 'user.name=Recovery Harness',
    '-c', 'user.email=recovery@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'fixture',
  );

  // `control` is the branch name the disposable cleanup child accepts for a
  // clean, genuinely removable worktree, so the mutation really does run.
  const worktree = path.join(projectRoot, '.psyche', 'worktrees', 'control');
  git('worktree', 'add', '--quiet', '-b', 'control', worktree);
  const branchBefore = git('rev-parse', 'refs/heads/control');

  // The only copy of uncommitted work is the disposable workspace's own file in
  // the main project, not one inside the worktree: `git worktree remove`
  // refuses a dirty worktree, and this scenario needs the removal to begin.
  const workFile = path.join(projectRoot, 'uncommitted-work.txt');
  const workBefore = await readFile(workFile);

  const worker = cleanupWorker(projectRoot, 'control', env);
  let mutationObservedInFlight = false;
  let ownerKilledDuringMutation = false;
  let gitPids: readonly number[] = [];
  try {
    mutationObservedInFlight = await waitForMutation(startedMarker, worker);
    if (mutationObservedInFlight) {
      // Recorded before the kill so an orphan can be detected afterwards. The
      // supervisor is responsible for terminating this group on parent loss.
      gitPids = findMutationProcesses(projectRoot);
      const exit = await worker.stop();
      ownerKilledDuringMutation = exit.signal === 'SIGKILL'
        && !exit.finished
        && !exit.timedOut;
    }
  } finally {
    await worker.stop();
  }

  // Bounded, because terminating the group is asynchronous on the supervisor's
  // side. A regression that never terminates it must surface as this failed
  // invariant rather than as a timeout that costs the run its evidence.
  //
  // Requiring at least one observed process keeps this from holding vacuously:
  // if the mutation's process group could not be identified, nothing was
  // proved about orphans and the invariant must not report success.
  const mutationLeftNoOrphan = gitPids.length > 0 && await waitForProcessExit(gitPids);

  // The supervisor can still be stopping its Git child after IPC loss, so the
  // durable leases are held until the queue is provably idle. A queue that
  // never goes idle is itself an observation: it must not throw away the rest
  // of the evidence, and it must not be reported as a recovered lease.
  let projectLeaseRecovered = false;
  try {
    await awaitCleanupQuiescence(projectRoot);
    const lease = await acquireProjectWorktreeLifecycleLease(
      { projectRoot, operation: 'harness-mid-mutation-recovery' },
      { timeoutMs: 5_000 },
    );
    projectLeaseRecovered = true;
    await lease.release();
  } catch {
    projectLeaseRecovered = false;
  }

  const registered = git('worktree', 'list', '--porcelain').includes(worktree);
  const present = existsSync(worktree);
  const worktreeStateSelfConsistent = registered === present;

  // Queried independently of the worktree. Reading it only when the worktree
  // survived would let a cleanup that removed the worktree *and* moved the
  // branch pass the branch-preservation invariant unchallenged.
  const branchOid = git('for-each-ref', '--format=%(objectname)', 'refs/heads/control');
  const branchUnchanged = present
    // A retained worktree must still have its branch, unmoved.
    ? branchOid === branchBefore
    // A completed cleanup is entitled to delete the branch it owns, but never
    // to point it at a different commit.
    : branchOid === '' || branchOid === branchBefore;
  const workPreserved = (await readFile(workFile)).equals(workBefore);

  return {
    mutationObservedInFlight,
    ownerKilledDuringMutation,
    worktreeStateSelfConsistent,
    mutationLeftNoOrphan,
    projectLeaseRecovered,
    branchUnchanged,
    workPreserved,
    retentionRequired: !mutationLeftNoOrphan || !projectLeaseRecovered,
  };
}

/**
 * Holds the destructive mutation at its first instruction, then execs the real
 * Git binary. Every other Git call passes straight through, so only the one
 * command this scenario interrupts is delayed.
 */
async function writeGitShim(options: {
  shimDir: string;
  startedMarker: string;
  releaseMarker: string;
}): Promise<void> {
  const realGit = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  }).trim();
  if (!realGit || realGit.startsWith(options.shimDir)) {
    throw new Error('Mid-mutation cleanup could not resolve the real Git binary');
  }

  const shim = `#!/bin/sh
# Recovery harness shim. Holds one destructive cleanup mutation so the owner
# can be terminated while the supervised Git process group is live, then execs
# the real Git binary. Git behaviour is never simulated.
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  : > "${options.startedMarker}"
  attempts=0
  while [ ! -f "${options.releaseMarker}" ] && [ "$attempts" -lt 600 ]; do
    sleep 0.05
    attempts=$((attempts + 1))
  done
fi
exec "${realGit}" "$@"
`;
  const shimPath = path.join(options.shimDir, 'git');
  await writeFile(shimPath, shim, 'utf8');
  await chmod(shimPath, 0o755);
}

async function waitForMutation(
  startedMarker: string,
  worker: ReturnType<typeof cleanupWorker>,
): Promise<boolean> {
  const deadline = Date.now() + MUTATION_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(startedMarker)) return true;
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return false;
    await delay(MUTATION_POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * The live processes holding this run's mutation. Matched on the disposable
 * project path, which is unique per run: a broader match could pick up an
 * unrelated Git process on the host and make the orphan check depend on it.
 */
function findMutationProcesses(projectRoot: string): readonly number[] {
  try {
    const output = execFileSync('/bin/ps', ['-Ao', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return output
      .split('\n')
      .filter((line) => line.includes(projectRoot))
      .map((line) => Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

/** Bounded wait for every interrupted mutation process to exit. */
async function waitForProcessExit(pids: readonly number[]): Promise<boolean> {
  const deadline = Date.now() + ORPHAN_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) return true;
    await delay(MUTATION_POLL_INTERVAL_MS);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
