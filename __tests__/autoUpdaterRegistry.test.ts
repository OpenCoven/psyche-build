import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync,
}));

const { AutoUpdater, REGISTRY_UPDATES_ENABLED } = await import('../src/services/AutoUpdater.js');

const roots: string[] = [];

function configFile(updateSettings: Record<string, unknown> = {}): string {
  const projectRoot = mkdtempSync(path.join(process.cwd(), '.psyche-updater-registry-test-'));
  roots.push(projectRoot);
  const file = path.join(projectRoot, '.psyche', 'psyche.config.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ panes: [], updateSettings }, null, 2));
  return file;
}

describe('AutoUpdater without a trusted update channel', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    execSync.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps registry updates disabled until a signed channel exists', () => {
    expect(REGISTRY_UPDATES_ENABLED).toBe(false);
  });

  it('never asks a package registry for a version', async () => {
    const updater = new AutoUpdater(configFile());

    await expect(updater.getLatestVersion()).resolves.toBeNull();
    const info = await updater.checkForUpdates();

    expect(info.hasUpdate).toBe(false);
    expect(info.latestVersion).toBe('unknown');
    expect(fetchSpy).not.toHaveBeenCalled();
    const registryCalls = execSync.mock.calls.filter(([command]) =>
      /\b(?:npm|pnpm|yarn)\s+(?:view|info|show)\b/.test(String(command)),
    );
    expect(registryCalls).toEqual([]);
  });

  it('never runs a global install even when handed an update', async () => {
    const updater = new AutoUpdater(configFile());

    const updated = await updater.performUpdate({
      currentVersion: '0.0.2',
      latestVersion: '9.9.9',
      hasUpdate: true,
      packageManager: 'npm',
      installMethod: 'global',
    });

    expect(updated).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it('ignores a cached registry answer from an earlier version', async () => {
    const updater = new AutoUpdater(
      configFile({
        cachedCurrentVersion: '0.0.2',
        cachedLatestVersion: '9.9.9',
        cachedHasUpdate: true,
      }),
    );

    await expect(updater.getCachedUpdateInfo()).resolves.toBeNull();
  });
});
