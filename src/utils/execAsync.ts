import { spawn, type SpawnOptions } from 'child_process';
import { EXEC_MAX_BYTES_CODE } from './execBuffers.js';

export interface ExecAsyncOptions extends Omit<SpawnOptions, 'stdio'> {
  /** Timeout in milliseconds. Default: 30000 (30s) */
  timeout?: number;
  /** If true, resolve with empty string on error instead of rejecting */
  silent?: boolean;
  /**
   * Maximum stdout bytes to buffer before the child is killed and the call
   * fails. Default: 16 MiB — far above any command psyche legitimately runs,
   * but bounded so a runaway process cannot exhaust the heap.
   */
  maxBytes?: number;
}

/** Default stdout ceiling. See ExecAsyncOptions.maxBytes. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * stderr is only ever used to build an error message, so it is capped far
 * lower than stdout and simply stops accumulating rather than failing the call.
 */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Async wrapper around child_process.spawn that returns stdout as a string.
 * This is the non-blocking replacement for execSync.
 *
 * @param command - The command to execute (can include spaces)
 * @param options - Spawn options plus timeout and silent flags
 * @returns Promise resolving to trimmed stdout
 *
 * @example
 * // Basic usage
 * const output = await execAsync('tmux list-panes');
 *
 * @example
 * // With timeout
 * const output = await execAsync('git status', { timeout: 5000 });
 *
 * @example
 * // Silent mode (returns empty string on error)
 * const output = await execAsync('tmux has-session -t foo', { silent: true });
 */
export function execAsync(
  command: string,
  options: ExecAsyncOptions = {}
): Promise<string> {
  const {
    timeout = 30000,
    silent = false,
    maxBytes = DEFAULT_MAX_BYTES,
    ...spawnOptions
  } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], {
      shell: true,
      ...spawnOptions,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Chunks are kept as Buffers and decoded once at close. Decoding each
    // chunk in isolation would corrupt any multi-byte character that straddles
    // a chunk boundary.
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let timeoutId: NodeJS.Timeout | undefined;

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeout);
    }

    proc.stdout?.on('data', (data: Buffer) => {
      if (overflowed) return;
      if (stdoutBytes + data.length > maxBytes) {
        // Truncating silently would hand callers a partial result they cannot
        // distinguish from a complete one, so fail loudly instead.
        overflowed = true;
        stdoutChunks.length = 0;
        stdoutBytes = 0;
        proc.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(data);
      stdoutBytes += data.length;
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const room = MAX_STDERR_BYTES - stderrBytes;
      const slice = data.length > room ? data.subarray(0, room) : data;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });

    proc.on('error', (error: Error) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (silent) {
        resolve('');
      } else {
        reject(error);
      }
    });

    proc.on('close', (code: number | null) => {
      if (timeoutId) clearTimeout(timeoutId);

      if (overflowed) {
        if (silent) {
          resolve('');
        } else {
          // Tagged so callers can tell "too much output" from "command failed"
          // and decide what an overflow means for them.
          reject(Object.assign(
            new Error(`Command exceeded ${maxBytes} bytes of output: ${command}`),
            { code: EXEC_MAX_BYTES_CODE },
          ));
        }
        return;
      }

      if (timedOut) {
        if (silent) {
          resolve('');
        } else {
          reject(new Error(`Command timed out after ${timeout}ms: ${command}`));
        }
        return;
      }

      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');

      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8');
        if (silent) {
          resolve('');
        } else {
          const errorMessage = stderr.trim() || `Command failed with exit code ${code}`;
          reject(new Error(errorMessage));
        }
      }
    });
  });
}

/**
 * Execute multiple commands in parallel, returning all results.
 * Uses Promise.allSettled so one failure doesn't fail all.
 *
 * @param commands - Array of commands to execute
 * @param options - Options applied to all commands
 * @returns Array of results (either string or Error)
 *
 * @example
 * const [dims, panes] = await execAsyncParallel([
 *   'tmux display-message -p "#{window_width}x#{window_height}"',
 *   'tmux list-panes -F "#{pane_id}"'
 * ]);
 */
export async function execAsyncParallel(
  commands: string[],
  options: ExecAsyncOptions = {}
): Promise<Array<string | Error>> {
  const results = await Promise.allSettled(
    commands.map(cmd => execAsync(cmd, options))
  );

  return results.map(result =>
    result.status === 'fulfilled' ? result.value : result.reason
  );
}

/**
 * Execute multiple commands in parallel, returning results only on full success.
 * If any command fails, the entire call rejects.
 *
 * @param commands - Array of commands to execute
 * @param options - Options applied to all commands
 * @returns Array of stdout strings in order
 *
 * @example
 * const [opt1, opt2, opt3] = await execAsyncAll([
 *   'tmux set-option -t sess pane-border-status top',
 *   'tmux set-option -t sess pane-border-style "fg=colour240"',
 *   'tmux set-option -t sess pane-border-format " #{pane_title} "'
 * ]);
 */
export async function execAsyncAll(
  commands: string[],
  options: ExecAsyncOptions = {}
): Promise<string[]> {
  return Promise.all(commands.map(cmd => execAsync(cmd, options)));
}

/**
 * Race multiple equivalent commands, returning the first successful result.
 * Useful for API fallbacks or trying multiple approaches.
 *
 * @param commands - Array of commands to race
 * @param options - Options applied to all commands
 * @returns First successful stdout
 * @throws If all commands fail
 *
 * @example
 * // Try multiple git commands, use first that succeeds
 * const branch = await execAsyncRace([
 *   'git symbolic-ref refs/remotes/origin/HEAD',
 *   'git show-ref --verify refs/heads/main',
 *   'git branch --show-current'
 * ], { silent: false });
 */
export async function execAsyncRace(
  commands: string[],
  options: Omit<ExecAsyncOptions, 'silent'> = {}
): Promise<string> {
  // Use Promise.any to get first success
  // Each command must NOT be silent so failures actually reject
  return Promise.any(
    commands.map(cmd => execAsync(cmd, { ...options, silent: false }))
  );
}
