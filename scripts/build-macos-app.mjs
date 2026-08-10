#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TAURI_CWD = 'native/macos/psyche-build-tauri';
const CARGO_MANIFEST_PATH = 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml';

const CHANNEL_CONFIG = {
  stable: {
    productName: 'Psyche Build',
    bundleIdentifier: 'dev.opencoven.psyche',
    appName: 'Psyche Build.app',
  },
  dev: {
    productName: 'Psyche Build Dev',
    bundleIdentifier: 'dev.opencoven.psyche.dev',
    appName: 'Psyche Build Dev.app',
  },
};

const scriptFilePath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFilePath), '..');
const DEFAULT_SMOKE_MS = 5_000;
const DEFAULT_TERM_TIMEOUT_MS = 5_000;
const DEFAULT_POST_KILL_TIMEOUT_MS = 2_000;
const TEMP_HOME_PREFIX = 'psyche-build-smoke-';

export function parseBuildArguments(argv) {
  const tokens = argv.filter((value) => value !== '--');
  const [channel, ...rest] = tokens;

  if (channel !== 'stable' && channel !== 'dev') {
    throw new Error('Build channel must be "stable" or "dev"');
  }

  if (channel === 'stable') {
    const ref = rest[0]?.trim() ?? '';
    if (rest.length !== 1 || ref === '') {
      throw new Error('stable builds require exactly one nonblank Git ref');
    }
    return { channel: 'stable', ref };
  }

  if (rest.length !== 0) {
    throw new Error('dev builds do not accept a Git ref');
  }

  return { channel: 'dev' };
}

export function channelConfig(channel) {
  const config = CHANNEL_CONFIG[channel];
  if (!config) {
    throw new Error(`Unknown build channel "${channel}"`);
  }
  return { ...config };
}

export function createDevTauriConfig(production) {
  const devConfig = structuredClone(production);
  const mainWindow = devConfig.app?.windows?.find((window) => window.label === 'main');

  if (!mainWindow) {
    throw new Error('Production Tauri config must contain an app.windows entry labeled "main"');
  }

  const devIdentity = channelConfig('dev');
  devConfig.productName = devIdentity.productName;
  devConfig.identifier = devIdentity.bundleIdentifier;
  mainWindow.title = devIdentity.productName;

  return devConfig;
}

export function buildCommandsFor(channel, options = {}) {
  if (channel === 'stable') {
    return [
      ['pnpm', ['install', '--frozen-lockfile'], '.'],
      ['pnpm', ['test'], '.'],
      ['pnpm', ['typecheck'], '.'],
      ['pnpm', ['build'], '.'],
      ['pnpm', ['smoke:pack'], '.'],
      ['cargo', ['fmt', '--manifest-path', CARGO_MANIFEST_PATH, '--check'], '.'],
      ['cargo', ['test', '--manifest-path', CARGO_MANIFEST_PATH, '--locked'], '.'],
      ['cargo', ['check', '--manifest-path', CARGO_MANIFEST_PATH, '--locked'], '.'],
      ['pnpm', ['build:web'], TAURI_CWD],
      ['pnpm', ['exec', 'tauri', 'build', '--bundles', 'app'], TAURI_CWD],
    ];
  }

  if (channel !== 'dev') {
    throw new Error(`Unknown build channel "${channel}"`);
  }

  if (typeof options.devConfigPath !== 'string' || options.devConfigPath.trim() === '') {
    throw new Error('dev builds require a devConfigPath');
  }

  const devConfigPath = path.resolve(options.devConfigPath);
  return [
    ['pnpm', ['build:web'], TAURI_CWD],
    [
      'pnpm',
      ['exec', 'tauri', 'build', '--bundles', 'app', '--config', devConfigPath],
      TAURI_CWD,
    ],
  ];
}

export async function findCandidateApp(bundleDir, expectedAppName) {
  const matches = [];
  await collectCandidateApps(path.resolve(bundleDir), expectedAppName, matches);

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one "${expectedAppName}" bundle, found ${matches.length}`);
  }

  return matches[0];
}

export function assertBundleIdentity(appPath, identity, expectedChannelConfig) {
  const actual = {
    appName: path.basename(appPath, '.app'),
    name: identity.name,
    identifier: identity.identifier,
  };
  const expected = {
    productName: expectedChannelConfig.productName,
    bundleIdentifier: expectedChannelConfig.bundleIdentifier,
  };

  if (
    actual.appName === expected.productName &&
    actual.name === expected.productName &&
    actual.identifier === expected.bundleIdentifier
  ) {
    return;
  }

  throw new Error(
    `Bundle identity mismatch for "${appPath}": ` +
      `expected productName="${expected.productName}" ` +
      `bundleIdentifier="${expected.bundleIdentifier}"; ` +
      `actual appName="${actual.appName}" ` +
      `identity.name="${actual.name}" ` +
      `identity.identifier="${actual.identifier}"`,
  );
}

export async function smokeLaunchBundle(appPath, overrides) {
  const executableName = overrides?.executableName?.trim();
  if (!executableName) {
    throw new Error('smokeLaunchBundle requires a nonblank executableName');
  }

  const args = [...(overrides.args ?? [])];
  const smokeMs = overrides.smokeMs ?? DEFAULT_SMOKE_MS;
  const termTimeoutMs = overrides.termTimeoutMs ?? DEFAULT_TERM_TIMEOUT_MS;
  const postKillTimeoutMs = overrides.postKillTimeoutMs ?? DEFAULT_POST_KILL_TIMEOUT_MS;
  const sleep = overrides.sleep ?? defaultSleep;
  const makeTemporaryHome = overrides.makeTemporaryHome ?? defaultMakeTemporaryHome;
  const removeTemporaryHome = overrides.removeTemporaryHome ?? defaultRemoveTemporaryHome;
  const tempHome = await Promise.resolve(makeTemporaryHome());
  const executablePath = path.join(appPath, 'Contents', 'MacOS', executableName);

  let operationError;
  let stdout = () => '';
  let stderr = () => '';

  try {
    let child;
    try {
      child = (overrides.spawnProcess ?? defaultSpawnProcess)(executablePath, args, {
        env: {
          ...process.env,
          ...temporaryHomeEnvironment(tempHome),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new StartupSmokeFailure(error);
    }

    stdout = collectStreamOutput(child.stdout);
    stderr = collectStreamOutput(child.stderr);
    const exitPromise = waitForProcessExit(child);
    const smokeResult = await Promise.race([
      exitPromise.then((exit) => ({ type: 'exit', exit })),
      sleep(smokeMs).then(() => ({ type: 'smoke' })),
    ]);

    if (smokeResult.type === 'exit') {
      throw new Error(buildEarlyExitMessage(appPath, smokeMs, smokeResult.exit, stdout(), stderr()));
    }

    child.kill('SIGTERM');
    const termResult = await Promise.race([
      exitPromise.then((exit) => ({ type: 'exit', exit })),
      sleep(termTimeoutMs).then(() => ({ type: 'timeout' })),
    ]);

    if (termResult.type === 'timeout') {
      child.kill('SIGKILL');
      const killResult = await Promise.race([
        exitPromise.then((exit) => ({ type: 'exit', exit })),
        sleep(postKillTimeoutMs).then(() => ({ type: 'timeout' })),
      ]);

      if (killResult.type === 'timeout') {
        throw new Error(buildPostKillTimeoutMessage(appPath, postKillTimeoutMs, child.pid));
      }
    }
  } catch (error) {
    operationError = normalizeSmokeLaunchError(appPath, error, stdout(), stderr());
  }

  try {
    await Promise.resolve(removeTemporaryHome(tempHome));
  } catch (cleanupError) {
    if (operationError instanceof Error) {
      throw new Error(
        `${operationError.message}\nFailed to remove temporary home "${tempHome}": ${describeError(cleanupError)}`,
      );
    }
    throw cleanupError;
  }

  if (operationError) {
    throw operationError;
  }
}

async function collectCandidateApps(currentDir, expectedAppName, matches) {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryPath = path.join(currentDir, entry.name);
    if (entry.name === expectedAppName) {
      matches.push(entryPath);
      continue;
    }

    await collectCandidateApps(entryPath, expectedAppName, matches);
  }
}

function temporaryHomeEnvironment(tempHome) {
  return {
    HOME: tempHome,
    TMPDIR: path.join(tempHome, 'tmp'),
    XDG_CONFIG_HOME: path.join(tempHome, '.config'),
    XDG_CACHE_HOME: path.join(tempHome, '.cache'),
    XDG_DATA_HOME: path.join(tempHome, '.local', 'share'),
  };
}

async function defaultMakeTemporaryHome() {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), TEMP_HOME_PREFIX));
  const env = temporaryHomeEnvironment(tempHome);

  await Promise.all([
    mkdir(env.TMPDIR, { recursive: true }),
    mkdir(env.XDG_CONFIG_HOME, { recursive: true }),
    mkdir(env.XDG_CACHE_HOME, { recursive: true }),
    mkdir(env.XDG_DATA_HOME, { recursive: true }),
  ]);

  return tempHome;
}

async function defaultRemoveTemporaryHome(tempHome) {
  await rm(tempHome, { recursive: true, force: true });
}

function defaultSpawnProcess(command, args, options) {
  return spawn(command, args, options);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectStreamOutput(stream) {
  let output = '';

  stream?.on('data', (chunk) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  });

  return () => output;
}

function waitForProcessExit(child) {
  return new Promise((resolve, reject) => {
    const onClose = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(new StartupSmokeFailure(error));
    };
    const cleanup = () => {
      child.off('close', onClose);
      child.off('error', onError);
    };

    child.once('close', onClose);
    child.once('error', onError);
  });
}

function normalizeSmokeLaunchError(appPath, error, stdout, stderr) {
  if (error instanceof StartupSmokeFailure) {
    return new Error(buildStartupSmokeErrorMessage(appPath, error.cause, stdout, stderr));
  }

  return error;
}

function buildEarlyExitMessage(appPath, smokeMs, exit, stdout, stderr) {
  const sections = [
    `Smoke launch failed for "${appPath}": exited before ${smokeMs}ms smoke window with ${describeExit(exit)}.`,
  ];

  if (stdout !== '') {
    sections.push(`stdout:\n${stdout.trimEnd()}`);
  }

  if (stderr !== '') {
    sections.push(`stderr:\n${stderr.trimEnd()}`);
  }

  return sections.join('\n');
}

function buildStartupSmokeErrorMessage(appPath, error, stdout, stderr) {
  const sections = [`Startup smoke failed for "${appPath}": ${describeError(error)}.`];

  if (stdout !== '') {
    sections.push(`stdout:\n${stdout.trimEnd()}`);
  }

  if (stderr !== '') {
    sections.push(`stderr:\n${stderr.trimEnd()}`);
  }

  return sections.join('\n');
}

function buildPostKillTimeoutMessage(appPath, postKillTimeoutMs, childPid) {
  const childDescription =
    typeof childPid === 'number' ? `child process ${childPid}` : 'child process';

  return (
    `Smoke launch failed for "${appPath}": ${childDescription} ` +
    `did not exit within ${postKillTimeoutMs}ms after SIGKILL.`
  );
}

function describeExit(exit) {
  if (exit.signal) {
    return `signal ${exit.signal}`;
  }
  if (typeof exit.code === 'number') {
    return `exit code ${exit.code}`;
  }
  return 'an unknown exit';
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

class StartupSmokeFailure extends Error {
  constructor(cause) {
    super(describeError(cause));
    this.name = 'StartupSmokeFailure';
    this.cause = cause;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isEntrypoint()) {
  try {
    const options = parseBuildArguments(process.argv.slice(2));
    console.log(JSON.stringify({ repositoryRoot, options }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
