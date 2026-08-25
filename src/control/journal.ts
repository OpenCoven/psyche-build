import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, truncate, type FileHandle, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AGENT_CONTROL_LIMITS } from './limits.js';
import { isJournalActionReceipt } from './types.js';
import type {
  ActionReceipt,
  CommandOutcome,
  ControlCommand,
  JournalActionReceipt,
} from './types.js';
import type { RedactedApprovalEffect } from './approvals.js';

export type AgentControlJournalKind =
  | 'command.requested' | 'command.succeeded' | 'command.failed'
  | 'command.unknown' | 'command.rejected' | 'approval.requested';

export const COMMAND_OUTCOME_ATTESTED_KIND = 'command.outcome.attested';
export const COMPACTED_OUTCOME_CODE = 'idempotency_outcome_compacted';

export function compactedCommandOutcome(): CommandOutcome {
  return {
    status: 'unknown',
    code: COMPACTED_OUTCOME_CODE,
    message: 'command completed; exact outcome was compacted',
  };
}

export function isCompactedCommandOutcome(outcome: CommandOutcome): boolean {
  return outcome.status === 'unknown' && outcome.code === COMPACTED_OUTCOME_CODE;
}

interface ForbiddenAgentControlJournalData {
  readonly outcome?: never;
  readonly transcript?: never;
  readonly page?: never;
  readonly screenshot?: never;
  readonly typedValue?: never;
  readonly value?: never;
  readonly script?: never;
  readonly cookie?: never;
  readonly header?: never;
  readonly absolutePath?: never;
}

declare const agentControlJournalResourceBrand: unique symbol;
export type AgentControlJournalResource = Readonly<{
  kind: ActionReceipt['resource']['kind'];
  idDigest: string;
  generation?: number;
  [agentControlJournalResourceBrand]: true;
}>;

const agentControlJournalResources = new WeakSet<object>();

export function createAgentControlJournalResource(
  resource: ActionReceipt['resource'],
): AgentControlJournalResource {
  const metadata = Object.freeze({
    kind: resource.kind,
    idDigest: createHash('sha256').update(resource.id, 'utf8').digest('hex'),
    ...(resource.kind === 'project' ? {} : { generation: resource.generation }),
  }) as AgentControlJournalResource;
  agentControlJournalResources.add(metadata);
  return metadata;
}

export type AgentControlJournalReceipt = ForbiddenAgentControlJournalData & {
  readonly schema: JournalActionReceipt['schema'];
  readonly actionId: string;
  readonly state: JournalActionReceipt['state'];
  readonly resource: AgentControlJournalResource;
} & Omit<JournalActionReceipt, 'resource'>;

export type AgentControlJournalInput =
  | (ForbiddenAgentControlJournalData & { kind: 'command.requested'; commandId: string; idempotencyKey: string;
      commandKind: ControlCommand['kind']; ownerEpoch: number }
    )
  | (ForbiddenAgentControlJournalData & { kind: 'approval.requested'; commandId: string; approvalId: string; payloadDigest: string;
      taskId?: string; actorId?: string; subjectId?: string; leaseId?: string; leaseRevision?: number;
      resource: AgentControlJournalResource; capability: string; effect: RedactedApprovalEffect })
  | (ForbiddenAgentControlJournalData & {
      kind: Exclude<AgentControlJournalKind, 'command.requested' | 'approval.requested'>;
      commandId: string;
      idempotencyKey: string;
      status: CommandOutcome['status'];
      outcomeDigest: string;
      code?: string;
      receipt?: AgentControlJournalReceipt;
    });

/** Construct-only boundary: sensitive effect values are never accepted here. */
export function agentControlJournalPayload(input: AgentControlJournalInput): {
  kind: AgentControlJournalKind;
  payload: Record<string, unknown>;
} {
  if (input.kind === 'command.requested') return {
    kind: input.kind,
    payload: { commandId: input.commandId, idempotencyKey: input.idempotencyKey,
      kind: input.commandKind, ownerEpoch: input.ownerEpoch },
  };
  if (input.kind === 'approval.requested') {
    assertJournalResource(input.resource);
    return {
      kind: input.kind,
      payload: { commandId: input.commandId, approvalId: input.approvalId,
        payloadDigest: input.payloadDigest,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.subjectId ? { subjectId: input.subjectId } : {}),
        ...(input.leaseId ? { leaseId: input.leaseId } : {}),
        ...(input.leaseRevision !== undefined ? { leaseRevision: input.leaseRevision } : {}),
        resource: input.resource,
        capability: input.capability, effect: input.effect },
    };
  }
  const receipt = input.receipt ? journalReceipt(input.receipt) : undefined;
  return {
    kind: input.kind,
    payload: receipt
      ? { commandId: input.commandId, idempotencyKey: input.idempotencyKey,
          status: input.status, outcomeDigest: input.outcomeDigest, receipt }
      : { commandId: input.commandId, idempotencyKey: input.idempotencyKey,
          status: input.status, outcomeDigest: input.outcomeDigest,
          ...(input.status === 'succeeded' ? {} : { code: input.code ?? 'surface_command_failed' }) },
  };
}

export function exactCommandOutcomeDigest(outcome: CommandOutcome): string {
  return createHash('sha256').update(stableOutcomeJson(outcome), 'utf8').digest('hex');
}

function stableOutcomeJson(outcome: CommandOutcome): string {
  return JSON.stringify(sortOutcomeValue(outcome));
}

function sortOutcomeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortOutcomeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [
        key,
        sortOutcomeValue((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}

function journalReceipt(receipt: AgentControlJournalReceipt): AgentControlJournalReceipt {
  assertJournalResource(receipt.resource);
  return Object.freeze({
    schema: receipt.schema,
    actionId: receipt.actionId,
    state: receipt.state,
    resource: receipt.resource,
    createdAt: receipt.createdAt,
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    ...(receipt.actorId ? { actorId: receipt.actorId } : {}),
    ...(receipt.leaseId ? { leaseId: receipt.leaseId } : {}),
    ...(receipt.leaseRevision !== undefined ? { leaseRevision: receipt.leaseRevision } : {}),
    ...(receipt.completedAt ? { completedAt: receipt.completedAt } : {}),
    ...(receipt.code ? { code: receipt.code } : {}),
    ...(receipt.sourceDigest ? { sourceDigest: receipt.sourceDigest } : {}),
    ...(receipt.sourceBytes !== undefined ? { sourceBytes: receipt.sourceBytes } : {}),
    ...(receipt.resultBytes !== undefined ? { resultBytes: receipt.resultBytes } : {}),
    ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
  });
}

function assertJournalResource(resource: AgentControlJournalResource): void {
  if (!resource || typeof resource !== 'object' || !agentControlJournalResources.has(resource)) {
    throw new Error('agent control journal resource lacks redaction provenance');
  }
}

export interface ControlEvent {
  sequence: number;
  id: string;
  ownerEpoch: number;
  timestamp: string;
  kind: string;
  payload: Record<string, unknown>;
}

type EventListener = (event: ControlEvent) => void;

const IDEMPOTENCY_INDEXED_KINDS = new Set([
  'command.requested',
  'command.accepted',
  'command.running',
  'command.succeeded',
  'command.failed',
  'command.unknown',
  'command.rejected',
]);

/**
 * Marks a journal whose head has been compacted away.
 *
 * A journal that has never been compacted has no header and begins at sequence
 * 1, so `replay` keeps accepting the original format. Recording the first
 * retained sequence explicitly is what lets contiguity still be verified after
 * compaction: a missing line in the middle remains corruption, while a
 * deliberately dropped prefix does not.
 */
const JOURNAL_HEADER_TAG = 'psyche.control.journal/v1';

interface JournalHeader {
  journal: typeof JOURNAL_HEADER_TAG;
  firstSequence: number;
}

function parseJournalHeader(value: unknown): JournalHeader | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { journal?: unknown; firstSequence?: unknown };
  if (candidate.journal !== JOURNAL_HEADER_TAG) return undefined;
  if (typeof candidate.firstSequence !== 'number' || !Number.isInteger(candidate.firstSequence)) {
    return undefined;
  }
  if (candidate.firstSequence < 1) return undefined;
  return { journal: JOURNAL_HEADER_TAG, firstSequence: candidate.firstSequence };
}

/**
 * What `snapshot.json` holds. It is a superset of the client-facing
 * ControlSnapshot: `receiptRecords` are the durable half of the runtime's
 * bounded receipt cache, while `outcomes` is kept only as a backward-compatible
 * warm-start seed for snapshots written before exact outcomes moved fully into
 * the hash-addressed durable sidecar. Exact command outcomes remain
 * authoritative in that sidecar because a compacted journal can no longer
 * rebuild them by replay.
 */
export interface JournalSnapshotFile {
  snapshot: DurableControlSnapshot;
  coveredSequence: number;
  outcomes: Record<string, CommandOutcome>;
  receiptRecords: DurableReceiptRecord[];
  openTransactions?: DurableOpenTransaction[];
  completedTransactions?: DurableCompletedTransaction[];
}

export interface DurableControlSnapshot {
  readonly ownerEpoch: number;
  readonly sequence: number;
}

export type DurableOpenTransactionKind =
  | 'command.requested'
  | 'command.accepted'
  | 'command.running';

export interface DurableOpenTransaction {
  readonly sequence: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly kind: DurableOpenTransactionKind;
}

export interface DurableCompletedTransaction {
  readonly sequence: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export interface DurableReceiptRecord {
  readonly sequence: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly receipt: JournalActionReceipt;
}

interface StoredOutcomeRecord {
  readonly idempotencyKey: string;
  readonly outcome: CommandOutcome;
}

interface DurableOutcomeFileSnapshot {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

interface DurableOutcomeDirectoryIdentity {
  readonly realPath: string;
  readonly dev?: bigint;
  readonly ino?: bigint;
}

interface DurableOutcomePublicationContext {
  readonly directoryPath: string;
  readonly destinationPath: string;
  readonly temporaryPath: string;
}

interface DurableOutcomeReadContext {
  readonly directoryPath: string;
  readonly outcomePath: string;
}

type DurableMetadataMutationTarget = 'directory' | 'outcome' | 'snapshot' | 'journal';
type DurableMetadataMutationStep =
  | 'created'
  | 'parent-directory-synced'
  | 'temporary-written'
  | 'temporary-synced'
  | 'temporary-closed'
  | 'identity-checked'
  | 'renamed'
  | 'directory-synced'
  | 'succeeded';

interface DurableMetadataMutationStepContext {
  readonly target: DurableMetadataMutationTarget;
  readonly directoryPath: string;
  readonly destinationPath: string;
  readonly temporaryPath: string;
  readonly step: DurableMetadataMutationStep;
}

interface DurableMetadataDirectorySyncContext {
  readonly target: DurableMetadataMutationTarget;
  readonly directoryPath: string;
  readonly destinationPath: string;
  readonly temporaryPath: string;
  readonly sync: () => Promise<void>;
}

interface SnapshotWriteContext {
  readonly snapshotPath: string;
  readonly temporaryPath: string;
  readonly coveredSequence: number;
}

interface JournalCompactionContext {
  readonly journalPath: string;
  readonly temporaryPath: string;
  readonly coveredSequence: number;
  readonly firstSequence: number;
}

export interface JournalMutationGuard {
  readonly shouldAbort?: () => boolean;
}

interface JournalTestHookContexts {
  readonly beforeTemporaryOpen: DurableOutcomePublicationContext;
  readonly beforeDestinationRename: DurableOutcomePublicationContext;
  readonly beforeOutcomePathRead: DurableOutcomeReadContext;
  readonly durableMutationStep: DurableMetadataMutationStepContext;
  readonly syncContainingDirectory: DurableMetadataDirectorySyncContext;
  readonly beforeSnapshotRename: SnapshotWriteContext;
  readonly beforeCompactRename: JournalCompactionContext;
}

type DurableOutcomePublicationTestHooks = {
  [K in keyof JournalTestHookContexts]?: (
    context: JournalTestHookContexts[K],
  ) => Promise<void> | void;
};

let durableOutcomePublicationTestHooks: DurableOutcomePublicationTestHooks | undefined;

export function setDurableOutcomePublicationTestHooksForTesting(
  hooks: DurableOutcomePublicationTestHooks | undefined,
): void {
  durableOutcomePublicationTestHooks = hooks;
}

/**
 * Large exact outcomes are accepted durably, but one file still needs a hard
 * ceiling so a single retry record cannot grow without bound. The cap is sized
 * for the largest existing bounded surfaces: a base64-encoded 4 MiB screenshot
 * plus the largest script result, pane capture payload, and small JSON
 * overhead.
 */
export const DURABLE_OUTCOME_RECORD_MAX_BYTES =
  (AGENT_CONTROL_LIMITS.screenshotBytes * 2)
  + AGENT_CONTROL_LIMITS.scriptResultBytes
  + AGENT_CONTROL_LIMITS.paneOutputBytes
  + (64 * 1024);

export class ControlJournal {
  readonly path: string;
  private readonly runtimeDirectoryPath: string;
  private readonly snapshotPath: string;
  private readonly outcomeDirectoryPath: string;
  private currentSequence: number;
  private firstRetainedSequence: number;
  private readonly ownerEpoch: number;
  private readonly events: ControlEvent[];
  private readonly idempotencyIndex = new Map<string, ControlEvent>();
  private readonly listeners = new Set<EventListener>();
  private readonly outcomePublicationTails = new Map<string, Promise<void>>();
  private appendTail: Promise<void> = Promise.resolve();

  private constructor(
    runtimeDirectoryPath: string,
    journalPath: string,
    snapshotPath: string,
    outcomeDirectoryPath: string,
    ownerEpoch: number,
    events: ControlEvent[],
    firstSequence: number,
  ) {
    this.runtimeDirectoryPath = runtimeDirectoryPath;
    this.path = journalPath;
    this.snapshotPath = snapshotPath;
    this.outcomeDirectoryPath = outcomeDirectoryPath;
    this.ownerEpoch = ownerEpoch;
    this.events = events;
    this.firstRetainedSequence = firstSequence;
    // With every event compacted away the file carries only a header, so the
    // head has to come from the header rather than from the last event.
    this.currentSequence = events.length > 0
      ? events[events.length - 1].sequence
      : firstSequence - 1;
    for (const event of events) this.indexIdempotency(event);
  }

  static async open(projectRoot: string, ownerEpoch: number): Promise<ControlJournal> {
    const runtimeDir = path.join(projectRoot, '.psyche', 'runtime');
    const outcomeDirectoryPath = path.join(runtimeDir, 'outcomes');
    await ensureDurableOutcomeDirectory(outcomeDirectoryPath);
    const journalPath = path.join(runtimeDir, 'events.ndjson');
    const snapshotPath = path.join(runtimeDir, 'snapshot.json');
    const { events, firstSequence } = await ControlJournal.replay(journalPath);
    return new ControlJournal(
      runtimeDir,
      journalPath,
      snapshotPath,
      outcomeDirectoryPath,
      ownerEpoch,
      events,
      firstSequence,
    );
  }

  private static async replay(
    journalPath: string,
  ): Promise<{ events: ControlEvent[]; firstSequence: number }> {
    let raw: Buffer;
    try {
      raw = await readFile(journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], firstSequence: 1 };
      throw error;
    }
    if (raw.length === 0) return { events: [], firstSequence: 1 };
    const endsWithNewline = raw[raw.length - 1] === 0x0a;
    const segments: Buffer[] = [];
    let start = 0;
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] === 0x0a) {
        segments.push(raw.subarray(start, index));
        start = index + 1;
      }
    }
    if (start < raw.length) segments.push(raw.subarray(start));
    while (segments.length > 0 && segments[segments.length - 1].length === 0) {
      segments.pop();
    }

    // A journal written before compaction existed has no header and starts at
    // sequence 1; anything else must say where it starts.
    let firstSequence = 1;
    let firstEventLine = 0;
    if (segments.length > 0) {
      let headerCandidate: unknown;
      try {
        headerCandidate = JSON.parse(segments[0].toString('utf8'));
      } catch {
        headerCandidate = undefined;
      }
      const header = parseJournalHeader(headerCandidate);
      if (header) {
        firstSequence = header.firstSequence;
        firstEventLine = 1;
      }
    }

    const events: ControlEvent[] = [];
    let expectedSequence = firstSequence;
    for (let index = firstEventLine; index < segments.length; index += 1) {
      const isLastLine = index === segments.length - 1;
      const lineBuffer = segments[index];
      let parsed: ControlEvent;
      try {
        parsed = JSON.parse(lineBuffer.toString('utf8')) as ControlEvent;
      } catch (error) {
        if (isLastLine && !endsWithNewline) {
          await truncate(journalPath, raw.length - lineBuffer.length);
          break;
        }
        throw new Error(`journal corruption at line ${index + 1}`);
      }
      if (parsed.sequence !== expectedSequence) {
        throw new Error(`journal corruption at line ${index + 1}`);
      }
      events.push(parsed);
      expectedSequence += 1;
    }
    return { events, firstSequence };
  }

  get sequence(): number {
    return this.currentSequence;
  }

  /** Lowest sequence still present in the journal; 1 until first compaction. */
  get firstSequence(): number {
    return this.firstRetainedSequence;
  }

  append(kind: string, payload: Record<string, unknown>): Promise<ControlEvent> {
    let resolveEvent!: (event: ControlEvent) => void;
    let rejectEvent!: (error: unknown) => void;
    const result = new Promise<ControlEvent>((resolve, reject) => {
      resolveEvent = resolve;
      rejectEvent = reject;
    });
    this.appendTail = this.appendTail.then(async () => {
      const event = this.buildNextEvent(kind, payload);
      const handle = await open(this.path, 'a');
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.currentSequence = event.sequence;
      this.events.push(event);
      this.indexIdempotency(event);
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A subscriber error must not undo a durably committed append.
        }
      }
      resolveEvent(event);
    }).catch((error) => {
      rejectEvent(error);
    });
    return result;
  }

  read(afterSequence: number, limit?: number): ControlEvent[] {
    // Retained sequences are contiguous, so the requested position is an index
    // rather than something to scan for.
    if (this.events.length === 0) return [];
    const offset = afterSequence - this.events[0].sequence + 1;
    const start = offset < 0 ? 0 : offset;
    if (start >= this.events.length) return [];
    const end = typeof limit === 'number' ? start + limit : undefined;
    return this.events.slice(start, end);
  }

  findByIdempotencyKey(key: string): ControlEvent | undefined {
    return this.idempotencyIndex.get(key);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadOutcome(idempotencyKey: string): Promise<CommandOutcome | undefined> {
    if (!await durableOutcomeDirectoryExists(this.outcomeDirectoryPath)) return undefined;
    const directoryIdentity = await snapshotDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath);
    if (!directoryIdentity) return undefined;
    const outcomePath = this.outcomePath(idempotencyKey);
    const readContext = {
      directoryPath: this.outcomeDirectoryPath,
      outcomePath,
    } satisfies DurableOutcomeReadContext;
    await assertDurableOutcomeDirectoryIdentity(
      this.outcomeDirectoryPath,
      directoryIdentity,
      durableOutcomeDirectoryChangedDuringRead,
    );
    await invokeDurableOutcomePublicationHook('beforeOutcomePathRead', readContext);
    await assertDurableOutcomeDirectoryIdentity(
      this.outcomeDirectoryPath,
      directoryIdentity,
      durableOutcomeDirectoryChangedDuringRead,
    );
    const preOpenPath = await readDurableOutcomeFilePathSnapshot(outcomePath);
    if (preOpenPath.missing) return undefined;
    if (preOpenPath.invalid || !preOpenPath.snapshot) {
      throw unsafeDurableOutcomePath();
    }
    const preOpenSnapshot = preOpenPath.snapshot;
    await assertDurableOutcomeDirectoryIdentity(
      this.outcomeDirectoryPath,
      directoryIdentity,
      durableOutcomeDirectoryChangedDuringRead,
    );
    let handle: FileHandle;
    try {
      handle = await open(outcomePath, durableOutcomeFileReadFlags());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (isUnsafeDurableOutcomeOpenError(error)) throw unsafeDurableOutcomePath();
      throw error;
    }
    try {
      const openedStats = await handle.stat({ bigint: true });
      if (!isSafeDurableOutcomeFileStats(openedStats)) throw unsafeDurableOutcomePath();
      const openedSnapshot = snapshotDurableOutcomeFile(openedStats);
      if (!sameDurableOutcomeFileSnapshot(preOpenSnapshot, openedSnapshot)) {
        throw new Error('durable outcome file changed while reading');
      }
      await assertDurableOutcomeDirectoryIdentity(
        this.outcomeDirectoryPath,
        directoryIdentity,
        durableOutcomeDirectoryChangedDuringRead,
      );
      const raw = await readBoundedStoredOutcome(handle);
      await assertDurableOutcomeDirectoryIdentity(
        this.outcomeDirectoryPath,
        directoryIdentity,
        durableOutcomeDirectoryChangedDuringRead,
      );
      const currentPath = await readDurableOutcomeFilePathSnapshot(outcomePath);
      if (currentPath.missing || currentPath.invalid || !currentPath.snapshot) {
        throw new Error('durable outcome file changed while reading');
      }
      if (!sameDurableOutcomeFileSnapshot(openedSnapshot, currentPath.snapshot)) {
        throw new Error('durable outcome file changed while reading');
      }
      return parseStoredOutcome(raw, idempotencyKey);
    } finally {
      await handle.close();
    }
  }

  async storeOutcome(idempotencyKey: string, outcome: CommandOutcome): Promise<void> {
    await this.serializeOutcomePublication(
      idempotencyKey,
      () => this.publishOutcome(idempotencyKey, outcome),
    );
  }

  async replaceOutcomeIfMatches(
    idempotencyKey: string,
    expectedOutcomeDigest: string,
    replacement: CommandOutcome,
  ): Promise<boolean> {
    return this.serializeOutcomePublication(idempotencyKey, async () => {
      const current = await this.loadOutcome(idempotencyKey);
      if (!current || exactCommandOutcomeDigest(current) !== expectedOutcomeDigest) return false;
      if (exactCommandOutcomeDigest(replacement) === expectedOutcomeDigest) return true;
      await this.publishOutcome(idempotencyKey, replacement);
      return true;
    });
  }

  private async publishOutcome(idempotencyKey: string, outcome: CommandOutcome): Promise<void> {
    const serialized = serializeStoredOutcomeRecord({ idempotencyKey, outcome }, idempotencyKey);
    const directoryIdentity = await ensureDurableOutcomeDirectory(this.outcomeDirectoryPath);
    const destination = this.outcomePath(idempotencyKey);
    const temporary = path.join(
      this.outcomeDirectoryPath,
      `${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const publication = {
      directoryPath: this.outcomeDirectoryPath,
      destinationPath: destination,
      temporaryPath: temporary,
    } satisfies DurableOutcomePublicationContext;
    let handle: FileHandle | undefined;
    let temporarySnapshot: DurableOutcomeFileSnapshot | undefined;
    let published = false;
    let preservePublishedDestination = false;
    try {
      await assertDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath, directoryIdentity);
      await invokeDurableOutcomePublicationHook('beforeTemporaryOpen', publication);
      await assertDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath, directoryIdentity);
      handle = await openExclusiveDurableOutcomeFile(temporary);
      const openedStats = await handle.stat({ bigint: true });
      if (!isSafeDurableOutcomeFileStats(openedStats)) throw unsafeDurableOutcomePath();
      temporarySnapshot = snapshotDurableOutcomeFile(openedStats);
      await assertDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath, directoryIdentity);
      await handle.writeFile(serialized, 'utf8');
      await recordDurableMetadataMutationStep({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        step: 'temporary-written',
      });
      await handle.sync();
      await recordDurableMetadataMutationStep({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        step: 'temporary-synced',
      });
      const syncedStats = await handle.stat({ bigint: true });
      if (!isSafeDurableOutcomeFileStats(syncedStats)) throw unsafeDurableOutcomePath();
      temporarySnapshot = snapshotDurableOutcomeFile(syncedStats);
      await handle.close();
      handle = undefined;
      await recordDurableMetadataMutationStep({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        step: 'temporary-closed',
      });
      await assertDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath, directoryIdentity);
      await recordDurableMetadataMutationStep({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        step: 'identity-checked',
      });
      await invokeDurableOutcomePublicationHook('beforeDestinationRename', publication);
      await assertDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath, directoryIdentity);
      await rename(temporary, destination);
      published = true;
      await recordDurableMetadataMutationStep({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        step: 'renamed',
      });
      if (temporarySnapshot) {
        const publishedPath = await readDurableOutcomeFilePathSnapshot(destination);
        if (
          publishedPath.missing
          || publishedPath.invalid
          || !publishedPath.snapshot
          || !sameDurableOutcomeFileIdentity(temporarySnapshot, publishedPath.snapshot)
        ) {
          await removeDurableOutcomePathIfMatching(destination, temporarySnapshot);
          temporarySnapshot = undefined;
          throw durableOutcomeDirectoryChangedDuringPublication();
        }
      }
      await assertDurableOutcomeDirectoryIdentity(this.outcomeDirectoryPath, directoryIdentity);
      preservePublishedDestination = true;
      await syncPublishedMetadataDirectory({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        directoryIdentity,
        mismatchError: durableOutcomeDirectoryChangedDuringPublication,
        syncUnsupportedError: durableOutcomeDirectorySyncUnsupported,
      });
      await recordDurableMetadataMutationStep({
        target: 'outcome',
        directoryPath: this.outcomeDirectoryPath,
        destinationPath: destination,
        temporaryPath: temporary,
        step: 'succeeded',
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (temporarySnapshot) {
        if (!(published && preservePublishedDestination)) {
          await removeDurableOutcomePathIfMatching(
            published ? destination : temporary,
            temporarySnapshot,
          );
        }
      } else if (!published) {
        await unlink(temporary).catch(() => undefined);
      }
      throw error;
    }
  }

  private async serializeOutcomePublication<T>(
    idempotencyKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.outcomePublicationTails.get(idempotencyKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.outcomePublicationTails.set(idempotencyKey, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.outcomePublicationTails.get(idempotencyKey) === tail) {
        this.outcomePublicationTails.delete(idempotencyKey);
      }
    }
  }

  async loadSnapshot(): Promise<JournalSnapshotFile | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return parseJournalSnapshotFile(JSON.parse(raw));
    } catch {
      throw durableSnapshotCorruption();
    }
  }

  async writeSnapshot(file: JournalSnapshotFile, guard?: JournalMutationGuard): Promise<void> {
    const temporary = path.join(
      this.runtimeDirectoryPath,
      `${path.basename(this.snapshotPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const context = {
      snapshotPath: this.snapshotPath,
      temporaryPath: temporary,
      coveredSequence: file.coveredSequence,
    } satisfies SnapshotWriteContext;
    await this.replaceRuntimeFile({
      serialized: JSON.stringify(file),
      temporaryPath: temporary,
      destinationPath: this.snapshotPath,
      target: 'snapshot',
      hookStep: 'beforeSnapshotRename',
      hookContext: context,
      guard,
      mismatchError: runtimeDirectoryChangedDuringSnapshotPublication,
      syncUnsupportedError: runtimeDirectorySyncUnsupportedDuringSnapshotPublication,
    });
  }

  /**
   * Drops every event at or below `coveredSequence` from the file and from
   * memory. The snapshot covering those events must already be durable — call
   * writeSnapshot first — because after this returns they are unrecoverable.
   *
   * Runs on the append tail so a concurrent append cannot interleave with the
   * rewrite, and replaces the file by atomic rename so a crash mid-compaction
   * leaves the previous journal intact.
   */
  compact(coveredSequence: number, guard?: JournalMutationGuard): Promise<void> {
    let resolveDone!: () => void;
    let rejectDone!: (error: unknown) => void;
    const result = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    this.appendTail = this.appendTail.then(async () => {
      const dropped = this.events.findIndex((event) => event.sequence > coveredSequence);
      const keepFrom = dropped === -1 ? this.events.length : dropped;
      if (keepFrom === 0) {
        resolveDone();
        return;
      }
      const retained = this.events.slice(keepFrom);
      const firstSequence = retained.length > 0
        ? retained[0].sequence
        : this.currentSequence + 1;
      const header: JournalHeader = { journal: JOURNAL_HEADER_TAG, firstSequence };
      const body = [header, ...retained]
        .map((entry) => JSON.stringify(entry))
        .join('\n');

      const temporary = path.join(
        this.runtimeDirectoryPath,
        `${path.basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
      );
      const context = {
        journalPath: this.path,
        temporaryPath: temporary,
        coveredSequence,
        firstSequence,
      } satisfies JournalCompactionContext;
      const replaced = await this.replaceRuntimeFile({
        serialized: `${body}\n`,
        temporaryPath: temporary,
        destinationPath: this.path,
        target: 'journal',
        hookStep: 'beforeCompactRename',
        hookContext: context,
        guard,
        mismatchError: runtimeDirectoryChangedDuringCompaction,
        syncUnsupportedError: runtimeDirectorySyncUnsupportedDuringCompaction,
      });
      if (!replaced) {
        resolveDone();
        return;
      }

      this.events.splice(0, keepFrom);
      this.firstRetainedSequence = firstSequence;
      for (const [key, event] of this.idempotencyIndex) {
        if (event.sequence < firstSequence) this.idempotencyIndex.delete(key);
      }
      resolveDone();
    }).catch((error) => {
      rejectDone(error);
    });
    return result;
  }

  private async replaceRuntimeFile(
    input: {
      serialized: string;
      temporaryPath: string;
      destinationPath: string;
      target: DurableMetadataMutationTarget;
      hookStep: 'beforeSnapshotRename' | 'beforeCompactRename';
      hookContext: SnapshotWriteContext | JournalCompactionContext;
      guard?: JournalMutationGuard;
      mismatchError: () => Error;
      syncUnsupportedError: () => Error;
    },
  ): Promise<boolean> {
    const runtimeIdentity = await ensureRuntimeDirectoryIdentity(this.runtimeDirectoryPath);
    let handle: FileHandle | undefined;
    let temporarySnapshot: DurableOutcomeFileSnapshot | undefined;
    let published = false;
    let preservePublishedDestination = false;
    try {
      await assertRuntimeDirectoryIdentity(this.runtimeDirectoryPath, runtimeIdentity, input.mismatchError);
      if (input.guard?.shouldAbort?.()) return false;
      try {
        handle = await openExclusiveDurableOutcomeFile(input.temporaryPath);
      } catch (error) {
        if (isRuntimeDirectoryMutationError(error)) throw input.mismatchError();
        throw error;
      }
      const openedStats = await handle.stat({ bigint: true });
      if (!isSafeDurableOutcomeFileStats(openedStats)) throw input.mismatchError();
      temporarySnapshot = snapshotDurableOutcomeFile(openedStats);
      await assertRuntimeDirectoryIdentity(this.runtimeDirectoryPath, runtimeIdentity, input.mismatchError);
      if (input.guard?.shouldAbort?.()) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await removeDurableOutcomePathIfMatching(input.temporaryPath, temporarySnapshot);
        return false;
      }
      await handle.writeFile(input.serialized, 'utf8');
      await recordDurableMetadataMutationStep({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        step: 'temporary-written',
      });
      await handle.sync();
      await recordDurableMetadataMutationStep({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        step: 'temporary-synced',
      });
      const syncedStats = await handle.stat({ bigint: true });
      if (!isSafeDurableOutcomeFileStats(syncedStats)) throw input.mismatchError();
      temporarySnapshot = snapshotDurableOutcomeFile(syncedStats);
      await handle.close();
      handle = undefined;
      await recordDurableMetadataMutationStep({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        step: 'temporary-closed',
      });
      await assertRuntimeDirectoryIdentity(this.runtimeDirectoryPath, runtimeIdentity, input.mismatchError);
      await recordDurableMetadataMutationStep({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        step: 'identity-checked',
      });
      await invokeDurableOutcomePublicationHook(input.hookStep as any, input.hookContext as any);
      await assertRuntimeDirectoryIdentity(this.runtimeDirectoryPath, runtimeIdentity, input.mismatchError);
      if (input.guard?.shouldAbort?.()) {
        await removeDurableOutcomePathIfMatching(input.temporaryPath, temporarySnapshot);
        return false;
      }
      try {
        await rename(input.temporaryPath, input.destinationPath);
      } catch (error) {
        if (isRuntimeDirectoryMutationError(error)) throw input.mismatchError();
        throw error;
      }
      published = true;
      await recordDurableMetadataMutationStep({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        step: 'renamed',
      });
      const publishedPath = await readDurableOutcomeFilePathSnapshot(input.destinationPath);
      if (
        temporarySnapshot
        && (
          publishedPath.missing
          || publishedPath.invalid
          || !publishedPath.snapshot
          || !sameDurableOutcomeFileIdentity(temporarySnapshot, publishedPath.snapshot)
        )
      ) {
        await removeDurableOutcomePathIfMatching(input.destinationPath, temporarySnapshot);
        temporarySnapshot = undefined;
        throw input.mismatchError();
      }
      await assertRuntimeDirectoryIdentity(this.runtimeDirectoryPath, runtimeIdentity, input.mismatchError);
      preservePublishedDestination = true;
      await syncPublishedMetadataDirectory({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        directoryIdentity: runtimeIdentity,
        mismatchError: input.mismatchError,
        syncUnsupportedError: input.syncUnsupportedError,
      });
      await recordDurableMetadataMutationStep({
        target: input.target,
        directoryPath: this.runtimeDirectoryPath,
        destinationPath: input.destinationPath,
        temporaryPath: input.temporaryPath,
        step: 'succeeded',
      });
      return true;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (temporarySnapshot) {
        if (!(published && preservePublishedDestination)) {
          await removeDurableOutcomePathIfMatching(
            published ? input.destinationPath : input.temporaryPath,
            temporarySnapshot,
          );
        }
      } else if (!published) {
        await unlink(input.temporaryPath).catch(() => undefined);
      }
      throw error;
    }
  }

  async recoverNonterminalCommands(
    restored: readonly DurableOpenTransaction[] = [],
  ): Promise<ControlEvent[]> {
    const terminalTransactions = new Set<string>();
    const nonterminal = new Map<string, DurableOpenTransaction>();
    const terminalKinds = new Set(['command.succeeded', 'command.failed', 'command.unknown', 'command.rejected']);
    const openKinds = new Set(['command.requested', 'command.accepted', 'command.running']);
    for (const event of restored) {
      nonterminal.set(commandTransactionKey(event.commandId, event.idempotencyKey), event);
    }
    for (const event of this.events) {
      const commandId = event.payload.commandId as string | undefined;
      const idempotencyKey = event.payload.idempotencyKey;
      if (!commandId || typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) continue;
      const transaction = commandTransactionKey(commandId, idempotencyKey);
      if (terminalKinds.has(event.kind)) {
        terminalTransactions.add(transaction);
        nonterminal.delete(transaction);
      } else if (openKinds.has(event.kind)) {
        nonterminal.set(transaction, {
          sequence: event.sequence,
          commandId,
          idempotencyKey,
          kind: event.kind as DurableOpenTransactionKind,
        });
      }
    }
    const recovered: ControlEvent[] = [];
    for (const [transaction, event] of [...nonterminal].sort((left, right) => left[1].sequence - right[1].sequence)) {
      if (terminalTransactions.has(transaction)) continue;
      if (this.events.some((candidate) => (
        terminalKinds.has(candidate.kind)
        && candidate.payload.commandId === event.commandId
        && candidate.payload.idempotencyKey === event.idempotencyKey
      ))) continue;
      const outcome = recoveredNonterminalOutcome();
      recovered.push(await this.append('command.unknown', {
        commandId: event.commandId,
        idempotencyKey: event.idempotencyKey,
        reason: 'recovered-nonterminal',
        outcomeDigest: exactCommandOutcomeDigest(outcome),
      }));
    }
    return recovered;
  }

  private buildNextEvent(kind: string, payload: Record<string, unknown>): ControlEvent {
    return {
      sequence: this.currentSequence + 1,
      id: randomUUID(),
      ownerEpoch: this.ownerEpoch,
      timestamp: new Date().toISOString(),
      kind,
      payload,
    };
  }

  private indexIdempotency(event: ControlEvent): void {
    const key = event.payload.idempotencyKey as string | undefined;
    if (key && IDEMPOTENCY_INDEXED_KINDS.has(event.kind)) this.idempotencyIndex.set(key, event);
  }

  private outcomePath(idempotencyKey: string): string {
    return path.join(
      this.outcomeDirectoryPath,
      createHash('sha256').update(idempotencyKey, 'utf8').digest('hex'),
    );
  }
}

export function commandTransactionKey(commandId: string, idempotencyKey: unknown): string {
  return JSON.stringify([commandId, typeof idempotencyKey === 'string' ? idempotencyKey : '']);
}

function recoveredNonterminalOutcome(): CommandOutcome {
  return {
    status: 'unknown',
    code: 'recovered-nonterminal',
    message: 'command outcome is unknown',
  };
}

function parseDurableControlSnapshot(value: unknown): DurableControlSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid durable control snapshot');
  const candidate = value as { ownerEpoch?: unknown; sequence?: unknown };
  if (typeof candidate.ownerEpoch !== 'number' || !Number.isSafeInteger(candidate.ownerEpoch)
    || candidate.ownerEpoch < 0 || typeof candidate.sequence !== 'number'
    || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 0) {
    throw new Error('invalid durable control snapshot');
  }
  return { ownerEpoch: candidate.ownerEpoch, sequence: candidate.sequence };
}

function parseJournalSnapshotFile(value: unknown): JournalSnapshotFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid durable snapshot');
  }
  const candidate = value as Partial<JournalSnapshotFile>;
  if (
    typeof candidate.coveredSequence !== 'number'
    || !Number.isSafeInteger(candidate.coveredSequence)
    || candidate.coveredSequence < 0
  ) {
    throw new Error('invalid durable snapshot covered sequence');
  }
  return {
    snapshot: parseDurableControlSnapshot(candidate.snapshot),
    coveredSequence: candidate.coveredSequence,
    outcomes: parseLegacySnapshotOutcomes(candidate.outcomes),
    receiptRecords: parseDurableReceiptRecords(candidate.receiptRecords),
    openTransactions: parseDurableOpenTransactions(candidate.openTransactions),
    completedTransactions: parseDurableCompletedTransactions(candidate.completedTransactions),
  };
}

function parseLegacySnapshotOutcomes(value: unknown): Record<string, CommandOutcome> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid durable snapshot outcomes');
  }
  const entries = Object.entries(value);
  if (entries.length > 1_000) throw new Error('invalid durable snapshot outcomes');
  const outcomes: Record<string, CommandOutcome> = {};
  for (const [idempotencyKey, outcome] of entries) {
    if (idempotencyKey.length === 0 || !isStoredCommandOutcome(outcome)) {
      throw new Error('invalid durable snapshot outcome');
    }
    outcomes[idempotencyKey] = outcome;
  }
  return outcomes;
}

function parseDurableReceiptRecords(value: unknown): DurableReceiptRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error('invalid durable receipt records');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid durable receipt record');
    }
    const candidate = item as Partial<DurableReceiptRecord>;
    if (
      typeof candidate.sequence !== 'number'
      || !Number.isSafeInteger(candidate.sequence)
      || candidate.sequence < 1
      || typeof candidate.commandId !== 'string'
      || candidate.commandId.length === 0
      || typeof candidate.idempotencyKey !== 'string'
      || candidate.idempotencyKey.length === 0
      || !isJournalActionReceipt(candidate.receipt)
    ) {
      throw new Error('invalid durable receipt record');
    }
    return candidate as DurableReceiptRecord;
  });
}

function parseDurableOpenTransactions(value: unknown): DurableOpenTransaction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > AGENT_CONTROL_LIMITS.pendingCommands) {
    throw new Error('invalid durable open transactions');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid durable open transaction');
    const candidate = item as Partial<DurableOpenTransaction>;
    if (typeof candidate.sequence !== 'number' || !Number.isSafeInteger(candidate.sequence)
      || candidate.sequence < 1 || typeof candidate.commandId !== 'string' || candidate.commandId.length === 0
      || typeof candidate.idempotencyKey !== 'string' || candidate.idempotencyKey.length === 0
      || !isDurableOpenTransactionKind(candidate.kind)) throw new Error('invalid durable open transaction');
    return candidate as DurableOpenTransaction;
  });
}

function parseDurableCompletedTransactions(value: unknown): DurableCompletedTransaction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) throw new Error('invalid durable completed transactions');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid durable completed transaction');
    const candidate = item as Partial<DurableCompletedTransaction>;
    if (typeof candidate.sequence !== 'number' || !Number.isSafeInteger(candidate.sequence)
      || candidate.sequence < 1 || typeof candidate.commandId !== 'string' || candidate.commandId.length === 0
      || typeof candidate.idempotencyKey !== 'string' || candidate.idempotencyKey.length === 0) {
      throw new Error('invalid durable completed transaction');
    }
    return candidate as DurableCompletedTransaction;
  });
}

function isDurableOpenTransactionKind(value: unknown): value is DurableOpenTransactionKind {
  return value === 'command.requested' || value === 'command.accepted' || value === 'command.running';
}

function durableOutcomeFileReadFlags(): number {
  let flags = constants.O_RDONLY;
  if (process.platform !== 'win32') {
    flags |= constants.O_NOFOLLOW;
    flags |= constants.O_NONBLOCK;
  }
  return flags;
}

function isSafeDurableOutcomeFileStats(stats: BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

function isSafeDurableOutcomeDirectoryStats(stats: BigIntStats): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink();
}

async function durableOutcomeDirectoryExists(directoryPath: string): Promise<boolean> {
  return privateDirectoryChainExists(durableOutcomeDirectoryComponents(directoryPath));
}

async function ensureDurableOutcomeDirectory(directoryPath: string): Promise<DurableOutcomeDirectoryIdentity> {
  await ensurePrivateDirectoryChain(durableOutcomeDirectoryComponents(directoryPath));
  const identity = await snapshotDurableOutcomeDirectoryIdentity(directoryPath);
  if (!identity) throw unsafeDurableOutcomePath();
  return identity;
}

async function ensureRuntimeDirectoryIdentity(directoryPath: string): Promise<DurableOutcomeDirectoryIdentity> {
  await ensurePrivateDirectoryChain(runtimeDirectoryComponents(directoryPath));
  const identity = await snapshotDurableOutcomeDirectoryIdentity(directoryPath);
  if (!identity) throw unsafeRuntimeDirectoryPath();
  return identity;
}

async function invokeDurableOutcomePublicationHook<K extends keyof JournalTestHookContexts>(
  step: K,
  context: JournalTestHookContexts[K],
): Promise<void> {
  const hook = durableOutcomePublicationTestHooks?.[step] as (
    (value: JournalTestHookContexts[K]) => Promise<void> | void
  ) | undefined;
  await hook?.(context);
}

async function recordDurableMetadataMutationStep(
  context: DurableMetadataMutationStepContext,
): Promise<void> {
  await invokeDurableOutcomePublicationHook('durableMutationStep', context);
}

function normalizeDurableOutcomeRealPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function snapshotDurableOutcomeDirectoryIdentity(
  directoryPath: string,
): Promise<DurableOutcomeDirectoryIdentity | undefined> {
  const stats = await readDurableOutcomeDirectoryStats(directoryPath);
  if (!stats) return undefined;
  if (!isSafeDurableOutcomeDirectoryStats(stats)) throw unsafeDurableOutcomePath();
  let resolved: string;
  try {
    resolved = await realpath(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (isUnsafeDurableOutcomeOpenError(error)) throw unsafeDurableOutcomePath();
    throw error;
  }
  return {
    realPath: normalizeDurableOutcomeRealPath(resolved),
    dev: stats.dev,
    ino: stats.ino,
  };
}

function sameDurableOutcomeDirectoryIdentity(
  left: DurableOutcomeDirectoryIdentity,
  right: DurableOutcomeDirectoryIdentity,
): boolean {
  return left.realPath === right.realPath
    && (left.dev === undefined || right.dev === undefined || left.dev === right.dev)
    && (left.ino === undefined || right.ino === undefined || left.ino === right.ino);
}

async function assertDurableOutcomeDirectoryIdentity(
  directoryPath: string,
  expected: DurableOutcomeDirectoryIdentity,
  mismatchError: () => Error = durableOutcomeDirectoryChangedDuringPublication,
): Promise<void> {
  let current: DurableOutcomeDirectoryIdentity | undefined;
  try {
    current = await snapshotDurableOutcomeDirectoryIdentity(directoryPath);
  } catch (error) {
    if (error instanceof Error && error.message === unsafeDurableOutcomePath().message) {
      throw mismatchError();
    }
    throw error;
  }
  if (!current || !sameDurableOutcomeDirectoryIdentity(expected, current)) {
    throw mismatchError();
  }
}

async function assertRuntimeDirectoryIdentity(
  directoryPath: string,
  expected: DurableOutcomeDirectoryIdentity,
  mismatchError: () => Error,
): Promise<void> {
  await assertDurableOutcomeDirectoryIdentity(directoryPath, expected, mismatchError);
}

function durableMetadataDirectoryReadFlags(): number {
  let flags = constants.O_RDONLY;
  if (process.platform !== 'win32') {
    flags |= constants.O_NOFOLLOW;
    if (typeof constants.O_DIRECTORY === 'number') flags |= constants.O_DIRECTORY;
  }
  return flags;
}

async function syncPublishedMetadataDirectory(
  context: Omit<DurableMetadataDirectorySyncContext, 'sync'> & {
    readonly directoryIdentity: DurableOutcomeDirectoryIdentity;
    readonly mismatchError: () => Error;
    readonly syncUnsupportedError: () => Error;
    readonly syncedStep?: DurableMetadataMutationStep;
  },
): Promise<void> {
  const sync = async (): Promise<void> => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(context.directoryPath, durableMetadataDirectoryReadFlags());
      await handle.sync();
    } catch (error) {
      if (isRuntimeDirectoryMutationError(error)) throw context.mismatchError();
      if (isUnsupportedDirectorySyncError(error)) throw context.syncUnsupportedError();
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  await assertDurableOutcomeDirectoryIdentity(
    context.directoryPath,
    context.directoryIdentity,
    context.mismatchError,
  );
  await invokeDurableOutcomePublicationHook('syncContainingDirectory', { ...context, sync });
  if (!durableOutcomePublicationTestHooks?.syncContainingDirectory) {
    await sync();
  }
  await assertDurableOutcomeDirectoryIdentity(
    context.directoryPath,
    context.directoryIdentity,
    context.mismatchError,
  );
  await recordDurableMetadataMutationStep({
    target: context.target,
    directoryPath: context.directoryPath,
    destinationPath: context.destinationPath,
    temporaryPath: context.temporaryPath,
    step: context.syncedStep ?? 'directory-synced',
  });
}

async function openExclusiveDurableOutcomeFile(filePath: string): Promise<FileHandle> {
  let flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY;
  if (process.platform !== 'win32') flags |= constants.O_NOFOLLOW;
  return open(filePath, flags, 0o600);
}

function runtimeDirectoryComponents(runtimeDirectoryPath: string): string[] {
  return [path.dirname(runtimeDirectoryPath), runtimeDirectoryPath];
}

function durableOutcomeDirectoryComponents(directoryPath: string): string[] {
  const runtimeDirectory = path.dirname(directoryPath);
  return [...runtimeDirectoryComponents(runtimeDirectory), directoryPath];
}

async function privateDirectoryChainExists(directoryPaths: readonly string[]): Promise<boolean> {
  for (const directoryPath of directoryPaths) {
    const stats = await readDurableOutcomeDirectoryStats(directoryPath);
    if (!stats) return false;
    if (!isSafeDurableOutcomeDirectoryStats(stats)) throw unsafeDurableOutcomePath();
  }
  return true;
}

async function ensurePrivateDirectoryChain(directoryPaths: readonly string[]): Promise<void> {
  for (const directoryPath of directoryPaths) {
    let stats = await readDurableOutcomeDirectoryStats(directoryPath);
    if (!stats) {
      const parentPath = path.dirname(directoryPath);
      const parentIdentity = await snapshotDurableOutcomeDirectoryIdentity(parentPath);
      if (!parentIdentity) throw unsafeRuntimeDirectoryPath();
      let created = false;
      try {
        await mkdir(directoryPath, { mode: 0o700 });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (created) {
        await recordDurableMetadataMutationStep({
          target: 'directory', directoryPath: parentPath, destinationPath: directoryPath,
          temporaryPath: directoryPath, step: 'created',
        });
      }
      stats = await readDurableOutcomeDirectoryStats(directoryPath);
      if (!stats || !isSafeDurableOutcomeDirectoryStats(stats)) throw unsafeDurableOutcomePath();
      try {
        await syncPublishedMetadataDirectory({
          target: 'directory', directoryPath: parentPath, destinationPath: directoryPath,
          temporaryPath: directoryPath, directoryIdentity: parentIdentity,
          mismatchError: runtimeDirectoryChangedDuringCreation,
          syncUnsupportedError: parentDirectorySyncUnsupportedDuringCreation,
          syncedStep: 'parent-directory-synced',
        });
      } catch (error) {
        if (created) await rmdir(directoryPath).catch(() => undefined);
        throw error;
      }
    }
    if (!stats || !isSafeDurableOutcomeDirectoryStats(stats)) throw unsafeDurableOutcomePath();
  }
}

async function readDurableOutcomeDirectoryStats(directoryPath: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readDurableOutcomeFilePathSnapshot(
  filePath: string,
): Promise<{ missing: true } | { missing: false; invalid: true } | {
  missing: false;
  invalid: false;
  snapshot: DurableOutcomeFileSnapshot;
}> {
  let stats: BigIntStats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    throw error;
  }
  if (!isSafeDurableOutcomeFileStats(stats)) return { missing: false, invalid: true };
  return { missing: false, invalid: false, snapshot: snapshotDurableOutcomeFile(stats) };
}

function isUnsafeDurableOutcomeOpenError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR';
}

function isRuntimeDirectoryMutationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || isUnsafeDurableOutcomeOpenError(error);
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM'
    || code === 'EACCES'
    || code === 'EINVAL'
    || code === 'UNKNOWN'
    || code === 'EISDIR';
}

function unsafeDurableOutcomePath(): Error {
  return new Error('durable outcome path is unsafe');
}

function durableOutcomeDirectoryChangedDuringPublication(): Error {
  return new Error('durable outcome directory changed during publication');
}

function durableOutcomeDirectoryChangedDuringRead(): Error {
  return new Error('durable outcome directory changed during read');
}

function durableOutcomeDirectorySyncUnsupported(): Error {
  return new Error('outcome directory fsync is unsupported on this platform');
}

function unsafeRuntimeDirectoryPath(): Error {
  return new Error('runtime directory path is unsafe');
}

function runtimeDirectoryChangedDuringSnapshotPublication(): Error {
  return new Error('runtime directory changed during snapshot publication');
}

function durableSnapshotCorruption(): Error {
  return new Error('durable snapshot corruption');
}

function runtimeDirectoryChangedDuringCompaction(): Error {
  return new Error('runtime directory changed during journal compaction');
}

function runtimeDirectoryChangedDuringCreation(): Error {
  return new Error('parent directory changed during runtime directory creation');
}

function runtimeDirectorySyncUnsupportedDuringSnapshotPublication(): Error {
  return new Error('runtime directory fsync is unsupported during snapshot publication');
}

function runtimeDirectorySyncUnsupportedDuringCompaction(): Error {
  return new Error('runtime directory fsync is unsupported during journal compaction');
}

function parentDirectorySyncUnsupportedDuringCreation(): Error {
  return new Error('parent directory fsync is unsupported during runtime directory creation');
}

function snapshotDurableOutcomeFile(stats: BigIntStats): DurableOutcomeFileSnapshot {
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

function sameDurableOutcomeFileSnapshot(
  left: DurableOutcomeFileSnapshot,
  right: DurableOutcomeFileSnapshot,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameDurableOutcomeFileIdentity(
  left: DurableOutcomeFileSnapshot,
  right: DurableOutcomeFileSnapshot,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function removeDurableOutcomePathIfMatching(
  filePath: string,
  expected: DurableOutcomeFileSnapshot,
): Promise<void> {
  const current = await readDurableOutcomeFilePathSnapshot(filePath);
  if (current.missing || current.invalid || !current.snapshot) return;
  if (!sameDurableOutcomeFileIdentity(expected, current.snapshot)) return;
  await unlink(filePath).catch(() => undefined);
}

async function readBoundedStoredOutcome(handle: FileHandle): Promise<string> {
  const opened = snapshotDurableOutcomeFile(await handle.stat({ bigint: true }));
  const maximumSize = BigInt(DURABLE_OUTCOME_RECORD_MAX_BYTES);
  if (opened.size > maximumSize) {
    throw new Error('durable outcome file exceeds the maximum size');
  }

  const buffer = Buffer.alloc(Math.min(Number(opened.size), DURABLE_OUTCOME_RECORD_MAX_BYTES + 1));
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) {
      throw new Error('durable outcome file changed while reading');
    }
    offset += bytesRead;
  }

  const current = snapshotDurableOutcomeFile(await handle.stat({ bigint: true }));
  if (current.size > maximumSize) {
    throw new Error('durable outcome file exceeds the maximum size');
  }
  if (!sameDurableOutcomeFileSnapshot(opened, current)) {
    throw new Error('durable outcome file changed while reading');
  }
  return buffer.toString('utf8');
}

function parseStoredOutcome(raw: string, expectedKey: string): CommandOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('durable outcome JSON corruption');
  }
  return assertStoredOutcomeRecord(parsed, expectedKey).outcome;
}

function serializeStoredOutcomeRecord(value: unknown, expectedKey: string): string {
  const record = assertStoredOutcomeRecord(value, expectedKey);
  const serialized = JSON.stringify(record);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > DURABLE_OUTCOME_RECORD_MAX_BYTES) {
    throw new Error('durable outcome file exceeds the maximum size');
  }
  return serialized;
}

function assertStoredOutcomeRecord(value: unknown, expectedKey: string): StoredOutcomeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid durable outcome record');
  }
  const candidate = value as { idempotencyKey?: unknown; outcome?: unknown };
  if (typeof candidate.idempotencyKey !== 'string') {
    throw new Error('invalid durable outcome record');
  }
  if (candidate.idempotencyKey !== expectedKey) {
    throw new Error('durable outcome key mismatch');
  }
  if (!isStoredCommandOutcome(candidate.outcome)) {
    throw new Error('invalid durable outcome shape');
  }
  return {
    idempotencyKey: candidate.idempotencyKey,
    outcome: candidate.outcome,
  };
}

function isStoredCommandOutcome(value: unknown): value is CommandOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate.status) {
    case 'succeeded':
      return hasOnlyKeys(candidate, ['status', 'value'])
        && !Object.prototype.hasOwnProperty.call(candidate, 'code')
        && !Object.prototype.hasOwnProperty.call(candidate, 'message');
    case 'failed':
    case 'unknown':
    case 'rejected':
      return hasOnlyKeys(candidate, ['status', 'code', 'message'])
        && typeof candidate.code === 'string'
        && typeof candidate.message === 'string'
        && !Object.prototype.hasOwnProperty.call(candidate, 'value');
    default:
      return false;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}
