#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID as createRandomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const TAURI_CWD = 'native/macos/psyche-build-tauri';
const CARGO_MANIFEST_PATH = 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml';
const BUNDLE_RELATIVE_PATH =
  'native/macos/psyche-build-tauri/src-tauri/target/release/bundle/macos';
const PRODUCTION_TAURI_CONFIG_RELATIVE_PATH =
  'native/macos/psyche-build-tauri/src-tauri/tauri.conf.json';

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
const TEMP_BUILD_PREFIX = 'psyche-build-macos-';
const BUILD_CHANNELS = ['stable', 'dev'];
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const COMMAND_MAX_BUFFER = 20 * 1024 * 1024;
const executeFile = promisify(execFile);

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

export async function runCommand(command, args, options = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('runCommand requires an array of string arguments');
  }

  try {
    const result = await executeFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (cause) {
    const stdout = typeof cause?.stdout === 'string' ? cause.stdout : '';
    const stderr = typeof cause?.stderr === 'string' ? cause.stderr : '';
    const exitCode = typeof cause?.code === 'number' ? cause.code : undefined;
    const sections = [
      `Command failed: ${[command, ...args].map((value) => JSON.stringify(value)).join(' ')}`,
    ];

    if (exitCode !== undefined) {
      sections.push(`exit code ${exitCode}`);
    }
    sections.push(`stdout:\n${stdout}`, `stderr:\n${stderr}`);

    const error = new Error(sections.join('\n'), { cause });
    error.command = command;
    error.exitCode = exitCode;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
}

export async function resolveCommit(root, ref, execute = runCommand) {
  const result = await execute('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: path.resolve(root),
  });
  const commitSha = result.stdout.trim();

  if (!COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new Error(
      `Git ref "${ref}" did not resolve to a full lowercase 40-character commit SHA`,
    );
  }

  return commitSha;
}

export async function sourceIsDirty(root, execute = runCommand) {
  const result = await execute('git', ['status', '--porcelain'], {
    cwd: path.resolve(root),
  });
  return result.stdout.length > 0;
}

export async function readBundleIdentity(appPath, execute = runCommand) {
  const infoPath = path.join(path.resolve(appPath), 'Contents', 'Info.plist');
  const readValue = async (key) => {
    const result = await execute('plutil', ['-extract', key, 'raw', '-o', '-', infoPath]);
    return result.stdout.trim();
  };

  return {
    name: await readValue('CFBundleName'),
    identifier: await readValue('CFBundleIdentifier'),
    executable: await readValue('CFBundleExecutable'),
  };
}

export async function writeDevTauriConfig(sourceRoot, tempRoot) {
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteTempRoot = path.resolve(tempRoot);
  const productionPath = path.join(
    absoluteSourceRoot,
    PRODUCTION_TAURI_CONFIG_RELATIVE_PATH,
  );
  const configPath = path.join(absoluteTempRoot, 'tauri.dev.generated.json');
  const temporaryPath = path.join(
    absoluteTempRoot,
    `.tauri.dev.generated.${createRandomUUID()}.tmp`,
  );
  const production = JSON.parse(await readFile(productionPath, 'utf8'));
  const devConfig = createDevTauriConfig(production);

  await mkdir(absoluteTempRoot, { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(devConfig, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, configPath);
    return configPath;
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // The orchestration owns removal of the temporary parent.
    }
    throw error;
  }
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
  let operationError;

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
    operationError = error;

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
        operationError = new Error(
          `${describeError(error)}\n${rollbackContext}: ${describeError(rollbackError)}`,
          { cause: error },
        );
      }
    }

    throw operationError;
  } finally {
    try {
      await removePath(stagingRoot);
    } catch (cleanupError) {
      if (!operationError) {
        throw cleanupError;
      }

      throw combineErrors(
        operationError,
        cleanupError,
        'Failed to clean staging install directory',
      );
    }
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

export async function runMacosBuild(options, deps = {}) {
  const channel = options?.channel;
  const absoluteRepositoryRoot = path.resolve(options?.repositoryRoot ?? repositoryRoot);

  if (channel !== 'stable' && channel !== 'dev') {
    throw new Error('runMacosBuild channel must be "stable" or "dev"');
  }

  const requestedRef = channel === 'stable' ? options.ref?.trim() : undefined;
  if (channel === 'stable' && !requestedRef) {
    throw new Error('stable builds require a nonblank Git ref');
  }
  if (channel === 'dev' && options.ref !== undefined) {
    throw new Error('dev builds do not accept a Git ref');
  }

  const execute = deps.execute ?? runCommand;
  const makeTemporaryDirectory =
    deps.makeTemporaryDirectory ?? defaultMakeBuildTemporaryDirectory;
  const removePath = deps.removePath ?? defaultRemovePath;
  const writeDevConfig = deps.writeDevTauriConfig ?? writeDevTauriConfig;
  const findCandidate = deps.findCandidateApp ?? findCandidateApp;
  const readIdentity = deps.readBundleIdentity ?? readBundleIdentity;
  const smokeLaunch = deps.smokeLaunchBundle ?? smokeLaunchBundle;
  const installBundle = deps.installBundleTransactional ?? installBundleTransactional;
  const writeProvenance = deps.writeBuildProvenance ?? writeBuildProvenance;
  const now = deps.now ?? (() => new Date());
  const homeDir = path.resolve(deps.homeDir ?? os.homedir());
  const expectedConfig = channelConfig(channel);

  let operationError;
  let cleanupError;
  let result;
  let tempRoot;
  let sourceRoot = absoluteRepositoryRoot;
  let stableWorktreeAdded = false;

  try {
    const commitSha = await resolveCommit(
      absoluteRepositoryRoot,
      channel === 'stable' ? requestedRef : 'HEAD',
      execute,
    );
    const dirty =
      channel === 'dev' ? await sourceIsDirty(absoluteRepositoryRoot, execute) : false;

    tempRoot = path.resolve(await makeTemporaryDirectory(TEMP_BUILD_PREFIX));

    if (channel === 'stable') {
      sourceRoot = path.join(tempRoot, 'source');
      await execute(
        'git',
        ['worktree', 'add', '--detach', sourceRoot, commitSha],
        { cwd: absoluteRepositoryRoot },
      );
      stableWorktreeAdded = true;
    }

    const devConfigPath =
      channel === 'dev' ? await writeDevConfig(sourceRoot, tempRoot) : undefined;
    const bundleDir = path.join(sourceRoot, BUNDLE_RELATIVE_PATH);
    const expectedCandidate = path.join(bundleDir, expectedConfig.appName);

    await removePath(expectedCandidate);

    const buildCommands =
      channel === 'stable'
        ? buildCommandsFor('stable')
        : buildCommandsFor('dev', { devConfigPath });

    for (const [command, args, relativeCwd] of buildCommands) {
      await execute(command, args, { cwd: path.resolve(sourceRoot, relativeCwd) });
    }

    const candidate = await findCandidate(bundleDir, expectedConfig.appName);
    const identity = await readIdentity(candidate, execute);
    assertBundleIdentity(candidate, identity, expectedConfig);

    if (channel === 'stable') {
      await smokeLaunch(candidate, { executableName: identity.executable });
    }

    const validateInstalledBundle = async (appPath, requestedConfig) => {
      const installedIdentity = await readIdentity(appPath, execute);
      assertBundleIdentity(appPath, installedIdentity, requestedConfig);
    };
    const installedPath = await installBundle(candidate, expectedConfig, {
      homeDir,
      validateInstalledBundle,
    });
    const builtAt = now().toISOString();

    const provenance = {
      channel,
      commitSha,
      ...(channel === 'stable' ? { requestedRef } : {}),
      dirty,
      builtAt,
      installedPath,
      productName: expectedConfig.productName,
      bundleIdentifier: expectedConfig.bundleIdentifier,
    };

    await writeProvenance(provenance, { homeDir });
    result = provenance;
  } catch (error) {
    operationError = error;
  } finally {
    if (stableWorktreeAdded) {
      try {
        await execute(
          'git',
          ['worktree', 'remove', '--force', sourceRoot],
          { cwd: absoluteRepositoryRoot },
        );
      } catch (error) {
        cleanupError = error;
      }
    }

    if (tempRoot) {
      try {
        await removePath(tempRoot);
      } catch (error) {
        cleanupError = cleanupError
          ? combineErrors(cleanupError, error, 'Failed to remove temporary build parent')
          : error;
      }
    }
  }

  if (operationError && cleanupError) {
    throw combineErrors(operationError, cleanupError, 'Build cleanup failed');
  }
  if (operationError) {
    throw operationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  return result;
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

async function defaultMakeBuildTemporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function defaultRemoveTemporaryHome(tempHome) {
  await rm(tempHome, { recursive: true, force: true });
}

function defaultSpawnProcess(command, args, options) {
  return spawn(command, args, options);
}

async function execFileAsync(command, args) {
  return runCommand(command, args);
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

function combineErrors(primaryError, secondaryError, secondaryContext) {
  return new AggregateError(
    [primaryError, secondaryError],
    `${describeError(primaryError)}\n${secondaryContext}: ${describeError(secondaryError)}`,
    { cause: primaryError },
  );
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
    const result = await runMacosBuild({ ...options, repositoryRoot });
    const sourceState = result.dirty ? 'dirty source' : 'clean source';
    console.log(`Installed ${result.productName} at ${result.installedPath}`);
    console.log(`Source ${result.commitSha} (${sourceState})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
