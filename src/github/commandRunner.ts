import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import type { ReadOnlyCommandRunner } from './repositoryContext.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_SUMMARY_LENGTH = 512;
const TERMINATION_GRACE_MS = 200;
const INVALID_TIMEOUT_ERROR = 'invalid GitHub command runner timeout';
const INVALID_OUTPUT_LIMIT_ERROR = 'invalid GitHub command runner output limit';
const CONTROL_CHARACTER = /\p{Cc}/gu;
const FORMAT_OR_LINE_SEPARATOR = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9_]+\b/giu;
const ACCESS_TOKEN_ASSIGNMENT_PATTERN =
  /\baccess_token\b\s*(?:[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:token|password|secret|key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;

export type GitHubCommandErrorKind =
  | 'spawn'
  | 'timeout'
  | 'outputLimit'
  | 'exit';

export class GitHubCommandError extends Error {
  readonly name = 'GitHubCommandError';

  constructor(
    public readonly kind: GitHubCommandErrorKind,
    public readonly command: string,
    public readonly exitCode?: number,
    public readonly stderrSummary?: string,
  ) {
    super(`GitHub command failed: ${kind}`);
  }
}

export function createCommandRunner(options: {
  timeoutMs?: number;
  maxOutputBytes?: number;
} = {}): ReadOnlyCommandRunner {
  const timeoutMs = normalizePositiveIntegerOption(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    INVALID_TIMEOUT_ERROR,
  );
  const maxOutputBytes = normalizePositiveIntegerOption(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    INVALID_OUTPUT_LIMIT_ERROR,
  );

  return {
    run(command, args, runOptions) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let totalBytes = 0;
        let stdoutChunks: Buffer[] = [];
        let stderrChunks: Buffer[] = [];
        let timeoutHandle: NodeJS.Timeout | undefined;
        let forceKillHandle: NodeJS.Timeout | undefined;

        const settle = (callback: () => void) => {
          if (settled) {
            return;
          }

          settled = true;
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }

          child.stdout?.off('data', onStdoutData);
          child.stderr?.off('data', onStderrData);
          child.off('error', onError);
          callback();
        };

        const clearForceKillHandle = () => {
          if (forceKillHandle) {
            clearTimeout(forceKillHandle);
            forceKillHandle = undefined;
          }
        };

        const requestTermination = () => {
          if (child.exitCode !== null || child.signalCode !== null) {
            clearForceKillHandle();
            return;
          }

          try {
            child.kill('SIGTERM');
          } catch {
            return;
          }

          if (forceKillHandle) {
            return;
          }

          forceKillHandle = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) {
              clearForceKillHandle();
              return;
            }

            try {
              child.kill('SIGKILL');
            } catch {
              // Ignore termination races.
            }
          }, TERMINATION_GRACE_MS);
          forceKillHandle.unref?.();
        };

        const pushChunk = (target: Buffer[], chunk: Buffer | string) => {
          if (settled) {
            return;
          }

          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.byteLength;

          if (totalBytes > maxOutputBytes) {
            stdoutChunks = [];
            stderrChunks = [];
            requestTermination();
            settle(() => reject(new GitHubCommandError('outputLimit', command)));
            return;
          }

          target.push(buffer);
        };

        const onStdoutData = (chunk: Buffer | string) => {
          pushChunk(stdoutChunks, chunk);
        };

        const onStderrData = (chunk: Buffer | string) => {
          pushChunk(stderrChunks, chunk);
        };

        const onError = () => {
          clearForceKillHandle();
          settle(() => reject(new GitHubCommandError('spawn', command)));
        };

        const onClose = (code: number | null) => {
          clearForceKillHandle();

          if (settled) {
            return;
          }

          const stdout = Buffer.concat(stdoutChunks).toString('utf8');
          const stderr = Buffer.concat(stderrChunks).toString('utf8');

          if (code === 0) {
            settle(() => resolve({ stdout, stderr, exitCode: 0 }));
            return;
          }

          if (runOptions.allowFailure && typeof code === 'number') {
            settle(() => resolve({ stdout, stderr, exitCode: code }));
            return;
          }

          settle(() =>
            reject(
              new GitHubCommandError(
                'exit',
                command,
                typeof code === 'number' ? code : undefined,
                summarizeStderr(stderrChunks),
              ),
            ));
        };

        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(command, [...args], {
            cwd: runOptions.cwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          reject(new GitHubCommandError('spawn', command));
          return;
        }

        if (!child.stdout || !child.stderr) {
          reject(new GitHubCommandError('spawn', command));
          return;
        }

        child.stdout.on('data', onStdoutData);
        child.stderr.on('data', onStderrData);
        child.once('error', onError);
        child.once('close', onClose);

        timeoutHandle = setTimeout(() => {
          requestTermination();
          settle(() => reject(new GitHubCommandError('timeout', command)));
        }, timeoutMs);
        timeoutHandle.unref?.();
      });
    },
  };
}

function normalizePositiveIntegerOption(
  value: number | undefined,
  defaultValue: number,
  errorMessage: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(errorMessage);
  }

  return value;
}

function summarizeStderr(stderrChunks: readonly Buffer[]): string | undefined {
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  if (!stderr) {
    return undefined;
  }

  const sanitized = redactSensitiveText(
    stderr
      .replace(CONTROL_CHARACTER, ' ')
      .replace(FORMAT_OR_LINE_SEPARATOR, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  );

  if (!sanitized) {
    return undefined;
  }

  return sanitized.slice(0, MAX_STDERR_SUMMARY_LENGTH);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(GITHUB_TOKEN_PATTERN, '<redacted>')
    .replace(ACCESS_TOKEN_ASSIGNMENT_PATTERN, '<redacted>')
    .replace(GENERIC_CREDENTIAL_ASSIGNMENT_PATTERN, '<redacted>');
}
