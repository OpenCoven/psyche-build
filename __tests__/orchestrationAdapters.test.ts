import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildLaneIdsForAgents,
  buildMultiAgentTaskRequest,
  buildSharedWorktreeTaskRequest,
  buildSinglePaneTaskRequest,
} from '../src/orchestration/adapters.js';
import { createLocalPaneBackend } from '../src/orchestration/localPaneBackend.js';
import { planOrchestrationTask } from '../src/orchestration/planner.js';
import type { PsychePane } from '../src/types.js';
import { mutateProjectPaneConfig } from '../src/services/ProjectPaneConfig.js';

const ROOT = process.cwd();

describe('buildLaneIdsForAgents', () => {
  it('uses the bare agent name when it appears once', () => {
    expect(buildLaneIdsForAgents(['codex', 'claude'])).toEqual(['codex', 'claude']);
  });

  it('suffixes only the agents that repeat', () => {
    expect(buildLaneIdsForAgents(['codex', 'claude', 'codex']))
      .toEqual(['codex-1', 'claude', 'codex-2']);
  });

  it('produces unique ids so the planner accepts them', () => {
    const ids = buildLaneIdsForAgents(['codex', 'codex', 'codex']);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('buildMultiAgentTaskRequest', () => {
  it('builds one isolated-worktree lane per agent, in order', () => {
    const request = buildMultiAgentTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'Fix the failing tests',
      agents: ['coven-code', 'claude'],
    });

    expect(request.lanes).toEqual([
      { id: 'coven-code', mode: 'isolated-worktree', agent: 'coven-code' },
      { id: 'claude', mode: 'isolated-worktree', agent: 'claude' },
    ]);
  });

  it('omits optional fields rather than passing undefined through', () => {
    const request = buildMultiAgentTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'p',
      agents: ['codex'],
    });

    expect('traceId' in request).toBe(false);
    expect('concurrency' in request).toBe(false);
    expect('mergeTargetChain' in request).toBe(false);
  });

  it('carries concurrency and merge targets when given', () => {
    const request = buildMultiAgentTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'p',
      agents: ['codex', 'claude'],
      concurrency: 2,
      mergeTargetChain: [{ branchName: 'main' }],
    });

    expect(request.concurrency).toBe(2);
    expect(request.mergeTargetChain).toEqual([{ branchName: 'main' }]);
  });

  // The adapters exist to feed the planner, so their output has to survive it.
  it('produces a request the planner accepts', () => {
    const plan = planOrchestrationTask(buildMultiAgentTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'Fix the failing tests',
      agents: ['coven-code', 'claude', 'coven-code'],
    }));

    expect(plan.lanes.map((lane) => lane.id)).toEqual(['coven-code-1', 'claude', 'coven-code-2']);
  });
});

describe('buildSinglePaneTaskRequest', () => {
  it('builds one agent lane', () => {
    const request = buildSinglePaneTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'p',
      agent: 'coven-code',
    });

    expect(request.lanes).toEqual([
      { id: 'coven-code', mode: 'isolated-worktree', agent: 'coven-code' },
    ]);
  });

  it('builds a terminal lane when no agent is given', () => {
    const request = buildSinglePaneTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'p',
    });

    expect(request.lanes).toEqual([{ id: 'terminal', mode: 'terminal' }]);
  });
});

describe('buildSharedWorktreeTaskRequest', () => {
  it('points every lane at the same existing worktree', () => {
    const existingWorktree = {
      slug: 'fix-auth',
      worktreePath: `${ROOT}/.psyche/worktrees/fix-auth`,
      branchName: 'psyche/fix-auth',
    };

    const request = buildSharedWorktreeTaskRequest({
      taskId: 'task-1',
      projectRoot: ROOT,
      prompt: 'Review this',
      agents: ['claude', 'codex'],
      existingWorktree,
    });

    expect(request.lanes).toHaveLength(2);
    for (const lane of request.lanes) {
      expect(lane.mode).toBe('shared-worktree');
      expect(lane.existingWorktree).toEqual(existingWorktree);
    }
  });
});

describe('createLocalPaneBackend', () => {
  function pane(id: string): PsychePane {
    return { id, slug: id, prompt: '', paneId: `%${id}` } as PsychePane;
  }

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
      prompt: 'Fix it',
      ...overrides,
    } as never;
  }

  function backendWith(createPaneFn: (...args: any[]) => any, basePanes: PsychePane[] = []) {
    return createLocalPaneBackend({
      projectName: 'repo',
      sessionProjectRoot: ROOT,
      basePanes,
      availableAgents: ['codex', 'claude'],
      createPaneFn: createPaneFn as never,
      persistOrchestrationMetadata: async (_originatingPane, nextPane) => nextPane,
    });
  }

  it('stamps orchestration metadata onto the created pane', async () => {
    const created = pane('psyche-1');
    const backend = backendWith(vi.fn(async () => ({ pane: created, needsAgentChoice: false })));

    const output = await backend.execute(lane());

    expect(output.pane?.orchestration).toEqual({
      taskId: 'task-1',
      laneId: 'codex',
      traceId: 'trace-1',
      mode: 'isolated-worktree',
    });
  });

  it('persists metadata as a fresh-pane delta without erasing a concurrent agent session', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-orchestration-delta-'));
    try {
      const created = pane('psyche-1');
      await mutateProjectPaneConfig(projectRoot, (config) => {
        config.panes = [created];
      });

      const createPaneFn = vi.fn(async () => {
        // Simulate StatusDetector writing after createPane persisted the pane
        // but before the orchestrator adds lane metadata.
        await mutateProjectPaneConfig(projectRoot, (config) => {
          config.panes = [{
            ...created,
            agentSession: {
              agent: 'codex',
              id: 'session-42',
              updatedAt: '2026-08-07T20:00:00.000Z',
            },
            daemonOnlyField: 'preserve-me',
          } as PsychePane];
        });
        return {
          pane: created,
          needsAgentChoice: false,
          persistedDuringLifecycle: true,
        };
      });
      const backend = createLocalPaneBackend({
        projectName: 'repo',
        sessionProjectRoot: projectRoot,
        basePanes: [],
        availableAgents: ['codex'],
        createPaneFn: createPaneFn as never,
      });

      await backend.execute(lane({ projectRoot }));

      const config = JSON.parse(
        readFileSync(join(projectRoot, '.psyche', 'psyche.config.json'), 'utf8'),
      );
      expect(config.panes).toEqual([
        expect.objectContaining({
          id: 'psyche-1',
          agentSession: expect.objectContaining({ id: 'session-42' }),
          daemonOnlyField: 'preserve-me',
          orchestration: {
            taskId: 'task-1',
            laneId: 'codex',
            traceId: 'trace-1',
            mode: 'isolated-worktree',
          },
        }),
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('passes the agent slug suffix so sibling lanes get distinct slugs', async () => {
    const createPaneFn = vi.fn(async () => ({ pane: pane('psyche-1'), needsAgentChoice: false }));
    await backendWith(createPaneFn).execute(lane());

    expect((createPaneFn.mock.calls[0] as any[])[0].slugSuffix).toBe('codex');
  });

  // The reason this state lives in the backend: createPane picks its tmux
  // split target from the panes it is told already exist.
  it('shows each lane the panes created by earlier lanes', async () => {
    const seen: number[] = [];
    const createPaneFn = vi.fn(async (options: any) => {
      seen.push(options.existingPanes.length);
      return { pane: pane(`psyche-${seen.length}`), needsAgentChoice: false };
    });
    const backend = backendWith(createPaneFn, [pane('existing')]);

    await backend.execute(lane({ id: 'a' }));
    await backend.execute(lane({ id: 'b' }));
    await backend.execute(lane({ id: 'c' }));

    expect(seen).toEqual([1, 2, 3]);
    expect(backend.createdPanes()).toHaveLength(3);
  });

  it('creates a terminal lane without an agent', async () => {
    const createPaneFn = vi.fn(async () => ({ pane: pane('psyche-1'), needsAgentChoice: false }));
    await backendWith(createPaneFn).execute(lane({ id: 'term', mode: 'terminal', agent: undefined }));

    const options = (createPaneFn.mock.calls[0] as any[])[0];
    expect(options.skipAgentSelection).toBe(true);
    expect(options.agent).toBeUndefined();
  });

  it('forwards an existing worktree for shared-worktree lanes', async () => {
    const existingWorktree = { slug: 's', worktreePath: '/w', branchName: 'b' };
    const createPaneFn = vi.fn(async () => ({ pane: pane('psyche-1'), needsAgentChoice: false }));

    await backendWith(createPaneFn).execute(lane({ mode: 'shared-worktree', existingWorktree }));

    expect((createPaneFn.mock.calls[0] as any[])[0].existingWorktree).toEqual(existingWorktree);
  });

  it('refuses Coven lanes rather than silently making a local pane', async () => {
    const createPaneFn = vi.fn();
    await expect(backendWith(createPaneFn).execute(lane({ mode: 'coven-session', harness: 'codex' })))
      .rejects.toMatchObject({ code: 'unsupported_lane_mode' });
    expect(createPaneFn).not.toHaveBeenCalled();
  });

  // createPane returns this sentinel instead of throwing.
  it('fails the lane when createPane cannot resolve an agent', async () => {
    const backend = backendWith(vi.fn(async () => ({ pane: null, needsAgentChoice: true })));
    await expect(backend.execute(lane())).rejects.toMatchObject({ code: 'unsupported_agent' });
  });

  // createPane's first call may build the sidebar layout and destroy the
  // welcome pane; two of those at once race over the same tmux window.
  describe('first-lane gate', () => {
    it('does not start a second lane until the first settles', async () => {
      const events: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const createPaneFn = vi.fn(async (options: any) => {
        const id = options.agent as string;
        events.push(`start:${id}`);
        if (id === 'codex') {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        events.push(`end:${id}`);
        return { pane: pane(`psyche-${id}`), needsAgentChoice: false };
      });
      const backend = backendWith(createPaneFn);

      const first = backend.execute(lane({ id: 'codex', agent: 'codex' }));
      const second = backend.execute(lane({ id: 'claude', agent: 'claude' }));

      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      expect(events).toEqual(['start:codex']);

      releaseFirst!();
      await Promise.all([first, second]);

      expect(events).toEqual(['start:codex', 'end:codex', 'start:claude', 'end:claude']);
    });

    it('lets siblings proceed when the first lane fails', async () => {
      const createPaneFn = vi.fn(async (options: any) => {
        if (options.agent === 'codex') throw new Error('first lane exploded');
        return { pane: pane('psyche-claude'), needsAgentChoice: false };
      });
      const backend = backendWith(createPaneFn);

      const first = backend.execute(lane({ id: 'codex', agent: 'codex' }));
      const second = backend.execute(lane({ id: 'claude', agent: 'claude' }));

      await expect(first).rejects.toThrow('first lane exploded');
      await expect(second).resolves.toMatchObject({ pane: { id: 'psyche-claude' } });
    });
  });

});
