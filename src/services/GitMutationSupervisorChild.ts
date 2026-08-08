import { spawn, type ChildProcess } from 'node:child_process';
import {
  claimPendingGitMutationLease,
  clearPendingGitMutationChildLease,
  clearPendingGitMutationLease,
  retainPendingGitMutationLease,
  trackPendingGitMutationChildLease,
  type LeaseChildProcess,
} from './WorktreeOperationLease.js';
import type {
  GitMutationSupervisorRequest,
  GitMutationSupervisorResult,
} from './GitMutationSupervisor.js';
import { BoundedOutputBuffer } from '../utils/BoundedOutputBuffer.js';

const TERMINATION_WAIT_MS = 2_000;
const DEFAULT_MAX_STDERR_BYTES = 1_024 * 1_024;

type SupervisorMessage = GitMutationSupervisorRequest;

interface ClaimedLease {
  lease: GitMutationSupervisorRequest['leases'][number];
  supervisor: LeaseChildProcess;
}

interface TrackedGitLease extends ClaimedLease {
  git: LeaseChildProcess;
}

interface ActiveGitProcess {
  readonly child: ChildProcess;
  readonly tracked: TrackedGitLease[];
  readonly close: Promise<GitMutationSupervisorResult>;
  continued: boolean;
  terminationReason?: string;
  hasClosed: () => boolean;
  terminate: () => Promise<boolean>;
  continue: () => void;
}

process.once('message', (message: SupervisorMessage) => {
  void superviseGitMutation(message)
    .then((result) => report({ type: 'result', result }, true))
    .catch((error) => report({
      type: 'result',
      error: error instanceof Error ? error.message : String(error),
    }, true));
});

interface SupervisorDependencies {
  isParentConnected?: () => boolean;
  claimPendingGitMutationLease?: typeof claimPendingGitMutationLease;
  clearPendingGitMutationLease?: typeof clearPendingGitMutationLease;
  startStoppedGit?: typeof startStoppedGit;
  installTerminationHandlers?: typeof installTerminationHandlers;
  report?: typeof report;
}

export async function superviseGitMutation(
  request: GitMutationSupervisorRequest,
  dependencies: SupervisorDependencies = {},
): Promise<GitMutationSupervisorResult> {
  validateRequest(request);

  const claimed: ClaimedLease[] = [];
  let activeGit: ActiveGitProcess | undefined;
  let parentLost = !(dependencies.isParentConnected ?? (() => process.connected !== false))();
  const stopHandlers = (
    dependencies.installTerminationHandlers ?? installTerminationHandlers
  )(
    () => activeGit,
    request,
    claimed,
    () => {
      parentLost = true;
    },
  );
  const assertParentConnected = () => {
    if (
      parentLost
      || !(dependencies.isParentConnected ?? (() => process.connected !== false))()
    ) {
      throw new Error('Git mutation supervisor lost its parent IPC channel');
    }
  };

  try {
    assertParentConnected();
    for (const lease of request.leases) {
      const supervisor = await (
        dependencies.claimPendingGitMutationLease ?? claimPendingGitMutationLease
      )(lease, {
        mutationNonce: request.mutationNonce,
      });
      claimed.push({ lease, supervisor });
      assertParentConnected();
    }
  } catch (error) {
    await Promise.allSettled(claimed.map(({ lease, supervisor }) => (
      (dependencies.clearPendingGitMutationLease ?? clearPendingGitMutationLease)(lease, {
        mutationNonce: request.mutationNonce,
        supervisor,
      })
    )));
    stopHandlers();
    throw error;
  }

  assertParentConnected();
  (dependencies.report ?? report)({ type: 'claimed' });

  try {
    activeGit = await (dependencies.startStoppedGit ?? startStoppedGit)(
      request,
      claimed,
      (active) => {
        activeGit = active;
      },
    );
    activeGit.continue();
    const result = await activeGit.close;
    if (activeGit.terminationReason) {
      throw new Error(activeGit.terminationReason);
    }
    return result;
  } finally {
    stopHandlers();
    if (activeGit?.hasClosed()) {
      await Promise.allSettled(activeGit.tracked.map(({ lease, git }) => (
        clearPendingGitMutationChildLease(lease, git)
      )));
      await Promise.allSettled(claimed.map(({ lease, supervisor }) => (
        clearPendingGitMutationLease(lease, {
          mutationNonce: request.mutationNonce,
          supervisor,
        })
      )));
    } else if (activeGit) {
      await retainUnconfirmedTermination(
        request,
        claimed,
        activeGit.terminationReason || 'Git process group did not exit before supervisor shutdown',
      );
    } else {
      // No Git PID was ever handed off, so this is the ordinary claimed-helper
      // setup failure path rather than an uncertain destructive operation.
      await Promise.allSettled(claimed.map(({ lease, supervisor }) => (
        clearPendingGitMutationLease(lease, {
          mutationNonce: request.mutationNonce,
          supervisor,
        })
      )));
    }
  }
}

/**
 * A POSIX gate stops itself before exec'ing Git. `exec` preserves the process
 * PID and start time, so the PID written while stopped is the actual Git PID.
 * This closes the spawn-to-hook race that a parent-side SIGSTOP cannot close.
 */
async function startStoppedGit(
  request: GitMutationSupervisorRequest,
  claimed: readonly ClaimedLease[],
  onStarted: (active: ActiveGitProcess) => void,
): Promise<ActiveGitProcess> {
  const unix = process.platform !== 'win32';
  const child = unix
    ? spawn('/bin/sh', [
      '-c',
      'kill -STOP "$$"; exec "$@"',
      '--',
      'git',
      ...request.args,
    ], {
      cwd: request.cwd,
      detached: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    : spawn('git', [...request.args], {
      cwd: request.cwd,
      detached: false,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

  const stderr = new BoundedOutputBuffer(
    request.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
  );
  let closed = false;
  let closeError: Error | undefined;
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.append(chunk);
  });
  const close = new Promise<GitMutationSupervisorResult>((resolve, reject) => {
    child.once('error', (error) => {
      closeError = error;
      if (closed) {
        return;
      }
      // spawn failures may not emit close on every platform.
      reject(error);
    });
    child.once('close', (exitCode) => {
      closed = true;
      if (closeError) {
        reject(closeError);
        return;
      }
      resolve({ exitCode, stderr: stderr.toString().trim() });
    });
  });

  const pid = child.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    try {
      await close;
    } catch {
      // The useful error is below: a process with no PID can never be owned.
    }
    throw new Error('Git supervisor could not obtain a Git child PID');
  }

  let continued = false;
  const active: ActiveGitProcess = {
    child,
    tracked: [],
    close,
    continued,
    hasClosed: () => closed,
    continue: () => {
      if (closed || continued) {
        return;
      }
      if (unix) {
        process.kill(-pid, 'SIGCONT');
      } else {
        child.kill('SIGCONT');
      }
      continued = true;
      active.continued = true;
    },
    terminate: async () => {
      if (closed) {
        return true;
      }

      if (!continued) {
        // The gate has not exec'ed Git yet. SIGKILL is deliverable to a
        // stopped process and guarantees no hook can run after a failed
        // ownership registration.
        signalGitProcessGroup(child, unix, 'SIGKILL');
        return waitForClose(active, TERMINATION_WAIT_MS);
      }

      signalGitProcessGroup(child, unix, 'SIGTERM');
      if (await waitForClose(active, TERMINATION_WAIT_MS)) {
        return true;
      }
      signalGitProcessGroup(child, unix, 'SIGKILL');
      return waitForClose(active, TERMINATION_WAIT_MS);
    },
  };
  onStarted(active);

  try {
    for (const claim of claimed) {
      const git = await trackGitChildWithRetry(claim, request.mutationNonce, pid);
      active.tracked.push({ ...claim, git });
    }
    return active;
  } catch (error) {
    const terminated = await active.terminate();
    if (!terminated) {
      await retainUnconfirmedTermination(
        request,
        claimed,
        `Git ownership registration failed and its process group could not be confirmed stopped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    throw error;
  }
}

async function trackGitChildWithRetry(
  claim: ClaimedLease,
  mutationNonce: string,
  pid: number,
): Promise<LeaseChildProcess> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await trackPendingGitMutationChildLease(claim.lease, {
        mutationNonce,
        supervisor: claim.supervisor,
        pid,
      });
    } catch (error) {
      lastError = error;
      if (!String(error).includes('process-start identity is unavailable') || attempt === 19) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not persist Git child ownership');
}

function installTerminationHandlers(
  active: () => ActiveGitProcess | undefined,
  request: GitMutationSupervisorRequest,
  claimed: readonly ClaimedLease[],
  onParentLoss: () => void = () => {},
): () => void {
  let stopping: Promise<void> | undefined;
  const stop = (reason: string) => {
    stopping ??= (async () => {
      const git = active();
      if (!git) {
        return;
      }
      git.terminationReason = reason;
      const terminated = await git.terminate();
      if (!terminated) {
        await retainUnconfirmedTermination(request, claimed, reason);
      }
    })();
    void stopping;
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>([
    ['SIGINT', () => stop('Git mutation supervisor received SIGINT')],
    ['SIGTERM', () => stop('Git mutation supervisor received SIGTERM')],
    ['SIGHUP', () => stop('Git mutation supervisor received SIGHUP')],
  ]);
  const disconnectHandler = () => {
    onParentLoss();
    stop('Git mutation supervisor lost its parent IPC channel');
  };
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }
  process.once('disconnect', disconnectHandler);

  return () => {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    process.removeListener('disconnect', disconnectHandler);
  };
}

async function retainUnconfirmedTermination(
  request: GitMutationSupervisorRequest,
  claimed: readonly ClaimedLease[],
  reason: string,
): Promise<void> {
  await Promise.allSettled(claimed.map(({ lease, supervisor }) => (
    retainPendingGitMutationLease(lease, {
      mutationNonce: request.mutationNonce,
      supervisor,
      reason,
    })
  )));
}

function signalGitProcessGroup(
  child: ChildProcess,
  unix: boolean,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  try {
    if (unix && pid) {
      process.kill(-pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The close probe below decides whether this was an already-dead process
    // or a termination we could not confirm.
  }
}

async function waitForClose(
  active: ActiveGitProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (active.hasClosed()) {
    return true;
  }
  await Promise.race([
    active.close.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return active.hasClosed();
}

function validateRequest(value: SupervisorMessage): void {
  if (
    !value
    || typeof value.cwd !== 'string'
    || !Array.isArray(value.args)
    || value.args.some((arg) => typeof arg !== 'string')
    || typeof value.mutationNonce !== 'string'
    || (
      value.maxStderrBytes !== undefined
      && (
        !Number.isFinite(value.maxStderrBytes)
        || value.maxStderrBytes <= 32
      )
    )
    || !Array.isArray(value.leases)
    || value.leases.length === 0
    || value.leases.some((lease) => (
      !lease
      || typeof lease.lockDir !== 'string'
      || typeof lease.leaseNonce !== 'string'
    ))
  ) {
    throw new Error('Git mutation supervisor received an invalid request');
  }
}

function report(message: {
  type: 'claimed' | 'result';
  result?: GitMutationSupervisorResult;
  error?: string;
}, final = false): void {
  if (typeof process.send === 'function') {
    process.send(message, () => {
      if (final) {
        process.disconnect?.();
      }
    });
  }
}
