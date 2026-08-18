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
    worktreePath: `/w/${id}`,
    branch: `psyche/${id}`,
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
      requestId: 'task-1:codex',
      cwd: ROOT,
      agent: 'codex',
      prompt: 'Fix the failing tests',
    });
    expect(backend.spawned().get('codex')).toMatchObject({ id: '%codex' });
  });

  it('forwards the lane permission mode to the bridge spawn request', async () => {
    const spawnPane = vi.fn(async () => spawnResult('codex'));
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await backend.execute(lane({ permissionMode: 'plan' }));

    expect((spawnPane.mock.calls[0] as any[])[2].permissionMode).toBe('plan');
  });

  it('returns the created pane, worktree, and branch identity', async () => {
    const backend = createBridgePaneBackend({
      sessionName: 's',
      spawnPane: vi.fn(async () => spawnResult('codex')),
    });

    const output = await backend.execute(lane());

    expect(output.pane).toMatchObject({
      id: '%codex',
      paneId: '%codex',
      worktreePath: '/w/codex',
      branchName: 'psyche/codex',
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
      projectRoot: ROOT,
      prompt: 'Fix the failing tests',
      lanes: [
        { id: 'coven-code', mode: 'isolated-worktree', agent: 'coven-code' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
    });

    expect(result.status).toBe('completed');
    expect(spawnPane).toHaveBeenCalledTimes(2);
    expect([...backend.spawned().keys()]).toEqual(['coven-code', 'claude']);
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
      projectRoot: ROOT,
      prompt: 'p',
      lanes: [
        { id: 'coven-code', mode: 'isolated-worktree', agent: 'coven-code' },
        { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
      ],
    });

    expect(result.status).toBe('partial');
    expect(backend.spawned().has('coven-code')).toBe(true);
    expect(backend.spawned().has('claude')).toBe(false);
  });
});
