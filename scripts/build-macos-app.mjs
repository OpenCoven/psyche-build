#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID as createRandomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
const BUILD_CHANNELS = ['stable', 'dev'];
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

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

export async function installBundleTransactional(candidate, requestedChannelConfig, overrides) {
  const validateInstalledBundle = overrides?.validateInstalledBundle;

  if (typeof validateInstalledBundle !== 'function') {
    throw new Error('installBundleTransactional requires a validateInstalledBundle callback');
  }

  const homeDir = path.resolve(overrides.homeDir ?? os.homedir());
  const applicationsDir = path.join(homeDir, 'Applications');
  const uuid = (overrides.randomUUID ?? createRandomUUID)();
  const finalPath = path.join(applicationsDir, requestedChannelConfig.appName);
  const stagingRoot = path.join(
    applicationsDir,
    `.install-${requestedChannelConfig.appName}.${uuid}.staging`,
  );
  const stagingPath = path.join(stagingRoot, requestedChannelConfig.appName);
  const backupPath = path.join(
    applicationsDir,
    `.${requestedChannelConfig.appName}.${uuid}.backup`,
  );
  const copyBundle = overrides.copyBundle ?? copyBundleWithDitto;
  const mkdirPath = overrides.mkdirPath ?? defaultCreateDirectory;
  const renamePath = overrides.renamePath ?? defaultRenamePath;
  const removePath = overrides.removePath ?? defaultRemovePath;

  let backupCreated = false;
  let finalValidated = false;
  let finalInstalled = false;

  await mkdirPath(applicationsDir);

  try {
    await mkdirPath(stagingRoot);
    await Promise.resolve(copyBundle(candidate, stagingPath));
    await Promise.resolve(validateInstalledBundle(stagingPath, requestedChannelConfig));

    try {
      await renamePath(finalPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await renamePath(stagingPath, finalPath);
    finalInstalled = true;
    await Promise.resolve(validateInstalledBundle(finalPath, requestedChannelConfig));
    finalValidated = true;

    if (backupCreated) {
      await removePath(backupPath);
      backupCreated = false;
    }

    return finalPath;
  } catch (error) {
    if (!finalValidated) {
      try {
        if (finalInstalled) {
          await removePath(finalPath);
          finalInstalled = false;
        }

        if (backupCreated) {
          await renamePath(backupPath, finalPath);
          backupCreated = false;
        }
      } catch (rollbackError) {
        const rollbackContext = backupCreated
          ? 'Rollback failed'
          : 'Failed to remove invalid installed app';
        throw new Error(
          `${describeError(error)}\n${rollbackContext}: ${describeError(rollbackError)}`,
        );
      }
    }

    throw error;
  } finally {
    await removePath(stagingRoot);
  }
}

export async function writeBuildProvenance(record, overrides = {}) {
  const homeDir = path.resolve(overrides.homeDir ?? os.homedir());
  const stateDir = path.join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
  const statePath = path.join(stateDir, 'builds.json');
  const tempPath = path.join(
    stateDir,
    `.builds.json.${(overrides.randomUUID ?? createRandomUUID)()}.tmp`,
  );
  const mkdirPath = overrides.mkdirPath ?? defaultCreateDirectory;
  const readFileText = overrides.readFileText ?? defaultReadFileText;
  const writeFileText = overrides.writeFileText ?? defaultWriteFileText;
  const renamePath = overrides.renamePath ?? defaultRenamePath;
  const removePath = overrides.removePath ?? defaultRemovePath;

  await mkdirPath(stateDir);

  const nextState = {
    version: 1,
    channels: {
      ...(await readExistingBuildProvenance(statePath, readFileText)),
      [record.channel]: record,
    },
  };

  try {
    await writeFileText(tempPath, `${JSON.stringify(nextState, null, 2)}\n`);
    await renamePath(tempPath, statePath);
    return statePath;
  } catch (error) {
    try {
      await removePath(tempPath);
    } catch (cleanupError) {
      throw new Error(
        `${describeError(error)}\nFailed to clean temporary provenance file: ${describeError(cleanupError)}`,
      );
    }
    throw error;
  }
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

async function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
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

function isEnoentError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'ENOENT';
}

async function copyBundleWithDitto(source, destination) {
  await execFileAsync('ditto', [source, destination]);
}

async function defaultCreateDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

async function defaultRenamePath(sourcePath, destinationPath) {
  await rename(sourcePath, destinationPath);
}

async function defaultRemovePath(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

async function defaultReadFileText(filePath) {
  return readFile(filePath, 'utf8');
}

async function defaultWriteFileText(filePath, content) {
  await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

async function readExistingBuildProvenance(statePath, readFileText) {
  try {
    const raw = await readFileText(statePath);
    const parsed = JSON.parse(raw);

    if (
      parsed?.version !== 1 ||
      !parsed.channels ||
      typeof parsed.channels !== 'object' ||
      Array.isArray(parsed.channels)
    ) {
      throw new Error('expected version 1 with object channels');
    }

    validateBuildProvenanceChannels(statePath, parsed.channels);
    return parsed.channels;
  } catch (error) {
    if (isEnoentError(error)) {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid build provenance file at "${statePath}": ${error.message}`);
    }

    if (error instanceof Error && error.message === 'expected version 1 with object channels') {
      throw new Error(`Invalid build provenance file at "${statePath}": ${error.message}`);
    }

    throw error;
  }
}

function validateBuildProvenanceChannels(statePath, channels) {
  for (const [channelName, record] of Object.entries(channels)) {
    if (!BUILD_CHANNELS.includes(channelName)) {
      throw invalidBuildProvenance(statePath, `unknown channel "${channelName}"`);
    }

    validateBuildProvenanceRecord(statePath, channelName, record);
  }
}

function validateBuildProvenanceRecord(statePath, channelName, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw invalidBuildProvenance(statePath, `channel "${channelName}" must be an object`);
  }

  if (record.channel !== channelName) {
    throw invalidBuildProvenance(
      statePath,
      `channel "${channelName}" record must contain channel="${channelName}"`,
    );
  }

  if (typeof record.commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(record.commitSha)) {
    throw invalidBuildProvenance(
      statePath,
      `channel "${channelName}" record must contain a 40-character lowercase hexadecimal commitSha`,
    );
  }

  if (typeof record.dirty !== 'boolean') {
    throw invalidBuildProvenance(
      statePath,
      `channel "${channelName}" record must contain boolean dirty`,
    );
  }

  for (const fieldName of ['builtAt', 'installedPath', 'productName', 'bundleIdentifier']) {
    if (typeof record[fieldName] !== 'string') {
      throw invalidBuildProvenance(
        statePath,
        `channel "${channelName}" record must contain string ${fieldName}`,
      );
    }
  }

  if (record.requestedRef !== undefined && typeof record.requestedRef !== 'string') {
    throw invalidBuildProvenance(
      statePath,
      `channel "${channelName}" record must omit requestedRef or provide it as a string`,
    );
  }
}

function invalidBuildProvenance(statePath, detail) {
  return new Error(`Invalid build provenance file at "${statePath}": ${detail}`);
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
