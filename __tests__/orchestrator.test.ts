import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/orchestration/orchestrator.js';
import { OrchestrationError } from '../src/orchestration/types.js';
import type { OrchestrationTaskRequest } from '../src/orchestration/types.js';

const ROOT = process.cwd();

function task(overrides: Partial<OrchestrationTaskRequest> = {}): OrchestrationTaskRequest {
  return {
    taskId: 'task-1',
    projectRoot: ROOT,
    prompt: 'Fix the failing tests',
    lanes: [{ id: 'a', mode: 'terminal' }],
    ...overrides,
  };
}

/** Deterministic clock so timestamps are assertable. */
function clock() {
  let tick = 0;
  return () => `2026-08-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Orchestrator', () => {
  it('returns one result per lane, in request order', async () => {
    const orchestrator = new Orchestrator({
      executeLane: async () => ({}),
      clock: clock(),
    });

    const result = await orchestrator.execute(task({
      lanes: [
        { id: 'one', mode: 'terminal' },
        { id: 'two', mode: 'terminal' },
        { id: 'three', mode: 'terminal' },
      ],
    }));

    expect(result.lanes.map((lane) => lane.id)).toEqual(['one', 'two', 'three']);
    expect(result.status).toBe('completed');
    expect(result.taskId).toBe('task-1');
  });

  // Order must hold even when lanes finish out of order — the slowest lane
  // first is the case a naive push-as-they-settle implementation gets wrong.
  it('preserves request order when lanes settle out of order', async () => {
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => {
        await sleep(lane.id === 'slow' ? 40 : 1);
        return {};
      },
    });

    const result = await orchestrator.execute(task({
      lanes: [
        { id: 'slow', mode: 'terminal' },
        { id: 'fast', mode: 'terminal' },
      ],
    }));

    expect(result.lanes.map((lane) => lane.id)).toEqual(['slow', 'fast']);
  });

  it('never runs more lanes at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const orchestrator = new Orchestrator({
      executeLane: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(10);
        active -= 1;
        return {};
      },
    });

    await orchestrator.execute(task({
      concurrency: 2,
      lanes: Array.from({ length: 6 }, (_, i) => ({ id: `lane-${i}`, mode: 'terminal' as const })),
    }));

    expect(peak).toBe(2);
  });

  it('still runs every lane when concurrency is below the lane count', async () => {
    const seen: string[] = [];
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => {
        seen.push(lane.id);
        return {};
      },
    });

    await orchestrator.execute(task({
      concurrency: 1,
      lanes: Array.from({ length: 5 }, (_, i) => ({ id: `lane-${i}`, mode: 'terminal' as const })),
    }));

    expect(seen).toHaveLength(5);
  });

  it('checks authority immediately before every lane effect', async () => {
    const effects: string[] = [];
    let authorized = true;
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => {
        effects.push(lane.id);
        authorized = false;
        return {};
      },
    });

    const result = await orchestrator.execute(task({
      concurrency: 1,
      lanes: [
        { id: 'first', mode: 'terminal' },
        { id: 'second', mode: 'terminal' },
      ],
    }), {
      beforeLaneEffect: () => {
        if (!authorized) throw Object.assign(new Error('lease revoked'), { code: 'lease_missing' });
      },
    });

    expect(effects).toEqual(['first']);
    expect(result).toMatchObject({
      status: 'partial',
      lanes: [
        { id: 'first', status: 'completed' },
        {
          id: 'second',
          status: 'failed',
          error: { code: 'lease_missing', message: 'lease revoked' },
        },
      ],
    });
  });

  it('does not pre-authorize concurrent lane effects', async () => {
    const effects: string[] = [];
    let authorized = true;
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => {
        effects.push(lane.id);
        authorized = false;
        return {};
      },
    });

    const result = await orchestrator.execute(task({
      concurrency: 2,
      lanes: [
        { id: 'first', mode: 'terminal' },
        { id: 'second', mode: 'terminal' },
      ],
    }), {
      beforeLaneEffect: () => {
        if (!authorized) throw Object.assign(new Error('lease revoked'), { code: 'lease_missing' });
      },
    });

    expect(effects).toEqual(['first']);
    expect(result).toMatchObject({
      status: 'partial',
      lanes: [
        { id: 'first', status: 'completed' },
        { id: 'second', status: 'failed', error: { code: 'lease_missing' } },
      ],
    });
  });

  it('uses effect_unknown when a later authority failure has no stable code', async () => {
    let checks = 0;
    const orchestrator = new Orchestrator({
      executeLane: async (lane) => ({
        pane: { id: `pane-${lane.id}`, slug: lane.id } as never,
      }),
    });

    const result = await orchestrator.execute(task({
      concurrency: 1,
      lanes: [
        { id: 'completed', mode: 'terminal' },
        { id: 'unstarted', mode: 'terminal' },
      ],
    }), {
      beforeLaneEffect: () => {
        checks += 1;
        if (checks === 2) throw new Error('authorization state unavailable');
      },
    });

    expect(result).toMatchObject({
      status: 'partial',
      lanes: [
        {
          id: 'completed',
          status: 'completed',
          pane: { id: 'pane-completed' },
        },
        {
          id: 'unstarted',
          status: 'failed',
          error: {
            code: 'effect_unknown',
            message: 'authorization state unavailable',
          },
        },
      ],
    });
  });

  describe('outcome aggregation', () => {
    it('reports completed when every lane succeeds', async () => {
      const orchestrator = new Orchestrator({ executeLane: async () => ({}) });
      const result = await orchestrator.execute(task());
      expect(result.status).toBe('completed');
    });

    it('counts a warning lane as completed and preserves its warning', async () => {
      const pane = { id: 'pane-a', slug: 'pane-a' } as never;
      const warning = {
        code: 'orchestration_persistence_failed' as const,
        message: 'Pane launched, but orchestration metadata persistence failed: disk full',
      };
      const orchestrator = new Orchestrator({
        executeLane: async () => ({ pane, warnings: [warning] }),
      });

      const result = await orchestrator.execute(task());
      const completed = result.lanes.filter((lane) => lane.status === 'completed');
      const failed = result.lanes.filter((lane) => lane.status === 'failed');

      expect(result.status).toBe('completed');
      expect(completed).toHaveLength(1);
      expect(failed).toHaveLength(0);
      expect(completed[0]).toMatchObject({ pane, warnings: [warning] });
    });

    it('reports partial when some lanes fail, keeping the successes usable', async () => {
      const orchestrator = new Orchestrator({
        executeLane: async (lane) => {
          if (lane.id === 'bad') throw new Error('boom');
          return { pane: { id: `pane-${lane.id}` } as never };
        },
      });

      const result = await orchestrator.execute(task({
        lanes: [
          { id: 'good', mode: 'terminal' },
          { id: 'bad', mode: 'terminal' },
        ],
      }));

      expect(result.status).toBe('partial');
      expect(result.lanes[0]).toMatchObject({ id: 'good', status: 'completed' });
      expect(result.lanes[1]).toMatchObject({
        id: 'bad',
        status: 'failed',
        error: { code: 'lane_execution_failed', message: 'boom' },
      });
    });

    it('reports failed when every lane fails', async () => {
      const orchestrator = new Orchestrator({
        executeLane: async () => { throw new Error('nope'); },
      });

      const result = await orchestrator.execute(task({
        lanes: [
          { id: 'a', mode: 'terminal' },
          { id: 'b', mode: 'terminal' },
        ],
      }));

      expect(result.status).toBe('failed');
      expect(result.lanes.every((lane) => lane.status === 'failed')).toBe(true);
    });

    // A failing lane must not cancel its siblings — the whole point of the
    // partial outcome is that surviving lanes stay available for inspection.
    it('runs every sibling lane even when an early lane throws', async () => {
      const executed: string[] = [];
      const orchestrator = new Orchestrator({
        executeLane: async (lane) => {
          executed.push(lane.id);
          if (lane.id === 'a') throw new Error('boom');
          return {};
        },
      });

      const result = await orchestrator.execute(task({
        concurrency: 1,
        lanes: [
          { id: 'a', mode: 'terminal' },
          { id: 'b', mode: 'terminal' },
          { id: 'c', mode: 'terminal' },
        ],
      }));

      expect(executed).toEqual(['a', 'b', 'c']);
      expect(result.lanes.filter((lane) => lane.status === 'completed')).toHaveLength(2);
    });
  });

  describe('error normalization', () => {
    it('preserves an OrchestrationError code raised by the backend', async () => {
      const orchestrator = new Orchestrator({
        executeLane: async () => {
          throw new OrchestrationError('project_scope_violation', 'outside the project');
        },
      });

      const result = await orchestrator.execute(task());
      expect(result.lanes[0]).toMatchObject({
        status: 'failed',
        error: { code: 'project_scope_violation', message: 'outside the project' },
      });
    });

    it('normalizes a non-Error throw into a lane failure', async () => {
      const orchestrator = new Orchestrator({
        executeLane: async () => { throw 'just a string'; },
      });

      const result = await orchestrator.execute(task());
      expect(result.lanes[0]).toMatchObject({
        status: 'failed',
        error: { code: 'lane_execution_failed', message: 'just a string' },
      });
    });
  });

  describe('validation', () => {
    // Planning must happen before any lane starts, so a bad request cannot
    // leave half a task's worth of worktrees behind.
    it('rejects an invalid request without executing any lane', async () => {
      const executeLane = vi.fn(async () => ({}));
      const orchestrator = new Orchestrator({ executeLane });

      await expect(orchestrator.execute(task({ lanes: [] })))
        .rejects.toBeInstanceOf(OrchestrationError);
      expect(executeLane).not.toHaveBeenCalled();
    });

    it('rejects duplicate lane ids before executing any lane', async () => {
      const executeLane = vi.fn(async () => ({}));
      const orchestrator = new Orchestrator({ executeLane });

      await expect(orchestrator.execute(task({
        lanes: [
          { id: 'same', mode: 'terminal' },
          { id: 'same', mode: 'terminal' },
        ],
      }))).rejects.toBeInstanceOf(OrchestrationError);
      expect(executeLane).not.toHaveBeenCalled();
    });
  });

  it('carries backend output onto the lane result', async () => {
    const pane = { id: 'psyche-1', slug: 'fix' } as never;
    const orchestrator = new Orchestrator({
      executeLane: async () => ({ pane, sessionId: 'session-9' }),
    });

    const result = await orchestrator.execute(task());
    expect(result.lanes[0]).toMatchObject({ status: 'completed', pane, sessionId: 'session-9' });
  });

  it('stamps task and lane timestamps from the injected clock', async () => {
    const orchestrator = new Orchestrator({
      executeLane: async () => ({}),
      clock: clock(),
    });

    const result = await orchestrator.execute(task());

    expect(result.startedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(result.lanes[0].startedAt).toBeDefined();
    expect(result.lanes[0].completedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
  });

  it('propagates the resolved trace id', async () => {
    const orchestrator = new Orchestrator({ executeLane: async () => ({}) });
    const result = await orchestrator.execute(task({ traceId: 'trace-7' }));
    expect(result.traceId).toBe('trace-7');
  });
});
