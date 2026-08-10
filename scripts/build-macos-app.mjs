#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { randomUUID as createRandomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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
const BUILD_PROVENANCE_HELPER_PATH = path.join(
  repositoryRoot,
  'scripts',
  'write-build-provenance.mjs',
);
const PUBLISH_BUILD_CHANNEL_HELPER_PATH = path.join(
  repositoryRoot,
  'scripts',
  'publish-build-channel.mjs',
);
const LOCKF_PATH = '/usr/bin/lockf';
const DEFAULT_SMOKE_MS = 5_000;
const DEFAULT_TERM_TIMEOUT_MS = 5_000;
const DEFAULT_POST_KILL_TIMEOUT_MS = 2_000;
const DEFAULT_PROVENANCE_LOCK_TIMEOUT_SECONDS = 5;
const MAX_PROVENANCE_LOCK_TIMEOUT_SECONDS = 60;
const TEMP_HOME_PREFIX = 'psyche-build-smoke-';
const TEMP_BUILD_PREFIX = 'psyche-build-macos-';
const BUILD_CHANNELS = ['stable', 'dev'];
const BUILD_PROVENANCE_STATE_KEYS = ['version', 'channels'];
const BUILD_PROVENANCE_BASE_RECORD_KEYS = [
  'channel',
  'commitSha',
  'dirty',
  'builtAt',
  'installedPath',
  'productName',
  'bundleIdentifier',
];
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
    const stage =
      typeof options.stage === 'string' && options.stage.trim() !== ''
        ? options.stage.trim()
        : 'run command';
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const stdout = typeof cause?.stdout === 'string' ? cause.stdout : '';
    const stderr = typeof cause?.stderr === 'string' ? cause.stderr : '';
    const exitCode = typeof cause?.code === 'number' ? cause.code : undefined;
    const code = typeof cause?.code === 'string' ? cause.code : undefined;
    const signal = typeof cause?.signal === 'string' ? cause.signal : undefined;
    const sections = [
      `Stage: ${stage}`,
      `cwd: ${cwd}`,
      `Command: ${[command, ...args].map((value) => JSON.stringify(value)).join(' ')}`,
    ];

    if (exitCode !== undefined) {
      sections.push(`exit code ${exitCode}`);
    } else if (code !== undefined) {
      sections.push(`spawn code ${code}`);
    }
    if (signal !== undefined) {
      sections.push(`signal ${signal}`);
    }
    sections.push(
      `stdout:\n${stdout}`,
      `stderr:\n${stderr}`,
      `cause: ${describeError(cause)}`,
    );

    const error = new Error(sections.join('\n'), { cause });
    error.command = command;
    error.args = [...args];
    error.cwd = cwd;
    error.stage = stage;
    error.exitCode = exitCode;
    error.code = code;
    error.signal = signal;
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
}

export async function resolveCommit(root, ref, execute = runCommand) {
  const result = await execute(
    'git',
    [
      '-c',
      'core.warnAmbiguousRefs=true',
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    ],
    {
      cwd: path.resolve(root),
      stage: ref === 'HEAD' ? 'resolve current commit' : `resolve Git ref "${ref}"`,
    },
  );

  if (result.stderr.length > 0) {
    throw new Error(
      `Git ref "${ref}" produced stderr during resolution and was rejected:\n${result.stderr}`,
    );
  }

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
    stage: 'inspect source status',
  });
  return result.stdout.length > 0;
}

export async function readBundleIdentity(appPath, execute = runCommand) {
  const infoPath = path.join(path.resolve(appPath), 'Contents', 'Info.plist');
  const readValue = async (key) => {
    const result = await execute('plutil', ['-extract', key, 'raw', '-o', '-', infoPath], {
      stage: `read plist key ${key}`,
    });
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

export async function publishBuildChannel(
  candidate,
  requestedChannelConfig,
  record,
  overrides = {},
) {
  const candidatePath = path.resolve(candidate);
  const homeDir = path.resolve(overrides.homeDir ?? os.homedir());
  const applicationsDir = path.join(homeDir, 'Applications');
  const stateDir = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Psyche Build Builder',
  );
  const installedPath = path.join(applicationsDir, requestedChannelConfig.appName);
  const lockPath = path.join(
    applicationsDir,
    `.${requestedChannelConfig.appName}.publish.lock`,
  );
  const randomUUID = overrides.randomUUID ?? createRandomUUID;
  const mkdirPath = overrides.mkdirPath ?? defaultCreateDirectory;
  const writeFileText = overrides.writeFileText ?? defaultWriteFileText;
  const removePath = overrides.removePath ?? defaultRemovePath;
  const execute = overrides.execute ?? runCommand;
  const lockTimeoutSeconds =
    overrides.lockTimeoutSeconds ?? DEFAULT_PROVENANCE_LOCK_TIMEOUT_SECONDS;

  validateIncomingBuildProvenance(record);
  validateChannelConfig(record.channel, requestedChannelConfig);
  validateLockTimeoutSeconds(lockTimeoutSeconds);

  if (record.installedPath !== installedPath) {
    throw invalidIncomingBuildProvenance(
      `channel "${record.channel}" installedPath must equal "${installedPath}"`,
    );
  }

  const inputPath = path.join(
    stateDir,
    `.publish-${record.channel}.input-${randomUUID()}.json`,
  );
  const input = {
    candidatePath,
    channelConfig: requestedChannelConfig,
    homeDir,
    provenance: record,
  };

  await mkdirPath(applicationsDir);
  await mkdirPath(stateDir);

  let operationError;
  let inputMayBelongToPublisher = false;
  let publishedPath;

  try {
    try {
      await writeFileText(
        inputPath,
        `${JSON.stringify(input)}\n`,
        { exclusive: true },
      );
      inputMayBelongToPublisher = true;
    } catch (error) {
      inputMayBelongToPublisher = !isAlreadyExistsError(error);
      throw error;
    }

    const result = await execute(
      LOCKF_PATH,
      [
        '-k',
        '-t',
        String(lockTimeoutSeconds),
        lockPath,
        process.execPath,
        PUBLISH_BUILD_CHANNEL_HELPER_PATH,
        inputPath,
      ],
      { stage: `publish ${record.channel} app and provenance` },
    );
    publishedPath = result.stdout.trim();

    if (publishedPath !== installedPath) {
      throw new Error(
        `Publication helper returned unexpected installed path ` +
          `"${publishedPath}" instead of "${installedPath}"`,
      );
    }
  } catch (error) {
    operationError =
      error?.exitCode === 75
        ? buildPublicationLockTimeoutError(
            error,
            record.channel,
            lockTimeoutSeconds,
            lockPath,
          )
        : includeChildDiagnostics(error);
  } finally {
    if (inputMayBelongToPublisher) {
      try {
        await removePath(inputPath);
      } catch (cleanupError) {
        operationError = operationError
          ? combineErrors(
              operationError,
              cleanupError,
              'Failed to clean private app publication input file',
            )
          : new Error(
              `Failed to clean private app publication input file "${inputPath}": ` +
                describeError(cleanupError),
              { cause: cleanupError },
            );
      }
    }
  }

  if (operationError) {
    throw operationError;
  }

  return publishedPath;
}

export function validateBuildProvenance(record) {
  validateIncomingBuildProvenance(record);
}

export async function writeBuildProvenance(record, overrides = {}) {
  const homeDir = path.resolve(overrides.homeDir ?? os.homedir());
  const stateDir = path.join(homeDir, 'Library', 'Application Support', 'Psyche Build Builder');
  const statePath = path.join(stateDir, 'builds.json');
  const lockPath = `${statePath}.lock`;
  const randomUUID = overrides.randomUUID ?? createRandomUUID;
  const mkdirPath = overrides.mkdirPath ?? defaultCreateDirectory;
  const writeFileText = overrides.writeFileText ?? defaultWriteFileText;
  const removePath = overrides.removePath ?? defaultRemovePath;
  const execute = overrides.execute ?? runCommand;
  const lockTimeoutSeconds =
    overrides.lockTimeoutSeconds ?? DEFAULT_PROVENANCE_LOCK_TIMEOUT_SECONDS;

  validateIncomingBuildProvenance(record);
  validateLockTimeoutSeconds(lockTimeoutSeconds);
  const inputPath = path.join(
    stateDir,
    `.builds.json.input-${randomUUID()}.json`,
  );
  await mkdirPath(stateDir);

  let operationError;
  let inputMayBelongToWriter = false;

  try {
    try {
      await writeFileText(
        inputPath,
        `${JSON.stringify(record)}\n`,
        { exclusive: true },
      );
      inputMayBelongToWriter = true;
    } catch (error) {
      inputMayBelongToWriter = !isAlreadyExistsError(error);
      throw error;
    }

    await execute(
      LOCKF_PATH,
      [
        '-k',
        '-t',
        String(lockTimeoutSeconds),
        lockPath,
        process.execPath,
        BUILD_PROVENANCE_HELPER_PATH,
        statePath,
        inputPath,
      ],
      { stage: 'write build provenance' },
    );
  } catch (error) {
    operationError =
      error?.exitCode === 75
        ? buildProvenanceLockTimeoutError(error, lockTimeoutSeconds, lockPath)
        : includeChildDiagnostics(error);
  } finally {
    if (inputMayBelongToWriter) {
      try {
        await removePath(inputPath);
      } catch (cleanupError) {
        if (operationError) {
          operationError = combineErrors(
            operationError,
            cleanupError,
            'Failed to clean private build provenance input file',
          );
        } else {
          operationError = new Error(
            `Failed to clean private build provenance input file "${inputPath}": ` +
              describeError(cleanupError),
            { cause: cleanupError },
          );
        }
      }
    }
  }

  if (operationError) {
    throw operationError;
  }

  return statePath;
}

export async function writeBuildProvenanceUnlocked(statePath, record, overrides = {}) {
  const absoluteStatePath = path.resolve(statePath);
  const stateDir = path.dirname(absoluteStatePath);
  const randomUUID = overrides.randomUUID ?? createRandomUUID;
  const tempPath = path.join(
    stateDir,
    `.builds.json.${randomUUID()}.tmp`,
  );
  const readFileText = overrides.readFileText ?? defaultReadFileText;
  const writeFileText = overrides.writeFileText ?? defaultWriteFileText;
  const renamePath = overrides.renamePath ?? defaultRenamePath;
  const removePath = overrides.removePath ?? defaultRemovePath;
  let operationError;
  let tempMayBelongToWriter = false;

  validateIncomingBuildProvenance(record);

  try {
    const nextState = {
      version: 1,
      channels: {
        ...(await readExistingBuildProvenance(absoluteStatePath, readFileText)),
        [record.channel]: record,
      },
    };

    try {
      await writeFileText(
        tempPath,
        `${JSON.stringify(nextState, null, 2)}\n`,
        { exclusive: true },
      );
      tempMayBelongToWriter = true;
    } catch (error) {
      tempMayBelongToWriter = !isAlreadyExistsError(error);
      throw error;
    }
    await renamePath(tempPath, absoluteStatePath);
    tempMayBelongToWriter = false;
  } catch (error) {
    operationError = error;
  } finally {
    if (tempMayBelongToWriter) {
      try {
        await removePath(tempPath);
      } catch (cleanupError) {
        operationError = operationError
          ? combineErrors(
              operationError,
              cleanupError,
              'Failed to clean temporary provenance file',
            )
          : cleanupError;
      }
    }
  }

  if (operationError) {
    throw operationError;
  }

  return absoluteStatePath;
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
  const publish = deps.publishBuildChannel ?? publishBuildChannel;
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
        {
          cwd: absoluteRepositoryRoot,
          stage: 'add stable worktree',
        },
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
      await execute(command, args, {
        cwd: path.resolve(sourceRoot, relativeCwd),
        stage: `run ${channel} validation/build command: ${command} ${args.join(' ')}`,
      });
    }

    const candidate = await findCandidate(bundleDir, expectedConfig.appName);
    const identity = await readIdentity(candidate, execute);
    assertBundleIdentity(candidate, identity, expectedConfig);

    if (channel === 'stable') {
      await smokeLaunch(candidate, { executableName: identity.executable });
    }

    const builtAt = now().toISOString();
    const provenance = {
      channel,
      commitSha,
      ...(channel === 'stable' ? { requestedRef } : {}),
      dirty,
      builtAt,
      installedPath: path.join(homeDir, 'Applications', expectedConfig.appName),
      productName: expectedConfig.productName,
      bundleIdentifier: expectedConfig.bundleIdentifier,
    };

    const installedPath = await publish(
      candidate,
      expectedConfig,
      provenance,
      { homeDir },
    );
    if (installedPath !== provenance.installedPath) {
      throw new Error(
        `Published app path "${installedPath}" did not match expected path ` +
          `"${provenance.installedPath}"`,
      );
    }
    result = provenance;
  } catch (error) {
    operationError = error;
  } finally {
    if (stableWorktreeAdded) {
      try {
        await execute(
          'git',
          ['worktree', 'remove', '--force', sourceRoot],
          {
            cwd: absoluteRepositoryRoot,
            stage: 'remove stable worktree',
          },
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
    CFFIXED_USER_HOME: tempHome,
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
  await runCommand('ditto', [source, destination], {
    stage: 'copy app bundle with ditto',
  });
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

async function defaultWriteFileText(filePath, content, options = {}) {
  await writeFile(filePath, content, {
    encoding: 'utf8',
    mode: 0o600,
    ...(options.exclusive ? { flag: 'wx' } : {}),
  });
}

function buildProvenanceLockTimeoutError(error, lockTimeoutSeconds, lockPath) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const diagnostics = stderr === '' || describeError(error).includes(stderr)
    ? describeError(error)
    : `${describeError(error)}\n${stderr}`;

  return new Error(
    `Timed out after ${lockTimeoutSeconds} seconds waiting for build provenance lock ` +
      `"${lockPath}": ${diagnostics}`,
    { cause: error },
  );
}

function buildPublicationLockTimeoutError(error, channel, lockTimeoutSeconds, lockPath) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const diagnostics = stderr === '' || describeError(error).includes(stderr)
    ? describeError(error)
    : `${describeError(error)}\n${stderr}`;

  return new Error(
    `Timed out after ${lockTimeoutSeconds} seconds waiting for ${channel} app ` +
      `publication lock "${lockPath}": ${diagnostics}`,
    { cause: error },
  );
}

function includeChildDiagnostics(error) {
  if (!(error instanceof Error)) {
    return error;
  }

  const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  if (stderr === '' || error.message.includes(stderr)) {
    return error;
  }

  return Object.assign(
    new Error(`${error.message}\nstderr:\n${stderr}`, { cause: error }),
    error,
  );
}

async function readExistingBuildProvenance(statePath, readFileText) {
  try {
    const raw = await readFileText(statePath);
    const parsed = JSON.parse(raw);

    const unknownTopLevelField = findUnknownField(
      parsed,
      BUILD_PROVENANCE_STATE_KEYS,
    );
    if (unknownTopLevelField) {
      throw invalidBuildProvenance(
        statePath,
        `unknown top-level field "${unknownTopLevelField}"`,
      );
    }

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

    validateBuildProvenanceRecord(
      record,
      channelName,
      (detail) => invalidBuildProvenance(statePath, detail),
    );
  }
}

function validateIncomingBuildProvenance(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw invalidIncomingBuildProvenance('record must be an object');
  }

  if (!BUILD_CHANNELS.includes(record.channel)) {
    throw invalidIncomingBuildProvenance('channel must be "stable" or "dev"');
  }

  validateBuildProvenanceRecord(
    record,
    record.channel,
    invalidIncomingBuildProvenance,
  );
}

function validateChannelConfig(channel, requestedChannelConfig) {
  const expected = CHANNEL_CONFIG[channel];

  if (
    !requestedChannelConfig ||
    typeof requestedChannelConfig !== 'object' ||
    Array.isArray(requestedChannelConfig) ||
    findUnknownField(requestedChannelConfig, ['productName', 'bundleIdentifier', 'appName']) ||
    requestedChannelConfig.productName !== expected.productName ||
    requestedChannelConfig.bundleIdentifier !== expected.bundleIdentifier ||
    requestedChannelConfig.appName !== expected.appName
  ) {
    throw invalidIncomingBuildProvenance(
      `channel "${channel}" configuration must exactly match the configured channel identity`,
    );
  }
}

function validateBuildProvenanceRecord(record, channelName, invalid) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw invalid(`channel "${channelName}" must be an object`);
  }

  if (record.channel !== channelName) {
    throw invalid(
      `channel "${channelName}" record must contain channel="${channelName}"`,
    );
  }

  if (typeof record.commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(record.commitSha)) {
    throw invalid(
      `channel "${channelName}" record must contain a 40-character lowercase hexadecimal commitSha`,
    );
  }

  if (typeof record.dirty !== 'boolean') {
    throw invalid(
      `channel "${channelName}" record must contain boolean dirty`,
    );
  }

  if (!isExactIsoTimestamp(record.builtAt)) {
    throw invalid(
      `channel "${channelName}" record must contain builtAt as an exact ISO timestamp`,
    );
  }

  const expectedConfig = CHANNEL_CONFIG[channelName];

  if (typeof record.installedPath !== 'string' || !path.isAbsolute(record.installedPath)) {
    throw invalid(
      `channel "${channelName}" record must contain an absolute installedPath`,
    );
  }

  if (path.basename(record.installedPath) !== expectedConfig.appName) {
    throw invalid(
      `channel "${channelName}" installedPath must end in "${expectedConfig.appName}"`,
    );
  }

  if (record.productName !== expectedConfig.productName) {
    throw invalid(
      `channel "${channelName}" record must contain productName="${expectedConfig.productName}"`,
    );
  }

  if (record.bundleIdentifier !== expectedConfig.bundleIdentifier) {
    throw invalid(
      `channel "${channelName}" record must contain bundleIdentifier="${expectedConfig.bundleIdentifier}"`,
    );
  }

  if (
    channelName === 'stable' &&
    (typeof record.requestedRef !== 'string' || record.requestedRef.trim() === '')
  ) {
    throw invalid(
      'channel "stable" record requestedRef must be nonblank',
    );
  }

  if (
    channelName === 'dev' &&
    Object.prototype.hasOwnProperty.call(record, 'requestedRef')
  ) {
    throw invalid('channel "dev" record requestedRef is forbidden');
  }

  const allowedKeys =
    channelName === 'stable'
      ? [...BUILD_PROVENANCE_BASE_RECORD_KEYS, 'requestedRef']
      : BUILD_PROVENANCE_BASE_RECORD_KEYS;
  const unknownField = findUnknownField(record, allowedKeys);
  if (unknownField) {
    throw invalid(
      `channel "${channelName}" record contains unknown field "${unknownField}"`,
    );
  }
}

function findUnknownField(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const allowed = new Set(allowedKeys);
  return Object.keys(value).find((key) => !allowed.has(key));
}

function validateLockTimeoutSeconds(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_PROVENANCE_LOCK_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `lockTimeoutSeconds must be an integer between 0 and ` +
        `${MAX_PROVENANCE_LOCK_TIMEOUT_SECONDS}`,
    );
  }
}

function isExactIsoTimestamp(value) {
  if (typeof value !== 'string') {
    return false;
  }

  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function invalidIncomingBuildProvenance(detail) {
  return new Error(`Invalid build provenance record: ${detail}`);
}

function invalidBuildProvenance(statePath, detail) {
  return new Error(`Invalid build provenance file at "${statePath}": ${detail}`);
}

function isAlreadyExistsError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 'EEXIST';
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

export async function runCli(argv, deps = {}) {
  const runBuild = deps.runBuild ?? runMacosBuild;
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));

  try {
    const options = parseBuildArguments(argv);
    const result = await runBuild({ ...options, repositoryRoot });
    const sourceState = result.dirty ? 'dirty source' : 'clean source';
    stdout(`Installed ${result.productName} at ${result.installedPath}`);
    stdout(`Source ${result.commitSha} (${sourceState})`);
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (isEntrypoint()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
