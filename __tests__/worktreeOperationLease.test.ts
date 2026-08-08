import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProjectWorktreeLifecycleLease,
  acquireWorktreeOperationLease,
  claimPendingGitMutationLease,
  clearPendingGitMutationLease,
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
  it('serializes cleanup and resume across root and child worktree paths', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const childWorktreePath = join(worktreePath, 'child-repo');
    mkdirSync(childWorktreePath, { recursive: true });
    const cleanup = await acquireProjectWorktreeLifecycleLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101,
        createNonce: () => 'cleanup-owner',
      },
    );

    let resumeAcquired = false;
    const resumePromise = acquireProjectWorktreeLifecycleLease(
      { projectRoot, worktreePath: childWorktreePath, operation: 'resume' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 101 || pid === 202,
        pollIntervalMs: 5,
        timeoutMs: 1_000,
        createNonce: () => 'resume-owner',
      },
    ).then((lease) => {
      resumeAcquired = true;
      return lease;
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    expect(resumeAcquired).toBe(false);

    await cleanup.release();
    const resume = await resumePromise;
    expect(resume.canonicalProjectRoot).toBe(resolve(projectRoot));
    await resume.release();
  });

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

  it('shares a lease for planned paths below a symlinked ancestor', async () => {
    const { projectRoot } = createLeaseTarget();
    const realRoot = join(projectRoot, 'real-worktrees');
    const symlinkRoot = join(projectRoot, 'worktrees-alias');
    mkdirSync(realRoot);
    symlinkSync(realRoot, symlinkRoot);
    const realPlannedPath = join(realRoot, 'new-worktree');
    const symlinkPlannedPath = join(symlinkRoot, 'new-worktree');
    const canonicalPlannedPath = join(realpathSync.native(realRoot), 'new-worktree');

    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath: realPlannedPath, operation: 'create' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101,
        createNonce: () => 'first-owner',
      },
    );
    expect(first.canonicalWorktreePath).toBe(canonicalPlannedPath);

    let secondAcquired = false;
    const secondPromise = acquireWorktreeOperationLease(
      { projectRoot, worktreePath: symlinkPlannedPath, operation: 'cleanup' },
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
    expect(second.canonicalWorktreePath).toBe(canonicalPlannedPath);
    expect(second.lockDir).toBe(first.lockDir);
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

  it('does not steal a dead parent lease while its tracked Git child is live', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101 || pid === 303,
        getProcessStartIdentity: (pid) => (
          pid === 101 ? 'parent-start' : pid === 303 ? 'git-child-start' : undefined
        ),
        createNonce: () => 'first-owner',
      },
    );
    const child = await first.trackChildProcess(303);

    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        // The parent has died, but its direct Git child still owns the
        // destructive operation and must keep the filesystem lease live.
        isProcessAlive: (pid) => pid === 202 || pid === 303,
        getProcessStartIdentity: (pid) => (
          pid === 202 ? 'contender-start' : pid === 303 ? 'git-child-start' : undefined
        ),
        pollIntervalMs: 5,
        timeoutMs: 25,
        createNonce: () => 'contender',
      },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);

    const childRecord = JSON.parse(readFileSync(
      join(lockDirFor(projectRoot, worktreePath), 'child.first-owner.json'),
      'utf8',
    ));
    expect(childRecord).toMatchObject({
      nonce: 'first-owner',
      pid: child.pid,
      processStartIdentity: child.processStartIdentity,
    });
    await first.clearChildProcess(child);
    await first.release();
  });

  it('recovers a dead-parent lease after its tracked Git child exits', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    let childAlive = true;
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101 || (pid === 303 && childAlive),
        getProcessStartIdentity: (pid) => (
          pid === 101 ? 'parent-start' : pid === 303 ? 'git-child-start' : undefined
        ),
        createNonce: () => 'first-owner',
      },
    );
    await first.trackChildProcess(303);
    childAlive = false;

    const recovered = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        getProcessStartIdentity: (pid) => pid === 202 ? 'recovered-start' : undefined,
        createNonce: () => 'recovered-owner',
      },
    );

    expect(JSON.parse(readFileSync(
      join(lockDirFor(projectRoot, worktreePath), 'lease.json'),
      'utf8',
    ))).toMatchObject({ nonce: 'recovered-owner' });
    await first.release();
    await recovered.release();
  });

  it('reclaims a deferred release after its tracked Git child exits while the original owner lives', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    let childAlive = true;
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101 || (pid === 303 && childAlive),
        getProcessStartIdentity: (pid) => (
          pid === 101 ? 'application-start'
            : pid === 303 ? 'git-child-start'
              : undefined
        ),
        createNonce: () => 'deferred-owner',
      },
    );
    await first.trackChildProcess(303);

    // Production callers release once from their finally block. The parent
    // process remains alive, so recovery must be driven by the tracked child,
    // not a second release call after it exits.
    await first.release();
    expect(JSON.parse(readFileSync(
      join(lockDirFor(projectRoot, worktreePath), 'lease.json'),
      'utf8',
    ))).toMatchObject({
      nonce: 'deferred-owner',
      releaseRequested: true,
    });

    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'resume' },
      {
        pid: 202,
        isProcessAlive: (pid) => (
          pid === 101 || pid === 202 || (pid === 303 && childAlive)
        ),
        getProcessStartIdentity: (pid) => (
          pid === 101 ? 'application-start'
            : pid === 202 ? 'contender-start'
              : pid === 303 ? 'git-child-start'
                : undefined
        ),
        pollIntervalMs: 5,
        timeoutMs: 25,
        createNonce: () => 'contender',
      },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);

    childAlive = false;
    const contender = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'resume' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 101 || pid === 202,
        getProcessStartIdentity: (pid) => (
          pid === 101 ? 'application-start'
            : pid === 202 ? 'contender-start'
              : undefined
        ),
        createNonce: () => 'contender-after-child-exit',
      },
    );

    expect(contender.nonce).toBe('contender-after-child-exit');
    await contender.release();
  });

  it('does not steal a dead-parent lease when the live child identity is uncertain', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101 || pid === 303,
        getProcessStartIdentity: (pid) => (
          pid === 101 ? 'parent-start' : pid === 303 ? 'git-child-start' : undefined
        ),
        createNonce: () => 'first-owner',
      },
    );
    await first.trackChildProcess(303);

    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202 || pid === 303,
        // A permission/transient ps failure cannot be treated as a dead child.
        getProcessStartIdentity: (pid) => pid === 202 ? 'contender-start' : undefined,
        pollIntervalMs: 5,
        timeoutMs: 25,
        createNonce: () => 'contender',
      },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);

    await first.release();
  });

  it('does not let an old nonce clear child metadata from a replacement lease', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: () => false,
        getProcessStartIdentity: (pid) => pid === 303 ? 'first-child-start' : 'first-start',
        createNonce: () => 'first-owner',
      },
    );
    const firstChild = await first.trackChildProcess(303);
    const replacement = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        getProcessStartIdentity: (pid) => pid === 202 ? 'replacement-start' : undefined,
        createNonce: () => 'replacement-owner',
      },
    );

    await first.clearChildProcess(firstChild);
    const lockDir = lockDirFor(projectRoot, worktreePath);
    const record = JSON.parse(
      readFileSync(join(lockDir, 'lease.json'), 'utf8'),
    ) as WorktreeOperationLeaseRecord;
    expect(record.nonce).toBe('replacement-owner');
    expect(existsSync(join(lockDir, 'child.replacement-owner.json'))).toBe(false);
    await first.release();
    await replacement.release();
  });

  it('keeps a dead parent lease unstealable while its supervisor claim is pending', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    let now = new Date('2026-08-07T00:00:00.000Z');
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'create' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101,
        getProcessStartIdentity: () => 'parent-start',
        now: () => now,
        createNonce: () => 'pending-owner',
      },
    );
    await first.preparePendingGitMutation({
      nonce: 'mutation-pending',
      deadline: new Date(now.getTime() + 60_000).toISOString(),
    });

    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        getProcessStartIdentity: (pid) => pid === 202 ? 'contender-start' : undefined,
        now: () => now,
        pollIntervalMs: 5,
        timeoutMs: 25,
        createNonce: () => 'contender',
      },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);

    const record = JSON.parse(readFileSync(
      join(lockDirFor(projectRoot, worktreePath), 'lease.json'),
      'utf8',
    )) as WorktreeOperationLeaseRecord;
    expect(record.pendingMutation).toMatchObject({
      nonce: 'mutation-pending',
      deadline: new Date(now.getTime() + 60_000).toISOString(),
    });
    await first.release();
  });

  it('keeps a dead parent lease unstealable while its claimed supervisor is live', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    let now = new Date('2026-08-07T00:00:00.000Z');
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101,
        getProcessStartIdentity: () => 'parent-start',
        now: () => now,
        createNonce: () => 'supervisor-owner',
      },
    );
    await first.preparePendingGitMutation({
      nonce: 'mutation-supervisor',
      deadline: new Date(now.getTime() + 1).toISOString(),
    });
    await claimPendingGitMutationLease(
      { lockDir: first.lockDir, leaseNonce: first.nonce },
      {
        mutationNonce: 'mutation-supervisor',
        pid: 303,
        processStartIdentity: 'supervisor-start',
        now: () => now,
      },
    );
    now = new Date(now.getTime() + 2);

    await expect(acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202 || pid === 303,
        getProcessStartIdentity: (pid) => (
          pid === 202 ? 'contender-start' : pid === 303 ? 'supervisor-start' : undefined
        ),
        now: () => now,
        pollIntervalMs: 5,
        timeoutMs: 25,
        createNonce: () => 'contender',
      },
    )).rejects.toThrow(/Timed out waiting for worktree operation lease/);
    await first.release();
  });

  it('allows recovery after the supervisor exits and clears its ownership', async () => {
    const { projectRoot, worktreePath } = createLeaseTarget();
    let now = new Date('2026-08-07T00:00:00.000Z');
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'rollback' },
      {
        pid: 101,
        isProcessAlive: (pid) => pid === 101,
        getProcessStartIdentity: () => 'parent-start',
        now: () => now,
        createNonce: () => 'supervisor-owner',
      },
    );
    await first.preparePendingGitMutation({
      nonce: 'mutation-complete',
      deadline: new Date(now.getTime() + 1).toISOString(),
    });
    const supervisor = await claimPendingGitMutationLease(
      { lockDir: first.lockDir, leaseNonce: first.nonce },
      {
        mutationNonce: 'mutation-complete',
        pid: 303,
        processStartIdentity: 'supervisor-start',
        now: () => now,
      },
    );
    now = new Date(now.getTime() + 2);
    await clearPendingGitMutationLease(
      { lockDir: first.lockDir, leaseNonce: first.nonce },
      {
        mutationNonce: 'mutation-complete',
        supervisor,
      },
    );

    const recovered = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        getProcessStartIdentity: (pid) => pid === 202 ? 'contender-start' : undefined,
        now: () => now,
        createNonce: () => 'contender',
      },
    );
    expect(JSON.parse(readFileSync(
      join(lockDirFor(projectRoot, worktreePath), 'lease.json'),
      'utf8',
    ))).toMatchObject({ nonce: 'contender' });
    await first.release();
    await recovered.release();
  });
});
