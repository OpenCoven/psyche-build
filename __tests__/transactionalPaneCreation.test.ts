import { describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';
import { createTransactionalPane } from '../src/utils/transactionalPaneCreation.js';

const generation = {
  pid: 4242,
  processStartIdentity: 'test-tmux-server-start',
  socketPath: '/tmux.sock',
  sessionId: '$test',
};

describe('transactional pane creation', () => {
  it.each([
    ['terminal-pane', 'terminal'],
    ['desktop-use-pane', 'desktop-use'],
    ['file-browser-pane', 'browser'],
    ['ritual-terminal-pane', 'ritual terminal'],
  ])(
    'verified-tears down the %s flow when its config is unwritable',
    async (operation, label) => {
      const events: string[] = [];
      const activate = vi.fn(async () => {
        events.push('activate');
      });

      await expect(createTransactionalPane({
        projectRoot: '/project',
        sessionProjectRoot: '/session',
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
    const persistRecovery = vi.fn(async () => ({
      durable: true,
      message: 'retained exact recovery record',
    }));

    await expect(createTransactionalPane({
      projectRoot: '/project',
      sessionProjectRoot: '/session',
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

  it('compensates an allocated split when its post-allocation generation capture fails', async () => {
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
      projectRoot: '/project',
      sessionProjectRoot: '/session',
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

  it('compensates an allocated split when pane record construction fails', async () => {
    const tearDown = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(createTransactionalPane({
      projectRoot: '/project',
      sessionProjectRoot: '/session',
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
