import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_024 * 1_024;
const TERMINATION_GRACE_MS = 1_000;

export interface RunProcessOptions {
  args?: readonly string[];
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class RunProcessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'RunProcessError';
  }
}

function appendOutput(
  chunks: Buffer[],
  currentSize: number,
  chunk: Buffer,
  maxOutputBytes: number,
): { size: number; exceeded: boolean } {
  const remaining = maxOutputBytes - currentSize;
  if (remaining <= 0) {
    return { size: currentSize, exceeded: true };
  }

  if (chunk.length > remaining) {
    chunks.push(chunk.subarray(0, remaining));
    return { size: maxOutputBytes, exceeded: true };
  }

  chunks.push(chunk);
  return { size: currentSize + chunk.length, exceeded: false };
}

/**
 * Runs one executable without shell parsing and captures its output.
 */
export function runProcess(
  executable: string,
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return Promise.reject(new TypeError('timeoutMs must be a non-negative finite number'));
  }
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new TypeError('maxOutputBytes must be a positive finite number'));
  }

  return new Promise((resolve, reject) => {
    let process;
    try {
      process = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new RunProcessError(message, -1, ''));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let terminationId: NodeJS.Timeout | undefined;

    const stderr = () => Buffer.concat(stderrChunks).toString('utf8');
    const clearTimers = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (terminationId) clearTimeout(terminationId);
    };
    const fail = (message: string, exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new RunProcessError(message, exitCode, stderr()));
    };
    const terminate = () => {
      try {
        process.kill('SIGTERM');
      } catch {
        return;
      }
      terminationId ??= setTimeout(() => {
        if (process.exitCode === null && process.signalCode === null) {
          process.kill('SIGKILL');
        }
      }, TERMINATION_GRACE_MS);
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }

    process.stdout.on('data', (chunk: Buffer) => {
      const result = appendOutput(stdoutChunks, stdoutSize, chunk, maxOutputBytes);
      stdoutSize = result.size;
      if (result.exceeded) {
        outputExceeded = true;
        terminate();
      }
    });

    process.stderr.on('data', (chunk: Buffer) => {
      const result = appendOutput(stderrChunks, stderrSize, chunk, maxOutputBytes);
      stderrSize = result.size;
      if (result.exceeded) {
        outputExceeded = true;
        terminate();
      }
    });

    process.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(message, -1);
    });

    process.stdin.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(message, -1);
    });

    process.once('close', (code) => {
      if (settled) return;
      clearTimers();

      const exitCode = code ?? -1;
      if (timedOut) {
        fail(`Process timed out after ${timeoutMs}ms: ${executable}`, exitCode);
        return;
      }
      if (outputExceeded) {
        fail(`Process exceeded output limit of ${maxOutputBytes} bytes: ${executable}`, exitCode);
        return;
      }
      if (exitCode !== 0) {
        fail(
          stderr().trim() || `Process failed with exit code ${exitCode}: ${executable}`,
          exitCode,
        );
        return;
      }

      settled = true;
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: stderr(),
        exitCode,
      });
    });

    process.stdin.end(options.input);
  });
}
