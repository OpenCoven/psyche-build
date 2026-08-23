import type { ChildProcess, ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';

export interface ExecFileRunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}

export interface ExecFileRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFileRun = (
  command: string,
  args: readonly string[],
  options: ExecFileRunOptions,
) => ExecFileRunResult | Promise<ExecFileRunResult>;

export type ExecFileImplementation = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void,
) => ChildProcess;

export function createExecFileRun(execFile?: ExecFileImplementation): ExecFileRun;

export function bootstrapBeads(options: {
  cwd: string;
  run: ExecFileRun;
}): Promise<void>;

export function exportBeads(options: {
  cwd: string;
  run: ExecFileRun;
  outputPath: string;
}): Promise<void>;

export function loadBeadsSource(options: {
  cwd: string;
  inventoryFile?: string | null;
  run?: ExecFileRun;
  makeTemporaryDirectory?: (prefix: string) => Promise<string>;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  remove?: (
    path: string,
    options: { recursive: true; force: true },
  ) => Promise<unknown>;
}): Promise<string>;
