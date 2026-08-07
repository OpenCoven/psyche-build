import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killBridgePane } from '../../src/daemon/bridge.js';

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
    };

    await expect(killBridgePane(projectRoot, '%3', d))
      .rejects.toMatchObject({ code: 'pane_probe_unknown' });

    expect(readConfig().panes).toHaveLength(1);
  });
});
