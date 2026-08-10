import { EventEmitter } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
  readBundleIdentity,
  resolveCommit,
  runCli,
  runCommand,
  runMacosBuild,
  smokeLaunchBundle,
  sourceIsDirty,
  writeDevTauriConfig,
  writeBuildProvenance,
} from '../scripts/build-macos-app.mjs';
import type {
  BuildProvenance,
  BundleIdentity,
  CommandOptions,
  CommandResult,
  InstallOverrides,
  Runner,
  RunMacosBuildDependencies,
  SmokeLaunchOverrides,
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

function writeLockOwner(lockPath: string, token: string, pid: number): void {
  writeFileSync(
    join(lockPath, 'owner.json'),
    `${JSON.stringify({ token, pid })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function runGit(repository: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed with status ${String(result.status)}\n${result.stderr}`,
    );
  }

  return result.stdout;
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

  describe('command and source helpers', () => {
    it('runs commands with argument arrays and captures string output', async () => {
      const result = await runCommand(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1]); process.stderr.write("stderr")',
        'release candidate with spaces',
      ]);

      expect(result).toEqual({
        stdout: 'release candidate with spaces',
        stderr: 'stderr',
      });
    });

    it('reports stage, cwd, command failure details, and preserves the cause', async () => {
      const command = process.execPath;
      const failure = await runCommand(command, [
        '-e',
        'process.stdout.write("partial"); process.stderr.write("broken"); process.exit(7)',
      ], {
        cwd: repositoryRoot,
        stage: 'validate generated application',
      }).then(
        () => undefined,
        (error) =>
          error as Error & {
            command?: string;
            cwd?: string;
            stage?: string;
            exitCode?: number;
            stdout?: string;
            stderr?: string;
          },
      );

      expect(failure).toBeDefined();
      expect(failure?.message).toContain('validate generated application');
      expect(failure?.message).toContain(repositoryRoot);
      expect(failure?.message).toContain(command);
      expect(failure?.message).toContain('exit code 7');
      expect(failure?.message).toContain('partial');
      expect(failure?.message).toContain('broken');
      expect(failure?.message).toContain('cause:');
      expect(failure?.command).toBe(command);
      expect(failure?.cwd).toBe(repositoryRoot);
      expect(failure?.stage).toBe('validate generated application');
      expect(failure?.exitCode).toBe(7);
      expect(failure?.stdout).toBe('partial');
      expect(failure?.stderr).toBe('broken');
      expect(failure?.cause).toBeInstanceOf(Error);
    });

    it('reports spawn codes and messages when the executable does not exist', async () => {
      const missingCommand = join(
        createScratchDirectory('missing-command'),
        'does-not-exist',
      );
      const failure = await runCommand(missingCommand, [], {
        cwd: repositoryRoot,
        stage: 'resolve external tool',
      }).then(
        () => undefined,
        (error) =>
          error as Error & {
            code?: string;
            stage?: string;
          },
      );

      expect(failure).toBeDefined();
      expect(failure?.message).toContain('resolve external tool');
      expect(failure?.message).toContain(`spawn code ENOENT`);
      expect(failure?.message).toMatch(/ENOENT|no such file/i);
      expect(failure?.message).toContain('cause:');
      expect(failure?.code).toBe('ENOENT');
      expect(failure?.stage).toBe('resolve external tool');
      expect(failure?.cause).toBeInstanceOf(Error);
    });

    it('reports the terminating signal when a command is killed', async () => {
      const failure = await runCommand(
        process.execPath,
        ['-e', 'process.kill(process.pid, "SIGTERM")'],
        {
          cwd: repositoryRoot,
          stage: 'exercise signal reporting',
        },
      ).then(
        () => undefined,
        (error) =>
          error as Error & {
            signal?: NodeJS.Signals;
            stdout?: string;
            stderr?: string;
          },
      );

      expect(failure).toBeDefined();
      expect(failure?.message).toContain('exercise signal reporting');
      expect(failure?.message).toContain('signal SIGTERM');
      expect(failure?.message).toContain('stdout:\n');
      expect(failure?.message).toContain('stderr:\n');
      expect(failure?.signal).toBe('SIGTERM');
      expect(failure?.stdout).toBe('');
      expect(failure?.stderr).toBe('');
      expect(failure?.cause).toBeInstanceOf(Error);
    });

    it('resolves a ref containing spaces as one git argument', async () => {
      const sha = 'a'.repeat(40);
      const execute = vi.fn(
        async (_command: string, _args: readonly string[]): Promise<CommandResult> => ({
          stdout: `${sha}\n`,
          stderr: '',
        }),
      );

      await expect(
        resolveCommit('/repo with spaces', 'release candidate', execute),
      ).resolves.toBe(sha);
      expect(execute).toHaveBeenCalledWith(
        'git',
        [
          '-c',
          'core.warnAmbiguousRefs=true',
          'rev-parse',
          '--verify',
          '--end-of-options',
          'release candidate^{commit}',
        ],
        {
          cwd: '/repo with spaces',
          stage: 'resolve Git ref "release candidate"',
        },
      );
    });

    it('keeps option-like refs after rev-parse end-of-options', async () => {
      const sha = 'a'.repeat(40);
      const execute = vi.fn(
        async (_command: string, _args: readonly string[]): Promise<CommandResult> => ({
          stdout: `${sha}\n`,
          stderr: '',
        }),
      );

      await expect(resolveCommit('/repo', '--help', execute)).resolves.toBe(sha);
      expect(execute).toHaveBeenCalledWith(
        'git',
        [
          '-c',
          'core.warnAmbiguousRefs=true',
          'rev-parse',
          '--verify',
          '--end-of-options',
          '--help^{commit}',
        ],
        {
          cwd: '/repo',
          stage: 'resolve Git ref "--help"',
        },
      );
    });

    it('rejects any successful ref resolution that emits stderr', async () => {
      const sha = 'a'.repeat(40);
      const execute = vi.fn(
        async (_command: string, _args: readonly string[]): Promise<CommandResult> => ({
          stdout: `${sha}\n`,
          stderr: 'avertissement sans texte anglais attendu\n',
        }),
      );

      await expect(resolveCommit('/repo', 'shared-name', execute)).rejects.toThrow(
        /shared-name.*stderr|stderr.*shared-name/i,
      );
    });

    it('rejects an ambiguous ref in a real repository despite disabled repo warnings', async () => {
      const gitRepository = createScratchDirectory('ambiguous-git-ref');
      runGit(gitRepository, ['init', '--quiet']);
      runGit(gitRepository, ['config', 'user.name', 'Psyche Build Tests']);
      runGit(gitRepository, ['config', 'user.email', 'tests@example.invalid']);
      runGit(gitRepository, ['config', 'core.warnAmbiguousRefs', 'false']);
      writeFileSync(join(gitRepository, 'tracked.txt'), 'tracked\n', 'utf8');
      runGit(gitRepository, ['add', 'tracked.txt']);
      runGit(gitRepository, ['commit', '--quiet', '-m', 'initial']);
      runGit(gitRepository, ['branch', 'shared-name']);
      runGit(gitRepository, ['tag', 'shared-name']);

      await expect(resolveCommit(gitRepository, 'shared-name')).rejects.toThrow(
        /shared-name.*stderr|stderr.*shared-name/i,
      );
    });

    it('rejects git output that is not a full lowercase commit SHA', async () => {
      const execute = vi.fn(
        async (_command: string, _args: readonly string[]): Promise<CommandResult> => ({
          stdout: 'abc123\n',
          stderr: '',
        }),
      );

      await expect(resolveCommit('/repo', 'main', execute)).rejects.toThrow(
        /full lowercase 40-character commit SHA/i,
      );
    });

    it.each([
      { output: '', expected: false },
      { output: ' M scripts/build-macos-app.mjs\n', expected: true },
    ])('reports dirty=$expected from porcelain output', async ({ output, expected }) => {
      const execute = vi.fn(
        async (_command: string, _args: readonly string[]): Promise<CommandResult> => ({
          stdout: output,
          stderr: '',
        }),
      );

      await expect(sourceIsDirty('/repo', execute)).resolves.toBe(expected);
      expect(execute).toHaveBeenCalledWith('git', ['status', '--porcelain'], {
        cwd: '/repo',
        stage: 'inspect source status',
      });
    });

    it('reads all required bundle identity values with plutil argument arrays', async () => {
      const values: Record<string, string> = {
        CFBundleName: 'Psyche Build',
        CFBundleIdentifier: 'dev.opencoven.psyche',
        CFBundleExecutable: 'psyche-build',
      };
      const execute = vi.fn(
        async (_command: string, args: readonly string[]): Promise<CommandResult> => ({
          stdout: `${values[args[1] ?? '']}\n`,
          stderr: '',
        }),
      );
      const appPath = '/Applications/Psyche Build.app';
      const infoPath = join(appPath, 'Contents', 'Info.plist');

      await expect(readBundleIdentity(appPath, execute)).resolves.toEqual({
        name: 'Psyche Build',
        identifier: 'dev.opencoven.psyche',
        executable: 'psyche-build',
      });
      expect(execute.mock.calls).toEqual([
        [
          'plutil',
          ['-extract', 'CFBundleName', 'raw', '-o', '-', infoPath],
          { stage: 'read plist key CFBundleName' },
        ],
        [
          'plutil',
          ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPath],
          { stage: 'read plist key CFBundleIdentifier' },
        ],
        [
          'plutil',
          ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', infoPath],
          { stage: 'read plist key CFBundleExecutable' },
        ],
      ]);
    });
  });

  describe('writeDevTauriConfig', () => {
    it('atomically writes a complete private config under the temporary parent', async () => {
      const tempRoot = createScratchDirectory('dev-tauri-config');
      const configPath = await writeDevTauriConfig(repositoryRoot, tempRoot);

      expect(resolve(configPath)).toBe(configPath);
      expect(configPath.startsWith(`${tempRoot}/`)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(
        createDevTauriConfig(macosTauriConfig),
      );
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(readdirSync(tempRoot)).toEqual([configPath.split('/').at(-1)]);
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
            CFFIXED_USER_HOME: '/virtual/home',
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

    it('removes the invalid first install when final validation fails after the staging rename', async () => {
      const homeDir = createScratchDirectory('install-first-final-validation-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const finalPath = join(applicationsDir, 'Psyche Build.app');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-first-final-validation-failure'),
        'Psyche Build.app',
        'replacement',
      );

      await expect(
        installBundleTransactional(candidatePath, channelConfig('stable'), {
          homeDir,
          copyBundle,
          randomUUID: () => 'first-validation-failure',
          validateInstalledBundle: async (appPath: string) => {
            if (appPath === finalPath) {
              throw new Error('final validation failed');
            }
          },
        }),
      ).rejects.toThrow(/final validation failed/);

      expect(readdirSync(applicationsDir)).toEqual([]);
    });

    it('fails with an explicit error when the validator callback is missing', async () => {
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-missing-validator'),
        'Psyche Build Dev.app',
        'replacement',
      );
      const installWithoutValidator = installBundleTransactional as unknown as (
        candidate: string,
        requestedChannelConfig: ReturnType<typeof channelConfig>,
        overrides?: unknown,
      ) => Promise<string>;

      await expect(installWithoutValidator(candidatePath, channelConfig('dev'))).rejects.toThrow(
        'installBundleTransactional requires a validateInstalledBundle callback',
      );
      await expect(
        installWithoutValidator(candidatePath, channelConfig('dev'), {}),
      ).rejects.toThrow('installBundleTransactional requires a validateInstalledBundle callback');
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

    it('preserves the main failure when staging cleanup also fails', async () => {
      const homeDir = createScratchDirectory('install-main-and-cleanup-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const finalPath = createAppBundle(applicationsDir, 'Psyche Build.app', 'known-good');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-main-and-cleanup-failure'),
        'Psyche Build.app',
        'replacement',
      );
      const stagingRoot = join(
        applicationsDir,
        '.install-Psyche Build.app.cleanup-failure.staging',
      );
      const cleanupError = new Error(`staging cleanup failed for ${stagingRoot}`);

      const installError = await installBundleTransactional(candidatePath, channelConfig('stable'), {
        homeDir,
        copyBundle,
        randomUUID: () => 'cleanup-failure',
        validateInstalledBundle: async (appPath: string) => {
          if (appPath === finalPath) {
            throw new Error('final validation failed');
          }
        },
        removePath: async (targetPath: string) => {
          if (targetPath === stagingRoot) {
            throw cleanupError;
          }
          rmSync(targetPath, { recursive: true, force: true });
        },
      }).then(
        () => undefined,
        (error) => error as Error & { cause?: unknown; errors?: unknown[] },
      );

      expect(installError).toBeDefined();
      expect(installError?.message).toMatch(/^final validation failed/);
      expect(installError?.message).toMatch(/staging cleanup failed/i);
      expect(readAppMarker(finalPath)).toBe('known-good');

      if (!installError) {
        throw new Error('expected install to fail');
      }

      if (installError instanceof AggregateError) {
        expect(installError.errors).toHaveLength(2);
        expect((installError.errors[0] as Error).message).toBe('final validation failed');
        expect((installError.errors[1] as Error).message).toBe(cleanupError.message);
      }

      if (installError.cause instanceof Error) {
        expect(installError.cause.message).toBe('final validation failed');
      }
    });

    it('fails the install when staging cleanup fails after a successful install', async () => {
      const homeDir = createScratchDirectory('install-success-and-cleanup-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const candidatePath = createAppBundle(
        createScratchDirectory('candidate-success-and-cleanup-failure'),
        'Psyche Build Dev.app',
        'replacement',
      );
      const finalPath = join(applicationsDir, 'Psyche Build Dev.app');
      const stagingRoot = join(
        applicationsDir,
        '.install-Psyche Build Dev.app.cleanup-after-success.staging',
      );

      await expect(
        installBundleTransactional(candidatePath, channelConfig('dev'), {
          homeDir,
          copyBundle,
          randomUUID: () => 'cleanup-after-success',
          validateInstalledBundle: async () => {},
          removePath: async (targetPath: string) => {
            if (targetPath === stagingRoot) {
              throw new Error(`staging cleanup failed for ${stagingRoot}`);
            }
            rmSync(targetPath, { recursive: true, force: true });
          },
        }),
      ).rejects.toThrow(/staging cleanup failed/i);

      expect(readAppMarker(finalPath)).toBe('replacement');
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
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requestedRef: 'origin/release/v1.2.3',
      dirty: false,
      builtAt: '2026-08-10T10:00:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build.app',
      productName: 'Psyche Build',
      bundleIdentifier: 'dev.opencoven.psyche',
    };
    const devRecord = {
      channel: 'dev' as const,
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      dirty: true,
      builtAt: '2026-08-10T11:00:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build Dev.app',
      productName: 'Psyche Build Dev',
      bundleIdentifier: 'dev.opencoven.psyche.dev',
    };

    it.each([
      {
        name: 'unknown channel',
        record: { ...devRecord, channel: 'preview' },
        errorPattern: /channel must be "stable" or "dev"/i,
      },
      {
        name: 'stable record without requestedRef',
        record: (({ requestedRef: _requestedRef, ...record }) => record)(stableRecord),
        errorPattern: /stable.*requestedRef.*nonblank/i,
      },
      {
        name: 'stable record with blank requestedRef',
        record: { ...stableRecord, requestedRef: '   ' },
        errorPattern: /stable.*requestedRef.*nonblank/i,
      },
      {
        name: 'dev record with requestedRef',
        record: { ...devRecord, requestedRef: 'HEAD' },
        errorPattern: /dev.*requestedRef.*forbidden/i,
      },
      {
        name: 'stable record with an unknown field',
        record: { ...stableRecord, futureField: true },
        errorPattern: /stable.*unknown field "futureField"/i,
      },
      {
        name: 'dev record with an unknown field',
        record: { ...devRecord, futureField: true },
        errorPattern: /dev.*unknown field "futureField"/i,
      },
      {
        name: 'uppercase commit SHA',
        record: { ...devRecord, commitSha: 'B'.repeat(40) },
        errorPattern: /lowercase hexadecimal commitSha/i,
      },
      {
        name: 'non-boolean dirty state',
        record: { ...devRecord, dirty: 'yes' },
        errorPattern: /boolean dirty/i,
      },
      {
        name: 'non-canonical build timestamp',
        record: { ...devRecord, builtAt: '2026-08-10T11:00:00Z' },
        errorPattern: /exact ISO timestamp/i,
      },
      {
        name: 'relative installed path',
        record: { ...devRecord, installedPath: 'Applications/Psyche Build Dev.app' },
        errorPattern: /absolute installedPath/i,
      },
      {
        name: 'wrong installed app name',
        record: { ...devRecord, installedPath: '/Users/test/Applications/Psyche Build.app' },
        errorPattern: /installedPath.*Psyche Build Dev\.app/i,
      },
      {
        name: 'wrong product name',
        record: { ...devRecord, productName: 'Psyche Build' },
        errorPattern: /productName="Psyche Build Dev"/i,
      },
      {
        name: 'wrong bundle identifier',
        record: { ...devRecord, bundleIdentifier: 'dev.opencoven.psyche' },
        errorPattern: /bundleIdentifier="dev\.opencoven\.psyche\.dev"/i,
      },
    ])('rejects an incoming $name before creating state', async ({ record, errorPattern }) => {
      const homeDir = createScratchDirectory('provenance-invalid-incoming');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');

      await expect(
        writeBuildProvenance(record as unknown as BuildProvenance, { homeDir }),
      ).rejects.toThrow(errorPattern);
      expect(existsSync(stateDir)).toBe(false);
    });

    it('rejects an unknown incoming field without changing existing state', async () => {
      const homeDir = createScratchDirectory('provenance-invalid-incoming-unchanged');
      const provenancePath = await writeBuildProvenance(stableRecord, { homeDir });
      const before = readFileSync(provenancePath, 'utf8');

      await expect(
        writeBuildProvenance(
          { ...devRecord, futureField: 'unsupported' } as unknown as BuildProvenance,
          { homeDir },
        ),
      ).rejects.toThrow(/dev.*unknown field "futureField"/i);
      expect(readFileSync(provenancePath, 'utf8')).toBe(before);
    });

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

    it('records a unique owner token and current PID while each lock is held', async () => {
      const homeDir = createScratchDirectory('provenance-lock-owner');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const lockPath = join(stateDir, 'builds.json.lock');
      const owners: unknown[] = [];

      for (const [record, token] of [
        [stableRecord, 'stable-owner-token'],
        [devRecord, 'dev-owner-token'],
      ] as const) {
        await writeBuildProvenance(record, {
          homeDir,
          randomUUID: () => token,
          writeFileText: async (filePath: string, content: string) => {
            writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
            if (!filePath.startsWith(`${lockPath}/`)) {
              owners.push(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')));
            }
          },
        });
      }

      expect(owners).toEqual([
        { token: 'stable-owner-token', pid: process.pid },
        { token: 'dev-owner-token', pid: process.pid },
      ]);
      expect(existsSync(lockPath)).toBe(false);
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

    it('rejects unknown top-level provenance fields without changing the file', async () => {
      const homeDir = createScratchDirectory('provenance-unknown-top-level');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        provenancePath,
        `${JSON.stringify({
          version: 1,
          channels: { stable: stableRecord },
          futureField: true,
        }, null, 2)}\n`,
        'utf8',
      );
      const before = readFileSync(provenancePath, 'utf8');

      await expect(writeBuildProvenance(devRecord, { homeDir })).rejects.toThrow(
        /unknown top-level field "futureField"/i,
      );
      expect(readFileSync(provenancePath, 'utf8')).toBe(before);
    });

    it.each([
      {
        name: 'null stable record',
        state: { version: 1, channels: { stable: null } },
        errorPattern: /Invalid build provenance file .* channel "stable" must be an object/i,
      },
      {
        name: 'mismatched dev channel record',
        state: {
          version: 1,
          channels: {
            stable: stableRecord,
            dev: {
              ...devRecord,
              channel: 'stable',
            },
          },
        },
        errorPattern:
          /Invalid build provenance file .* channel "dev" record must contain channel="dev"/i,
      },
      {
        name: 'malformed dev record',
        state: {
          version: 1,
          channels: {
            stable: stableRecord,
            dev: {
              ...devRecord,
              commitSha: 'SHORTSHA',
              requestedRef: 42,
            },
          },
        },
        errorPattern:
          /Invalid build provenance file .* channel "dev" record must contain a 40-character lowercase hexadecimal commitSha/i,
      },
      {
        name: 'stable record without requestedRef',
        state: {
          version: 1,
          channels: {
            stable: (({ requestedRef: _requestedRef, ...record }) => record)(stableRecord),
          },
        },
        errorPattern: /Invalid build provenance file .*stable.*requestedRef.*nonblank/i,
      },
      {
        name: 'dev record with requestedRef',
        state: {
          version: 1,
          channels: {
            dev: {
              ...devRecord,
              requestedRef: 'HEAD',
            },
          },
        },
        errorPattern: /Invalid build provenance file .*dev.*requestedRef.*forbidden/i,
      },
      {
        name: 'stable record with an unknown field',
        state: {
          version: 1,
          channels: {
            stable: {
              ...stableRecord,
              futureField: true,
            },
          },
        },
        errorPattern: /Invalid build provenance file .*stable.*unknown field "futureField"/i,
      },
      {
        name: 'dev record with an unknown field',
        state: {
          version: 1,
          channels: {
            dev: {
              ...devRecord,
              futureField: true,
            },
          },
        },
        errorPattern: /Invalid build provenance file .*dev.*unknown field "futureField"/i,
      },
      {
        name: 'non-canonical timestamp',
        state: {
          version: 1,
          channels: {
            dev: {
              ...devRecord,
              builtAt: '2026-08-10T11:00:00Z',
            },
          },
        },
        errorPattern: /Invalid build provenance file .* exact ISO timestamp/i,
      },
      {
        name: 'relative installed path',
        state: {
          version: 1,
          channels: {
            dev: {
              ...devRecord,
              installedPath: 'Applications/Psyche Build Dev.app',
            },
          },
        },
        errorPattern: /Invalid build provenance file .* absolute installedPath/i,
      },
      {
        name: 'wrong stable identity',
        state: {
          version: 1,
          channels: {
            stable: {
              ...stableRecord,
              productName: 'Psyche Build Dev',
            },
          },
        },
        errorPattern: /Invalid build provenance file .* productName="Psyche Build"/i,
      },
      {
        name: 'unknown channel key',
        state: {
          version: 1,
          channels: {
            stable: stableRecord,
            preview: {
              ...devRecord,
              channel: 'dev',
            },
          },
        },
        errorPattern: /Invalid build provenance file .* unknown channel "preview"/i,
      },
    ])('rejects $name without changing the file', async ({ state, errorPattern }) => {
      const homeDir = createScratchDirectory('provenance-channel-validation');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(provenancePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      const before = readFileSync(provenancePath, 'utf8');

      await expect(writeBuildProvenance(devRecord, { homeDir })).rejects.toThrow(errorPattern);
      expect(readFileSync(provenancePath, 'utf8')).toBe(before);
    });

    it('serializes concurrent stable and dev updates so neither record is lost', async () => {
      const homeDir = createScratchDirectory('provenance-concurrent');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      let releaseFirstWrite = () => {};
      let markFirstWriting = () => {};
      const firstWriteGate = new Promise<void>((resolveGate) => {
        releaseFirstWrite = resolveGate;
      });
      const firstWriting = new Promise<void>((resolveWriting) => {
        markFirstWriting = resolveWriting;
      });

      const stableWrite = writeBuildProvenance(stableRecord, {
        homeDir,
        lockRetryMs: 1,
        writeFileText: async (filePath: string, content: string) => {
          if (filePath.startsWith(`${lockPath}/`)) {
            writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
            return;
          }
          markFirstWriting();
          await firstWriteGate;
          writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
        },
      });
      await firstWriting;

      const devWrite = writeBuildProvenance(devRecord, {
        homeDir,
        lockRetryMs: 1,
      });
      await tick();
      releaseFirstWrite();
      await Promise.all([stableWrite, devWrite]);

      expect(JSON.parse(readFileSync(provenancePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          stable: stableRecord,
          dev: devRecord,
        },
      });
      expect(existsSync(lockPath)).toBe(false);
    });

    it('times out while a fresh provenance lock is held by another process', async () => {
      const homeDir = createScratchDirectory('provenance-lock-timeout');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      mkdirSync(lockPath, { recursive: true });

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          lockTimeoutMs: 0,
          staleLockMs: 60_000,
        }),
      ).rejects.toThrow(/Timed out.*provenance lock/i);
      expect(existsSync(provenancePath)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('bounds lock retries even when the injected clock does not advance', async () => {
      const homeDir = createScratchDirectory('provenance-static-clock-timeout');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const lockPath = join(stateDir, 'builds.json.lock');
      const sleep = vi.fn(async () => {});
      mkdirSync(lockPath, { recursive: true });

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          nowMs: () => 1_000,
          sleep,
          lockTimeoutMs: 3,
          lockRetryMs: 1,
          staleLockMs: 60_000,
        }),
      ).rejects.toThrow(/Timed out after 3ms.*provenance lock/i);
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('times out without removing an old lock whose owner process is alive', async () => {
      const homeDir = createScratchDirectory('provenance-live-old-lock');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeLockOwner(lockPath, 'live-owner', 4242);
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTime, staleTime);
      const isProcessAlive = vi.fn(async (pid: number) => {
        expect(pid).toBe(4242);
        return true;
      });
      const removePath = vi.fn(async (targetPath: string) => {
        rmSync(targetPath, { recursive: true, force: true });
      });

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          lockTimeoutMs: 0,
          staleLockMs: 10,
          isProcessAlive,
          removePath,
        }),
      ).rejects.toThrow(/Timed out.*provenance lock/i);
      expect(isProcessAlive).toHaveBeenCalledTimes(1);
      expect(removePath).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))).toEqual({
        token: 'live-owner',
        pid: 4242,
      });
      expect(existsSync(provenancePath)).toBe(false);
    });

    it('recovers an old lock whose owner process is dead', async () => {
      const homeDir = createScratchDirectory('provenance-dead-stale-lock');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeLockOwner(lockPath, 'dead-owner', 4242);
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTime, staleTime);
      const isProcessAlive = vi.fn(async (pid: number) => {
        expect(pid).toBe(4242);
        return false;
      });

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          lockRetryMs: 1,
          lockTimeoutMs: 50,
          staleLockMs: 10,
          isProcessAlive,
        }),
      ).resolves.toBe(provenancePath);
      expect(isProcessAlive).toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(false);
      expect(JSON.parse(readFileSync(provenancePath, 'utf8')).channels.dev).toEqual(devRecord);
      expect(readdirSync(stateDir)).toEqual(['builds.json']);
    });

    it('recovers an old lock with a malformed owner record', async () => {
      const homeDir = createScratchDirectory('provenance-malformed-stale-lock');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, 'owner.json'), '{"token":', 'utf8');
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTime, staleTime);
      const isProcessAlive = vi.fn(async () => true);

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          lockRetryMs: 1,
          lockTimeoutMs: 50,
          staleLockMs: 10,
          isProcessAlive,
        }),
      ).resolves.toBe(provenancePath);
      expect(isProcessAlive).not.toHaveBeenCalled();
      expect(existsSync(lockPath)).toBe(false);
      expect(JSON.parse(readFileSync(provenancePath, 'utf8')).channels.dev).toEqual(devRecord);
    });

    it('lets only one concurrent contender quarantine a dead stale lock and retains both records', async () => {
      const homeDir = createScratchDirectory('provenance-concurrent-stale-lock');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeLockOwner(lockPath, 'dead-owner', 4242);
      const staleTime = new Date(Date.now() - 60_000);
      utimesSync(lockPath, staleTime, staleTime);

      let livenessChecks = 0;
      let releaseLivenessChecks = () => {};
      const bothCheckingLiveness = new Promise<void>((resolveChecks) => {
        releaseLivenessChecks = resolveChecks;
      });
      const isProcessAlive = vi.fn(async (pid: number) => {
        if (pid === process.pid) {
          return true;
        }
        livenessChecks += 1;
        if (livenessChecks === 2) {
          releaseLivenessChecks();
        }
        await bothCheckingLiveness;
        return false;
      });
      let successfulQuarantines = 0;
      const renamePath = async (sourcePath: string, destinationPath: string) => {
        await renameAsync(sourcePath, destinationPath);
        if (sourcePath === lockPath && destinationPath.includes('.stale-')) {
          successfulQuarantines += 1;
        }
      };

      await Promise.all([
        writeBuildProvenance(stableRecord, {
          homeDir,
          randomUUID: () => 'stable-contender',
          lockRetryMs: 1,
          lockTimeoutMs: 500,
          staleLockMs: 10,
          isProcessAlive,
          renamePath,
        }),
        writeBuildProvenance(devRecord, {
          homeDir,
          randomUUID: () => 'dev-contender',
          lockRetryMs: 1,
          lockTimeoutMs: 500,
          staleLockMs: 10,
          isProcessAlive,
          renamePath,
        }),
      ]);

      expect(successfulQuarantines).toBe(1);
      expect(JSON.parse(readFileSync(provenancePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          stable: stableRecord,
          dev: devRecord,
        },
      });
      expect(readdirSync(stateDir)).toEqual(['builds.json']);
    });

    it('cleans up atomic temp files when writing the provenance file fails', async () => {
      const homeDir = createScratchDirectory('provenance-write-failure');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');

      await expect(
        writeBuildProvenance(stableRecord, {
          homeDir,
          randomUUID: () => 'write-failure',
          writeFileText: async (filePath: string, content: string) => {
            if (filePath.startsWith(`${join(stateDir, 'builds.json.lock')}/`)) {
              writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
              return;
            }
            throw new Error('write failed');
          },
        }),
      ).rejects.toThrow(/write failed/);

      expect(readdirSync(stateDir)).toEqual([]);
      expect(existsSync(join(stateDir, 'builds.json.lock'))).toBe(false);
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
          renamePath: async (sourcePath: string, destinationPath: string) => {
            if (destinationPath === provenancePath) {
              throw new Error('rename failed');
            }
            await renameAsync(sourcePath, destinationPath);
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

    it('preserves a replacement lock when ownership changes before release', async () => {
      const homeDir = createScratchDirectory('provenance-release-owner-mismatch');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;
      const ownerPath = join(lockPath, 'owner.json');

      const error = await writeBuildProvenance(devRecord, {
        homeDir,
        randomUUID: () => 'original-owner',
        writeFileText: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
          if (!filePath.startsWith(`${lockPath}/`)) {
            writeLockOwner(lockPath, 'replacement-owner', 9999);
          }
        },
      }).then(
        () => undefined,
        (failure) => failure as Error,
      );

      expect(error?.message).toMatch(/release.*ownership|ownership.*release/i);
      expect(JSON.parse(readFileSync(ownerPath, 'utf8'))).toEqual({
        token: 'replacement-owner',
        pid: 9999,
      });
      expect(existsSync(lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(provenancePath, 'utf8')).channels.dev).toEqual(devRecord);
    });

    it('reports lock release failures after an otherwise successful write', async () => {
      const homeDir = createScratchDirectory('provenance-release-failure');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const provenancePath = join(stateDir, 'builds.json');
      const lockPath = `${provenancePath}.lock`;

      const error = await writeBuildProvenance(devRecord, {
        homeDir,
        removePath: async (targetPath) => {
          if (targetPath === lockPath) {
            throw new Error('release failed');
          }
          rmSync(targetPath, { recursive: true, force: true });
        },
      }).then(
        () => undefined,
        (failure) => failure as Error,
      );

      expect(error?.message).toContain('Failed to release build provenance lock');
      expect(error?.message).toContain('release failed');
      expect(error?.cause).toBeInstanceOf(Error);
      expect(JSON.parse(readFileSync(provenancePath, 'utf8')).channels.dev).toEqual(devRecord);
      expect(existsSync(lockPath)).toBe(true);
    });

    it('preserves write and lock release failures together', async () => {
      const homeDir = createScratchDirectory('provenance-write-release-failure');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const lockPath = join(stateDir, 'builds.json.lock');

      const error = await writeBuildProvenance(devRecord, {
        homeDir,
        writeFileText: async (filePath: string, content: string) => {
          if (filePath.startsWith(`${lockPath}/`)) {
            writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
            return;
          }
          throw new Error('write failed');
        },
        removePath: async (targetPath) => {
          if (targetPath === lockPath) {
            throw new Error('release failed');
          }
          rmSync(targetPath, { recursive: true, force: true });
        },
      }).then(
        () => undefined,
        (failure) => failure as Error,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(error?.message).toContain('write failed');
      expect(error?.message).toContain('Failed to release build provenance lock');
      expect(error?.message).toContain('release failed');
      expect((error as AggregateError).errors).toHaveLength(2);
      expect(existsSync(lockPath)).toBe(true);
    });
  });

  describe('runMacosBuild', () => {
    const stableSha = 'a'.repeat(40);
    const devSha = 'b'.repeat(40);
    const builtAt = '2026-08-10T18:00:00.000Z';
    const virtualRepository = '/workspace/psyche-build';
    const virtualHome = '/Users/test';
    const stableIdentity: BundleIdentity = {
      name: 'Psyche Build',
      identifier: 'dev.opencoven.psyche',
      executable: 'psyche-build',
    };
    const devIdentity: BundleIdentity = {
      name: 'Psyche Build Dev',
      identifier: 'dev.opencoven.psyche.dev',
      executable: 'psyche-build-dev',
    };

    it('runs the exact stable workflow in an isolated source child and records provenance', async () => {
      const tempRoot = '/workspace/.build-temp/stable-1';
      const sourceRoot = join(tempRoot, 'source');
      const bundleDir = join(
        sourceRoot,
        'native/macos/psyche-build-tauri/src-tauri/target/release/bundle/macos',
      );
      const candidate = join(bundleDir, 'Psyche Build.app');
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build.app');
      const events: string[] = [];
      const execute = vi.fn(
        async (
          command: string,
          args: readonly string[],
          _options: CommandOptions = {},
        ): Promise<CommandResult> => {
          events.push(`command:${command}:${args.join(' ')}`);
          if (command === 'git' && args.includes('rev-parse')) {
            return { stdout: `${stableSha}\n`, stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      );
      const removePath = vi.fn(async (targetPath: string) => {
        events.push(`remove:${targetPath}`);
      });
      const readIdentity = vi.fn(
        async (_appPath: string, _execute?: Runner): Promise<BundleIdentity> => stableIdentity,
      );
      const smokeLaunch = vi.fn(
        async (_appPath: string, _overrides: SmokeLaunchOverrides): Promise<void> => {},
      );
      const install = vi.fn(
        async (
          installedCandidate: string,
          requestedConfig: ReturnType<typeof channelConfig>,
          overrides: InstallOverrides,
        ) => {
          expect(installedCandidate).toBe(candidate);
          expect(requestedConfig).toEqual(channelConfig('stable'));
          await Promise.resolve(
            overrides.validateInstalledBundle('/staging/Psyche Build.app', requestedConfig),
          );
          await Promise.resolve(overrides.validateInstalledBundle(installedPath, requestedConfig));
          return installedPath;
        },
      );
      const writeProvenance = vi.fn(async (_record: BuildProvenance) => '/state/builds.json');
      const dependencies = {
        execute,
        makeTemporaryDirectory: vi.fn(async () => tempRoot),
        removePath,
        findCandidateApp: vi.fn(async () => candidate),
        readBundleIdentity: readIdentity,
        smokeLaunchBundle: smokeLaunch,
        installBundleTransactional: install,
        writeBuildProvenance: writeProvenance,
        now: () => new Date(builtAt),
        homeDir: virtualHome,
      } satisfies RunMacosBuildDependencies;

      const result = await runMacosBuild(
        {
          channel: 'stable',
          ref: 'release candidate',
          repositoryRoot: virtualRepository,
        },
        dependencies,
      );

      const expectedBuildCalls = buildCommandsFor('stable').map(([command, args, relativeCwd]) => [
        command,
        args,
        {
          cwd: resolve(sourceRoot, relativeCwd),
          stage: `run stable validation/build command: ${command} ${args.join(' ')}`,
        },
      ]);
      expect(execute.mock.calls).toEqual([
        [
          'git',
          [
            '-c',
            'core.warnAmbiguousRefs=true',
            'rev-parse',
            '--verify',
            '--end-of-options',
            'release candidate^{commit}',
          ],
          {
            cwd: virtualRepository,
            stage: 'resolve Git ref "release candidate"',
          },
        ],
        [
          'git',
          ['worktree', 'add', '--detach', sourceRoot, stableSha],
          {
            cwd: virtualRepository,
            stage: 'add stable worktree',
          },
        ],
        ...expectedBuildCalls,
        [
          'git',
          ['worktree', 'remove', '--force', sourceRoot],
          {
            cwd: virtualRepository,
            stage: 'remove stable worktree',
          },
        ],
      ]);
      expect(sourceRoot).not.toBe(tempRoot);
      expect(events.indexOf(`remove:${candidate}`)).toBeLessThan(
        events.indexOf('command:pnpm:install --frozen-lockfile'),
      );
      expect(dependencies.findCandidateApp).toHaveBeenCalledWith(
        bundleDir,
        'Psyche Build.app',
      );
      expect(readIdentity.mock.calls.map(([appPath]) => appPath)).toEqual([
        candidate,
        '/staging/Psyche Build.app',
        installedPath,
      ]);
      expect(smokeLaunch).toHaveBeenCalledWith(candidate, {
        executableName: stableIdentity.executable,
      });
      expect(removePath).toHaveBeenLastCalledWith(tempRoot);
      expect(writeProvenance).toHaveBeenCalledWith(
        {
          channel: 'stable',
          commitSha: stableSha,
          requestedRef: 'release candidate',
          dirty: false,
          builtAt,
          installedPath,
          productName: 'Psyche Build',
          bundleIdentifier: 'dev.opencoven.psyche',
        },
        { homeDir: virtualHome },
      );
      expect(result).toEqual({
        channel: 'stable',
        commitSha: stableSha,
        requestedRef: 'release candidate',
        dirty: false,
        builtAt,
        installedPath,
        productName: 'Psyche Build',
        bundleIdentifier: 'dev.opencoven.psyche',
      });
    });

    it('force-removes only its added stable worktree after failure and does not install', async () => {
      const tempRoot = '/workspace/.build-temp/stable-failure';
      const sourceRoot = join(tempRoot, 'source');
      const install = vi.fn(
        async (
          _candidate: string,
          _config: ReturnType<typeof channelConfig>,
          _overrides: InstallOverrides,
        ): Promise<string> => {
          throw new Error('install should not run');
        },
      );
      const execute = vi.fn(
        async (command: string, args: readonly string[]): Promise<CommandResult> => {
          if (command === 'git' && args.includes('rev-parse')) {
            return { stdout: `${stableSha}\n`, stderr: '' };
          }
          if (command === 'pnpm' && args[0] === 'install') {
            throw new Error('build command failed');
          }
          return { stdout: '', stderr: '' };
        },
      );

      await expect(
        runMacosBuild(
          {
            channel: 'stable',
            ref: 'origin/release',
            repositoryRoot: virtualRepository,
          },
          {
            execute,
            makeTemporaryDirectory: async () => tempRoot,
            removePath: async () => {},
            installBundleTransactional: install,
          },
        ),
      ).rejects.toThrow('build command failed');

      expect(
        execute.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'worktree'),
      ).toEqual([
        [
          'git',
          ['worktree', 'add', '--detach', sourceRoot, stableSha],
          { cwd: virtualRepository, stage: 'add stable worktree' },
        ],
        [
          'git',
          ['worktree', 'remove', '--force', sourceRoot],
          { cwd: virtualRepository, stage: 'remove stable worktree' },
        ],
      ]);
      expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('prune');
      expect(install).not.toHaveBeenCalled();
    });

    it('builds dev from the current checkout with a temporary config and no stable-only gates', async () => {
      const tempRoot = '/workspace/.build-temp/dev-1';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const bundleDir = join(
        virtualRepository,
        'native/macos/psyche-build-tauri/src-tauri/target/release/bundle/macos',
      );
      const candidate = join(bundleDir, 'Psyche Build Dev.app');
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');
      const execute = vi.fn(
        async (command: string, args: readonly string[]): Promise<CommandResult> => {
          if (command === 'git' && args.includes('rev-parse')) {
            return { stdout: `${devSha}\n`, stderr: '' };
          }
          if (command === 'git' && args[0] === 'status') {
            return { stdout: ' M scripts/build-macos-app.mjs\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        },
      );
      const smokeLaunch = vi.fn(
        async (_appPath: string, _overrides: SmokeLaunchOverrides): Promise<void> => {},
      );
      const install = vi.fn(
        async (
          _candidate: string,
          requestedConfig: ReturnType<typeof channelConfig>,
          overrides: InstallOverrides,
        ) => {
          await Promise.resolve(
            overrides.validateInstalledBundle('/staging/Psyche Build Dev.app', requestedConfig),
          );
          await Promise.resolve(overrides.validateInstalledBundle(installedPath, requestedConfig));
          return installedPath;
        },
      );
      const dependencies = {
        execute,
        makeTemporaryDirectory: vi.fn(async () => tempRoot),
        removePath: vi.fn(async () => {}),
        writeDevTauriConfig: vi.fn(async () => configPath),
        findCandidateApp: vi.fn(async () => candidate),
        readBundleIdentity: vi.fn(
          async (_appPath: string, _execute?: Runner): Promise<BundleIdentity> => devIdentity,
        ),
        smokeLaunchBundle: smokeLaunch,
        installBundleTransactional: install,
        writeBuildProvenance: vi.fn(async () => '/state/builds.json'),
        now: () => new Date(builtAt),
        homeDir: virtualHome,
      } satisfies RunMacosBuildDependencies;

      const result = await runMacosBuild(
        { channel: 'dev', repositoryRoot: virtualRepository },
        dependencies,
      );

      expect(dependencies.writeDevTauriConfig).toHaveBeenCalledWith(
        virtualRepository,
        tempRoot,
      );
      expect(execute.mock.calls).toEqual([
        [
          'git',
          [
            '-c',
            'core.warnAmbiguousRefs=true',
            'rev-parse',
            '--verify',
            '--end-of-options',
            'HEAD^{commit}',
          ],
          { cwd: virtualRepository, stage: 'resolve current commit' },
        ],
        [
          'git',
          ['status', '--porcelain'],
          { cwd: virtualRepository, stage: 'inspect source status' },
        ],
        ...buildCommandsFor('dev', { devConfigPath: configPath }).map(
          ([command, args, relativeCwd]) => [
            command,
            args,
            {
              cwd: resolve(virtualRepository, relativeCwd),
              stage: `run dev validation/build command: ${command} ${args.join(' ')}`,
            },
          ],
        ),
      ]);
      expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('worktree');
      expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('test');
      expect(smokeLaunch).not.toHaveBeenCalled();
      expect(dependencies.removePath).toHaveBeenNthCalledWith(1, candidate);
      expect(dependencies.removePath).toHaveBeenLastCalledWith(tempRoot);
      expect(result).toEqual({
        channel: 'dev',
        commitSha: devSha,
        dirty: true,
        builtAt,
        installedPath,
        productName: 'Psyche Build Dev',
        bundleIdentifier: 'dev.opencoven.psyche.dev',
      });
    });

    it('does not install or record provenance when a dev build command fails and cleans the config root', async () => {
      const tempRoot = '/workspace/.build-temp/dev-build-failure';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const candidate = join(
        virtualRepository,
        'native/macos/psyche-build-tauri/src-tauri/target/release/bundle/macos',
        'Psyche Build Dev.app',
      );
      const removePath = vi.fn(async () => {});
      const install = vi.fn(async () => '/should-not-install');
      const writeProvenance = vi.fn(async () => '/should-not-write');

      await expect(
        runMacosBuild(
          { channel: 'dev', repositoryRoot: virtualRepository },
          {
            execute: async (command, args) => {
              if (command === 'git' && args.includes('rev-parse')) {
                return { stdout: `${devSha}\n`, stderr: '' };
              }
              if (command === 'pnpm') {
                throw new Error('dev build failed');
              }
              return { stdout: '', stderr: '' };
            },
            makeTemporaryDirectory: async () => tempRoot,
            removePath,
            writeDevTauriConfig: async () => configPath,
            installBundleTransactional: install,
            writeBuildProvenance: writeProvenance,
          },
        ),
      ).rejects.toThrow('dev build failed');

      expect(install).not.toHaveBeenCalled();
      expect(writeProvenance).not.toHaveBeenCalled();
      expect(removePath).toHaveBeenNthCalledWith(1, candidate);
      expect(removePath).toHaveBeenLastCalledWith(tempRoot);
    });

    it('does not install or record provenance when dev bundle identity fails and cleans the config root', async () => {
      const tempRoot = '/workspace/.build-temp/dev-identity-failure';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const candidate = join(
        virtualRepository,
        'native/macos/psyche-build-tauri/src-tauri/target/release/bundle/macos',
        'Psyche Build Dev.app',
      );
      const removePath = vi.fn(async () => {});
      const install = vi.fn(async () => '/should-not-install');
      const writeProvenance = vi.fn(async () => '/should-not-write');

      await expect(
        runMacosBuild(
          { channel: 'dev', repositoryRoot: virtualRepository },
          {
            execute: async (command, args) => {
              if (command === 'git' && args.includes('rev-parse')) {
                return { stdout: `${devSha}\n`, stderr: '' };
              }
              return { stdout: '', stderr: '' };
            },
            makeTemporaryDirectory: async () => tempRoot,
            removePath,
            writeDevTauriConfig: async () => configPath,
            findCandidateApp: async () => candidate,
            readBundleIdentity: async () => stableIdentity,
            installBundleTransactional: install,
            writeBuildProvenance: writeProvenance,
          },
        ),
      ).rejects.toThrow(/Bundle identity mismatch/);

      expect(install).not.toHaveBeenCalled();
      expect(writeProvenance).not.toHaveBeenCalled();
      expect(removePath).toHaveBeenLastCalledWith(tempRoot);
    });

    it('leaves an installed app in place when provenance writing fails', async () => {
      const tempRoot = '/workspace/.build-temp/dev-provenance-failure';
      const candidate = '/workspace/Psyche Build Dev.app';
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');
      let installed = false;

      await expect(
        runMacosBuild(
          { channel: 'dev', repositoryRoot: virtualRepository },
          {
            execute: async (command, args) => {
              if (command === 'git' && args.includes('rev-parse')) {
                return { stdout: `${devSha}\n`, stderr: '' };
              }
              return { stdout: '', stderr: '' };
            },
            makeTemporaryDirectory: async () => tempRoot,
            removePath: async () => {},
            writeDevTauriConfig: async () => join(tempRoot, 'dev.json'),
            findCandidateApp: async () => candidate,
            readBundleIdentity: async () => devIdentity,
            installBundleTransactional: async () => {
              installed = true;
              return installedPath;
            },
            writeBuildProvenance: async () => {
              throw new Error('provenance write failed');
            },
            homeDir: virtualHome,
          },
        ),
      ).rejects.toThrow('provenance write failed');

      expect(installed).toBe(true);
    });

    it('reports both a primary failure and stable worktree cleanup failure', async () => {
      const tempRoot = '/workspace/.build-temp/stable-double-failure';

      const error = await runMacosBuild(
        {
          channel: 'stable',
          ref: 'origin/release',
          repositoryRoot: virtualRepository,
        },
        {
          execute: async (command, args) => {
            if (command === 'git' && args.includes('rev-parse')) {
              return { stdout: `${stableSha}\n`, stderr: '' };
            }
            if (command === 'pnpm') {
              throw new Error('primary build failure');
            }
            if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
              throw new Error('worktree cleanup failure');
            }
            return { stdout: '', stderr: '' };
          },
          makeTemporaryDirectory: async () => tempRoot,
          removePath: async () => {},
        },
      ).then(
        () => undefined,
        (failure) => failure as Error,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(error?.message).toContain('primary build failure');
      expect(error?.message).toContain('worktree cleanup failure');
      expect(error?.cause).toBeInstanceOf(Error);
      expect((error?.cause as Error).message).toBe('primary build failure');
    });

    it('fails when temporary-parent cleanup fails after a successful operation', async () => {
      const tempRoot = '/workspace/.build-temp/dev-cleanup-failure';
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');

      await expect(
        runMacosBuild(
          { channel: 'dev', repositoryRoot: virtualRepository },
          {
            execute: async (command, args) => {
              if (command === 'git' && args.includes('rev-parse')) {
                return { stdout: `${devSha}\n`, stderr: '' };
              }
              return { stdout: '', stderr: '' };
            },
            makeTemporaryDirectory: async () => tempRoot,
            removePath: async (targetPath) => {
              if (targetPath === tempRoot) {
                throw new Error('temporary parent cleanup failed');
              }
            },
            writeDevTauriConfig: async () => join(tempRoot, 'dev.json'),
            findCandidateApp: async () => '/workspace/Psyche Build Dev.app',
            readBundleIdentity: async () => devIdentity,
            installBundleTransactional: async () => installedPath,
            writeBuildProvenance: async () => '/state/builds.json',
            homeDir: virtualHome,
          },
        ),
      ).rejects.toThrow('temporary parent cleanup failed');
    });
  });

  describe('CLI entrypoint', () => {
    it('prints stable install path and exact SHA without a dirty phrase', async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const runBuild = vi.fn(async () => ({
        channel: 'stable' as const,
        commitSha: 'a'.repeat(40),
        requestedRef: 'release/v1.2.3',
        dirty: false,
        builtAt: '2026-08-10T18:00:00.000Z',
        installedPath: '/Users/test/Applications/Psyche Build.app',
        productName: 'Psyche Build',
        bundleIdentifier: 'dev.opencoven.psyche',
      }));

      await expect(
        runCli(['stable', 'release/v1.2.3'], {
          runBuild,
          stdout: (line: string) => stdout.push(line),
          stderr: (line: string) => stderr.push(line),
        }),
      ).resolves.toBe(0);

      expect(runBuild).toHaveBeenCalledOnce();
      expect(runBuild).toHaveBeenCalledWith({
        channel: 'stable',
        ref: 'release/v1.2.3',
        repositoryRoot,
      });
      expect(stdout).toEqual([
        'Installed Psyche Build at /Users/test/Applications/Psyche Build.app',
        `Source ${'a'.repeat(40)} (clean source)`,
      ]);
      expect(stdout.join('\n')).not.toMatch(/dirty/i);
      expect(stderr).toEqual([]);
    });

    it('prints dev install path, exact SHA, and the dirty phrase for a dirty dev build', async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const runBuild = vi.fn(async () => ({
        channel: 'dev' as const,
        commitSha: 'b'.repeat(40),
        dirty: true,
        builtAt: '2026-08-10T18:00:00.000Z',
        installedPath: '/Users/test/Applications/Psyche Build Dev.app',
        productName: 'Psyche Build Dev',
        bundleIdentifier: 'dev.opencoven.psyche.dev',
      }));

      await expect(
        runCli(['dev'], {
          runBuild,
          stdout: (line: string) => stdout.push(line),
          stderr: (line: string) => stderr.push(line),
        }),
      ).resolves.toBe(0);

      expect(runBuild).toHaveBeenCalledOnce();
      expect(stdout).toEqual([
        'Installed Psyche Build Dev at /Users/test/Applications/Psyche Build Dev.app',
        `Source ${'b'.repeat(40)} (dirty source)`,
      ]);
      expect(stderr).toEqual([]);
    });

    it('prints CLI errors to stderr without reporting success', async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const runBuild = vi.fn(async () => {
        throw new Error('build exploded');
      });

      await expect(
        runCli(['dev'], {
          runBuild,
          stdout: (line: string) => stdout.push(line),
          stderr: (line: string) => stderr.push(line),
        }),
      ).resolves.toBe(1);

      expect(runBuild).toHaveBeenCalledOnce();
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(['build exploded']);
    });

    it('names the missing stable ref on stderr, exits nonzero, and prints no install success', () => {
      const result = spawnSync('node', [scriptPath, 'stable'], {
        cwd: tauriDirectory,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('Installed');
      expect(result.stderr).toMatch(/stable.*ref/i);
    });
  });
});
