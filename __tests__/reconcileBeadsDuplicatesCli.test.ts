import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  parseReconcileDuplicatesCliOptions,
  runReconcileDuplicatesCli,
} from '../scripts/beads-project-sync/reconcile-duplicates-cli.mjs';
import type { GhClient, DuplicateManagedIssueGroup } from '../scripts/beads-project-sync/github.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureConfigPath = join(
  repositoryRoot,
  '__tests__/fixtures/beads-project-sync/canonical-targets-config.json',
);
const token = 'github_pat_DO_NOT_LEAK';

interface CapturedCli {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FakeGhOptions {
  groups?: readonly DuplicateManagedIssueGroup[];
  failAcquireLock?: Error;
}

function createFakeGhClient(options: FakeGhOptions = {}) {
  const groups: DuplicateManagedIssueGroup[] = [...(options.groups ?? [
    { beadId: 'pb-232', survivorIssueNumber: 232, duplicateIssueNumbers: [418] },
  ])];
  const retireCalls: { issueNumber: number; survivorIssueNumber: number; beadId?: string }[] = [];
  let released = false;

  const client: Partial<GhClient> = {
    verifyAccess: vi.fn(async () => ({ organization: {}, repository: {} })),
    detectDuplicateManagedIssues: vi.fn(async () => groups),
    acquireApplyLock: vi.fn(async () => {
      if (options.failAcquireLock) {
        throw options.failAcquireLock;
      }
      return {
        version: 1 as const,
        state: 'acquired' as const,
        owner: 'local-cli',
        runId: 'local-test',
        leaseId: 'lease-test',
        acquiredAt: 0,
        expiresAt: 60_000,
        ref: 'refs/heads/psyche-beads-project-sync-lock' as const,
        sha: 'SHA',
        treeSha: 'TREE',
      };
    }),
    startApplyLockLease: vi.fn(() => ({
      assertOwned: vi.fn(async () => {}),
      failure: () => null,
      release: vi.fn(async () => {
        released = true;
      }),
      renewNow: vi.fn(async () => {
        throw new Error('renewNow should not be called in this test');
      }),
      stop: vi.fn(async () => {}),
    })),
    retireDuplicateIssue: vi.fn(async (operation) => {
      retireCalls.push(operation);
      return { issueNumber: operation.issueNumber, survivorIssueNumber: operation.survivorIssueNumber };
    }),
  };

  return {
    client: client as GhClient,
    retireCalls,
    wasReleased: () => released,
  };
}

async function runCli(
  argv: readonly string[],
  ghOptions: FakeGhOptions = {},
  env: Readonly<Record<string, string | undefined>> = { BEADS_PROJECT_TOKEN: token },
): Promise<CapturedCli & ReturnType<typeof createFakeGhClient>> {
  let stdout = '';
  let stderr = '';
  const fake = createFakeGhClient(ghOptions);

  const exitCode = await runReconcileDuplicatesCli(argv, {
    configPath: fixtureConfigPath,
    env,
    run: (async () => {
      throw new Error('run should not be invoked; createGhClient is stubbed');
    }) as never,
    createGhClient: () => fake.client,
    stdout: { write: (chunk: string) => { stdout += chunk; } },
    stderr: { write: (chunk: string) => { stderr += chunk; } },
  });

  return { exitCode, stdout, stderr, ...fake };
}

describe('parseReconcileDuplicatesCliOptions', () => {
  it('requires --confirm-issue-numbers with --apply', () => {
    expect(() => parseReconcileDuplicatesCliOptions(['--apply'])).toThrow(
      /--confirm-issue-numbers/i,
    );
  });

  it('rejects --confirm-issue-numbers without --apply', () => {
    expect(() => parseReconcileDuplicatesCliOptions(['--confirm-issue-numbers=1,2'])).toThrow(
      /only applies with --apply/i,
    );
  });

  it('rejects a non-numeric confirm token', () => {
    expect(() =>
      parseReconcileDuplicatesCliOptions(['--apply', '--confirm-issue-numbers=1,two']),
    ).toThrow(/non-issue-number token/i);
  });

  it('parses a valid apply invocation', () => {
    expect(
      parseReconcileDuplicatesCliOptions(['--apply', '--confirm-issue-numbers=418, 395']),
    ).toEqual({ apply: true, confirmIssueNumbers: [418, 395] });
  });

  it('rejects unknown arguments', () => {
    expect(() => parseReconcileDuplicatesCliOptions(['--unknown'])).toThrow(/unknown argument/i);
  });
});

describe('runReconcileDuplicatesCli', () => {
  it('prints a read-only plan by default without acquiring a lock', async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(0);
    expect(result.client.acquireApplyLock).not.toHaveBeenCalled();
    expect(result.retireCalls).toEqual([]);
    expect(JSON.parse(result.stdout)).toEqual({
      groups: [{ beadId: 'pb-232', survivorIssueNumber: 232, duplicateIssueNumbers: [418] }],
      plannedDuplicateIssueNumbers: [418],
    });
    expect(result.stderr).toMatch(/--apply --confirm-issue-numbers=418/);
  });

  it('reports no duplicates cleanly', async () => {
    const result = await runCli([], { groups: [] });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/nothing to reconcile/i);
  });

  it('retires every confirmed duplicate and releases the lock', async () => {
    const result = await runCli(['--apply', '--confirm-issue-numbers=418']);

    expect(result.exitCode).toBe(0);
    expect(result.client.acquireApplyLock).toHaveBeenCalledTimes(1);
    expect(result.retireCalls).toEqual([
      { issueNumber: 418, survivorIssueNumber: 232, beadId: 'pb-232' },
    ]);
    expect(result.wasReleased()).toBe(true);
    expect(JSON.parse(result.stdout).retired).toEqual([
      { issueNumber: 418, survivorIssueNumber: 232 },
    ]);
  });

  it('fails closed when the confirmed list omits a currently detected duplicate', async () => {
    const result = await runCli(
      ['--apply', '--confirm-issue-numbers=999'],
      {
        groups: [
          { beadId: 'pb-232', survivorIssueNumber: 232, duplicateIssueNumbers: [418] },
        ],
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.client.acquireApplyLock).not.toHaveBeenCalled();
    expect(result.retireCalls).toEqual([]);
    expect(result.stderr).toMatch(/does not match the freshly detected duplicate plan/i);
    expect(result.stderr).toMatch(/missing from --confirm-issue-numbers: 418/i);
  });

  it('fails closed when the confirmed list includes an issue no longer part of the plan', async () => {
    const result = await runCli(
      ['--apply', '--confirm-issue-numbers=418,999'],
    );

    expect(result.exitCode).toBe(1);
    expect(result.retireCalls).toEqual([]);
    expect(result.stderr).toMatch(/not part of the current detected plan: 999/i);
  });

  it('requires BEADS_PROJECT_TOKEN', async () => {
    const result = await runCli([], {}, {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/BEADS_PROJECT_TOKEN is required/i);
  });

  it('releases the lock even when a retirement fails midway', async () => {
    const fake = createFakeGhClient({
      groups: [
        { beadId: 'pb-232', survivorIssueNumber: 232, duplicateIssueNumbers: [418] },
      ],
    });
    (fake.client.retireDuplicateIssue as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('boom');
      },
    );

    let stderr = '';
    const exitCode = await runReconcileDuplicatesCli(['--apply', '--confirm-issue-numbers=418'], {
      configPath: fixtureConfigPath,
      env: { BEADS_PROJECT_TOKEN: token },
      run: (async () => {
        throw new Error('run should not be invoked');
      }) as never,
      createGhClient: () => fake.client,
      stdout: { write: () => {} },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/boom/);
    expect(fake.wasReleased()).toBe(true);
  });
});
