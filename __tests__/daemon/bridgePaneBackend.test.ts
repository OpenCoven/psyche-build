import { describe, expect, it, vi } from 'vitest';
import { createBridgePaneBackend } from '../../src/orchestration/bridgePaneBackend.js';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';

const ROOT = process.cwd();

function lane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'codex',
    mode: 'isolated-worktree',
    agent: 'codex',
    taskId: 'task-1',
    traceId: 'trace-1',
    operationId: 'operation-1',
    index: 0,
    projectRoot: ROOT,
    cwd: ROOT,
    prompt: 'Fix the failing tests',
    ...overrides,
  } as never;
}

function spawnResult(id: string) {
  return {
    id: `%${id}`,
    pane: {
      id: `%${id}`,
      cwd: `/w/${id}`,
      branch: `psyche/${id}`,
      agent: 'codex',
      title: `${id} lane`,
    },
    createdPane: {
      id: `psyche-${id}`,
      slug: id,
      prompt: 'Fix the failing tests',
      paneId: `%${id}`,
    },
    worktreePath: `/w/${id}`,
    branch: `psyche/${id}`,
    persistedPane: {
      id: `pane-${id}`,
      slug: `persisted-${id}`,
      paneId: `%${id}`,
      worktreePath: `/persisted/${id}`,
      branchName: `persisted/${id}`,
    },
  };
}

describe('createBridgePaneBackend', () => {
  it('spawns a bridge pane per lane and keeps the result', async () => {
    const spawnPane = vi.fn(async () => spawnResult('codex'));
    const backend = createBridgePaneBackend({ sessionName: 'psyche-repo', spawnPane });

    await backend.execute(lane());

    const [projectRoot, sessionName, request] = spawnPane.mock.calls[0] as any[];
    expect(projectRoot).toBe(ROOT);
    expect(sessionName).toBe('psyche-repo');
    expect(request).toMatchObject({
      cwd: ROOT,
      agent: 'codex',
      prompt: 'Fix the failing tests',
    });
    expect(request.requestId).toMatch(/^orch-pane-v1-[0-9a-f]{64}$/);
    expect([...backend.spawned().values()][0]).toMatchObject({ id: '%codex' });
  });

  it('uses the same launch identity when the same authoritative operation lane retries', async () => {
    const launches = new Map<string, ReturnType<typeof spawnResult>>();
    const spawnPane = vi.fn(async (_root: string, _session: string, request: { requestId: string }) => {
      const retained = launches.get(request.requestId);
      if (retained) return retained;
      const created = spawnResult(`pane-${launches.size + 1}`);
      launches.set(request.requestId, created);
      return created;
    });
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane: spawnPane as never });

    const first = await backend.execute(lane({ operationId: 'authoritative-operation' }));
    const retry = await backend.execute(lane({ operationId: 'authoritative-operation' }));

    expect((spawnPane.mock.calls[0] as any[])[2].requestId)
      .toBe((spawnPane.mock.calls[1] as any[])[2].requestId);
    expect(retry.pane).toEqual(first.pane);
    expect(launches).toHaveLength(1);
  });

  it('uses a distinct launch identity for another operation with the same task and lane ids', async () => {
    const spawnPane = vi.fn(async () => spawnResult('codex'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await backend.execute(lane({ operationId: 'operation-a' }));
    await backend.execute(lane({ operationId: 'operation-b' }));

    expect((spawnPane.mock.calls[0] as any[])[2].requestId)
      .not.toBe((spawnPane.mock.calls[1] as any[])[2].requestId);
    expect(backend.spawned().size).toBe(2);
  });

  it('forwards the lane permission mode to the bridge spawn request', async () => {
    const spawnPane = vi.fn(async () => spawnResult('codex'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await backend.execute(lane({ permissionMode: 'plan' }));

    expect((spawnPane.mock.calls[0] as any[])[2].permissionMode).toBe('plan');
  });

  it('forwards an explicit empty permission mode to preserve agent defaults', async () => {
    const spawnPane = vi.fn(async () => spawnResult('codex'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await backend.execute(lane({ permissionMode: '' }));

    expect((spawnPane.mock.calls[0] as any[])[2]).toHaveProperty('permissionMode', '');
  });

  it('returns the exact pane identity persisted by the spawn result', async () => {
    const result = spawnResult('codex');
    const backend = createBridgePaneBackend({
      sessionName: 's',
      spawnPane: vi.fn(async () => result),
    });

    const output = await backend.execute(lane());

    expect({
      id: output.pane?.id,
      slug: output.pane?.slug,
      paneId: output.pane?.paneId,
      worktreePath: output.pane?.worktreePath,
      branchName: output.pane?.branchName,
    }).toEqual(result.persistedPane);
  });

  it('returns effect-unknown launches as a partial task with the persisted pane identity', async () => {
    const result = {
      ...spawnResult('codex'),
      warnings: [{
        code: 'effect_unknown' as const,
        message: 'Pane persisted, but command dispatch outcome is unknown',
      }],
    };
    const backend = createBridgePaneBackend({
      sessionName: 's',
      spawnPane: vi.fn(async () => result),
    });
    const orchestrator = new Orchestrator({ executeLane: backend.execute });

    const execution = await orchestrator.execute({
      taskId: 'task-effect-unknown',
      operationId: 'operation-effect-unknown',
      projectRoot: ROOT,
      prompt: 'Run once',
      lanes: [{ id: 'codex', mode: 'isolated-worktree', agent: 'codex' }],
    });

    expect(execution).toMatchObject({
      status: 'partial',
      lanes: [{
        id: 'codex',
        status: 'completed',
        pane: result.persistedPane,
        warnings: [{ code: 'effect_unknown' }],
      }],
    });
  });

  it('can execute without retaining completed spawn summaries', async () => {
    const backend = createBridgePaneBackend({
      sessionName: 's',
      spawnPane: vi.fn(async () => spawnResult('codex')),
      retainResults: false,
    });

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        backend.execute(lane({ id: `lane-${index}` }))),
    );

    expect(backend.spawned().size).toBe(0);
  });

  it('omits the agent for terminal lanes', async () => {
    const spawnPane = vi.fn(async () => spawnResult('t'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await backend.execute(lane({ id: 'term', mode: 'terminal', agent: undefined }));

    expect((spawnPane.mock.calls[0] as any[])[2].agent).toBeUndefined();
  });

  it('uses the lane start point to create a generated branch', async () => {
    const spawnPane = vi.fn(async () => spawnResult('codex'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await backend.execute(lane({ startPointBranch: 'main' }));

    const request = (spawnPane.mock.calls[0] as any[])[2];
    expect(request.startPointBranch).toBe('main');
    expect(request.branch).toBeUndefined();
  });

  it('forwards the existing worktree for shared-worktree lanes', async () => {
    const spawnPane = vi.fn(async () => spawnResult('attached'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });
    const existingWorktree = { slug: 'fix-auth', worktreePath: '/w/fix-auth', branchName: 'psyche/fix-auth' };

    await backend.execute(lane({ mode: 'shared-worktree', existingWorktree }));

    expect((spawnPane.mock.calls[0] as any[])[2].existingWorktree).toEqual(existingWorktree);
  });

  // The planner normally enforces this; the backend re-checks so a hand-built
  // lane cannot reach spawnBridgePane and silently receive a NEW worktree.
  it('refuses a shared-worktree lane that names no worktree', async () => {
    const spawnPane = vi.fn();
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await expect(backend.execute(lane({ mode: 'shared-worktree' })))
      .rejects.toMatchObject({ code: 'invalid_orchestration_request' });
    expect(spawnPane).not.toHaveBeenCalled();
  });

  it('refuses Coven lanes', async () => {
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane: vi.fn() });
    await expect(backend.execute(lane({ mode: 'coven-session', harness: 'codex' })))
      .rejects.toMatchObject({ code: 'unsupported_lane_mode' });
  });

  // The capability the daemon and MCP never had: more than one pane per call.
  it('drives several lanes through the orchestrator', async () => {
    const spawnPane = vi.fn(async (_root: string, _session: string, request: any) =>
      spawnResult(request.agent));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });
    const orchestrator = new Orchestrator({ executeLane: backend.execute });

    const result = await orchestrator.execute({
      taskId: 'task-1',
      operationId: 'operation-multi-lane',
      projectRoot: ROOT,
      prompt: 'Fix the failing tests',
      lanes: [
        { id: 'coven-code', mode: 'isolated-worktree', agent: 'coven-code' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
    });

    expect(result.status).toBe('completed');
    expect(spawnPane).toHaveBeenCalledTimes(2);
    expect([...backend.spawned().values()].map((value) => value.id))
      .toEqual(['%coven-code', '%claude']);
  });

  it('reports a partial task when one lane fails, keeping the other', async () => {
    const spawnPane = vi.fn(async (_root: string, _session: string, request: any) => {
      if (request.agent === 'claude') throw new Error('worktree_create_failed');
      return spawnResult(request.agent);
    });
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });
    const orchestrator = new Orchestrator({ executeLane: backend.execute });

    const result = await orchestrator.execute({
      taskId: 'task-1',
      operationId: 'operation-partial',
      projectRoot: ROOT,
      prompt: 'p',
      lanes: [
        { id: 'coven-code', mode: 'isolated-worktree', agent: 'coven-code' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
    });

    expect(result.status).toBe('partial');
    expect([...backend.spawned().values()].map((value) => value.id))
      .toEqual(['%coven-code']);
  });
});
