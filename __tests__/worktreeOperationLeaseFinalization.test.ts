import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renameRace = vi.hoisted(() => ({
  enabled: false,
  started: undefined as undefined | (() => void),
  continue: Promise.resolve(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameRace.enabled && to.includes('.release-claim.race-owner.')) {
        renameRace.enabled = false;
        renameRace.started?.();
        await renameRace.continue;
      }
      return actual.rename(from, to);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function lockDirFor(projectRoot: string, worktreePath: string): string {
  const lockKey = createHash('sha256').update(resolve(worktreePath)).digest('hex');
  return join(projectRoot, '.psyche', 'runtime', 'worktree-locks', `${lockKey}.lock`);
}

describe('worktree lease finalization', () => {
  it('does not delete a replacement acquired after the old nonce was validated', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-lease-finalize-'));
    roots.push(projectRoot);
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    const worktreePath = join(projectRoot, '.psyche', 'worktrees', 'feature');
    mkdirSync(worktreePath, { recursive: true });
    const { acquireWorktreeOperationLease } = await import(
      '../src/services/WorktreeOperationLease.js'
    );
    const first = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'cleanup' },
      {
        pid: 101,
        isProcessAlive: () => false,
        getProcessStartIdentity: () => 'old-start',
        createNonce: () => 'race-owner',
      },
    );

    let signalRename!: () => void;
    let continueRename!: () => void;
    const renameStarted = new Promise<void>((resolveStarted) => {
      signalRename = resolveStarted;
    });
    renameRace.started = signalRename;
    renameRace.continue = new Promise<void>((resolveContinue) => {
      continueRename = resolveContinue;
    });
    renameRace.enabled = true;

    const release = first.release();
    await renameStarted;
    const replacement = await acquireWorktreeOperationLease(
      { projectRoot, worktreePath, operation: 'resume' },
      {
        pid: 202,
        isProcessAlive: (pid) => pid === 202,
        getProcessStartIdentity: (pid) => pid === 202 ? 'replacement-start' : undefined,
        createNonce: () => 'replacement-owner',
      },
    );
    continueRename();
    await release;

    const lockDir = lockDirFor(projectRoot, worktreePath);
    expect(existsSync(lockDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(lockDir, 'lease.json'), 'utf8')))
      .toMatchObject({ nonce: 'replacement-owner' });
    await replacement.release();
  });
});
