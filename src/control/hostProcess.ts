import { spawn, type ChildProcess } from 'node:child_process';
import { ControlClient, type ControlClientOptions } from './client.js';
import { canonicalizeProjectRoot } from './projectIdentity.js';

export interface EnsureHostOptions {
  projectRoot: string;
  token: string;
  clientName: string;
  entryPath: string;
}

interface HostProcessDeps {
  connect(options: ControlClientOptions): Promise<ControlClient>;
  spawn(command: string, args: readonly string[], options: {
    detached: true;
    stdio: 'ignore';
  }): Pick<ChildProcess, 'unref' | 'once' | 'exitCode' | 'signalCode'>;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeout(ms: number): Promise<void>;
}

const defaultDeps: HostProcessDeps = {
  connect: (options) => ControlClient.connect(options),
  spawn: (command, args, options) => spawn(command, args, options),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }),
  timeout: (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }),
};

let deps = defaultDeps;

/** Test seam for deterministic startup races and retry timing. */
export function setHostProcessDeps(next: Partial<HostProcessDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...next };
  return () => { deps = previous; };
}

function connectionUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause !== undefined && cause !== error && connectionUnavailable(cause);
}

function unavailableError(diagnostic?: string): Error & { code: string } {
  const suffix = diagnostic ? ` (${diagnostic})` : '';
  return Object.assign(new Error(`control owner unavailable${suffix}`), {
    code: 'control_owner_unavailable',
  });
}

function childDiagnostic(
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  observed?: string,
): string | undefined {
  return observed
    ?? (child.exitCode !== null
      ? `daemon exited with exit code ${child.exitCode}`
      : child.signalCode
        ? `daemon exited with signal ${child.signalCode}`
        : undefined);
}

function safeConnectionError(error: unknown): Error & { code: string } {
  const rawCode = (error as NodeJS.ErrnoException | undefined)?.code;
  const rawMessage = error instanceof Error ? error.message : '';
  if (rawCode === 'EACCES' || /unauthorized|authentication|invalid_token/i.test(rawMessage)) {
    return Object.assign(new Error('control authentication failed'), {
      code: 'control_authentication_failed',
    });
  }
  if (rawCode === 'EPERM' || /permission|forbidden/i.test(rawMessage)) {
    return Object.assign(new Error('control permission denied'), {
      code: 'control_permission_denied',
    });
  }
  return Object.assign(new Error('control protocol error'), {
    code: 'control_protocol_error',
  });
}

async function connectBefore(
  options: ControlClientOptions,
  timeoutMs: number,
): Promise<ControlClient | undefined> {
  let timedOut = false;
  const controller = new AbortController();
  const connecting = deps.connect({ ...options, signal: controller.signal }).then(
    async (client) => {
      if (timedOut) {
        await client.close().catch(() => undefined);
        return undefined;
      }
      return client;
    },
    (error) => {
      if (timedOut) return undefined;
      throw error;
    },
  );
  const timeout = deps.timeout(timeoutMs).then(() => {
    timedOut = true;
    controller.abort();
    return undefined;
  });
  return Promise.race([connecting, timeout]);
}

/**
 * Connect to the one project owner, starting a detached owner only when its
 * project-derived socket is absent. Only this health connection is retried;
 * callers submit each command exactly once after the client is returned.
 */
export async function ensureHostControlPlane(
  options: EnsureHostOptions,
): Promise<ControlClient> {
  const canonicalRoot = await canonicalizeProjectRoot(options.projectRoot);
  const connectOptions: ControlClientOptions = {
    projectRoot: canonicalRoot,
    token: options.token,
    clientName: options.clientName,
  };
  const deadline = deps.now() + 5_000;

  try {
    const client = await connectBefore(connectOptions, deadline - deps.now());
    if (!client) throw unavailableError();
    return client;
  } catch (error) {
    if ((error as { code?: string }).code === 'control_owner_unavailable') throw error;
    if (!connectionUnavailable(error)) throw safeConnectionError(error);
  }

  if (deadline - deps.now() <= 0) throw unavailableError();

  let exitDiagnostic: string | undefined;
  let child: ReturnType<HostProcessDeps['spawn']>;
  try {
    child = deps.spawn(process.execPath, [
      options.entryPath,
      'daemon',
      '--port',
      '0',
      '--project-root',
      canonicalRoot,
    ], { detached: true, stdio: 'ignore' });
  } catch {
    throw unavailableError();
  }
  child.once('exit', (code, signal) => {
    exitDiagnostic = code === null
      ? `daemon exited with signal ${signal ?? 'unknown'}`
      : `daemon exited with exit code ${code}`;
  });
  child.once('error', (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    exitDiagnostic = `daemon failed to start${code ? `: ${code}` : ''}`;
  });
  child.unref();

  let delay = 25;
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw unavailableError(childDiagnostic(child, exitDiagnostic));
    }
    await deps.sleep(Math.min(delay, remaining));
    const connectRemaining = deadline - deps.now();
    if (connectRemaining <= 0) throw unavailableError(childDiagnostic(child, exitDiagnostic));
    try {
      const client = await connectBefore(connectOptions, connectRemaining);
      if (!client) throw unavailableError(childDiagnostic(child, exitDiagnostic));
      return client;
    } catch (error) {
      if ((error as { code?: string }).code === 'control_owner_unavailable') throw error;
      if (!connectionUnavailable(error)) throw safeConnectionError(error);
    }
    delay = Math.min(delay * 2, 250);
  }
}
