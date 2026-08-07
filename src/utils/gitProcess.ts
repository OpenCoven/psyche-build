import { spawn } from 'node:child_process';

export interface GitProcessResult {
  exitCode: number | null;
  stderr: string;
}

/**
 * Runs Git without a shell. Lifecycle callers use this for operations whose
 * successful child exit is the only proof that this process created a target.
 */
export function runGitProcess(
  args: readonly string[],
  cwd: string,
): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({ exitCode, stderr: stderr.trim() });
    });
  });
}
