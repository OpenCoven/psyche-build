import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalizeProjectRoot } from './projectIdentity.js';

export type ControlPrincipalKind = 'operator' | 'agent' | 'compatibility';
export type ControlCapability = 'read' | 'mutate' | 'delegate';

export interface ControlPrincipal {
  id: string;
  kind: ControlPrincipalKind;
  capabilities: readonly ControlCapability[];
}

export interface ControlCredentialStore {
  authenticate(token: string): Promise<ControlPrincipal | null>;
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
  const filePath = options.filePath === undefined
    ? undefined
    : path.join(root, path.relative(path.resolve(options.projectRoot), path.resolve(options.filePath)));
  return createControlCredentialStoreForCanonicalRoot({
    canonicalProjectRoot: root,
    ...(filePath === undefined ? {} : { filePath }),
  });
}

/** Trusted seam for an owner bootstrap that already canonicalized the root. */
export async function createControlCredentialStoreForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  filePath?: string;
}): Promise<ControlCredentialStore> {
  const root = options.canonicalProjectRoot;
  const filePath = path.resolve(
    options.filePath ?? path.join(root, '.psyche', 'runtime', 'control-credentials.json'),
  );
  let cache: StoredCredentials | null = null;

  const load = async (): Promise<StoredCredentials> => {
    if (cache) return cache;
    let pending = credentialLoads.get(filePath);
    if (!pending) {
      pending = loadOrCreateCredentials(root, filePath);
      credentialLoads.set(filePath, pending);
      void pending.finally(() => {
        if (credentialLoads.get(filePath) === pending) credentialLoads.delete(filePath);
      }).catch(() => undefined);
    }
    cache = await pending;
    return cache;
  };

  return {
    async authenticate(token: string): Promise<ControlPrincipal | null> {
      if (!token) return null;
      const stored = await load();
      if (constantTimeEquals(token, stored.operatorToken)) {
        return { id: 'operator', kind: 'operator', capabilities: OPERATOR_CAPABILITIES };
      }
      if (constantTimeEquals(token, stored.agentToken)) {
        return { id: 'agent', kind: 'agent', capabilities: AGENT_CAPABILITIES };
      }
      return null;
    },
    async operatorToken(): Promise<string> {
      return (await load()).operatorToken;
    },
    async agentToken(): Promise<string> {
      return (await load()).agentToken;
    },
  };
}

async function loadOrCreateCredentials(
  canonicalRoot: string,
  filePath: string,
): Promise<StoredCredentials> {
  await ensureSafeCredentialParent(canonicalRoot, filePath);
  const existing = await readStoredCredentials(filePath);
  if (existing) return existing;

  const created: StoredCredentials = {
    operatorToken: randomBytes(32).toString('hex'),
    agentToken: randomBytes(32).toString('hex'),
  };
  const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(created)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    // A hard link publishes the fully written inode without overwriting a
    // winner from another process. Unlike rename, this is no-clobber atomic.
    await link(temporary, filePath);
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = await readStoredCredentials(filePath);
    if (!winner) throw unsafeCredentialPath('credential winner disappeared during creation');
    return winner;
  } finally {
    await unlink(temporary).catch(() => undefined);
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
