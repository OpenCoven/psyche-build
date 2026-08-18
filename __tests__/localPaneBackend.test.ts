import { describe, expect, it, vi } from 'vitest';
import { createLocalPaneBackend } from '../src/orchestration/localPaneBackend.js';
import { OrchestrationError, type OrchestrationLanePlan } from '../src/orchestration/types.js';
import type { PsychePane } from '../src/types.js';

const ROOT = process.cwd();

function pane(id: string, overrides: Partial<PsychePane> = {}): PsychePane {
  return {
    id,
    slug: id,
    prompt: '',
    paneId: `%${id}`,
    ...overrides,
  } as PsychePane;
}

function lane(overrides: Partial<OrchestrationLanePlan> = {}): OrchestrationLanePlan {
  return {
    id: 'codex',
    mode: 'isolated-worktree',
    agent: 'codex',
    taskId: 'task-1',
    traceId: 'trace-1',
    index: 0,
    projectRoot: ROOT,
    cwd: ROOT,
    prompt: 'Fix the tests',
    ...overrides,
  } as OrchestrationLanePlan;
}

function backendWith(
  createPaneFn: (...args: any[]) => any,
  overrides: Record<string, unknown> = {},
) {
  return createLocalPaneBackend({
    projectName: 'repo',
    sessionProjectRoot: ROOT,
    basePanes: [],
    availableAgents: ['codex', 'claude', 'coven-code'],
    createPaneFn: createPaneFn as never,
    persistOrchestrationMetadata: async (_originatingPane, nextPane) => nextPane,
    ...overrides,
  });
}

describe('localPaneBackend', () => {
  describe('isolated-worktree lane translation', () => {
    it('passes agent and prompt to createPane for isolated-worktree mode', async () => {
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      await backend.execute(lane({
        id: 'codex',
        mode: 'isolated-worktree',
        agent: 'codex',
        prompt: 'Fix all tests',
      }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.agent).toBe('codex');
      expect(options.prompt).toBe('Fix all tests');
      expect(options.projectRoot).toBe(ROOT);
      expect(options.skipAgentSelection).toBeUndefined();
    });

    it('forwards startPointBranch to createPane', async () => {
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      await backend.execute(lane({
        startPointBranch: 'develop',
      }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.startPointBranch).toBe('develop');
    });

    it('forwards mergeTargetChain to createPane', async () => {
      const chain = [{ branchName: 'main' }];
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      await backend.execute(lane({
        mergeTargetChain: chain,
      }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.mergeTargetChain).toEqual(chain);
    });

    it('passes the agent slug suffix so sibling lanes get distinct slugs', async () => {
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      await backendWith(createPaneFn).execute(lane({ agent: 'claude' }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.slugSuffix).toBe('claude-code');
    });
  });

  describe('shared-worktree lane translation', () => {
    it('passes the existing worktree reference to createPane', async () => {
      const existingWorktree = {
        slug: 'fix-auth',
        worktreePath: `${ROOT}/.psyche/worktrees/fix-auth`,
        branchName: 'psyche/fix-auth',
      };
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      await backend.execute(lane({
        id: 'claude',
        mode: 'shared-worktree',
        agent: 'claude',
        existingWorktree,
      }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.existingWorktree).toEqual(existingWorktree);
      expect(options.agent).toBe('claude');
    });

    it('injects persistReusedPane when backend has one', async () => {
      const persistReusedPane = vi.fn(async () => {});
      const existingWorktree = {
        slug: 'fix-auth',
        worktreePath: `${ROOT}/.psyche/worktrees/fix-auth`,
        branchName: 'psyche/fix-auth',
      };
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn, { persistReusedPane });

      await backend.execute(lane({
        mode: 'shared-worktree',
        existingWorktree,
      }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.persistReusedPane).toBeDefined();
    });

    it('allocates a sibling slug from fresh persisted panes', async () => {
      const existingWorktree = {
        slug: 'fix-auth',
        worktreePath: `${ROOT}/.psyche/worktrees/fix-auth`,
        branchName: 'psyche/fix-auth',
      };
      const createPaneFn = vi.fn(async (options: any) => {
        const slug = options.resolveExistingWorktreeSlug([
          pane('fix-auth'),
          pane('fix-auth-a2'),
        ]);
        return {
          pane: pane(slug),
          needsAgentChoice: false,
        };
      });
      const backend = backendWith(createPaneFn);

      const output = await backend.execute(lane({
        mode: 'shared-worktree',
        existingWorktree,
      }));

      expect(output.pane?.slug).toBe('fix-auth-a3');
    });

    it('allocates distinct sibling slugs for parallel shared-worktree lanes', async () => {
      const existingWorktree = {
        slug: 'fix-auth',
        worktreePath: `${ROOT}/.psyche/worktrees/fix-auth`,
        branchName: 'psyche/fix-auth',
      };
      let persistedPanes = [pane('fix-auth')];
      let reservationTail = Promise.resolve();
      const createPaneFn = vi.fn(async (options: any) => {
        const previousReservation = reservationTail;
        let releaseReservation!: () => void;
        reservationTail = new Promise<void>((resolve) => {
          releaseReservation = resolve;
        });
        await previousReservation;

        try {
          const slug = options.resolveExistingWorktreeSlug(persistedPanes);
          const createdPane = pane(slug);
          persistedPanes = [...persistedPanes, createdPane];
          return {
            pane: createdPane,
            needsAgentChoice: false,
          };
        } finally {
          releaseReservation();
        }
      });
      const firstBackend = backendWith(createPaneFn);
      const secondBackend = backendWith(createPaneFn);

      const [first, second] = await Promise.all([
        firstBackend.execute(lane({
          id: 'first',
          mode: 'shared-worktree',
          existingWorktree,
        })),
        secondBackend.execute(lane({
          id: 'second',
          mode: 'shared-worktree',
          existingWorktree,
        })),
      ]);

      expect([first.pane?.slug, second.pane?.slug].sort()).toEqual([
        'fix-auth-a2',
        'fix-auth-a3',
      ]);
    });
  });

  describe('terminal lane translation', () => {
    it('creates a pane with skipAgentSelection and no agent', async () => {
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-term'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      await backend.execute(lane({
        id: 'term',
        mode: 'terminal',
        agent: undefined,
      }));

      const options = (createPaneFn.mock.calls[0] as any[])[0];
      expect(options.skipAgentSelection).toBe(true);
      expect(options.agent).toBeUndefined();
    });
  });

  describe('coven-session lane rejection', () => {
    it('rejects coven-session lanes with unsupported_lane_mode', async () => {
      const createPaneFn = vi.fn();
      const backend = backendWith(createPaneFn);

      const error = await backend.execute(
        lane({ id: 'coven', mode: 'coven-session', harness: 'codex' }),
      ).catch((e) => e);

      expect(error).toBeInstanceOf(OrchestrationError);
      expect(error.code).toBe('unsupported_lane_mode');
      expect(createPaneFn).not.toHaveBeenCalled();
    });

    it('includes an informative message about requiring the Coven backend', async () => {
      const createPaneFn = vi.fn();
      const backend = backendWith(createPaneFn);

      await expect(backend.execute(
        lane({ mode: 'coven-session', harness: 'codex' }),
      )).rejects.toThrow(/coven/i);
    });
  });

  describe('orchestration metadata', () => {
    it('stamps orchestration metadata from the lane plan onto the result pane', async () => {
      const created = pane('psyche-1');
      const createPaneFn = vi.fn(async () => ({
        pane: created,
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      const output = await backend.execute(lane({
        taskId: 'task-42',
        traceId: 'trace-42',
        id: 'claude-lane',
        mode: 'isolated-worktree',
        agent: 'claude',
      }));

      expect(output.pane?.orchestration).toEqual({
        taskId: 'task-42',
        laneId: 'claude-lane',
        traceId: 'trace-42',
        mode: 'isolated-worktree',
      });
    });

    it('stamps terminal mode onto the orchestration metadata', async () => {
      const created = pane('psyche-term');
      const createPaneFn = vi.fn(async () => ({
        pane: created,
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      const output = await backend.execute(lane({
        id: 'shell',
        mode: 'terminal',
        agent: undefined,
      }));

      expect(output.pane?.orchestration?.mode).toBe('terminal');
    });

    it('stamps shared-worktree mode onto the orchestration metadata', async () => {
      const created = pane('psyche-share');
      const createPaneFn = vi.fn(async () => ({
        pane: created,
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      const output = await backend.execute(lane({
        id: 'share',
        mode: 'shared-worktree',
        existingWorktree: {
          slug: 's',
          worktreePath: `${ROOT}/.psyche/worktrees/s`,
          branchName: 'b',
        },
      }));

      expect(output.pane?.orchestration?.mode).toBe('shared-worktree');
    });
  });

  describe('pane accumulation', () => {
    it('accumulates created panes and shows them to subsequent lanes', async () => {
      const existingPanesSeen: number[] = [];
      const createPaneFn = vi.fn(async (options: any) => {
        existingPanesSeen.push(options.existingPanes.length);
        return {
          pane: pane(`psyche-${existingPanesSeen.length}`),
          needsAgentChoice: false,
        };
      });
      const backend = backendWith(createPaneFn, {
        basePanes: [pane('existing-1')],
      });

      await backend.execute(lane({ id: 'first' }));
      await backend.execute(lane({ id: 'second' }));
      await backend.execute(lane({ id: 'third' }));

      // 1 base + 0 created, 1 base + 1 created, 1 base + 2 created
      expect(existingPanesSeen).toEqual([1, 2, 3]);
      expect(backend.createdPanes()).toHaveLength(3);
    });

    it('returns a copy of the created panes array', async () => {
      const createPaneFn = vi.fn(async () => ({
        pane: pane('psyche-1'),
        needsAgentChoice: false,
      }));
      const backend = backendWith(createPaneFn);

      await backend.execute(lane());

      const first = backend.createdPanes();
      const second = backend.createdPanes();
      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });
  });

  describe('error handling', () => {
    it('fails the lane when createPane cannot resolve an agent', async () => {
      const createPaneFn = vi.fn(async () => ({
        pane: null,
        needsAgentChoice: true,
      }));
      const backend = backendWith(createPaneFn);

      await expect(backend.execute(lane())).rejects.toMatchObject({
        code: 'unsupported_agent',
      });
    });

    it('propagates createPane failures to the caller', async () => {
      const createPaneFn = vi.fn(async () => {
        throw new Error('tmux split failed');
      });
      const backend = backendWith(createPaneFn);

      await expect(backend.execute(lane())).rejects.toThrow('tmux split failed');
    });
  });

  describe('first-lane gate', () => {
    it('serialises the first lane so sidebar layout races cannot occur', async () => {
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

      // Give the microtask queue a tick so the gate wiring takes effect.
      await vi.waitFor(() => expect(releaseFirst).toBeDefined());
      expect(events).toEqual(['start:codex']);

      releaseFirst!();
      await Promise.all([first, second]);

      expect(events).toEqual([
        'start:codex', 'end:codex',
        'start:claude', 'end:claude',
      ]);
    });

    it('unblocks siblings when the first lane fails', async () => {
      const createPaneFn = vi.fn(async (options: any) => {
        if (options.agent === 'codex') throw new Error('first lane exploded');
        return { pane: pane('psyche-claude'), needsAgentChoice: false };
      });
      const backend = backendWith(createPaneFn);

      const first = backend.execute(lane({ id: 'codex', agent: 'codex' }));
      const second = backend.execute(lane({ id: 'claude', agent: 'claude' }));

      await expect(first).rejects.toThrow('first lane exploded');
      await expect(second).resolves.toMatchObject({
        pane: expect.objectContaining({ id: 'psyche-claude' }),
      });
    });
  });
});
