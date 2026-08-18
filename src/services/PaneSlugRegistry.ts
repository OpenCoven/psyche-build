import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TmuxServerIdentity } from './TmuxServerIdentity.js';
import {
  acquireProjectPaneSlugAllocationLock,
  readProjectPaneConfigUnderLock,
  type ProjectPaneConfig,
  type ProjectPaneConfigLockOptions,
} from './ProjectPaneConfig.js';
import {
  getProcessStartIdentity,
  isProcessAlive,
  type ProcessStartIdentityResolver,
} from './ProcessIdentity.js';
import { canonicalizePathWithExistingAncestor } from './WorktreePath.js';
import { atomicWriteJson } from '../utils/atomicWrite.js';
import type { TmuxPanePresence } from '../utils/paneTeardown.js';

const PANE_SLUG_RECORD_VERSION = 1;
const PANE_SLUG_DIRECTORY_NAME = 'pane-slug-ownership';

export type PaneSlugOwnershipState = 'provisional' | 'quarantined';

export interface PaneSlugOwnershipRecord {
  version: typeof PANE_SLUG_RECORD_VERSION;
  recoveryId: string;
  state: PaneSlugOwnershipState;
  sessionProjectRoot: string;
  projectRoot: string;
  worktreePath: string;
  slug: string;
  pane: {
    id: string;
    paneId?: string;
    tmuxServerIdentity?: TmuxServerIdentity;
  };
  owner: {
    pid: number;
    processStartIdentity?: string;
    nonce: string;
  };
  operation: string;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  targetMarkerId?: string;
}

export interface PaneSlugAllocationState {
  config: ProjectPaneConfig;
  occupiedSlugs: ReadonlySet<string>;
  persistedSlugs: ReadonlySet<string>;
  ownershipRecords: readonly PaneSlugOwnershipRecord[];
}

export interface PaneSlugCandidate {
  slug: string;
  worktreePath: string;
}

export interface PaneSlugReservation {
  readonly recoveryId: string;
  readonly sessionProjectRoot: string;
  readonly projectRoot: string;
  readonly slug: string;
  readonly paneId: string;
  readonly worktreePath: string;
  readonly effect: {
    paneId: string;
    tmuxServerIdentity?: TmuxServerIdentity;
  } | undefined;
  recordPaneEffect: (
    paneId: string,
    tmuxServerIdentity?: TmuxServerIdentity,
  ) => Promise<void>;
  completeAfterPanePersisted: (pane: {
    id: string;
    paneId: string;
    slug: string;
  }) => Promise<void>;
  clearBeforeEffect: () => Promise<void>;
  clearAfterConfirmedTeardown: (presence: TmuxPanePresence) => Promise<void>;
}

export interface PaneSlugRegistryOwnerProbe {
  isProcessAlive?: (pid: number) => boolean;
  getProcessStartIdentity?: ProcessStartIdentityResolver;
}

export async function reservePaneSlug(
  options: {
    sessionProjectRoot: string;
    projectRoot: string;
    paneId: string;
    operation: string;
    allocate: (
      state: PaneSlugAllocationState,
    ) => PaneSlugCandidate | Promise<PaneSlugCandidate>;
    pid?: number;
    getProcessStartIdentity?: ProcessStartIdentityResolver;
    now?: () => Date;
    createRecoveryId?: () => string;
    createNonce?: () => string;
    lockOptions?: ProjectPaneConfigLockOptions;
  },
): Promise<PaneSlugReservation> {
  const sessionProjectRoot = canonicalizePathWithExistingAncestor(
    options.sessionProjectRoot,
  );
  const projectRoot = canonicalizePathWithExistingAncestor(options.projectRoot);
  const lock = await acquireProjectPaneSlugAllocationLock(
    sessionProjectRoot,
    options.lockOptions,
  );
  try {
    const config = await readProjectPaneConfigUnderLock(sessionProjectRoot);
    const ownershipRecords = await listPaneSlugOwnershipRecords(sessionProjectRoot);
    const persistedSlugs = new Set(extractConfigSlugs(config));
    const occupiedSlugs = new Set([
      ...persistedSlugs,
      ...ownershipRecords.map((record) => record.slug),
    ]);
    const candidate = await options.allocate({
      config,
      occupiedSlugs,
      persistedSlugs,
      ownershipRecords,
    });
    assertPaneSlug(candidate.slug);
    if (occupiedSlugs.has(candidate.slug)) {
      throw new Error(`Pane slug "${candidate.slug}" is already owned`);
    }

    const pid = options.pid ?? process.pid;
    const resolveStartIdentity = options.getProcessStartIdentity
      ?? getProcessStartIdentity;
    const now = options.now ?? (() => new Date());
    const createRecoveryId = options.createRecoveryId ?? randomUUID;
    const createNonce = options.createNonce ?? randomUUID;
    const timestamp = now().toISOString();
    const processStartIdentity = resolveStartIdentity(pid);
    const record: PaneSlugOwnershipRecord = {
      version: PANE_SLUG_RECORD_VERSION,
      recoveryId: createRecoveryId(),
      state: 'provisional',
      sessionProjectRoot,
      projectRoot,
      worktreePath: canonicalizePathWithExistingAncestor(candidate.worktreePath),
      slug: candidate.slug,
      pane: { id: options.paneId },
      owner: {
        pid,
        ...(processStartIdentity
          ? { processStartIdentity }
          : {}),
        nonce: createNonce(),
      },
      operation: options.operation,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertPaneSlugOwnershipRecord(record);
    await writePaneSlugOwnershipRecord(record);
    return createReservation(record, options.lockOptions);
  } finally {
    await lock.release();
  }
}

function createReservation(
  initialRecord: PaneSlugOwnershipRecord,
  lockOptions?: ProjectPaneConfigLockOptions,
): PaneSlugReservation {
  let currentRecord = initialRecord;
  let currentEffect: PaneSlugReservation['effect'];

  const withOwnedRecord = async (
    operation: (record: PaneSlugOwnershipRecord) => Promise<void>,
  ): Promise<void> => {
    const lock = await acquireProjectPaneSlugAllocationLock(
      currentRecord.sessionProjectRoot,
      lockOptions,
    );
    try {
      const record = await readPaneSlugOwnershipRecord(
        currentRecord.sessionProjectRoot,
        currentRecord.recoveryId,
      );
      if (!record) {
        if (currentRecord.state === 'quarantined') {
          return;
        }
        throw new Error(
          `Pane slug ownership ${currentRecord.recoveryId} disappeared before settlement`,
        );
      }
      if (record.owner.nonce !== currentRecord.owner.nonce) {
        throw new Error(
          `Pane slug ownership ${currentRecord.recoveryId} changed owner`,
        );
      }
      currentRecord = record;
      await operation(record);
    } finally {
      await lock.release();
    }
  };

  return {
    get recoveryId() {
      return currentRecord.recoveryId;
    },
    get sessionProjectRoot() {
      return currentRecord.sessionProjectRoot;
    },
    get projectRoot() {
      return currentRecord.projectRoot;
    },
    get slug() {
      return currentRecord.slug;
    },
    get paneId() {
      return currentRecord.pane.id;
    },
    get worktreePath() {
      return currentRecord.worktreePath;
    },
    get effect() {
      return currentEffect;
    },
    recordPaneEffect: async (paneId, tmuxServerIdentity) => {
      currentEffect = {
        paneId,
        ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
      };
      const record = await readPaneSlugOwnershipRecord(
        currentRecord.sessionProjectRoot,
        currentRecord.recoveryId,
      );
      if (!record || record.owner.nonce !== currentRecord.owner.nonce) {
        throw new Error(
          `Pane slug ownership ${currentRecord.recoveryId} changed before effect binding`,
        );
      }
      if (record.state !== 'provisional') {
        throw new Error(
          `Pane slug ownership ${record.recoveryId} is already quarantined`,
        );
      }
      currentRecord = {
        ...record,
        pane: {
          ...record.pane,
          paneId,
          ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
      // This atomic replacement does not change namespace membership: the
      // slug was already reserved under the allocation lock. Avoid acquiring
      // slug after pane-config when daemon creation binds an effect inside a
      // config transaction.
      await writePaneSlugOwnershipRecord(currentRecord);
    },
    completeAfterPanePersisted: async (pane) => {
      await withOwnedRecord(async (record) => {
        const config = await readProjectPaneConfigUnderLock(
          record.sessionProjectRoot,
        );
        const exact = (Array.isArray(config.panes) ? config.panes : []).some(
          (candidate) => {
            if (!candidate || typeof candidate !== 'object') {
              return false;
            }
            const value = candidate as Record<string, unknown>;
            return (
              value.id === pane.id
              && value.paneId === pane.paneId
              && value.slug === pane.slug
            );
          },
        );
        if (!exact) {
          throw new Error(
            `Pane slug "${record.slug}" cannot be released before its exact pane record is durable`,
          );
        }
        await removePaneSlugOwnershipRecord(
          record.sessionProjectRoot,
          record.recoveryId,
        );
      });
    },
    clearBeforeEffect: async () => {
      if (currentEffect) {
        throw new Error(
          `Pane slug "${currentRecord.slug}" has a tmux effect and requires teardown proof`,
        );
      }
      await withOwnedRecord(async (record) => {
        if (record.pane.paneId) {
          throw new Error(
            `Pane slug "${record.slug}" has a durable effect identity and requires teardown proof`,
          );
        }
        await removePaneSlugOwnershipRecord(
          record.sessionProjectRoot,
          record.recoveryId,
        );
      });
    },
    clearAfterConfirmedTeardown: async (presence) => {
      if (presence !== 'absent') {
        throw new Error(
          `Pane slug "${currentRecord.slug}" teardown is ${presence}, not absent`,
        );
      }
      await withOwnedRecord(async (record) => {
        await removePaneSlugOwnershipRecord(
          record.sessionProjectRoot,
          record.recoveryId,
        );
      });
    },
  };
}

export function allocateUniquePaneSlug(
  baseSlug: string,
  occupiedSlugs: ReadonlySet<string>,
  isUnavailable: (slug: string) => boolean | Promise<boolean> = () => false,
): Promise<string> {
  return allocate();

  async function allocate(): Promise<string> {
    for (let index = 0; index < 100; index += 1) {
      const slug = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
      if (!occupiedSlugs.has(slug) && !await isUnavailable(slug)) {
        return slug;
      }
    }
    throw new Error(`Could not allocate a unique pane slug from "${baseSlug}"`);
  }
}

export async function listPaneSlugOwnershipRecords(
  sessionProjectRoot: string,
): Promise<PaneSlugOwnershipRecord[]> {
  const directory = paneSlugOwnershipDirectory(sessionProjectRoot);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const records: PaneSlugOwnershipRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const recordPath = path.join(directory, entry);
    const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as unknown;
    if (!isPaneSlugOwnershipRecord(parsed)) {
      throw new Error(`Invalid pane slug ownership record: ${recordPath}`);
    }
    records.push(parsed);
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function readPaneSlugOwnershipRecord(
  sessionProjectRoot: string,
  recoveryId: string,
): Promise<PaneSlugOwnershipRecord | undefined> {
  assertRecoveryId(recoveryId);
  try {
    const parsed = JSON.parse(await readFile(
      paneSlugOwnershipRecordPath(sessionProjectRoot, recoveryId),
      'utf8',
    )) as unknown;
    if (!isPaneSlugOwnershipRecord(parsed)) {
      throw new Error(`Invalid pane slug ownership record for ${recoveryId}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writePaneSlugOwnershipRecord(
  record: PaneSlugOwnershipRecord,
): Promise<void> {
  assertPaneSlugOwnershipRecord(record);
  const directory = paneSlugOwnershipDirectory(record.sessionProjectRoot);
  await mkdir(directory, { recursive: true });
  await atomicWriteJson(
    paneSlugOwnershipRecordPath(record.sessionProjectRoot, record.recoveryId),
    record,
  );
}

export async function quarantinePaneSlugOwnershipRecord(
  input: {
    sessionProjectRoot: string;
    recoveryId: string;
    projectRoot: string;
    worktreePath: string;
    slug: string;
    pane: PaneSlugOwnershipRecord['pane'];
    operation: string;
    reason: string;
    targetMarkerId: string;
  },
): Promise<PaneSlugOwnershipRecord> {
  const existing = await readPaneSlugOwnershipRecord(
    input.sessionProjectRoot,
    input.recoveryId,
  );
  if (
    existing
    && (
      existing.slug !== input.slug
      || existing.pane.id !== input.pane.id
      || canonicalizePathWithExistingAncestor(existing.projectRoot)
        !== canonicalizePathWithExistingAncestor(input.projectRoot)
    )
  ) {
    throw new Error(
      `Pane slug recovery ${input.recoveryId} conflicts with an existing ownership identity`,
    );
  }
  const ownershipConflict = (await listPaneSlugOwnershipRecords(
    input.sessionProjectRoot,
  )).find((record) => (
    record.recoveryId !== input.recoveryId
    && record.slug === input.slug
  ));
  if (ownershipConflict) {
    throw new Error(
      `Pane slug "${input.slug}" is already reserved by recovery ${ownershipConflict.recoveryId}`,
    );
  }
  let persistedConflict = false;
  try {
    const config = await readProjectPaneConfigUnderLock(input.sessionProjectRoot);
    persistedConflict = (Array.isArray(config.panes) ? config.panes : [])
      .some((candidate) => {
        if (!candidate || typeof candidate !== 'object') {
          return false;
        }
        const pane = candidate as Record<string, unknown>;
        return pane.slug === input.slug && pane.id !== input.pane.id;
      });
  } catch {
    // An unreadable pane config is itself ambiguous; retain the quarantine.
  }
  if (persistedConflict) {
    throw new Error(
      `Pane slug "${input.slug}" is already durably owned by another pane`,
    );
  }
  const timestamp = new Date().toISOString();
  const record: PaneSlugOwnershipRecord = {
    version: PANE_SLUG_RECORD_VERSION,
    recoveryId: input.recoveryId,
    state: 'quarantined',
    sessionProjectRoot: canonicalizePathWithExistingAncestor(
      input.sessionProjectRoot,
    ),
    projectRoot: canonicalizePathWithExistingAncestor(input.projectRoot),
    worktreePath: canonicalizePathWithExistingAncestor(input.worktreePath),
    slug: input.slug,
    pane: input.pane,
    owner: existing?.owner || {
      pid: process.pid,
      processStartIdentity: getProcessStartIdentity(process.pid),
      nonce: randomUUID(),
    },
    operation: input.operation,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    reason: input.reason,
    targetMarkerId: input.targetMarkerId,
  };
  await writePaneSlugOwnershipRecord(record);
  return record;
}

export async function removePaneSlugOwnershipRecord(
  sessionProjectRoot: string,
  recoveryId: string,
): Promise<boolean> {
  assertRecoveryId(recoveryId);
  try {
    await rm(paneSlugOwnershipRecordPath(sessionProjectRoot, recoveryId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function isPaneSlugOwnerStale(
  record: PaneSlugOwnershipRecord,
  probe: PaneSlugRegistryOwnerProbe = {},
): boolean {
  const ownerAlive = probe.isProcessAlive ?? isProcessAlive;
  const resolveStartIdentity = probe.getProcessStartIdentity
    ?? getProcessStartIdentity;
  if (!ownerAlive(record.owner.pid)) {
    return true;
  }
  if (!record.owner.processStartIdentity) {
    return false;
  }
  const currentIdentity = resolveStartIdentity(record.owner.pid);
  return currentIdentity !== undefined
    && currentIdentity !== record.owner.processStartIdentity;
}

export function paneSlugOwnershipDirectory(sessionProjectRoot: string): string {
  return path.join(
    canonicalizePathWithExistingAncestor(sessionProjectRoot),
    '.psyche',
    'runtime',
    PANE_SLUG_DIRECTORY_NAME,
  );
}

function paneSlugOwnershipRecordPath(
  sessionProjectRoot: string,
  recoveryId: string,
): string {
  return path.join(paneSlugOwnershipDirectory(sessionProjectRoot), `${recoveryId}.json`);
}

function extractConfigSlugs(config: ProjectPaneConfig): string[] {
  return (Array.isArray(config.panes) ? config.panes : []).flatMap((pane) => {
    if (!pane || typeof pane !== 'object') {
      return [];
    }
    const slug = (pane as Record<string, unknown>).slug;
    return typeof slug === 'string' && slug ? [slug] : [];
  });
}

function assertPaneSlug(slug: string): void {
  if (
    typeof slug !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(slug)
  ) {
    throw new Error(`Pane slug "${slug}" contains unsupported characters`);
  }
}

function assertRecoveryId(recoveryId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(recoveryId)) {
    throw new Error('Pane slug recovery ID must be a UUID');
  }
}

function assertPaneSlugOwnershipRecord(
  record: PaneSlugOwnershipRecord,
): void {
  if (!isPaneSlugOwnershipRecord(record)) {
    throw new Error('Invalid pane slug ownership record');
  }
}

function isPaneSlugOwnershipRecord(
  value: unknown,
): value is PaneSlugOwnershipRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<PaneSlugOwnershipRecord>;
  return (
    record.version === PANE_SLUG_RECORD_VERSION
    && typeof record.recoveryId === 'string'
    && /^[0-9a-f-]{36}$/i.test(record.recoveryId)
    && (record.state === 'provisional' || record.state === 'quarantined')
    && typeof record.sessionProjectRoot === 'string'
    && typeof record.projectRoot === 'string'
    && typeof record.worktreePath === 'string'
    && typeof record.slug === 'string'
    && typeof record.pane?.id === 'string'
    && (
      record.pane.paneId === undefined
      || typeof record.pane.paneId === 'string'
    )
    && typeof record.owner?.pid === 'number'
    && typeof record.owner?.nonce === 'string'
    && typeof record.operation === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
  );
}
