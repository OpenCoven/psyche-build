import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../src/types.js';
import {
  retainBackgroundWindowPaneId,
  startBackgroundWindowTransaction,
} from '../src/utils/backgroundWindowTransaction.js';
import { migrateBackgroundPaneResources } from '../src/hooks/usePaneLoading.js';

const roots: string[] = [];

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
          testStatus: 'running',
        }),
      ]);
    });

    const result = await startBackgroundWindowTransaction({
      type: 'test',
      projectRoot,
      pane: current,
      createWindow: async () => {
        order.push('create');
        return { windowId: '@7', paneId: '%7' };
      },
      sendCommand,
      tearDownResource: async () => ({ presence: 'absent' }),
    });

    expect(order).toEqual(['create', 'send']);
    expect(result).toMatchObject({ windowId: '@7', paneId: '%7' });
    expect(sendCommand).toHaveBeenCalledWith({ windowId: '@7', paneId: '%7' });
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
      createWindow: async () => ({ windowId: '@7', paneId: '%7' }),
      sendCommand,
      tearDownResource,
    })).rejects.toThrow(/missing or rebound/);

    expect(tearDownResource).toHaveBeenCalledWith({ windowId: '@7', paneId: '%7' });
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
      createWindow: async () => ({ windowId: '@8', paneId: '%8' }),
      sendCommand,
      tearDownResource,
    })).rejects.toThrow(/already owns/);

    expect(sendCommand).not.toHaveBeenCalled();
    expect(tearDownResource).toHaveBeenCalledWith({ windowId: '@8', paneId: '%8' });
    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({ devWindowId: '@old', devPaneId: '%old' }),
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
      createWindow: async () => ({ windowId: '@7', paneId: '%7' }),
      sendCommand: async () => {
        throw new Error('tmux send-keys failed');
      },
      tearDownResource: async () => ({ presence: 'absent' }),
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

  it('retains a stable pane ID after joining a legacy background window', async () => {
    const current = pane({ testWindowId: '@7', testStatus: 'running' });
    const projectRoot = projectWithPanes([current]);

    const retained = await retainBackgroundWindowPaneId(
      projectRoot,
      current,
      'test',
      '%7',
    );

    expect(retained).toMatchObject({ testWindowId: '@7', testPaneId: '%7' });
    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({ testWindowId: '@7', testPaneId: '%7' }),
    ]);
  });

  it('retains recovery fields when command teardown is unknown', async () => {
    const current = pane();
    const projectRoot = projectWithPanes([current]);

    await expect(startBackgroundWindowTransaction({
      type: 'dev',
      projectRoot,
      pane: current,
      createWindow: async () => ({ windowId: '@8', paneId: '%8' }),
      sendCommand: async () => {
        throw new Error('launch failed');
      },
      tearDownResource: async () => ({ presence: 'unknown' }),
    })).rejects.toThrow(/retained durable recovery fields/);

    expect(readPanes(projectRoot)).toEqual([
      expect.objectContaining({
        devWindowId: '@8',
        devPaneId: '%8',
        backgroundWindowRecoveries: [{
          type: 'dev',
          windowId: '@8',
          paneId: '%8',
          reason: expect.any(String),
        }],
      }),
    ]);
  });
});
