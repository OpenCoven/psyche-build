import { mkdir, open, readFile, rename, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ControlSnapshot } from './types.js';
import type { ActionReceipt, CommandOutcome, ControlCommand } from './types.js';
import type { RedactedApprovalEffect } from './approvals.js';

export type AgentControlJournalKind =
  | 'command.requested' | 'command.succeeded' | 'command.failed'
  | 'command.unknown' | 'command.rejected' | 'approval.requested';

export type AgentControlJournalInput =
  | { kind: 'command.requested'; commandId: string; idempotencyKey: string;
      commandKind: ControlCommand['kind']; ownerEpoch: number }
  | { kind: 'approval.requested'; commandId: string; approvalId: string; payloadDigest: string;
      resource: ActionReceipt['resource']; capability: string; effect: {
        readonly kind: RedactedApprovalEffect['kind']; readonly target: string;
      } }
  | { kind: Exclude<AgentControlJournalKind, 'command.requested' | 'approval.requested'>;
      commandId: string; idempotencyKey: string; outcome: CommandOutcome; receipt?: ActionReceipt };

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
  if (input.kind === 'approval.requested') return {
    kind: input.kind,
    payload: { commandId: input.commandId, approvalId: input.approvalId,
      payloadDigest: input.payloadDigest, resource: input.resource,
      capability: input.capability, effect: input.effect },
  };
  const receipt = input.receipt ? journalReceipt(input.receipt) : undefined;
  return {
    kind: input.kind,
    payload: receipt
      ? { commandId: input.commandId, idempotencyKey: input.idempotencyKey,
          status: input.outcome.status, receipt }
      : { commandId: input.commandId, idempotencyKey: input.idempotencyKey,
          status: input.outcome.status,
          ...(input.outcome.status === 'succeeded' ? {} : { code: 'surface_command_failed' }) },
  };
}

function journalReceipt(receipt: ActionReceipt): ActionReceipt {
  return Object.freeze({
    schema: receipt.schema,
    actionId: receipt.actionId,
    state: receipt.state,
    resource: receipt.resource,
    createdAt: receipt.createdAt,
    ...(receipt.completedAt ? { completedAt: receipt.completedAt } : {}),
    ...(receipt.code ? { code: receipt.code } : {}),
    ...(receipt.sourceDigest ? { sourceDigest: receipt.sourceDigest } : {}),
    ...(receipt.sourceBytes !== undefined ? { sourceBytes: receipt.sourceBytes } : {}),
    ...(receipt.resultBytes !== undefined ? { resultBytes: receipt.resultBytes } : {}),
    ...(receipt.durationMs !== undefined ? { durationMs: receipt.durationMs } : {}),
  });
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

export class ControlJournal {
  readonly path: string;
  private readonly snapshotPath: string;
  private currentSequence: number;
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
  ) {
    this.path = journalPath;
    this.snapshotPath = snapshotPath;
    this.ownerEpoch = ownerEpoch;
    this.events = events;
    this.currentSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
    for (const event of events) this.indexIdempotency(event);
  }

  static async open(projectRoot: string, ownerEpoch: number): Promise<ControlJournal> {
    const runtimeDir = path.join(projectRoot, '.psyche', 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const journalPath = path.join(runtimeDir, 'events.ndjson');
    const snapshotPath = path.join(runtimeDir, 'snapshot.json');
    const events = await ControlJournal.replay(journalPath);
    return new ControlJournal(journalPath, snapshotPath, ownerEpoch, events);
  }

  private static async replay(journalPath: string): Promise<ControlEvent[]> {
    let raw: Buffer;
    try {
      raw = await readFile(journalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (raw.length === 0) return [];
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
    const events: ControlEvent[] = [];
    let expectedSequence = 1;
    for (let index = 0; index < segments.length; index += 1) {
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
    return events;
  }

  get sequence(): number {
    return this.currentSequence;
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
    const slice = this.events.filter((event) => event.sequence > afterSequence);
    return typeof limit === 'number' ? slice.slice(0, limit) : slice;
  }

  findByIdempotencyKey(key: string): ControlEvent | undefined {
    return this.idempotencyIndex.get(key);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadSnapshot(): Promise<(ControlSnapshot & { coveredSequence: number }) | undefined> {
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      return JSON.parse(raw) as ControlSnapshot & { coveredSequence: number };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async writeSnapshot(snapshot: ControlSnapshot, coveredSequence: number): Promise<void> {
    const temporary = `${this.snapshotPath}.${process.pid}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(JSON.stringify({ ...snapshot, coveredSequence }), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.snapshotPath);
  }

  async recoverNonterminalCommands(): Promise<ControlEvent[]> {
    const terminalByCommand = new Map<string, boolean>();
    const nonterminal = new Map<string, ControlEvent>();
    const terminalKinds = new Set(['command.succeeded', 'command.failed', 'command.unknown', 'command.rejected']);
    const openKinds = new Set(['command.requested', 'command.accepted', 'command.running']);
    for (const event of this.events) {
      const commandId = event.payload.commandId as string | undefined;
      if (!commandId) continue;
      if (terminalKinds.has(event.kind)) terminalByCommand.set(commandId, true);
      else if (openKinds.has(event.kind)) nonterminal.set(commandId, event);
    }
    const recovered: ControlEvent[] = [];
    for (const [commandId, event] of nonterminal) {
      if (terminalByCommand.get(commandId)) continue;
      recovered.push(await this.append('command.unknown', {
        commandId,
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
