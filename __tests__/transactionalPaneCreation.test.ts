import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';
import { listPaneSlugOwnershipRecords } from '../src/services/PaneSlugRegistry.js';
import {
  mutateProjectPaneConfig,
  readProjectPaneConfig,
} from '../src/services/ProjectPaneConfig.js';
import {
  acknowledgeWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
} from '../src/services/WorktreeRecoveryMarker.js';
import { createTransactionalPane } from '../src/utils/transactionalPaneCreation.js';
import {
  buildManagedPaneTitle,
  getPaneTmuxTitle,
} from '../src/utils/paneTitle.js';

const generation = {
  pid: 4242,
  processStartIdentity: 'test-tmux-server-start',
  socketPath: '/tmux.sock',
  sessionId: '$test',
};
const roots: string[] = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(process.cwd(), '.psyche-transaction-pane-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('transactional pane creation', () => {
  it('durably reserves a fresh session slug before allocating the tmux effect', async () => {
    const projectRoot = createProjectRoot();
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{ id: 'existing', paneId: '%1', slug: 'shell-1' }];
    });

    const pane = await createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'terminal-pane',
      slugBase: 'shell-1',
      allocate: async () => {
        const records = await listPaneSlugOwnershipRecords(projectRoot);
        expect(records).toEqual([
          expect.objectContaining({
            state: 'provisional',
            slug: 'shell-1-2',
          }),
        ]);
        expect(records[0]?.pane).not.toHaveProperty('paneId');
        return '%42';
      },
      getTmuxServerIdentity: () => generation,
      createPane: ({ paneId, tmuxServerIdentity }): PsychePane => ({
        id: 'discarded-id',
        slug: 'discarded-slug',
        prompt: '',
        paneId,
        tmuxServerIdentity,
      }),
      persist: async (nextPane) => {
        expect(await listPaneSlugOwnershipRecords(projectRoot)).toEqual([
          expect.objectContaining({
            state: 'provisional',
            slug: 'shell-1-2',
            pane: expect.objectContaining({
              paneId: '%42',
              tmuxServerIdentity: generation,
            }),
          }),
        ]);
        await mutateProjectPaneConfig(projectRoot, (config) => {
          config.panes = [...(config.panes || []), nextPane];
        });
      },
    });

    expect(pane.slug).toBe('shell-1-2');
    expect(pane.id).not.toBe('discarded-id');
    expect(await listPaneSlugOwnershipRecords(projectRoot)).toEqual([]);
  });

  it('derives a desktop-use title from the final collision-resolved slug', async () => {
    const projectRoot = createProjectRoot();
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{
        id: 'existing',
        paneId: '%1',
        slug: 'desktop-use-1',
        displayName: 'desktop-use · desktop-use-1',
      }];
    });

    const pane = await createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'desktop-use-pane',
      slugBase: 'desktop-use-1',
      allocate: () => '%42',
      getTmuxServerIdentity: () => generation,
      createPane: ({ paneId, tmuxServerIdentity, slug }): PsychePane => ({
        id: 'discarded-id',
        slug,
        displayName: buildManagedPaneTitle('desktop-use', slug),
        prompt: '',
        paneId,
        tmuxServerIdentity,
        type: 'desktop-use',
      }),
      persist: async (nextPane) => {
        await mutateProjectPaneConfig(projectRoot, (config) => {
          config.panes = [...(config.panes || []), nextPane];
        });
      },
    });

    expect(pane.slug).toBe('desktop-use-1-2');
    expect(pane.displayName).toBe('desktop-use · desktop-use-1-2');
    expect(getPaneTmuxTitle(pane, projectRoot)).toBe(pane.displayName);
  });

  it.each([
    ['terminal-pane', 'terminal'],
    ['desktop-use-pane', 'desktop-use'],
    ['file-browser-pane', 'browser'],
    ['ritual-terminal-pane', 'ritual terminal'],
  ])(
    'verified-tears down the %s flow when its config is unwritable',
    async (operation, label) => {
      const projectRoot = createProjectRoot();
      const events: string[] = [];
      const activate = vi.fn(async () => {
        events.push('activate');
      });

      await expect(createTransactionalPane({
        projectRoot,
        sessionProjectRoot: projectRoot,
        operation,
        allocate: async () => {
          events.push('split');
          return '%42';
        },
        getTmuxServerIdentity: () => generation,
        createPane: ({ paneId, tmuxServerIdentity }): PsychePane => ({
          id: `psyche-${operation}`,
          slug: operation,
          prompt: label,
          paneId,
          tmuxServerIdentity,
          type: 'shell',
        }),
        persist: async () => {
          events.push('persist');
          throw new Error('EACCES: pane config is unwritable');
        },
        tearDown: async () => {
          events.push('teardown');
          return { presence: 'absent' };
        },
        activate,
      })).rejects.toThrow(/pane config is unwritable/);

      expect(events).toEqual(['split', 'persist', 'teardown']);
      expect(activate).not.toHaveBeenCalled();
    },
  );

  it('retains recovery protection when config failure teardown is uncertain', async () => {
    const projectRoot = createProjectRoot();
    const persistRecovery = vi.fn(async () => ({
      durable: true,
      message: 'retained exact recovery record',
    }));

    await expect(createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'terminal-pane',
      allocate: () => '%42',
      getTmuxServerIdentity: () => generation,
      createPane: ({ paneId, tmuxServerIdentity }): PsychePane => ({
        id: 'psyche-terminal',
        slug: 'terminal',
        prompt: '',
        paneId,
        tmuxServerIdentity,
        type: 'shell',
      }),
      persist: async () => {
        throw new Error('invalid pane config');
      },
      tearDown: async () => ({ presence: 'unknown' }),
      persistRecovery,
    })).rejects.toThrow(/retained exact recovery record/);

    expect(persistRecovery).toHaveBeenCalledOnce();
  });

  it('surfaces cleanup marker deletion failure and leaves an acknowledgeable repair marker', async () => {
    const projectRoot = createProjectRoot();

    const pane = await createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'terminal-pane',
      allocate: () => '%43',
      getTmuxServerIdentity: () => generation,
      createPane: ({ paneId, tmuxServerIdentity }): PsychePane => ({
        id: 'discarded-id',
        slug: 'discarded-slug',
        prompt: '',
        paneId,
        tmuxServerIdentity,
        type: 'shell',
      }),
      persist: async (nextPane) => {
        await mutateProjectPaneConfig(projectRoot, (config) => {
          config.panes = [...(config.panes || []), nextPane];
        });
      },
      removeCleanupBlocker: async () => {
        throw new Error('injected marker deletion failure');
      },
    });

    expect(pane.recoveryWarnings).toEqual([
      expect.objectContaining({
        code: 'pane_cleanup_repair_required',
        message: expect.stringContaining('injected marker deletion failure'),
        projectRoot,
        markerId: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    const [marker] = await listWorktreeRecoveryMarkers(projectRoot);
    expect(marker.id).toBe(pane.recoveryWarnings?.[0]?.markerId);
    expect((await readProjectPaneConfig(projectRoot)).panes?.[0])
      .not.toHaveProperty('recoveryWarnings');

    await expect(acknowledgeWorktreeRecoveryMarker(projectRoot, marker.id))
      .resolves.toBe(true);
    expect(await listWorktreeRecoveryMarkers(projectRoot)).toEqual([]);
  });

  it('compensates an allocated split when its post-allocation generation capture fails', async () => {
    const projectRoot = createProjectRoot();
    const getTmuxServerIdentity = vi.fn()
      .mockReturnValueOnce(generation)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(generation);
    const tearDown = vi.fn(async () => ({ presence: 'absent' as const }));
    const createPane = vi.fn(({
      paneId,
      tmuxServerIdentity,
    }): PsychePane => ({
      id: 'psyche-terminal',
      slug: 'terminal',
      prompt: '',
      paneId,
      tmuxServerIdentity,
    }));

    await expect(createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'terminal-pane',
      allocate: () => '%42',
      getTmuxServerIdentity,
      createPane,
      persist: vi.fn(),
      tearDown,
    })).rejects.toThrow(/could not capture the tmux server generation after allocation/);

    expect(createPane).not.toHaveBeenCalled();
    expect(tearDown).toHaveBeenCalledWith('%42', generation);
  });

  it('uses durable recovery instead of retaining a live lease when generation changes', async () => {
    const projectRoot = createProjectRoot();
    const replacementGeneration = {
      ...generation,
      pid: 5252,
      processStartIdentity: 'replacement-start',
      sessionId: '$replacement',
    };
    const getTmuxServerIdentity = vi.fn()
      .mockReturnValueOnce(generation)
      .mockReturnValue(replacementGeneration);
    const retain = vi.fn();
    const tearDown = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'terminal-pane',
      allocate: () => '%42',
      getTmuxServerIdentity,
      createPane: vi.fn(),
      persist: vi.fn(),
      tearDown,
      reservation: { retain },
    })).rejects.toThrow(/wrote recovery marker/);

    expect(retain).not.toHaveBeenCalled();
    expect(tearDown).not.toHaveBeenCalled();
  });

  it('compensates an allocated split when pane record construction fails', async () => {
    const projectRoot = createProjectRoot();
    const tearDown = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(createTransactionalPane({
      projectRoot,
      sessionProjectRoot: projectRoot,
      operation: 'terminal-pane',
      allocate: () => '%42',
      getTmuxServerIdentity: () => generation,
      createPane: () => {
        throw new Error('pane record construction failed');
      },
      persist: vi.fn(),
      tearDown,
    })).rejects.toThrow(/pane record construction failed/);

    expect(tearDown).toHaveBeenCalledWith('%42', generation);
  });
});
