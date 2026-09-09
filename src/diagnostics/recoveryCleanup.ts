import { execFileSync, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  acquireProjectWorktreeLifecycleLease,
  acquireWorktreeOperationLease,
  type WorktreeOperationLease,
} from '../services/WorktreeOperationLease.js';
import { writeWorktreeRecoveryMarker } from '../services/WorktreeRecoveryMarker.js';

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  markerBlocked: boolean;
  finished: boolean;
  timedOut: boolean;
}

export class RecoveryCleanupRetentionError extends Error {
  constructor() {
    super('Recovery cleanup workspace retained: mutation termination could not be confirmed');
  }
}

export function assertRecoveryCleanupEnvironment(env: NodeJS.ProcessEnv): void {
  // Parent-side --git-common-dir discovery invokes Git too. These overrides
  // can redirect its lock outside the disposable project despite an explicit cwd.
  if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].some((key) => env[key] !== undefined)) {
    throw new Error('Recovery cleanup requires an environment without Git repository overrides');
  }
}

export async function awaitCleanupQuiescence(projectRoot: string, timeoutMs = 5_000): Promise<void> {
  try {
    const lease = await acquireProjectWorktreeLifecycleLease(
      { projectRoot, operation: 'harness-disposal-barrier' },
      { timeoutMs },
    );
    await lease.release();
  } catch {
    throw new RecoveryCleanupRetentionError();
  }
}

function cleanupWorker(projectRoot: string, branch: 'retained' | 'control', env: NodeJS.ProcessEnv) {
  const compiled = fileURLToPath(new URL('./recoveryCleanupChild.js', import.meta.url));
  const source = fileURLToPath(new URL('./recoveryCleanupChild.ts', import.meta.url));
  const child = fork(existsSync(compiled) ? compiled : source, [], {
    // Source-mode Git supervisors resolve their tsx loader from the package.
    // Every product Git operation still receives the disposable project cwd.
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env,
    execArgv: existsSync(compiled) ? [] : ['--import', fileURLToPath(import.meta.resolve('tsx'))],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let finished = false;
  let markerBlocked = false;
  const done = new Promise<WorkerExit>((resolve) => {
    let failed = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 25_000);
    child.on('message', (message: unknown) => {
      if (
        message && typeof message === 'object'
        && 'type' in message && message.type === 'finished'
        && 'markerBlocked' in message && typeof message.markerBlocked === 'boolean'
      ) {
        finished = true;
        markerBlocked = message.markerBlocked;
      }
    });
    child.once('error', () => {
      failed = true;
      child.kill('SIGKILL');
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: failed ? 2 : code, signal, markerBlocked, finished, timedOut });
    });
  });
  child.send({ projectRoot, branch }, (error) => {
    if (error) child.kill('SIGKILL');
  });
  return {
    child,
    done,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return done;
    },
  };
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new Error('Recovery cleanup evidence could not be read');
  }
}

async function waitForCleanupLease(
  lockDir: string,
  worker: ReturnType<typeof cleanupWorker>,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const bytes = await readOptional(path.join(lockDir, 'lease.json'));
    if (bytes) {
      const record: unknown = JSON.parse(bytes.toString());
      if (
        record && typeof record === 'object'
        && 'pid' in record && record.pid === worker.child.pid
        && 'operation' in record && record.operation === 'cleanup'
        && 'nonce' in record && typeof record.nonce === 'string'
        && !('pendingMutation' in record)
      ) return record.nonce;
    }
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) break;
    await delay(20);
  }
  throw new Error('Recovery cleanup worker did not acquire its project lease');
}

/**
 * Interrupt the real queue after its project lease is durable but before it can
 * acquire the exact-worktree lease. No Git mutation can begin at this boundary.
 */
export async function observeInterruptedCleanup(projectRoot: string) {
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
  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: projectRoot, env, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 64 * 1024,
      }).trim();
    } catch {
      throw new Error('Recovery cleanup fixture Git command failed');
    }
  };
  git('init', '--quiet');
  git('-c', 'user.name=Recovery Harness', '-c', 'user.email=recovery@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  const worktree = path.join(projectRoot, '.psyche', 'worktrees', 'retained');
  const control = path.join(projectRoot, '.psyche', 'worktrees', 'control');
  git('worktree', 'add', '--quiet', '-b', 'retained', worktree);
  git('worktree', 'add', '--quiet', '-b', 'control', control);
  const beforeOid = git('rev-parse', 'refs/heads/retained');
  const workFile = path.join(worktree, 'uncommitted.txt');
  const workBefore = Buffer.from('the only copy of interrupted cleanup work\n');
  await writeFile(workFile, workBefore);

  // Discover the canonical lease path through the production API.
  const probe = await acquireProjectWorktreeLifecycleLease({
    projectRoot, operation: 'harness-probe',
  });
  const projectLockDir = probe.lockDir;
  await probe.release();
  let blocker: WorktreeOperationLease | undefined;
  let activeWorker: ReturnType<typeof cleanupWorker> | undefined;
  try {
    blocker = await acquireWorktreeOperationLease({
      projectRoot, worktreePath: worktree, operation: 'harness-block-cleanup',
    });
    const worker = cleanupWorker(projectRoot, 'retained', env);
    activeWorker = worker;
    let interrupted = false;
    let recovered = false;
    try {
      const oldNonce = await waitForCleanupLease(projectLockDir, worker);
      const exit = await worker.stop();
      interrupted = exit.signal === 'SIGKILL' && !exit.finished && !exit.timedOut;
      const lease = await acquireProjectWorktreeLifecycleLease(
        { projectRoot, operation: 'harness-recovery' },
        { timeoutMs: 5_000 },
      );
      recovered = lease.nonce !== oldNonce;
      await lease.release();
    } finally {
      await worker.stop();
      await blocker.release();
      blocker = undefined;
    }

    // This marker is explicitly published by the harness/operator after the crash,
    // not claimed as an automatic cleanup-service effect.
    await writeWorktreeRecoveryMarker({
      projectRoot, worktreePath: worktree,
      pane: { id: 'harness-cleanup', paneId: '%1' },
      operation: 'cleanup', reason: 'harness cleanup owner interrupted before mutation',
    });
    const retry = cleanupWorker(projectRoot, 'retained', env);
    activeWorker = retry;
    let retryExit: WorkerExit;
    try {
      retryExit = await retry.done;
    } finally {
      await retry.stop();
    }
    // A separate, clean worktree must actually be removed: a no-op queue must not
    // satisfy the preservation observations above.
    const positiveControl = cleanupWorker(projectRoot, 'control', env);
    activeWorker = positiveControl;
    let controlExit: WorkerExit;
    try {
      controlExit = await positiveControl.done;
    } finally {
      await positiveControl.stop();
    }
    const controlRemoved = controlExit.code === 0 && controlExit.finished
      && !controlExit.markerBlocked && !existsSync(control)
      && git('for-each-ref', '--format=%(refname)', 'refs/heads/control') === '';
    await awaitCleanupQuiescence(projectRoot);
    const workAfter = await readOptional(workFile);
    const retained = workAfter?.equals(workBefore) === true;
    const branchUnchanged = git('rev-parse', 'refs/heads/retained') === beforeOid;
    return {
      interrupted, recovered, retained, branchUnchanged, controlRemoved, workAfter,
      retryBlocked: retryExit.code === 0 && retryExit.finished && retryExit.markerBlocked,
    };
  } finally {
    // Worker exit alone is insufficient: a Git supervisor can still be stopping
    // its mutation child after IPC loss. Keep durable leases until it is idle.
    try {
      await activeWorker?.stop();
      await blocker?.release();
    } finally {
      await awaitCleanupQuiescence(projectRoot);
    }
  }
}
