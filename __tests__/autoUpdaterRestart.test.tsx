import React, { useEffect } from 'react';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';

import useAutoUpdater from '../src/hooks/useAutoUpdater.js';
import {
  AutoUpdater,
  REGISTRY_UPDATES_ENABLED,
  isInsideGlobalPackageRoot,
  readInstalledPackageVersion,
} from '../src/services/AutoUpdater.js';

const roots: string[] = [];

function packageJsonAt(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'psyche-updater-installed-'));
  roots.push(root);
  const file = path.join(root, 'package.json');
  writeFileSync(file, JSON.stringify({ name: 'psyche-build', version }));
  return file;
}

// A fake package-manager global root holding an installed psyche-build.
function globalInstall(version: string): { globalRoot: string; packageJson: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'psyche-updater-global-'));
  roots.push(base);
  const globalRoot = path.join(base, 'lib', 'node_modules');
  const packageDir = path.join(globalRoot, 'psyche-build');
  mkdirSync(packageDir, { recursive: true });
  const packageJson = path.join(packageDir, 'package.json');
  writeFileSync(packageJson, JSON.stringify({ name: 'psyche-build', version }));
  return { globalRoot, packageJson };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type HookApi = ReturnType<typeof useAutoUpdater>;

function Harness({
  autoUpdater,
  onApi,
  onStatus,
}: {
  autoUpdater: unknown;
  onApi: (api: HookApi) => void;
  onStatus: (message: string) => void;
}) {
  const api = useAutoUpdater(autoUpdater, onStatus);
  useEffect(() => {
    onApi(api);
  });
  return <Text>{api.isUpdating ? 'updating' : 'idle'}</Text>;
}

const updateInfo = {
  currentVersion: '0.0.2',
  latestVersion: '0.0.3',
  hasUpdate: true,
  packageManager: 'npm' as const,
  installMethod: 'global' as const,
};

describe('useAutoUpdater after an update', () => {
  it('never exits the process and tells the user to restart when ready', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const statuses: string[] = [];
    let api: HookApi | undefined;
    // No configFile, so the hook never starts the update-check worker.
    const autoUpdater = { performUpdate: vi.fn().mockResolvedValue(true), skipVersion: vi.fn() };

    const { unmount } = render(
      <Harness
        autoUpdater={autoUpdater}
        onApi={(next) => {
          api = next;
        }}
        onStatus={(message) => statuses.push(message)}
      />,
    );
    await vi.waitFor(() => expect(api).toBeDefined());
    api!.setUpdateInfo(updateInfo);
    await vi.waitFor(() => expect(api!.updateInfo).toEqual(updateInfo));

    vi.useFakeTimers();
    await api!.performUpdate();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(autoUpdater.performUpdate).toHaveBeenCalledWith(updateInfo);
    expect(exit).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatch(/restart psyche when you are ready/i);
    unmount();
  });

  it('keeps no timed process exit in the hook source', () => {
    const source = readFileSync('src/hooks/useAutoUpdater.ts', 'utf8');
    expect(source).not.toMatch(/process\.exit/);
  });
});

describe('AutoUpdater post-install verification', () => {
  it('keeps registry updates disabled', () => {
    expect(REGISTRY_UPDATES_ENABLED).toBe(false);
  });

  it('reads the installed version freshly from disk, not from a module cache', () => {
    const file = packageJsonAt('0.0.2');
    expect(readInstalledPackageVersion(file)).toBe('0.0.2');

    // A global install replaces the package in place; the running process's
    // require cache would keep reporting the old version.
    writeFileSync(file, JSON.stringify({ name: 'psyche-build', version: '0.0.3' }));
    expect(readInstalledPackageVersion(file)).toBe('0.0.3');
  });

  it('returns null for a missing or malformed installed package.json', () => {
    const file = packageJsonAt('0.0.2');
    expect(readInstalledPackageVersion(`${file}.missing`)).toBeNull();
    writeFileSync(file, '{ not json');
    expect(readInstalledPackageVersion(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 3 }));
    expect(readInstalledPackageVersion(file)).toBeNull();
  });

  it('verifies the expected version against the current global install', () => {
    const updater = new AutoUpdater('/unused/.psyche/psyche.config.json');
    const { globalRoot, packageJson } = globalInstall('0.0.2');

    expect(updater.verifyInstalledVersion('0.0.3', globalRoot, 'psyche-build')).toBe('mismatch');
    writeFileSync(packageJson, JSON.stringify({ name: 'psyche-build', version: '0.0.3' }));
    expect(updater.verifyInstalledVersion('0.0.3', globalRoot, 'psyche-build')).toBe('verified');
    // Nothing installed under that name in the global root.
    expect(updater.verifyInstalledVersion('0.0.3', globalRoot, 'other-package')).toBe('unverified');
  });

  it('follows a pnpm global link switched to a new store directory', () => {
    const updater = new AutoUpdater('/unused/.psyche/psyche.config.json');
    const base = mkdtempSync(path.join(tmpdir(), 'psyche-updater-pnpm-'));
    roots.push(base);
    const globalRoot = path.join(base, 'global', '5', 'node_modules');
    const storeDir = (version: string) =>
      path.join(globalRoot, '.pnpm', `psyche-build@${version}`, 'node_modules', 'psyche-build');
    for (const version of ['0.0.2', '0.0.3']) {
      mkdirSync(storeDir(version), { recursive: true });
      writeFileSync(
        path.join(storeDir(version), 'package.json'),
        JSON.stringify({ name: 'psyche-build', version }),
      );
    }
    const globalLink = path.join(globalRoot, 'psyche-build');
    // Before the update the running module was loaded from the 0.0.2 store path.
    symlinkSync(storeDir('0.0.2'), globalLink, 'dir');
    const runningManifest = path.join(storeDir('0.0.2'), 'package.json');
    // `pnpm update -g` points the global link at the new store directory.
    rmSync(globalLink);
    symlinkSync(storeDir('0.0.3'), globalLink, 'dir');

    // The running module's physical path still holds the old manifest...
    expect(readInstalledPackageVersion(runningManifest)).toBe('0.0.2');
    // ...but verification resolves the current global install.
    expect(updater.verifyInstalledVersion('0.0.3', globalRoot, 'psyche-build')).toBe('verified');
  });

  it('refuses to verify without a detectable global root', () => {
    const updater = new AutoUpdater('/unused/.psyche/psyche.config.json');
    expect(updater.verifyInstalledVersion('0.0.3', null, 'psyche-build')).toBe('unverified');
  });

  it('refuses to verify a source checkout linked into the global root', () => {
    const updater = new AutoUpdater('/unused/.psyche/psyche.config.json');
    const base = mkdtempSync(path.join(tmpdir(), 'psyche-updater-link-'));
    roots.push(base);
    const globalRoot = path.join(base, 'global', 'node_modules');
    mkdirSync(globalRoot, { recursive: true });
    const checkout = packageJsonAt('0.0.3');
    // `npm link` style: the global entry is a symlink to the source checkout.
    symlinkSync(path.dirname(checkout), path.join(globalRoot, 'psyche-build'), 'dir');
    const linkedPackageJson = path.join(globalRoot, 'psyche-build', 'package.json');

    expect(readInstalledPackageVersion(linkedPackageJson)).toBe('0.0.3');
    expect(isInsideGlobalPackageRoot(linkedPackageJson, globalRoot)).toBe(false);
    expect(isInsideGlobalPackageRoot(checkout, globalRoot)).toBe(false);
    expect(updater.verifyInstalledVersion('0.0.3', globalRoot, 'psyche-build')).toBe('unverified');
  });

  it('refuses a package name that could escape the global root', () => {
    const updater = new AutoUpdater('/unused/.psyche/psyche.config.json');
    const { globalRoot } = globalInstall('0.0.3');
    for (const name of ['../psyche-build', 'a/../../b', '/abs', '']) {
      expect(updater.verifyInstalledVersion('0.0.3', globalRoot, name)).toBe('unverified');
    }
  });

  it('refuses an installed manifest that names a different package', () => {
    const updater = new AutoUpdater('/unused/.psyche/psyche.config.json');
    const { globalRoot, packageJson } = globalInstall('0.0.3');
    writeFileSync(packageJson, JSON.stringify({ name: 'impostor', version: '0.0.3' }));
    expect(updater.verifyInstalledVersion('0.0.3', globalRoot, 'psyche-build')).toBe('unverified');
  });

  it('does not treat the global root itself as an installed package', () => {
    const { globalRoot } = globalInstall('0.0.3');
    expect(isInsideGlobalPackageRoot(globalRoot, globalRoot)).toBe(false);
  });

  it('does not verify an install through the cached running version', () => {
    const source = readFileSync('src/services/AutoUpdater.ts', 'utf8');
    const performUpdate = source.slice(
      source.indexOf('async performUpdate('),
      source.indexOf('async skipVersion('),
    );
    expect(performUpdate).not.toContain('checkForUpdates(');
    expect(performUpdate).toContain('detectGlobalPackageRoot(updateInfo.packageManager)');
    expect(performUpdate).toContain(
      "verifyInstalledVersion(updateInfo.latestVersion, globalRoot) === 'verified'",
    );
  });
});
