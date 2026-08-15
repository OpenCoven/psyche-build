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
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { rename as renameAsync } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertBundleIdentity,
  buildDevAppSnapshot,
  buildCommandsFor,
  channelConfig,
  createDevTauriConfig,
  findCandidateApp,
  installBundleTransactional,
  parseBuildArguments,
  publishBuildChannel,
  readBundleIdentity,
  resolveCommit,
  runDevBuildSnapshotUnlocked,
  runCli,
  runCommand,
  runMacosBuild,
  smokeLaunchBundle,
  sourceIsDirty,
  writeDevTauriConfig,
  writeBuildProvenance,
} from '../scripts/build-macos-app.mjs';
import { runBuildDevAppHelper } from '../scripts/build-dev-app.mjs';
import type {
  BuildProvenance,
  BundleIdentity,
  CommandOptions,
  CommandResult,
  InstallOverrides,
  TauriConfigOverlay,
  Runner,
  RunCliDependencies,
  RunMacosBuildDependencies,
  SmokeLaunchOverrides,
} from '../scripts/build-macos-app.mjs';

const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, 'scripts/build-macos-app.mjs');
const devBuildHelperPath = join(repositoryRoot, 'scripts/build-dev-app.mjs');
const publishHelperPath = join(repositoryRoot, 'scripts/publish-build-channel.mjs');
const provenanceHelperPath = join(repositoryRoot, 'scripts/write-build-provenance.mjs');
const tauriRelativeCwd = 'native/desktop/psyche-build-tauri';
const tauriDirectory = join(repositoryRoot, tauriRelativeCwd);
const manifestPath = 'native/desktop/psyche-build-tauri/src-tauri/Cargo.toml';
const devConfigPath = resolve(repositoryRoot, 'native/desktop/psyche-build-tauri/dev.tauri.generated.json');
const scratchRoot = join(repositoryRoot, '.agent-test-artifacts', 'macos-build-channels');
const devSourcePathspecs = [
  ':(top,glob)**',
  ':(top,glob,exclude)**/target/**',
  ':(top,glob,exclude)**/node_modules/**',
  ':(top,glob,exclude)native/desktop/psyche-build-tauri/web/*.bundle.js',
];

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

const baseTauriConfig = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      'native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json',
    ),
    'utf8',
  ),
) as TauriConfig;
const macosTauriOverlay = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      'native/desktop/psyche-build-tauri/src-tauri/tauri.macos.conf.json',
    ),
    'utf8',
  ),
) as TauriConfigOverlay;

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

function createIdentifiedAppBundle(
  root: string,
  relativePath: string,
  marker: string,
  identity: BundleIdentity,
): string {
  const appPath = createAppBundle(root, relativePath, marker);
  writeFileSync(
    join(appPath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${identity.name}</string>
  <key>CFBundleIdentifier</key>
  <string>${identity.identifier}</string>
  <key>CFBundleExecutable</key>
  <string>${identity.executable}</string>
</dict>
</plist>
`,
    'utf8',
  );
  writeFileSync(join(appPath, 'Contents', 'MacOS', identity.executable), '', {
    mode: 0o755,
  });
  return appPath;
}

function readAppMarker(appPath: string): string {
  return readFileSync(join(appPath, 'Contents', 'marker.txt'), 'utf8');
}

function copyBundle(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true });
}

function createGatedPlutilDirectory(root: string): string {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'plutil'),
    `#!/bin/sh
if [ -n "$PSYCHE_TEST_PLUTIL_STARTED_PATH" ]; then
  printf started > "$PSYCHE_TEST_PLUTIL_STARTED_PATH"
fi
info_path=
for argument in "$@"; do
  info_path="$argument"
done
if [ "$2" = "CFBundleName" ] &&
   [ -n "$PSYCHE_TEST_FINAL_PATH" ] &&
   [ "$(dirname "$(dirname "$info_path")")" = "$PSYCHE_TEST_FINAL_PATH" ]; then
  printf ready > "$PSYCHE_TEST_READY_PATH"
  while [ ! -e "$PSYCHE_TEST_RELEASE_PATH" ]; do
    sleep 0.05
  done
  if [ "$PSYCHE_TEST_FAIL_FINAL_IDENTITY" = "1" ]; then
    printf "Wrong Product"
    exit 0
  fi
fi
exec /usr/bin/plutil "$@"
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  return binDir;
}

type PublicationProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function spawnChannelPublisher(
  candidatePath: string,
  requestedChannelConfig: ReturnType<typeof channelConfig>,
  provenance: BuildProvenance,
  homeDir: string,
  env: NodeJS.ProcessEnv = {},
): {
  completion: Promise<PublicationProcessResult>;
} {
  const childScript = `
    import { writeFile } from 'node:fs/promises';

    const input = JSON.parse(process.env.PSYCHE_PUBLICATION_DRIVER_INPUT);
    if (input.startedPath) {
      await writeFile(input.startedPath, 'started');
    }
    try {
      const { publishBuildChannel } = await import(input.moduleUrl);
      const installedPath = await publishBuildChannel(
        input.candidatePath,
        input.channelConfig,
        input.provenance,
        {
          homeDir: input.homeDir,
          lockTimeoutSeconds: 5,
        },
      );
      process.stdout.write(installedPath + '\\n');
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.stack ?? error.message : String(error)) + '\\n',
      );
      process.exitCode = 1;
    }
  `;
  const child = spawnChild(
    process.execPath,
    ['--input-type=module', '--eval', childScript],
    {
      env: {
        ...process.env,
        ...env,
        PSYCHE_PUBLICATION_DRIVER_INPUT: JSON.stringify({
          moduleUrl: pathToFileURL(scriptPath).href,
          candidatePath,
          channelConfig: requestedChannelConfig,
          provenance,
          homeDir,
          startedPath: env.PSYCHE_TEST_PUBLISH_STARTED_PATH,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const completion = new Promise<PublicationProcessResult>((resolveChild, rejectChild) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectChild);
    child.on('close', (code, signal) => {
      resolveChild({ code, signal, stdout, stderr });
    });
  });

  return { completion };
}

type DevSnapshotProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function spawnDevSnapshotBuilder(
  sourceRoot: string,
  tempRoot: string,
  devConfigPath: string,
  env: NodeJS.ProcessEnv,
): {
  completion: Promise<DevSnapshotProcessResult>;
} {
  const childScript = `
    import { writeFile } from 'node:fs/promises';

    const input = JSON.parse(process.env.PSYCHE_DEV_SNAPSHOT_DRIVER_INPUT);
    if (input.startedPath) {
      await writeFile(input.startedPath, 'started');
    }
    try {
      const { buildDevAppSnapshot } = await import(input.moduleUrl);
      const result = await buildDevAppSnapshot(
        {
          sourceRoot: input.sourceRoot,
          tempRoot: input.tempRoot,
          devConfigPath: input.devConfigPath,
        },
        { lockTimeoutSeconds: 5 },
      );
      process.stdout.write(JSON.stringify(result) + '\\n');
    } catch (error) {
      process.stderr.write(
        (error instanceof Error ? error.stack ?? error.message : String(error)) + '\\n',
      );
      process.exitCode = 1;
    }
  `;
  const child = spawnChild(
    process.execPath,
    ['--input-type=module', '--eval', childScript],
    {
      env: {
        ...process.env,
        ...env,
        PSYCHE_DEV_SNAPSHOT_DRIVER_INPUT: JSON.stringify({
          moduleUrl: pathToFileURL(scriptPath).href,
          sourceRoot,
          tempRoot,
          devConfigPath,
          startedPath: env.PSYCHE_TEST_DEV_DRIVER_STARTED_PATH,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const completion = new Promise<DevSnapshotProcessResult>((resolveChild, rejectChild) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectChild);
    child.on('close', (code, signal) => {
      resolveChild({ code, signal, stdout, stderr });
    });
  });

  return { completion };
}

function spawnProvenanceWriter(
  record: BuildProvenance,
  homeDir: string,
  readyPath: string,
  startPath: string,
): Promise<void> {
  const childScript = `
    import { existsSync } from 'node:fs';
    import { writeFile } from 'node:fs/promises';
    import { setTimeout as sleep } from 'node:timers/promises';

    const { moduleUrl, recordJson, homeDir, readyPath, startPath } = JSON.parse(
      process.env.PSYCHE_PROVENANCE_WRITER_INPUT,
    );
    await writeFile(readyPath, 'ready');
    while (!existsSync(startPath)) {
      await sleep(1);
    }
    const { writeBuildProvenance } = await import(moduleUrl);
    await writeBuildProvenance(JSON.parse(recordJson), {
      homeDir,
      lockTimeoutSeconds: 5,
    });
  `;
  const child = spawnChild(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      childScript,
    ],
    {
      env: {
        ...process.env,
        PSYCHE_PROVENANCE_WRITER_INPUT: JSON.stringify({
          moduleUrl: pathToFileURL(scriptPath).href,
          recordJson: JSON.stringify(record),
          homeDir,
          readyPath,
          startPath,
        }),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );

  return new Promise<void>((resolveChild, rejectChild) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectChild);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolveChild();
        return;
      }
      rejectChild(
        new Error(
          `provenance child exited with code ${String(code)} signal ${String(signal)}: ${stderr}`,
        ),
      );
    });
  });
}

function spawnLockfProcess(
  lockPath: string,
  childScript: string,
  childArgs: string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawnChild(
    '/usr/bin/lockf',
    [
      '-k',
      '-t',
      '5',
      lockPath,
      process.execPath,
      '--input-type=module',
      '--eval',
      childScript,
      ...childArgs,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  return new Promise((resolveChild, rejectChild) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', rejectChild);
    child.on('close', (code, signal) => {
      resolveChild({ code, signal, stderr });
    });
  });
}

async function waitForPaths(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (paths.every((candidate) => existsSync(candidate))) {
      return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for paths: ${paths.join(', ')}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessToStop(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Timed out waiting for process ${pid} to stop`);
}

async function waitForPathOrPublicationFailure(
  readyPath: string,
  completion: Promise<PublicationProcessResult>,
): Promise<void> {
  await Promise.race([
    waitForPaths([readyPath]),
    completion.then((result) => {
      throw new Error(
        `Publication exited before "${readyPath}" was created: ` +
          `${JSON.stringify(result)}`,
      );
    }),
  ]);
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
    expect(baseTauriConfig.productName).toBe('Psyche Build');
    expect(baseTauriConfig.identifier).toBe('dev.opencoven.psyche');
    expect(baseTauriConfig.app.windows[0].title).toBe('Psyche Build');
  });

  it('documents stable and dev local app workflows and their isolation boundary', () => {
    const contributing = readFileSync(join(repositoryRoot, 'CONTRIBUTING.md'), 'utf8');

    expect(contributing).toContain('pnpm app:stable -- <git-ref>');
    expect(contributing).toContain('pnpm app:dev');
    expect(contributing).toContain('~/Applications/Psyche Build.app');
    expect(contributing).toContain('~/Applications/Psyche Build Dev.app');
    expect(contributing).toContain('temporary detached worktree');
    expect(contributing).toMatch(
      /preferences, WebView data, caches, and\s+restored state isolated/,
    );
    expect(contributing).toContain(
      'Local commands do not create a signed or notarized public release.',
    );
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
      const production = structuredClone(baseTauriConfig);
      const overlay = structuredClone(macosTauriOverlay);
      const productionSnapshot = structuredClone(baseTauriConfig);
      const overlaySnapshot = structuredClone(macosTauriOverlay);

      const dev = createDevTauriConfig(production, overlay);

      expect(dev).toEqual({
        ...productionSnapshot,
        productName: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        app: {
          ...productionSnapshot.app,
          ...overlaySnapshot.app,
          windows: [
            {
              ...productionSnapshot.app.windows[0],
              ...overlaySnapshot.app!.windows![0],
              title: 'Psyche Build Dev',
            },
          ],
        },
        bundle: {
          ...productionSnapshot.bundle,
          ...overlaySnapshot.bundle,
        },
      });
      expect(dev.app.windows[0]).toMatchObject({
        label: 'main',
        title: 'Psyche Build Dev',
        transparent: true,
        titleBarStyle: 'Overlay',
        hiddenTitle: true,
      });
      expect(dev).toMatchObject({
        bundle: {
          icon: [
            'icons/32x32.png',
            'icons/128x128.png',
            'icons/128x128@2x.png',
            'icons/icon.icns',
          ],
          macOS: {
            minimumSystemVersion: '12.0',
          },
        },
      });
      expect(dev.build).toEqual(productionSnapshot.build);
      expect(dev.app.security).toEqual(productionSnapshot.app.security);
      expect(production).toEqual(productionSnapshot);
      expect(overlay).toEqual(overlaySnapshot);
    });

    it('fails when the production config has no main window', () => {
      const withoutMain = structuredClone(baseTauriConfig);
      const overlayWithoutMain = structuredClone(macosTauriOverlay);
      withoutMain.app.windows[0] = {
        ...withoutMain.app.windows[0],
        label: 'secondary',
      };
      overlayWithoutMain.app!.windows![0] = {
        ...overlayWithoutMain.app!.windows![0],
        label: 'secondary',
      };

      expect(() => createDevTauriConfig(withoutMain, overlayWithoutMain)).toThrow(
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

    it('aborts the active command and preserves detailed abort diagnostics', async () => {
      const controller = new AbortController();
      const startedPath = join(
        createScratchDirectory('run-command-abort'),
        'started',
      );
      const command = runCommand(
        process.execPath,
        [
          '-e',
          `import("node:fs").then(({ writeFileSync }) => {
            process.stdout.write(
              "child started",
              () => writeFileSync(process.argv[1], "started"),
            );
            setTimeout(() => process.exit(0), 250);
          })`,
          startedPath,
        ],
        {
          cwd: repositoryRoot,
          stage: 'exercise command cancellation',
          signal: controller.signal,
        },
      );
      await waitForPaths([startedPath]);
      controller.abort(new Error('test requested command cancellation'));

      const failure = await command.then(
        () => undefined,
        (error) =>
          error as Error & {
            code?: string;
            stdout?: string;
          },
      );

      expect(failure).toBeDefined();
      expect(failure?.message).toContain('exercise command cancellation');
      expect(failure?.message).toMatch(/abort/i);
      expect(failure?.message).toContain('child started');
      expect(failure?.message).toContain('test requested command cancellation');
      expect(failure?.code).toBe('ABORT_ERR');
      expect(failure?.stdout).toEqual(expect.any(String));
      expect(failure?.cause).toBeInstanceOf(Error);
      expect(failure?.message).not.toContain('process-group termination failed');
    });

    it('waits for the aborted command process group before returning', async () => {
      const controller = new AbortController();
      const childPidPath = join(
        createScratchDirectory('run-command-process-group'),
        'child.pid',
      );
      const command = runCommand(
        process.execPath,
        [
          '-e',
          `Promise.all([
            import("node:child_process"),
            import("node:fs"),
          ]).then(([{ spawn }, { writeFileSync }]) => {
            const child = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              { stdio: "ignore" },
            );
            writeFileSync(process.argv[1], String(child.pid));
            setInterval(() => {}, 1000);
          })`,
          childPidPath,
        ],
        {
          cwd: repositoryRoot,
          stage: 'exercise process-group cancellation',
          signal: controller.signal,
        },
      );
      await waitForPaths([childPidPath]);
      const childPid = Number(readFileSync(childPidPath, 'utf8'));

      try {
        controller.abort(new Error('test requested process-group cancellation'));
        await expect(command).rejects.toThrow(/process-group cancellation|abort/i);
        await waitForProcessToStop(childPid);
      } finally {
        if (processIsAlive(childPid)) {
          process.kill(childPid, 'SIGKILL');
        }
      }
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
      runGit(gitRepository, ['config', 'commit.gpgsign', 'false']);
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
        createDevTauriConfig(baseTauriConfig, macosTauriOverlay),
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

  describe('buildDevAppSnapshot', () => {
    it('uses the exact dev-build lockf arguments and a private mode-0600 input file', async () => {
      const sourceRoot = createScratchDirectory('dev-snapshot-source');
      const tempRoot = createScratchDirectory('dev-snapshot-temp');
      const configPath = join(tempRoot, 'tauri.dev.json');
      const targetDir = join(
        sourceRoot,
        'native/desktop/psyche-build-tauri/src-tauri/target',
      );
      const lockPath = join(targetDir, '.psyche-build-dev.lock');
      const inputPath = join(tempRoot, '.dev-build.input-fixed.json');
      const snapshotPath = join(
        tempRoot,
        '.dev-build.snapshot-fixed',
        'Psyche Build Dev.app',
      );
      const candidatePath = join(
        sourceRoot,
        'native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos',
        'Psyche Build Dev.app',
      );
      const identity: BundleIdentity = {
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-dev',
      };
      const removedPaths: string[] = [];
      writeFileSync(configPath, '{}\n', 'utf8');

      const execute = vi.fn(async (
        _command: string,
        args: readonly string[],
      ): Promise<CommandResult> => {
        expect(statSync(inputPath).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(inputPath, 'utf8'))).toEqual({
          sourceRoot,
          tempRoot,
          devConfigPath: configPath,
          snapshotPath,
        });
        expect(args).not.toContain(JSON.stringify({
          sourceRoot,
          tempRoot,
          devConfigPath: configPath,
          snapshotPath,
        }));
        expect(args).not.toContain(candidatePath);
        return {
          stdout: `${JSON.stringify({
            snapshotPath,
            identity,
          })}\n`,
          stderr: '',
        };
      });

      await expect(
        buildDevAppSnapshot(
          { sourceRoot, tempRoot, devConfigPath: configPath },
          {
            execute,
            lockTimeoutSeconds: 7,
            randomUUID: () => 'fixed',
            removePath: async (targetPath: string) => {
              removedPaths.push(targetPath);
              rmSync(targetPath, { recursive: true, force: true });
            },
          },
        ),
      ).resolves.toEqual({
        snapshotPath,
        identity,
      });

      expect(execute).toHaveBeenCalledWith(
        '/usr/bin/lockf',
        [
          '-k',
          '-t',
          '7',
          lockPath,
          process.execPath,
          join(repositoryRoot, 'scripts/build-dev-app.mjs'),
          inputPath,
        ],
        { stage: 'build and snapshot dev app' },
      );
      expect(removedPaths).toEqual([inputPath]);
      expect(existsSync(inputPath)).toBe(false);
    });

    it('removes the stale candidate and snapshots the validated helper build with ditto', async () => {
      const sourceRoot = '/workspace/psyche-build';
      const tempRoot = '/workspace/.build-temp/dev-helper';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const bundleDir = join(
        sourceRoot,
        'native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos',
      );
      const candidatePath = join(bundleDir, 'Psyche Build Dev.app');
      const snapshotPath = join(
        tempRoot,
        '.dev-build.snapshot-helper',
        'Psyche Build Dev.app',
      );
      const snapshotParent = resolve(snapshotPath, '..');
      const identity: BundleIdentity = {
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-dev',
      };
      const execute = vi.fn(async (): Promise<CommandResult> => ({
        stdout: '',
        stderr: '',
      }));
      const removePath = vi.fn(async () => {});
      const mkdirPath = vi.fn(async () => {});
      const findCandidate = vi.fn(async () => candidatePath);
      const readIdentity = vi.fn(async () => identity);

      await expect(
        runDevBuildSnapshotUnlocked(
          {
            sourceRoot,
            tempRoot,
            devConfigPath: configPath,
            snapshotPath,
          },
          {
            execute,
            removePath,
            mkdirPath,
            findCandidateApp: findCandidate,
            readBundleIdentity: readIdentity,
          },
        ),
      ).resolves.toEqual({ snapshotPath, identity });

      expect(removePath).toHaveBeenCalledWith(candidatePath);
      expect(mkdirPath).toHaveBeenCalledWith(snapshotParent);
      expect(execute.mock.calls).toEqual([
        ...buildCommandsFor('dev', { devConfigPath: configPath }).map(
          ([command, args, relativeCwd]) => [
            command,
            args,
            {
              cwd: resolve(sourceRoot, relativeCwd),
              stage: `run dev validation/build command: ${command} ${args.join(' ')}`,
            },
          ],
        ),
        [
          'ditto',
          [candidatePath, snapshotPath],
          { stage: 'snapshot dev app bundle with ditto' },
        ],
      ]);
      expect(findCandidate).toHaveBeenCalledWith(bundleDir, 'Psyche Build Dev.app');
      expect(readIdentity).toHaveBeenCalledWith(candidatePath, execute);
    });

    it('reports helper-specific usage instead of running the normal build CLI', () => {
      const result = spawnSync(process.execPath, [devBuildHelperPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'build-dev-app requires exactly one private input-file path',
      );
      expect(result.stderr).not.toContain('Build channel must be "stable" or "dev"');
    });

    it('reads the private input before running the unlocked snapshot operation', async () => {
      const sourceRoot = createScratchDirectory('dev-helper-input-source');
      const tempRoot = createScratchDirectory('dev-helper-input-temp');
      const inputPath = join(tempRoot, '.dev-build.input-test.json');
      const input = {
        sourceRoot,
        tempRoot,
        devConfigPath: join(tempRoot, 'tauri.dev.json'),
        snapshotPath: join(
          tempRoot,
          '.dev-build.snapshot-test',
          'Psyche Build Dev.app',
        ),
      };
      const identity: BundleIdentity = {
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-dev',
      };
      writeFileSync(inputPath, `${JSON.stringify(input)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      const runUnlocked = vi.fn(async () => ({
        snapshotPath: input.snapshotPath,
        identity,
      }));

      await expect(
        runBuildDevAppHelper(
          [inputPath],
          { runDevBuildSnapshotUnlocked: runUnlocked },
        ),
      ).resolves.toEqual({
        snapshotPath: input.snapshotPath,
        identity,
      });
      expect(runUnlocked).toHaveBeenCalledWith(input);
    });

    it('removes the private input after helper failure and includes child diagnostics', async () => {
      const sourceRoot = createScratchDirectory('dev-helper-failure-source');
      const tempRoot = createScratchDirectory('dev-helper-failure-temp');
      const inputPath = join(tempRoot, '.dev-build.input-helper-failure.json');
      const helperError = Object.assign(new Error('dev helper failed'), {
        stderr: 'tauri build exploded',
      });

      const error = await buildDevAppSnapshot(
        {
          sourceRoot,
          tempRoot,
          devConfigPath: join(tempRoot, 'tauri.dev.json'),
        },
        {
          execute: async () => {
            throw helperError;
          },
          randomUUID: () => 'helper-failure',
        },
      ).then(
        () => undefined,
        (failure: unknown) => failure as Error,
      );

      expect(error?.message).toContain('dev helper failed');
      expect(error?.message).toContain('tauri build exploded');
      expect(existsSync(inputPath)).toBe(false);
    });

    it('reports a bounded dev-build timeout together with private-input cleanup failure', async () => {
      const sourceRoot = createScratchDirectory('dev-helper-timeout-source');
      const tempRoot = createScratchDirectory('dev-helper-timeout-temp');
      const lockPath = join(
        sourceRoot,
        'native/desktop/psyche-build-tauri/src-tauri/target/.psyche-build-dev.lock',
      );
      const timeoutError = Object.assign(new Error('lockf failed'), {
        exitCode: 75,
        stderr: `lockf: ${lockPath}: already locked`,
      });

      const error = await buildDevAppSnapshot(
        {
          sourceRoot,
          tempRoot,
          devConfigPath: join(tempRoot, 'tauri.dev.json'),
        },
        {
          execute: async () => {
            throw timeoutError;
          },
          lockTimeoutSeconds: 2,
          randomUUID: () => 'timeout',
          removePath: async () => {
            throw new Error('private input cleanup failed');
          },
        },
      ).then(
        () => undefined,
        (failure: unknown) => failure as Error,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(error?.message).toMatch(
        /Timed out after 2 seconds waiting for dev build lock/i,
      );
      expect(error?.message).toContain(lockPath);
      expect(error?.message).toContain('already locked');
      expect(error?.message).toContain('private input cleanup failed');
      expect(error?.cause).toBeInstanceOf(Error);
      expect((error?.cause as Error).message).toMatch(
        /Timed out after 2 seconds waiting for dev build lock/i,
      );
    });

    it('fails a successful helper operation when private-input cleanup fails', async () => {
      const sourceRoot = createScratchDirectory('dev-helper-cleanup-source');
      const tempRoot = createScratchDirectory('dev-helper-cleanup-temp');
      const snapshotPath = join(
        tempRoot,
        '.dev-build.snapshot-cleanup',
        'Psyche Build Dev.app',
      );
      const identity: BundleIdentity = {
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-dev',
      };

      await expect(
        buildDevAppSnapshot(
          {
            sourceRoot,
            tempRoot,
            devConfigPath: join(tempRoot, 'tauri.dev.json'),
          },
          {
            execute: async () => ({
              stdout: `${JSON.stringify({ snapshotPath, identity })}\n`,
              stderr: '',
            }),
            randomUUID: () => 'cleanup',
            removePath: async () => {
              throw new Error('private input cleanup failed');
            },
          },
        ),
      ).rejects.toThrow(/Failed to clean private dev build input file.*private input cleanup failed/);
    });

    it('keeps each concurrent dev record paired with its own immutable snapshot under the helper lock', async () => {
      const sourceRoot = createScratchDirectory('concurrent-dev-source');
      const tempRootA = createScratchDirectory('concurrent-dev-a');
      const tempRootB = createScratchDirectory('concurrent-dev-b');
      const controls = createScratchDirectory('concurrent-dev-controls');
      const binDir = join(controls, 'bin');
      const tauriRoot = join(sourceRoot, tauriRelativeCwd);
      const candidatePath = join(
        tauriRoot,
        'src-tauri/target/release/bundle/macos/Psyche Build Dev.app',
      );
      const lockPath = join(
        tauriRoot,
        'src-tauri/target/.psyche-build-dev.lock',
      );
      const configPathA = join(tempRootA, 'tauri.dev.json');
      const configPathB = join(tempRootB, 'tauri.dev.json');
      const snapshotStartedA = join(controls, 'a-snapshot-started');
      const releaseSnapshotA = join(controls, 'release-a-snapshot');
      const driverStartedB = join(controls, 'b-driver-started');
      const buildStartedB = join(controls, 'b-build-started');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(tauriRoot, { recursive: true });
      writeFileSync(configPathA, '{"build":"A"}\n', 'utf8');
      writeFileSync(configPathB, '{"build":"B"}\n', 'utf8');
      writeFileSync(
        join(binDir, 'pnpm'),
        `#!/bin/sh
if [ "$1" = "build:web" ]; then
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "tauri" ] && [ "$3" = "build" ]; then
  mkdir -p "$PSYCHE_FAKE_CANDIDATE/Contents/MacOS"
  printf '%s' "$PSYCHE_FAKE_BUILD_MARKER" > "$PSYCHE_FAKE_CANDIDATE/Contents/marker.txt"
  printf executable > "$PSYCHE_FAKE_CANDIDATE/Contents/MacOS/psyche-build-dev"
  if [ -n "$PSYCHE_FAKE_BUILD_STARTED_PATH" ]; then
    printf started > "$PSYCHE_FAKE_BUILD_STARTED_PATH"
  fi
  exit 0
fi
printf 'unexpected pnpm command: %s\\n' "$*" >&2
exit 64
`,
        { encoding: 'utf8', mode: 0o755 },
      );
      writeFileSync(
        join(binDir, 'plutil'),
        `#!/bin/sh
case "$2" in
  CFBundleName) printf 'Psyche Build Dev' ;;
  CFBundleIdentifier) printf 'dev.opencoven.psyche.dev' ;;
  CFBundleExecutable) printf 'psyche-build-dev' ;;
  *) printf 'unexpected plist key: %s\\n' "$2" >&2; exit 64 ;;
esac
`,
        { encoding: 'utf8', mode: 0o755 },
      );
      writeFileSync(
        join(binDir, 'ditto'),
        `#!/bin/sh
if [ "$PSYCHE_FAKE_BUILD_MARKER" = "A" ]; then
  printf started > "$PSYCHE_TEST_SNAPSHOT_STARTED_PATH"
  while [ ! -e "$PSYCHE_TEST_SNAPSHOT_RELEASE_PATH" ]; do
    sleep 0.01
  done
fi
/bin/cp -R "$1" "$2"
`,
        { encoding: 'utf8', mode: 0o755 },
      );

      const commonEnv = {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        PSYCHE_FAKE_CANDIDATE: candidatePath,
      };
      const builderA = spawnDevSnapshotBuilder(
        sourceRoot,
        tempRootA,
        configPathA,
        {
          ...commonEnv,
          PSYCHE_FAKE_BUILD_MARKER: 'A',
          PSYCHE_TEST_SNAPSHOT_STARTED_PATH: snapshotStartedA,
          PSYCHE_TEST_SNAPSHOT_RELEASE_PATH: releaseSnapshotA,
        },
      );

      await Promise.race([
        waitForPaths([snapshotStartedA]),
        builderA.completion.then((result) => {
          throw new Error(`Builder A exited before snapshot gate: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(readAppMarker(candidatePath)).toBe('A');

      const builderB = spawnDevSnapshotBuilder(
        sourceRoot,
        tempRootB,
        configPathB,
        {
          ...commonEnv,
          PSYCHE_FAKE_BUILD_MARKER: 'B',
          PSYCHE_TEST_DEV_DRIVER_STARTED_PATH: driverStartedB,
          PSYCHE_FAKE_BUILD_STARTED_PATH: buildStartedB,
        },
      );
      await waitForPaths([driverStartedB]);

      const contendingLock = spawnSync(
        '/usr/bin/lockf',
        ['-t', '0', lockPath, '/usr/bin/true'],
        { encoding: 'utf8' },
      );
      expect(contendingLock.status).toBe(75);
      expect(existsSync(buildStartedB)).toBe(false);

      writeFileSync(releaseSnapshotA, 'release', 'utf8');
      const [resultA, resultB] = await Promise.all([
        builderA.completion,
        builderB.completion,
      ]);

      expect(resultA).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(resultB).toMatchObject({ code: 0, signal: null, stderr: '' });
      const snapshotA = JSON.parse(resultA.stdout) as {
        snapshotPath: string;
        identity: BundleIdentity;
      };
      const snapshotB = JSON.parse(resultB.stdout) as {
        snapshotPath: string;
        identity: BundleIdentity;
      };
      const recordA = { build: 'A', snapshotPath: snapshotA.snapshotPath };
      const recordB = { build: 'B', snapshotPath: snapshotB.snapshotPath };

      expect(readAppMarker(recordA.snapshotPath)).toBe(recordA.build);
      expect(readAppMarker(recordB.snapshotPath)).toBe(recordB.build);
      expect(recordA.snapshotPath).not.toBe(recordB.snapshotPath);
      expect(snapshotA.identity.identifier).toBe('dev.opencoven.psyche.dev');
      expect(snapshotB.identity.identifier).toBe('dev.opencoven.psyche.dev');
      expect(
        readdirSync(tempRootA).some((entry) => entry.startsWith('.dev-build.input-')),
      ).toBe(false);
      expect(
        readdirSync(tempRootB).some((entry) => entry.startsWith('.dev-build.input-')),
      ).toBe(false);
    }, 15_000);
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

    it('waits for SIGKILL escalation before completing smoke cancellation', async () => {
      const events: string[] = [];
      const controller = new AbortController();
      const child = createFakeChildProcess((signal) => {
        events.push(`kill:${String(signal)}`);
        if (signal === 'SIGKILL') {
          events.push('close');
          child.close(null, 'SIGKILL');
        }
      });
      const spawnProcess = vi.fn(
        (
          _command: string,
          _args: readonly string[],
          options: { signal?: AbortSignal },
        ) => {
          options.signal?.addEventListener(
            'abort',
            () => child.fail(new Error('spawn aborted before close')),
            { once: true },
          );
          return child.child;
        },
      );
      const removeTemporaryHome = vi.fn(async () => {
        events.push('remove-home');
      });
      const launch = smokeLaunchBundle('/Applications/Psyche Build.app', {
        executableName: 'Psyche Build',
        signal: controller.signal,
        spawnProcess,
        smokeMs: 10_000,
        termTimeoutMs: 5,
        postKillTimeoutMs: 5,
        makeTemporaryHome: async () => '/virtual/home',
        removeTemporaryHome,
      });

      await tick();
      controller.abort(new Error('test requested smoke cancellation'));

      await expect(launch).rejects.toThrow(/smoke cancellation|abort/i);
      expect(child.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
      expect(child.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(events.indexOf('close')).toBeLessThan(events.indexOf('remove-home'));
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

  describe('publishBuildChannel', () => {
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
    const devRecord = {
      channel: 'dev' as const,
      commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      dirty: true,
      builtAt: '2026-08-10T11:00:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build Dev.app',
      productName: 'Psyche Build Dev',
      bundleIdentifier: 'dev.opencoven.psyche.dev',
    };

    it('uses the exact channel lockf arguments and a private mode-0600 input file', async () => {
      const homeDir = createScratchDirectory('publish-lockf-arguments');
      const applicationsDir = join(homeDir, 'Applications');
      const stateDir = join(
        homeDir,
        'Library',
        'Application Support',
        'Psyche Build Builder',
      );
      const candidatePath = createAppBundle(
        createScratchDirectory('publish-candidate'),
        'Psyche Build Dev.app',
        'candidate',
      );
      const installedPath = join(applicationsDir, 'Psyche Build Dev.app');
      const record = { ...devRecord, installedPath };
      const inputPath = join(stateDir, '.publish-dev.input-fixed-input.json');
      const lockPath = join(applicationsDir, '.Psyche Build Dev.app.publish.lock');
      const removedPaths: string[] = [];
      const execute = vi.fn(async (
        _command: string,
        args: readonly string[],
      ): Promise<CommandResult> => {
        expect(statSync(inputPath).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(inputPath, 'utf8'))).toEqual({
          candidatePath,
          channelConfig: channelConfig('dev'),
          homeDir,
          provenance: record,
        });
        expect(args).not.toContain(JSON.stringify(record));
        expect(args).not.toContain(candidatePath);
        expect(args.every((argument) => !argument.includes(record.commitSha))).toBe(true);
        return { stdout: `${installedPath}\n`, stderr: '' };
      });

      await expect(
        publishBuildChannel(
          candidatePath,
          channelConfig('dev'),
          record,
          {
            homeDir,
            execute,
            lockTimeoutSeconds: 7,
            randomUUID: () => 'fixed-input',
            removePath: async (targetPath: string) => {
              removedPaths.push(targetPath);
              rmSync(targetPath, { recursive: true, force: true });
            },
          },
        ),
      ).resolves.toBe(installedPath);

      expect(execute).toHaveBeenCalledWith(
        '/usr/bin/lockf',
        [
          '-k',
          '-t',
          '7',
          lockPath,
          process.execPath,
          publishHelperPath,
          inputPath,
        ],
        { stage: 'publish dev app and provenance' },
      );
      expect(removedPaths).toEqual([inputPath]);
      expect(existsSync(inputPath)).toBe(false);
    });

    it('reports a bounded channel lock timeout and does not mask it with input cleanup failure', async () => {
      const homeDir = createScratchDirectory('publish-lock-timeout');
      const applicationsDir = join(homeDir, 'Applications');
      const candidatePath = createAppBundle(
        createScratchDirectory('publish-timeout-candidate'),
        'Psyche Build Dev.app',
        'candidate',
      );
      const record = {
        ...devRecord,
        installedPath: join(applicationsDir, 'Psyche Build Dev.app'),
      };
      const lockPath = join(applicationsDir, '.Psyche Build Dev.app.publish.lock');
      const timeoutError = Object.assign(new Error('lockf failed'), {
        exitCode: 75,
        stderr: `lockf: ${lockPath}: already locked`,
      });

      const error = await publishBuildChannel(
        candidatePath,
        channelConfig('dev'),
        record,
        {
          homeDir,
          execute: async () => {
            throw timeoutError;
          },
          lockTimeoutSeconds: 2,
          randomUUID: () => 'timeout-input',
          removePath: async () => {
            throw new Error('private input cleanup failed');
          },
        },
      ).then(
        () => undefined,
        (failure) => failure as Error,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(error?.message).toMatch(
        /Timed out after 2 seconds waiting for dev app publication lock/i,
      );
      expect(error?.message).toContain(lockPath);
      expect(error?.message).toContain('already locked');
      expect(error?.message).toContain('private input cleanup failed');
      expect(error?.cause).toBeInstanceOf(Error);
      expect((error?.cause as Error).message).toMatch(
        /Timed out after 2 seconds waiting for dev app publication lock/i,
      );
    });

    it('reports helper-specific usage instead of running the normal build CLI', () => {
      const result = spawnSync(process.execPath, [publishHelperPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'publish-build-channel requires exactly one private input-file path',
      );
      expect(result.stderr).not.toContain('Build channel must be "stable" or "dev"');
    });

    it('keeps the installed app and reports it explicitly when provenance publication fails', async () => {
      const homeDir = createScratchDirectory('publish-provenance-failure');
      const applicationsDir = join(homeDir, 'Applications');
      const stateDir = join(
        homeDir,
        'Library',
        'Application Support',
        'Psyche Build Builder',
      );
      const statePath = join(stateDir, 'builds.json');
      const candidatePath = createIdentifiedAppBundle(
        createScratchDirectory('publish-provenance-failure-candidate'),
        'Psyche Build Dev.app',
        'installed-before-provenance-failure',
        devIdentity,
      );
      const installedPath = join(applicationsDir, 'Psyche Build Dev.app');
      const record = { ...devRecord, installedPath };
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath, '{"version":2,"channels":{}}\n', 'utf8');

      const error = await publishBuildChannel(
        candidatePath,
        channelConfig('dev'),
        record,
        { homeDir },
      ).then(
        () => undefined,
        (failure) => failure as Error & { stdout?: string },
      );

      expect(error?.message).toContain(
        `App installed at "${installedPath}", but build provenance publication failed`,
      );
      expect(error?.message).toContain('Invalid build provenance file');
      expect(error?.stdout).toBe('');
      expect(readAppMarker(installedPath)).toBe('installed-before-provenance-failure');
      expect(readFileSync(statePath, 'utf8')).toBe('{"version":2,"channels":{}}\n');
    }, 15_000);

    it('serializes same-channel install through provenance so the installed marker and SHA correspond', async () => {
      const homeDir = createScratchDirectory('publish-same-channel');
      const applicationsDir = join(homeDir, 'Applications');
      const statePath = join(
        homeDir,
        'Library',
        'Application Support',
        'Psyche Build Builder',
        'builds.json',
      );
      const installedPath = join(applicationsDir, 'Psyche Build Dev.app');
      const lockPath = join(applicationsDir, '.Psyche Build Dev.app.publish.lock');
      const controls = createScratchDirectory('publish-same-channel-controls');
      const binDir = createGatedPlutilDirectory(controls);
      const readyPath = join(controls, 'a-final-ready');
      const releasePath = join(controls, 'release-a');
      const bStartedPath = join(controls, 'b-started');
      const candidateA = createIdentifiedAppBundle(
        createScratchDirectory('publish-same-channel-a'),
        'Psyche Build Dev.app',
        'candidate-a',
        devIdentity,
      );
      const candidateB = createIdentifiedAppBundle(
        createScratchDirectory('publish-same-channel-b'),
        'Psyche Build Dev.app',
        'candidate-b',
        devIdentity,
      );
      const recordA = {
        ...devRecord,
        commitSha: 'a'.repeat(40),
        builtAt: '2026-08-10T11:00:00.000Z',
        installedPath,
      };
      const recordB = {
        ...devRecord,
        commitSha: 'b'.repeat(40),
        builtAt: '2026-08-10T11:00:01.000Z',
        installedPath,
      };
      const publisherA = spawnChannelPublisher(
        candidateA,
        channelConfig('dev'),
        recordA,
        homeDir,
        {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PSYCHE_TEST_FINAL_PATH: installedPath,
          PSYCHE_TEST_READY_PATH: readyPath,
          PSYCHE_TEST_RELEASE_PATH: releasePath,
        },
      );

      await waitForPathOrPublicationFailure(readyPath, publisherA.completion);
      expect(readAppMarker(installedPath)).toBe('candidate-a');

      const publisherB = spawnChannelPublisher(
        candidateB,
        channelConfig('dev'),
        recordB,
        homeDir,
        {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PSYCHE_TEST_PUBLISH_STARTED_PATH: bStartedPath,
        },
      );
      await waitForPaths([bStartedPath]);
      const contendingLock = spawnSync(
        '/usr/bin/lockf',
        ['-t', '0', lockPath, '/usr/bin/true'],
        { encoding: 'utf8' },
      );
      writeFileSync(releasePath, 'release', 'utf8');
      const [resultA, resultB] = await Promise.all([
        publisherA.completion,
        publisherB.completion,
      ]);

      expect(contendingLock.status).toBe(75);
      expect(resultA).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(resultB).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(readAppMarker(installedPath)).toBe('candidate-b');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).channels.dev).toEqual(recordB);
    }, 15_000);

    it('prevents a failed concurrent rollback from removing another same-channel app', async () => {
      const homeDir = createScratchDirectory('publish-rollback-isolation');
      const applicationsDir = join(homeDir, 'Applications');
      const statePath = join(
        homeDir,
        'Library',
        'Application Support',
        'Psyche Build Builder',
        'builds.json',
      );
      const installedPath = join(applicationsDir, 'Psyche Build Dev.app');
      const lockPath = join(applicationsDir, '.Psyche Build Dev.app.publish.lock');
      const controls = createScratchDirectory('publish-rollback-controls');
      const binDir = createGatedPlutilDirectory(controls);
      const readyPath = join(controls, 'failing-final-ready');
      const releasePath = join(controls, 'release-failing');
      const succeedingStartedPath = join(controls, 'succeeding-started');
      const failingCandidate = createIdentifiedAppBundle(
        createScratchDirectory('publish-rollback-failing'),
        'Psyche Build Dev.app',
        'failing-candidate',
        devIdentity,
      );
      const succeedingCandidate = createIdentifiedAppBundle(
        createScratchDirectory('publish-rollback-succeeding'),
        'Psyche Build Dev.app',
        'succeeding-candidate',
        devIdentity,
      );
      const failingRecord = {
        ...devRecord,
        commitSha: 'c'.repeat(40),
        builtAt: '2026-08-10T11:00:02.000Z',
        installedPath,
      };
      const succeedingRecord = {
        ...devRecord,
        commitSha: 'd'.repeat(40),
        builtAt: '2026-08-10T11:00:03.000Z',
        installedPath,
      };
      const failingPublisher = spawnChannelPublisher(
        failingCandidate,
        channelConfig('dev'),
        failingRecord,
        homeDir,
        {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PSYCHE_TEST_FINAL_PATH: installedPath,
          PSYCHE_TEST_READY_PATH: readyPath,
          PSYCHE_TEST_RELEASE_PATH: releasePath,
          PSYCHE_TEST_FAIL_FINAL_IDENTITY: '1',
        },
      );

      await waitForPathOrPublicationFailure(readyPath, failingPublisher.completion);
      const succeedingPublisher = spawnChannelPublisher(
        succeedingCandidate,
        channelConfig('dev'),
        succeedingRecord,
        homeDir,
        {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PSYCHE_TEST_PUBLISH_STARTED_PATH: succeedingStartedPath,
        },
      );
      await waitForPaths([succeedingStartedPath]);
      const contendingLock = spawnSync(
        '/usr/bin/lockf',
        ['-t', '0', lockPath, '/usr/bin/true'],
        { encoding: 'utf8' },
      );
      writeFileSync(releasePath, 'release', 'utf8');
      const [failingResult, succeedingResult] = await Promise.all([
        failingPublisher.completion,
        succeedingPublisher.completion,
      ]);

      expect(contendingLock.status).toBe(75);
      expect(failingResult.code).toBe(1);
      expect(failingResult.stderr).toContain('Bundle identity mismatch');
      expect(succeedingResult).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(readAppMarker(installedPath)).toBe('succeeding-candidate');
      expect(JSON.parse(readFileSync(statePath, 'utf8')).channels.dev).toEqual(
        succeedingRecord,
      );
    }, 15_000);

    it('lets stable and dev publication locks proceed independently and preserves both records', async () => {
      const homeDir = createScratchDirectory('publish-distinct-channels');
      const applicationsDir = join(homeDir, 'Applications');
      const statePath = join(
        homeDir,
        'Library',
        'Application Support',
        'Psyche Build Builder',
        'builds.json',
      );
      const stableInstalledPath = join(applicationsDir, 'Psyche Build.app');
      const devInstalledPath = join(applicationsDir, 'Psyche Build Dev.app');
      const controls = createScratchDirectory('publish-distinct-controls');
      const binDir = createGatedPlutilDirectory(controls);
      const stableReadyPath = join(controls, 'stable-final-ready');
      const stableReleasePath = join(controls, 'release-stable');
      const stableCandidate = createIdentifiedAppBundle(
        createScratchDirectory('publish-distinct-stable'),
        'Psyche Build.app',
        'stable-candidate',
        stableIdentity,
      );
      const devCandidate = createIdentifiedAppBundle(
        createScratchDirectory('publish-distinct-dev'),
        'Psyche Build Dev.app',
        'dev-candidate',
        devIdentity,
      );
      const stableRecord = {
        channel: 'stable' as const,
        commitSha: 'e'.repeat(40),
        requestedRef: 'release/v1',
        dirty: false,
        builtAt: '2026-08-10T11:00:04.000Z',
        installedPath: stableInstalledPath,
        productName: 'Psyche Build',
        bundleIdentifier: 'dev.opencoven.psyche',
      };
      const distinctDevRecord = {
        ...devRecord,
        commitSha: 'f'.repeat(40),
        builtAt: '2026-08-10T11:00:05.000Z',
        installedPath: devInstalledPath,
      };
      const stablePublisher = spawnChannelPublisher(
        stableCandidate,
        channelConfig('stable'),
        stableRecord,
        homeDir,
        {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PSYCHE_TEST_FINAL_PATH: stableInstalledPath,
          PSYCHE_TEST_READY_PATH: stableReadyPath,
          PSYCHE_TEST_RELEASE_PATH: stableReleasePath,
        },
      );

      await waitForPathOrPublicationFailure(
        stableReadyPath,
        stablePublisher.completion,
      );
      const devPublisher = spawnChannelPublisher(
        devCandidate,
        channelConfig('dev'),
        distinctDevRecord,
        homeDir,
        { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      );
      const devBeforeStableRelease = await Promise.race([
        devPublisher.completion.then((result) => ({ result, timedOut: false })),
        new Promise<{ result?: never; timedOut: true }>((resolveTimeout) => {
          setTimeout(() => resolveTimeout({ timedOut: true }), 3_000);
        }),
      ]);
      writeFileSync(stableReleasePath, 'release', 'utf8');
      const [stableResult, devResult] = await Promise.all([
        stablePublisher.completion,
        devPublisher.completion,
      ]);

      expect(devBeforeStableRelease.timedOut).toBe(false);
      expect(stableResult).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(devResult).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(readAppMarker(stableInstalledPath)).toBe('stable-candidate');
      expect(readAppMarker(devInstalledPath)).toBe('dev-candidate');
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          dev: distinctDevRecord,
          stable: stableRecord,
        },
      });
    }, 15_000);
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

    it('invokes lockf with an exact argument array and never puts record JSON on the command line', async () => {
      const homeDir = createScratchDirectory('provenance-lockf-arguments');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const statePath = join(stateDir, 'builds.json');
      const inputPath = join(stateDir, '.builds.json.input-fixed-input.json');
      const lockPath = `${statePath}.lock`;
      const execute = vi.fn(async (
        _command: string,
        _args: readonly string[],
        _options?: CommandOptions,
      ): Promise<CommandResult> => ({ stdout: '', stderr: '' }));

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          execute,
          lockTimeoutSeconds: 7,
          randomUUID: () => 'fixed-input',
        }),
      ).resolves.toBe(statePath);

      expect(execute).toHaveBeenCalledWith(
        '/usr/bin/lockf',
        [
          '-k',
          '-t',
          '7',
          lockPath,
          process.execPath,
          provenanceHelperPath,
          statePath,
          inputPath,
        ],
        { stage: 'write build provenance' },
      );
      const invokedArgs = execute.mock.calls[0]?.[1] ?? [];
      expect(invokedArgs).not.toContain(JSON.stringify(devRecord));
      expect(invokedArgs.every((argument) => !argument.includes(devRecord.commitSha))).toBe(true);
    });

    it('writes a unique mode-0600 private input file and removes only that input', async () => {
      const homeDir = createScratchDirectory('provenance-private-input');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const inputPath = join(stateDir, '.builds.json.input-private-input.json');
      const removedPaths: string[] = [];
      const execute = vi.fn(async (
        _command: string,
        args: readonly string[],
      ): Promise<CommandResult> => {
        expect(args.at(-1)).toBe(inputPath);
        expect(statSync(inputPath).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(inputPath, 'utf8'))).toEqual(devRecord);
        return { stdout: '', stderr: '' };
      });

      await writeBuildProvenance(devRecord, {
        homeDir,
        execute,
        randomUUID: () => 'private-input',
        removePath: async (targetPath: string) => {
          removedPaths.push(targetPath);
          rmSync(targetPath, { recursive: true, force: true });
        },
      });

      expect(execute).toHaveBeenCalledTimes(1);
      expect(removedPaths).toEqual([inputPath]);
      expect(existsSync(inputPath)).toBe(false);
    });

    it('reports an explicit bounded lockf timeout and cleans the private input', async () => {
      const homeDir = createScratchDirectory('provenance-lockf-timeout');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const inputPath = join(stateDir, '.builds.json.input-timeout-input.json');
      const timeoutError = Object.assign(new Error('lockf failed'), {
        exitCode: 75,
        stderr: 'lockf: builds.json.lock: already locked',
      });
      const execute = vi.fn(async () => {
        throw timeoutError;
      });

      await expect(
        writeBuildProvenance(devRecord, {
          homeDir,
          execute,
          lockTimeoutSeconds: 2,
          randomUUID: () => 'timeout-input',
        }),
      ).rejects.toThrow(/Timed out after 2 seconds.*build provenance lock.*already locked/is);
      expect(existsSync(inputPath)).toBe(false);
    });

    it.each([-1, 61, 1.5, Number.POSITIVE_INFINITY])(
      'rejects an unbounded lock timeout of %s before creating state',
      async (lockTimeoutSeconds) => {
        const homeDir = createScratchDirectory('provenance-invalid-timeout');
        const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');

        await expect(
          writeBuildProvenance(devRecord, { homeDir, lockTimeoutSeconds }),
        ).rejects.toThrow(/lockTimeoutSeconds.*integer between 0 and 60/i);
        expect(existsSync(stateDir)).toBe(false);
      },
    );

    it('propagates helper diagnostics and leaves malformed existing state unchanged', async () => {
      const homeDir = createScratchDirectory('provenance-helper-failure');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const statePath = join(stateDir, 'builds.json');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath, '{"version":2,"channels":{}}\n', 'utf8');
      const before = readFileSync(statePath, 'utf8');

      const error = await writeBuildProvenance(devRecord, { homeDir }).then(
        () => undefined,
        (failure) => failure as Error & { stderr?: string },
      );

      expect(error?.message).toContain('write-build-provenance.mjs');
      expect(error?.message).toContain('Invalid build provenance file');
      expect(error?.stderr).toContain('Invalid build provenance file');
      expect(readFileSync(statePath, 'utf8')).toBe(before);
      expect(readdirSync(stateDir).sort()).toEqual(['builds.json', 'builds.json.lock']);
    });

    it('preserves primary helper and private-input cleanup failures together', async () => {
      const homeDir = createScratchDirectory('provenance-primary-cleanup-failure');
      const execute = vi.fn(async () => {
        throw Object.assign(new Error('helper failed'), {
          exitCode: 1,
          stderr: 'helper diagnostic',
        });
      });
      const removePath = vi.fn(async () => {
        throw new Error('input cleanup failed');
      });

      const error = await writeBuildProvenance(devRecord, {
        homeDir,
        execute,
        removePath,
        randomUUID: () => 'aggregate-input',
      }).then(
        () => undefined,
        (failure) => failure as Error,
      );

      expect(error).toBeInstanceOf(AggregateError);
      expect(error?.message).toContain('helper failed');
      expect(error?.message).toContain('helper diagnostic');
      expect(error?.message).toContain('Failed to clean private build provenance input file');
      expect(error?.message).toContain('input cleanup failed');
      expect((error as AggregateError).errors).toHaveLength(2);
      expect(removePath).toHaveBeenCalledTimes(1);
    });

    it('preserves stable and dev provenance independently with strict existing-state validation', async () => {
      const homeDir = createScratchDirectory('provenance-preservation');
      const statePath = await writeBuildProvenance(stableRecord, { homeDir });
      const secondPath = await writeBuildProvenance(devRecord, { homeDir });

      expect(secondPath).toBe(statePath);
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          stable: stableRecord,
          dev: devRecord,
        },
      });
      expect(readdirSync(join(statePath, '..')).sort()).toEqual([
        'builds.json',
        'builds.json.lock',
      ]);
    });

    it.each([
      {
        name: 'unknown top-level field',
        state: { version: 1, channels: { stable: stableRecord }, futureField: true },
        errorPattern: /unknown top-level field "futureField"/i,
      },
      {
        name: 'unknown channel',
        state: { version: 1, channels: { preview: devRecord } },
        errorPattern: /unknown channel "preview"/i,
      },
      {
        name: 'stable record missing requestedRef',
        state: {
          version: 1,
          channels: {
            stable: (({ requestedRef: _requestedRef, ...record }) => record)(stableRecord),
          },
        },
        errorPattern: /stable.*requestedRef.*nonblank/i,
      },
      {
        name: 'dev record with requestedRef',
        state: {
          version: 1,
          channels: { dev: { ...devRecord, requestedRef: 'HEAD' } },
        },
        errorPattern: /dev.*requestedRef.*forbidden/i,
      },
      {
        name: 'record with unknown field',
        state: {
          version: 1,
          channels: { dev: { ...devRecord, futureField: true } },
        },
        errorPattern: /dev.*unknown field "futureField"/i,
      },
    ])('rejects existing state with an exact-key violation: $name', async ({ state, errorPattern }) => {
      const homeDir = createScratchDirectory('provenance-existing-validation');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const statePath = join(stateDir, 'builds.json');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      const before = readFileSync(statePath, 'utf8');

      await expect(writeBuildProvenance(devRecord, { homeDir })).rejects.toThrow(errorPattern);
      expect(readFileSync(statePath, 'utf8')).toBe(before);
    });

    it('preserves stable and dev records across concurrent processes', async () => {
      const homeDir = createScratchDirectory('provenance-cross-process');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const statePath = join(stateDir, 'builds.json');
      const startPath = join(homeDir, 'start');
      const stableReadyPath = join(homeDir, 'stable-ready');
      const devReadyPath = join(homeDir, 'dev-ready');

      const stableWrite = spawnProvenanceWriter(
        stableRecord,
        homeDir,
        stableReadyPath,
        startPath,
      );
      const devWrite = spawnProvenanceWriter(
        devRecord,
        homeDir,
        devReadyPath,
        startPath,
      );
      await waitForPaths([stableReadyPath, devReadyPath]);
      writeFileSync(startPath, 'start', 'utf8');
      await Promise.all([stableWrite, devWrite]);

      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
        version: 1,
        channels: {
          stable: stableRecord,
          dev: devRecord,
        },
      });
      expect(readdirSync(stateDir).sort()).toEqual(['builds.json', 'builds.json.lock']);
    }, 15_000);

    it('releases the kernel lock after a child crash so an immediate writer succeeds', async () => {
      const homeDir = createScratchDirectory('provenance-child-crash');
      const stateDir = join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
      const statePath = join(stateDir, 'builds.json');
      const lockPath = `${statePath}.lock`;
      const readyPath = join(homeDir, 'crash-ready');
      const startPath = join(homeDir, 'crash-start');
      mkdirSync(stateDir, { recursive: true });
      const crashScript = `
        import { existsSync } from 'node:fs';
        import { writeFile } from 'node:fs/promises';
        import { setTimeout as sleep } from 'node:timers/promises';
        const [readyPath, startPath] = process.argv.slice(1);
        await writeFile(readyPath, 'ready');
        while (!existsSync(startPath)) await sleep(1);
        process.kill(process.pid, 'SIGKILL');
      `;
      const crashingLock = spawnLockfProcess(lockPath, crashScript, [readyPath, startPath]);
      await waitForPaths([readyPath]);
      writeFileSync(startPath, 'crash', 'utf8');
      const crashResult = await crashingLock;

      expect(crashResult.code).not.toBe(0);
      await expect(writeBuildProvenance(devRecord, { homeDir })).resolves.toBe(statePath);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).channels.dev).toEqual(devRecord);
      expect(existsSync(lockPath)).toBe(true);
    }, 15_000);
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

    function createCommittedSource(label: string): string {
      const sourceRoot = createScratchDirectory(label);
      runGit(sourceRoot, ['init', '--quiet']);
      runGit(sourceRoot, ['config', 'user.name', 'Psyche Build Tests']);
      runGit(sourceRoot, ['config', 'user.email', 'tests@example.invalid']);
      runGit(sourceRoot, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(sourceRoot, 'tracked.txt'), 'committed source\n', 'utf8');
      runGit(sourceRoot, ['add', 'tracked.txt']);
      runGit(sourceRoot, ['commit', '--quiet', '-m', 'initial source']);
      return sourceRoot;
    }

    async function runDevBuildWithSourceMutation(
      label: string,
      prepare: (sourceRoot: string) => void,
      mutateDuringBuild: (sourceRoot: string) => void,
    ) {
      const sourceRoot = createCommittedSource(label);
      const tempRoot = createScratchDirectory(`${label}-temp`);
      const snapshotPath = join(tempRoot, 'snapshot', 'Psyche Build Dev.app');
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');
      prepare(sourceRoot);
      const publish = vi.fn(async () => installedPath);

      const completion = runMacosBuild(
        { channel: 'dev', repositoryRoot: sourceRoot },
        {
          execute: runCommand,
          makeTemporaryDirectory: async () => tempRoot,
          removePath: async (targetPath) => {
            rmSync(targetPath, { recursive: true, force: true });
          },
          writeDevTauriConfig: async () => join(tempRoot, 'dev.json'),
          buildDevAppSnapshot: async () => {
            mutateDuringBuild(sourceRoot);
            return { snapshotPath, identity: devIdentity };
          },
          publishBuildChannel: publish,
          now: () => new Date(builtAt),
          homeDir: virtualHome,
        },
      );

      return { completion, publish, tempRoot };
    }

    it('runs the exact stable workflow in an isolated source child and records provenance', async () => {
      const tempRoot = '/workspace/.build-temp/stable-1';
      const sourceRoot = join(tempRoot, 'source');
      const bundleDir = join(
        sourceRoot,
        'native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos',
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
      const publish = vi.fn(
        async (
          publishedCandidate: string,
          requestedConfig: ReturnType<typeof channelConfig>,
          record: BuildProvenance,
          overrides?: { homeDir?: string },
        ) => {
          expect(publishedCandidate).toBe(candidate);
          expect(requestedConfig).toEqual(channelConfig('stable'));
          expect(record.installedPath).toBe(installedPath);
          expect(overrides).toEqual({ homeDir: virtualHome });
          return installedPath;
        },
      );
      const dependencies = {
        execute,
        makeTemporaryDirectory: vi.fn(async () => tempRoot),
        removePath,
        findCandidateApp: vi.fn(async () => candidate),
        readBundleIdentity: readIdentity,
        smokeLaunchBundle: smokeLaunch,
        publishBuildChannel: publish,
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
      expect(readIdentity.mock.calls.map(([appPath]) => appPath)).toEqual([candidate]);
      expect(smokeLaunch).toHaveBeenCalledWith(candidate, {
        executableName: stableIdentity.executable,
      });
      expect(removePath).toHaveBeenLastCalledWith(tempRoot);
      expect(publish).toHaveBeenCalledWith(
        candidate,
        channelConfig('stable'),
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
      const publish = vi.fn(async (): Promise<string> => {
        throw new Error('publication should not run');
      });
      const execute = vi.fn(
        async (
          command: string,
          args: readonly string[],
          _options: CommandOptions = {},
        ): Promise<CommandResult> => {
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
            publishBuildChannel: publish,
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
      expect(publish).not.toHaveBeenCalled();
    });

    it('builds dev from the current checkout with a temporary config and no stable-only gates', async () => {
      const tempRoot = '/workspace/.build-temp/dev-1';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const bundleDir = join(
        virtualRepository,
        'native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos',
      );
      const candidate = join(bundleDir, 'Psyche Build Dev.app');
      const snapshot = join(tempRoot, 'dev-snapshot', 'Psyche Build Dev.app');
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');
      const execute = vi.fn(
        async (
          command: string,
          args: readonly string[],
          _options: CommandOptions = {},
        ): Promise<CommandResult> => {
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
      const publish = vi.fn(async () => installedPath);
      const dependencies = {
        execute,
        makeTemporaryDirectory: vi.fn(async () => tempRoot),
        removePath: vi.fn(async () => {}),
        writeDevTauriConfig: vi.fn(async () => configPath),
        buildDevAppSnapshot: vi.fn(async () => ({
          snapshotPath: snapshot,
          identity: devIdentity,
        })),
        smokeLaunchBundle: smokeLaunch,
        publishBuildChannel: publish,
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
      const sourceStatusCalls = execute.mock.calls.filter(
        ([command, args]) => command === 'git' && args[0] === 'status',
      );
      expect(sourceStatusCalls).toHaveLength(2);
      for (const [, args, options] of sourceStatusCalls) {
        expect(args).toEqual(expect.arrayContaining([
          '--porcelain=v2',
          '--untracked-files=all',
          ':(top,glob,exclude)**/target/**',
          ':(top,glob,exclude)**/node_modules/**',
          ':(top,glob,exclude)native/desktop/psyche-build-tauri/web/*.bundle.js',
        ]));
        expect(options).toEqual({
          cwd: virtualRepository,
          stage: 'capture dev source status',
        });
      }
      expect(
        execute.mock.calls.filter(
          ([command, args]) => command === 'git' && args.includes('rev-parse'),
        ),
      ).toHaveLength(2);
      expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('worktree');
      expect(execute.mock.calls.flatMap(([, args]) => args)).not.toContain('test');
      expect(smokeLaunch).not.toHaveBeenCalled();
      expect(dependencies.removePath).toHaveBeenLastCalledWith(tempRoot);
      expect(dependencies.buildDevAppSnapshot).toHaveBeenCalledWith(
        {
          sourceRoot: virtualRepository,
          tempRoot,
          devConfigPath: configPath,
        },
        { execute },
      );
      expect(publish).toHaveBeenCalledWith(
        snapshot,
        channelConfig('dev'),
        {
          channel: 'dev',
          commitSha: devSha,
          dirty: true,
          builtAt,
          installedPath,
          productName: 'Psyche Build Dev',
          bundleIdentifier: 'dev.opencoven.psyche.dev',
        },
        { homeDir: virtualHome },
      );
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

    it('uses the locked dev snapshot builder by default and publishes only its snapshot', async () => {
      const sourceRoot = createScratchDirectory('run-dev-default-source');
      const tempRoot = createScratchDirectory('run-dev-default-temp');
      const configPath = join(tempRoot, 'tauri.dev.json');
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');
      const identity: BundleIdentity = {
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-dev',
      };
      let snapshotPath = '';
      const execute = vi.fn(
        async (
          command: string,
          args: readonly string[],
        ): Promise<CommandResult> => {
          if (command === 'git' && args.includes('rev-parse')) {
            return { stdout: `${devSha}\n`, stderr: '' };
          }
          if (command === 'git' && args[0] === 'status') {
            return { stdout: '', stderr: '' };
          }
          if (command === '/usr/bin/lockf') {
            const inputPath = String(args.at(-1));
            const input = JSON.parse(readFileSync(inputPath, 'utf8')) as {
              snapshotPath: string;
            };
            snapshotPath = input.snapshotPath;
            mkdirSync(join(snapshotPath, 'Contents'), { recursive: true });
            writeFileSync(join(snapshotPath, 'Contents', 'marker.txt'), 'snapshot', 'utf8');
            return {
              stdout: `${JSON.stringify({ snapshotPath, identity })}\n`,
              stderr: '',
            };
          }
          if (command === 'git') {
            return { stdout: '', stderr: '' };
          }
          throw new Error(`Unexpected direct dev command: ${command} ${args.join(' ')}`);
        },
      );
      const publish = vi.fn(async (publishedCandidate: string) => {
        expect(readAppMarker(publishedCandidate)).toBe('snapshot');
        return installedPath;
      });

      const result = await runMacosBuild(
        { channel: 'dev', repositoryRoot: sourceRoot },
        {
          execute,
          makeTemporaryDirectory: async () => tempRoot,
          removePath: async (targetPath) => {
            rmSync(targetPath, { recursive: true, force: true });
          },
          writeDevTauriConfig: async () => configPath,
          publishBuildChannel: publish,
          now: () => new Date(builtAt),
          homeDir: virtualHome,
        },
      );

      expect(snapshotPath).toContain(`${tempRoot}/.dev-build.snapshot-`);
      expect(publish).toHaveBeenCalledWith(
        snapshotPath,
        channelConfig('dev'),
        {
          channel: 'dev',
          commitSha: devSha,
          dirty: false,
          builtAt,
          installedPath,
          productName: 'Psyche Build Dev',
          bundleIdentifier: 'dev.opencoven.psyche.dev',
        },
        { homeDir: virtualHome },
      );
      expect(execute.mock.calls.some(([command]) => command === 'pnpm')).toBe(false);
      expect(result.installedPath).toBe(installedPath);
      expect(existsSync(tempRoot)).toBe(false);
    });

    it('rejects a dev snapshot when clean source advances to a new commit', async () => {
      const { completion, publish, tempRoot } = await runDevBuildWithSourceMutation(
        'dev-source-new-commit',
        () => {},
        (sourceRoot) => {
          writeFileSync(join(sourceRoot, 'tracked.txt'), 'new committed source\n', 'utf8');
          runGit(sourceRoot, ['add', 'tracked.txt']);
          runGit(sourceRoot, ['commit', '--quiet', '-m', 'source changed during build']);
        },
      );

      await expect(completion).rejects.toThrow(/dev source changed.*build|build.*dev source changed/i);
      expect(publish).not.toHaveBeenCalled();
      expect(existsSync(tempRoot)).toBe(false);
    });

    it('rejects changed dirty content even when status and paths stay the same', async () => {
      const { completion, publish, tempRoot } = await runDevBuildWithSourceMutation(
        'dev-source-dirty-content',
        (sourceRoot) => {
          writeFileSync(join(sourceRoot, 'tracked.txt'), 'dirty version one\n', 'utf8');
        },
        (sourceRoot) => {
          writeFileSync(join(sourceRoot, 'tracked.txt'), 'dirty version two\n', 'utf8');
        },
      );

      await expect(completion).rejects.toThrow(/dev source changed.*build|build.*dev source changed/i);
      expect(publish).not.toHaveBeenCalled();
      expect(existsSync(tempRoot)).toBe(false);
    });

    it('rejects changed untracked content even when its status and path stay the same', async () => {
      const { completion, publish, tempRoot } = await runDevBuildWithSourceMutation(
        'dev-source-untracked-content',
        (sourceRoot) => {
          writeFileSync(join(sourceRoot, 'draft.txt'), 'untracked version one\n', 'utf8');
        },
        (sourceRoot) => {
          writeFileSync(join(sourceRoot, 'draft.txt'), 'untracked version two\n', 'utf8');
        },
      );

      await expect(completion).rejects.toThrow(/dev source changed.*build|build.*dev source changed/i);
      expect(publish).not.toHaveBeenCalled();
      expect(existsSync(tempRoot)).toBe(false);
    });

    it('rejects changed source metadata even when content and status stay the same', async () => {
      const firstTimestamp = new Date('2026-08-10T18:00:00.000Z');
      const secondTimestamp = new Date('2026-08-10T18:00:05.000Z');
      const { completion, publish, tempRoot } = await runDevBuildWithSourceMutation(
        'dev-source-metadata',
        (sourceRoot) => {
          const trackedPath = join(sourceRoot, 'tracked.txt');
          writeFileSync(trackedPath, 'dirty content\n', 'utf8');
          utimesSync(trackedPath, firstTimestamp, firstTimestamp);
        },
        (sourceRoot) => {
          const trackedPath = join(sourceRoot, 'tracked.txt');
          utimesSync(trackedPath, secondTimestamp, secondTimestamp);
        },
      );

      await expect(completion).rejects.toThrow(/dev source changed.*build|build.*dev source changed/i);
      expect(publish).not.toHaveBeenCalled();
      expect(existsSync(tempRoot)).toBe(false);
    });

    it('allows build:web to change tracked generated bundles without rejecting publication', async () => {
      const generatedBundle =
        'native/desktop/psyche-build-tauri/web/editor.bundle.js';
      const sourceRoot = createCommittedSource('dev-source-generated-output');
      mkdirSync(join(sourceRoot, 'native/desktop/psyche-build-tauri/web'), {
        recursive: true,
      });
      writeFileSync(join(sourceRoot, generatedBundle), 'generated version one\n', 'utf8');
      runGit(sourceRoot, ['add', generatedBundle]);
      runGit(sourceRoot, ['commit', '--quiet', '-m', 'add generated bundle']);
      const tempRoot = createScratchDirectory('dev-source-generated-output-temp');
      const snapshotPath = join(tempRoot, 'snapshot', 'Psyche Build Dev.app');
      const installedPath = join(virtualHome, 'Applications', 'Psyche Build Dev.app');
      const publish = vi.fn(async () => installedPath);

      await expect(
        runMacosBuild(
          { channel: 'dev', repositoryRoot: sourceRoot },
          {
            execute: runCommand,
            makeTemporaryDirectory: async () => tempRoot,
            removePath: async (targetPath) => {
              rmSync(targetPath, { recursive: true, force: true });
            },
            writeDevTauriConfig: async () => join(tempRoot, 'dev.json'),
            buildDevAppSnapshot: async () => {
              writeFileSync(
                join(sourceRoot, generatedBundle),
                'generated version two\n',
                'utf8',
              );
              return { snapshotPath, identity: devIdentity };
            },
            publishBuildChannel: publish,
            now: () => new Date(builtAt),
            homeDir: virtualHome,
          },
        ),
      ).resolves.toMatchObject({
        channel: 'dev',
        dirty: false,
      });

      expect(publish).toHaveBeenCalledOnce();
      expect(existsSync(tempRoot)).toBe(false);
    });

    it('does not install or record provenance when a dev build command fails and cleans the config root', async () => {
      const tempRoot = '/workspace/.build-temp/dev-build-failure';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const removePath = vi.fn(async () => {});
      const publish = vi.fn(async () => '/should-not-publish');

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
            buildDevAppSnapshot: async () => {
              throw new Error('dev build failed');
            },
            publishBuildChannel: publish,
          },
        ),
      ).rejects.toThrow('dev build failed');

      expect(publish).not.toHaveBeenCalled();
      expect(removePath).toHaveBeenLastCalledWith(tempRoot);
    });

    it('does not install or record provenance when dev bundle identity fails and cleans the config root', async () => {
      const tempRoot = '/workspace/.build-temp/dev-identity-failure';
      const configPath = join(tempRoot, 'tauri.dev.json');
      const candidate = join(
        virtualRepository,
        'native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos',
        'Psyche Build Dev.app',
      );
      const removePath = vi.fn(async () => {});
      const publish = vi.fn(async () => '/should-not-publish');

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
            buildDevAppSnapshot: async () => {
              throw new Error(
                `Bundle identity mismatch for "${candidate}": wrong stable identity`,
              );
            },
            publishBuildChannel: publish,
          },
        ),
      ).rejects.toThrow(/Bundle identity mismatch/);

      expect(publish).not.toHaveBeenCalled();
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
            buildDevAppSnapshot: async () => ({
              snapshotPath: candidate,
              identity: devIdentity,
            }),
            publishBuildChannel: async () => {
              installed = true;
              throw new Error(
                `App installed at "${installedPath}", but build provenance publication failed: ` +
                  'provenance write failed',
              );
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
            publishBuildChannel: async () => installedPath,
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
      expect(runBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'stable',
          ref: 'release/v1.2.3',
          repositoryRoot,
          signal: expect.any(AbortSignal),
        }),
      );
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

    it.each([
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const)(
      'aborts a long stable child on %s, waits for cleanup, and returns %i',
      async (signalName, expectedExitCode) => {
        const signalTarget = new EventEmitter();
        const tempRoot = `/workspace/.build-temp/stable-${signalName.toLowerCase()}`;
        const sourceRoot = join(tempRoot, 'source');
        const expectedCandidate = join(
          sourceRoot,
          'native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos',
          'Psyche Build.app',
        );
        const stdout: string[] = [];
        const stderr: string[] = [];
        const events: string[] = [];
        const publish = vi.fn(async () => '/should-not-install');
        let markChildStarted = () => {};
        const childStarted = new Promise<void>((resolveStarted) => {
          markChildStarted = resolveStarted;
        });
        let abortCount = 0;

        const execute = vi.fn(
          async (
            command: string,
            args: readonly string[],
            options: CommandOptions = {},
          ): Promise<CommandResult> => {
            if (command === 'git' && args.includes('rev-parse')) {
              return { stdout: `${'c'.repeat(40)}\n`, stderr: '' };
            }
            if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
              events.push('worktree-add');
              return { stdout: '', stderr: '' };
            }
            if (command === 'pnpm' && args[0] === 'install') {
              events.push('stable-child-started');
              markChildStarted();
              if (!options.signal) {
                throw new Error('stable child did not receive an AbortSignal');
              }
              await new Promise<never>((_resolve, reject) => {
                options.signal?.addEventListener(
                  'abort',
                  () => {
                    abortCount += 1;
                    events.push('stable-child-aborted');
                    reject(
                      new Error(
                        `Stage: long stable child\nCommand: pnpm install\n` +
                          `cause: aborted by ${signalName}`,
                      ),
                    );
                  },
                  { once: true },
                );
              });
            }
            if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
              events.push(`worktree-remove:${args.join(' ')}`);
              expect(options.signal).toBeUndefined();
              return { stdout: '', stderr: '' };
            }
            return { stdout: '', stderr: '' };
          },
        );
        const removePath = vi.fn(async (targetPath: string) => {
          events.push(`remove:${targetPath}`);
        });
        const runBuild = vi.fn(async (options: Parameters<typeof runMacosBuild>[0]) =>
          runMacosBuild(options, {
            execute,
            makeTemporaryDirectory: async () => tempRoot,
            removePath,
            publishBuildChannel: publish,
          }),
        );

        const completion = runCli(['stable', 'release/v1'], {
          runBuild,
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
          signalTarget,
        } as RunCliDependencies);

        await childStarted;
        signalTarget.emit(signalName, signalName);
        signalTarget.emit(signalName, signalName);

        await expect(completion).resolves.toBe(expectedExitCode);
        expect(abortCount).toBe(1);
        expect(events).toContain('stable-child-aborted');
        expect(events).toContain(
          `worktree-remove:worktree remove --force ${sourceRoot}`,
        );
        expect(events.indexOf('stable-child-aborted')).toBeLessThan(
          events.indexOf(`worktree-remove:worktree remove --force ${sourceRoot}`),
        );
        expect(
          removePath.mock.calls.filter(([targetPath]) => targetPath === tempRoot),
        ).toHaveLength(1);
        expect(publish).not.toHaveBeenCalled();
        expect(stdout).toEqual([]);
        expect(stderr.join('\n')).toContain('long stable child');
        expect(stderr.join('\n')).toContain(`aborted by ${signalName}`);
        expect(signalTarget.listenerCount('SIGINT')).toBe(0);
        expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
      },
    );

    it('removes cancellation listeners after normal completion', async () => {
      const signalTarget = new EventEmitter();
      let receivedSignal: AbortSignal | undefined;
      const runBuild = vi.fn(async (options: Parameters<typeof runMacosBuild>[0]) => {
        receivedSignal = options.signal;
        return {
          channel: 'dev' as const,
          commitSha: 'd'.repeat(40),
          dirty: false,
          builtAt: '2026-08-10T18:00:00.000Z',
          installedPath: '/Users/test/Applications/Psyche Build Dev.app',
          productName: 'Psyche Build Dev',
          bundleIdentifier: 'dev.opencoven.psyche.dev',
        };
      });

      await expect(
        runCli(['dev'], {
          runBuild,
          stdout: () => {},
          stderr: () => {},
          signalTarget,
        } as RunCliDependencies),
      ).resolves.toBe(0);

      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(signalTarget.listenerCount('SIGINT')).toBe(0);
      expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
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
