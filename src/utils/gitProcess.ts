import { spawn } from 'node:child_process';
import { BoundedOutputBuffer } from './BoundedOutputBuffer.js';

const DEFAULT_MAX_STDERR_BYTES = 1_024 * 1_024;

export interface GitProcessResult {
  exitCode: number | null;
  stderr: string;
}

export interface GitProcessOptions {
  maxStderrBytes?: number;
}

/**
 * Runs Git without a shell. Lifecycle callers use this for operations whose
 * successful child exit is the only proof that this process created a target.
 */
export function runGitProcess(
  args: readonly string[],
  cwd: string,
  options: GitProcessOptions = {},
): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr = new BoundedOutputBuffer(
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    );
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.append(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode, stderr: stderr.toString().trim() });
    });
  });
}
