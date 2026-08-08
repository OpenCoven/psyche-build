import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runGitMutationWithSupervisor,
} from '../src/services/GitMutationSupervisor.js';
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
});
