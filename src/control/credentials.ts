import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import {
  psycheUserConfigDirectory,
  resolveControlCredentialPaths,
  taskCredentialLockDirectoryPath,
  taskCredentialRecordPath,
  type ResolvedControlCredentialPaths,
} from './credentialPaths.js';
import { getProcessStartIdentity, isProcessAlive, isSafeProcessStartIdentity } from '../services/ProcessIdentity.js';
import { canonicalizeProjectRoot, normalizeCanonicalProjectIdentity } from './projectIdentity.js';

export type ControlPrincipalKind = 'operator' | 'agent' | 'compatibility';
export type ControlCapability = 'read' | 'mutate' | 'delegate';

export interface ControlPrincipal {
  id: string;
  kind: ControlPrincipalKind;
  capabilities: readonly ControlCapability[];
}

export interface ControlTaskBinding {
  taskId: string;
  subjectId: string;
}

export interface ControlTaskCredentialReference {
  taskBinding: ControlTaskBinding;
  principalId: string;
}

export interface IssuedControlTaskCredential extends ControlTaskCredentialReference {
  token: string;
  replaced?: ControlTaskCredentialReference;
}

export type RevokedControlTaskCredential = ControlTaskCredentialReference;

export interface AuthenticatedControlIdentity {
  principal: ControlPrincipal;
  taskBinding?: ControlTaskBinding;
}

export interface ControlCredentialStore {
  authenticate(token: string): Promise<AuthenticatedControlIdentity | null>;
  operatorToken(): Promise<string>;
  agentToken(): Promise<string>;
  currentTaskCredential?(taskId: string): Promise<ControlTaskCredentialReference | null>;
}

const OPERATOR_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate', 'delegate'];
const AGENT_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate'];
const COMPATIBILITY_CAPABILITIES: readonly ControlCapability[] = ['read', 'mutate'];
const TASK_CREDENTIAL_SCHEMA = 'psyche.control.task-credential/v1' as const;
const TASK_CREDENTIAL_LOCK_RECORD_FILE = 'lock.json' as const;
const TASK_CREDENTIAL_LOCK_RECOVERY_CLAIM_FILE = 'recovery.claim.json' as const;
const TASK_CREDENTIAL_LOCK_TIMEOUT_MS = 30_000;
const TASK_CREDENTIAL_LOCK_POLL_INTERVAL_MS = 50;
const TASK_CREDENTIAL_TEST_HOOK_POLL_INTERVAL_MS = 10;
const TASK_CREDENTIAL_LOCK_METADATA_MAX_BYTES = 8 * 1024;
const CONTROL_CREDENTIAL_FILE_MAX_BYTES = 64 * 1024;
const TASK_CREDENTIAL_RECORD_MAX_BYTES = 16 * 1024;
const TASK_CREDENTIAL_LOCK_METADATA_DECODER = new TextDecoder('utf-8', { fatal: true });

interface StoredCredentials {
  operatorToken: string;
  agentToken: string;
}

interface StoredTaskCredentialRecord {
  schema: typeof TASK_CREDENTIAL_SCHEMA;
  taskId: string;
  subjectId: string;
  principalId: string;
  tokenFingerprint: string;
  issuedAt: string;
}

interface TaskCredentialMutationLockRecord {
  pid: number;
  processStartIdentity?: string;
  nonce: string;
  taskId: string;
  operation: 'issue' | 'revoke';
  acquiredAt: string;
}

interface TaskCredentialMutationLockReadResult {
  record?: TaskCredentialMutationLockRecord;
  missing: boolean;
  invalid?: boolean;
  snapshot?: TaskCredentialMetadataSnapshot;
}

interface TaskCredentialMutationLockRecoveryClaim {
  pid: number;
  processStartIdentity?: string;
  claimerNonce: string;
  targetNonce: string;
  targetPid: number;
  targetProcessStartIdentity?: string;
  targetTaskId: string;
  targetOperation: 'issue' | 'revoke';
  targetAcquiredAt: string;
  claimedAt: string;
}

interface TaskCredentialMutationLockRecoveryClaimReadResult {
  claim?: TaskCredentialMutationLockRecoveryClaim;
  missing: boolean;
  invalid?: boolean;
  snapshot?: TaskCredentialMetadataSnapshot;
}

interface TaskCredentialMutationLock {
  nonce: string;
  lockDir: string;
  release(): Promise<void>;
}

interface TaskCredentialMetadataSnapshot {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

interface CredentialDirectoryIdentitySnapshot {
  dev: bigint;
  ino: bigint;
}

interface ValidatedCredentialDirectory {
  path: string;
  snapshot: CredentialDirectoryIdentitySnapshot;
}

interface TaskCredentialMetadataReadResult<T> {
  missing: boolean;
  invalid?: boolean;
  value?: T;
  snapshot?: TaskCredentialMetadataSnapshot;
}

interface CredentialDirectoryReadResult {
  missing: boolean;
  invalid?: boolean;
  snapshot?: CredentialDirectoryIdentitySnapshot;
}

type CredentialDirectoryIdentityChangePolicy = 'unsafe' | 'missing';

interface CredentialDirectoryValidationOptions {
  hardenMode?: number;
  description: string;
  identityChangePolicy?: CredentialDirectoryIdentityChangePolicy;
  beforeStabilityCheck?: (directoryPath: string) => Promise<void>;
}

interface CredentialDirectoryResolutionOptions extends Pick<
  CredentialDirectoryValidationOptions,
  'description' | 'hardenMode'
> {
  create?: boolean;
  allowMissing?: boolean;
  finalComponentIdentityChangePolicy?: CredentialDirectoryIdentityChangePolicy;
  beforeValidateFinalComponent?: (directoryPath: string) => Promise<void>;
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

export function fingerprintControlToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function principalIdForTaskSubject(subjectId: string): string {
  return `task-subject:${subjectId}`;
}

/** File-backed project credentials with defensive project canonicalization. */
export async function createControlCredentialStore(options: {
  projectRoot: string;
  filePath?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<ControlCredentialStore> {
  const root = await canonicalizeProjectRoot(options.projectRoot);
  const filePath = options.filePath === undefined
    ? undefined
    : path.join(root, path.relative(path.resolve(options.projectRoot), path.resolve(options.filePath)));
  return createControlCredentialStoreForCanonicalRoot({
    canonicalProjectRoot: root,
    ...(filePath === undefined ? {} : { filePath }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
}

/**
 * Trusted launcher-only helper that rotates the single active task credential
 * for a task and returns the replacement token.
 */
export async function issueControlTaskToken(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<string> {
  return (await issueControlTaskCredential(options)).token;
}

/**
 * Trusted launcher-only helper that rotates the single active task credential
 * for a task and returns the new token plus its subject binding.
 */
export async function issueControlTaskCredential(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  previousSubjectId?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<IssuedControlTaskCredential> {
  const root = await canonicalizeProjectRoot(options.projectRoot);
  const filePath = options.filePath === undefined
    ? undefined
    : path.join(root, path.relative(path.resolve(options.projectRoot), path.resolve(options.filePath)));
  return issueControlTaskCredentialForCanonicalRoot({
    canonicalProjectRoot: root,
    taskId: options.taskId,
    ...(filePath === undefined ? {} : { filePath }),
    ...(options.previousSubjectId === undefined ? {} : { previousSubjectId: options.previousSubjectId }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
}

/** Trusted launcher-only helper that revokes the active subject for a task. */
export async function revokeControlTaskCredential(options: {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  subjectId?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<RevokedControlTaskCredential | null> {
  const root = await canonicalizeProjectRoot(options.projectRoot);
  const filePath = options.filePath === undefined
    ? undefined
    : path.join(root, path.relative(path.resolve(options.projectRoot), path.resolve(options.filePath)));
  return revokeControlTaskCredentialForCanonicalRoot({
    canonicalProjectRoot: root,
    taskId: options.taskId,
    ...(filePath === undefined ? {} : { filePath }),
    ...(options.subjectId === undefined ? {} : { subjectId: options.subjectId }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
}

/** Trusted seam for an owner bootstrap that already canonicalized the root. */
export async function createControlCredentialStoreForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  filePath?: string;
  creationOps?: CredentialCreationOps;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<ControlCredentialStore> {
  const root = options.canonicalProjectRoot;
  const paths = resolveControlCredentialPaths({
    canonicalProjectRoot: root,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
  const creationOps = options.creationOps ?? DEFAULT_CREATION_OPS;
  const load = async (): Promise<StoredCredentials> => (
    loadOrCreateCredentials(root, paths, creationOps)
  );

  return {
    async authenticate(token: string): Promise<AuthenticatedControlIdentity | null> {
      if (!token) return null;
      const stored = await load();
      if (constantTimeEquals(token, stored.operatorToken)) {
        return {
          principal: {
            id: 'operator',
            kind: 'operator',
            capabilities: OPERATOR_CAPABILITIES,
          },
        };
      }
      if (constantTimeEquals(token, stored.agentToken)) {
        return {
          principal: {
            id: 'agent',
            kind: 'agent',
            capabilities: AGENT_CAPABILITIES,
          },
        };
      }
      const binding = await findStoredTaskCredential(
        root,
        paths,
        fingerprintControlToken(token),
      );
      if (binding) {
        return {
          principal: {
            id: binding.principalId,
            kind: 'agent',
            capabilities: AGENT_CAPABILITIES,
          },
          taskBinding: Object.freeze({
            taskId: binding.taskId,
            subjectId: binding.subjectId,
          }),
        };
      }
      return null;
    },
    async currentTaskCredential(taskId: string): Promise<ControlTaskCredentialReference | null> {
      const trimmedTaskId = taskId.trim();
      if (!trimmedTaskId) throw new Error('taskId is required');
      const record = await readStoredTaskCredential(
        root,
        paths,
        taskCredentialRecordPath(paths.taskCredentialsDirectory, trimmedTaskId),
      );
      return record ? referenceForStoredTaskCredential(record) : null;
    },
    async operatorToken(): Promise<string> {
      return (await load()).operatorToken;
    },
    async agentToken(): Promise<string> {
      return (await load()).agentToken;
    },
  };
}

/**
 * Trusted seam that rotates the single active task credential for a task after
 * the caller already canonicalized the project root.
 */
export async function issueControlTaskTokenForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<string> {
  return (await issueControlTaskCredentialForCanonicalRoot(options)).token;
}

/**
 * Trusted seam that rotates the single active task credential for a task after
 * the caller already canonicalized the project root.
 */
export async function issueControlTaskCredentialForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
  previousSubjectId?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<IssuedControlTaskCredential> {
  const root = options.canonicalProjectRoot;
  const taskId = options.taskId.trim();
  if (!taskId) throw new Error('taskId is required');
  const previousSubjectId = options.previousSubjectId?.trim();
  if (options.previousSubjectId !== undefined && !previousSubjectId) {
    throw new Error('previousSubjectId is required when provided');
  }
  const paths = resolveControlCredentialPaths({
    canonicalProjectRoot: root,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
  await loadOrCreateCredentials(root, paths, DEFAULT_CREATION_OPS);
  const recordPath = taskCredentialRecordPath(paths.taskCredentialsDirectory, taskId);
  return withTaskCredentialRecordLock(root, paths, taskId, 'issue', async () => {
    const current = await readStoredTaskCredential(root, paths, recordPath);
    if (previousSubjectId !== undefined && current?.subjectId !== previousSubjectId) {
      throw taskCredentialConflict('task credential subject does not match the expected active subject');
    }

    await awaitTaskCredentialMutationTestHook('before-issue-write', taskId);

    const token = randomBytes(32).toString('hex');
    const subjectId = randomUUID();
    const principalId = principalIdForTaskSubject(subjectId);
    const issuedAt = new Date().toISOString();
    const record: StoredTaskCredentialRecord = {
      schema: TASK_CREDENTIAL_SCHEMA,
      taskId,
      subjectId,
      principalId,
      tokenFingerprint: fingerprintControlToken(token),
      issuedAt,
    };
    await writeStoredTaskCredential(root, paths, recordPath, record);

    return {
      token,
      taskBinding: Object.freeze({ taskId, subjectId }),
      principalId,
      ...(current ? { replaced: referenceForStoredTaskCredential(current) } : {}),
    };
  });
}

/** Trusted seam that revokes the active subject for a task on a canonical root. */
export async function revokeControlTaskCredentialForCanonicalRoot(options: {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
  subjectId?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}): Promise<RevokedControlTaskCredential | null> {
  const root = options.canonicalProjectRoot;
  const taskId = options.taskId.trim();
  if (!taskId) throw new Error('taskId is required');
  const subjectId = options.subjectId?.trim();
  if (options.subjectId !== undefined && !subjectId) {
    throw new Error('subjectId is required when provided');
  }
  const paths = resolveControlCredentialPaths({
    canonicalProjectRoot: root,
    ...(options.filePath === undefined ? {} : { filePath: options.filePath }),
    ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
  });
  const recordPath = taskCredentialRecordPath(paths.taskCredentialsDirectory, taskId);
  return withTaskCredentialRecordLock(root, paths, taskId, 'revoke', async () => {
    const directory = await ensureSafeTaskCredentialDirectory(root, paths, {
      allowMissing: true,
      description: 'task credential directory',
    });
    if (!directory) return null;
    const current = await readStoredTaskCredentialResult(root, paths, recordPath);
    if (!current.value || !current.snapshot) return null;
    if (subjectId !== undefined && current.value.subjectId !== subjectId) return null;
    await awaitTaskCredentialMutationTestHook('before-revoke-delete', taskId);
    if (!await deleteStoredTaskCredential(directory, recordPath, current.snapshot)) return null;
    return referenceForStoredTaskCredential(current.value);
  });
}

async function loadOrCreateCredentials(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  creationOps: CredentialCreationOps,
): Promise<StoredCredentials> {
  await ensureSafeCredentialFileParent(canonicalRoot, paths);
  const filePath = paths.credentialFilePath;
  const existing = await readStoredCredentialsForCreation(filePath);
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
      const winner = await readStoredCredentialsForCreation(filePath);
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
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT' && primaryError !== undefined) {
        throw cleanupError;
      }
    }
  }
}

async function readStoredCredentialsResult(filePath: string): Promise<TaskCredentialMetadataReadResult<StoredCredentials>> {
  return readCredentialJsonFile({
    filePath,
    parse: parseStoredCredentials,
    maxBytes: CONTROL_CREDENTIAL_FILE_MAX_BYTES,
    hardenMode: 0o600,
    sameSnapshot: sameReadableTaskCredentialMetadataSnapshot,
  });
}

async function readStoredCredentials(filePath: string): Promise<StoredCredentials | undefined> {
  const result = await readStoredCredentialsResult(filePath);
  if (result.invalid) throw unsafeCredentialPath('credential file is invalid');
  return result.value;
}

async function readStoredCredentialsForCreation(filePath: string): Promise<StoredCredentials | undefined> {
  const deadline = Date.now() + 250;
  while (true) {
    const result = await readStoredCredentialsResult(filePath);
    if (result.value || result.missing) return result.value;
    if (!result.invalid || Date.now() >= deadline) {
      if (result.invalid) throw unsafeCredentialPath('credential file is invalid');
      return undefined;
    }
    await sleep(10);
  }
}

function parseStoredCredentials(value: unknown): StoredCredentials | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed = value as Partial<StoredCredentials>;
  if (
    typeof parsed.operatorToken !== 'string' || !parsed.operatorToken
    || typeof parsed.agentToken !== 'string' || !parsed.agentToken
  ) {
    return undefined;
  }
  return {
    operatorToken: parsed.operatorToken,
    agentToken: parsed.agentToken,
  };
}

function referenceForStoredTaskCredential(
  record: StoredTaskCredentialRecord,
): ControlTaskCredentialReference {
  return Object.freeze({
    taskBinding: Object.freeze({
      taskId: record.taskId,
      subjectId: record.subjectId,
    }),
    principalId: record.principalId,
  });
}

async function findStoredTaskCredential(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  tokenFingerprint: string,
): Promise<StoredTaskCredentialRecord | undefined> {
  const taskDirectory = await ensureSafeTaskCredentialDirectory(canonicalRoot, paths, {
    allowMissing: true,
    description: 'task credential directory',
  });
  if (!taskDirectory) return undefined;
  const entries = await listCredentialDirectoryEntries(taskDirectory);
  const seenTasks = new Set<string>();
  const seenSubjects = new Set<string>();
  const seenPrincipals = new Set<string>();
  const seenFingerprints = new Set<string>();
  let match: StoredTaskCredentialRecord | undefined;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const record = await readStoredTaskCredential(
      canonicalRoot,
      paths,
      path.join(taskDirectory.path, entry),
    );
    if (!record) continue;
    if (
      seenTasks.has(record.taskId)
      || seenSubjects.has(record.subjectId)
      || seenPrincipals.has(record.principalId)
      || seenFingerprints.has(record.tokenFingerprint)
    ) {
      throw unsafeCredentialPath('task credential directory is invalid');
    }
    seenTasks.add(record.taskId);
    seenSubjects.add(record.subjectId);
    seenPrincipals.add(record.principalId);
    seenFingerprints.add(record.tokenFingerprint);
    if (constantTimeEquals(record.tokenFingerprint, tokenFingerprint)) {
      if (match) throw unsafeCredentialPath('task credential directory is invalid');
      match = record;
    }
  }
  return match;
}

function parseStoredTaskCredentialRecord(
  value: unknown,
): StoredTaskCredentialRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed = value as Partial<StoredTaskCredentialRecord>;
  if (
    parsed.schema !== TASK_CREDENTIAL_SCHEMA
    || typeof parsed.taskId !== 'string' || !parsed.taskId.trim()
    || typeof parsed.subjectId !== 'string' || !parsed.subjectId.trim()
    || typeof parsed.principalId !== 'string' || !parsed.principalId.trim()
    || typeof parsed.tokenFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.tokenFingerprint)
    || typeof parsed.issuedAt !== 'string' || !Number.isFinite(Date.parse(parsed.issuedAt))
  ) {
    return undefined;
  }
  const taskId = parsed.taskId.trim();
  const subjectId = parsed.subjectId.trim();
  const principalId = parsed.principalId.trim();
  if (principalId !== principalIdForTaskSubject(subjectId)) {
    return undefined;
  }
  return {
    schema: TASK_CREDENTIAL_SCHEMA,
    taskId,
    subjectId,
    principalId,
    tokenFingerprint: parsed.tokenFingerprint,
    issuedAt: parsed.issuedAt,
  };
}

async function readStoredTaskCredentialResult(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  filePath: string,
): Promise<TaskCredentialMetadataReadResult<StoredTaskCredentialRecord>> {
  const directory = await ensureSafeTaskCredentialDirectory(canonicalRoot, paths, {
    allowMissing: true,
    description: 'task credential directory',
  });
  if (!directory) return { missing: true };
  const result = await readCredentialJsonFile({
    filePath,
    parse: parseStoredTaskCredentialRecord,
    maxBytes: TASK_CREDENTIAL_RECORD_MAX_BYTES,
    hardenMode: 0o600,
    sameSnapshot: sameReadableTaskCredentialMetadataSnapshot,
  });
  if (result.invalid) throw unsafeCredentialPath('task credential file is invalid');
  return result;
}

async function readStoredTaskCredential(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  filePath: string,
): Promise<StoredTaskCredentialRecord | undefined> {
  return (await readStoredTaskCredentialResult(canonicalRoot, paths, filePath)).value;
}

async function writeStoredTaskCredential(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  filePath: string,
  record: StoredTaskCredentialRecord,
): Promise<void> {
  const directory = await ensureSafeTaskCredentialDirectory(canonicalRoot, paths, {
    create: true,
    hardenMode: 0o700,
    description: 'task credential directory',
  });
  if (!directory) throw unsafeCredentialPath('task credential directory is unavailable');
  const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  let temporarySnapshot: TaskCredentialMetadataSnapshot | undefined;
  try {
    if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) {
      throw unsafeCredentialPath('task credential directory changed before publication');
    }
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    temporarySnapshot = snapshotTaskCredentialMetadata(await handle.stat({ bigint: true }));
    await handle.close();
    handle = undefined;
    if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) {
      throw unsafeCredentialPath('task credential directory changed before publication');
    }
    await rename(temporary, filePath);
    const published = await readStoredTaskCredentialResult(canonicalRoot, paths, filePath);
    if (
      !published.value
      || published.value.taskId !== record.taskId
      || published.value.subjectId !== record.subjectId
      || published.value.principalId !== record.principalId
      || published.value.tokenFingerprint !== record.tokenFingerprint
      || published.value.issuedAt !== record.issuedAt
    ) {
      throw unsafeCredentialPath('task credential file changed during publication');
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (directory) {
      await unlinkCredentialFileIfSafe(directory, temporary, temporarySnapshot).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && primaryError === undefined) {
          throw error;
        }
      });
    } else {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && primaryError === undefined) {
          throw error;
        }
      });
    }
  }
}

async function unlinkCredentialFileIfSafe(
  directory: ValidatedCredentialDirectory,
  filePath: string,
  expectedSnapshot?: TaskCredentialMetadataSnapshot,
): Promise<boolean> {
  if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) return false;
  if (expectedSnapshot) {
    const current = await readTaskCredentialMetadataPathSnapshot(filePath);
    if (
      current.missing
      || current.invalid
      || !current.snapshot
      || !sameTaskCredentialMetadataSnapshot(current.snapshot, expectedSnapshot)
    ) {
      return current.missing;
    }
  }
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function deleteStoredTaskCredential(
  directory: ValidatedCredentialDirectory,
  filePath: string,
  expectedSnapshot: TaskCredentialMetadataSnapshot,
): Promise<boolean> {
  if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) {
    throw unsafeCredentialPath('task credential directory changed before revocation');
  }
  if (!await taskCredentialMetadataPathMatchesSnapshot(filePath, expectedSnapshot)) return false;
  const quarantinePath = path.join(
    directory.path,
    `${path.basename(filePath)}.revoked.${randomBytes(12).toString('hex')}.tmp`,
  );
  try {
    await rename(filePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const quarantined = await readTaskCredentialMetadataPathSnapshot(quarantinePath);
  if (
    quarantined.missing
    || quarantined.invalid
    || !quarantined.snapshot
    || !sameTaskCredentialMetadataIdentity(quarantined.snapshot, expectedSnapshot)
  ) {
    throw unsafeCredentialPath('task credential file changed during revocation');
  }
  if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) {
    throw unsafeCredentialPath('task credential directory changed during revocation');
  }
  await unlinkCredentialFileIfSafe(directory, quarantinePath, quarantined.snapshot);
  return true;
}

async function withTaskCredentialRecordLock<T>(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  taskId: string,
  operation: TaskCredentialMutationLockRecord['operation'],
  work: () => Promise<T>,
): Promise<T> {
  const lock = await acquireTaskCredentialRecordLock(canonicalRoot, paths, taskId, operation);
  try {
    return await work();
  } finally {
    await lock.release().catch(() => undefined);
  }
}

async function acquireTaskCredentialRecordLock(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  taskId: string,
  operation: TaskCredentialMutationLockRecord['operation'],
): Promise<TaskCredentialMutationLock> {
  await ensureSafeCredentialFileParent(canonicalRoot, paths);
  const validatedLocksDir = await ensureSafeTaskCredentialLockDirectory(canonicalRoot, paths, {
    create: true,
    hardenMode: 0o700,
    description: 'task credential lock directory',
  });
  if (!validatedLocksDir) throw unsafeCredentialPath('task credential lock directory is unavailable');

  const nonce = randomUUID();
  const lockDir = taskCredentialLockDirectoryPath(validatedLocksDir.path, taskId);
  const candidateDir = `${lockDir}.candidate.${nonce}`;
  const recordPath = path.join(candidateDir, TASK_CREDENTIAL_LOCK_RECORD_FILE);
  const acquiredAt = new Date().toISOString();
  const rawProcessStartIdentity = getProcessStartIdentity(process.pid);
  const processStartIdentity = isSafeProcessStartIdentity(rawProcessStartIdentity)
    ? rawProcessStartIdentity
    : undefined;
  const record: TaskCredentialMutationLockRecord = {
    pid: process.pid,
    ...(processStartIdentity ? { processStartIdentity } : {}),
    nonce,
    taskId,
    operation,
    acquiredAt,
  };
  const deadline = Date.now() + taskCredentialLockTimeoutMs();
  let acquired = false;
  let lastWaitReason = 'another task credential mutation is already in progress';

  try {
    if (!await credentialDirectoryPathMatchesSnapshot(validatedLocksDir.path, validatedLocksDir.snapshot)) {
      throw unsafeCredentialPath('task credential lock directory changed before acquisition');
    }
    await mkdir(candidateDir, { mode: 0o700 });
    await writeTaskCredentialMutationLockRecord(recordPath, record);

    while (true) {
      try {
        if (!await credentialDirectoryPathMatchesSnapshot(validatedLocksDir.path, validatedLocksDir.snapshot)) {
          throw unsafeCredentialPath('task credential lock directory changed during acquisition');
        }
        await rename(candidateDir, lockDir);
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      }

      const current = await readTaskCredentialMutationLockRecord(canonicalRoot, lockDir, taskId);
      if (current.record) {
        const recovery = await readTaskCredentialMutationLockRecoveryClaim(
          canonicalRoot,
          lockDir,
          taskId,
        );
        if (recovery.invalid) {
          lastWaitReason = 'task credential mutation lock recovery metadata is invalid or untrusted';
        } else if (recovery.claim) {
          if (!recoveryClaimTargetsLock(recovery.claim, current.record)) {
            if (await reapTaskCredentialMutationLockRecoveryClaim(canonicalRoot, lockDir, recovery.claim)) continue;
            lastWaitReason = 'task credential mutation lock recovery metadata is stale or inconsistent';
          } else if (isTaskCredentialMutationLockRecoveryClaimStale(recovery.claim)) {
            if (await reapTaskCredentialMutationLockRecoveryClaim(canonicalRoot, lockDir, recovery.claim)) continue;
            lastWaitReason = `stale task credential mutation lock recovery is held by dead or replaced pid ${recovery.claim.pid}`;
          } else {
            await awaitTaskCredentialMutationTestHook('recovery-claim-observed', taskId, {
              claimPid: recovery.claim.pid,
              targetNonce: recovery.claim.targetNonce,
            });
            lastWaitReason = `stale task credential mutation lock recovery is in progress for pid ${recovery.claim.pid}`;
          }
        } else if (isTaskCredentialMutationLockStale(current.record)) {
          if (
            await claimAndQuarantineStaleTaskCredentialMutationLock(
              canonicalRoot,
              lockDir,
              current.record,
            )
          ) continue;
          lastWaitReason = `stale task credential mutation lock recovery is in progress for pid ${current.record.pid}`;
        } else {
          lastWaitReason = `task credential mutation lock is held by live or unverifiable pid ${current.record.pid}`;
        }
      } else if (current.missing) {
        lastWaitReason = 'task credential mutation lock was released while waiting';
        continue;
      } else {
        const recovery = await readTaskCredentialMutationLockRecoveryClaim(
          canonicalRoot,
          lockDir,
          taskId,
        );
        if (recovery.invalid) {
          lastWaitReason = 'task credential mutation lock recovery metadata is invalid or untrusted';
        } else {
          lastWaitReason = 'task credential mutation lock metadata is unavailable, changed, or invalid';
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for task credential mutation lock for ${taskId}: ${lastWaitReason}`,
        );
      }
      await sleep(taskCredentialLockPollIntervalMs(), remainingMs);
    }
  } finally {
    if (!acquired) {
      await rm(candidateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    nonce,
    lockDir,
    release: async () => releaseTaskCredentialRecordLock(canonicalRoot, lockDir, nonce),
  };
}

async function writeTaskCredentialMutationLockRecord(
  filePath: string,
  record: TaskCredentialMutationLockRecord,
): Promise<void> {
  const handle = await openExclusiveTaskCredentialFile(filePath);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function snapshotTaskCredentialMetadata(stats: BigIntStats): TaskCredentialMetadataSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  };
}

function snapshotCredentialDirectoryIdentity(
  stats: BigIntStats,
): CredentialDirectoryIdentitySnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
  };
}

function sameTaskCredentialMetadataSnapshot(
  left: TaskCredentialMetadataSnapshot,
  right: TaskCredentialMetadataSnapshot,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameReadableTaskCredentialMetadataSnapshot(
  left: TaskCredentialMetadataSnapshot,
  right: TaskCredentialMetadataSnapshot,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameTaskCredentialMetadataIdentity(
  left: TaskCredentialMetadataSnapshot,
  right: TaskCredentialMetadataSnapshot,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameCredentialDirectoryIdentitySnapshot(
  left: CredentialDirectoryIdentitySnapshot,
  right: CredentialDirectoryIdentitySnapshot,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizeCredentialPathForComparison(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = normalizeCanonicalProjectIdentity(path.resolve(filePath), platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameCredentialPathForComparison(left: string, right: string): boolean {
  return normalizeCredentialPathForComparison(left) === normalizeCredentialPathForComparison(right);
}

async function credentialPathResolvesToSelf(filePath: string): Promise<boolean> {
  return (await credentialPathResolutionState(filePath)) === 'self';
}

async function credentialPathResolutionState(filePath: string): Promise<'self' | 'missing' | 'other'> {
  try {
    const canonical = normalizeCanonicalProjectIdentity(await realpath(filePath));
    return sameCredentialPathForComparison(canonical, filePath) ? 'self' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function credentialDirectoryReadFlags(): number {
  let flags = constants.O_RDONLY;
  if (process.platform !== 'win32') {
    flags |= constants.O_NOFOLLOW;
    if (typeof constants.O_DIRECTORY === 'number') flags |= constants.O_DIRECTORY;
  }
  return flags;
}

function credentialFileReadFlags(): number {
  let flags = constants.O_RDONLY;
  if (process.platform !== 'win32') {
    flags |= constants.O_NOFOLLOW;
    flags |= constants.O_NONBLOCK;
  }
  return flags;
}

function isSafeCredentialFileStats(stats: BigIntStats): boolean {
  return stats.isFile()
    && !stats.isSymbolicLink()
    && stats.nlink === 1n
    && isOwnedByCurrentUser(stats);
}

function isSafeCredentialDirectoryStats(stats: BigIntStats): boolean {
  return stats.isDirectory()
    && !stats.isSymbolicLink()
    && isOwnedByCurrentUser(stats);
}

async function readTaskCredentialMetadataPathSnapshot(
  filePath: string,
): Promise<TaskCredentialMetadataReadResult<TaskCredentialMetadataSnapshot>> {
  let stats: BigIntStats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { missing: false, invalid: true };
  }
  if (!isSafeCredentialFileStats(stats)) return { missing: false, invalid: true };
  const snapshot = snapshotTaskCredentialMetadata(stats);
  return { missing: false, value: snapshot, snapshot };
}

async function readCredentialDirectoryPathSnapshot(
  directoryPath: string,
): Promise<CredentialDirectoryReadResult> {
  let stats: BigIntStats;
  try {
    stats = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { missing: false, invalid: true };
  }
  if (!isSafeCredentialDirectoryStats(stats)) return { missing: false, invalid: true };
  return {
    missing: false,
    snapshot: snapshotCredentialDirectoryIdentity(stats),
  };
}

async function taskCredentialMetadataPathMatchesSnapshot(
  filePath: string,
  snapshot: TaskCredentialMetadataSnapshot,
): Promise<boolean> {
  const current = await readTaskCredentialMetadataPathSnapshot(filePath);
  return Boolean(
    current.snapshot
    && !current.missing
    && !current.invalid
    && sameTaskCredentialMetadataSnapshot(current.snapshot, snapshot),
  );
}

async function credentialDirectoryPathMatchesSnapshot(
  directoryPath: string,
  snapshot: CredentialDirectoryIdentitySnapshot,
): Promise<boolean> {
  const current = await readCredentialDirectoryPathSnapshot(directoryPath);
  return Boolean(
    current.snapshot
    && !current.missing
    && !current.invalid
    && sameCredentialDirectoryIdentitySnapshot(current.snapshot, snapshot)
    && await credentialPathResolvesToSelf(directoryPath)
  );
}

async function taskCredentialMutationLockDirectoryMatchesSnapshot(
  directory: ValidatedCredentialDirectory,
): Promise<boolean> {
  const current = await readCredentialDirectoryPathSnapshot(directory.path);
  if (current.missing) return false;
  if (current.invalid || !current.snapshot) {
    throw unsafeCredentialPath('task credential mutation lock directory contains an unsafe path component');
  }
  if (!sameCredentialDirectoryIdentitySnapshot(directory.snapshot, current.snapshot)) {
    return false;
  }
  const resolutionState = await credentialPathResolutionState(directory.path);
  if (resolutionState === 'missing') return false;
  if (resolutionState !== 'self') {
    throw unsafeCredentialPath('task credential mutation lock directory contains an unsafe path component');
  }
  return true;
}

async function readBoundedTaskCredentialMetadataText(
  handle: FileHandle,
  snapshot: TaskCredentialMetadataSnapshot,
): Promise<string | undefined> {
  const size = Number(snapshot.size);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) return undefined;
    offset += bytesRead;
  }
  try {
    return TASK_CREDENTIAL_LOCK_METADATA_DECODER.decode(buffer);
  } catch {
    return undefined;
  }
}

async function readCredentialJsonFile<T>(options: {
  filePath: string;
  parse: (value: unknown) => T | undefined;
  maxBytes: number;
  hardenMode?: number;
  sameSnapshot?: (
    left: TaskCredentialMetadataSnapshot,
    right: TaskCredentialMetadataSnapshot,
  ) => boolean;
}): Promise<TaskCredentialMetadataReadResult<T>> {
  const sameSnapshot = options.sameSnapshot ?? sameTaskCredentialMetadataSnapshot;
  const preOpenPath = await readTaskCredentialMetadataPathSnapshot(options.filePath);
  if (preOpenPath.missing) return { missing: true };
  if (preOpenPath.invalid || !preOpenPath.snapshot) return { missing: false, invalid: true };
  if (!await credentialPathResolvesToSelf(options.filePath)) {
    return { missing: false, invalid: true };
  }

  let handle: FileHandle | undefined;
  let closeError: unknown;
  let result: TaskCredentialMetadataReadResult<T> = { missing: false, invalid: true };
  try {
    handle = await open(options.filePath, credentialFileReadFlags());
    const openedStats = await handle.stat({ bigint: true });
    if (!isSafeCredentialFileStats(openedStats)) {
      result = { missing: false, invalid: true };
    } else {
      let openedSnapshot = snapshotTaskCredentialMetadata(openedStats);
      if (!sameSnapshot(preOpenPath.snapshot, openedSnapshot)) {
        result = { missing: false, invalid: true };
      } else {
        if (options.hardenMode !== undefined) {
          await handle.chmod(options.hardenMode);
          const hardenedStats = await handle.stat({ bigint: true });
          if (!isSafeCredentialFileStats(hardenedStats)) {
            result = { missing: false, invalid: true };
            openedSnapshot = snapshotTaskCredentialMetadata(openedStats);
          } else {
            openedSnapshot = snapshotTaskCredentialMetadata(hardenedStats);
          }
        }
        if (openedSnapshot.size > BigInt(options.maxBytes)) {
          result = { missing: false, invalid: true };
        } else {
          const raw = await readBoundedTaskCredentialMetadataText(handle, openedSnapshot);
          if (raw === undefined) {
            result = { missing: false, invalid: true };
          } else {
            const currentStats = await handle.stat({ bigint: true });
            const currentSnapshot = isSafeCredentialFileStats(currentStats)
              ? snapshotTaskCredentialMetadata(currentStats)
              : undefined;
            const currentPath = await readTaskCredentialMetadataPathSnapshot(options.filePath);
            if (
              !currentSnapshot
              || !sameSnapshot(openedSnapshot, currentSnapshot)
              || !currentPath.snapshot
              || currentPath.missing
              || currentPath.invalid
              || !sameSnapshot(openedSnapshot, currentPath.snapshot)
              || !await credentialPathResolvesToSelf(options.filePath)
            ) {
              result = { missing: false, invalid: true };
            } else {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw) as unknown;
              } catch {
                result = { missing: false, invalid: true };
                parsed = undefined;
              }
              if (parsed !== undefined) {
                const value = options.parse(parsed);
                result = value === undefined
                  ? { missing: false, invalid: true }
                  : { missing: false, value, snapshot: openedSnapshot };
              }
            }
          }
        }
      }
    }
  } catch (error) {
    result = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { missing: true }
      : { missing: false, invalid: true };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      }
    }
  }
  if (closeError !== undefined) return { missing: false, invalid: true };
  return result;
}

async function readTaskCredentialMetadataJson<T>(
  filePath: string,
  parse: (value: unknown) => T | undefined,
): Promise<TaskCredentialMetadataReadResult<T>> {
  return readCredentialJsonFile({
    filePath,
    parse,
    maxBytes: TASK_CREDENTIAL_LOCK_METADATA_MAX_BYTES,
  });
}

function parseTaskCredentialMutationLockRecord(value: unknown): TaskCredentialMutationLockRecord | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed = value as Partial<TaskCredentialMutationLockRecord>;
  if (
    typeof parsed.pid !== 'number'
    || !Number.isInteger(parsed.pid)
    || parsed.pid <= 0
    || typeof parsed.nonce !== 'string'
    || !parsed.nonce
    || typeof parsed.taskId !== 'string'
    || !parsed.taskId.trim()
    || (parsed.operation !== 'issue' && parsed.operation !== 'revoke')
    || typeof parsed.acquiredAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.acquiredAt))
    || (
      parsed.processStartIdentity !== undefined
      && !isSafeProcessStartIdentity(parsed.processStartIdentity)
    )
  ) {
    return undefined;
  }
  const pid = parsed.pid as number;
  const nonce = parsed.nonce as string;
  const taskId = (parsed.taskId as string).trim();
  const operation = parsed.operation as TaskCredentialMutationLockRecord['operation'];
  const acquiredAt = parsed.acquiredAt as string;
  return {
    pid,
    ...(parsed.processStartIdentity ? { processStartIdentity: parsed.processStartIdentity } : {}),
    nonce,
    taskId,
    operation,
    acquiredAt,
  };
}

function parseTaskCredentialMutationLockRecoveryClaim(
  value: unknown,
): TaskCredentialMutationLockRecoveryClaim | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const parsed = value as Partial<TaskCredentialMutationLockRecoveryClaim>;
  if (
    typeof parsed.pid !== 'number'
    || !Number.isInteger(parsed.pid)
    || parsed.pid <= 0
    || (
      parsed.processStartIdentity !== undefined
      && !isSafeProcessStartIdentity(parsed.processStartIdentity)
    )
    || typeof parsed.claimerNonce !== 'string'
    || !parsed.claimerNonce
    || typeof parsed.targetNonce !== 'string'
    || !parsed.targetNonce
    || typeof parsed.targetPid !== 'number'
    || !Number.isInteger(parsed.targetPid)
    || parsed.targetPid <= 0
    || (
      parsed.targetProcessStartIdentity !== undefined
      && !isSafeProcessStartIdentity(parsed.targetProcessStartIdentity)
    )
    || typeof parsed.targetTaskId !== 'string'
    || !parsed.targetTaskId.trim()
    || (parsed.targetOperation !== 'issue' && parsed.targetOperation !== 'revoke')
    || typeof parsed.targetAcquiredAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.targetAcquiredAt))
    || typeof parsed.claimedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.claimedAt))
  ) {
    return undefined;
  }
  const pid = parsed.pid as number;
  const claimerNonce = parsed.claimerNonce as string;
  const targetNonce = parsed.targetNonce as string;
  const targetPid = parsed.targetPid as number;
  const targetTaskId = (parsed.targetTaskId as string).trim();
  const targetOperation = parsed.targetOperation as TaskCredentialMutationLockRecord['operation'];
  const targetAcquiredAt = parsed.targetAcquiredAt as string;
  const claimedAt = parsed.claimedAt as string;
  return {
    pid,
    ...(parsed.processStartIdentity ? { processStartIdentity: parsed.processStartIdentity } : {}),
    claimerNonce,
    targetNonce,
    targetPid,
    ...(parsed.targetProcessStartIdentity
      ? { targetProcessStartIdentity: parsed.targetProcessStartIdentity }
      : {}),
    targetTaskId,
    targetOperation,
    targetAcquiredAt,
    claimedAt,
  };
}

async function readTaskCredentialMutationLockRecord(
  _canonicalRoot: string,
  lockDir: string,
  taskId?: string,
): Promise<TaskCredentialMutationLockReadResult> {
  const directory = await resolveSafeTaskCredentialMutationLockDirectory(lockDir, taskId);
  if (!directory) return { missing: true };
  const result = await readTaskCredentialMetadataJson(
    path.join(directory.path, TASK_CREDENTIAL_LOCK_RECORD_FILE),
    parseTaskCredentialMutationLockRecord,
  );
  return result.value
    ? { missing: false, record: result.value, snapshot: result.snapshot }
    : { missing: result.missing, invalid: result.invalid };
}

function isTaskCredentialMutationLockStale(record: TaskCredentialMutationLockRecord): boolean {
  if (!isProcessAlive(record.pid)) return true;
  if (!record.processStartIdentity) return false;
  const current = getProcessStartIdentity(record.pid);
  if (!isSafeProcessStartIdentity(current)) return false;
  return current !== record.processStartIdentity;
}

async function writeTaskCredentialMutationLockRecoveryClaim(
  filePath: string,
  claim: TaskCredentialMutationLockRecoveryClaim,
): Promise<TaskCredentialMetadataSnapshot> {
  const temporary = `${filePath}.${process.pid}.${claim.claimerNonce}.tmp`;
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  let temporaryUnlinked = false;
  try {
    handle = await openExclusiveTaskCredentialFile(temporary);
    await handle.writeFile(`${JSON.stringify(claim)}\n`, 'utf8');
    await handle.sync();
    await link(temporary, filePath);
    const claimSnapshot = snapshotTaskCredentialMetadata(await handle.stat({ bigint: true }));
    const publishedBeforeCleanup = await lstat(filePath, { bigint: true });
    if (
      !publishedBeforeCleanup.isFile()
      || publishedBeforeCleanup.isSymbolicLink()
      || publishedBeforeCleanup.nlink !== 2n
      || !isOwnedByCurrentUser(publishedBeforeCleanup)
      || !sameTaskCredentialMetadataIdentity(
        snapshotTaskCredentialMetadata(publishedBeforeCleanup),
        claimSnapshot,
      )
    ) {
      throw unsafeCredentialPath('task credential mutation lock recovery metadata changed during publication');
    }
    await handle.close();
    handle = undefined;
    await unlink(temporary);
    temporaryUnlinked = true;
    const published = await readTaskCredentialMetadataPathSnapshot(filePath);
    if (!published.snapshot || published.missing || published.invalid) {
      throw unsafeCredentialPath('task credential mutation lock recovery metadata changed during publication');
    }
    return published.snapshot;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (!temporaryUnlinked) {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && primaryError === undefined) {
          throw error;
        }
      });
    }
  }
}

async function readTaskCredentialMutationLockRecoveryClaim(
  _canonicalRoot: string,
  lockDir: string,
  taskId?: string,
): Promise<TaskCredentialMutationLockRecoveryClaimReadResult> {
  const directory = await resolveSafeTaskCredentialMutationLockDirectory(lockDir, taskId);
  if (!directory) return { missing: true };
  const result = await readTaskCredentialMetadataJson(
    taskCredentialMutationLockRecoveryClaimPath(directory.path),
    parseTaskCredentialMutationLockRecoveryClaim,
  );
  return result.value
    ? { missing: false, claim: result.value, snapshot: result.snapshot }
    : { missing: result.missing, invalid: result.invalid };
}

function isTaskCredentialMutationLockRecoveryClaimStale(
  claim: TaskCredentialMutationLockRecoveryClaim,
): boolean {
  if (!isProcessAlive(claim.pid)) return true;
  if (!claim.processStartIdentity) return false;
  const current = getProcessStartIdentity(claim.pid);
  if (!isSafeProcessStartIdentity(current)) return false;
  return current !== claim.processStartIdentity;
}

function recoveryClaimTargetsLock(
  claim: TaskCredentialMutationLockRecoveryClaim,
  record: TaskCredentialMutationLockRecord,
): boolean {
  return claim.targetNonce === record.nonce
    && claim.targetPid === record.pid
    && claim.targetTaskId === record.taskId
    && claim.targetOperation === record.operation
    && claim.targetAcquiredAt === record.acquiredAt
    && (claim.targetProcessStartIdentity ?? undefined) === (record.processStartIdentity ?? undefined);
}

function sameTaskCredentialMutationLockRecoveryClaim(
  left: TaskCredentialMutationLockRecoveryClaim,
  right: TaskCredentialMutationLockRecoveryClaim,
): boolean {
  return left.pid === right.pid
    && (left.processStartIdentity ?? undefined) === (right.processStartIdentity ?? undefined)
    && left.claimerNonce === right.claimerNonce
    && left.targetNonce === right.targetNonce
    && left.targetPid === right.targetPid
    && (left.targetProcessStartIdentity ?? undefined) === (right.targetProcessStartIdentity ?? undefined)
    && left.targetTaskId === right.targetTaskId
    && left.targetOperation === right.targetOperation
    && left.targetAcquiredAt === right.targetAcquiredAt
    && left.claimedAt === right.claimedAt;
}

async function claimAndQuarantineStaleTaskCredentialMutationLock(
  canonicalRoot: string,
  lockDir: string,
  record: TaskCredentialMutationLockRecord,
): Promise<boolean> {
  const lockDirectory = await resolveSafeTaskCredentialMutationLockDirectory(lockDir, record.taskId);
  if (!lockDirectory) return true;
  if (!await taskCredentialMutationLockDirectoryMatchesSnapshot(lockDirectory)) return true;
  const claimPath = taskCredentialMutationLockRecoveryClaimPath(lockDirectory.path);
  const rawProcessStartIdentity = getProcessStartIdentity(process.pid);
  const processStartIdentity = isSafeProcessStartIdentity(rawProcessStartIdentity)
    ? rawProcessStartIdentity
    : undefined;
  const claim: TaskCredentialMutationLockRecoveryClaim = {
    pid: process.pid,
    ...(processStartIdentity ? { processStartIdentity } : {}),
    claimerNonce: randomUUID(),
    targetNonce: record.nonce,
    targetPid: record.pid,
    ...(record.processStartIdentity ? { targetProcessStartIdentity: record.processStartIdentity } : {}),
    targetTaskId: record.taskId,
    targetOperation: record.operation,
    targetAcquiredAt: record.acquiredAt,
    claimedAt: new Date().toISOString(),
  };
  let claimed = false;
  let quarantined = false;
  let claimSnapshot: TaskCredentialMetadataSnapshot | undefined;
  try {
    claimSnapshot = await writeTaskCredentialMutationLockRecoveryClaim(claimPath, claim);
    claimed = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    if (code === 'credential_path_unsafe') return false;
    if (code === 'ENOENT') return true;
    throw error;
  }

  try {
    if (!await taskCredentialMutationLockDirectoryMatchesSnapshot(lockDirectory)) return true;
    const current = await readTaskCredentialMutationLockRecord(
      canonicalRoot,
      lockDirectory.path,
      record.taskId,
    );
    if (!current.record) return current.missing;
    if (
      current.record.nonce !== record.nonce
      || !recoveryClaimTargetsLock(claim, current.record)
      || !isTaskCredentialMutationLockStale(current.record)
    ) {
      return false;
    }
    await awaitTaskCredentialMutationTestHook('after-recovery-claim', record.taskId, {
      claimNonce: claim.claimerNonce,
      targetNonce: record.nonce,
    });
    const currentClaim = await readTaskCredentialMutationLockRecoveryClaim(
      canonicalRoot,
      lockDirectory.path,
      record.taskId,
    );
    if (
      !currentClaim.claim
      || !currentClaim.snapshot
      || !claimSnapshot
      || !sameTaskCredentialMutationLockRecoveryClaim(currentClaim.claim, claim)
      || !sameTaskCredentialMetadataSnapshot(currentClaim.snapshot, claimSnapshot)
    ) {
      return currentClaim.missing;
    }
    const currentAfterHook = await readTaskCredentialMutationLockRecord(
      canonicalRoot,
      lockDirectory.path,
      record.taskId,
    );
    if (!currentAfterHook.record) return currentAfterHook.missing;
    if (
      currentAfterHook.record.nonce !== record.nonce
      || !recoveryClaimTargetsLock(claim, currentAfterHook.record)
      || !isTaskCredentialMutationLockStale(currentAfterHook.record)
    ) {
      return false;
    }
    if (!await taskCredentialMutationLockDirectoryMatchesSnapshot(lockDirectory)) return true;
    const quarantineDir = `${lockDirectory.path}.stale.${record.nonce}.${randomBytes(6).toString('hex')}`;
    try {
      await rename(lockDirectory.path, quarantineDir);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    await rm(quarantineDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } finally {
    if (claimed && !quarantined && claimSnapshot) {
      if (
        await credentialDirectoryPathMatchesSnapshot(lockDirectory.path, lockDirectory.snapshot)
        && await taskCredentialMetadataPathMatchesSnapshot(claimPath, claimSnapshot)
      ) {
        await unlink(claimPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      } else {
        await reapTaskCredentialMutationLockRecoveryClaim(canonicalRoot, lockDir, claim).catch(() => undefined);
      }
    }
  }
}

async function reapTaskCredentialMutationLockRecoveryClaim(
  canonicalRoot: string,
  lockDir: string,
  claim: TaskCredentialMutationLockRecoveryClaim,
): Promise<boolean> {
  const lockDirectory = await resolveSafeTaskCredentialMutationLockDirectory(
    lockDir,
    claim.targetTaskId,
  );
  if (!lockDirectory) return true;
  const current = await readTaskCredentialMutationLockRecoveryClaim(
    canonicalRoot,
    lockDirectory.path,
    claim.targetTaskId,
  );
  if (!current.claim || !current.snapshot) return current.missing;
  if (!sameTaskCredentialMutationLockRecoveryClaim(current.claim, claim)) return false;
  const claimPath = taskCredentialMutationLockRecoveryClaimPath(lockDirectory.path);
  if (!await taskCredentialMutationLockDirectoryMatchesSnapshot(lockDirectory)) return true;
  if (!await taskCredentialMetadataPathMatchesSnapshot(claimPath, current.snapshot)) return false;
  const staleClaimPath = path.join(
    lockDirectory.path,
    `${TASK_CREDENTIAL_LOCK_RECOVERY_CLAIM_FILE}.stale.${claim.claimerNonce}.${randomBytes(6).toString('hex')}`,
  );
  try {
    await rename(claimPath, staleClaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  await rm(staleClaimPath, { force: true }).catch(() => undefined);
  return true;
}

async function openExclusiveTaskCredentialFile(filePath: string) {
  return open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
}

async function releaseTaskCredentialRecordLock(
  canonicalRoot: string,
  lockDir: string,
  nonce: string,
): Promise<void> {
  const current = await readTaskCredentialMutationLockRecord(canonicalRoot, lockDir);
  if (!current.record || current.record.nonce !== nonce) return;
  const releasedDir = `${lockDir}.released.${nonce}.${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockDir, releasedDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(releasedDir, { recursive: true, force: true }).catch(() => undefined);
}

async function awaitTaskCredentialMutationTestHook(
  point:
    | 'before-issue-write'
    | 'before-revoke-delete'
    | 'after-lock-dir-snapshot'
    | 'after-recovery-claim'
    | 'recovery-claim-observed',
  taskId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const hookDir = process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_HOOK_DIR?.trim();
  const hookLabel = process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_HOOK_LABEL?.trim();
  const hookPoint = process.env.PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_HOOK_POINT?.trim();
  if (!hookDir || !hookLabel || hookPoint !== point) return;
  await mkdir(hookDir, { recursive: true, mode: 0o700 });
  const readyPath = path.join(hookDir, `${hookLabel}.ready.json`);
  const goPath = path.join(hookDir, `${hookLabel}.go`);
  await writeFile(
    readyPath,
    `${JSON.stringify({ point, taskId, pid: process.pid, ...details })}\n`,
    { mode: 0o600 },
  );
  while (true) {
    try {
      await access(goPath, constants.F_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await sleep(TASK_CREDENTIAL_TEST_HOOK_POLL_INTERVAL_MS);
    }
  }
}

function taskCredentialLockTimingOverride(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function taskCredentialLockTimeoutMs(): number {
  return taskCredentialLockTimingOverride('PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_TIMEOUT_MS')
    ?? TASK_CREDENTIAL_LOCK_TIMEOUT_MS;
}

function taskCredentialLockPollIntervalMs(): number {
  return taskCredentialLockTimingOverride('PSYCHE_CONTROL_TASK_CREDENTIAL_TEST_LOCK_POLL_INTERVAL_MS')
    ?? TASK_CREDENTIAL_LOCK_POLL_INTERVAL_MS;
}

async function sleep(delayMs: number, maxDelayMs = delayMs): Promise<void> {
  const delay = Math.max(0, Math.min(delayMs, maxDelayMs));
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

function ensureCredentialPathWithinBase(
  basePath: string,
  targetPath: string,
  description: string,
): void {
  const relative = path.relative(basePath, path.resolve(targetPath));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeCredentialPath(`${description} escapes the trusted base`);
  }
}

function currentUserUid(): bigint | undefined {
  return typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
}

function isOwnedByCurrentUser(stats: Pick<BigIntStats, 'uid'>): boolean {
  const uid = currentUserUid();
  return uid === undefined || stats.uid === uid;
}

async function validateExistingCredentialDirectory(
  basePath: string,
  directoryPath: string,
  options: CredentialDirectoryValidationOptions,
): Promise<ValidatedCredentialDirectory | undefined> {
  const initial = await readCredentialDirectoryPathSnapshot(directoryPath);
  if (initial.missing) return undefined;
  if (initial.invalid || !initial.snapshot) {
    throw unsafeCredentialPath(`${options.description} contains an unsafe path component`);
  }
  await options.beforeStabilityCheck?.(directoryPath);

  let handle: FileHandle | undefined;
  let snapshot = initial.snapshot;
  try {
    if (process.platform !== 'win32') {
      try {
        handle = await open(directoryPath, credentialDirectoryReadFlags());
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && options.identityChangePolicy === 'missing') return undefined;
        if (code === 'ENOENT') {
          throw unsafeCredentialPath(`${options.description} changed during validation`);
        }
        if (code === 'EACCES' || code === 'ELOOP' || code === 'ENOTDIR' || code === 'EPERM') {
          throw unsafeCredentialPath(`${options.description} contains an unsafe path component`);
        }
        throw error;
      }
      const openedStats = await handle.stat({ bigint: true });
      if (!openedStats.isDirectory() || !isOwnedByCurrentUser(openedStats)) {
        throw unsafeCredentialPath(`${options.description} contains an unsafe path component`);
      }
      const openedSnapshot = snapshotCredentialDirectoryIdentity(openedStats);
      if (!sameCredentialDirectoryIdentitySnapshot(initial.snapshot, openedSnapshot)) {
        if (options.identityChangePolicy === 'missing') return undefined;
        throw unsafeCredentialPath(`${options.description} changed during validation`);
      }
      if (options.hardenMode !== undefined) await handle.chmod(options.hardenMode);
      snapshot = snapshotCredentialDirectoryIdentity(await handle.stat({ bigint: true }));
    } else if (options.hardenMode !== undefined) {
      await chmod(directoryPath, options.hardenMode);
    }

    const current = await readCredentialDirectoryPathSnapshot(directoryPath);
    if (current.missing) {
      if (options.identityChangePolicy === 'missing') return undefined;
      throw unsafeCredentialPath(`${options.description} changed during validation`);
    }
    if (current.invalid || !current.snapshot) {
      throw unsafeCredentialPath(`${options.description} contains an unsafe path component`);
    }
    if (!sameCredentialDirectoryIdentitySnapshot(snapshot, current.snapshot)) {
      if (options.identityChangePolicy === 'missing') return undefined;
      throw unsafeCredentialPath(`${options.description} changed during validation`);
    }
    const resolutionState = await credentialPathResolutionState(directoryPath);
    if (resolutionState === 'missing' && options.identityChangePolicy === 'missing') {
      return undefined;
    }
    if (resolutionState !== 'self') {
      throw unsafeCredentialPath(`${options.description} contains an unsafe path component`);
    }
    const ownedStats = handle
      ? await handle.stat({ bigint: true })
      : await lstat(directoryPath, { bigint: true });
    if (!ownedStats.isDirectory() || !isOwnedByCurrentUser(ownedStats)) {
      throw unsafeCredentialPath(`${options.description} is not owned by the current user`);
    }
    ensureCredentialPathWithinBase(basePath, directoryPath, options.description);
    return { path: directoryPath, snapshot: current.snapshot };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveSafeCredentialDirectory(
  basePath: string,
  directoryPath: string,
  options: CredentialDirectoryResolutionOptions,
): Promise<ValidatedCredentialDirectory | undefined> {
  ensureCredentialPathWithinBase(basePath, directoryPath, options.description);

  const relative = path.relative(basePath, path.resolve(directoryPath));
  const components = relative.split(path.sep).filter(Boolean);
  let current = basePath;
  let resolved = await validateExistingCredentialDirectory(
    basePath,
    current,
    { description: 'trusted credential base' },
  );
  if (!resolved) {
    throw unsafeCredentialPath('trusted credential base is unavailable');
  }
  if (components.length === 0) return resolved;

  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    const isFinal = index === components.length - 1;
    if (options.create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    resolved = await validateExistingCredentialDirectory(
      basePath,
      current,
      {
        description: isFinal ? options.description : 'credential parent directory',
        ...(isFinal && options.hardenMode !== undefined ? { hardenMode: options.hardenMode } : {}),
        ...(isFinal && options.finalComponentIdentityChangePolicy !== undefined
          ? { identityChangePolicy: options.finalComponentIdentityChangePolicy }
          : {}),
        ...(isFinal && options.beforeValidateFinalComponent
          ? { beforeStabilityCheck: options.beforeValidateFinalComponent }
          : {}),
      },
    );
    if (resolved) continue;
    if (options.allowMissing) return undefined;
    throw unsafeCredentialPath(`${options.description} is unavailable`);
  }
  return resolved;
}

async function ensureSafeCredentialParent(
  canonicalRoot: string,
  filePath: string,
): Promise<ValidatedCredentialDirectory> {
  const parent = await resolveSafeCredentialDirectory(canonicalRoot, path.dirname(filePath), {
    create: true,
    hardenMode: 0o700,
    description: 'credential parent directory',
  });
  if (!parent) throw unsafeCredentialPath('credential parent directory is unavailable');
  return parent;
}

async function ensureSafeCredentialDirectory(
  canonicalRoot: string,
  directoryPath: string,
  options: Omit<CredentialDirectoryResolutionOptions, 'description'> & { description?: string } = {},
): Promise<ValidatedCredentialDirectory | undefined> {
  return resolveSafeCredentialDirectory(canonicalRoot, directoryPath, {
    ...options,
    description: options.description ?? 'credential directory',
  });
}

async function ensureSafeControlStateRoot(
  stateRoot: string,
): Promise<ValidatedCredentialDirectory> {
  const normalizedStateRoot = path.resolve(stateRoot);
  const defaultStateRoot = path.join(psycheUserConfigDirectory(), 'control');
  if (sameCredentialPathForComparison(normalizedStateRoot, defaultStateRoot)) {
    const psycheConfigDir = await resolveSafeCredentialDirectory(
      path.resolve(path.dirname(path.dirname(psycheUserConfigDirectory()))),
      psycheUserConfigDirectory(),
      {
        create: true,
        hardenMode: 0o700,
        description: 'psyche user configuration directory',
      },
    );
    if (!psycheConfigDir) throw unsafeCredentialPath('psyche user configuration directory is unavailable');
    const controlStateRoot = await resolveSafeCredentialDirectory(
      psycheConfigDir.path,
      normalizedStateRoot,
      {
        create: true,
        hardenMode: 0o700,
        description: 'control state root',
      },
    );
    if (!controlStateRoot) throw unsafeCredentialPath('control state root is unavailable');
    return controlStateRoot;
  }
  const stateRootParent = await resolveSafeCredentialDirectory(
    path.resolve(path.dirname(normalizedStateRoot)),
    path.dirname(normalizedStateRoot),
    {
      description: 'control state root parent',
    },
  );
  if (!stateRootParent) throw unsafeCredentialPath('control state root parent is unavailable');
  const controlStateRoot = await resolveSafeCredentialDirectory(
    stateRootParent.path,
    normalizedStateRoot,
    {
      create: true,
      hardenMode: 0o700,
      description: 'control state root',
    },
  );
  if (!controlStateRoot) throw unsafeCredentialPath('control state root is unavailable');
  return controlStateRoot;
}

async function ensureSafeControlProjectDirectory(
  paths: ResolvedControlCredentialPaths,
): Promise<ValidatedCredentialDirectory> {
  const controlStateRoot = await ensureSafeControlStateRoot(paths.controlStateRoot);
  const projectsDir = await resolveSafeCredentialDirectory(
    controlStateRoot.path,
    path.join(controlStateRoot.path, 'projects'),
    {
      create: true,
      hardenMode: 0o700,
      description: 'control project directory root',
    },
  );
  if (!projectsDir) throw unsafeCredentialPath('control project directory root is unavailable');
  const projectDir = await resolveSafeCredentialDirectory(
    projectsDir.path,
    paths.projectDirectory,
    {
      create: true,
      hardenMode: 0o700,
      description: 'control project directory',
    },
  );
  if (!projectDir) throw unsafeCredentialPath('control project directory is unavailable');
  return projectDir;
}

async function ensureSafeCredentialFileParent(
  canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
): Promise<ValidatedCredentialDirectory> {
  if (paths.credentialFileTrustRoot === 'project-root') {
    return ensureSafeCredentialParent(canonicalRoot, paths.credentialFilePath);
  }
  return ensureSafeControlProjectDirectory(paths);
}

async function ensureSafeTaskCredentialDirectory(
  _canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  options: Omit<CredentialDirectoryResolutionOptions, 'description'> & { description?: string } = {},
): Promise<ValidatedCredentialDirectory | undefined> {
  const projectDirectory = await ensureSafeControlProjectDirectory(paths);
  return resolveSafeCredentialDirectory(projectDirectory.path, paths.taskCredentialsDirectory, {
    ...options,
    description: options.description ?? 'task credential directory',
  });
}

async function ensureSafeTaskCredentialLockDirectory(
  _canonicalRoot: string,
  paths: ResolvedControlCredentialPaths,
  options: Omit<CredentialDirectoryResolutionOptions, 'description'> & { description?: string } = {},
): Promise<ValidatedCredentialDirectory | undefined> {
  const projectDirectory = await ensureSafeControlProjectDirectory(paths);
  return resolveSafeCredentialDirectory(projectDirectory.path, paths.taskCredentialLocksDirectory, {
    ...options,
    description: options.description ?? 'task credential lock directory',
  });
}

async function resolveSafeTaskCredentialMutationLockDirectory(
  lockDir: string,
  taskId?: string,
): Promise<ValidatedCredentialDirectory | undefined> {
  return resolveSafeCredentialDirectory(path.dirname(lockDir), lockDir, {
    allowMissing: true,
    description: 'task credential mutation lock directory',
    finalComponentIdentityChangePolicy: 'missing',
    ...(taskId
      ? {
          beforeValidateFinalComponent: async (directoryPath: string) => {
            await awaitTaskCredentialMutationTestHook('after-lock-dir-snapshot', taskId, {
              lockDir: directoryPath,
            });
          },
        }
      : {}),
  });
}

async function listCredentialDirectoryEntries(directory: ValidatedCredentialDirectory): Promise<string[]> {
  if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) {
    throw unsafeCredentialPath('credential directory changed before listing');
  }
  const entries = await readdir(directory.path);
  if (!await credentialDirectoryPathMatchesSnapshot(directory.path, directory.snapshot)) {
    throw unsafeCredentialPath('credential directory changed during listing');
  }
  return entries;
}

function taskCredentialMutationLockRecoveryClaimPath(lockDir: string): string {
  return path.join(lockDir, TASK_CREDENTIAL_LOCK_RECOVERY_CLAIM_FILE);
}

function taskCredentialConflict(message: string): Error & { code: 'task_subject_conflict' } {
  return Object.assign(new Error(message), { code: 'task_subject_conflict' as const });
}

function unsafeCredentialPath(message: string): Error & { code: 'credential_path_unsafe' } {
  return Object.assign(new Error(message), { code: 'credential_path_unsafe' as const });
}
