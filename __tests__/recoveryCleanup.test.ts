import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertRecoveryCleanupEnvironment,
  awaitCleanupQuiescence,
  RecoveryCleanupRetentionError,
} from '../src/diagnostics/recoveryCleanup.js';
import { acquireProjectWorktreeLifecycleLease } from '../src/services/WorktreeOperationLease.js';

describe('cleanup harness failure boundaries', () => {
  it.each([
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
  ])('rejects ambient %s before discovering a worktree lease', (key) => {
    expect(() => assertRecoveryCleanupEnvironment({ [key]: 'private-value' }))
      .toThrow('Recovery cleanup requires an environment without Git repository overrides');
    expect(() => assertRecoveryCleanupEnvironment({ [key]: '' })).toThrow();
  });

  it('allows ordinary environment and non-routing Git controls', () => {
    expect(() => assertRecoveryCleanupEnvironment({
      PATH: '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    })).not.toThrow();
  });

  it('refuses disposal while a live lifecycle lease is held, then confirms quiescence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-cleanup-barrier-'));
    const work = path.join(root, 'sentinel');
    await writeFile(work, 'preserve');
    const lease = await acquireProjectWorktreeLifecycleLease({
      projectRoot: root, operation: 'live-mutation',
    });
    try {
      await expect(awaitCleanupQuiescence(root, 50))
        .rejects.toBeInstanceOf(RecoveryCleanupRetentionError);
      expect(await readFile(work, 'utf8')).toBe('preserve');
    } finally {
      await lease.release();
      await awaitCleanupQuiescence(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});
