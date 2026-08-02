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
    pane: {} as never,
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

  // spawnBridgePane always creates a fresh worktree. Silently making a second
  // one when the caller asked to share an existing one would be worse than
  // refusing.
  it('refuses shared-worktree lanes rather than creating a second worktree', async () => {
    const spawnPane = vi.fn();
    const backend = createBridgePaneBackend({ sessionName: 's', spawnPane });

    await expect(backend.execute(lane({
      mode: 'shared-worktree',
      existingWorktree: { slug: 's', worktreePath: '/w', branchName: 'b' },
    }))).rejects.toMatchObject({ code: 'unsupported_lane_mode' });
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
