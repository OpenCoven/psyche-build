import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireWorktreeOperationLease,
  type WorktreeOperationLeaseRecord,
} from '../src/services/WorktreeOperationLease.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createLeaseTarget(): { projectRoot: string; worktreePath: string } {
  const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-worktree-lease-test-'));
  execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
  const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
  mkdirSync(worktreePath, { recursive: true });
  roots.push(projectRoot);
  return { projectRoot, worktreePath };
}

function lockDirFor(projectRoot: string, worktreePath: string): string {
  const lockKey = createHash('sha256').update(resolve(worktreePath)).digest('hex');
  return join(projectRoot, '.psyche', 'runtime', 'worktree-locks', `${lockKey}.lock`);
}

describe('worktree operation lease', () => {
  it('waits for a live owner before acquiring the same worktree lease', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'reuse' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101,
        createNonce: () => 'first-owner',
      },
    );

    let secondAcquired = false;
    const secondPromise = acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 101 || pid === 202,
        pollIntervalMs: 5,
        timeoutMs: 1_000,
        createNonce: () => 'second-owner',
      },
    ).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(secondAcquired).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(second.canonicalWorktreePath).toBe(resolve(worktreePath));
    await second.release();
  });

  it('quarantines a dead owner and recovers its lease', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const stale = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'reuse' },
      {
        pid: 101,
        isProcessAlive: () => false,
        createNonce: () => 'stale-owner',
      },
    );

    const recovered = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        createNonce: () => 'recovered-owner',
      },
    );

    const lockDir = lockDirFor(projectRoot, worktreePath);
    const record = JSON.parse(
      readFileSync(join(lockDir, 'lease.json'), 'utf8'),
    ) as WorktreeOperationLeaseRecord;
    expect(record).toMatchObject({
      pid: 202,
      nonce: 'recovered-owner',
      canonicalPath: resolve(worktreePath),
      operation: 'cleanup',
    });
    expect(record.acquiredAt).toEqual(expect.any(String));
    expect(existsSync(`${lockDir.replace(/\.lock$/, '')}.stale.stale-owner`)).toBe(true);

    await stale.release();
    await recovered.release();
  });

  it('does not release a lease replaced by a different nonce', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'reuse' },
      {
        pid: 101,
        isProcessAlive: () => false,
        createNonce: () => 'first-owner',
      },
    );
    const replacement = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        createNonce: () => 'replacement-owner',
      },
    );

    await first.release();

    const lockDir = lockDirFor(projectRoot, worktreePath);
    const record = JSON.parse(
      readFileSync(join(lockDir, 'lease.json'), 'utf8'),
    ) as WorktreeOperationLeaseRecord;
    expect(record.nonce).toBe('replacement-owner');

    await replacement.release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it('recovers a live reused PID when its process-start identity changed', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    let firstOwnerIdentity = 'first-start';
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'create' },
      {
        pid: 101,
        isProcessAlive: () => true,
        getProcessStartIdentity: () => firstOwnerIdentity,
        createNonce: () => 'first-owner',
      },
    );

    firstOwnerIdentity = 'reused-pid-start';
    const recovered = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: () => true,
        getProcessStartIdentity: (pid) => (
          pid === 101 ? firstOwnerIdentity : 'second-start'
        ),
        createNonce: () => 'recovered-owner',
      },
    );

    const lockDir = lockDirFor(projectRoot, worktreePath);
    const record = JSON.parse(
      readFileSync(join(lockDir, 'lease.json'), 'utf8'),
    ) as WorktreeOperationLeaseRecord;
    expect(record).toMatchObject({
      pid: 202,
      nonce: 'recovered-owner',
      processStartIdentity: 'second-start',
    });
    expect(existsSync(`${lockDir.replace(/\.lock$/, '')}.stale.first-owner`)).toBe(true);

    await first.release();
    await recovered.release();
  });

  it('does not steal a lease when a live PID has the matching start identity', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'create' },
      {
        pid: 101,
        isProcessAlive: () => true,
        getProcessStartIdentity: () => 'same-start',
        createNonce: () => 'first-owner',
      },
    );

    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: () => true,
        getProcessStartIdentity: () => 'same-start',
        pollIntervalMs: 5,
        timeoutMs: 25,
        createNonce: () => 'second-owner',
      },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);

    const lockDir = lockDirFor(projectRoot, worktreePath);
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(`${lockDir.replace(/\.lock$/, '')}.stale.first-owner`)).toBe(false);
    await first.release();
  });
});
