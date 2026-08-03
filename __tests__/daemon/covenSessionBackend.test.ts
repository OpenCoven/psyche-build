import { describe, expect, it, vi } from 'vitest';
import {
  composeLaneBackends,
  createCovenSessionBackend,
} from '../../src/orchestration/covenSessionBackend.js';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';

const ROOT = process.cwd();

function lane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'coven',
    mode: 'coven-session',
    harness: 'codex',
    taskId: 'task-1',
    traceId: 'trace-1',
    index: 0,
    projectRoot: ROOT,
    cwd: ROOT,
    prompt: 'Fix the failing tests',
    ...overrides,
  } as never;
}

function session(id: string) {
  return {
    id,
    projectRoot: ROOT,
    harness: 'codex',
    title: 'Fix the failing tests',
    status: 'running',
  };
}

function clientWith(launchSession: unknown) {
  return { listSessions: async () => [], launchSession } as never;
}

describe('createCovenSessionBackend', () => {
  it('launches a session and returns its id as the lane result', async () => {
    const launchSession = vi.fn(async () => session('session-9'));
    const backend = createCovenSessionBackend({ client: clientWith(launchSession) });

    const output = await backend.execute(lane());

    expect(output.sessionId).toBe('session-9');
    // No pane: Coven owns the process, so there is no local pane to report.
    expect(output.pane).toBeUndefined();
    expect(backend.sessions().get('coven')?.id).toBe('session-9');
  });

  it('passes the lane harness, prompt, and cwd to Coven', async () => {
    const launchSession = vi.fn(async (_request: Record<string, unknown>) => session('s'));
    const backend = createCovenSessionBackend({ client: clientWith(launchSession) });

    await backend.execute(lane({ title: 'Auth work' }));

    expect(launchSession.mock.calls[0][0]).toMatchObject({
      harness: 'codex',
      prompt: 'Fix the failing tests',
      title: 'Auth work',
      projectRoot: ROOT,
    });
  });

  // The planner enforces this, but a hand-built lane would otherwise reach
  // Coven with no harness and fail somewhere far less legible.
  it('refuses a coven lane that names no harness', async () => {
    const launchSession = vi.fn();
    const backend = createCovenSessionBackend({ client: clientWith(launchSession) });

    await expect(backend.execute(lane({ harness: undefined })))
      .rejects.toMatchObject({ code: 'invalid_orchestration_request' });
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('refuses lanes that are not coven-session', async () => {
    const backend = createCovenSessionBackend({ client: clientWith(vi.fn()) });
    await expect(backend.execute(lane({ mode: 'isolated-worktree' })))
      .rejects.toMatchObject({ code: 'unsupported_lane_mode' });
  });

  // Coven missing is the common case on a machine without the daemon. The
  // original message is what tells the caller to start it.
  it('surfaces a Coven failure with its original message', async () => {
    const backend = createCovenSessionBackend({
      client: { listSessions: async () => [] } as never,
    });

    await expect(backend.execute(lane())).rejects.toMatchObject({
      code: 'lane_execution_failed',
      message: expect.stringContaining('does not support launching'),
    });
  });
});

describe('composeLaneBackends', () => {
  it('routes each lane to the backend owning its mode', async () => {
    const panes = vi.fn(async () => ({ pane: { id: 'p' } as never }));
    const coven = vi.fn(async () => ({ sessionId: 'session-1' }));
    const route = composeLaneBackends({
      'isolated-worktree': panes,
      'coven-session': coven,
    });

    await route(lane({ id: 'a', mode: 'isolated-worktree', agent: 'codex' }));
    await route(lane({ id: 'b', mode: 'coven-session' }));

    expect(panes).toHaveBeenCalledTimes(1);
    expect(coven).toHaveBeenCalledTimes(1);
  });

  it('reports a single legible error for an unrouted mode', async () => {
    const route = composeLaneBackends({ 'isolated-worktree': vi.fn() });
    await expect(route(lane({ mode: 'terminal' })))
      .rejects.toMatchObject({ code: 'unsupported_lane_mode' });
  });

  // The payoff: one task spanning local panes and Coven sessions, with each
  // backend unaware of the other.
  it('runs a mixed task through the orchestrator', async () => {
    const panes = vi.fn(async () => ({ pane: { id: 'pane-1' } as never }));
    const coven = vi.fn(async () => ({ sessionId: 'session-1' }));
    const orchestrator = new Orchestrator({
      executeLane: composeLaneBackends({
        'isolated-worktree': panes,
        'coven-session': coven,
      }),
    });

    const result = await orchestrator.execute({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'Fix the failing tests',
      lanes: [
        { id: 'local', mode: 'isolated-worktree', agent: 'coven-code' },
        { id: 'managed', mode: 'coven-session', harness: 'codex' },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.lanes[0]).toMatchObject({ id: 'local', status: 'completed' });
    expect(result.lanes[1]).toMatchObject({ id: 'managed', status: 'completed', sessionId: 'session-1' });
  });

  it('reports partial when the Coven half fails and the local half succeeds', async () => {
    const orchestrator = new Orchestrator({
      executeLane: composeLaneBackends({
        'isolated-worktree': vi.fn(async () => ({ pane: { id: 'pane-1' } as never })),
        'coven-session': vi.fn(async () => { throw new Error('coven daemon is not running'); }),
      }),
    });

    const result = await orchestrator.execute({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'p',
      lanes: [
        { id: 'local', mode: 'isolated-worktree', agent: 'coven-code' },
        { id: 'managed', mode: 'coven-session', harness: 'codex' },
      ],
    });

    expect(result.status).toBe('partial');
    expect(result.lanes[1]).toMatchObject({
      status: 'failed',
      error: { message: 'coven daemon is not running' },
    });
  });
});
