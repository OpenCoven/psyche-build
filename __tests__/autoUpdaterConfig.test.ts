import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoUpdater } from '../src/services/AutoUpdater.js';
import { mutateProjectPaneConfig } from '../src/services/ProjectPaneConfig.js';

const roots: string[] = [];

function createProject(config: Record<string, unknown>): {
  projectRoot: string;
  configPath: string;
} {
  const projectRoot = mkdtempSync(path.join(process.cwd(), '.psyche-updater-test-'));
  roots.push(projectRoot);
  const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { projectRoot, configPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AutoUpdater shared project config persistence', () => {
  it('preserves pane records and unknown config fields while updating updater settings', async () => {
    const { configPath } = createProject({
      panes: [{ id: 'pane-1', paneId: '%1', slug: 'keep', prompt: '' }],
      settings: { testCommand: 'pnpm test' },
      updateSettings: { thirdPartyCacheKey: 'preserve-me' },
      unknownTopLevelField: { retained: true },
    });
    const updater = new AutoUpdater(configPath);

    await updater.saveSettings({
      lastCheckTime: 123,
      cachedCurrentVersion: '1.0.0',
      cachedLatestVersion: '1.1.0',
      cachedHasUpdate: true,
    });

    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved).toMatchObject({
      panes: [expect.objectContaining({ id: 'pane-1', paneId: '%1' })],
      settings: { testCommand: 'pnpm test' },
      updateSettings: {
        thirdPartyCacheKey: 'preserve-me',
        lastCheckTime: 123,
        cachedLatestVersion: '1.1.0',
      },
      unknownTopLevelField: { retained: true },
    });
  });

  it('serializes an updater write with a concurrent pane mutation', async () => {
    const { projectRoot, configPath } = createProject({ panes: [] });
    const updater = new AutoUpdater(configPath);

    await Promise.all([
      updater.saveSettings({ lastCheckTime: 456, autoUpdateEnabled: false }),
      mutateProjectPaneConfig(projectRoot, (config) => {
        config.panes = [{
          id: 'daemon-pane',
          paneId: '%2',
          slug: 'daemon-pane',
          prompt: '',
        }];
      }),
    ]);

    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.updateSettings).toMatchObject({
      lastCheckTime: 456,
      autoUpdateEnabled: false,
    });
    expect(saved.panes).toEqual([
      expect.objectContaining({ id: 'daemon-pane', paneId: '%2' }),
    ]);
  });
});
