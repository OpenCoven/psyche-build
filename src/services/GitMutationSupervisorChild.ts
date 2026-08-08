import { spawn } from 'node:child_process';
import {
  claimPendingGitMutationLease,
  clearPendingGitMutationLease,
  type LeaseChildProcess,
} from './WorktreeOperationLease.js';
import type {
  GitMutationSupervisorRequest,
  GitMutationSupervisorResult,
} from './GitMutationSupervisor.js';

type SupervisorMessage = GitMutationSupervisorRequest;

process.once('message', (message: SupervisorMessage) => {
  void supervise(message)
    .then((result) => report({ type: 'result', result }, true))
    .catch((error) => report({
      type: 'result',
      error: error instanceof Error ? error.message : String(error),
    }, true));
});

async function supervise(
  request: GitMutationSupervisorRequest,
): Promise<GitMutationSupervisorResult> {
  validateRequest(request);

  const claimed: Array<{
    lease: GitMutationSupervisorRequest['leases'][number];
    supervisor: LeaseChildProcess;
  }> = [];
  try {
    for (const lease of request.leases) {
      const supervisor = await claimPendingGitMutationLease(lease, {
        mutationNonce: request.mutationNonce,
      });
      claimed.push({ lease, supervisor });
    }
  } catch (error) {
    await Promise.allSettled(claimed.map(({ lease, supervisor }) => (
      clearPendingGitMutationLease(lease, {
        mutationNonce: request.mutationNonce,
        supervisor,
      })
    )));
    throw error;
  }

  report({ type: 'claimed' });
  let result: GitMutationSupervisorResult;
  try {
    result = await runGit(request.cwd, request.args);
  } finally {
    // This is intentionally after the Git close event. Git waits for normal
    // hooks, so the supervisor retains durable ownership for the full command
    // lifetime rather than only through the parent's spawn call.
    await Promise.all(claimed.map(({ lease, supervisor }) => (
      clearPendingGitMutationLease(lease, {
        mutationNonce: request.mutationNonce,
        supervisor,
      })
    )));
  }
  return result!;
}

function runGit(
  cwd: string,
  args: readonly string[],
): Promise<GitMutationSupervisorResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode, stderr: stderr.trim() });
    });
  });
}

function validateRequest(value: SupervisorMessage): void {
  if (
    !value
    || typeof value.cwd !== 'string'
    || !Array.isArray(value.args)
    || value.args.some((arg) => typeof arg !== 'string')
    || typeof value.mutationNonce !== 'string'
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
