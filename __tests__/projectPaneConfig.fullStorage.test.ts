import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStorageFaults, injectStorageFault, temporaryLeftovers } from './helpers/storageFaults.js';

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFsPromises(await importOriginal()));

const {
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectPaneConfigError,
  mutateProjectPaneConfig,
  projectConfigSnapshotDirectory,
  projectPaneConfigPath,
  readProjectPaneConfig,
} = await import('../src/services/ProjectPaneConfig.js');

const LOCK = { timeoutMs: 2_000, pollIntervalMs: 10 };

describe('project pane config on full storage', () => {
  let projectRoot: string;
  let configPath: string;

  beforeEach(async () => {
    projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-config-full-')));
    configPath = projectPaneConfigPath(projectRoot);
    await mkdir(path.dirname(configPath), { recursive: true });
  });

  afterEach(async () => {
    clearStorageFaults();
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function seed(config: Record<string, unknown>): Promise<string> {
    const bytes = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configPath, bytes, 'utf8');
    return bytes;
  }

  it.each(['ENOSPC', 'EDQUOT'] as const)(
    'a %s mid-write surfaces config_write_failed and keeps the prior config',
    async (code) => {
      const prior = await seed({
        schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
        projectName: 'full',
        panes: [{ id: 'pane-1', paneId: '%1', slug: 'pane-1' }],
      });
      const fault = injectStorageFault({
        code,
        afterBytes: 16,
        match: (filePath) => filePath.endsWith('.tmp') && filePath.includes('psyche.config.json'),
      });

      const error = await mutateProjectPaneConfig(projectRoot, (config) => {
        config.panes = [];
      }, LOCK).then(() => undefined, (caught: unknown) => caught);

      expect(fault.landed).toBe(1);
      expect(error).toBeInstanceOf(ProjectPaneConfigError);
      expect((error as InstanceType<typeof ProjectPaneConfigError>).code).toBe('config_write_failed');
      expect((error as Error).message).toContain(code);
      expect(await readFile(configPath, 'utf8')).toBe(prior);
      expect(temporaryLeftovers(await readdir(path.dirname(configPath)))).toEqual([]);

      // The lease was released and the store still works once space returns.
      fault.remove();
      await mutateProjectPaneConfig(projectRoot, (config) => {
        config.panes = [];
      }, LOCK);
      expect((await readProjectPaneConfig(projectRoot)).panes).toEqual([]);
    },
  );

  it('a full disk while snapshotting a superseded schema leaves no partial snapshot and no migration', async () => {
    const prior = await seed({
      projectName: 'unversioned',
      panes: [{ id: 'pane-1', paneId: '%1', slug: 'pane-1' }],
    });
    const snapshotDir = projectConfigSnapshotDirectory(projectRoot);
    const fault = injectStorageFault({
      code: 'ENOSPC',
      afterBytes: 8,
      match: (filePath) => filePath.startsWith(snapshotDir),
    });

    const error = await mutateProjectPaneConfig(projectRoot, (config) => {
      config.panes = [];
    }, LOCK).then(() => undefined, (caught: unknown) => caught);

    expect(fault.landed).toBe(1);
    expect((error as InstanceType<typeof ProjectPaneConfigError>).code).toBe('config_snapshot_failed');
    expect(await readFile(configPath, 'utf8')).toBe(prior);
    // A truncated file under a snapshot name would pose as a recovery point.
    expect(await readdir(snapshotDir)).toEqual([]);
  });

  it('a full disk reported only at the snapshot fsync leaves no snapshot and no migration', async () => {
    const prior = await seed({ projectName: 'unversioned', panes: [] });
    const snapshotDir = projectConfigSnapshotDirectory(projectRoot);
    const fault = injectStorageFault({
      code: 'ENOSPC',
      at: 'sync',
      match: (filePath) => filePath.startsWith(snapshotDir),
    });

    await expect(mutateProjectPaneConfig(projectRoot, () => undefined, LOCK))
      .rejects.toMatchObject({ code: 'config_snapshot_failed' });
    expect(fault.landed).toBe(1);
    expect(await readFile(configPath, 'utf8')).toBe(prior);
    expect(await readdir(snapshotDir)).toEqual([]);
  });
});
