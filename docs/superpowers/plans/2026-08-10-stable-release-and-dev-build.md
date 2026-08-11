# Stable and Development macOS Build Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated local macOS build channels so a pinned, fully verified `Psyche Build.app` and a fast experimental `Psyche Build Dev.app` can coexist under `~/Applications`.

**Architecture:** A Node ESM orchestrator builds stable source in a temporary detached Git worktree and builds dev source from the current checkout with a generated full Tauri config that changes only channel identity. Shared bundle validation, startup smoke, transactional installation, and atomic provenance helpers prevent either channel from replacing the other or overwriting a known-good app after failure.

**Tech Stack:** Node.js ESM, pnpm 10, Vitest, Tauri 2, Rust/Cargo, macOS `plutil` and `ditto`, Git worktrees

---

## File structure

- Create `scripts/build-macos-app.mjs`: command parsing, channel constants, Git source preparation, validation/build sequencing, bundle inspection, stable launch smoke, transactional installation, provenance, and CLI entrypoint.
- Create `scripts/build-macos-app.d.mts`: TypeScript declarations for every helper imported by tests.
- Create `__tests__/macosBuildChannels.test.ts`: focused contracts for parsing, channel isolation, build sequencing, smoke behavior, rollback, provenance, and cleanup.
- Modify `package.json`: expose `app:stable` and `app:dev`.
- Modify `CONTRIBUTING.md`: document the two local app workflows and their safety boundary.

Keep the orchestrator in one file because all helpers implement one bounded responsibility: producing and installing a local macOS app bundle. Use named exported helpers and dependency injection at process/filesystem boundaries so tests remain focused without running full Tauri builds.

### Task 1: Lock the channel identity and command contract

**Files:**
- Create: `__tests__/macosBuildChannels.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing package and Tauri identity tests**

Create `__tests__/macosBuildChannels.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('macOS build channel contract', () => {
  it('exposes explicit stable and dev app commands', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['app:stable']).toBe('node scripts/build-macos-app.mjs stable');
    expect(packageJson.scripts['app:dev']).toBe('node scripts/build-macos-app.mjs dev');
  });

  it('does not change the production Tauri identity', () => {
    const production = JSON.parse(
      readFileSync(
        path.resolve('native/macos/psyche-build-tauri/src-tauri/tauri.conf.json'),
        'utf8',
      ),
    );

    expect(production.productName).toBe('Psyche Build');
    expect(production.identifier).toBe('dev.opencoven.psyche');
    expect(production.app.windows[0].title).toBe('Psyche Build');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because the scripts do not exist.

- [ ] **Step 3: Add the root package commands**

Add these entries beside the existing Tauri scripts in `package.json`:

```json
"app:stable": "node scripts/build-macos-app.mjs stable",
"app:dev": "node scripts/build-macos-app.mjs dev",
```

- [ ] **Step 4: Run the focused test**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: the identity and command tests pass.

- [ ] **Step 5: Commit the channel contract**

```sh
git add package.json __tests__/macosBuildChannels.test.ts
git commit -m "test: define macOS build channels"
```

### Task 2: Add parsing, channel metadata, and build plans

**Files:**
- Create: `scripts/build-macos-app.mjs`
- Create: `scripts/build-macos-app.d.mts`
- Modify: `__tests__/macosBuildChannels.test.ts`

- [ ] **Step 1: Add failing parser and build-plan tests**

Append to `__tests__/macosBuildChannels.test.ts`:

```ts
import {
  buildCommandsFor,
  channelConfig,
  createDevTauriConfig,
  parseBuildArguments,
} from '../scripts/build-macos-app.mjs';

describe('macOS build planning', () => {
  it('requires exactly one ref for stable and none for dev', () => {
    expect(parseBuildArguments(['stable', '--', 'v0.0.1'])).toEqual({
      channel: 'stable',
      ref: 'v0.0.1',
    });
    expect(parseBuildArguments(['dev'])).toEqual({ channel: 'dev' });
    expect(() => parseBuildArguments(['stable'])).toThrow(/requires exactly one Git ref/);
    expect(() => parseBuildArguments(['stable', 'main', 'extra'])).toThrow(
      /requires exactly one Git ref/,
    );
    expect(() => parseBuildArguments(['dev', 'main'])).toThrow(/does not accept a Git ref/);
    expect(() => parseBuildArguments(['preview'])).toThrow(/stable or dev/);
  });

  it('defines non-overlapping channel identities and install paths', () => {
    expect(channelConfig('stable')).toMatchObject({
      productName: 'Psyche Build',
      bundleIdentifier: 'dev.opencoven.psyche',
      appName: 'Psyche Build.app',
    });
    expect(channelConfig('dev')).toMatchObject({
      productName: 'Psyche Build Dev',
      bundleIdentifier: 'dev.opencoven.psyche.dev',
      appName: 'Psyche Build Dev.app',
    });
  });

  it('uses the full verification gate only for stable builds', () => {
    const stable = buildCommandsFor('stable');
    const dev = buildCommandsFor('dev', {
      devConfigPath: '/tmp/psyche-dev-config/tauri.conf.json',
    });

    expect(stable).toEqual([
      ['pnpm', ['install', '--frozen-lockfile'], '.'],
      ['pnpm', ['test'], '.'],
      ['pnpm', ['typecheck'], '.'],
      ['pnpm', ['build'], '.'],
      ['pnpm', ['smoke:pack'], '.'],
      [
        'cargo',
        [
          'fmt',
          '--manifest-path',
          'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
          '--check',
        ],
        '.',
      ],
      [
        'cargo',
        [
          'test',
          '--manifest-path',
          'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
          '--locked',
        ],
        '.',
      ],
      [
        'cargo',
        [
          'check',
          '--manifest-path',
          'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
          '--locked',
        ],
        '.',
      ],
      ['pnpm', ['build:web'], 'native/macos/psyche-build-tauri'],
      [
        'pnpm',
        ['exec', 'tauri', 'build', '--bundles', 'app'],
        'native/macos/psyche-build-tauri',
      ],
    ]);
    expect(dev).toEqual([
      ['pnpm', ['build:web'], 'native/macos/psyche-build-tauri'],
      [
        'pnpm',
        [
          'exec',
          'tauri',
          'build',
          '--bundles',
          'app',
          '--config',
          '/tmp/psyche-dev-config/tauri.conf.json',
        ],
        'native/macos/psyche-build-tauri',
      ],
    ]);
  });

  it('generates a complete dev config without losing production window settings', () => {
    const production = {
      productName: 'Psyche Build',
      identifier: 'dev.opencoven.psyche',
      build: { frontendDist: '../web' },
      app: {
        windows: [
          {
            label: 'main',
            title: 'Psyche Build',
            width: 1280,
            height: 800,
            minWidth: 980,
            transparent: true,
          },
        ],
        security: { csp: "default-src 'self'" },
      },
      bundle: { targets: ['dmg', 'app'] },
    };

    const dev = createDevTauriConfig(production);

    expect(dev).toEqual({
      ...production,
      productName: 'Psyche Build Dev',
      identifier: 'dev.opencoven.psyche.dev',
      app: {
        ...production.app,
        windows: [
          {
            ...production.app.windows[0],
            title: 'Psyche Build Dev',
          },
        ],
      },
    });
    expect(production.app.windows[0].title).toBe('Psyche Build');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because `scripts/build-macos-app.mjs` does not exist.

- [ ] **Step 3: Implement channel constants, parsing, and command plans**

Create `scripts/build-macos-app.mjs` with this initial implementation:

```js
#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

const CHANNELS = {
  stable: {
    channel: 'stable',
    productName: 'Psyche Build',
    bundleIdentifier: 'dev.opencoven.psyche',
    appName: 'Psyche Build.app',
  },
  dev: {
    channel: 'dev',
    productName: 'Psyche Build Dev',
    bundleIdentifier: 'dev.opencoven.psyche.dev',
    appName: 'Psyche Build Dev.app',
  },
};

const STABLE_COMMANDS = [
  ['pnpm', ['install', '--frozen-lockfile'], '.'],
  ['pnpm', ['test'], '.'],
  ['pnpm', ['typecheck'], '.'],
  ['pnpm', ['build'], '.'],
  ['pnpm', ['smoke:pack'], '.'],
  [
    'cargo',
    [
      'fmt',
      '--manifest-path',
      'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
      '--check',
    ],
    '.',
  ],
  [
    'cargo',
    [
      'test',
      '--manifest-path',
      'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
      '--locked',
    ],
    '.',
  ],
  [
    'cargo',
    [
      'check',
      '--manifest-path',
      'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
      '--locked',
    ],
    '.',
  ],
  ['pnpm', ['build:web'], 'native/macos/psyche-build-tauri'],
  [
    'pnpm',
    ['exec', 'tauri', 'build', '--bundles', 'app'],
    'native/macos/psyche-build-tauri',
  ],
];

const DEV_COMMANDS = [
  ['pnpm', ['build:web'], 'native/macos/psyche-build-tauri'],
];

export function parseBuildArguments(argv) {
  const values = argv.filter((value) => value !== '--');
  const [channel, ...rest] = values;
  if (channel !== 'stable' && channel !== 'dev') {
    throw new Error('Build channel must be stable or dev');
  }
  if (channel === 'stable') {
    if (rest.length !== 1 || rest[0].trim() === '') {
      throw new Error('The stable channel requires exactly one Git ref');
    }
    return { channel, ref: rest[0] };
  }
  if (rest.length !== 0) {
    throw new Error('The dev channel does not accept a Git ref');
  }
  return { channel };
}

export function channelConfig(channel) {
  const config = CHANNELS[channel];
  if (!config) throw new Error(`Unknown build channel: ${channel}`);
  return { ...config };
}

export function createDevTauriConfig(productionConfig) {
  const config = structuredClone(productionConfig);
  const mainWindow = config?.app?.windows?.find((window) => window.label === 'main');
  if (!mainWindow) {
    throw new Error('Production Tauri config must contain the main window');
  }
  config.productName = 'Psyche Build Dev';
  config.identifier = 'dev.opencoven.psyche.dev';
  mainWindow.title = 'Psyche Build Dev';
  return config;
}

export function buildCommandsFor(channel, options = {}) {
  const commands = channel === 'stable' ? STABLE_COMMANDS : [...DEV_COMMANDS];
  if (channel === 'dev') {
    if (!options.devConfigPath) {
      throw new Error('The dev build requires a generated Tauri config path');
    }
    commands.push([
      'pnpm',
      [
        'exec',
        'tauri',
        'build',
        '--bundles',
        'app',
        '--config',
        options.devConfigPath,
      ],
      'native/macos/psyche-build-tauri',
    ]);
  }
  return commands.map(([command, args, cwd]) => [command, [...args], cwd]);
}

async function main() {
  const options = parseBuildArguments(process.argv.slice(2));
  console.log(JSON.stringify({ repositoryRoot: REPOSITORY_ROOT, ...options }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Add declarations for test type safety**

Create `scripts/build-macos-app.d.mts`:

```ts
export type BuildChannel = 'stable' | 'dev';

export interface ParsedBuildArguments {
  channel: BuildChannel;
  ref?: string;
}

export interface ChannelConfig {
  channel: BuildChannel;
  productName: string;
  bundleIdentifier: string;
  appName: string;
}

export type BuildCommand = [command: string, args: string[], cwd: string];

export function parseBuildArguments(argv: string[]): ParsedBuildArguments;
export function channelConfig(channel: BuildChannel): ChannelConfig;
export function createDevTauriConfig<T extends Record<string, unknown>>(productionConfig: T): T;
export function buildCommandsFor(
  channel: BuildChannel,
  options?: { devConfigPath?: string },
): BuildCommand[];
```

- [ ] **Step 5: Run focused tests and test-tree typecheck**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
pnpm typecheck:tests
```

Expected: both commands pass.

- [ ] **Step 6: Commit the build plan helpers**

```sh
git add scripts/build-macos-app.mjs scripts/build-macos-app.d.mts \
  __tests__/macosBuildChannels.test.ts
git commit -m "feat: plan stable and dev app builds"
```

### Task 3: Implement bundle discovery, identity validation, and startup smoke

**Files:**
- Modify: `scripts/build-macos-app.mjs`
- Modify: `scripts/build-macos-app.d.mts`
- Modify: `__tests__/macosBuildChannels.test.ts`

- [ ] **Step 1: Add failing artifact and identity tests**

Add imports for `mkdir`, `mkdtemp`, `rm`, and `writeFile` from
`node:fs/promises`, `tmpdir` from `node:os`, and these builder helpers:

```ts
import {
  assertBundleIdentity,
  findCandidateApp,
  smokeLaunchBundle,
} from '../scripts/build-macos-app.mjs';
```

Add:

```ts
describe('macOS app artifact validation', () => {
  it('finds exactly one expected app bundle', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-app-artifact-'));
    try {
      const bundleDir = path.join(root, 'bundle/macos');
      await mkdir(path.join(bundleDir, 'Psyche Build.app/Contents'), { recursive: true });

      await expect(findCandidateApp(bundleDir, 'Psyche Build.app')).resolves.toBe(
        path.join(bundleDir, 'Psyche Build.app'),
      );
      await mkdir(path.join(bundleDir, 'nested/Psyche Build.app'), { recursive: true });
      await expect(findCandidateApp(bundleDir, 'Psyche Build.app')).rejects.toThrow(
        /exactly one Psyche Build\.app/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a bundle with the other channel identity', () => {
    expect(() =>
      assertBundleIdentity(
        '/tmp/Psyche Build Dev.app',
        { name: 'Psyche Build', identifier: 'dev.opencoven.psyche' },
        channelConfig('dev'),
      ),
    ).toThrow(/expected Psyche Build Dev.*dev\.opencoven\.psyche\.dev/);
  });

  it('fails when the stable candidate exits during the smoke window', async () => {
    const events: string[] = [];
    const child = {
      exitCode: null,
      signalCode: null,
      kill: (signal: NodeJS.Signals) => {
        events.push(`kill:${signal}`);
        return true;
      },
      once: (event: string, listener: (code: number) => void) => {
        if (event === 'exit') queueMicrotask(() => listener(1));
        return child;
      },
      stdout: { on: () => child.stdout },
      stderr: { on: () => child.stderr },
    };

    await expect(
      smokeLaunchBundle('/tmp/Psyche Build.app', {
        executableName: 'psyche-build-tauri',
        smokeMilliseconds: 10,
        spawnProcess: () => child,
        sleep: async () => undefined,
        makeTemporaryHome: async () => '/tmp/psyche-smoke-home',
        removeTemporaryHome: async () => undefined,
      }),
    ).rejects.toThrow(/exited during startup smoke/);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because the artifact helpers do not exist.

- [ ] **Step 3: Implement artifact discovery and identity assertions**

Add imports in `scripts/build-macos-app.mjs`:

```js
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
```

Add:

```js
export async function findCandidateApp(bundleDir, expectedAppName) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === expectedAppName) matches.push(entryPath);
      else await visit(entryPath);
    }
  }
  await visit(bundleDir);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${expectedAppName} in ${bundleDir}; found ${matches.length}`,
    );
  }
  return matches[0];
}

export function assertBundleIdentity(appPath, identity, expected) {
  const actualName = path.basename(appPath, '.app');
  if (
    actualName !== expected.productName ||
    identity.name !== expected.productName ||
    identity.identifier !== expected.bundleIdentifier
  ) {
    throw new Error(
      `Bundle identity mismatch: expected ${expected.productName} ` +
        `(${expected.bundleIdentifier}), received ${identity.name} ` +
        `(${identity.identifier}) at ${appPath}`,
    );
  }
}
```

- [ ] **Step 4: Implement bounded stable startup smoke**

Add:

```js
function collectStream(stream, chunks) {
  stream?.on('data', (chunk) => chunks.push(String(chunk)));
}

export async function smokeLaunchBundle(appPath, overrides = {}) {
  const executableName = overrides.executableName;
  if (!executableName) throw new Error('Bundle executable name is required for startup smoke');
  const smokeMilliseconds = overrides.smokeMilliseconds ?? 5_000;
  const spawnProcess = overrides.spawnProcess ?? spawn;
  const sleep = overrides.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const makeTemporaryHome =
    overrides.makeTemporaryHome ??
    (() => mkdtemp(path.join(os.tmpdir(), 'psyche-app-smoke-')));
  const removeTemporaryHome =
    overrides.removeTemporaryHome ??
    ((directory) => rm(directory, { recursive: true, force: true }));
  const temporaryHome = await makeTemporaryHome();
  const stdout = [];
  const stderr = [];

  try {
    const executable = path.join(appPath, 'Contents/MacOS', executableName);
    const child = spawnProcess(executable, [], {
      env: {
        ...process.env,
        HOME: temporaryHome,
        TMPDIR: temporaryHome,
        XDG_CACHE_HOME: path.join(temporaryHome, '.cache'),
        XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
        XDG_DATA_HOME: path.join(temporaryHome, '.local/share'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    collectStream(child.stdout, stdout);
    collectStream(child.stderr, stderr);
    const exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const earlyExit = await Promise.race([
      exit,
      sleep(smokeMilliseconds).then(() => null),
    ]);
    if (earlyExit) {
      throw new Error(
        `Stable app exited during startup smoke: ${JSON.stringify(earlyExit)}\n` +
          `${stdout.join('')}${stderr.join('')}`,
      );
    }
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      exit.then(() => true),
      sleep(5_000).then(() => false),
    ]);
    if (!stopped) {
      child.kill('SIGKILL');
      await exit;
    }
  } finally {
    await removeTemporaryHome(temporaryHome);
  }
}
```

- [ ] **Step 5: Extend declarations**

Add to `scripts/build-macos-app.d.mts`:

```ts
export interface BundleIdentity {
  name: string;
  identifier: string;
  executable?: string;
}

export interface SmokeOverrides {
  executableName: string;
  smokeMilliseconds?: number;
  spawnProcess?: (...args: any[]) => any;
  sleep?: (milliseconds: number) => Promise<void>;
  makeTemporaryHome?: () => Promise<string>;
  removeTemporaryHome?: (directory: string) => Promise<void>;
}

export function findCandidateApp(bundleDir: string, expectedAppName: string): Promise<string>;
export function assertBundleIdentity(
  appPath: string,
  identity: BundleIdentity,
  expected: ChannelConfig,
): void;
export function smokeLaunchBundle(appPath: string, overrides: SmokeOverrides): Promise<void>;
```

- [ ] **Step 6: Add success and forced-stop tests**

Add:

```ts
function runningChild(
  onKill: (signal: NodeJS.Signals) => void,
  exitOnTerm: boolean,
) {
  let exitListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const child = {
    stdout: { on: () => child.stdout },
    stderr: { on: () => child.stderr },
    once: (event: string, listener: typeof exitListener) => {
      if (event === 'exit') exitListener = listener;
      return child;
    },
    kill: (signal: NodeJS.Signals) => {
      onKill(signal);
      if ((signal === 'SIGTERM' && exitOnTerm) || signal === 'SIGKILL') {
        exitListener?.(null, signal);
      }
      return true;
    },
  };
  return child;
}

it('terminates the stable smoke process cleanly after the smoke window', async () => {
  const signals: NodeJS.Signals[] = [];
  let cleaned = false;

  await smokeLaunchBundle('/tmp/Psyche Build.app', {
    executableName: 'psyche-build-tauri',
    smokeMilliseconds: 10,
    spawnProcess: () => runningChild((signal) => signals.push(signal), true),
    sleep: async () => undefined,
    makeTemporaryHome: async () => '/tmp/psyche-smoke-home',
    removeTemporaryHome: async () => {
      cleaned = true;
    },
  });

  expect(signals).toEqual(['SIGTERM']);
  expect(cleaned).toBe(true);
});

it('uses SIGKILL only when the smoke process ignores bounded shutdown', async () => {
  const signals: NodeJS.Signals[] = [];

  await smokeLaunchBundle('/tmp/Psyche Build.app', {
    executableName: 'psyche-build-tauri',
    smokeMilliseconds: 10,
    spawnProcess: () => runningChild((signal) => signals.push(signal), false),
    sleep: async () => undefined,
    makeTemporaryHome: async () => '/tmp/psyche-smoke-home',
    removeTemporaryHome: async () => undefined,
  });

  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});
```

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
pnpm typecheck:tests
```

Expected: both pass.

- [ ] **Step 8: Commit bundle validation and smoke**

```sh
git add scripts/build-macos-app.mjs scripts/build-macos-app.d.mts \
  __tests__/macosBuildChannels.test.ts
git commit -m "feat: verify local macOS app candidates"
```

### Task 4: Add transactional installation and atomic provenance

**Files:**
- Modify: `scripts/build-macos-app.mjs`
- Modify: `scripts/build-macos-app.d.mts`
- Modify: `__tests__/macosBuildChannels.test.ts`

- [ ] **Step 1: Write failing installation rollback tests**

Add imports for `cp`, `readFile`, and `rename` from `node:fs/promises`.
Add:

```ts
import {
  installBundleTransactional,
  writeBuildProvenance,
} from '../scripts/build-macos-app.mjs';

describe('macOS app installation', () => {
  it('replaces only the selected channel and preserves the other app', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'psyche-install-home-'));
    const candidate = path.join(home, 'candidate/Psyche Build Dev.app');
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, 'marker'), 'new dev');
    await mkdir(path.join(home, 'Applications/Psyche Build.app'), { recursive: true });
    await writeFile(path.join(home, 'Applications/Psyche Build.app/marker'), 'stable');

    await installBundleTransactional(candidate, channelConfig('dev'), {
      homeDir: home,
      copyBundle: async (source, destination) => {
        await cp(source, destination, { recursive: true });
      },
      validateInstalledBundle: async () => undefined,
    });

    await expect(
      readFile(path.join(home, 'Applications/Psyche Build Dev.app/marker'), 'utf8'),
    ).resolves.toBe('new dev');
    await expect(
      readFile(path.join(home, 'Applications/Psyche Build.app/marker'), 'utf8'),
    ).resolves.toBe('stable');
  });

  it('restores the previous app when the final rename fails', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'psyche-install-rollback-'));
    const installed = path.join(home, 'Applications/Psyche Build.app');
    const candidate = path.join(home, 'candidate/Psyche Build.app');
    await mkdir(installed, { recursive: true });
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(installed, 'marker'), 'known good');
    await writeFile(path.join(candidate, 'marker'), 'candidate');

    await expect(
      installBundleTransactional(candidate, channelConfig('stable'), {
        homeDir: home,
        copyBundle: async (source, destination) => {
          await cp(source, destination, { recursive: true });
        },
        validateInstalledBundle: async () => undefined,
        renamePath: async (source, destination) => {
          if (destination === installed && source.includes('.staging-')) {
            throw new Error('injected final rename failure');
          }
          await rename(source, destination);
        },
      }),
    ).rejects.toThrow(/injected final rename failure/);

    await expect(readFile(path.join(installed, 'marker'), 'utf8')).resolves.toBe(
      'known good',
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because install and provenance helpers do not exist.

- [ ] **Step 3: Implement transactional same-filesystem replacement**

Add imports for `cp`, `mkdir`, `readFile`, `rename`, `writeFile`, and
`randomUUID`. Implement:

```js
export async function installBundleTransactional(candidate, config, overrides = {}) {
  const homeDir = overrides.homeDir ?? os.homedir();
  const applicationsDir = path.join(homeDir, 'Applications');
  const finalPath = path.join(applicationsDir, config.appName);
  const token = randomUUID();
  const stagingPath = path.join(applicationsDir, `.${config.appName}.staging-${token}`);
  const backupPath = path.join(applicationsDir, `.${config.appName}.backup-${token}`);
  const copyBundle =
    overrides.copyBundle ??
    (async (source, destination) => {
      await runCommand('ditto', [source, destination], { cwd: applicationsDir });
    });
  const renamePath = overrides.renamePath ?? rename;
  const validateInstalledBundle = overrides.validateInstalledBundle;
  let backedUp = false;

  await mkdir(applicationsDir, { recursive: true });
  try {
    await copyBundle(candidate, stagingPath);
    await validateInstalledBundle(stagingPath);
    try {
      await renamePath(finalPath, backupPath);
      backedUp = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await renamePath(stagingPath, finalPath);
      await validateInstalledBundle(finalPath);
    } catch (error) {
      if (backedUp) await renamePath(backupPath, finalPath);
      throw error;
    }
    if (backedUp) await rm(backupPath, { recursive: true, force: true });
    return finalPath;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}
```

Define the shared `runCommand` in Task 5; until then, tests always inject
`copyBundle`.

- [ ] **Step 4: Implement atomic provenance updates**

Add:

```js
export async function writeBuildProvenance(record, overrides = {}) {
  const homeDir = overrides.homeDir ?? os.homedir();
  const stateDir = path.join(
    homeDir,
    'Library/Application Support/Psyche Build Builder',
  );
  const statePath = path.join(stateDir, 'builds.json');
  const temporaryPath = `${statePath}.tmp-${randomUUID()}`;
  await mkdir(stateDir, { recursive: true });
  let state = { version: 1, channels: {} };
  try {
    const current = JSON.parse(await readFile(statePath, 'utf8'));
    if (
      current?.version !== 1 ||
      typeof current.channels !== 'object' ||
      current.channels === null
    ) {
      throw new Error(`Invalid build provenance file: ${statePath}`);
    }
    state = current;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  state.channels[record.channel] = record;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, statePath);
  return statePath;
}
```

- [ ] **Step 5: Add provenance tests**

```ts
it('keeps stable and dev provenance records together', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'psyche-provenance-'));
  try {
    const stable = {
      channel: 'stable' as const,
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      requestedRef: 'v0.0.1',
      dirty: false,
      builtAt: '2026-08-10T15:00:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build.app',
      productName: 'Psyche Build',
      bundleIdentifier: 'dev.opencoven.psyche',
    };
    const dev = {
      channel: 'dev' as const,
      commitSha: '89abcdef0123456789abcdef0123456789abcdef',
      dirty: true,
      builtAt: '2026-08-10T15:05:00.000Z',
      installedPath: '/Users/test/Applications/Psyche Build Dev.app',
      productName: 'Psyche Build Dev',
      bundleIdentifier: 'dev.opencoven.psyche.dev',
    };

    const statePath = await writeBuildProvenance(stable, { homeDir: home });
    await writeBuildProvenance(dev, { homeDir: home });
    const state = JSON.parse(await readFile(statePath, 'utf8'));

    expect(state).toEqual({
      version: 1,
      channels: { stable, dev },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('rejects malformed provenance without replacing it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'psyche-provenance-invalid-'));
  const stateDir = path.join(
    home,
    'Library/Application Support/Psyche Build Builder',
  );
  const statePath = path.join(stateDir, 'builds.json');
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(statePath, '{"version":2}\n');
    await expect(
      writeBuildProvenance(
        {
          channel: 'dev',
          commitSha: '89abcdef0123456789abcdef0123456789abcdef',
          dirty: true,
          builtAt: '2026-08-10T15:05:00.000Z',
          installedPath: '/Users/test/Applications/Psyche Build Dev.app',
          productName: 'Psyche Build Dev',
          bundleIdentifier: 'dev.opencoven.psyche.dev',
        },
        { homeDir: home },
      ),
    ).rejects.toThrow(/Invalid build provenance file/);
    await expect(readFile(statePath, 'utf8')).resolves.toBe('{"version":2}\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Extend declarations**

Add:

```ts
export interface InstallOverrides {
  homeDir?: string;
  copyBundle?: (source: string, destination: string) => Promise<void>;
  renamePath?: (source: string, destination: string) => Promise<void>;
  validateInstalledBundle: (appPath: string) => Promise<void>;
}

export interface BuildProvenance {
  channel: BuildChannel;
  commitSha: string;
  requestedRef?: string;
  dirty: boolean;
  builtAt: string;
  installedPath: string;
  productName: string;
  bundleIdentifier: string;
}

export function installBundleTransactional(
  candidate: string,
  config: ChannelConfig,
  overrides: InstallOverrides,
): Promise<string>;
export function writeBuildProvenance(
  record: BuildProvenance,
  overrides?: { homeDir?: string },
): Promise<string>;
```

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
pnpm typecheck:tests
```

Expected: both pass.

- [ ] **Step 8: Commit installation safety**

```sh
git add scripts/build-macos-app.mjs scripts/build-macos-app.d.mts \
  __tests__/macosBuildChannels.test.ts
git commit -m "feat: install macOS build channels safely"
```

### Task 5: Wire stable worktree isolation and dev orchestration

**Files:**
- Modify: `scripts/build-macos-app.mjs`
- Modify: `scripts/build-macos-app.d.mts`
- Modify: `__tests__/macosBuildChannels.test.ts`

- [ ] **Step 1: Add failing orchestration and cleanup tests**

Add tests for `resolveCommit`, `sourceIsDirty`, and `runMacosBuild`:

```ts
import {
  resolveCommit,
  runMacosBuild,
  sourceIsDirty,
} from '../scripts/build-macos-app.mjs';

it('resolves a stable ref as a commit without shell interpolation', async () => {
  const calls: Array<[string, string[]]> = [];
  const sha = await resolveCommit('/repo', 'feature/ref with spaces', async (command, args) => {
    calls.push([command, args]);
    return { stdout: '0123456789abcdef0123456789abcdef01234567\n', stderr: '' };
  });

  expect(sha).toBe('0123456789abcdef0123456789abcdef01234567');
  expect(calls).toEqual([
    ['git', ['rev-parse', '--verify', 'feature/ref with spaces^{commit}']],
  ]);
});

it('marks dev provenance dirty from porcelain output', async () => {
  await expect(
    sourceIsDirty('/repo', async () => ({ stdout: ' M web/main.js\n', stderr: '' })),
  ).resolves.toBe(true);
  await expect(
    sourceIsDirty('/repo', async () => ({ stdout: '', stderr: '' })),
  ).resolves.toBe(false);
});

it('force-removes only the temporary stable worktree after a failed gate', async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const temporaryRoot = '/tmp/psyche-stable-build-123';
  await expect(
    runMacosBuild(
      { channel: 'stable', ref: 'v0.0.1', repositoryRoot: '/repo' },
      {
        makeTemporaryRoot: async () => temporaryRoot,
        removeTemporaryRoot: async () => undefined,
        runCommand: async (command, args, options) => {
          calls.push({ command, args, cwd: options.cwd });
          if (command === 'git' && args[0] === 'rev-parse') {
            return {
              stdout: '0123456789abcdef0123456789abcdef01234567\n',
              stderr: '',
            };
          }
          if (command === 'pnpm' && args[0] === 'test') {
            throw new Error('test gate failed');
          }
          return { stdout: '', stderr: '' };
        },
      },
    ),
  ).rejects.toThrow(/test gate failed/);

  expect(calls).toContainEqual({
    command: 'git',
    args: ['worktree', 'remove', '--force', temporaryRoot],
    cwd: '/repo',
  });
  expect(
    calls.some(
      ({ command, args }) => command === 'git' && args[0] === 'worktree' && args[1] === 'prune',
    ),
  ).toBe(false);
});
```

Add:

```ts
it('builds dev from the current checkout without stable gates or smoke', async () => {
  const commands: Array<[string, string[]]> = [];
  let smokeCalled = false;
  const result = await runMacosBuild(
    { channel: 'dev', repositoryRoot: '/repo' },
    {
      homeDir: '/Users/test',
      makeTemporaryRoot: async () => '/tmp/psyche-dev-config-123',
      removeTemporaryRoot: async () => undefined,
      writeDevTauriConfig: async () => '/tmp/psyche-dev-config-123/tauri.dev.conf.json',
      runCommand: async (command, args) => {
        commands.push([command, args]);
        if (command === 'git' && args[0] === 'rev-parse') {
          return {
            stdout: '89abcdef0123456789abcdef0123456789abcdef\n',
            stderr: '',
          };
        }
        if (command === 'git' && args[0] === 'status') {
          return { stdout: ' M web/main.js\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
      findCandidateApp: async () => '/repo/target/Psyche Build Dev.app',
      readBundleIdentity: async () => ({
        name: 'Psyche Build Dev',
        identifier: 'dev.opencoven.psyche.dev',
        executable: 'psyche-build-tauri',
      }),
      smokeLaunchBundle: async () => {
        smokeCalled = true;
      },
      installBundleTransactional: async () =>
        '/Users/test/Applications/Psyche Build Dev.app',
      writeBuildProvenance: async () =>
        '/Users/test/Library/Application Support/Psyche Build Builder/builds.json',
      now: () => new Date('2026-08-10T15:05:00.000Z'),
    },
  );

  expect(commands).not.toContainEqual([
    'git',
    expect.arrayContaining(['worktree', 'add']),
  ]);
  expect(commands).not.toContainEqual(['pnpm', ['test']]);
  expect(commands).toContainEqual([
    'pnpm',
    [
      'exec',
      'tauri',
      'build',
      '--bundles',
      'app',
      '--config',
      '/tmp/psyche-dev-config-123/tauri.dev.conf.json',
    ],
  ]);
  expect(smokeCalled).toBe(false);
  expect(result).toMatchObject({
    channel: 'dev',
    dirty: true,
    commitSha: '89abcdef0123456789abcdef0123456789abcdef',
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because source and orchestration helpers do not exist.

- [ ] **Step 3: Add the real argument-array command runner**

Add `execFile` and `promisify` imports and implement:

```js
const execFileAsync = promisify(execFile);

export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const status = typeof error?.code === 'number' ? ` (exit ${error.code})` : '';
    throw new Error(
      `Command failed${status}: ${command} ${args.join(' ')}\n${stdout}${stderr}`,
      { cause: error },
    );
  }
}
```

- [ ] **Step 4: Implement source identity helpers**

Add:

```js
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export async function resolveCommit(repositoryRoot, ref, execute = runCommand) {
  const result = await execute('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: repositoryRoot,
  });
  const sha = result.stdout.trim();
  if (!COMMIT_SHA.test(sha)) {
    throw new Error(`Git ref did not resolve to a full commit SHA: ${ref}`);
  }
  return sha;
}

export async function sourceIsDirty(repositoryRoot, execute = runCommand) {
  const result = await execute('git', ['status', '--porcelain'], {
    cwd: repositoryRoot,
  });
  return result.stdout.trim().length > 0;
}
```

- [ ] **Step 5: Add Info.plist reading and candidate cleanup**

Implement:

```js
export async function readBundleIdentity(appPath, execute = runCommand) {
  const infoPlist = path.join(appPath, 'Contents/Info.plist');
  const readKey = async (key) => {
    const result = await execute(
      'plutil',
      ['-extract', key, 'raw', '-o', '-', infoPlist],
      { cwd: path.dirname(infoPlist) },
    );
    return result.stdout.trim();
  };
  return {
    name: await readKey('CFBundleName'),
    identifier: await readKey('CFBundleIdentifier'),
    executable: await readKey('CFBundleExecutable'),
  };
}
```

Add:

```js
export async function writeDevTauriConfig(sourceRoot, temporaryRoot) {
  const productionPath = path.join(
    sourceRoot,
    'native/macos/psyche-build-tauri/src-tauri/tauri.conf.json',
  );
  const generatedPath = path.join(temporaryRoot, 'tauri.dev.conf.json');
  const production = JSON.parse(await readFile(productionPath, 'utf8'));
  const devConfig = createDevTauriConfig(production);
  await writeFile(generatedPath, `${JSON.stringify(devConfig, null, 2)}\n`, {
    mode: 0o600,
  });
  return generatedPath;
}
```

Before each Tauri build, remove only the expected channel candidate path under:

```text
native/macos/psyche-build-tauri/src-tauri/target/release/bundle/macos/<app name>
```

This prevents a stale candidate from being installed after a packaging
regression while leaving unrelated build output untouched.

- [ ] **Step 6: Implement `runMacosBuild`**

The function must:

1. Resolve the current commit for dev or requested ref for stable.
2. Create a temporary root and detached stable worktree with:

   ```js
   await execute(
     'git',
     ['worktree', 'add', '--detach', temporaryRoot, commitSha],
     { cwd: repositoryRoot },
   );
   ```

3. For dev, read
   `native/macos/psyche-build-tauri/src-tauri/tauri.conf.json`, pass the parsed
   object through `createDevTauriConfig`, and atomically write the complete
   result to `path.join(temporaryRoot, 'tauri.dev.conf.json')`.
4. Run `buildCommandsFor(channel, { devConfigPath })` sequentially with each
   relative command directory resolved against the selected source root.
5. Find and validate the expected candidate.
6. Run startup smoke only for stable, using `CFBundleExecutable`.
7. Install transactionally into the selected channel path.
8. Write provenance after install.
9. In `finally`, run only:

   ```js
   await execute(
     'git',
     ['worktree', 'remove', '--force', temporaryRoot],
     { cwd: repositoryRoot },
   );
   await removeTemporaryRoot(temporaryRoot);
   ```

   The worktree command runs only when `git worktree add` succeeded. The
   temporary-root removal runs for both channels, which also removes the
   generated dev config after success or failure.

Use this dependency shape so tests can replace side effects:

```js
{
  runCommand,
  makeTemporaryRoot: () => mkdtemp(path.join(os.tmpdir(), 'psyche-stable-build-')),
  removeTemporaryRoot: (directory) => rm(directory, { recursive: true, force: true }),
  findCandidateApp,
  readBundleIdentity,
  smokeLaunchBundle,
  installBundleTransactional,
  writeBuildProvenance,
  now: () => new Date(),
  homeDir: os.homedir(),
}
```

Merge overrides with these defaults instead of requiring callers to provide
every dependency.

- [ ] **Step 7: Replace the temporary CLI output with real orchestration**

Update `main`:

```js
async function main() {
  const options = parseBuildArguments(process.argv.slice(2));
  const result = await runMacosBuild({
    ...options,
    repositoryRoot: REPOSITORY_ROOT,
  });
  const dirtyLabel = result.dirty ? ' with uncommitted changes' : '';
  console.log(
    `Installed ${result.productName} at ${result.installedPath}\n` +
      `Source: ${result.commitSha}${dirtyLabel}`,
  );
}
```

- [ ] **Step 8: Extend declarations and test CLI argument forwarding**

Add to `scripts/build-macos-app.d.mts`:

```ts
export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface RunMacosBuildOptions {
  channel: BuildChannel;
  ref?: string;
  repositoryRoot: string;
}

export interface RunMacosBuildDependencies {
  runCommand?: CommandRunner;
  makeTemporaryRoot?: () => Promise<string>;
  removeTemporaryRoot?: (directory: string) => Promise<void>;
  writeDevTauriConfig?: (sourceRoot: string, temporaryRoot: string) => Promise<string>;
  findCandidateApp?: (bundleDir: string, appName: string) => Promise<string>;
  readBundleIdentity?: (
    appPath: string,
    execute?: CommandRunner,
  ) => Promise<BundleIdentity>;
  smokeLaunchBundle?: (appPath: string, overrides: SmokeOverrides) => Promise<void>;
  installBundleTransactional?: (
    candidate: string,
    config: ChannelConfig,
    overrides: InstallOverrides,
  ) => Promise<string>;
  writeBuildProvenance?: (
    record: BuildProvenance,
    overrides?: { homeDir?: string },
  ) => Promise<string>;
  now?: () => Date;
  homeDir?: string;
}

export interface RunMacosBuildResult extends BuildProvenance {
  productName: string;
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult>;
export function resolveCommit(
  repositoryRoot: string,
  ref: string,
  execute?: CommandRunner,
): Promise<string>;
export function sourceIsDirty(
  repositoryRoot: string,
  execute?: CommandRunner,
): Promise<boolean>;
export function readBundleIdentity(
  appPath: string,
  execute?: CommandRunner,
): Promise<BundleIdentity>;
export function writeDevTauriConfig(
  sourceRoot: string,
  temporaryRoot: string,
): Promise<string>;
export function runMacosBuild(
  options: RunMacosBuildOptions,
  dependencies?: RunMacosBuildDependencies,
): Promise<RunMacosBuildResult>;
```

Add `execFile` and `promisify` imports to the test, then add:

```ts
it('fails a missing stable ref before printing an install path', async () => {
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync(
      process.execPath,
      [path.resolve('scripts/build-macos-app.mjs'), 'stable', '--', 'missing-ref'],
      { cwd: path.resolve('.') },
    );
    throw new Error('expected missing ref to fail');
  } catch (error) {
    expect(error).toMatchObject({
      stderr: expect.stringContaining('missing-ref'),
      stdout: expect.not.stringContaining('Installed Psyche Build'),
    });
  }
});
```

- [ ] **Step 9: Run focused tests and typecheck**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
pnpm typecheck:tests
```

Expected: both pass.

- [ ] **Step 10: Commit orchestration**

```sh
git add scripts/build-macos-app.mjs scripts/build-macos-app.d.mts \
  __tests__/macosBuildChannels.test.ts
git commit -m "feat: build isolated stable and dev macOS apps"
```

### Task 6: Document and prove both local channels

**Files:**
- Modify: `CONTRIBUTING.md`
- Test: `__tests__/macosBuildChannels.test.ts`

- [ ] **Step 1: Add a failing documentation contract**

Add:

```ts
it('documents stable and dev local app workflows', () => {
  const contributing = readFileSync(path.resolve('CONTRIBUTING.md'), 'utf8');

  expect(contributing).toContain('pnpm app:stable -- <git-ref>');
  expect(contributing).toContain('pnpm app:dev');
  expect(contributing).toContain('~/Applications/Psyche Build.app');
  expect(contributing).toContain('~/Applications/Psyche Build Dev.app');
  expect(contributing).toContain('does not create a signed or notarized public release');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because `CONTRIBUTING.md` does not document the commands.

- [ ] **Step 3: Document the local app workflow**

Add a `Local macOS App Channels` section after `Local Development (Dogfood
Loop)` in `CONTRIBUTING.md`:

````md
## Local macOS App Channels

Build a protected daily-use app from an explicit tested Git ref:

```sh
pnpm app:stable -- <git-ref>
```

The command builds in a temporary detached worktree, runs the full desktop
verification gate, smoke-launches the candidate with temporary local data, and
replaces `~/Applications/Psyche Build.app` only after every check passes.

Build the current checkout as a separate experimental app:

```sh
pnpm app:dev
```

This fast path accepts uncommitted changes and replaces only
`~/Applications/Psyche Build Dev.app`. Its separate bundle identifier keeps
preferences, WebView data, caches, and restored state isolated from the stable
app.

These commands produce local application bundles. They do not create a signed
or notarized public release; use `docs/RELEASE.md` for publication.
````

- [ ] **Step 4: Run the focused and related contract tests**

Run:

```sh
pnpm vitest --run \
  __tests__/macosBuildChannels.test.ts \
  __tests__/tauriWebBundles.test.ts \
  __tests__/releaseWorkflow.test.ts
pnpm typecheck
```

Expected: all tests and typechecks pass.

- [ ] **Step 5: Run Rust and web verification**

Run:

```sh
MANIFEST=native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo fmt --manifest-path "$MANIFEST" --check
cargo test --manifest-path "$MANIFEST" --locked
cargo check --manifest-path "$MANIFEST" --locked
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: every command passes.

- [ ] **Step 6: Build and inspect the dev channel**

Run:

```sh
pnpm app:dev
plutil -extract CFBundleName raw -o - \
  "$HOME/Applications/Psyche Build Dev.app/Contents/Info.plist"
plutil -extract CFBundleIdentifier raw -o - \
  "$HOME/Applications/Psyche Build Dev.app/Contents/Info.plist"
```

Expected:

```text
Psyche Build Dev
dev.opencoven.psyche.dev
```

- [ ] **Step 7: Build and inspect the stable channel from the current commit**

Record the exact clean commit to test:

```sh
stable_ref="$(git rev-parse HEAD)"
pnpm app:stable -- "$stable_ref"
plutil -extract CFBundleName raw -o - \
  "$HOME/Applications/Psyche Build.app/Contents/Info.plist"
plutil -extract CFBundleIdentifier raw -o - \
  "$HOME/Applications/Psyche Build.app/Contents/Info.plist"
```

Expected:

```text
Psyche Build
dev.opencoven.psyche
```

The stable command must report the same `stable_ref`, complete the launch
smoke, and leave the active checkout's existing uncommitted files unchanged.

- [ ] **Step 8: Verify side-by-side installation and provenance**

Run:

```sh
test -d "$HOME/Applications/Psyche Build.app"
test -d "$HOME/Applications/Psyche Build Dev.app"
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const statePath = path.join(
  os.homedir(),
  'Library/Application Support/Psyche Build Builder/builds.json',
);
const state = JSON.parse(await readFile(statePath, 'utf8'));
if (!state.channels.stable || !state.channels.dev) {
  throw new Error('Both build-channel provenance records are required');
}
console.log(state.channels.stable.commitSha);
console.log(state.channels.dev.commitSha);
NODE
```

Expected: both app directories exist and both channel SHAs print.

- [ ] **Step 9: Run the complete repository gate**

Run:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
git diff --check
```

Expected: every command passes with no whitespace errors.

- [ ] **Step 10: Commit documentation and final contracts**

```sh
git add CONTRIBUTING.md __tests__/macosBuildChannels.test.ts
git commit -m "docs: explain local macOS build channels"
```

### Task 7: Final implementation audit

**Files:** none beyond Tasks 1-6.

- [ ] **Step 1: Review the complete diff**

Run:

```sh
git --no-pager diff HEAD~6..HEAD -- \
  package.json \
  CONTRIBUTING.md \
  scripts/build-macos-app.mjs \
  scripts/build-macos-app.d.mts \
  __tests__/macosBuildChannels.test.ts
```

Confirm:

- stable source comes only from the resolved detached worktree;
- dev source comes only from the current checkout;
- commands use argument arrays rather than shell interpolation;
- stable failures occur before installation;
- transactional rollback restores the previous channel app;
- stable and dev bundle identifiers and install paths do not overlap;
- startup smoke uses temporary local data and kills only its exact child;
- cleanup removes only the temporary worktree and directory it created;
- local build commands do not alter `.github/workflows/release.yml`.

- [ ] **Step 2: Verify the user's existing worktree changes remain intact**

Run:

```sh
git status --short
```

Expected: pre-existing edits to `.beads/interactions.jsonl`, workspace tests,
and `native/macos/psyche-build-tauri/web/` remain present unless the user
changed them separately. Do not stage or revert those files as part of this
feature.

- [ ] **Step 3: Record the final validation result**

Capture the exact stable and dev installed paths, source SHAs, and passing
focused/full validation commands in the implementation handoff. Do not claim
the local bundles are signed, notarized, or publishable.
