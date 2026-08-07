import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_024 * 1_024;
const TERMINATION_GRACE_MS = 250;

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
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
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
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let terminationId: NodeJS.Timeout | undefined;
    let pendingFailure: { message: string; exitCode: number } | undefined;

    const stderr = () => Buffer.concat(stderrChunks).toString('utf8');
    const clearTimers = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (terminationId) {
        clearTimeout(terminationId);
        terminationId = undefined;
      }
    };
    const fail = (message: string, exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(new RunProcessError(message, exitCode, stderr()));
    };

    const destroyStdio = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if (!stream.destroyed) stream.destroy();
      }
    };

    const signalProcessTree = (signal: NodeJS.Signals) => {
      const { pid } = child;

      if (process.platform === 'win32' && pid !== undefined) {
        try {
          const taskkill = spawn(
            'taskkill',
            ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])],
            { stdio: 'ignore', windowsHide: true },
          );
          taskkill.once('error', () => {
            child.kill(signal);
          });
          taskkill.unref();
          return;
        } catch {}
      }

      if (process.platform !== 'win32' && pid !== undefined) {
        try {
          globalThis.process.kill(-pid, signal);
          return;
        } catch {}
      }

      try {
        child.kill(signal);
      } catch {}
    };

    const terminateAndFail = (message: string, exitCode: number) => {
      if (settled || pendingFailure) return;

      pendingFailure = { message, exitCode };
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      signalProcessTree('SIGTERM');
      destroyStdio();

      terminationId = setTimeout(() => {
        signalProcessTree('SIGKILL');
        destroyStdio();
        fail(message, exitCode);
      }, TERMINATION_GRACE_MS);
    };

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        terminateAndFail(`Process timed out after ${timeoutMs}ms: ${executable}`, -1);
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const result = appendOutput(stdoutChunks, stdoutSize, chunk, maxOutputBytes);
      stdoutSize = result.size;
      if (result.exceeded) {
        terminateAndFail(
          `Process exceeded output limit of ${maxOutputBytes} bytes: ${executable}`,
          -1,
        );
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const result = appendOutput(stderrChunks, stderrSize, chunk, maxOutputBytes);
      stderrSize = result.size;
      if (result.exceeded) {
        terminateAndFail(
          `Process exceeded output limit of ${maxOutputBytes} bytes: ${executable}`,
          -1,
        );
      }
    });

    child.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      fail(message, -1);
    });

    child.stdin.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      terminateAndFail(message, -1);
    });

    child.once('close', (code) => {
      if (settled) return;
      if (pendingFailure) return;
      clearTimers();

      const exitCode = code ?? -1;
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

    try {
      child.stdin.end(options.input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      terminateAndFail(message, -1);
    }
  });
}
