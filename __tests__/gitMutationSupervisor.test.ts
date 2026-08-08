import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runGitMutationWithSupervisor,
} from '../src/services/GitMutationSupervisor.js';
import {
  acquireWorktreeOperationLease,
  type WorktreeOperationLeaseRecord,
} from '../src/services/WorktreeOperationLease.js';
import { isProcessAlive } from '../src/services/ProcessIdentity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function configureBlockingPreCommitHook(projectRoot: string): {
  started: string;
  release: string;
} {
  const hooksDir = join(projectRoot, '.git', 'hooks');
  const started = join(projectRoot, '.hook-started');
  const release = join(projectRoot, '.hook-release');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, 'pre-commit'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$$" > '${started}'`,
      `while [ ! -f '${release}' ]; do sleep 0.02; done`,
    ].join('\n'),
  );
  chmodSync(join(hooksDir, 'pre-commit'), 0o755);
  return { started, release };
}

describe('GitMutationSupervisor', () => {
  it('claims a pending lease before spawning Git and clears it only after Git exits', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-git-supervisor-test-'));
    roots.push(projectRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
    const lease = await acquireWorktreeOperationLease({
      projectRoot,
      worktreePath,
      operation: 'create',
    });

    const result = await runGitMutationWithSupervisor({
      cwd: projectRoot,
      args: ['config', 'psyche.supervisor-test', 'owned'],
      leases: [{
        lockDir: lease.lockDir,
        leaseNonce: lease.nonce,
        preparePendingGitMutation: lease.preparePendingGitMutation,
      }],
    });

    expect(result).toEqual({ exitCode: 0, stderr: '' });
    expect(execFileSync(
      'git',
      ['config', '--get', 'psyche.supervisor-test'],
      { cwd: projectRoot, encoding: 'utf8' },
    ).trim()).toBe('owned');
    const record = JSON.parse(readFileSync(
      join(lease.lockDir, 'lease.json'),
      'utf8',
    )) as WorktreeOperationLeaseRecord;
    expect(record.pendingMutation).toBeUndefined();
    expect(existsSync(join(lease.lockDir, `child.${lease.nonce}.json`))).toBe(false);
    await lease.release();
  });

  it('retains the actual Git child lease after a killed supervisor until the blocked hook exits', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-git-supervisor-test-'));
    roots.push(projectRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectRoot });
    const hook = configureBlockingPreCommitHook(projectRoot);
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
    const lease = await acquireWorktreeOperationLease({
      projectRoot,
      worktreePath,
      operation: 'create',
    });
    let supervisorPid: number | undefined;
    const mutation = runGitMutationWithSupervisor({
      cwd: projectRoot,
      args: ['commit', '--allow-empty', '-m', 'blocked mutation'],
      leases: [{
        lockDir: lease.lockDir,
        leaseNonce: lease.nonce,
        preparePendingGitMutation: lease.preparePendingGitMutation,
      }],
      onSupervisorSpawn: (child) => {
        supervisorPid = child.pid;
      },
    });

    await waitFor(() => existsSync(hook.started), 'pre-commit hook start');
    const beforeKill = JSON.parse(readFileSync(
      join(lease.lockDir, 'lease.json'),
      'utf8',
    )) as WorktreeOperationLeaseRecord;
    const child = JSON.parse(readFileSync(
      join(lease.lockDir, `child.${lease.nonce}.json`),
      'utf8',
    )) as { pid: number; processStartIdentity: string };
    expect(supervisorPid).toEqual(expect.any(Number));
    expect(child.pid).not.toBe(supervisorPid);
    expect(child.processStartIdentity).toEqual(expect.any(String));
    expect(beforeKill.pendingMutation).toMatchObject({
      supervisorPid,
    });

    process.kill(supervisorPid!, 'SIGKILL');
    await expect(mutation).rejects.toThrow(/supervisor exited/i);
    expect(isProcessAlive(child.pid)).toBe(true);

    // This is the former ownership bug: a caller-finally must not release the
    // lock merely because the supervisor died while detached Git still runs.
    await lease.release();
    expect(existsSync(lease.lockDir)).toBe(true);
    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'contender' },
      { pollIntervalMs: 5, timeoutMs: 50 },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);

    writeFileSync(hook.release, 'continue\n');
    await waitFor(() => !isProcessAlive(child.pid), 'detached Git exit');
    await lease.release();

    const contender = await acquireWorktreeOperationLease({
      projectRoot,
      worktreePath,
      operation: 'contender',
    });
    await contender.release();
  });

  it('terminates the detached Git process group and cleans the lease on supervisor shutdown', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-git-supervisor-test-'));
    roots.push(projectRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectRoot });
    const hook = configureBlockingPreCommitHook(projectRoot);
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
    const lease = await acquireWorktreeOperationLease({
      projectRoot,
      worktreePath,
      operation: 'create',
    });
    let supervisorPid: number | undefined;
    const mutation = runGitMutationWithSupervisor({
      cwd: projectRoot,
      args: ['commit', '--allow-empty', '-m', 'termination test'],
      leases: [{
        lockDir: lease.lockDir,
        leaseNonce: lease.nonce,
        preparePendingGitMutation: lease.preparePendingGitMutation,
      }],
      onSupervisorSpawn: (child) => {
        supervisorPid = child.pid;
      },
    });

    await waitFor(() => existsSync(hook.started), 'pre-commit hook start');
    const child = JSON.parse(readFileSync(
      join(lease.lockDir, `child.${lease.nonce}.json`),
      'utf8',
    )) as { pid: number };

    process.kill(supervisorPid!, 'SIGTERM');
    await expect(mutation).rejects.toThrow(/SIGTERM/);
    await waitFor(() => !isProcessAlive(child.pid), 'forced Git process-group exit');

    const record = JSON.parse(readFileSync(
      join(lease.lockDir, 'lease.json'),
      'utf8',
    )) as WorktreeOperationLeaseRecord;
    expect(record.pendingMutation).toBeUndefined();
    expect(existsSync(join(lease.lockDir, `child.${lease.nonce}.json`))).toBe(false);
    await lease.release();
    expect(existsSync(lease.lockDir)).toBe(false);
  });
});
