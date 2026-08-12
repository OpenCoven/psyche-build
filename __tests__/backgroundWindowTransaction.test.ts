import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';
import {
  joinBackgroundWindowTransaction,
  startBackgroundWindowTransaction,
} from '../src/utils/backgroundWindowTransaction.js';
import { migrateBackgroundPaneResources } from '../src/hooks/usePaneLoading.js';

const roots: string[] = [];
const serverGeneration = {
  pid: 4242,
  processStartIdentity: 'Thu Aug  7 20:00:00 2026',
  socketPath: '/tmp/tmux-501/default',
  sessionId: '$1',
};

function pane(overrides: Partial<PsychePane> = {}): PsychePane {
  return {
    id: 'psyche-1',
    slug: 'feature',
    prompt: '',
    paneId: '%1',
    worktreePath: '/project/.psyche/worktrees/feature',
    ...overrides,
  };
}

function projectWithPanes(panes: PsychePane[]): string {
  const projectRoot = fs.mkdtempSync(
    path.join(process.cwd(), '.psyche-background-test-'),
  );
  roots.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, '.psyche'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.psyche', 'psyche.config.json'), JSON.stringify({
    projectName: 'project',
    projectRoot,
    panes,
    settings: {},
  }));
  return projectRoot;
}

function readPanes(projectRoot: string): PsychePane[] {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.psyche', 'psyche.config.json'), 'utf8'),
  ).panes;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('background window transaction', () => {
  it('migrates recoverable legacy background records to stable pane IDs', () => {
    expect(migrateBackgroundPaneResources(pane({
      testWindowId: '@7',
      backgroundWindowRecoveries: [{
        type: 'test',
        windowId: '@7',
        paneId: '%7',
        reason: 'interrupted launch',
      }],
    }))).toMatchObject({
      testWindowId: '@7',
      testPaneId: '%7',
    });
  });

  it('CAS-claims fresh exact pane ownership with stable window and pane IDs before send', async () => {
    const current = pane();
    const projectRoot = projectWithPanes([current]);
    const order: string[] = [];
    const sendCommand = vi.fn(async () => {
      order.push('send');
      expect(readPanes(projectRoot)).toEqual([
        expect.objectContaining({
          id: current.id,
          paneId: current.paneId,
          testWindowId: '@7',
          testPaneId: '%7',
          testTmuxServerIdentity: serverGeneration,
          testStatus: 'running',
        }),
      ]);
    });

    const result = await startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      allocateWindow: async () => {
        order.push('create');
        return '@7';
      },
      getWindowPaneId: async () => '%7',
      sendCommand,
      tearDownResource: async () => ({ presence: 'absent' }),
      tearDownAllocatedWindow: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    });

    expect(order).toEqual(['create', 'send']);
    expect(result).toMatchObject({ windowId: '@7', paneId: '%7' });
    expect(sendCommand).toHaveBeenCalledWith({
      windowId: '@7',
      paneId: '%7',
      tmuxServerIdentity: serverGeneration,
    });
  });

  it('tears down the new resource and never sends when the pane was rebound', async () => {
    const original = pane();
    const projectRoot = projectWithPanes([pane({ paneId: '%rebound' })]);
    const sendCommand = vi.fn();
    const tearDownResource = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: original,
      allocateWindow: async () => '@7',
      getWindowPaneId: async () => '%7',
      sendCommand,
      tearDownResource,
      tearDownAllocatedWindow: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/missing or rebound/);

    expect(tearDownResource).toHaveBeenCalledWith({
      windowId: '@7',
      paneId: '%7',
      tmuxServerIdentity: serverGeneration,
    }, serverGeneration);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({ paneId: '%rebound' }),
    ]);
  });

  it('tears down the new resource and never sends when the field is already claimed', async () => {
    const current = pane({ devWindowId: '@old', devPaneId: '%old' });
    const projectRoot = projectWithPanes([current]);
    const sendCommand = vi.fn();
    const tearDownResource = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(startBackgroundWindowTransaction({
      type: 'dev',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@8',
      getWindowPaneId: async () => '%8',
      sendCommand,
      tearDownResource,
      tearDownAllocatedWindow: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/already owns/);

    expect(sendCommand).not.toHaveBeenCalled();
    expect(tearDownResource).toHaveBeenCalledWith({
      windowId: '@8',
      paneId: '%8',
      tmuxServerIdentity: serverGeneration,
    }, serverGeneration);
    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({ devWindowId: '@old', devPaneId: '%old' }),
    ]);
  });

  it('rejects a duplicate pane/window claim from another live record in the same server generation', async () => {
    const current = pane();
    const other = pane({
      id: 'psyche-2',
      paneId: '%2',
      testWindowId: '@7',
      testPaneId: '%7',
      testTmuxServerIdentity: serverGeneration,
    });
    const projectRoot = projectWithPanes([current, other]);
    const sendCommand = vi.fn();
    const tearDownResource = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@7',
      getWindowPaneId: async () => '%7',
      sendCommand,
      tearDownResource,
      tearDownAllocatedWindow: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/already owned/i);

    expect(sendCommand).not.toHaveBeenCalled();
    expect(tearDownResource).toHaveBeenCalledOnce();
    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({ id: 'psyche-1' }),
      expect.objectContaining({ id: 'psyche-2', testPaneId: '%7' }),
    ]);
  });

  it('clears only its exact stable resource fields when send fails after claim', async () => {
    const current = pane({
      devWindowId: '@dev',
      devPaneId: '%dev',
      devStatus: 'running',
      devUrl: 'http://localhost:3000',
    });
    const projectRoot = projectWithPanes([current]);

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@7',
      getWindowPaneId: async () => '%7',
      sendCommand: async () => {
        throw new Error('tmux send-keys failed');
      },
      tearDownResource: async () => ({ presence: 'absent' }),
      tearDownAllocatedWindow: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/Failed to launch test command/);

    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({
        devWindowId: '@dev',
        devPaneId: '%dev',
        devStatus: 'running',
        devUrl: 'http://localhost:3000',
      }),
    ]);
    expect(readPanes(projectRoot)[0]).not.toHaveProperty('testWindowId');
    expect(readPanes(projectRoot)[0]).not.toHaveProperty('testPaneId');
  });

  it('retains a stable pane ID after joining an exact generation-bound background window', async () => {
    const current = pane({
      testWindowId: '@7',
      testTmuxServerIdentity: serverGeneration,
      testStatus: 'running',
    });
    const projectRoot = projectWithPanes([current]);

    const retained = await joinBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      expectedWindow: {
        windowId: '@7',
        tmuxServerIdentity: serverGeneration,
      },
      getWindowPaneId: async () => '%7',
      joinPane: async () => {},
      tearDownJoinedPane: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    });

    expect(retained).toMatchObject({ testWindowId: '@7', testPaneId: '%7' });
    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({ testWindowId: '@7', testPaneId: '%7' }),
    ]);
  });

  it('compensates a window when getWindowPaneId fails after allocation', async () => {
    const current = pane();
    const projectRoot = projectWithPanes([current]);
    const tearDownAllocatedWindow = vi.fn(async () => ({ presence: 'absent' as const }));
    const sendCommand = vi.fn();

    await expect(startBackgroundWindowTransaction({
      type: 'dev',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@failed',
      getWindowPaneId: async () => {
        throw new Error('getWindowPaneId failed');
      },
      sendCommand,
      tearDownResource: async () => ({ presence: 'absent' }),
      tearDownAllocatedWindow,
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/getWindowPaneId failed/);

    expect(tearDownAllocatedWindow).toHaveBeenCalledWith('@failed', serverGeneration);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('compensates an allocated window when its generation recapture fails', async () => {
    const current = pane();
    const projectRoot = projectWithPanes([current]);
    const getTmuxServerIdentity = vi.fn()
      .mockReturnValueOnce(serverGeneration)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(serverGeneration);
    const getWindowPaneId = vi.fn(async () => '%unreached');
    const tearDownAllocatedWindow = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@generation-failed',
      getWindowPaneId,
      sendCommand: vi.fn(),
      tearDownResource: async () => ({ presence: 'absent' }),
      tearDownAllocatedWindow,
      getTmuxServerIdentity,
    })).rejects.toThrow(/Could not recapture tmux server generation/);

    expect(getWindowPaneId).not.toHaveBeenCalled();
    expect(tearDownAllocatedWindow).toHaveBeenCalledWith(
      '@generation-failed',
      serverGeneration,
    );
  });

  it('compensates an allocated window when resource construction rejects an empty pane ID', async () => {
    const current = pane();
    const projectRoot = projectWithPanes([current]);
    const tearDownAllocatedWindow = vi.fn(async () => ({ presence: 'absent' as const }));

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@invalid-resource',
      getWindowPaneId: async () => '',
      sendCommand: vi.fn(),
      tearDownResource: async () => ({ presence: 'absent' }),
      tearDownAllocatedWindow,
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/stable window, pane, and tmux generation IDs/);

    expect(tearDownAllocatedWindow).toHaveBeenCalledWith(
      '@invalid-resource',
      serverGeneration,
    );
  });

  it('does not join a background window after its exact generation-bound claim was replaced', async () => {
    const selected = pane({
      testWindowId: '@selected',
      testPaneId: '%selected',
      testTmuxServerIdentity: serverGeneration,
    });
    const replacement = pane({
      testWindowId: '@replacement',
      testPaneId: '%replacement',
      testTmuxServerIdentity: serverGeneration,
    });
    const projectRoot = projectWithPanes([replacement]);
    const getWindowPaneId = vi.fn(async () => '%selected');
    const joinPane = vi.fn(async () => {});
    const module = await import('../src/utils/backgroundWindowTransaction.js');
    const joinBackgroundWindowTransaction = (
      module as typeof module & {
        joinBackgroundWindowTransaction?: (options: Record<string, unknown>) => Promise<PsychePane>;
      }
    ).joinBackgroundWindowTransaction;

    expect(joinBackgroundWindowTransaction).toEqual(expect.any(Function));
    await expect(joinBackgroundWindowTransaction!({
      type: 'test',
      projectRoot,
      pane: selected,
      expectedWindow: {
        windowId: '@selected',
        paneId: '%selected',
        tmuxServerIdentity: serverGeneration,
      },
      getWindowPaneId,
      joinPane,
      tearDownJoinedPane: vi.fn(),
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/missing, rebound, or replaced/);

    expect(getWindowPaneId).not.toHaveBeenCalled();
    expect(joinPane).not.toHaveBeenCalled();
  });

  it('tears down a joined pane and clears its exact claim when persistence fails', async () => {
    const current = pane({
      testWindowId: '@7',
      testPaneId: '%7',
      testTmuxServerIdentity: serverGeneration,
      testStatus: 'running',
    });
    const projectRoot = projectWithPanes([current]);
    const psycheDir = path.join(projectRoot, '.psyche');
    const tearDownJoinedPane = vi.fn(async () => {
      fs.chmodSync(psycheDir, 0o700);
      return { presence: 'absent' as const };
    });
    const module = await import('../src/utils/backgroundWindowTransaction.js');
    const joinBackgroundWindowTransaction = (
      module as typeof module & {
        joinBackgroundWindowTransaction?: (options: Record<string, unknown>) => Promise<PsychePane>;
      }
    ).joinBackgroundWindowTransaction;

    expect(joinBackgroundWindowTransaction).toEqual(expect.any(Function));
    try {
      await expect(joinBackgroundWindowTransaction!({
        type: 'test',
        projectRoot,
        pane: current,
        expectedWindow: {
          windowId: '@7',
          paneId: '%7',
          tmuxServerIdentity: serverGeneration,
        },
        getWindowPaneId: async () => '%7',
        joinPane: async () => {
          fs.chmodSync(psycheDir, 0o500);
        },
        tearDownJoinedPane,
        getTmuxServerIdentity: () => serverGeneration,
      })).rejects.toThrow(/Could not persist joined test pane/);
    } finally {
      fs.chmodSync(psycheDir, 0o700);
    }

    expect(tearDownJoinedPane).toHaveBeenCalledWith('%7', serverGeneration);
    expect(readPanes(projectRoot)[0]).not.toHaveProperty('testWindowId');
    expect(readPanes(projectRoot)[0]).not.toHaveProperty('testPaneId');
  });

  it('retains recovery fields when command teardown is unknown', async () => {
    const current = pane();
    const projectRoot = projectWithPanes([current]);

    await expect(startBackgroundWindowTransaction({
      type: 'dev',
      projectRoot,
      pane: current,
      allocateWindow: async () => '@8',
      getWindowPaneId: async () => '%8',
      sendCommand: async () => {
        throw new Error('launch failed');
      },
      tearDownResource: async () => ({ presence: 'unknown' }),
      tearDownAllocatedWindow: async () => ({ presence: 'absent' }),
      getTmuxServerIdentity: () => serverGeneration,
    })).rejects.toThrow(/retained durable recovery fields/);

    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({
        devWindowId: '@8',
        devPaneId: '%8',
        backgroundWindowRecoveries: [expect.objectContaining({
          type: 'dev',
          windowId: '@8',
          paneId: '%8',
          reason: expect.any(String),
        })],
      }),
    ]);
  });
});
