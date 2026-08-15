import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import {
  MAX_CONTROL_TASK_ID_LENGTH,
  normalizeControlTaskId,
} from './taskIdentity.js';

export type ControlPrincipalKind = 'operator' | 'agent' | 'compatibility';
export type ControlCapability = 'read' | 'mutate' | 'delegate';

export interface ControlPrincipal {
  id: string;
  kind: ControlPrincipalKind;
  capabilities: readonly ControlCapability[];
}

export interface ControlTaskBinding {
  taskId: string;
}

export interface AuthenticatedControlIdentity extends ControlPrincipal {
  principal: ControlPrincipal;
  taskBinding?: ControlTaskBinding;
}

export interface ControlCredentialStore {
  authenticate(token: string): Promise<AuthenticatedControlIdentity | null>;
  operatorToken(): Promise<string>;
  agentToken(): Promise<string>;
}

const OPERATOR_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate', 'delegate'];
const AGENT_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate'];
const COMPATIBILITY_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate'];

interface StoredCredentials {
  operatorToken: string;
  agentToken: string;
}

export interface CredentialTemporaryHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface CredentialCreationOps {
  openTemporary(filePath: string): Promise<CredentialTemporaryHandle>;
  publish(temporary: string, target: string): Promise<void>;
  removeTemporary(filePath: string): Promise<void>;
}

const DEFAULT_CREATION_OPS: CredentialCreationOps = {
  openTemporary: (filePath) => open(filePath, 'wx', 0o600),
  publish: link,
  removeTemporary: unlink,
};

/** Per-path coordination complements the cross-process atomic link below. */
const credentialLoads = new Map<string, Promise<StoredCredentials>>();

export function compatibilityPrincipal(id: string): ControlPrincipal {
  return { id, kind: 'compatibility', capabilities: COMPATIBILITY_CAPABILITIES };
}

export function capabilitiesForKind(kind: ControlPrincipalKind): readonly ControlCapability[] {
  switch (kind) {
    case 'operator': return OPERATOR_CAPABILITIES;
    case 'agent': return AGENT_CAPABILITIES;
    case 'compatibility': return COMPATIBILITY_CAPABILITIES;
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** File-backed project credentials with defensive project canonicalization. */
export async function createControlCredentialStore(options: {
  projectRoot: string;
  filePath?: string;
}): Promise<ControlCredentialStore> {
  const root = await canonicalizeProjectRoot(options.projectRoot);
  const filePath = resolvePublicCredentialPath(options.projectRoot, root, options.filePath);
  return createControlCredentialStoreForCanonicalRoot({
    canonicalProjectRoot: root,
    ...(filePath === undefined ? {} : { filePath }),
  });
}

export async function issueControlTaskToken(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
}): Promise<string> {
  const root = await canonicalizeProjectRoot(options.projectRoot);
  const filePath = resolvePublicCredentialPath(options.projectRoot, root, options.filePath);
  return issueControlTaskTokenForCanonicalRoot({
    canonicalProjectRoot: root,
    taskId: options.taskId,
    ...(filePath === undefined ? {} : { filePath }),
  });
}

export async function issueControlTaskTokenForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
}): Promise<string> {
  const taskId = normalizeControlTaskId(options.taskId);
  if (taskId === undefined) {
    if (typeof options.taskId === 'string' && options.taskId.trim().length > 0) {
      throw new TypeError(`taskId must be at most ${MAX_CONTROL_TASK_ID_LENGTH} characters`);
    }
    throw new TypeError('taskId must not be blank');
  }
  const filePath = resolveCredentialPath(options.canonicalProjectRoot, options.filePath);
  const token = randomBytes(32).toString('hex');
  const bindingPath = taskBindingPath(filePath, token);
  await ensureSafeCredentialParent(options.canonicalProjectRoot, bindingPath);
  await writeTaskBinding(bindingPath, { taskId });
  return token;
}

/** Trusted seam for an owner bootstrap that already canonicalized the root. */
export async function createControlCredentialStoreForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  filePath?: string;
  creationOps?: CredentialCreationOps;
}): Promise<ControlCredentialStore> {
  const root = options.canonicalProjectRoot;
  const filePath = resolveCredentialPath(root, options.filePath);
  let cache: StoredCredentials | null = null;

  const load = async (): Promise<StoredCredentials> => {
    if (cache) return cache;
    let pending = credentialLoads.get(filePath);
    if (!pending) {
      pending = loadOrCreateCredentials(root, filePath, options.creationOps ?? DEFAULT_CREATION_OPS);
      credentialLoads.set(filePath, pending);
      void pending.finally(() => {
        if (credentialLoads.get(filePath) === pending) credentialLoads.delete(filePath);
      }).catch(() => undefined);
    }
    cache = await pending;
    return cache;
  };

  return {
    async authenticate(token: string): Promise<AuthenticatedControlIdentity | null> {
      if (!token) return null;
      const stored = await load();
      const operatorMatches = constantTimeEquals(token, stored.operatorToken);
      const agentMatches = constantTimeEquals(token, stored.agentToken);
      if (operatorMatches) {
        return authenticatedIdentity({
          id: 'operator',
          kind: 'operator',
          capabilities: OPERATOR_CAPABILITIES,
        });
      }
      if (agentMatches) {
        return authenticatedIdentity({
          id: 'agent',
          kind: 'agent',
          capabilities: AGENT_CAPABILITIES,
        });
      }
      const bindingPath = taskBindingPath(filePath, token);
      await ensureSafeCredentialParent(root, bindingPath);
      const taskBinding = await readStoredTaskBinding(bindingPath);
      return taskBinding === undefined
        ? null
        : authenticatedIdentity(
          { id: 'agent', kind: 'agent', capabilities: AGENT_CAPABILITIES },
          taskBinding,
        );
    },
    async operatorToken(): Promise<string> {
      return (await load()).operatorToken;
    },
    async agentToken(): Promise<string> {
      return (await load()).agentToken;
    },
  };
}

function authenticatedIdentity(
  principal: ControlPrincipal,
  taskBinding?: ControlTaskBinding,
): AuthenticatedControlIdentity {
  return {
    ...principal,
    principal,
    ...(taskBinding === undefined ? {} : { taskBinding }),
  };
}

function resolvePublicCredentialPath(
  projectRoot: string,
  canonicalRoot: string,
  filePath: string | undefined,
): string | undefined {
  return filePath === undefined
    ? undefined
    : path.join(canonicalRoot, path.relative(path.resolve(projectRoot), path.resolve(filePath)));
}

function resolveCredentialPath(canonicalRoot: string, filePath: string | undefined): string {
  return path.resolve(
    filePath ?? path.join(canonicalRoot, '.psyche', 'runtime', 'control-credentials.json'),
  );
}

function taskBindingPath(filePath: string, token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return path.join(path.dirname(filePath), 'control-task-bindings', `${digest}.json`);
}

async function loadOrCreateCredentials(
  canonicalRoot: string,
  filePath: string,
  creationOps: CredentialCreationOps,
): Promise<StoredCredentials> {
  await ensureSafeCredentialParent(canonicalRoot, filePath);
  const existing = await readStoredCredentials(filePath);
  if (existing) return existing;

  const created: StoredCredentials = {
    operatorToken: randomBytes(32).toString('hex'),
    agentToken: randomBytes(32).toString('hex'),
  };
  const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let handle: CredentialTemporaryHandle | undefined;
  let primaryError: unknown;
  try {
    handle = await creationOps.openTemporary(temporary);
    await handle.writeFile(`${JSON.stringify(created)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    // A hard link publishes the fully written inode without overwriting a
    // winner from another process. Unlike rename, this is no-clobber atomic.
    await creationOps.publish(temporary, filePath);
    return created;
  } catch (error) {
    primaryError = error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = await readStoredCredentials(filePath);
      if (!winner) throw unsafeCredentialPath('credential winner disappeared during creation');
      primaryError = undefined;
      return winner;
    }
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        if (primaryError === undefined) primaryError = closeError;
      }
    }
    try {
      await creationOps.removeTemporary(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT' && primaryError === undefined) {
        throw cleanupError;
      }
    }
  }
}

async function writeTaskBinding(
  filePath: string,
  binding: ControlTaskBinding,
): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let handle: CredentialTemporaryHandle | undefined;
  let primaryError: unknown;
  try {
    handle = await DEFAULT_CREATION_OPS.openTemporary(temporary);
    await handle.writeFile(`${JSON.stringify(binding)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await DEFAULT_CREATION_OPS.publish(temporary, filePath);
  } catch (error) {
    primaryError = error;
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw unsafeCredentialPath('task binding target already exists');
    }
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        if (primaryError === undefined) primaryError = closeError;
      }
    }
    try {
      await DEFAULT_CREATION_OPS.removeTemporary(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT' && primaryError === undefined) {
        throw cleanupError;
      }
    }
  }
}

async function readStoredCredentials(filePath: string): Promise<StoredCredentials | undefined> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw unsafeCredentialPath('credential path must be a regular file');
  }
  let parsed: Partial<StoredCredentials>;
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw unsafeCredentialPath('credential path must be a regular file');
    await handle.chmod(0o600);
    parsed = JSON.parse(await handle.readFile('utf8')) as Partial<StoredCredentials>;
  } catch {
    throw unsafeCredentialPath('credential file is invalid');
  } finally {
    await handle.close();
  }
  if (
    typeof parsed.operatorToken !== 'string' || !parsed.operatorToken
    || typeof parsed.agentToken !== 'string' || !parsed.agentToken
  ) {
    throw unsafeCredentialPath('credential file is invalid');
  }
  return { operatorToken: parsed.operatorToken, agentToken: parsed.agentToken };
}

async function readStoredTaskBinding(filePath: string): Promise<ControlTaskBinding | undefined> {
  let stats;
  try {
    stats = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw unsafeCredentialPath('task binding path must be a regular file');
  }
  let parsed: Partial<ControlTaskBinding>;
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw unsafeCredentialPath('task binding path must be a regular file');
    }
    await handle.chmod(0o600);
    parsed = JSON.parse(await handle.readFile('utf8')) as Partial<ControlTaskBinding>;
  } catch {
    throw unsafeCredentialPath('task binding file is invalid');
  } finally {
    await handle.close();
  }
  const taskId = normalizeControlTaskId(parsed.taskId);
  if (taskId === undefined) {
    throw unsafeCredentialPath('task binding file is invalid');
  }
  return { taskId };
}

async function ensureSafeCredentialParent(canonicalRoot: string, filePath: string): Promise<void> {
  const relative = path.relative(canonicalRoot, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeCredentialPath('credential path escapes the canonical project');
  }
  const parent = path.dirname(filePath);
  const parentRelative = path.relative(canonicalRoot, parent);
  let current = canonicalRoot;
  for (const component of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeCredentialPath('credential parent contains an unsafe path component');
    }
  }
  if (parent !== canonicalRoot) await chmod(parent, 0o700);
}

function unsafeCredentialPath(message: string): Error & { code: 'credential_path_unsafe' } {
  return Object.assign(new Error(message), { code: 'credential_path_unsafe' as const });
}
