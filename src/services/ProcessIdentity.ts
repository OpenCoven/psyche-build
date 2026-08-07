import { execFileSync } from 'node:child_process';

const PROCESS_IDENTITY_TIMEOUT_MS = 1_000;

export type ProcessStartIdentityResolver = (pid: number) => string | undefined;

/**
 * Returns a stable identity for a currently running process when the platform
 * can provide one. Failure deliberately means "unknown", never "dead".
 */
export function getProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  try {
    const value = execFileSync(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROCESS_IDENTITY_TIMEOUT_MS,
      },
    ).trim();
    return value || undefined;
  } catch {
    // On unsupported platforms, permission failures, and transient command
    // failures, callers must conservatively retain a live owner's lease.
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that a process with this PID exists; treating it as
    // dead could steal a lease owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isSafeProcessStartIdentity(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !/[\r\n\0]/.test(value)
  );
}
