import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCommandsFor,
  channelConfig,
  createDevTauriConfig,
  parseBuildArguments,
} from '../scripts/build-macos-app.mjs';

const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, 'scripts/build-macos-app.mjs');
const tauriRelativeCwd = 'native/macos/psyche-build-tauri';
const tauriDirectory = join(repositoryRoot, tauriRelativeCwd);
const manifestPath = 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml';
const devConfigPath = resolve(repositoryRoot, 'native/macos/psyche-build-tauri/dev.tauri.generated.json');

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
