import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listPaneSurfaceBindings, listPanes } from '../../src/daemon/panes.js';
import {
  installDaemonPaneLifecycleHooks,
  parseDaemonArgs,
  refreshPaneSurfaces,
  PaneSurfaceRefreshQueue,
  uninstallDaemonPaneLifecycleHooks,
  updatePaneMeta,
} from '../../src/daemon/index.js';
import { SurfaceRegistry } from '../../src/control/surfaces.js';
import { PaneObservationStore } from '../../src/control/resources/paneObservation.js';

let tempRoots: string[] = [];

async function writeConfig(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-daemon-panes-'));
  tempRoots.push(root);
  const psycheDir = path.join(root, '.psyche');
  await mkdir(psycheDir, { recursive: true });
  await writeFile(path.join(psycheDir, 'psyche.config.json'), JSON.stringify(config, null, 2));
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

describe('daemon pane config helpers', () => {
  it('rejects invalid ports before daemon resources can be acquired', () => {
    for (const port of ['-1', '65536', '1.5', 'NaN']) {
      expect(() => parseDaemonArgs(['--port', port])).toThrow(/--port requires/);
    }
    expect(parseDaemonArgs(['--port', '0'])).toMatchObject({ port: 0 });
    expect(parseDaemonArgs(['--port', '65535'])).toMatchObject({ port: 65_535 });
  });

  it('installs additive real tmux hooks for split and exit refresh signals', () => {
    const run = vi.fn();

    installDaemonPaneLifecycleHooks('psyche-test', 1234, run as never);

    expect(run.mock.calls).toEqual([
      ['tmux', ['set-hook', '-t', 'psyche-test', 'pane-exited[987654321]',
        'run-shell "kill -USR2 1234 2>/dev/null || true # psyche-daemon-control"'], { stdio: 'ignore' }],
      ['tmux', ['set-hook', '-t', 'psyche-test', 'after-split-window[987654321]',
        'run-shell "kill -USR2 1234 2>/dev/null || true # psyche-daemon-control"'], { stdio: 'ignore' }],
    ]);
  });

  it('rolls back installed hooks when installation fails partway through', () => {
    const failure = new Error('hook install failed');
    const run = vi.fn((_file: string, args: readonly string[]) => {
      if (args.includes('after-split-window[987654321]')) throw failure;
    });

    expect(() => installDaemonPaneLifecycleHooks('psyche-test', 1234, run as never)).toThrow(failure);
    expect(run.mock.calls.at(-1)).toEqual([
      'tmux', ['set-hook', '-u', '-t', 'psyche-test', 'pane-exited[987654321]'],
      { stdio: 'ignore' },
    ]);
  });

  it('uninstalls every daemon-owned lifecycle hook', () => {
    const run = vi.fn();

    uninstallDaemonPaneLifecycleHooks('psyche-test', run as never);

    expect(run.mock.calls).toEqual([
      ['tmux', ['set-hook', '-u', '-t', 'psyche-test', 'pane-exited[987654321]'],
        { stdio: 'ignore' }],
      ['tmux', ['set-hook', '-u', '-t', 'psyche-test', 'after-split-window[987654321]'],
        { stdio: 'ignore' }],
    ]);
  });

  it('lists tmux pane identifiers while preserving psyche ids as fallback titles', async () => {
    const root = await writeConfig({
      panes: [
        {
          id: 'psyche-2',
          paneId: '%3',
          worktreeDir: '/repo/worktree',
          branch: 'feature',
          agent: 'codex',
        },
      ],
    });

    await expect(listPanes(root)).resolves.toEqual([
      {
        id: '%3',
        cwd: '/repo/worktree',
        branch: 'feature',
        agent: 'codex',
        title: 'psyche-2',
        lastActivity: undefined,
      },
    ]);
  });

  it('projects stable Psyche ids separately from replaceable tmux bindings', async () => {
    const root = await writeConfig({
      panes: [{
        id: 'psyche-2', paneId: '%3', worktreeDir: '/repo/worktree',
        title: 'Agent', agent: 'codex',
      }],
    });

    await expect(listPaneSurfaceBindings(root, async () => true)).resolves.toEqual([{
      id: 'psyche-2', tmuxPaneId: '%3', worktreeRoot: '/repo/worktree',
      title: 'Agent', agent: 'codex',
    }]);
  });

  it('does not resurrect a stale exited pane record and increments on a confirmed rebind', async () => {
    const root = await writeConfig({
      panes: [{ id: 'psyche-2', paneId: '%3', worktreeDir: '/repo/worktree' }],
    });
    const surfaces = new SurfaceRegistry();
    const observations = new PaneObservationStore();
    const first = surfaces.upsertPane({
      id: 'psyche-2', tmuxPaneId: '%3', projectRoot: root, worktreeRoot: '/repo/worktree',
      writable: true, outputSequence: 0,
    });

    await refreshPaneSurfaces(root, surfaces, observations, async () => false);
    expect(surfaces.get('psyche-2')).toBeUndefined();

    await writeFile(path.join(root, '.psyche', 'psyche.config.json'), JSON.stringify({
      panes: [{ id: 'psyche-2', paneId: '%4', worktreeDir: '/repo/worktree' }],
    }));
    await refreshPaneSurfaces(root, surfaces, observations, async (paneId) => paneId === '%4');
    expect(surfaces.get('psyche-2')).toMatchObject({
      tmuxPaneId: '%4', generation: first.generation + 1,
    });
  });

  it('serializes delayed refreshes so an older result cannot overwrite a newer rebind', async () => {
    const root = await writeConfig({
      panes: [{ id: 'psyche-2', paneId: '%3', worktreeDir: '/repo/worktree' }],
    });
    const surfaces = new SurfaceRegistry();
    const observations = new PaneObservationStore();
    const original = surfaces.upsertPane({
      id: 'psyche-2', tmuxPaneId: '%2', projectRoot: root, worktreeRoot: '/repo/worktree',
      writable: true, outputSequence: 7,
    });
    let releaseFirst!: () => void;
    let probeCalls = 0;
    const queue = new PaneSurfaceRefreshQueue(() => refreshPaneSurfaces(
      root,
      surfaces,
      observations,
      async (paneId) => {
        probeCalls += 1;
        if (probeCalls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return paneId === '%4';
      },
    ));

    const first = queue.run();
    await vi.waitFor(() => expect(probeCalls).toBe(1));
    await writeFile(path.join(root, '.psyche', 'psyche.config.json'), JSON.stringify({
      panes: [{ id: 'psyche-2', paneId: '%4', worktreeDir: '/repo/worktree' }],
    }));
    const second = queue.run();
    releaseFirst();
    await Promise.all([first, second]);
    expect(surfaces.get('psyche-2')).toMatchObject({
      tmuxPaneId: '%4', generation: original.generation + 1, outputSequence: 0,
    });
  });

  it('updates pane metadata by tmux pane id from panes.list results', async () => {
    const root = await writeConfig({
      panes: [
        {
          id: 'psyche-2',
          paneId: '%3',
          title: 'old title',
          agent: 'codex',
        },
      ],
    });

    await updatePaneMeta(root, '%3', { title: 'new title', agent: 'claude' });

    const raw = await readFile(path.join(root, '.psyche', 'psyche.config.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      panes: [{ id: 'psyche-2', paneId: '%3', title: 'new title', agent: 'claude' }],
    });
  });
});
