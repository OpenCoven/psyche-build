// @ts-check

import { execFile as nodeExecFile } from 'node:child_process';
import {
  mkdtemp as nodeMakeTemporaryDirectory,
  readFile as nodeReadFile,
  rm as nodeRemove,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TERMINATION_SIGNALS = /** @type {const} */ (['SIGHUP', 'SIGINT', 'SIGTERM']);

/**
 * @typedef {{
 *   cwd?: string,
 *   env?: Readonly<Record<string, string>>,
 *   stdin?: string,
 * }} ExecFileRunOptions
 */

/**
 * @typedef {{
 *   stdout: string,
 *   stderr: string,
 *   exitCode: number,
 * }} ExecFileRunResult
 */

/**
 * @typedef {'dry-run' | 'apply' | 'provision'} BeadsSourceMode
 */

/**
 * @typedef {{
 *   pid: number,
 *   exitCode?: string | number | null,
 *   on(signal: NodeJS.Signals, listener: () => void): unknown,
 *   off(signal: NodeJS.Signals, listener: () => void): unknown,
 *   kill(pid: number, signal: NodeJS.Signals): unknown,
 * }} SignalProcess
 */

/**
 * @typedef {(
 *   command: string,
 *   args: readonly string[],
 *   options: ExecFileRunOptions,
 * ) => ExecFileRunResult | Promise<ExecFileRunResult>} ExecFileRun
 */

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(message);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'unknown error';
}

/**
 * @param {typeof nodeExecFile} [execFile]
 * @returns {ExecFileRun}
 */
export function createExecFileRun(execFile = nodeExecFile) {
  return (command, args, options = {}) => new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env == null
          ? process.env
          : { ...process.env, ...options.env },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stringValue(stdout),
          stderr: stringValue(stderr),
          exitCode: error == null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : 1,
        });
      },
    );

    child.stdin?.end(options.stdin);
  });
}

/**
 * @param {ExecFileRunResult} result
 * @param {string} operation
 */
function assertCommandSucceeded(result, operation) {
  if (!Number.isInteger(result.exitCode)) {
    fail(`${operation} runner returned an invalid exit code`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    fail(`${operation} failed: ${detail}`);
  }
}

/**
 * @param {{cwd: string, run: ExecFileRun}} options
 */
export async function bootstrapBeads(options) {
  const result = await options.run('bd', ['bootstrap', '--yes'], { cwd: options.cwd });
  assertCommandSucceeded(result, 'bd bootstrap');
}

/**
 * @param {{cwd: string, run: ExecFileRun, outputPath: string}} options
 */
export async function exportBeads(options) {
  const result = await options.run(
    'bd',
    ['--readonly', 'export', '-o', options.outputPath],
    { cwd: options.cwd },
  );
  assertCommandSucceeded(result, 'bd readonly export');
}

/**
 * @param {string} directory
 * @param {(path: string, options: {recursive: true, force: true}) => Promise<unknown>} remove
 */
function createCleanup(directory, remove) {
  /** @type {Promise<void> | null} */
  let cleanupPromise = null;
  return () => {
    cleanupPromise ??= Promise.resolve(
      remove(directory, { recursive: true, force: true }),
    ).then(() => undefined);
    return cleanupPromise;
  };
}

/**
 * @param {() => Promise<void>} cleanup
 * @param {SignalProcess} signalProcess
 * @returns {() => void}
 */
function installSignalCleanup(cleanup, signalProcess) {
  let disposed = false;
  let handlingSignal = false;
  /** @type {Map<NodeJS.Signals, () => void>} */
  const handlers = new Map();

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const [signal, handler] of handlers) {
      signalProcess.off(signal, handler);
    }
  };

  for (const signal of TERMINATION_SIGNALS) {
    const handler = () => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      void cleanup()
        .catch(() => undefined)
        .finally(() => {
          dispose();
          try {
            signalProcess.kill(signalProcess.pid, signal);
          } catch {
            signalProcess.exitCode = 1;
          }
        });
    };
    handlers.set(signal, handler);
    signalProcess.on(signal, handler);
  }

  return dispose;
}

/**
 * @param {{
 *   cwd: string,
 *   mode?: BeadsSourceMode,
 *   inventoryFile?: string | null,
 *   run?: ExecFileRun,
 *   makeTemporaryDirectory?: (prefix: string) => Promise<string>,
 *   readFile?: (path: string, encoding: 'utf8') => Promise<string>,
 *   remove?: (path: string, options: {recursive: true, force: true}) => Promise<unknown>,
 *   signalProcess?: SignalProcess,
 * }} options
 * @returns {Promise<string>}
 */
export async function loadBeadsSource(options) {
  const readFile = options.readFile ?? nodeReadFile;
  if (options.inventoryFile) {
    return readFile(options.inventoryFile, 'utf8');
  }

  const run = options.run ?? createExecFileRun();
  const mode = options.mode ?? 'apply';
  if (!['dry-run', 'apply', 'provision'].includes(mode)) {
    fail(`Unsupported Beads source mode "${mode}"`);
  }
  const makeTemporaryDirectory = options.makeTemporaryDirectory ?? nodeMakeTemporaryDirectory;
  const remove = options.remove ?? nodeRemove;
  const temporaryDirectory = await makeTemporaryDirectory(
    join(tmpdir(), 'psyche-beads-project-sync-'),
  );
  const outputPath = join(temporaryDirectory, 'issues.jsonl');
  const cleanup = createCleanup(temporaryDirectory, remove);
  const disposeSignalCleanup = installSignalCleanup(
    cleanup,
    options.signalProcess ?? process,
  );

  try {
    if (mode !== 'dry-run') {
      await bootstrapBeads({ cwd: options.cwd, run });
    }
    try {
      await exportBeads({ cwd: options.cwd, run, outputPath });
    } catch (error) {
      if (mode === 'dry-run') {
        throw new Error(
          `${errorMessage(error)}. Dry-run source loading is read-only and will not initialize Beads. `
          + 'If the database is missing or uninitialized, run `bd bootstrap --yes` and retry.',
          { cause: error },
        );
      }
      throw error;
    }
    return await readFile(outputPath, 'utf8');
  } finally {
    disposeSignalCleanup();
    await cleanup();
  }
}
