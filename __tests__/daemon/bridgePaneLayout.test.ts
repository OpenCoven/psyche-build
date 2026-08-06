import { execSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PsychePane } from '../../src/types.js';

const capturePaneInsertionMock = vi.hoisted(() => vi.fn());
const insertPaneIntoStoredLayoutMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/utils/layoutManager.js', () => ({
  capturePaneInsertion: capturePaneInsertionMock,
  insertPaneIntoStoredLayout: insertPaneIntoStoredLayoutMock,
  SIDEBAR_WIDTH: 40,
}));

let root: string;

function pane(id: string, paneId: string): PsychePane {
  return {
    id,
    slug: id,
    prompt: id,
    paneId,
    worktreePath: path.join(root, '.psyche', 'worktrees', id),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(process.cwd(), '.bridge-pane-layout-'));
  await mkdir(path.join(root, '.psyche'), { recursive: true });
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: root,
    stdio: 'ignore',
  });

  const existingPane = pane('existing', '%1');
  await writeFile(path.join(root, '.psyche', 'psyche.config.json'), JSON.stringify({
    projectRoot: root,
    projectName: 'project',
    controlPaneId: '%0',
    panes: [existingPane],
    paneLayout: {
      version: 1,
      root: { kind: 'leaf', paneId: existingPane.id },
    },
  }));
  capturePaneInsertionMock.mockResolvedValue({
    targetPaneId: existingPane.id,
    targetTmuxPaneId: existingPane.paneId,
    direction: 'vertical',
  });
  insertPaneIntoStoredLayoutMock.mockResolvedValue({});
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('daemon bridge pane placement', () => {
  it('inserts Coven sessions and agent lanes into the stored layout before persistence', async () => {
    const { openProjectCovenSession, spawnBridgePane } = await import('../../src/daemon/bridge.js');
    let paneNumber = 1;
    const deps = {
      tmuxSessionExists: () => true,
      getFocusedTmuxPaneId: () => '%1',
      createTmuxPane: vi.fn(() => `%${++paneNumber}`),
      sendTmuxCommand: vi.fn(),
    };

    await openProjectCovenSession(
      root,
      'psyche-test',
      'coven-1',
      {
        listSessions: async () => [{
          id: 'coven-1',
          projectRoot: root,
          harness: 'claude',
          title: 'Coven task',
          status: 'running',
          createdAt: '2026-08-06T00:00:00.000Z',
          updatedAt: '2026-08-06T00:00:00.000Z',
        }],
      },
      deps,
    );
    await spawnBridgePane(
      root,
      'psyche-test',
      {
        requestId: 'lane-1',
        cwd: root,
        agent: 'coven-code',
        prompt: 'Fix the lifecycle tests',
      },
      deps,
    );

    expect(capturePaneInsertionMock).toHaveBeenCalledTimes(2);
    expect(capturePaneInsertionMock).toHaveBeenNthCalledWith(1, {
      panesFile: path.join(root, '.psyche', 'psyche.config.json'),
      panes: [pane('existing', '%1')],
      focusedTmuxPaneId: '%1',
    });
    expect(insertPaneIntoStoredLayoutMock).toHaveBeenCalledTimes(2);
    for (const call of insertPaneIntoStoredLayoutMock.mock.calls) {
      expect(call[0]).toMatchObject({
        panesFile: path.join(root, '.psyche', 'psyche.config.json'),
        panes: [pane('existing', '%1')],
        controlPaneId: '%0',
        insertion: {
          targetPaneId: 'existing',
          targetTmuxPaneId: '%1',
          direction: 'vertical',
        },
      });
      expect(call[0].pane.id).toMatch(/^psyche-/);
    }
  });
});
