import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  clearUnclaimedPendingGitMutationLease,
  type PendingGitMutationLeaseRef,
  type PendingGitMutationRequest,
} from './WorktreeOperationLease.js';

const DEFAULT_PENDING_TIMEOUT_MS = 30_000;

export interface GitMutationSupervisorLease extends PendingGitMutationLeaseRef {
  preparePendingGitMutation: (
    request: PendingGitMutationRequest,
  ) => Promise<void>;
}

export interface GitMutationSupervisorRequest {
  cwd: string;
  args: string[];
  mutationNonce: string;
  leases: PendingGitMutationLeaseRef[];
}

export interface GitMutationSupervisorResult {
  exitCode: number | null;
  stderr: string;
}

export interface RunGitMutationWithSupervisorOptions {
  cwd: string;
  args: readonly string[];
  leases: readonly GitMutationSupervisorLease[];
  pendingTimeoutMs?: number;
  mutationNonce?: string;
  now?: () => Date;
  forkProcess?: (
    modulePath: string,
    args: readonly string[],
    options: Parameters<typeof fork>[2],
  ) => ChildProcess;
  /**
   * Lifecycle test seam. The real process is exposed only after fork succeeds;
   * callers must never use it to decide lease ownership.
   */
  onSupervisorSpawn?: (child: ChildProcess) => void;
}

interface GitMutationSupervisorMessage {
  type: 'claimed' | 'result';
  result?: GitMutationSupervisorResult;
  error?: string;
}

/**
 * Runs a mutating Git command in a durable child supervisor.
 *
 * The caller records a bounded pending claim first. The child then claims
 * every participating filesystem lease before spawning Git without a shell.
 * That order keeps the lease live if the caller dies at any point after the
 * pending record reaches disk.
 */
export async function runGitMutationWithSupervisor(
  options: RunGitMutationWithSupervisorOptions,
): Promise<GitMutationSupervisorResult> {
  if (options.args.length === 0) {
    throw new Error('A supervised Git mutation requires Git arguments');
  }
  const leases = uniqueLeases(options.leases);
  if (leases.length === 0) {
    throw new Error('A supervised Git mutation requires at least one filesystem lease');
  }

  const now = options.now ?? (() => new Date());
  const pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  if (!Number.isFinite(pendingTimeoutMs) || pendingTimeoutMs <= 0) {
    throw new Error('Supervised Git mutation pending timeout must be greater than zero');
  }

  const mutationNonce = options.mutationNonce ?? randomUUID();
  const pending: PendingGitMutationRequest = {
    nonce: mutationNonce,
    deadline: new Date(now().getTime() + pendingTimeoutMs).toISOString(),
  };
  const prepared: GitMutationSupervisorLease[] = [];
  try {
    for (const lease of leases) {
      await lease.preparePendingGitMutation(pending);
      prepared.push(lease);
    }
  } catch (error) {
    await Promise.allSettled(prepared.map((lease) => (
      clearUnclaimedPendingGitMutationLease(lease, mutationNonce)
    )));
    throw error;
  }

  const script = resolveSupervisorScript();
  let child: ChildProcess;
  try {
    const startFork = options.forkProcess ?? fork;
    child = startFork(script.modulePath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // A helper must not inherit a parent's `node -e`, test runner loader,
      // or inspector flags: those can replace the child entry point entirely.
      // Source mode explicitly supplies only the tsx loader below.
      execArgv: script.execArgv ?? [],
    });
    options.onSupervisorSpawn?.(child);
  } catch (error) {
    await Promise.allSettled(leases.map((lease) => (
      clearUnclaimedPendingGitMutationLease(lease, mutationNonce)
    )));
    throw error;
  }

  const request: GitMutationSupervisorRequest = {
    cwd: options.cwd,
    args: [...options.args],
    mutationNonce,
    leases: leases.map(({ lockDir, leaseNonce }) => ({ lockDir, leaseNonce })),
  };

  return new Promise<GitMutationSupervisorResult>((resolve, reject) => {
    let claimed = false;
    let result: GitMutationSupervisorResult | undefined;
    let reportError: Error | undefined;
    let settled = false;
    let supervisorStderr = '';

    child.stderr?.on('data', (chunk: Buffer | string) => {
      supervisorStderr += chunk.toString();
    });

    const succeed = (value: GitMutationSupervisorResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.on('message', (message: GitMutationSupervisorMessage) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'claimed') {
        claimed = true;
        return;
      }
      if (message.type === 'result') {
        if (message.error) {
          reportError = new Error(message.error);
        } else if (message.result) {
          result = message.result;
        } else {
          reportError = new Error('Git mutation supervisor returned an invalid result');
        }
      }
    });
    child.once('error', async (error) => {
      if (!claimed) {
        await Promise.allSettled(leases.map((lease) => (
          clearUnclaimedPendingGitMutationLease(lease, mutationNonce)
        )));
      }
      fail(error);
    });
    child.once('exit', async (code, signal) => {
      if (!claimed) {
        await Promise.allSettled(leases.map((lease) => (
          clearUnclaimedPendingGitMutationLease(lease, mutationNonce)
        )));
      }
      if (reportError) {
        fail(reportError);
        return;
      }
      if (result) {
        succeed(result);
        return;
      }
      fail(
        new Error(
          `Git mutation supervisor exited before reporting a result (code ${
            code ?? 'unknown'
          }, signal ${signal ?? 'none'})${
            supervisorStderr.trim() ? `: ${supervisorStderr.trim()}` : ''
          }`,
        ),
      );
    });

    try {
      child.send?.(request, (error) => {
        if (error) {
          child.emit('error', error);
        }
      });
    } catch (error) {
      child.emit('error', error);
    }
  });
}

export function isGitMutationSupervisorLease(
  value: unknown,
): value is GitMutationSupervisorLease {
  const lease = value as Partial<GitMutationSupervisorLease> | undefined;
  return Boolean(
    lease
    && typeof lease.lockDir === 'string'
    && typeof lease.leaseNonce === 'string'
    && typeof lease.preparePendingGitMutation === 'function',
  );
}

function uniqueLeases(
  leases: readonly GitMutationSupervisorLease[],
): GitMutationSupervisorLease[] {
  const unique = new Map<string, GitMutationSupervisorLease>();
  for (const lease of leases) {
    unique.set(`${lease.lockDir}\0${lease.leaseNonce}`, lease);
  }
  return [...unique.values()];
}

function resolveSupervisorScript(): {
  modulePath: string;
  execArgv?: string[];
} {
  const compiledPath = fileURLToPath(
    new URL('./GitMutationSupervisorChild.js', import.meta.url),
  );
  if (existsSync(compiledPath)) {
    return { modulePath: compiledPath };
  }

  // Source-mode development and Vitest load TypeScript directly. Production
  // packages always contain the compiled child in dist; tsx is only the
  // source-mode bridge to exercise the same supervisor protocol.
  return {
    modulePath: fileURLToPath(
      new URL('./GitMutationSupervisorChild.ts', import.meta.url),
    ),
    execArgv: ['--import', 'tsx'],
  };
}
