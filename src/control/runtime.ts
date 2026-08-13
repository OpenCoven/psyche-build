import { LaneLeaseStore } from './leases.js';
import { PromptDispatcher } from './promptDispatch.js';
import { ApprovalStore, createRedactedApprovalEffect, type Approval, type RedactedApprovalEffect } from './approvals.js';
import { CapabilityLeaseStore, type LeaseTarget, type SurfaceCapability } from './capabilityLeases.js';
import {
  classifyBrowserAction,
  classifyBrowserScript,
  classifyPaneAction,
  type CanonicalElementSemantics,
  type PolicyClassification,
} from './policy.js';
import { SurfaceRegistry } from './surfaces.js';
import type {
  ActionReceipt,
  CommandOutcome,
  CommandRecord,
  ControlCommand,
  ControlSnapshot,
  PromptEnvelope,
} from './types.js';

export type Payload<K extends ControlCommand['kind']> = Extract<ControlCommand, { kind: K }>['payload'];

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
  observePane(payload: Payload<'pane.observe'>): Promise<unknown>;
  actOnPane(payload: Payload<'pane.action'>): Promise<unknown>;
  inspectBrowser(payload: Payload<'browser.inspect'>): Promise<unknown>;
  actOnBrowser(payload: Payload<'browser.action'>): Promise<unknown>;
  runBrowserScript(payload: Payload<'browser.script'>): Promise<unknown>;
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
  surfaces?: SurfaceRegistry;
  capabilityLeases?: CapabilityLeaseStore;
  approvals?: ApprovalStore;
  resolveBrowserElementSemantics?: (input: {
    tabId: string;
    generation: number;
    snapshotId: string;
    elementRef: string;
  }) => CanonicalElementSemantics | Promise<CanonicalElementSemantics>;
}

interface LeaseRequestRecord {
  id: string;
  actorId: string;
  taskId: string;
  status: 'pending' | 'granted' | 'released' | 'revoked';
  createdAt: string;
}

interface SurfaceActionContext {
  command: Extract<ControlCommand, { kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script' }>;
  target: LeaseTarget;
  classification: PolicyClassification;
  effect?: RedactedApprovalEffect;
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
  readonly queueKey: string;
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
  public readonly surfaces: SurfaceRegistry;
  public readonly capabilityLeases: CapabilityLeaseStore;
  public readonly approvals: ApprovalStore;

  private readonly outcomesByIdempotencyKey = new Map<string, CommandOutcome>();
  private readonly pendingByIdempotencyKey = new Map<string, Promise<CommandOutcome>>();
  private readonly commandRecords = new Map<string, {
    command: ControlCommand;
    outcome?: CommandOutcome;
    sequence: number;
  }>();
  private readonly paneBarrierGenerations = new Map<string, number>();
  private readonly promptDispatcher: PromptDispatcher;
  private readonly resourceQueues = new Map<string, PaneQueueState>();
  private readonly leaseRequests = new Map<string, LeaseRequestRecord>();
  private readonly pendingApprovals = new Map<string, SurfaceActionContext>();
  private readonly receipts = new Map<string, ActionReceipt>();
  private readonly passiveTerminalizations = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly ownerEpoch: number,
    private readonly handlers: ControlHandlers,
    private readonly journal: RuntimeJournal,
    options: ControlRuntimeOptions,
  ) {
    this.surfaces = options.surfaces ?? new SurfaceRegistry();
    this.capabilityLeases = options.capabilityLeases ?? new CapabilityLeaseStore(undefined, ownerEpoch);
    this.approvals = options.approvals ?? new ApprovalStore();
    this.resolveBrowserElementSemantics = options.resolveBrowserElementSemantics;
    this.promptDispatcher = new PromptDispatcher(async (envelope) => {
      const result = await this.handlers.sendPrompt(envelope);
      if (isReceiptResult(result)) return result;
      return undefined;
    });
  }

  static async create(opts: ControlRuntimeOptions): Promise<ControlRuntime> {
    await opts.journal.recoverNonterminalCommands();
    const runtime = new ControlRuntime(opts.ownerEpoch, opts.handlers, opts.journal, opts);
    runtime.capabilityLeases.revokeAll();
    runtime.approvals.revokeAll();
    runtime.reduceOutcomes(opts.journal.read(0));
    return runtime;
  }

  private readonly resolveBrowserElementSemantics?: ControlRuntimeOptions['resolveBrowserElementSemantics'];

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
    this.expireApprovalsForSnapshot();
    const events = this.journal.read(0);
    const sequence = events.length > 0 ? events[events.length - 1].sequence : 0;
    const commands: Record<string, CommandRecord> = {};
    for (const [id, record] of this.commandRecords) {
      if (record.outcome) {
        commands[id] = { command: record.command, outcome: record.outcome, sequence: record.sequence };
      }
    }
    const approvals = this.approvals.snapshot();
    this.prunePendingApprovals(approvals);
    return {
      ownerEpoch: this.ownerEpoch,
      sequence,
      commands,
      leases: this.leases.snapshot(),
      resources: this.surfaces.list(),
      capabilityLeases: this.capabilityLeases.snapshot(),
      leaseRequests: [...this.leaseRequests.values()].map((request) => ({ ...request })),
      approvals,
      receipts: [...this.receipts.values()],
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
    return this.blockResourceQueue(this.resourceTargetForPane(paneId));
  }

  blockResourceQueue(target: LeaseTarget): () => void {
    const queue = this.queueForResource(target);
    let released = false;
    let release!: () => void;
    queue.blocker = new Promise<void>((resolve) => { release = resolve; });
    return () => {
      if (released) return;
      released = true;
      const current = queue.blocker;
      release();
      if (queue.blocker === current) delete queue.blocker;
    };
  }

  private submitFresh(command: ControlCommand): Promise<CommandOutcome> {
    if (
      command.ownerEpoch < this.ownerEpoch
      || (isSurfaceControlCommand(command) && command.ownerEpoch !== this.ownerEpoch)
    ) return this.rejectStaleOwnerEpoch(command);

    if (isSurfaceControlCommand(command)) return this.executeSurfaceControlCommand(command);

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
    const surface = this.surfaces.get(command.payload.paneId);
    if (surface?.kind === 'pane') {
      await this.revokeTarget({ kind: 'pane', id: surface.id, generation: surface.generation });
    }
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

  private async executeSurfaceControlCommand(
    command: Extract<ControlCommand, { kind:
      | 'lease.request' | 'lease.grant' | 'lease.release' | 'lease.revoke'
      | 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action'
      | 'browser.script' | 'approval.resolve' | 'provider.resource.upsert'
      | 'provider.resource.remove' }>,
  ): Promise<CommandOutcome> {
    await this.appendRequested(command);
    try {
      if (requiresOperator(command.kind) && command.actor.kind !== 'human') {
        return this.appendTerminal(command, rejectedOutcome('operator_required', 'command requires an operator'));
      }
      switch (command.kind) {
        case 'lease.request': {
          const request: LeaseRequestRecord = {
            id: command.id, actorId: command.actor.id, taskId: command.payload.taskId,
            status: 'pending', createdAt: command.createdAt,
          };
          this.leaseRequests.set(request.id, request);
          while (this.leaseRequests.size > MAX_COMMAND_RECORDS) {
            const oldest = this.leaseRequests.keys().next().value;
            if (oldest === undefined) break;
            this.leaseRequests.delete(oldest);
          }
          return this.appendTerminal(command, succeededOutcome({ requestId: request.id }));
        }
        case 'lease.grant': {
          this.assertGrantTargets(command.payload.grants, command.projectRoot);
          const lease = this.capabilityLeases.grant({ ...command.payload, grantedBy: command.actor.id });
          const request = this.leaseRequests.get(command.payload.requestId);
          if (request) request.status = 'granted';
          return this.appendTerminal(command, succeededOutcome({ lease }));
        }
        case 'lease.release': {
          const lease = this.capabilityLeases.snapshot().find((item) => item.id === command.payload.leaseId);
          if (!lease || lease.actorId !== command.actor.id || lease.taskId !== command.payload.taskId
            || lease.revision !== command.payload.leaseRevision) {
            throw codedRuntimeError('capability_denied', 'only the owning task may release a capability lease');
          }
          this.capabilityLeases.release(lease.id);
          await this.terminalizeRevokedApprovals(this.approvals.revokeForLease(lease.id));
          const request = this.leaseRequests.get(lease.requestId);
          if (request) request.status = 'released';
          return this.appendTerminal(command, succeededOutcome());
        }
        case 'lease.revoke': {
          const lease = this.capabilityLeases.revoke(command.payload.leaseId);
          if (lease) {
            await this.terminalizeRevokedApprovals(this.approvals.revokeForLease(lease.id));
            const request = this.leaseRequests.get(lease.requestId);
            if (request) request.status = 'revoked';
          }
          return this.appendTerminal(command, succeededOutcome());
        }
        case 'provider.resource.upsert': {
          const resource = this.surfaces.upsertBrowserTab(command.payload.resource);
          return this.appendTerminal(command, succeededOutcome({ resource }));
        }
        case 'provider.resource.remove': {
          const current = this.surfaces.require(command.payload.id, command.payload.generation);
          if (current.kind !== 'browser_tab') throw codedRuntimeError('resource_missing', 'browser resource is missing');
          const removed = this.surfaces.removeByProvider(current.providerId);
          for (const item of removed) {
            await this.revokeTarget({ kind: 'browser_tab', id: item.id, generation: item.generation });
          }
          return this.appendTerminal(command, succeededOutcome());
        }
        case 'approval.resolve':
          return await this.resolveApproval(command);
        default: {
          const context = await this.prepareSurfaceAction(command);
          if (context.classification.decision === 'approval') {
            if (!context.effect) throw codedRuntimeError('approval_payload_invalid', 'approval effect is missing');
            this.prunePendingApprovals(this.approvals.snapshot());
            const immutableContext = freezeContext(context);
            const approval = this.approvals.request({
              actionId: command.id,
              ownerEpoch: command.ownerEpoch,
              leaseId: command.payload.leaseId,
              leaseRevision: command.payload.leaseRevision,
              resource: context.target,
              capability: context.classification.capability,
              effect: context.effect,
            });
            this.pendingApprovals.set(approval.id, immutableContext);
            await this.journal.append('approval.requested', {
              commandId: command.id,
              approvalId: approval.id,
              payloadDigest: approval.payloadDigest,
              resource: approval.resource,
              capability: approval.capability,
              effect: approval.effect,
            });
            const receipt = this.makeReceipt(command, context.target, 'approval_required', {
              value: { approvalId: approval.id, payloadDigest: approval.payloadDigest },
            });
            this.rememberReceipt(receipt);
            return this.appendTerminal(command, succeededOutcome({
              ...receipt,
              approvalId: approval.id,
              payloadDigest: approval.payloadDigest,
            }));
          }
          const receipt = await this.enqueueSurfaceEffect(context);
          return this.appendTerminal(command, outcomeForReceipt(receipt), receipt);
        }
      }
    } catch (error) {
      if (isSurfaceActionCommand(command)) {
        return this.terminalizeValidationFailure(command, targetForSurfaceAction(command));
      }
      return this.appendTerminal(command, failedOutcome(error));
    }
  }

  private async prepareSurfaceAction(
    command: SurfaceActionContext['command'],
  ): Promise<SurfaceActionContext> {
    this.assertCommandCurrent(command);
    let target: LeaseTarget;
    let classification: PolicyClassification;
    let effect: RedactedApprovalEffect | undefined;
    switch (command.kind) {
      case 'pane.observe':
        target = { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
        classification = { decision: 'allow', capability: 'pane.observe' };
        break;
      case 'pane.action':
        if (command.payload.action.kind === 'create') {
          if (!command.payload.projectId) throw codedRuntimeError('resource_missing', 'project target is missing');
          target = { kind: 'project', id: command.payload.projectId };
        } else {
          if (!command.payload.paneId || command.payload.generation === undefined) {
            throw codedRuntimeError('resource_missing', 'pane target is missing');
          }
          target = { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
        }
        classification = classifyPaneAction(command.payload.action);
        if (classification.decision === 'approval') {
          effect = createRedactedApprovalEffect({ kind: 'close', target: target.id });
        }
        break;
      case 'browser.inspect':
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        classification = {
          decision: 'allow',
          capability: command.payload.includeScreenshot ? 'browser.screenshot' : 'browser.inspect',
        };
        break;
      case 'browser.action': {
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        const action = command.payload.action;
        let semantic: CanonicalElementSemantics | undefined;
        if ('elementRef' in action) {
          if (!command.payload.snapshotId || !this.resolveBrowserElementSemantics) {
            throw codedRuntimeError('snapshot_missing', 'runtime semantic snapshot lookup is unavailable');
          }
          semantic = await this.resolveBrowserElementSemantics({
            tabId: command.payload.tabId,
            generation: command.payload.generation,
            snapshotId: command.payload.snapshotId,
            elementRef: action.elementRef,
          });
        }
        classification = classifyBrowserAction({ kind: action.kind, ...(semantic ? { semantic } : {}) });
        effect = approvalEffectForBrowserAction(action, semantic);
        break;
      }
      case 'browser.script':
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        classification = classifyBrowserScript();
        effect = createRedactedApprovalEffect({ kind: 'script', target: command.payload.source });
        break;
    }
    this.assertSurfaceAndLease(command, target, classification.capability);
    return { command, target, classification, ...(effect ? { effect } : {}) };
  }

  private async resolveApproval(
    command: Extract<ControlCommand, { kind: 'approval.resolve' }>,
  ): Promise<CommandOutcome> {
    const context = this.pendingApprovals.get(command.payload.approvalId);
    let approval: Approval;
    try {
      approval = command.payload.decision === 'approve'
        ? this.approvals.approve(command.payload.approvalId, command.actor.id, command.payload.payloadDigest)
        : this.approvals.deny(command.payload.approvalId, command.actor.id, command.payload.payloadDigest);
    } catch (error) {
      if (
        context
        && isApprovalInvalidationError(error)
        && !this.passiveTerminalizations.has(command.payload.approvalId)
      ) {
        await this.terminalizeValidationFailure(context.command, context.target, 'action_invalidated');
        this.pendingApprovals.delete(command.payload.approvalId);
      }
      throw error;
    }
    if (!context) throw codedRuntimeError('approval_missing', 'original approval command is unavailable');
    if (command.payload.decision === 'deny') {
      const receipt = this.makeReceipt(context.command, context.target, 'denied', { code: 'approval_denied' });
      this.rememberReceipt(receipt);
      this.pendingApprovals.delete(approval.id);
      return this.appendTerminal(command, succeededOutcome(receipt));
    }
    if (!context.effect) throw codedRuntimeError('approval_payload_invalid', 'approval effect is unavailable');
    try {
      this.assertSurfaceAndLease(context.command, context.target, context.classification.capability);
      this.approvals.consume({
        approvalId: approval.id,
        payloadDigest: command.payload.payloadDigest,
        actionId: context.command.id,
        ownerEpoch: context.command.ownerEpoch,
        leaseId: context.command.payload.leaseId,
        leaseRevision: context.command.payload.leaseRevision,
        resource: context.target,
        capability: context.classification.capability,
        effect: context.effect,
      });
      this.pendingApprovals.delete(approval.id);
      const receipt = await this.enqueueSurfaceEffect(context);
      if (receipt.state === 'failed' && receipt.code === 'action_invalidated') {
        await this.appendTerminal(context.command, outcomeForReceipt(receipt), receipt);
      }
      return this.appendTerminal(command, outcomeForReceipt(receipt), receipt);
    } catch (error) {
      await this.terminalizeRevokedApprovals(this.approvals.revokeForLease(approval.leaseId));
      this.pendingApprovals.delete(approval.id);
      throw error;
    }
  }

  private async enqueueSurfaceEffect(context: SurfaceActionContext): Promise<ActionReceipt> {
    const queue = this.queueForResource(context.target);
    const prior = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      await (queue.blocker ?? Promise.resolve());
      try {
        this.assertCommandCurrent(context.command);
        const current = await this.prepareSurfaceAction(context.command);
        if (!contextsMatch(context, current)) {
          throw codedRuntimeError('approval_identity_mismatch', 'action intent changed during revalidation');
        }
      } catch {
        const receipt = this.makeReceipt(context.command, context.target, 'failed', {
          code: context.classification.decision === 'approval'
            ? 'action_invalidated'
            : 'action_validation_failed',
        });
        this.rememberReceipt(receipt);
        return receipt;
      }
      let value: unknown;
      try {
        switch (context.command.kind) {
          case 'pane.observe': value = await this.handlers.observePane(context.command.payload); break;
          case 'pane.action': value = await this.handlers.actOnPane(context.command.payload); break;
          case 'browser.inspect': value = await this.handlers.inspectBrowser(context.command.payload); break;
          case 'browser.action': value = await this.handlers.actOnBrowser(context.command.payload); break;
          case 'browser.script': value = await this.handlers.runBrowserScript(context.command.payload); break;
        }
      } catch (error) {
        const ambiguous = Boolean(error && typeof error === 'object' && (error as { ambiguous?: unknown }).ambiguous);
        const receipt = this.makeReceipt(context.command, context.target, ambiguous ? 'unknown' : 'failed', {
          code: ambiguous ? 'effect_unknown' : 'effect_failed',
        });
        this.rememberReceipt(receipt);
        return receipt;
      }
      const receipt = this.makeReceipt(context.command, context.target, 'succeeded', { value });
      this.rememberReceipt(receipt);
      return receipt;
    } finally {
      release();
    }
  }

  private enqueuePaneCommand(
    command: ControlCommand,
    paneId: string,
    run: () => Promise<CommandOutcome>,
  ): Promise<CommandOutcome> {
    const queue = this.queueForPane(paneId);
    const queueKey = resourceKey(this.resourceTargetForPane(paneId));
    const requested = this.appendRequested(command);
    const generation = this.paneBarrierGenerations.get(paneId) ?? 0;

    const promise = new Promise<CommandOutcome>((resolve, reject) => {
      const item: QueuedCommand = {
        command,
        paneId,
        automation: command.actor.kind === 'psyche',
        generation,
        requested,
        queueKey,
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
      await this.waitForQueueBlocker(item.queueKey);
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
      const queue = this.resourceQueues.get(item.queueKey);
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
        case 'lease.request':
        case 'lease.grant':
        case 'lease.release':
        case 'lease.revoke':
        case 'pane.observe':
        case 'pane.action':
        case 'browser.inspect':
        case 'browser.action':
        case 'browser.script':
        case 'approval.resolve':
        case 'provider.resource.upsert':
        case 'provider.resource.remove':
          throw Object.assign(new Error('agent surface command is not implemented'), {
            code: 'command_not_implemented',
          });
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

  private assertGrantTargets(grants: readonly { target: LeaseTarget; capabilities: readonly SurfaceCapability[] }[], projectRoot: string): void {
    for (const grant of grants) {
      if (grant.target.kind === 'project') {
        if (grant.target.id !== projectRoot || grant.capabilities.some((capability) => capability !== 'pane.create')) {
          throw codedRuntimeError('capability_denied', 'project grants are limited to pane.create for this project');
        }
      } else {
        const resource = this.surfaces.require(grant.target.id, grant.target.generation);
        if (resource.kind !== grant.target.kind) {
          throw codedRuntimeError('resource_missing', 'surface target kind does not match the registered resource');
        }
      }
    }
  }

  private assertCommandCurrent(command: SurfaceActionContext['command']): void {
    if (command.ownerEpoch !== this.ownerEpoch) {
      throw codedRuntimeError('stale_owner_epoch', 'action belongs to another owner epoch');
    }
    if (command.expiresAt && Date.parse(command.expiresAt) <= Date.now()) {
      throw codedRuntimeError('action_expired', 'action expired before execution');
    }
  }

  private assertSurfaceAndLease(
    command: SurfaceActionContext['command'],
    target: LeaseTarget,
    capability: SurfaceCapability,
  ): void {
    if (target.kind !== 'project') {
      const resource = this.surfaces.require(target.id, target.generation);
      if (resource.kind !== target.kind) {
        throw codedRuntimeError('resource_missing', 'surface target kind does not match the registered resource');
      }
    } else if (target.id !== command.projectRoot) {
      throw codedRuntimeError('resource_missing', 'project target does not match the command project');
    }
    this.capabilityLeases.assert({
      leaseId: command.payload.leaseId,
      revision: command.payload.leaseRevision,
      ownerEpoch: command.ownerEpoch,
      actorId: command.actor.id,
      taskId: command.payload.taskId,
      target,
      capability,
    });
  }

  private async revokeTarget(target: LeaseTarget): Promise<void> {
    for (const lease of this.capabilityLeases.revokeTarget(target)) {
      await this.terminalizeRevokedApprovals(this.approvals.revokeForLease(lease.id));
      const request = this.leaseRequests.get(lease.requestId);
      if (request) request.status = 'revoked';
    }
  }

  private async terminalizeRevokedApprovals(approvals: readonly Approval[]): Promise<void> {
    for (const approval of approvals) {
      const context = this.pendingApprovals.get(approval.id);
      if (!context) continue;
      await this.terminalizeValidationFailure(context.command, context.target, 'action_invalidated');
      this.pendingApprovals.delete(approval.id);
    }
  }

  private expireApprovalsForSnapshot(): void {
    for (const approval of this.approvals.expire()) {
      const context = this.pendingApprovals.get(approval.id);
      if (!context || this.passiveTerminalizations.has(approval.id)) continue;
      const terminalization = this.terminalizeValidationFailure(
        context.command,
        context.target,
        'approval_expired',
      );
      this.passiveTerminalizations.set(approval.id, terminalization);
      void terminalization
        .then(() => this.pendingApprovals.delete(approval.id))
        .catch(() => undefined)
        .finally(() => this.passiveTerminalizations.delete(approval.id));
    }
  }

  private makeReceipt(
    command: SurfaceActionContext['command'],
    target: LeaseTarget,
    state: ActionReceipt['state'],
    details: { code?: string; message?: string; value?: unknown } = {},
  ): ActionReceipt {
    return Object.freeze({
      schema: 'psyche.control.receipt/v1' as const,
      actionId: command.id,
      state,
      resource: Object.freeze({ ...target }),
      createdAt: command.createdAt,
      ...(state === 'approval_required' ? {} : { completedAt: new Date().toISOString() }),
      ...details,
    });
  }

  private rememberReceipt(receipt: ActionReceipt): void {
    const redacted = redactReceipt(receipt);
    this.receipts.delete(receipt.actionId);
    this.receipts.set(receipt.actionId, redacted);
    while (this.receipts.size > MAX_COMMAND_RECORDS) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
  }

  private async terminalizeValidationFailure(
    command: SurfaceActionContext['command'],
    target: LeaseTarget,
    code = 'action_validation_failed',
  ): Promise<CommandOutcome> {
    const receipt = this.makeReceipt(command, target, 'failed', { code });
    this.rememberReceipt(receipt);
    const outcome = outcomeForReceipt(receipt);
    return this.appendTerminal(command, outcome, receipt);
  }

  private prunePendingApprovals(approvals: readonly { id: string; status: string }[]): void {
    const active = new Set(
      approvals.filter((approval) => approval.status === 'pending' || approval.status === 'approved')
        .map((approval) => approval.id),
    );
    for (const id of this.pendingApprovals.keys()) {
      if (!active.has(id) && !this.passiveTerminalizations.has(id)) {
        this.pendingApprovals.delete(id);
      }
    }
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
    if (!isSurfaceControlCommand(command)) {
      this.retainCommandRecord(command.id, { command, sequence: event.sequence });
    }
    return event;
  }

  private async appendTerminal(
    command: ControlCommand,
    outcome: CommandOutcome,
    receipt?: ActionReceipt,
  ): Promise<CommandOutcome> {
    const event = await this.journal.append(terminalKindForOutcome(outcome), {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      ...(isSurfaceControlCommand(command)
        ? redactedPayloadForOutcome(outcome, receipt)
        : payloadForOutcome(outcome)),
    });
    this.outcomesByIdempotencyKey.set(command.idempotencyKey, outcome);
    const record = this.commandRecords.get(command.id);
    if (record) {
      record.outcome = outcome;
      record.sequence = event.sequence;
    } else if (!isSurfaceControlCommand(command)) {
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
    return this.queueForResource(this.resourceTargetForPane(paneId));
  }

  private queueForResource(target: LeaseTarget): PaneQueueState {
    const key = resourceKey(target);
    let queue = this.resourceQueues.get(key);
    if (!queue) {
      queue = { items: new Set<QueuedCommand>(), tail: Promise.resolve() };
      this.resourceQueues.set(key, queue);
    }
    return queue;
  }

  private waitForQueueBlocker(key: string): Promise<void> {
    return this.resourceQueues.get(key)?.blocker ?? Promise.resolve();
  }

  private bumpPaneBarrier(paneId: string): void {
    this.paneBarrierGenerations.set(paneId, (this.paneBarrierGenerations.get(paneId) ?? 0) + 1);
  }

  private preemptQueuedAutomation(paneId: string): Promise<CommandOutcome>[] {
    const queue = this.resourceQueues.get(resourceKey(this.resourceTargetForPane(paneId)));
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

  private resourceTargetForPane(paneId: string): LeaseTarget {
    const surface = this.surfaces.get(paneId);
    return surface?.kind === 'pane'
      ? { kind: 'pane', id: paneId, generation: surface.generation }
      : { kind: 'pane', id: paneId, generation: 0 };
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

function succeededOutcome(value?: unknown): CommandOutcome {
  return value === undefined ? { status: 'succeeded' } : { status: 'succeeded', value };
}

function rejectedOutcome(code: string, message: string): CommandOutcome {
  return { status: 'rejected', code, message };
}

function codedRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function requiresOperator(kind: ControlCommand['kind']): boolean {
  return kind === 'lease.grant'
    || kind === 'lease.revoke'
    || kind === 'approval.resolve'
    || kind === 'provider.resource.upsert'
    || kind === 'provider.resource.remove';
}

function isSurfaceControlCommand(command: ControlCommand): command is Extract<ControlCommand, { kind:
  | 'lease.request' | 'lease.grant' | 'lease.release' | 'lease.revoke'
  | 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action'
  | 'browser.script' | 'approval.resolve' | 'provider.resource.upsert'
  | 'provider.resource.remove' }> {
  return command.kind === 'lease.request'
    || command.kind === 'lease.grant'
    || command.kind === 'lease.release'
    || command.kind === 'lease.revoke'
    || command.kind === 'pane.observe'
    || command.kind === 'pane.action'
    || command.kind === 'browser.inspect'
    || command.kind === 'browser.action'
    || command.kind === 'browser.script'
    || command.kind === 'approval.resolve'
    || command.kind === 'provider.resource.upsert'
    || command.kind === 'provider.resource.remove';
}

function isSurfaceActionCommand(command: ControlCommand): command is SurfaceActionContext['command'] {
  return command.kind === 'pane.observe'
    || command.kind === 'pane.action'
    || command.kind === 'browser.inspect'
    || command.kind === 'browser.action'
    || command.kind === 'browser.script';
}

function targetForSurfaceAction(command: SurfaceActionContext['command']): LeaseTarget {
  switch (command.kind) {
    case 'pane.observe':
      return { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
    case 'pane.action':
      return command.payload.action.kind === 'create'
        ? { kind: 'project', id: command.payload.projectId ?? command.projectRoot }
        : {
            kind: 'pane',
            id: command.payload.paneId ?? '[missing-pane]',
            generation: command.payload.generation ?? 0,
          };
    case 'browser.inspect':
    case 'browser.action':
    case 'browser.script':
      return { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
  }
}

function isApprovalInvalidationError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'approval_denied'
    || code === 'approval_expired'
    || code === 'approval_missing'
    || code === 'approval_identity_mismatch';
}

function resourceKey(target: LeaseTarget): string {
  return target.kind === 'project'
    ? `${target.kind}:${target.id}`
    : `${target.kind}:${target.id}:${target.generation}`;
}

function approvalEffectForBrowserAction(
  action: Extract<ControlCommand, { kind: 'browser.action' }>['payload']['action'],
  semantic?: CanonicalElementSemantics,
): RedactedApprovalEffect | undefined {
  switch (action.kind) {
    case 'click':
      return semantic?.submit
        ? createRedactedApprovalEffect({ kind: 'submit', target: action.elementRef })
        : undefined;
    case 'type':
      return semantic?.secret
        ? createRedactedApprovalEffect({ kind: 'secret_input', target: action.elementRef })
        : undefined;
    case 'submit':
      return createRedactedApprovalEffect({ kind: 'submit', target: action.elementRef });
    case 'upload':
      return createRedactedApprovalEffect({ kind: 'upload', target: action.path });
    case 'download':
      return createRedactedApprovalEffect({ kind: 'download', target: action.destination });
    case 'permission_response':
      return createRedactedApprovalEffect({
        kind: 'permission_response', target: `${action.origin} ${action.permission}`,
      });
    case 'close':
      return createRedactedApprovalEffect({ kind: 'close', target: 'browser tab' });
    default:
      return undefined;
  }
}

function freezeContext(context: SurfaceActionContext): SurfaceActionContext {
  const command = deepFreezeClone(context.command) as SurfaceActionContext['command'];
  return Object.freeze({ ...context, command, target: Object.freeze({ ...context.target }) });
}

function deepFreezeClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreezeClone(item))) as T;
  }
  if (value && typeof value === 'object') {
    const copy = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deepFreezeClone(item)]),
    );
    return Object.freeze(copy) as T;
  }
  return value;
}

function outcomeForReceipt(receipt: ActionReceipt): CommandOutcome {
  if (receipt.state === 'unknown') {
    return { status: 'unknown', code: receipt.code ?? 'effect_unknown', message: receipt.message ?? 'effect outcome is unknown' };
  }
  if (receipt.state === 'failed' || receipt.state === 'expired' || receipt.state === 'denied') {
    return {
      status: 'failed',
      code: receipt.code ?? `action_${receipt.state}`,
      message: receipt.state === 'failed' ? 'surface effect failed' : `action ${receipt.state}`,
    };
  }
  return succeededOutcome(receipt);
}

function contextsMatch(left: SurfaceActionContext, right: SurfaceActionContext): boolean {
  return resourceKey(left.target) === resourceKey(right.target)
    && left.classification.decision === right.classification.decision
    && left.classification.capability === right.classification.capability
    && JSON.stringify(left.effect) === JSON.stringify(right.effect);
}

function redactedPayloadForOutcome(
  outcome: CommandOutcome,
  explicitReceipt?: ActionReceipt,
): Record<string, unknown> {
  const receipt = explicitReceipt
    ?? (outcome.status === 'succeeded' && 'value' in outcome && isActionReceiptLike(outcome.value)
      ? outcome.value
      : undefined);
  if (receipt) return { status: outcome.status, receipt: redactReceipt(receipt) };
  return {
    status: outcome.status,
    ...(outcome.status === 'succeeded' ? {} : { code: 'surface_command_failed' }),
  };
}

function redactReceipt(receipt: ActionReceipt): ActionReceipt {
  const { value: _sensitiveValue, message: _sensitiveMessage, ...safeReceipt } = receipt;
  return Object.freeze(safeReceipt);
}

function isActionReceiptLike(value: unknown): value is ActionReceipt {
  return Boolean(value && typeof value === 'object'
    && (value as { schema?: unknown }).schema === 'psyche.control.receipt/v1');
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
  const receipt = actionReceiptPayload(event);
  switch (event.kind) {
    case 'command.succeeded':
      return receipt
        ? { status: 'succeeded', value: receipt }
        : Object.prototype.hasOwnProperty.call(event.payload, 'value')
        ? { status: 'succeeded', value: event.payload.value }
        : { status: 'succeeded' };
    case 'command.rejected':
      return {
        status: 'rejected',
        code: receipt?.code ?? stringPayload(event, 'code') ?? 'command_rejected',
        message: receipt ? 'surface action was rejected' : stringPayload(event, 'message') ?? 'command was rejected',
      };
    case 'command.failed':
      return {
        status: 'failed',
        code: receipt?.code ?? stringPayload(event, 'code') ?? 'command_failed',
        message: receipt ? 'surface effect failed' : stringPayload(event, 'message') ?? 'command failed',
      };
    case 'command.unknown':
      return {
        status: 'unknown',
        code: receipt?.code ?? stringPayload(event, 'code') ?? stringPayload(event, 'reason') ?? 'command_unknown',
        message: receipt ? 'surface effect outcome is unknown' : stringPayload(event, 'message') ?? 'command outcome is unknown',
      };
    default:
      throw new Error(`not a terminal command event: ${event.kind}`);
  }
}

function actionReceiptPayload(event: RuntimeEvent): ActionReceipt | undefined {
  const receipt = event.payload.receipt;
  return isActionReceiptLike(receipt) ? receipt : undefined;
}

function stringPayload(event: RuntimeEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function isReceiptResult(value: unknown): value is { receiptId?: string } {
  return typeof value === 'object' && value !== null &&
    (!('receiptId' in value) || typeof (value as { receiptId?: unknown }).receiptId === 'string');
}
