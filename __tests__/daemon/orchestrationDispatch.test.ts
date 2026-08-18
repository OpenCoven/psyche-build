import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchOrchestrationRequest } from '../../src/daemon/bridge.js';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';
import type { OrchestrationLanePlan } from '../../src/orchestration/types.js';
import { buildSinglePaneTaskRequest } from '../../src/orchestration/adapters.js';

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

const FIXED_TIME = '2026-08-01T15:00:00.000Z';

function createMockOrchestrator(
  executeLane: (lane: OrchestrationLanePlan) => Promise<{ pane?: undefined; sessionId?: string }> = async () => ({}),
): Orchestrator {
  return new Orchestrator({
    executeLane,
    clock: () => FIXED_TIME,
  });
}

describe('dispatchOrchestrationRequest', () => {
  it('executes a task through the orchestrator and returns the result', async () => {
    const root = await tempDir('psyche-orch-dispatch-');
    const orchestrator = createMockOrchestrator();

    const request = {
      type: 'orchestration.execute' as const,
      requestId: 'request-1',
      task: {
        taskId: 'task-1',
        projectRoot: root,
        prompt: 'Fix tests',
        lanes: [{ id: 'codex', mode: 'isolated-worktree' as const, agent: 'codex' as const }],
      },
    };

    const response = await dispatchOrchestrationRequest(root, request, orchestrator);

    expect(response).toMatchObject({
      type: 'orchestration.execute.result',
      requestId: 'request-1',
      result: {
        taskId: 'task-1',
        status: 'completed',
      },
    });
    expect(response.result.lanes).toHaveLength(1);
    expect(response.result.lanes[0]).toMatchObject({
      id: 'codex',
      status: 'completed',
    });
  });

  it('keeps the daemon root authoritative when task projectRoot names a subdirectory', async () => {
    const root = await tempDir('psyche-orch-authority-');
    const claimedRoot = path.join(root, 'packages', 'app');
    await mkdir(claimedRoot, { recursive: true });
    let delegatedLane: OrchestrationLanePlan | undefined;
    const orchestrator = createMockOrchestrator(async (lane) => {
      delegatedLane = lane;
      return {};
    });

    await dispatchOrchestrationRequest(
      root,
      {
        type: 'orchestration.execute',
        requestId: 'request-authority',
        task: {
          taskId: 'task-authority',
          projectRoot: claimedRoot,
          prompt: 'Work in app',
          lanes: [{ id: 'lane', mode: 'terminal' }],
        },
      },
      orchestrator,
    );

    expect(delegatedLane).toMatchObject({
      projectRoot: root,
      cwd: claimedRoot,
    });
  });

  it('resolves explicit task cwd relative to the claimed in-scope path', async () => {
    const root = await tempDir('psyche-orch-relative-cwd-');
    const claimedRoot = path.join(root, 'packages', 'app');
    const claimedCwd = path.join(claimedRoot, 'src');
    await mkdir(claimedCwd, { recursive: true });
    let delegatedLane: OrchestrationLanePlan | undefined;
    const orchestrator = createMockOrchestrator(async (lane) => {
      delegatedLane = lane;
      return {};
    });

    await dispatchOrchestrationRequest(
      root,
      {
        type: 'orchestration.execute',
        requestId: 'request-relative-cwd',
        task: {
          taskId: 'task-relative-cwd',
          projectRoot: claimedRoot,
          cwd: 'src',
          prompt: 'Work in src',
          lanes: [{ id: 'lane', mode: 'terminal' }],
        },
      },
      orchestrator,
    );

    expect(delegatedLane).toMatchObject({
      projectRoot: root,
      cwd: claimedCwd,
    });
  });

  it('rejects task projectRoot outside the daemon project root', async () => {
    const root = await tempDir('psyche-orch-scope-');
    const outside = await tempDir('psyche-orch-outside-');
    const orchestrator = createMockOrchestrator();

    const request = {
      type: 'orchestration.execute' as const,
      requestId: 'request-2',
      task: {
        taskId: 'task-2',
        projectRoot: outside,
        prompt: 'Escape attempt',
        lanes: [{ id: 'bad', mode: 'terminal' as const }],
      },
    };

    await expect(
      dispatchOrchestrationRequest(root, request, orchestrator),
    ).rejects.toThrow(/outside the psyche project root/);
  });

  it('rejects task cwd symlink escapes from the claimed path', async () => {
    const root = await tempDir('psyche-orch-symlink-scope-');
    const outside = await tempDir('psyche-orch-symlink-outside-');
    const claimedRoot = path.join(root, 'packages', 'app');
    await mkdir(claimedRoot, { recursive: true });
    await symlink(outside, path.join(claimedRoot, 'escape'), 'dir');
    const orchestrator = createMockOrchestrator();

    const request = {
      type: 'orchestration.execute' as const,
      requestId: 'request-symlink-escape',
      task: {
        taskId: 'task-symlink-escape',
        projectRoot: claimedRoot,
        cwd: 'escape',
        prompt: 'Escape attempt',
        lanes: [{ id: 'bad', mode: 'terminal' as const }],
      },
    };

    await expect(
      dispatchOrchestrationRequest(root, request, orchestrator),
    ).rejects.toThrow(/outside the psyche project root/);
  });

  it('reports partial failure when one lane fails', async () => {
    const root = await tempDir('psyche-orch-partial-');
    const orchestrator = createMockOrchestrator(async (lane) => {
      if (lane.id === 'bad') throw new Error('boom');
      return {};
    });

    const request = {
      type: 'orchestration.execute' as const,
      requestId: 'request-3',
      task: {
        taskId: 'task-3',
        projectRoot: root,
        prompt: 'Partial work',
        lanes: [
          { id: 'good', mode: 'terminal' as const },
          { id: 'bad', mode: 'terminal' as const },
        ],
      },
    };

    const response = await dispatchOrchestrationRequest(root, request, orchestrator);

    expect(response.result.status).toBe('partial');
    expect(response.result.lanes[0]).toMatchObject({
      id: 'good',
      status: 'completed',
    });
    expect(response.result.lanes[1]).toMatchObject({
      id: 'bad',
      status: 'failed',
      error: { code: 'lane_execution_failed', message: 'boom' },
    });
  });

  it('preserves the requestId in the response', async () => {
    const root = await tempDir('psyche-orch-reqid-');
    const orchestrator = createMockOrchestrator();

    const request = {
      type: 'orchestration.execute' as const,
      requestId: 'unique-request-id',
      task: {
        taskId: 'task-4',
        projectRoot: root,
        prompt: 'Work',
        lanes: [{ id: 'lane', mode: 'terminal' as const }],
      },
    };

    const response = await dispatchOrchestrationRequest(root, request, orchestrator);
    expect(response.requestId).toBe('unique-request-id');
  });
});

describe('panes.spawn translation to single lane', () => {
  it('builds a single-pane task request with an agent', () => {
    const request = buildSinglePaneTaskRequest({
      taskId: 'spawn-1',
      projectRoot: '/repo',
      prompt: 'Fix bug',
      agent: 'codex',
    });

    expect(request.lanes).toEqual([
      { id: 'codex', mode: 'isolated-worktree', agent: 'codex' },
    ]);
    expect(request.taskId).toBe('spawn-1');
    expect(request.prompt).toBe('Fix bug');
  });

  it('builds a terminal lane when no agent is given', () => {
    const request = buildSinglePaneTaskRequest({
      taskId: 'spawn-2',
      projectRoot: '/repo',
      prompt: 'Run shell',
    });

    expect(request.lanes).toEqual([
      { id: 'terminal', mode: 'terminal' },
    ]);
  });

  it('produces a task that executes successfully through the orchestrator', async () => {
    const root = await tempDir('psyche-orch-single-');
    const orchestrator = createMockOrchestrator();

    const task = buildSinglePaneTaskRequest({
      taskId: 'spawn-3',
      projectRoot: root,
      prompt: 'Work',
      agent: 'claude',
    });

    const response = await dispatchOrchestrationRequest(
      root,
      { type: 'orchestration.execute', requestId: 'r-spawn', task },
      orchestrator,
    );

    expect(response.result.status).toBe('completed');
    expect(response.result.lanes).toHaveLength(1);
    expect(response.result.lanes[0]).toMatchObject({
      id: 'claude',
      status: 'completed',
    });
  });
});
