import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killBridgePane } from '../../src/daemon/bridge.js';
import { replaceProjectPaneConfigPaneIdentity } from '../../src/services/ProjectPaneConfig.js';

const oldServerGeneration = {
  pid: 111,
  processStartIdentity: 'Thu Aug  7 19:00:00 2026',
  socketPath: '/tmp/tmux-501/default',
  sessionId: '$1',
};
const currentServerGeneration = {
  pid: 222,
  processStartIdentity: 'Thu Aug  7 20:00:00 2026',
  socketPath: '/tmp/tmux-501/default',
  sessionId: '$1',
};

let projectRoot: string;
let worktreePath: string;

function configPath() {
  return path.join(projectRoot, '.psyche', 'psyche.config.json');
}

function writeConfig(panes: unknown[]) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({
    projectName: path.basename(projectRoot),
    projectRoot,
    panes,
    settings: {},
  }, null, 2));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
}

function pane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'psyche-1',
    slug: 'fix-auth',
    paneId: '%3',
    worktreePath,
    branchName: 'psyche/fix-auth',
    agent: 'coven-code',
    tmuxServerIdentity: currentServerGeneration,
    ...overrides,
  };
}

function deps(exists: boolean | undefined = true) {
  let presence = exists;
  return {
    tmuxPaneExists: vi.fn(() => presence),
    killTmuxPane: vi.fn(() => {
      presence = false;
    }),
    getTmuxServerIdentity: () => currentServerGeneration,
  };
}

beforeEach(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-kill-')));
  worktreePath = path.join(projectRoot, '.psyche', 'worktrees', 'fix-auth');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'UNCOMMITTED.txt'), 'work in progress\n');
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('killBridgePane', () => {
  it('kills the tmux pane and removes the config record', async () => {
    writeConfig([pane()]);
    const d = deps();

    const result = await killBridgePane(projectRoot, '%3', d);

    expect(d.killTmuxPane).toHaveBeenCalledWith('%3');
    expect(result).toMatchObject({ id: 'psyche-1', paneId: '%3', killed: true });
    expect(readConfig().panes).toEqual([]);
  });

  it('removes a restarted-server record without killing its reused IDs', async () => {
    writeConfig([pane({
      tmuxServerIdentity: oldServerGeneration,
      testPaneId: '%4',
      testWindowId: '@7',
      testTmuxServerIdentity: oldServerGeneration,
    })]);
    const d = {
      tmuxPaneExists: vi.fn(() => true),
      killTmuxPane: vi.fn(),
      probeTmuxWindow: vi.fn(() => 'present' as const),
      killTmuxWindow: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    const result = await killBridgePane(projectRoot, '%3', d);

    expect(result.killed).toBe(false);
    expect(d.killTmuxPane).not.toHaveBeenCalled();
    expect(d.killTmuxWindow).not.toHaveBeenCalled();
    expect(readConfig().panes).toEqual([]);
  });

  it('tears down a uniquely owned pane in the same tmux server generation', async () => {
    writeConfig([pane({ tmuxServerIdentity: currentServerGeneration })]);
    const d = {
      ...deps(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await killBridgePane(projectRoot, '%3', d);

    expect(d.killTmuxPane).toHaveBeenCalledWith('%3');
    expect(readConfig().panes).toEqual([]);
  });

  it('does not kill a live unversioned legacy record but removes it once absent', async () => {
    writeConfig([pane({ tmuxServerIdentity: undefined })]);
    const live = {
      tmuxPaneExists: vi.fn(() => true),
      killTmuxPane: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await expect(killBridgePane(projectRoot, '%3', live))
      .rejects.toMatchObject({ code: 'pane_legacy_present' });
    expect(live.killTmuxPane).not.toHaveBeenCalled();
    expect(readConfig().panes).toHaveLength(1);

    const absent = {
      tmuxPaneExists: vi.fn(() => false),
      killTmuxPane: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };
    const result = await killBridgePane(projectRoot, '%3', absent);

    expect(result.killed).toBe(false);
    expect(absent.killTmuxPane).not.toHaveBeenCalled();
    expect(readConfig().panes).toEqual([]);
  });

  it('kills only the replacement pane after restart restoration clears old-generation resources', async () => {
    writeConfig([pane({
      tmuxServerIdentity: oldServerGeneration,
      testPaneId: '%old-test',
      testWindowId: '@old-test',
      testTmuxServerIdentity: oldServerGeneration,
      devPaneId: '%old-dev',
      devWindowId: '@old-dev',
      devTmuxServerIdentity: oldServerGeneration,
      backgroundWindowRecoveries: [{
        type: 'test',
        paneId: '%old-recovery',
        windowId: '@old-recovery',
        tmuxServerIdentity: oldServerGeneration,
        reason: 'old server',
      }],
    })]);
    await replaceProjectPaneConfigPaneIdentity(
      projectRoot,
      { id: 'psyche-1', paneId: '%3' },
      {
        id: 'psyche-1',
        paneId: '%9',
        slug: 'fix-auth',
        prompt: '',
        tmuxServerIdentity: currentServerGeneration,
      },
    );

    const livePanes = new Set(['%9', '%old-test', '%old-dev', '%old-recovery']);
    const liveWindows = new Set(['@old-test', '@old-dev', '@old-recovery']);
    const d = {
      tmuxPaneExists: vi.fn((id: string) => livePanes.has(id)),
      probeTmuxPane: vi.fn((id: string) => (
        livePanes.has(id) ? 'present' as const : 'absent' as const
      )),
      killTmuxPane: vi.fn((id: string) => livePanes.delete(id)),
      probeTmuxWindow: vi.fn((id: string) => (
        liveWindows.has(id) ? 'present' as const : 'absent' as const
      )),
      killTmuxWindow: vi.fn((id: string) => liveWindows.delete(id)),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await killBridgePane(projectRoot, '%9', d);

    expect(d.killTmuxPane).toHaveBeenCalledWith('%9');
    expect(d.killTmuxPane).not.toHaveBeenCalledWith('%old-test');
    expect(d.killTmuxPane).not.toHaveBeenCalledWith('%old-dev');
    expect(d.killTmuxPane).not.toHaveBeenCalledWith('%old-recovery');
    expect(d.killTmuxWindow).not.toHaveBeenCalled();
    expect(readConfig().panes).toEqual([]);
  });

  // The whole point of the tool's contract: an MCP client killing a pane must
  // not be able to destroy uncommitted work as a side effect.
  it('leaves the worktree and its uncommitted files on disk', async () => {
    writeConfig([pane()]);

    const result = await killBridgePane(projectRoot, '%3', deps());

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, 'UNCOMMITTED.txt'), 'utf8'))
      .toBe('work in progress\n');
    expect(result.worktreePath).toBe(worktreePath);
    expect(result.branch).toBe('psyche/fix-auth');
  });

  it('accepts the psyche pane id as well as the tmux pane id', async () => {
    writeConfig([pane()]);
    const result = await killBridgePane(projectRoot, 'psyche-1', deps());
    expect(result.paneId).toBe('%3');
    expect(readConfig().panes).toEqual([]);
  });

  it('leaves sibling panes untouched', async () => {
    writeConfig([pane(), pane({ id: 'psyche-2', paneId: '%4', slug: 'other' })]);

    await killBridgePane(projectRoot, '%3', deps());

    const remaining = readConfig().panes;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('psyche-2');
  });

  it('still deregisters a pane whose tmux pane is already gone', async () => {
    writeConfig([pane()]);
    const d = deps(false);

    const result = await killBridgePane(projectRoot, '%3', d);

    expect(d.killTmuxPane).not.toHaveBeenCalled();
    expect(result.killed).toBe(false);
    expect(readConfig().panes).toEqual([]);
  });

  it('rejects a pane that is not registered in this project', async () => {
    writeConfig([pane()]);
    await expect(killBridgePane(projectRoot, '%99', deps()))
      .rejects.toMatchObject({ code: 'pane_not_found' });
  });

  it('does not drop the config record when the kill fails', async () => {
    writeConfig([pane()]);
    const d = {
      tmuxPaneExists: vi.fn(() => true),
      killTmuxPane: vi.fn(() => { throw new Error('tmux refused'); }),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await expect(killBridgePane(projectRoot, '%3', d))
      .rejects.toMatchObject({ code: 'pane_kill_failed' });

    // The pane is still live, so it must still be registered.
    expect(readConfig().panes).toHaveLength(1);
  });

  it('does not drop the config record when tmux presence is unknown', async () => {
    writeConfig([pane()]);
    const d = {
      tmuxPaneExists: vi.fn(() => undefined),
      killTmuxPane: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await expect(killBridgePane(projectRoot, '%3', d))
      .rejects.toMatchObject({ code: 'pane_probe_unknown' });

    expect(d.killTmuxPane).not.toHaveBeenCalled();
    expect(readConfig().panes).toHaveLength(1);
  });

  it('retains the record when kill succeeds but the follow-up probe is uncertain', async () => {
    writeConfig([pane()]);
    let probes = 0;
    const d = {
      tmuxPaneExists: vi.fn(() => {
        probes += 1;
        return probes === 1 ? true : undefined;
      }),
      killTmuxPane: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await expect(killBridgePane(projectRoot, '%3', d))
      .rejects.toMatchObject({ code: 'pane_probe_unknown' });

    expect(readConfig().panes).toHaveLength(1);
  });

  it('fetches fresh exact resource fields and tears down background panes before windows', async () => {
    writeConfig([pane({
      tmuxServerIdentity: currentServerGeneration,
      testPaneId: '%old-test',
      testWindowId: '@old-test',
      testTmuxServerIdentity: currentServerGeneration,
      devPaneId: '%old-dev',
      devWindowId: '@old-dev',
      devTmuxServerIdentity: currentServerGeneration,
    })]);
    const order: string[] = [];
    const livePanes = new Set(['%3', '%fresh-test', '%fresh-dev']);
    const liveWindows = new Set(['@fresh-test', '@fresh-dev']);
    const d = {
      tmuxPaneExists: vi.fn(() => true),
      probeTmuxPane: vi.fn((id: string) => (
        livePanes.has(id) ? 'present' as const : 'absent' as const
      )),
      killTmuxPane: vi.fn((id: string) => {
        order.push(`pane:${id}`);
        livePanes.delete(id);
      }),
      probeTmuxWindow: vi.fn((id: string) => (
        liveWindows.has(id) ? 'present' as const : 'absent' as const
      )),
      killTmuxWindow: vi.fn((id: string) => {
        order.push(`window:${id}`);
        liveWindows.delete(id);
      }),
      getTmuxServerIdentity: () => currentServerGeneration,
      afterInitialProbe: () => {
        writeConfig([pane({
          tmuxServerIdentity: currentServerGeneration,
          testPaneId: '%fresh-test',
          testWindowId: '@fresh-test',
          testTmuxServerIdentity: currentServerGeneration,
          devPaneId: '%fresh-dev',
          devWindowId: '@fresh-dev',
          devTmuxServerIdentity: currentServerGeneration,
        })]);
      },
    };

    await killBridgePane(projectRoot, '%3', d);

    expect(order).toEqual([
      'pane:%fresh-test',
      'pane:%fresh-dev',
      'window:@fresh-test',
      'window:@fresh-dev',
      'pane:%3',
    ]);
    expect(readConfig().panes).toEqual([]);
  });

  it('preserves the fresh record when a background resource probe is unknown', async () => {
    writeConfig([pane({ testPaneId: '%test', testWindowId: '@test' })]);
    const d = {
      tmuxPaneExists: vi.fn(() => true),
      probeTmuxPane: vi.fn((id: string) => id === '%3' ? 'present' as const : 'unknown' as const),
      killTmuxPane: vi.fn(),
      probeTmuxWindow: vi.fn(() => 'absent' as const),
      killTmuxWindow: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
    };

    await expect(killBridgePane(projectRoot, '%3', d))
      .rejects.toMatchObject({ code: 'pane_probe_unknown' });
    expect(readConfig().panes).toHaveLength(1);
    expect(d.killTmuxPane).not.toHaveBeenCalledWith('%3');
  });

  it('does not kill or remove a replacement after a paused read observes a rebind', async () => {
    writeConfig([pane()]);
    let releaseProbePause!: () => void;
    let signalProbePause!: () => void;
    const paused = new Promise<void>((resolve) => {
      releaseProbePause = resolve;
    });
    const probePaused = new Promise<void>((resolve) => {
      signalProbePause = resolve;
    });
    const d = {
      tmuxPaneExists: vi.fn(() => true),
      killTmuxPane: vi.fn(),
      getTmuxServerIdentity: () => currentServerGeneration,
      afterInitialProbe: async () => {
        signalProbePause();
        await paused;
      },
    };

    const killing = killBridgePane(projectRoot, 'psyche-1', d);
    await probePaused;
    writeConfig([pane({ paneId: '%4', slug: 'replacement' })]);
    releaseProbePause();

    await expect(killing).rejects.toMatchObject({ code: 'pane_rebound' });
    expect(d.killTmuxPane).not.toHaveBeenCalled();
    expect(readConfig().panes).toEqual([
      expect.objectContaining({ id: 'psyche-1', paneId: '%4', slug: 'replacement' }),
    ]);
  });
});
