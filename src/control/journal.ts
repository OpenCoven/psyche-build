import { mkdir, open, readFile, rename, truncate } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ControlSnapshot } from './types.js';
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
          status: input.status, receipt }
      : { commandId: input.commandId, idempotencyKey: input.idempotencyKey,
          status: input.status,
          ...(input.status === 'succeeded' ? {} : { code: input.code ?? 'surface_command_failed' }) },
  };
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
 * ControlSnapshot: `outcomes` and `receiptRecords` are the durable half of the
 * runtime's bounded in-memory state, which the wire type does not carry
 * (`ControlSnapshot.commands` is scoped to the current owner epoch) and which
 * a compacted journal can therefore no longer rebuild by replay.
 */
export interface JournalSnapshotFile {
  snapshot: ControlSnapshot;
  coveredSequence: number;
  outcomes: Record<string, CommandOutcome>;
  receiptRecords: DurableReceiptRecord[];
}

export interface DurableReceiptRecord {
  readonly sequence: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly receipt: JournalActionReceipt;
}

export class ControlJournal {
  readonly path: string;
  private readonly snapshotPath: string;
  private currentSequence: number;
  private firstRetainedSequence: number;
  private readonly ownerEpoch: number;
  private readonly events: ControlEvent[];
  private readonly idempotencyIndex = new Map<string, ControlEvent>();
  private readonly listeners = new Set<EventListener>();
  private appendTail: Promise<void> = Promise.resolve();

  private constructor(
    journalPath: string,
    snapshotPath: string,
    ownerEpoch: number,
    events: ControlEvent[],
    firstSequence: number,
  ) {
    this.path = journalPath;
    this.snapshotPath = snapshotPath;
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
    await mkdir(runtimeDir, { recursive: true });
    const journalPath = path.join(runtimeDir, 'events.ndjson');
    const snapshotPath = path.join(runtimeDir, 'snapshot.json');
    const { events, firstSequence } = await ControlJournal.replay(journalPath);
    return new ControlJournal(journalPath, snapshotPath, ownerEpoch, events, firstSequence);
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

  async loadSnapshot(): Promise<JournalSnapshotFile | undefined> {
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<JournalSnapshotFile>;
      if (!parsed || typeof parsed.coveredSequence !== 'number') return undefined;
      return {
        snapshot: parsed.snapshot as ControlSnapshot,
        coveredSequence: parsed.coveredSequence,
        outcomes: parsed.outcomes ?? {},
        receiptRecords: parsed.receiptRecords ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async writeSnapshot(file: JournalSnapshotFile): Promise<void> {
    const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(JSON.stringify(file), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.snapshotPath);
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
  compact(coveredSequence: number): Promise<void> {
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

      const temporary = `${this.path}.${process.pid}.tmp`;
      const handle = await open(temporary, 'w');
      try {
        await handle.writeFile(`${body}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);

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

  async recoverNonterminalCommands(): Promise<ControlEvent[]> {
    const terminalTransactions = new Set<string>();
    const nonterminal = new Map<string, ControlEvent>();
    const terminalKinds = new Set(['command.succeeded', 'command.failed', 'command.unknown', 'command.rejected']);
    const openKinds = new Set(['command.requested', 'command.accepted', 'command.running']);
    for (const event of this.events) {
      const commandId = event.payload.commandId as string | undefined;
      if (!commandId) continue;
      const transaction = commandTransactionKey(commandId, event.payload.idempotencyKey);
      if (terminalKinds.has(event.kind)) terminalTransactions.add(transaction);
      else if (openKinds.has(event.kind)) nonterminal.set(transaction, event);
    }
    const recovered: ControlEvent[] = [];
    for (const [transaction, event] of nonterminal) {
      if (terminalTransactions.has(transaction)) continue;
      recovered.push(await this.append('command.unknown', {
        commandId: event.payload.commandId,
        idempotencyKey: event.payload.idempotencyKey,
        reason: 'recovered-nonterminal',
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
    if (key) this.idempotencyIndex.set(key, event);
  }
}

function commandTransactionKey(commandId: string, idempotencyKey: unknown): string {
  return JSON.stringify([commandId, typeof idempotencyKey === 'string' ? idempotencyKey : '']);
}
