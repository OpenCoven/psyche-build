import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireProjectPaneConfigLock,
  mutateProjectPaneConfig,
} from '../src/services/ProjectPaneConfig.js';

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
});
