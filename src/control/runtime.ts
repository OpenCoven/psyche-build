import { LaneLeaseStore } from './leases.js';
import { PromptDispatcher } from './promptDispatch.js';
import type {
  CommandOutcome,
  CommandRecord,
  ControlCommand,
  ControlSnapshot,
  PromptEnvelope,
} from './types.js';

type Payload<K extends ControlCommand['kind']> = Extract<ControlCommand, { kind: K }>['payload'];

export interface ControlHandlers {
  executeOrchestration(payload: Payload<'orchestration.execute'>): Promise<unknown>;
  spawnPane(payload: Payload<'pane.spawn'>): Promise<unknown>;
  sendPrompt(payload: PromptEnvelope): Promise<unknown>;
  interruptPane(payload: Payload<'pane.interrupt'>): Promise<unknown>;
  sendInput(payload: Payload<'pane.input'>): Promise<unknown>;
  openTerminal(payload: Payload<'pane.terminal.open'>): Promise<unknown>;
  resizePane(payload: Payload<'pane.resize'>): Promise<unknown>;
  focusPane(payload: Payload<'pane.focus'>): Promise<unknown>;
  killPane(payload: Payload<'pane.kill'>): Promise<unknown>;
  respawnPane(payload: Payload<'pane.respawn'>): Promise<unknown>;
  openConflictPane(payload: Payload<'pane.conflict.open'>): Promise<unknown>;
  updatePaneOption(payload: Payload<'pane.option.update'>): Promise<unknown>;
  updatePaneMeta(payload: Payload<'pane.meta.update'>): Promise<unknown>;
  launchRitual(payload: Payload<'ritual.launch'>): Promise<unknown>;
  launchCovenSession(payload: Payload<'coven.session.launch'>): Promise<unknown>;
  openCovenSession(payload: Payload<'coven.session.open'>): Promise<unknown>;
  runCovenDesktopAction(payload: Payload<'coven.desktop.action'>): Promise<unknown>;
  executeCovenCapability(payload: Payload<'coven.capability.execute'>): Promise<unknown>;
}

export interface RuntimeEvent {
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RuntimeJournal {
  append(kind: string, payload: Record<string, unknown>): Promise<RuntimeEvent>;
  read(afterSequence: number, limit?: number): RuntimeEvent[];
  findByIdempotencyKey(key: string): RuntimeEvent | undefined;
  recoverNonterminalCommands(): Promise<RuntimeEvent[]>;
}

interface ControlRuntimeOptions {
  ownerEpoch: number;
  handlers: ControlHandlers;
  journal: RuntimeJournal;
}

interface PaneQueueState {
  readonly items: Set<QueuedCommand>;
  tail: Promise<void>;
  blocker?: Promise<void>;
}

interface QueuedCommand {
  readonly command: ControlCommand;
  readonly paneId: string;
  readonly automation: boolean;
  readonly generation: number;
  readonly requested: Promise<RuntimeEvent>;
  started: boolean;
  preempted: boolean;
  terminalized: boolean;
  outcome?: CommandOutcome;
  resolve(outcome: CommandOutcome): void;
  reject(error: unknown): void;
}

const TERMINAL_EVENT_KINDS = new Set([
  'command.succeeded',
  'command.failed',
  'command.unknown',
  'command.rejected',
]);

/**
 * Cap on retained command envelopes for `snapshot()`.
 *
 * A long-running owner drives high-volume pane I/O, and some command payloads
 * (`pane.input` data, `pane.prompt` text) are large. Retaining every envelope
 * forever would grow without bound, so the map keeps only the most recent
 * transactions; the durable record of what happened is the journal.
 */
const MAX_COMMAND_RECORDS = 1000;

export class ControlRuntime {
  public readonly leases = new LaneLeaseStore();

  private readonly outcomesByIdempotencyKey = new Map<string, CommandOutcome>();
  private readonly pendingByIdempotencyKey = new Map<string, Promise<CommandOutcome>>();
  private readonly commandRecords = new Map<string, {
    command: ControlCommand;
    outcome?: CommandOutcome;
    sequence: number;
  }>();
  private readonly paneBarrierGenerations = new Map<string, number>();
  private readonly paneQueues = new Map<string, PaneQueueState>();
  private readonly promptDispatcher: PromptDispatcher;

  private constructor(
    private readonly ownerEpoch: number,
    private readonly handlers: ControlHandlers,
    private readonly journal: RuntimeJournal,
  ) {
    this.promptDispatcher = new PromptDispatcher(async (envelope) => {
      const result = await this.handlers.sendPrompt(envelope);
      if (isReceiptResult(result)) return result;
      return undefined;
    });
  }

  static async create(opts: ControlRuntimeOptions): Promise<ControlRuntime> {
    await opts.journal.recoverNonterminalCommands();
    const runtime = new ControlRuntime(opts.ownerEpoch, opts.handlers, opts.journal);
    runtime.reduceOutcomes(opts.journal.read(0));
    return runtime;
  }

  submit(command: ControlCommand): Promise<CommandOutcome> {
    const prior = this.outcomesByIdempotencyKey.get(command.idempotencyKey);
    if (prior) return Promise.resolve(prior);

    const pending = this.pendingByIdempotencyKey.get(command.idempotencyKey);
    if (pending) return pending;

    const execution = this.submitFresh(command).finally(() => {
      this.pendingByIdempotencyKey.delete(command.idempotencyKey);
    });
    this.pendingByIdempotencyKey.set(command.idempotencyKey, execution);
    return execution;
  }

  events(): RuntimeEvent[] {
    return this.journal.read(0);
  }

  /**
   * A point-in-time view of the runtime for read-only clients.
   *
   * `commands` only contains transactions this process has observed since it
   * became owner. After a restart the journal is replayed for outcome
   * deduplication, but the full command envelopes are not rehydrated, so the
   * map is scoped to the current owner epoch's activity.
   */
  snapshot(): ControlSnapshot {
    const events = this.journal.read(0);
    const sequence = events.length > 0 ? events[events.length - 1].sequence : 0;
    const commands: Record<string, CommandRecord> = {};
    for (const [id, record] of this.commandRecords) {
      if (record.outcome) {
        commands[id] = { command: record.command, outcome: record.outcome, sequence: record.sequence };
      }
    }
    return {
      ownerEpoch: this.ownerEpoch,
      sequence,
      commands,
      leases: this.leases.snapshot(),
    };
  }

  readEvents(afterSequence: number, limit?: number): {
    events: RuntimeEvent[];
    nextSequence: number;
    gap: boolean;
  } {
    const events = this.journal.read(afterSequence, limit);
    const nextSequence = events.length > 0
      ? events[events.length - 1].sequence
      : afterSequence;
    return { events, nextSequence, gap: false };
  }

  blockPaneQueue(paneId: string): () => void {
    const queue = this.queueForPane(paneId);
    let released = false;
    let release!: () => void;
    queue.blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      if (released) return;
      released = true;
      const current = queue.blocker;
      release();
      if (queue.blocker === current) delete queue.blocker;
    };
  }

  private submitFresh(command: ControlCommand): Promise<CommandOutcome> {
    if (command.ownerEpoch < this.ownerEpoch) return this.rejectStaleOwnerEpoch(command);

    if (command.kind === 'pane.delegate') return this.executeDelegate(command);
    if (command.kind === 'pane.takeover') return this.executeTakeover(command);

    const paneId = paneIdForCommand(command);
    if (paneId) {
      return this.enqueuePaneCommand(command, paneId, () => this.executeStartedCommand(command));
    }

    return this.executeImmediateCommand(command);
  }

  private async rejectStaleOwnerEpoch(command: ControlCommand): Promise<CommandOutcome> {
    await this.appendRequested(command);
    return this.appendTerminal(command, {
      status: 'rejected',
      code: 'stale_owner_epoch',
      message: `command owner epoch ${command.ownerEpoch} is stale; active epoch is ${this.ownerEpoch}`,
    });
  }

  private async executeDelegate(command: Extract<ControlCommand, { kind: 'pane.delegate' }>): Promise<CommandOutcome> {
    await this.appendRequested(command);
    if (command.actor.kind !== 'human') {
      return this.appendTerminal(command, {
        status: 'rejected',
        code: 'human_actor_required',
        message: 'pane delegation requires a human actor',
      });
    }

    const lease = this.leases.delegate(
      command.payload.paneId,
      command.payload.automationActorId,
      command.payload.taskId,
      command.payload.ttlMs,
    );
    await this.journal.append('lease.delegated', {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      paneId: lease.paneId,
      actorId: lease.actorId,
      taskId: lease.taskId,
      revision: lease.revision,
    });
    return this.appendTerminal(command, {
      status: 'succeeded',
      value: { actorId: lease.actorId, taskId: lease.taskId, revision: lease.revision },
    });
  }

  private async executeTakeover(command: Extract<ControlCommand, { kind: 'pane.takeover' }>): Promise<CommandOutcome> {
    await this.appendRequested(command);
    this.bumpPaneBarrier(command.payload.paneId);
    await Promise.all(this.preemptQueuedAutomation(command.payload.paneId));

    const lease = this.leases.takeover(command.payload.paneId, command.actor.id);
    await this.journal.append('lease.takeover', {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      paneId: lease.paneId,
      actorId: lease.actorId,
      revision: lease.revision,
    });
    return this.appendTerminal(command, {
      status: 'succeeded',
      value: { actorId: lease.actorId, revision: lease.revision },
    });
  }

  private enqueuePaneCommand(
    command: ControlCommand,
    paneId: string,
    run: () => Promise<CommandOutcome>,
  ): Promise<CommandOutcome> {
    const queue = this.queueForPane(paneId);
    const requested = this.appendRequested(command);
    const generation = this.paneBarrierGenerations.get(paneId) ?? 0;

    const promise = new Promise<CommandOutcome>((resolve, reject) => {
      const item: QueuedCommand = {
        command,
        paneId,
        automation: command.actor.kind === 'psyche',
        generation,
        requested,
        started: false,
        preempted: false,
        terminalized: false,
        resolve,
        reject,
      };
      queue.items.add(item);
      queue.tail = queue.tail
        .then(() => this.runQueuedItem(item, run))
        .catch((error: unknown) => item.reject(error));
    });

    return promise;
  }

  private async runQueuedItem(item: QueuedCommand, run: () => Promise<CommandOutcome>): Promise<void> {
    try {
      await item.requested;
      await this.waitForPaneBlocker(item.paneId);
      if (item.terminalized) return;
      if (item.preempted || this.isStaleAutomationGeneration(item)) {
        await this.terminalizeQueuedItem(item, automationPreemptedOutcome());
        return;
      }

      item.started = true;
      await this.terminalizeQueuedItem(item, await run());
    } catch (error) {
      if (!item.terminalized) {
        try {
          await this.terminalizeQueuedItem(item, failedOutcome(error));
        } catch {
          if (!item.terminalized) item.reject(error);
        }
      }
    } finally {
      const queue = this.paneQueues.get(item.paneId);
      queue?.items.delete(item);
    }
  }

  private async executeImmediateCommand(command: ControlCommand): Promise<CommandOutcome> {
    await this.appendRequested(command);
    return this.appendTerminal(command, await this.executeStartedCommand(command));
  }

  private async executeStartedCommand(command: ControlCommand): Promise<CommandOutcome> {
    try {
      switch (command.kind) {
        case 'pane.prompt':
          return this.executePrompt(command);
        case 'pane.input':
          return this.executeInput(command);
        case 'pane.interrupt':
          this.assertActorLease(command.payload.paneId, command.actor, command.payload.leaseRevision);
          return succeededOutcome(await this.handlers.interruptPane(command.payload));
        case 'pane.spawn':
          return succeededOutcome(await this.handlers.spawnPane(command.payload));
        case 'pane.terminal.open':
          return succeededOutcome(await this.handlers.openTerminal(command.payload));
        case 'pane.resize':
          return succeededOutcome(await this.handlers.resizePane(command.payload));
        case 'pane.focus':
          return succeededOutcome(await this.handlers.focusPane(command.payload));
        case 'pane.kill':
          return succeededOutcome(await this.handlers.killPane(command.payload));
        case 'pane.respawn':
          return succeededOutcome(await this.handlers.respawnPane(command.payload));
        case 'pane.conflict.open':
          return succeededOutcome(await this.handlers.openConflictPane(command.payload));
        case 'pane.option.update':
          return succeededOutcome(await this.handlers.updatePaneOption(command.payload));
        case 'pane.meta.update':
          return succeededOutcome(await this.handlers.updatePaneMeta(command.payload));
        case 'orchestration.execute':
          return succeededOutcome(await this.handlers.executeOrchestration(command.payload));
        case 'ritual.launch':
          return succeededOutcome(await this.handlers.launchRitual(command.payload));
        case 'coven.session.launch':
          return succeededOutcome(await this.handlers.launchCovenSession(command.payload));
        case 'coven.session.open':
          return succeededOutcome(await this.handlers.openCovenSession(command.payload));
        case 'coven.desktop.action':
          return succeededOutcome(await this.handlers.runCovenDesktopAction(command.payload));
        case 'coven.capability.execute':
          return succeededOutcome(await this.handlers.executeCovenCapability(command.payload));
        case 'pane.delegate':
        case 'pane.takeover':
          throw new Error(`lease command reached side-effect executor: ${command.kind}`);
      }
    } catch (error) {
      return failedOutcome(error);
    }
  }

  private async executePrompt(command: Extract<ControlCommand, { kind: 'pane.prompt' }>): Promise<CommandOutcome> {
    this.leases.assertAutomation(command.payload.paneId, command.actor.id, command.payload.leaseRevision);
    const outcome = await this.promptDispatcher.dispatch(command.payload);
    switch (outcome.status) {
      case 'dispatched':
      case 'confirmed':
        return { status: 'succeeded' };
      case 'failed':
        return { status: 'failed', code: outcome.code, message: outcome.message };
      case 'unknown':
        return { status: 'unknown', code: outcome.code, message: outcome.message };
    }
  }

  private async executeInput(command: Extract<ControlCommand, { kind: 'pane.input' }>): Promise<CommandOutcome> {
    this.assertActorLease(command.payload.paneId, command.actor, command.payload.leaseRevision);
    return succeededOutcome(await this.handlers.sendInput(command.payload));
  }

  private assertActorLease(
    paneId: string,
    actor: ControlCommand['actor'],
    leaseRevision: number,
  ): void {
    if (actor.kind === 'psyche') {
      this.leases.assertAutomation(paneId, actor.id, leaseRevision);
      return;
    }
    this.leases.assertHuman(paneId, actor.id, leaseRevision);
  }

  private async terminalizeQueuedItem(item: QueuedCommand, outcome: CommandOutcome): Promise<CommandOutcome> {
    if (item.terminalized) return item.outcome ?? outcome;
    item.terminalized = true;
    item.outcome = outcome;
    try {
      await item.requested;
      await this.appendTerminal(item.command, outcome);
      item.resolve(outcome);
      return outcome;
    } catch (error) {
      item.reject(error);
      throw error;
    }
  }

  private async appendRequested(command: ControlCommand): Promise<RuntimeEvent> {
    const event = await this.journal.append('command.requested', {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      kind: command.kind,
      ownerEpoch: command.ownerEpoch,
    });
    this.retainCommandRecord(command.id, { command, sequence: event.sequence });
    return event;
  }

  private async appendTerminal(command: ControlCommand, outcome: CommandOutcome): Promise<CommandOutcome> {
    const event = await this.journal.append(terminalKindForOutcome(outcome), {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      ...payloadForOutcome(outcome),
    });
    this.outcomesByIdempotencyKey.set(command.idempotencyKey, outcome);
    const record = this.commandRecords.get(command.id);
    if (record) {
      record.outcome = outcome;
      record.sequence = event.sequence;
    } else {
      this.retainCommandRecord(command.id, { command, outcome, sequence: event.sequence });
    }
    return outcome;
  }

  private retainCommandRecord(
    id: string,
    record: { command: ControlCommand; outcome?: CommandOutcome; sequence: number },
  ): void {
    this.commandRecords.delete(id);
    this.commandRecords.set(id, record);
    while (this.commandRecords.size > MAX_COMMAND_RECORDS) {
      const oldest = this.commandRecords.keys().next().value;
      if (oldest === undefined) break;
      this.commandRecords.delete(oldest);
    }
  }

  private reduceOutcomes(events: RuntimeEvent[]): void {
    for (const event of events) {
      if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
      const idempotencyKey = stringPayload(event, 'idempotencyKey');
      if (!idempotencyKey) continue;
      this.outcomesByIdempotencyKey.set(idempotencyKey, outcomeFromEvent(event));
    }
  }

  private queueForPane(paneId: string): PaneQueueState {
    let queue = this.paneQueues.get(paneId);
    if (!queue) {
      queue = { items: new Set<QueuedCommand>(), tail: Promise.resolve() };
      this.paneQueues.set(paneId, queue);
    }
    return queue;
  }

  private waitForPaneBlocker(paneId: string): Promise<void> {
    return this.paneQueues.get(paneId)?.blocker ?? Promise.resolve();
  }

  private bumpPaneBarrier(paneId: string): void {
    this.paneBarrierGenerations.set(paneId, (this.paneBarrierGenerations.get(paneId) ?? 0) + 1);
  }

  private preemptQueuedAutomation(paneId: string): Promise<CommandOutcome>[] {
    const queue = this.paneQueues.get(paneId);
    if (!queue) return [];
    const preemptions: Promise<CommandOutcome>[] = [];
    for (const item of queue.items) {
      if (!item.automation || item.started || item.terminalized) continue;
      item.preempted = true;
      preemptions.push(this.terminalizeQueuedItem(item, automationPreemptedOutcome()));
    }
    return preemptions;
  }

  private isStaleAutomationGeneration(item: QueuedCommand): boolean {
    return item.automation && item.generation !== (this.paneBarrierGenerations.get(item.paneId) ?? 0);
  }
}

function paneIdForCommand(command: ControlCommand): string | undefined {
  switch (command.kind) {
    case 'pane.prompt':
    case 'pane.interrupt':
    case 'pane.input':
    case 'pane.resize':
    case 'pane.focus':
    case 'pane.kill':
    case 'pane.respawn':
    case 'pane.option.update':
    case 'pane.meta.update':
      return command.payload.paneId;
    case 'pane.conflict.open':
      return command.payload.sourcePaneId;
    default:
      return undefined;
  }
}

function succeededOutcome(value: unknown): CommandOutcome {
  return value === undefined ? { status: 'succeeded' } : { status: 'succeeded', value };
}

function failedOutcome(error: unknown): CommandOutcome {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'command_failed';
  return {
    status: 'failed',
    code,
    message: error instanceof Error ? error.message : String(error),
  };
}

function automationPreemptedOutcome(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'automation_preempted',
    message: 'queued automation command was preempted by human takeover',
  };
}

function terminalKindForOutcome(outcome: CommandOutcome): string {
  switch (outcome.status) {
    case 'succeeded':
      return 'command.succeeded';
    case 'failed':
      return 'command.failed';
    case 'unknown':
      return 'command.unknown';
    case 'rejected':
      return 'command.rejected';
  }
}

function payloadForOutcome(outcome: CommandOutcome): Record<string, unknown> {
  if (outcome.status === 'succeeded') {
    return 'value' in outcome ? { status: outcome.status, value: outcome.value } : { status: outcome.status };
  }
  return { status: outcome.status, code: outcome.code, message: outcome.message };
}

function outcomeFromEvent(event: RuntimeEvent): CommandOutcome {
  switch (event.kind) {
    case 'command.succeeded':
      return Object.prototype.hasOwnProperty.call(event.payload, 'value')
        ? { status: 'succeeded', value: event.payload.value }
        : { status: 'succeeded' };
    case 'command.rejected':
      return {
        status: 'rejected',
        code: stringPayload(event, 'code') ?? 'command_rejected',
        message: stringPayload(event, 'message') ?? 'command was rejected',
      };
    case 'command.failed':
      return {
        status: 'failed',
        code: stringPayload(event, 'code') ?? 'command_failed',
        message: stringPayload(event, 'message') ?? 'command failed',
      };
    case 'command.unknown':
      return {
        status: 'unknown',
        code: stringPayload(event, 'code') ?? stringPayload(event, 'reason') ?? 'command_unknown',
        message: stringPayload(event, 'message') ?? 'command outcome is unknown',
      };
    default:
      throw new Error(`not a terminal command event: ${event.kind}`);
  }
}

function stringPayload(event: RuntimeEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function isReceiptResult(value: unknown): value is { receiptId?: string } {
  return typeof value === 'object' && value !== null &&
    (!('receiptId' in value) || typeof (value as { receiptId?: unknown }).receiptId === 'string');
}
