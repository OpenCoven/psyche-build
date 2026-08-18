import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDaemonOrchestrator } from '../../src/daemon/orchestrationBackend.js';
import type { CovenSessionSummary } from '../../src/daemon/protocol.js';
import type {
  OrchestrationLaneMode,
  OrchestrationTaskRequest,
} from '../../src/orchestration/types.js';

let root = '';
const BRANCH = 'main';

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.orchestration-backend-test-'));
  runGit(['init'], root);
  runGit(['config', 'user.name', 'Test User'], root);
  runGit(['config', 'user.email', 'test@example.invalid'], root);
  runGit(['checkout', '-b', BRANCH], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# Test repo\n');
  runGit(['add', 'README.md'], root);
  runGit(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init'], root);
  root = fs.realpathSync.native(root);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function requestWithLaneMode(mode: OrchestrationLaneMode): OrchestrationTaskRequest {
  return {
    taskId: `task-${mode}`,
    projectRoot: root,
    prompt: 'Fix the failing tests',
    lanes: [{
      id: `lane-${mode}`,
      mode,
      ...(mode === 'isolated-worktree' ? { agent: 'codex' as const } : {}),
      ...(mode === 'shared-worktree'
        ? {
            existingWorktree: {
              slug: 'orchestration-follow-up',
              worktreePath: root,
              branchName: BRANCH,
            },
          }
        : {}),
      ...(mode === 'coven-session' ? { harness: 'codex' } : {}),
    }],
  };
}

function spawnResult() {
  return {
    id: '%1',
    pane: {
      id: '%1',
      cwd: root,
      branch: BRANCH,
      agent: 'codex',
      title: 'Fix the failing tests',
    },
    worktreePath: root,
    branch: BRANCH,
  };
}

function covenSession(): CovenSessionSummary {
  return {
    id: 'session-1',
    projectRoot: root,
    harness: 'codex',
    title: 'Fix the failing tests',
    status: 'running',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

describe('createDaemonOrchestrator', () => {
  it.each([
    'isolated-worktree',
    'terminal',
    'shared-worktree',
  ] as const)('routes %s lanes through the bridge pane backend', async (mode) => {
    const spawnPane = vi.fn(async () => spawnResult());
    const launchSession = vi.fn(async () => covenSession());
    const orchestrator = createDaemonOrchestrator({
      sessionName: 'psyche-repo',
      spawnPane,
      covenClient: {
        listSessions: async () => [],
        launchSession,
      },
    });

    const result = await orchestrator.execute(requestWithLaneMode(mode));

    expect(result.status).toBe('completed');
    expect(result.lanes).toEqual([
      expect.objectContaining({ id: `lane-${mode}`, status: 'completed' }),
    ]);
    expect(spawnPane).toHaveBeenCalledTimes(1);
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('preserves bridge pane correlation identity in the lane result', async () => {
    const orchestrator = createDaemonOrchestrator({
      sessionName: 'psyche-repo',
      spawnPane: vi.fn(async () => spawnResult()),
      covenClient: { listSessions: async () => [] },
    });

    const result = await orchestrator.execute(requestWithLaneMode('isolated-worktree'));

    expect(result.lanes[0]).toMatchObject({
      id: 'lane-isolated-worktree',
      status: 'completed',
      pane: {
        id: '%1',
        paneId: '%1',
        worktreePath: root,
        branchName: BRANCH,
      },
    });
  });

  it('routes coven-session lanes through the Coven backend', async () => {
    const spawnPane = vi.fn(async () => spawnResult());
    const launchSession = vi.fn(async () => covenSession());
    const orchestrator = createDaemonOrchestrator({
      sessionName: 'psyche-repo',
      spawnPane,
      covenClient: {
        listSessions: async () => [],
        launchSession,
      },
    });

    const result = await orchestrator.execute(requestWithLaneMode('coven-session'));

    expect(result.status).toBe('completed');
    expect(result.lanes).toEqual([
      expect.objectContaining({
        id: 'lane-coven-session',
        status: 'completed',
        sessionId: 'session-1',
      }),
    ]);
    expect(launchSession).toHaveBeenCalledTimes(1);
    expect(spawnPane).not.toHaveBeenCalled();
  });

  it('does not complete a lane when its selected backend fails', async () => {
    const spawnPane = vi.fn(async () => {
      throw new Error('pane launch failed');
    });
    const orchestrator = createDaemonOrchestrator({
      sessionName: 'psyche-repo',
      spawnPane,
      covenClient: { listSessions: async () => [] },
    });

    const result = await orchestrator.execute(requestWithLaneMode('terminal'));

    expect(spawnPane).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.lanes).toEqual([
      expect.objectContaining({
        id: 'lane-terminal',
        status: 'failed',
        error: expect.objectContaining({ message: 'pane launch failed' }),
      }),
    ]);
  });
});
