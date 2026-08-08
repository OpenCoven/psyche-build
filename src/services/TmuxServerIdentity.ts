import { execFileSync } from 'node:child_process';
import {
  getProcessStartIdentity,
  isSafeProcessStartIdentity,
  type ProcessStartIdentityResolver,
} from './ProcessIdentity.js';

const TMUX_IDENTITY_TIMEOUT_MS = 1_000;

/**
 * A tmux pane or window ID is only meaningful within this server generation.
 * The PID/start pair prevents PID reuse from binding an old persisted ID to a
 * new tmux server; the optional socket/session values tighten that binding when
 * the installed tmux version exposes them.
 */
export interface TmuxServerIdentity {
  pid: number;
  processStartIdentity: string;
  socketPath?: string;
  sessionId?: string;
}

export function getCurrentTmuxServerIdentity(
  target?: string,
  resolveProcessStartIdentity: ProcessStartIdentityResolver = getProcessStartIdentity,
): TmuxServerIdentity | undefined {
  try {
    const output = execFileSync(
      'tmux',
      [
        'display-message',
        ...(target ? ['-t', target] : []),
        '-p',
        '#{pid}\t#{socket_path}\t#{session_id}',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: TMUX_IDENTITY_TIMEOUT_MS,
      },
    );
    return parseTmuxServerIdentity(output, resolveProcessStartIdentity);
  } catch {
    return undefined;
  }
}

export function parseTmuxServerIdentity(
  output: string,
  resolveProcessStartIdentity: ProcessStartIdentityResolver = getProcessStartIdentity,
): TmuxServerIdentity | undefined {
  const [rawPid, rawSocketPath, rawSessionId] = output
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\t');
  const pid = Number.parseInt(rawPid || '', 10);
  if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== (rawPid || '').trim()) {
    return undefined;
  }
  const processStartIdentity = resolveProcessStartIdentity(pid);
  if (!isSafeProcessStartIdentity(processStartIdentity)) {
    return undefined;
  }

  const socketPath = normalizeTmuxIdentityPart(rawSocketPath);
  const sessionId = normalizeTmuxIdentityPart(rawSessionId);
  return {
    pid,
    processStartIdentity,
    ...(socketPath ? { socketPath } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export function isTmuxServerIdentity(value: unknown): value is TmuxServerIdentity {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const identity = value as Partial<TmuxServerIdentity>;
  return (
    typeof identity.pid === 'number'
    && Number.isInteger(identity.pid)
    && identity.pid > 0
    && isSafeProcessStartIdentity(identity.processStartIdentity)
    && (identity.socketPath === undefined || isSafeTmuxIdentityPart(identity.socketPath))
    && (identity.sessionId === undefined || isSafeTmuxIdentityPart(identity.sessionId))
  );
}

export function sameTmuxServerIdentity(
  left: TmuxServerIdentity,
  right: TmuxServerIdentity,
): boolean {
  return (
    left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && (
      !left.socketPath
      || !right.socketPath
      || left.socketPath === right.socketPath
    )
    && (
      !left.sessionId
      || !right.sessionId
      || left.sessionId === right.sessionId
    )
  );
}

function normalizeTmuxIdentityPart(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return isSafeTmuxIdentityPart(normalized) ? normalized : undefined;
}

function isSafeTmuxIdentityPart(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= 4_096
    && !/[\r\n\0]/.test(value)
  );
}
