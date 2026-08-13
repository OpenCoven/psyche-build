import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, chmod, link, open, unlink } from 'node:fs/promises';
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
  /** Resolve a bearer token to a principal, or null when it matches nothing. */
  authenticate(token: string): Promise<ControlPrincipal | null>;
  /** The operator (TUI / authenticated human device) token. */
  operatorToken(): Promise<string>;
  /** The agent (MCP) token. */
  agentToken(): Promise<string>;
}

const OPERATOR_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate', 'delegate'];
const AGENT_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate'];
const COMPATIBILITY_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate'];

interface StoredCredentials {
  operatorToken: string;
  agentToken: string;
}

/**
 * A server-minted principal for translated legacy v0 automation.
 *
 * Legacy clients never authenticate against the credential store; the owner
 * stamps this principal so their commands still carry an explicit,
 * non-delegating identity through the single authority.
 */
export function compatibilityPrincipal(id: string): ControlPrincipal {
  return { id, kind: 'compatibility', capabilities: COMPATIBILITY_CAPABILITIES };
}

/** The read-only capability set advertised for each authenticated kind. */
export function capabilitiesForKind(kind: ControlPrincipalKind): readonly ControlCapability[] {
  switch (kind) {
    case 'operator':
      return OPERATOR_CAPABILITIES;
    case 'agent':
      return AGENT_CAPABILITIES;
    case 'compatibility':
      return COMPATIBILITY_CAPABILITIES;
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * A file-backed credential store scoped to one project.
 *
 * Tokens are generated on first use and persisted with mode `0600` under the
 * project runtime directory. The store only ever authenticates the operator
 * and agent principals; compatibility principals are minted by the server.
 */
export async function createControlCredentialStore(options: {
  projectRoot: string;
  filePath?: string;
}): Promise<ControlCredentialStore> {
  const root = await canonicalizeProjectRoot(options.projectRoot);
  const filePath = options.filePath
    ?? path.join(root, '.psyche', 'runtime', 'control-credentials.json');

  let cache: StoredCredentials | null = null;
  let loading: Promise<StoredCredentials> | null = null;

  const loadOnce = async (): Promise<StoredCredentials> => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<StoredCredentials>;
      if (typeof parsed.operatorToken === 'string' && typeof parsed.agentToken === 'string') {
        // Best-effort re-assert 0600 in case an older version or external edit
        // left the token file with looser permissions.
        try {
          await chmod(filePath, 0o600);
        } catch {
          // Non-fatal: on platforms without POSIX modes this is a no-op.
        }
        cache = { operatorToken: parsed.operatorToken, agentToken: parsed.agentToken };
        return cache;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const created: StoredCredentials = {
      operatorToken: randomBytes(32).toString('hex'),
      agentToken: randomBytes(32).toString('hex'),
    };
    const parent = path.dirname(filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(created)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, filePath);
      cache = created;
      return created;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<StoredCredentials>;
      if (typeof parsed.operatorToken !== 'string' || typeof parsed.agentToken !== 'string') {
        throw new Error('invalid control credential file');
      }
      cache = { operatorToken: parsed.operatorToken, agentToken: parsed.agentToken };
      return cache;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };

  const load = async (): Promise<StoredCredentials> => {
    if (cache) return cache;
    loading ??= loadOnce().finally(() => { loading = null; });
    return loading;
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
