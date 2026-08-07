import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProjectPaneConfigLock,
  mutateProjectPaneConfig,
  mutateProjectPaneSettings,
} from '../src/services/ProjectPaneConfig.js';
import { savePanesToFile } from '../src/hooks/usePaneSync.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(): string {
  const root = mkdtempSync(join(process.cwd(), '.psyche-project-config-test-'));
  roots.push(root);
  return root;
}

describe('project pane config mutation', () => {
  it('keeps a daemon pane when a stale TUI closes a different pane', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    let releaseDaemonMutation!: () => void;
    let daemonMutationEntered!: () => void;
    const daemonCanPersist = new Promise<void>((resolve) => {
      releaseDaemonMutation = resolve;
    });
    const daemonEntered = new Promise<void>((resolve) => {
      daemonMutationEntered = resolve;
    });

    const daemonPersist = mutateProjectPaneConfig(projectRoot, async (config) => {
      config.panes = [{
        id: 'tui-close',
        paneId: '%1',
        slug: 'tui-close',
      }];
      daemonMutationEntered();
      await daemonCanPersist;
      config.panes = [
        ...(config.panes || []),
        {
          id: 'daemon-pane',
          paneId: '%2',
          slug: 'daemon-pane',
          worktreePath: join(projectRoot, '.psyche', 'worktrees', 'daemon-pane'),
        },
      ];
    });

    await daemonEntered;
    const staleTuiClose = mutateProjectPaneConfig(projectRoot, (config) => {
      // The TUI only knows its own stale snapshot. It must remove this exact
      // ID from the fresh config instead of writing its stale array back.
      config.panes = (config.panes || []).filter((pane) => pane.id !== 'tui-close');
    });

    releaseDaemonMutation();
    await Promise.all([daemonPersist, staleTuiClose]);

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual([
      expect.objectContaining({ id: 'daemon-pane', paneId: '%2' }),
    ]);
  });

  it('keeps a daemon pane when a stale TUI creates and updates panes', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    const renderedPane = {
      id: 'tui-pane',
      paneId: '%1',
      slug: 'tui-pane',
      prompt: '',
    };
    const daemonPane = {
      id: 'daemon-pane',
      paneId: '%2',
      slug: 'daemon-pane',
      prompt: '',
      daemonOnlyField: 'keep-me',
    };

    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [renderedPane];
    });

    // The daemon writes after React rendered `renderedPane`, so the TUI's
    // next save cannot infer deletion from its stale whole-array snapshot.
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [...(config.panes || []), daemonPane];
    });

    const updatedPane = {
      ...renderedPane,
      displayName: 'Renamed in TUI',
    };
    const createdPane = {
      id: 'tui-created',
      paneId: '%3',
      slug: 'tui-created',
      prompt: '',
    };
    await savePanesToFile(
      configPath,
      [updatedPane, createdPane] as any,
      async (operation) => operation(),
      [renderedPane] as any,
    );

    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.panes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tui-pane',
        displayName: 'Renamed in TUI',
      }),
      expect.objectContaining({
        id: 'tui-created',
        paneId: '%3',
      }),
      expect.objectContaining({
        id: 'daemon-pane',
        daemonOnlyField: 'keep-me',
      }),
    ]));
  });

  it('mutates settings without replacing pane records or unknown fields', async () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.psyche', 'psyche.config.json');
    await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [{ id: 'keep-pane', paneId: '%1', slug: 'keep-pane' }];
      config.settings = { thirdPartySetting: 'preserve-me' };
      config.unknownTopLevelField = { retained: true };
    });

    await mutateProjectPaneSettings(projectRoot, (settings) => {
      settings.testCommand = 'pnpm test';
    });

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
      panes: [expect.objectContaining({ id: 'keep-pane', paneId: '%1' })],
      settings: {
        thirdPartySetting: 'preserve-me',
        testCommand: 'pnpm test',
      },
      unknownTopLevelField: { retained: true },
    });
  });

  it('recovers a config lock from a reused live PID with a different start identity', async () => {
    const projectRoot = createProject();
    let ownerIdentity = 'owner-start';
    const first = await acquireProjectPaneConfigLock(projectRoot, {
      pid: 101,
      isProcessAlive: () => true,
      getProcessStartIdentity: () => ownerIdentity,
      createNonce: () => 'first-owner',
    });

    ownerIdentity = 'reused-pid-start';
    const recovered = await acquireProjectPaneConfigLock(projectRoot, {
      pid: 202,
      isProcessAlive: () => true,
      getProcessStartIdentity: (pid) => (
        pid === 101 ? ownerIdentity : 'second-start'
      ),
      createNonce: () => 'second-owner',
    });

    expect(recovered.nonce).toBe('second-owner');
    await first.release();
    await recovered.release();
  });

  it('does not steal a live config lock when process identity is unavailable', async () => {
    const projectRoot = createProject();
    const first = await acquireProjectPaneConfigLock(projectRoot, {
      pid: 101,
      isProcessAlive: () => true,
      getProcessStartIdentity: () => 'first-owner-start',
      createNonce: () => 'first-owner',
    });

    await expect(acquireProjectPaneConfigLock(projectRoot, {
      pid: 202,
      isProcessAlive: () => true,
      // A failed ps lookup is uncertainty, not evidence of PID reuse.
      getProcessStartIdentity: (pid) => (pid === 101 ? undefined : 'second-owner-start'),
      pollIntervalMs: 5,
      timeoutMs: 25,
      createNonce: () => 'second-owner',
    })).rejects.toThrow(/Timed out waiting for project pane config lock/);

    await first.release();
  });
});
