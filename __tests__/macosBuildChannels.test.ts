import { EventEmitter } from 'node:events';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { rename as renameAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertBundleIdentity,
  buildCommandsFor,
  channelConfig,
  createDevTauriConfig,
  findCandidateApp,
  installBundleTransactional,
  parseBuildArguments,
  smokeLaunchBundle,
  writeBuildProvenance,
} from '../scripts/build-macos-app.mjs';

const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, 'scripts/build-macos-app.mjs');
const tauriRelativeCwd = 'native/macos/psyche-build-tauri';
const tauriDirectory = join(repositoryRoot, tauriRelativeCwd);
const manifestPath = 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml';
const devConfigPath = resolve(repositoryRoot, 'native/macos/psyche-build-tauri/dev.tauri.generated.json');
const scratchRoot = join(repositoryRoot, '.agent-test-artifacts', 'macos-build-channels');

const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

type TauriWindow = {
  label?: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  transparent: boolean;
};

type TauriConfig = {
  productName: string;
  identifier: string;
  build: Record<string, unknown>;
  bundle: Record<string, unknown>;
  app: {
    security: Record<string, unknown>;
    windows: TauriWindow[];
  };
};

const macosTauriConfig = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      'native/macos/psyche-build-tauri/src-tauri/tauri.conf.json',
    ),
    'utf8',
  ),
) as TauriConfig;

let scratchSequence = 0;
const scratchDirs: string[] = [];

const tick = () => new Promise<void>((resolveTick) => setImmediate(resolveTick));

function createBundleDirectory(relativePaths: string[]): string {
  const bundleDir = join(scratchRoot, String(scratchSequence++));
  scratchDirs.push(bundleDir);

  for (const relativePath of relativePaths) {
    mkdirSync(join(bundleDir, relativePath), { recursive: true });
  }

  return bundleDir;
}

function createScratchDirectory(label: string): string {
  const dir = join(scratchRoot, `${String(scratchSequence++)}-${label}`);
  scratchDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createAppBundle(root: string, relativePath: string, marker: string): string {
  const appPath = join(root, relativePath);
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(appPath, 'Contents', 'marker.txt'), marker, 'utf8');
  return appPath;
}

function readAppMarker(appPath: string): string {
  return readFileSync(join(appPath, 'Contents', 'marker.txt'), 'utf8');
}

function copyBundle(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true });
}

function createSleepController() {
  const pending: Array<{ ms: number; resolve: () => void }> = [];
  const sleep = vi.fn((ms: number) => new Promise<void>((resolveSleep) => {
    pending.push({ ms, resolve: resolveSleep });
  }));

  return {
    sleep,
    pending,
    async resolveNext(expectedMs: number) {
      const next = pending.shift();
      expect(next?.ms).toBe(expectedMs);
      next?.resolve();
      await tick();
    },
  };
}

type FakeChildProcess = ChildProcess &
  EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ChildProcess['kill'];
  };

function createFakeChildProcess(
  onKill?: (signal: NodeJS.Signals | number | undefined) => void,
): {
  child: FakeChildProcess;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
  close: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  fail: (error: Error) => void;
} {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    onKill?.(signal);
    return true;
  }) as ChildProcess['kill'];

  return {
    child,
    writeStdout(value: string) {
      child.stdout.write(value);
    },
    writeStderr(value: string) {
      child.stderr.write(value);
    },
    close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      child.emit('close', code, signal);
    },
    fail(error: Error) {
      child.emit('error', error);
    },
  };
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('macOS build channels', () => {
  it('defines stable and dev app build scripts and preserves production identity', () => {
    expect(packageJson.scripts['app:stable']).toBe('node scripts/build-macos-app.mjs stable');
    expect(packageJson.scripts['app:dev']).toBe('node scripts/build-macos-app.mjs dev');
    expect(macosTauriConfig.productName).toBe('Psyche Build');
    expect(macosTauriConfig.identifier).toBe('dev.opencoven.psyche');
    expect(macosTauriConfig.app.windows[0].title).toBe('Psyche Build');
  });

  describe('parseBuildArguments', () => {
    it('parses stable builds with exactly one nonblank git ref after removing separators', () => {
      expect(parseBuildArguments(['stable', '--', 'origin/release/v1.2.3'])).toEqual({
        channel: 'stable',
        ref: 'origin/release/v1.2.3',
      });
      expect(parseBuildArguments(['stable', '  origin/release/v1.2.3  '])).toEqual({
        channel: 'stable',
        ref: 'origin/release/v1.2.3',
      });
    });

    it('parses dev builds with no ref after removing separators', () => {
      expect(parseBuildArguments(['--', 'dev', '--'])).toEqual({ channel: 'dev' });
    });

    it('rejects channels other than stable or dev', () => {
      expect(() => parseBuildArguments(['preview'])).toThrow(
        'Build channel must be "stable" or "dev"',
      );
    });

    it('rejects stable builds without exactly one nonblank git ref', () => {
      expect(() => parseBuildArguments(['stable'])).toThrow(
        'stable builds require exactly one nonblank Git ref',
      );
      expect(() => parseBuildArguments(['stable', '   '])).toThrow(
        'stable builds require exactly one nonblank Git ref',
      );
      expect(() => parseBuildArguments(['stable', 'main', 'release'])).toThrow(
        'stable builds require exactly one nonblank Git ref',
      );
    });

    it('rejects dev builds when a git ref is provided', () => {
      expect(() => parseBuildArguments(['dev', 'main'])).toThrow(
        'dev builds do not accept a Git ref',
      );
    });
  });

  describe('channelConfig', () => {
    it('returns stable channel identity', () => {
      expect(channelConfig('stable')).toEqual({
        productName: 'Psyche Build',
        bundleIdentifier: 'dev.opencoven.psyche',
        appName: 'Psyche Build.app',
      });
    });

    it('returns dev channel identity without overlapping stable values', () => {
      const stable = channelConfig('stable');
      const dev = channelConfig('dev');

      expect(dev).toEqual({
        productName: 'Psyche Build Dev',
        bundleIdentifier: 'dev.opencoven.psyche.dev',
        appName: 'Psyche Build Dev.app',
      });
      expect(dev).not.toBe(stable);
      expect(dev.productName).not.toBe(stable.productName);
      expect(dev.bundleIdentifier).not.toBe(stable.bundleIdentifier);
      expect(dev.appName).not.toBe(stable.appName);
    });

    it('rejects unknown channels', () => {
      expect(() => channelConfig('preview' as never)).toThrow(
        'Unknown build channel "preview"',
      );
    });
  });

  describe('createDevTauriConfig', () => {
    it('creates a full dev config without mutating production values', () => {
      const production = structuredClone(macosTauriConfig);
      const snapshot = structuredClone(macosTauriConfig);

      const dev = createDevTauriConfig(production);

      expect(dev).toEqual({
        ...snapshot,
        productName: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        app: {
          ...snapshot.app,
          windows: snapshot.app.windows.map((window) =>
            window.label === 'main'
              ? { ...window, title: 'Psyche Build Dev' }
              : structuredClone(window),
          ),
        },
      });
      expect(dev.app.windows[0]).toMatchObject({
        width: snapshot.app.windows[0].width,
        height: snapshot.app.windows[0].height,
        minWidth: snapshot.app.windows[0].minWidth,
        transparent: snapshot.app.windows[0].transparent,
      });
      expect(dev.build).toEqual(snapshot.build);
      expect(dev.bundle).toEqual(snapshot.bundle);
      expect(dev.app.security).toEqual(snapshot.app.security);
      expect(production).toEqual(snapshot);
    });

    it('fails when the production config has no main window', () => {
      const withoutMain = structuredClone(macosTauriConfig);
      withoutMain.app.windows[0] = {
        ...withoutMain.app.windows[0],
        label: 'secondary',
      };

      expect(() => createDevTauriConfig(withoutMain)).toThrow(
        'Production Tauri config must contain an app.windows entry labeled "main"',
      );
    });
  });

  describe('buildCommandsFor', () => {
    it('returns the exact stable command sequence as fresh tuple arrays', () => {
      const first = buildCommandsFor('stable');
      const second = buildCommandsFor('stable');

      expect(first).toEqual([
        ['pnpm', ['install', '--frozen-lockfile'], '.'],
        ['pnpm', ['test'], '.'],
        ['pnpm', ['typecheck'], '.'],
        ['pnpm', ['build'], '.'],
        ['pnpm', ['smoke:pack'], '.'],
        ['cargo', ['fmt', '--manifest-path', manifestPath, '--check'], '.'],
        ['cargo', ['test', '--manifest-path', manifestPath, '--locked'], '.'],
        ['cargo', ['check', '--manifest-path', manifestPath, '--locked'], '.'],
        ['pnpm', ['build:web'], tauriRelativeCwd],
        ['pnpm', ['exec', 'tauri', 'build', '--bundles', 'app'], tauriRelativeCwd],
      ]);
      expect(first).not.toBe(second);
      first.forEach((command, index) => {
        expect(command).not.toBe(second[index]);
        expect(command[1]).not.toBe(second[index]?.[1]);
      });
    });

    it('returns the exact dev command sequence with the injected absolute config path', () => {
      expect(buildCommandsFor('dev', { devConfigPath })).toEqual([
        ['pnpm', ['build:web'], tauriRelativeCwd],
        [
          'pnpm',
          ['exec', 'tauri', 'build', '--bundles', 'app', '--config', devConfigPath],
          tauriRelativeCwd,
        ],
      ]);
    });

    it('requires a dev config path for dev builds', () => {
      const buildCommandsForRuntime = buildCommandsFor as unknown as (
        channel: 'dev',
        options?: { devConfigPath?: string },
      ) => unknown;

      expect(() => buildCommandsForRuntime('dev')).toThrow(
        'dev builds require a devConfigPath',
      );
    });
  });

  describe('findCandidateApp', () => {
    it('returns the only matching app bundle and does not recurse into the matched app', async () => {
      const bundleDir = createBundleDirectory([
        'Psyche Build.app/Contents/MacOS',
        'Psyche Build.app/Contents/Hidden/Psyche Build.app',
        'nested/Other.app',
      ]);

      await expect(findCandidateApp(bundleDir, 'Psyche Build.app')).resolves.toBe(
        join(bundleDir, 'Psyche Build.app'),
      );
    });

    it('rejects when the expected app is missing', async () => {
      const bundleDir = createBundleDirectory(['nested/Other.app']);

      await expect(findCandidateApp(bundleDir, 'Psyche Build.app')).rejects.toThrow(
        'Expected exactly one "Psyche Build.app" bundle, found 0',
      );
    });

    it('rejects when multiple matching apps exist', async () => {
      const bundleDir = createBundleDirectory([
        'Psyche Build.app',
        'nested/Psyche Build.app',
      ]);

      await expect(findCandidateApp(bundleDir, 'Psyche Build.app')).rejects.toThrow(
        'Expected exactly one "Psyche Build.app" bundle, found 2',
      );
    });
  });

  describe('assertBundleIdentity', () => {
    it('rejects when the app basename does not match the requested channel identity', () => {
      expect(() =>
        assertBundleIdentity(
          '/Applications/Psyche Build Dev.app',
          {
            name: 'Psyche Build',
            identifier: 'dev.opencoven.psyche',
            executable: 'Psyche Build',
          },
          channelConfig('stable'),
        ),
      ).toThrow(
        'actual appName="Psyche Build Dev" identity.name="Psyche Build" identity.identifier="dev.opencoven.psyche"',
      );
    });

    it('rejects when CFBundleName does not match the requested channel identity', () => {
      expect(() =>
        assertBundleIdentity(
          '/Applications/Psyche Build.app',
          {
            name: 'Psyche Build Dev',
            identifier: 'dev.opencoven.psyche',
            executable: 'Psyche Build',
          },
          channelConfig('stable'),
        ),
      ).toThrow(
        'actual appName="Psyche Build" identity.name="Psyche Build Dev" identity.identifier="dev.opencoven.psyche"',
      );
    });

    it('rejects when the bundle identifier does not match the requested channel identity', () => {
      expect(() =>
        assertBundleIdentity(
          '/Applications/Psyche Build.app',
          {
            name: 'Psyche Build',
            identifier: 'dev.opencoven.psyche.dev',
            executable: 'Psyche Build',
          },
          channelConfig('stable'),
        ),
      ).toThrow(
        'expected productName="Psyche Build" bundleIdentifier="dev.opencoven.psyche"',
      );
      expect(() =>
        assertBundleIdentity(
          '/Applications/Psyche Build.app',
          {
            name: 'Psyche Build',
            identifier: 'dev.opencoven.psyche.dev',
            executable: 'Psyche Build',
          },
          channelConfig('stable'),
        ),
      ).toThrow(
        'actual appName="Psyche Build" identity.name="Psyche Build" identity.identifier="dev.opencoven.psyche.dev"',
      );
    });
  });

  describe('smokeLaunchBundle', () => {
    it('fails with a startup-smoke error when spawning throws synchronously and still cleans up', async () => {
      const spawnProcess = vi.fn(() => {
        throw new Error('spawn EPERM');
      });
      const removeTemporaryHome = vi.fn(async () => {});
      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        spawnProcess,
        makeTemporaryHome: async () => '/virtual/home',
        removeTemporaryHome,
      });

      await expect(launch).rejects.toThrow(/startup smoke/i);
      await expect(launch).rejects.toThrow(/spawn EPERM/);
      expect(removeTemporaryHome).toHaveBeenCalledWith('/virtual/home');
    });

    it('fails with a startup-smoke error when the child emits an error and still cleans up', async () => {
      const child = createFakeChildProcess();
      const spawnProcess = vi.fn(() => child.child);
      const removeTemporaryHome = vi.fn(async () => {});

      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        spawnProcess,
        makeTemporaryHome: async () => '/virtual/home',
        removeTemporaryHome,
      });

      await tick();
      child.writeStdout('booting\n');
      child.writeStderr('permission denied\n');
      child.fail(new Error('spawn EACCES'));

      await expect(launch).rejects.toThrow(/startup smoke/i);
      await expect(launch).rejects.toThrow(/spawn EACCES/);
      await expect(launch).rejects.toThrow(/booting/);
      await expect(launch).rejects.toThrow(/permission denied/);
      expect(removeTemporaryHome).toHaveBeenCalledWith('/virtual/home');
    });

    it('fails on early exit, reports output, skips termination, and cleans up the temporary home', async () => {
      const child = createFakeChildProcess();
      const sleep = createSleepController();
      const spawnProcess = vi.fn(() => child.child);
      const makeTemporaryHome = vi.fn(async () => '/virtual/home');
      const removeTemporaryHome = vi.fn(async () => {});

      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        args: ['--smoke'],
        spawnProcess,
        sleep: sleep.sleep,
        makeTemporaryHome,
        removeTemporaryHome,
      });

      await tick();
      child.writeStdout('booting\n');
      child.writeStderr('boom\n');
      child.close(23, null);

      await expect(launch).rejects.toThrow(/exit code 23/);
      await expect(launch).rejects.toThrow(/booting/);
      await expect(launch).rejects.toThrow(/boom/);
      expect(child.child.kill).not.toHaveBeenCalled();
      expect(removeTemporaryHome).toHaveBeenCalledWith('/virtual/home');
      expect(spawnProcess).toHaveBeenCalledWith(
        '/Applications/Psyche Build.app/Contents/MacOS/Psyche Build',
        ['--smoke'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
          env: expect.objectContaining({
            HOME: '/virtual/home',
            TMPDIR: '/virtual/home/tmp',
            XDG_CONFIG_HOME: '/virtual/home/.config',
            XDG_CACHE_HOME: '/virtual/home/.cache',
            XDG_DATA_HOME: '/virtual/home/.local/share',
          }),
        }),
      );
    });

    it('waits through the smoke window, terminates with SIGTERM, and cleans up on success', async () => {
      const child = createFakeChildProcess((signal) => {
        if (signal === 'SIGTERM') {
          child.close(0, 'SIGTERM');
        }
      });
      const sleep = createSleepController();
      const spawnProcess = vi.fn(() => child.child);
      const removeTemporaryHome = vi.fn(async () => {});

      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        spawnProcess,
        sleep: sleep.sleep,
        makeTemporaryHome: async () => '/virtual/home',
        removeTemporaryHome,
      });

      await tick();
      await sleep.resolveNext(5000);
      await launch;

      expect(child.child.kill).toHaveBeenCalledTimes(1);
      expect(child.child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(removeTemporaryHome).toHaveBeenCalledWith('/virtual/home');
    });

    it('sends SIGKILL only if the app ignores SIGTERM', async () => {
      const child = createFakeChildProcess((signal) => {
        if (signal === 'SIGKILL') {
          child.close(null, 'SIGKILL');
        }
      });
      const sleep = createSleepController();

      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        spawnProcess: vi.fn(() => child.child),
        sleep: sleep.sleep,
        makeTemporaryHome: async () => '/virtual/home',
        removeTemporaryHome: async () => {},
      });

      await tick();
      await sleep.resolveNext(5000);
      expect(child.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

      await sleep.resolveNext(5000);
      await launch;

      expect(child.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(child.child.kill).toHaveBeenCalledTimes(2);
    });

    it('fails explicitly and still cleans up when the child does not exit after SIGKILL', async () => {
      const child = createFakeChildProcess();
      const sleep = createSleepController();
      const removeTemporaryHome = vi.fn(async () => {});
      const pending = Symbol('pending');

      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        spawnProcess: vi.fn(() => child.child),
        sleep: sleep.sleep,
        smokeMs: 50,
        termTimeoutMs: 60,
        postKillTimeoutMs: 70,
        makeTemporaryHome: async () => '/virtual/home',
        removeTemporaryHome,
      });
      const launchOutcome = launch.then(
        () => 'resolved',
        (error: unknown) => error,
      );

      await tick();
      await sleep.resolveNext(50);
      expect(child.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

      await sleep.resolveNext(60);
      expect(child.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

      await sleep.resolveNext(70);

      const outcome = await Promise.race([
        launchOutcome,
        tick().then(() => pending),
      ]);

      expect(outcome).not.toBe(pending);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain('did not exit within 70ms after SIGKILL');
      expect(removeTemporaryHome).toHaveBeenCalledWith('/virtual/home');
    });
  });

  describe('installBundleTransactional', () => {
    it('replaces the dev app while leaving the stable app untouched', async () => {
      const homeDir = createScratchDirectory('install-dev-replacement');
      const applicationsDir = join(homeDir, 'Applications');
      const stablePath = createAppBundle(applicationsDir, 'Psyche Build.app', 'stable-known-good');
      const existingDevPath = createAppBundle(applicationsDir, 'Psyche Build Dev.app', 'dev-known-good');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-dev'),
        'Psyche Build Dev.app',
        'dev-candidate',
      );
      const validateInstalledBundle = vi.fn(async (appPath: string) => {
        expect(readAppMarker(appPath)).toContain('dev');
      });

      const installedPath = await installBundleTransactional(candidatePath, channelConfig('dev'), {
        homeDir,
        copyBundle,
        validateInstalledBundle,
        randomUUID: () => 'dev-replacement',
      });

      expect(installedPath).toBe(existingDevPath);
      expect(readAppMarker(stablePath)).toBe('stable-known-good');
      expect(readAppMarker(existingDevPath)).toBe('dev-candidate');
      expect(validateInstalledBundle).toHaveBeenCalledTimes(2);
      expect(readdirSync(applicationsDir).sort()).toEqual([
        'Psyche Build Dev.app',
        'Psyche Build.app',
      ]);
    });

    it('installs the first app when no prior channel bundle exists', async () => {
      const homeDir = createScratchDirectory('install-first-app');
      const applicationsDir = join(homeDir, 'Applications');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-first-install'),
        'Psyche Build.app',
        'stable-first-install',
      );
      const validateInstalledBundle = vi.fn(async (appPath: string) => {
        expect(readAppMarker(appPath)).toBe('stable-first-install');
      });

      const installedPath = await installBundleTransactional(candidatePath, channelConfig('stable'), {
        homeDir,
        copyBundle,
        validateInstalledBundle,
        randomUUID: () => 'first-install',
      });

      expect(installedPath).toBe(join(applicationsDir, 'Psyche Build.app'));
      expect(readAppMarker(installedPath)).toBe('stable-first-install');
      expect(validateInstalledBundle).toHaveBeenCalledTimes(2);
      expect(readdirSync(applicationsDir)).toEqual(['Psyche Build.app']);
    });

    it('restores the known-good app when the final rename fails', async () => {
      const homeDir = createScratchDirectory('install-final-rename-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const finalPath = createAppBundle(applicationsDir, 'Psyche Build Dev.app', 'known-good');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-final-rename-failure'),
        'Psyche Build Dev.app',
        'replacement',
      );
      let renameCallCount = 0;

      await expect(
        installBundleTransactional(candidatePath, channelConfig('dev'), {
          homeDir,
          copyBundle,
          validateInstalledBundle: async () => {},
          randomUUID: () => 'rename-failure',
          renamePath: async (from: string, to: string) => {
            renameCallCount += 1;
            if (renameCallCount === 2) {
              throw new Error(`rename failed for ${from} -> ${to}`);
            }
            await renameAsync(from, to);
          },
        }),
      ).rejects.toThrow(/rename failed/i);

      expect(readAppMarker(finalPath)).toBe('known-good');
      expect(readdirSync(applicationsDir)).toEqual(['Psyche Build Dev.app']);
    });

    it('removes the failed candidate and restores the known-good app when final validation fails', async () => {
      const homeDir = createScratchDirectory('install-final-validation-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const finalPath = createAppBundle(applicationsDir, 'Psyche Build.app', 'known-good');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-final-validation-failure'),
        'Psyche Build.app',
        'replacement',
      );

      await expect(
        installBundleTransactional(candidatePath, channelConfig('stable'), {
          homeDir,
          copyBundle,
          randomUUID: () => 'validation-failure',
          validateInstalledBundle: async (appPath: string) => {
            if (appPath === finalPath) {
              throw new Error('final validation failed');
            }
          },
        }),
      ).rejects.toThrow(/final validation failed/);

      expect(readAppMarker(finalPath)).toBe('known-good');
      expect(readdirSync(applicationsDir)).toEqual(['Psyche Build.app']);
    });

    it('reports both the installation failure and rollback failure explicitly', async () => {
      const homeDir = createScratchDirectory('install-rollback-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const finalPath = createAppBundle(applicationsDir, 'Psyche Build Dev.app', 'known-good');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-rollback-failure'),
        'Psyche Build Dev.app',
        'replacement',
      );
      let renameCallCount = 0;

      const install = installBundleTransactional(candidatePath, channelConfig('dev'), {
        homeDir,
        copyBundle,
        randomUUID: () => 'rollback-failure',
        validateInstalledBundle: async (appPath: string) => {
          if (appPath === finalPath) {
            throw new Error('final validation failed');
          }
        },
        renamePath: async (from: string, to: string) => {
          renameCallCount += 1;
          if (renameCallCount === 3) {
            throw new Error(`rollback restore failed for ${from} -> ${to}`);
          }
          await renameAsync(from, to);
        },
      });

      await expect(install).rejects.toThrow(/final validation failed/);
      await expect(install).rejects.toThrow(/rollback restore failed/);
    });

    it('cleans up staging paths after a successful install', async () => {
      const homeDir = createScratchDirectory('install-staging-cleanup');
      const applicationsDir = join(homeDir, 'Applications');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-staging-cleanup'),
        'Psyche Build Dev.app',
        'cleanup-target',
      );

      await installBundleTransactional(candidatePath, channelConfig('dev'), {
        homeDir,
        copyBundle,
        validateInstalledBundle: async () => {},
        randomUUID: () => 'cleanup',
      });

      expect(readdirSync(applicationsDir)).toEqual(['Psyche Build Dev.app']);
    });
  });

  describe('writeBuildProvenance', () => {
    const stableRecord = {
      channel: 'stable' as const,
      commitSha: 'abc1234',
      requestedRef: 'origin/release/v1.2.3',
      dirty: false,
      builtAt: '2026-08-10T10:00:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build.app',
      productName: 'Psyche Build',
      bundleIdentifier: 'dev.opencoven.psyche',
    };
    const devRecord = {
      channel: 'dev' as const,
      commitSha: 'def5678',
      dirty: true,
      builtAt: '2026-08-10T11:00:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build Dev.app',
      productName: 'Psyche Build Dev',
      bundleIdentifier: 'dev.opencoven.psyche.dev',
    };

    it('preserves stable and dev provenance independently', async () => {
      const homeDir = createScratchDirectory('provenance-preservation');
      const provenancePath = await writeBuildProvenance(stableRecord, { homeDir });
      const secondPath = await writeBuildProvenance(devRecord, { homeDir });

      expect(secondPath).toBe(provenancePath);
      expect(JSON.parse(readFileSync(provenancePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          stable: stableRecord,
          dev: devRecord,
        },
      });
    });

    it('rejects malformed provenance files without changing them', async () => {
      const homeDir = createScratchDirectory('provenance-invalid-file');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(provenancePath, '{"version":2,"channels":{}}', 'utf8');
      const before = readFileSync(provenancePath, 'utf8');

      await expect(writeBuildProvenance(devRecord, { homeDir })).rejects.toThrow(
        /Invalid build provenance file/,
      );
      expect(readFileSync(provenancePath, 'utf8')).toBe(before);
    });

    it('cleans up atomic temp files when writing the provenance file fails', async () => {
      const homeDir = createScratchDirectory('provenance-write-failure');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');

      await expect(
        writeBuildProvenance(stableRecord, {
          homeDir,
          randomUUID: () => 'write-failure',
          writeFileText: async () => {
            throw new Error('write failed');
          },
        }),
      ).rejects.toThrow(/write failed/);

      expect(readdirSync(stateDir)).toEqual([]);
    });

    it('cleans up atomic temp files when renaming the provenance file fails', async () => {
      const homeDir = createScratchDirectory('provenance-rename-failure');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(provenancePath, JSON.stringify({ version: 1, channels: { stable: stableRecord } }), 'utf8');

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          randomUUID: () => 'rename-failure',
          renamePath: async () => {
            throw new Error('rename failed');
          },
        }),
      ).rejects.toThrow(/rename failed/);

      expect(JSON.parse(readFileSync(provenancePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          stable: stableRecord,
        },
      });
      expect(readdirSync(stateDir)).toEqual(['builds.json']);
    });
  });

  describe('CLI entrypoint', () => {
    it('prints repositoryRoot and parsed options as JSON', () => {
      const result = spawnSync('node', [scriptPath, 'stable', '--', 'origin/main'], {
        cwd: tauriDirectory,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        repositoryRoot,
        options: {
          channel: 'stable',
          ref: 'origin/main',
        },
      });
    });

    it('writes parser errors to stderr and exits with code 1', () => {
      const result = spawnSync('node', [scriptPath, 'dev', 'main'], {
        cwd: tauriDirectory,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('dev builds do not accept a Git ref');
    });
  });
});
