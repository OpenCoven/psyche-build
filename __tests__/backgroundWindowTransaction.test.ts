import { describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';
import {
  startBackgroundWindowTransaction,
} from '../src/utils/backgroundWindowTransaction.js';

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

describe('background window transaction', () => {
  it('verified-tears down a new window when initial persistence fails', async () => {
    const order: string[] = [];
    const savePanes = vi.fn(async (): Promise<void> => {
      order.push('save');
      throw new Error('disk unavailable');
    });
    const tearDownWindow = vi.fn(async () => {
      order.push('teardown');
      return { presence: 'absent' as const };
    });

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      pane: pane(),
      panes: [pane()],
      createWindow: async () => {
        order.push('create');
        return '@7';
      },
      sendCommand: async () => {
        order.push('send');
      },
      savePanes,
      tearDownWindow,
    })).rejects.toThrow(/Could not persist test window @7/);

    expect(order).toEqual(['create', 'save', 'teardown']);
    expect(tearDownWindow).toHaveBeenCalledWith('@7');
  });

  it('persists ownership before send, then tears down and removes only test fields on send failure', async () => {
    const order: string[] = [];
    const original = pane({
      devWindowId: '@dev',
      devStatus: 'running',
      devUrl: 'http://localhost:3000',
    });
    const saves: Array<{ next: PsychePane[]; previous: readonly PsychePane[] }> = [];
    const savePanes = vi.fn(async (
      next: PsychePane[],
      previous: readonly PsychePane[],
    ): Promise<void> => {
      order.push('save');
      saves.push({ next, previous });
    });

    await expect(startBackgroundWindowTransaction({
      type: 'test',
      pane: original,
      panes: [original],
      createWindow: async () => {
        order.push('create');
        return '@7';
      },
      sendCommand: async () => {
        order.push('send');
        throw new Error('tmux send-keys failed');
      },
      savePanes,
      tearDownWindow: async () => {
        order.push('teardown');
        return { presence: 'absent' };
      },
    })).rejects.toThrow(/Failed to launch test command/);

    expect(order).toEqual(['create', 'save', 'send', 'teardown', 'save']);
    expect(saves[0]?.next[0]).toMatchObject({
      testWindowId: '@7',
      testStatus: 'running',
    });
    expect(saves[1]?.next[0]).not.toHaveProperty('testWindowId');
    expect(saves[1]?.next[0]).not.toHaveProperty('testStatus');
    expect(saves[1]?.next[0]).toMatchObject({
      devWindowId: '@dev',
      devStatus: 'running',
      devUrl: 'http://localhost:3000',
    });
  });

  it('retains durable recovery fields when send failure teardown is unknown', async () => {
    const original = pane();
    const saves: PsychePane[][] = [];
    const savePanes = vi.fn(async (next: PsychePane[]): Promise<void> => {
      saves.push(next);
    });

    await expect(startBackgroundWindowTransaction({
      type: 'dev',
      pane: original,
      panes: [original],
      createWindow: async () => '@8',
      sendCommand: async () => {
        throw new Error('launch failed');
      },
      savePanes,
      tearDownWindow: async () => ({ presence: 'unknown' }),
    })).rejects.toThrow(/retained durable recovery fields/);

    expect(saves).toHaveLength(2);
    expect(saves[1]?.[0]).toMatchObject({
      devWindowId: '@8',
      devStatus: 'running',
      backgroundWindowRecoveries: [{
        type: 'dev',
        windowId: '@8',
      }],
    });
  });
});
