import { spawn, type ChildProcess } from 'node:child_process';
import { ControlClient, type ControlClientOptions } from './client.js';
import { controlEndpointForProject } from './endpoint.js';
import { canonicalizeProjectRoot } from './projectIdentity.js';

export type ConnectControl = (options: ControlClientOptions) => Promise<ControlClient>;
type SpawnOwner = (
  command: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' },
) => Pick<ChildProcess, 'unref'>;

export interface EnsureHostOptions {
  projectRoot: string;
  token: string;
  clientName: string;
  entryPath: string;
  taskBinding?: ControlClientOptions['taskBinding'];
  connect?: ConnectControl;
  spawn?: SpawnOwner;
  canonicalize?: typeof canonicalizeProjectRoot;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

const OWNER_START_TIMEOUT_MS = 5_000;
const INITIAL_POLL_DELAY_MS = 25;
const MAX_POLL_DELAY_MS = 250;

/**
 * Connect to the one project owner, starting it only when its socket is absent.
 *
 * The retries below establish authenticated health only. Callers receive the
 * connected client and remain responsible for submitting every mutation once.
 */
export async function ensureHostControlPlane(
  options: EnsureHostOptions,
): Promise<ControlClient> {
  const canonicalRoot = await (options.canonicalize ?? canonicalizeProjectRoot)(options.projectRoot);
  return ensureCanonicalHostControlPlane(canonicalRoot, options);
}

/** Trusted internal path for callers that already resolved the project once. */
export async function ensureCanonicalHostControlPlane(
  canonicalRoot: string,
  options: Omit<EnsureHostOptions, 'projectRoot' | 'canonicalize'>,
): Promise<ControlClient> {
  const connectControl = options.connect ?? ControlClient.connectCanonical;
  const spawnOwner = options.spawn ?? ((command, args, spawnOptions) => (
    spawn(command, [...args], spawnOptions)
  ));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const connection = {
    projectRoot: canonicalRoot,
    endpoint: controlEndpointForProject(canonicalRoot),
    token: options.token,
    clientName: options.clientName,
    ...(options.taskBinding === undefined ? {} : { taskBinding: options.taskBinding }),
  };
  const deadline = now() + OWNER_START_TIMEOUT_MS;

  try {
    return await connectBeforeDeadline(connectControl, connection, deadline, now);
  } catch (error) {
    if (!isOwnerAbsent(error)) throw error;
  }

  const child = spawnOwner(
    process.execPath,
    [options.entryPath, 'daemon', '--port', '0', '--project-root', canonicalRoot],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  let delayMs = INITIAL_POLL_DELAY_MS;
  for (;;) {
    try {
      return await connectBeforeDeadline(connectControl, connection, deadline, now);
    } catch (error) {
      if (!isOwnerAbsent(error)) throw error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw ownerUnavailable();
    await sleep(Math.min(delayMs, remaining));
    delayMs = Math.min(delayMs * 2, MAX_POLL_DELAY_MS);
  }
}

async function connectBeforeDeadline(
  connectControl: ConnectControl,
  connection: Omit<ControlClientOptions, 'signal'>,
  deadline: number,
  now: () => number,
): Promise<ControlClient> {
  const remaining = deadline - now();
  if (remaining <= 0) throw ownerUnavailable();

  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const attempt = Promise.resolve().then(() => connectControl({
    ...connection,
    signal: controller.signal,
  }));
  const guardedAttempt = attempt.then(
    (client) => {
      if (!timedOut) return client;
      void client.close().catch(() => undefined);
      throw ownerUnavailable();
    },
    (error: unknown) => {
      if (timedOut) throw ownerUnavailable();
      throw error;
    },
  );
  const deadlineReached = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(ownerUnavailable());
    }, remaining);
  });

  try {
    return await Promise.race([guardedAttempt, deadlineReached]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isOwnerAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

function ownerUnavailable(): Error & { code: 'control_owner_unavailable' } {
  return Object.assign(
    new Error('the project control owner did not become available within five seconds'),
    { code: 'control_owner_unavailable' as const },
  );
}
