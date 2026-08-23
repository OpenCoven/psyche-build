// @ts-check

import { execFile as nodeExecFile } from 'node:child_process';
import {
  mkdtemp as nodeMakeTemporaryDirectory,
  readFile as nodeReadFile,
  rm as nodeRemove,
} from 'node:fs/promises';
import { join } from 'node:path';

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
 * @param {{
 *   cwd: string,
 *   inventoryFile?: string | null,
 *   run?: ExecFileRun,
 *   makeTemporaryDirectory?: (prefix: string) => Promise<string>,
 *   readFile?: (path: string, encoding: 'utf8') => Promise<string>,
 *   remove?: (path: string, options: {recursive: true, force: true}) => Promise<unknown>,
 * }} options
 * @returns {Promise<string>}
 */
export async function loadBeadsSource(options) {
  const readFile = options.readFile ?? nodeReadFile;
  if (options.inventoryFile) {
    return readFile(options.inventoryFile, 'utf8');
  }

  const run = options.run ?? createExecFileRun();
  const makeTemporaryDirectory = options.makeTemporaryDirectory ?? nodeMakeTemporaryDirectory;
  const remove = options.remove ?? nodeRemove;
  const temporaryDirectory = await makeTemporaryDirectory(
    join(options.cwd, '.beads-project-sync-'),
  );
  const outputPath = join(temporaryDirectory, 'issues.jsonl');

  try {
    await bootstrapBeads({ cwd: options.cwd, run });
    await exportBeads({ cwd: options.cwd, run, outputPath });
    return await readFile(outputPath, 'utf8');
  } finally {
    await remove(temporaryDirectory, { recursive: true, force: true });
  }
}
