import { LaneLeaseStore } from './leases.js';
import { PromptDispatcher } from './promptDispatch.js';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { ApprovalStore, digestActionPayload, type Approval, type RedactedApprovalEffect } from './approvals.js';
import { CapabilityLeaseStore, type LeaseTarget, type SurfaceCapability } from './capabilityLeases.js';
import {
  classifyBrowserScript,
  classifyPaneAction,
  createBrowserPolicyAuthority,
  type CanonicalSnapshotRiskNode,
  type PolicyClassification,
} from './policy.js';
import { SurfaceRegistry, type SurfaceResource } from './surfaces.js';
import type {
  ActionReceipt,
  BrowserSemanticAction,
  CommandOutcome,
  CommandRecord,
  ControlCommand,
  ControlSnapshot,
  PromptEnvelope,
  LeaseRequestState,
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

export interface CanonicalBrowserSnapshotResolver {
  (payload: Payload<'browser.action'>): Promise<CanonicalBrowserElementBinding | undefined>;
}

export interface CanonicalBrowserElementBinding {
  readonly tabId: string;
  readonly generation: number;
  readonly snapshotId: string;
  readonly elementRef: string;
  readonly actionKind: Extract<Payload<'browser.action'>['action'], { elementRef: string }>['kind'];
  readonly submit?: boolean;
  readonly secret?: boolean;
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

export interface ControlRuntimeOptions {
  ownerEpoch: number;
  handlers: ControlHandlers;
  journal: RuntimeJournal;
  surfaces?: SurfaceRegistry;
  capabilityLeases?: CapabilityLeaseStore;
  approvals?: ApprovalStore;
  resolveBrowserSnapshot?: CanonicalBrowserSnapshotResolver;
  canonicalizePath?: (candidate: string, mode?: 'existing' | 'prospective') => string | Promise<string>;
}

interface ResourceQueueState {
  readonly items: Set<QueuedCommand>;
  tail: Promise<void>;
  readonly blockers: Set<Promise<void>>;
  activeEffects: number;
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

interface PendingApproval {
  readonly approval: Approval;
  readonly command: Extract<ControlCommand, {
    kind: 'pane.action' | 'browser.action' | 'browser.script';
  }>;
  readonly classification: PolicyClassification;
  readonly effect: RedactedApprovalEffect;
}

const TERMINAL_EVENT_KINDS = new Set([
  'command.succeeded',
  'command.failed',
  'command.unknown',
  'command.rejected',
]);
const AGENT_CONTROL_KINDS: ReadonlySet<ControlCommand['kind']> = new Set([
  'lease.request', 'lease.grant', 'lease.release', 'lease.revoke',
  'pane.observe', 'pane.action', 'browser.inspect', 'browser.action', 'browser.script',
  'approval.resolve', 'provider.resource.upsert', 'provider.resource.remove',
]);
const PSYCHE_ALLOWED_COMMANDS: ReadonlySet<ControlCommand['kind']> = new Set([
  'lease.request', 'lease.release', 'pane.observe', 'pane.action',
  'browser.inspect', 'browser.action', 'browser.script',
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
const MAX_RECEIPTS = 100;
const MAX_STATUS_INDEX = 100;
const MAX_LEASE_REQUESTS = 1000;

export class ControlRuntime {
  public readonly leases = new LaneLeaseStore();
  public readonly surfaces: SurfaceRegistry;
  public readonly capabilityLeases: CapabilityLeaseStore;
  public readonly approvals: ApprovalStore;

  private readonly outcomesByIdempotencyKey = new Map<string, CommandOutcome>();
  private readonly pendingByIdempotencyKey = new Map<string, Promise<CommandOutcome>>();
  private readonly fingerprintsByIdempotencyKey = new Map<string, string>();
  private readonly fingerprintsByCommandId = new Map<string, string>();
  private readonly outcomesByCommandId = new Map<string, CommandOutcome>();
  private readonly idempotencyKeysByCommandId = new Map<string, string>();
  private readonly commandIdsByIdempotencyKey = new Map<string, string>();
  private readonly pendingByCommandId = new Map<string, Promise<CommandOutcome>>();
  private readonly commandRecords = new Map<string, {
    command: ControlCommand;
    outcome?: CommandOutcome;
    sequence: number;
  }>();
  private readonly paneBarrierGenerations = new Map<string, number>();
  private readonly resourceQueues = new Map<string, ResourceQueueState>();
  private readonly leaseRequests = new Map<string, LeaseRequestState>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly receipts: ActionReceipt[] = [];
  private readonly actionStatuses = new Map<string, ActionReceipt>();
  private readonly terminalReceiptOverrides = new Map<string, ActionReceipt>();
  private readonly promptDispatcher: PromptDispatcher;
  private readonly browserPolicy = createBrowserPolicyAuthority();

  private constructor(
    private readonly ownerEpoch: number,
    private readonly handlers: ControlHandlers,
    private readonly journal: RuntimeJournal,
    surfaces?: SurfaceRegistry,
    capabilityLeases?: CapabilityLeaseStore,
    approvals?: ApprovalStore,
    private readonly resolveBrowserSnapshot: CanonicalBrowserSnapshotResolver = async () => {
      throw codedError('snapshot_stale', 'canonical browser snapshot is unavailable');
    },
    private readonly canonicalizePath: (
      candidate: string,
      mode?: 'existing' | 'prospective',
    ) => string | Promise<string> = canonicalizeFilesystemPath,
  ) {
    this.surfaces = surfaces ?? new SurfaceRegistry();
    this.capabilityLeases = capabilityLeases ?? new CapabilityLeaseStore(undefined, ownerEpoch);
    this.approvals = approvals ?? new ApprovalStore();
    this.promptDispatcher = new PromptDispatcher(async (envelope) => {
      const result = await this.handlers.sendPrompt(envelope);
      if (isReceiptResult(result)) return result;
      return undefined;
    });
  }

  static async create(opts: ControlRuntimeOptions): Promise<ControlRuntime> {
    await opts.journal.recoverNonterminalCommands();
    opts.approvals?.revokeAll();
    for (const lease of opts.capabilityLeases?.snapshot() ?? []) {
      if (lease.ownerEpoch !== opts.ownerEpoch) opts.capabilityLeases?.revoke(lease.id);
    }
    const runtime = new ControlRuntime(
      opts.ownerEpoch, opts.handlers, opts.journal,
      opts.surfaces, opts.capabilityLeases, opts.approvals, opts.resolveBrowserSnapshot,
      opts.canonicalizePath,
    );
    runtime.reduceOutcomes(opts.journal.read(0));
    await runtime.reconcileOrphanedApprovals();
    return runtime;
  }

  submit(command: ControlCommand): Promise<CommandOutcome> {
    if (command.actor.kind === 'psyche' && !PSYCHE_ALLOWED_COMMANDS.has(command.kind)) {
      return this.rejectAgentMutation(command);
    }
    try {
      validateCommandLeaseTargets(command);
    } catch (error) {
      return Promise.resolve(safeSurfaceFailure(error));
    }
    const immutable = immutableCopy(command);
    const fingerprint = commandFingerprint(immutable);
    const knownKey = this.idempotencyKeysByCommandId.get(immutable.id);
    if (knownKey && knownKey !== immutable.idempotencyKey) return Promise.resolve(commandConflictOutcome());
    const knownId = this.commandIdsByIdempotencyKey.get(immutable.idempotencyKey);
    if (knownId && knownId !== immutable.id) return Promise.resolve(commandConflictOutcome());
    const idempotencyFingerprint = this.fingerprintsByIdempotencyKey.get(immutable.idempotencyKey);
    if (idempotencyFingerprint && idempotencyFingerprint !== fingerprint) {
      return Promise.resolve(commandConflictOutcome());
    }
    const commandFingerprintValue = this.fingerprintsByCommandId.get(immutable.id);
    if (commandFingerprintValue && commandFingerprintValue !== fingerprint) {
      return Promise.resolve(commandConflictOutcome());
    }

    const priorById = this.outcomesByCommandId.get(immutable.id);
    if (priorById) return Promise.resolve(priorById);
    const pendingById = this.pendingByCommandId.get(immutable.id);
    if (pendingById) return pendingById;

    const prior = this.outcomesByIdempotencyKey.get(immutable.idempotencyKey);
    if (prior) return Promise.resolve(prior);

    const pending = this.pendingByIdempotencyKey.get(immutable.idempotencyKey);
    if (pending) return pending;

    const persisted = this.lookupPersistedCommand(immutable, fingerprint);
    if (persisted) return Promise.resolve(persisted);

    this.fingerprintsByIdempotencyKey.set(immutable.idempotencyKey, fingerprint);
    this.fingerprintsByCommandId.set(immutable.id, fingerprint);
    this.idempotencyKeysByCommandId.set(immutable.id, immutable.idempotencyKey);
    this.commandIdsByIdempotencyKey.set(immutable.idempotencyKey, immutable.id);
    const execution = this.submitFresh(immutable).finally(() => {
      this.pendingByIdempotencyKey.delete(immutable.idempotencyKey);
      this.pendingByCommandId.delete(immutable.id);
    });
    this.pendingByIdempotencyKey.set(immutable.idempotencyKey, execution);
    this.pendingByCommandId.set(immutable.id, execution);
    return execution;
  }

  events(): RuntimeEvent[] {
    return this.journal.read(0);
  }

  actionStatus(actionId: string): ActionReceipt | undefined {
    const current = this.actionStatuses.get(actionId);
    if (current) return current;
    for (const event of [...this.journal.read(0)].reverse()) {
      if (event.payload.commandId !== actionId) continue;
      const receipt = receiptPayload(event);
      if (receipt) return receipt;
    }
    return undefined;
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
        commands[id] = {
          id: record.command.id,
          kind: record.command.kind,
          outcome: redactOutcome(record.outcome),
          sequence: record.sequence,
        };
      }
    }
    return {
      ownerEpoch: this.ownerEpoch,
      sequence,
      commands,
      leases: this.leases.snapshot(),
      resources: this.surfaces.list().map(({ id, kind, generation }) => ({ id, kind, generation })),
      capabilityLeases: this.capabilityLeases.snapshot().map((lease) => ({
        ...lease,
        grants: lease.grants.map((grant) => ({
          ...grant,
          target: redactTarget(grant.target),
        })),
      })),
      leaseRequests: [...this.leaseRequests.values()].map((request) => ({
        ...request,
        grants: request.grants.map((grant) => ({ ...grant, target: redactTarget(grant.target) })),
      })),
      approvals: this.approvals.snapshot().slice(-MAX_STATUS_INDEX).map((approval) => ({
        ...approval,
        resource: redactTarget(approval.resource),
      })),
      receipts: this.receipts.map((receipt) => ({
        ...receipt,
        resource: redactTarget(receipt.resource),
      })),
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
    return this.blockResourceQueue(paneId);
  }

  blockResourceQueue(key: string): () => void {
    const queue = this.queueForResource(key);
    let released = false;
    let release!: () => void;
    const token = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.blockers.add(token);
    return () => {
      if (released) return;
      released = true;
      release();
      queue.blockers.delete(token);
      this.cleanupResourceQueue(key, queue);
    };
  }

  private submitFresh(command: ControlCommand): Promise<CommandOutcome> {
    if (command.ownerEpoch !== this.ownerEpoch) {
      return AGENT_CONTROL_KINDS.has(command.kind)
        ? this.rejectOwnerRestarted(command)
        : this.rejectStaleOwnerEpoch(command);
    }
    if (command.actor.kind === 'psyche' && !PSYCHE_ALLOWED_COMMANDS.has(command.kind)) {
      return this.rejectAgentMutation(command);
    }

    if (command.kind === 'pane.delegate') return this.executeDelegate(command);
    if (command.kind === 'pane.takeover') return this.executeTakeover(command);
    if (isAgentSurfaceEffect(command)) return this.executeAgentSurfaceEffect(command);

    const paneId = paneIdForCommand(command);
    if (paneId) {
      return this.enqueuePaneCommand(command, paneId, () => this.executeStartedCommand(command));
    }

    return this.executeImmediateCommand(command);
  }

  private async rejectAgentMutation(command: ControlCommand): Promise<CommandOutcome> {
    await this.appendRequested(command);
    return this.appendTerminal(command, {
      status: 'rejected', code: 'agent_mutation_denied', message: 'agent must use lease-mediated control commands',
    });
  }

  private async rejectStaleOwnerEpoch(command: ControlCommand): Promise<CommandOutcome> {
    await this.appendRequested(command);
    return this.appendTerminal(command, {
      status: 'rejected',
      code: 'stale_owner_epoch',
      message: `command owner epoch ${command.ownerEpoch} is stale; active epoch is ${this.ownerEpoch}`,
    });
  }

  private async rejectOwnerRestarted(command: ControlCommand): Promise<CommandOutcome> {
    await this.appendRequested(command);
    const outcome: CommandOutcome = {
      status: 'rejected', code: 'owner_restarted', message: 'control owner restarted',
    };
    return this.terminalizeAgentAction(command, outcome, 'denied');
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
    const resource = this.surfaces.list().find((candidate) => (
      candidate.kind === 'pane'
      && (candidate.id === command.payload.paneId || candidate.tmuxPaneId === command.payload.paneId)
    ));
    if (resource) this.revokeTargetAuthority(resourceTarget(resource));
    await this.journal.append('lease.takeover', {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      paneId: lease.paneId,
      actorId: lease.actorId,
      revision: lease.revision,
    });
    const outcome = await this.appendTerminal(command, {
      status: 'succeeded',
      value: { actorId: lease.actorId, revision: lease.revision },
    });
    const queue = this.resourceQueues.get(command.payload.paneId);
    if (!queue || queue.items.size === 0) {
      this.paneBarrierGenerations.delete(command.payload.paneId);
    }
    return outcome;
  }

  private async executeAgentSurfaceEffect(
    command: Extract<ControlCommand, {
      kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script';
    }>,
  ): Promise<CommandOutcome> {
    await this.appendRequested(command);
    try {
      const prepared = await this.prepareAgentSurfaceEffect(command);
      if (prepared.classification.decision === 'approval') {
        if (command.kind === 'pane.observe' || command.kind === 'browser.inspect') {
          throw codedError('capability_denied', 'observation cannot require approval');
        }
        const effect = approvalEffectFor(command);
        const approval = this.approvals.request({
          actionId: command.id,
          ownerEpoch: command.ownerEpoch,
          leaseId: command.payload.leaseId,
          leaseRevision: command.payload.leaseRevision,
          resource: prepared.target,
          capability: prepared.classification.capability,
          effect,
          actionPayload: command.payload,
        });
        this.pendingApprovals.set(approval.id, { approval, command, classification: prepared.classification, effect });
        const receipt = this.recordReceipt(command, prepared.target, 'approval_required', 'approval_required');
        return this.appendTerminal(command, succeededOutcome(receipt));
      }
      return this.enqueueAgentSurfaceEffect(command, prepared.target, async () => {
        await this.prepareAgentSurfaceEffect(command);
        return this.invokeAgentSurfaceHandler(command, prepared.target);
      });
    } catch (error) {
      const outcome = safeSurfaceFailure(error);
      return this.terminalizeAgentAction(command, outcome);
    }
  }

  private async prepareAgentSurfaceEffect(
    command: Extract<ControlCommand, {
      kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script';
    }>,
  ): Promise<{ target: LeaseTarget; classification: PolicyClassification }> {
    this.assertCurrentOwner(command.ownerEpoch);
    let target: LeaseTarget;
    let classification: PolicyClassification;
    switch (command.kind) {
      case 'pane.observe':
        this.requireResource(command.payload.paneId, command.payload.generation, 'pane');
        target = { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
        classification = { decision: 'allow', capability: 'pane.observe' };
        break;
      case 'pane.action':
        classification = classifyPaneAction(command.payload.action);
        if ('projectId' in command.payload) {
          if (command.payload.projectId !== command.projectRoot) {
            throw codedError('capability_denied', 'pane creation target is not the canonical project');
          }
          await this.assertContainedPath(
            path.resolve(command.projectRoot, command.payload.action.cwd),
            'prospective',
            this.registeredRoots(command.projectRoot),
          );
          target = { kind: 'project', id: command.projectRoot };
        } else {
          this.requireResource(command.payload.paneId, command.payload.generation, 'pane');
          target = { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
        }
        break;
      case 'browser.inspect':
        this.requireResource(command.payload.tabId, command.payload.generation, 'browser_tab');
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        classification = {
          decision: 'allow',
          capability: command.payload.includeScreenshot ? 'browser.screenshot' : 'browser.inspect',
        };
        break;
      case 'browser.action': {
        const resource = this.requireResource(command.payload.tabId, command.payload.generation, 'browser_tab');
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        this.assertCapabilityLease(command, target, browserCapabilityForAction(command.payload.action.kind));
        let risk;
        if ('snapshotId' in command.payload) {
          const binding = await this.resolveBrowserSnapshot(command.payload);
          assertBrowserBinding(command.payload, binding);
          if (binding?.actionKind === 'click') {
            risk = this.browserPolicy.resolveFromCanonicalSnapshot({ actionKind: 'click', submit: binding.submit === true });
          } else if (binding?.actionKind === 'type') {
            risk = this.browserPolicy.resolveFromCanonicalSnapshot({ actionKind: 'type', secret: binding.secret === true });
          }
        }
        if (command.payload.action.kind === 'upload') {
          await this.assertContainedPath(
            path.resolve(resource.worktreeRoot, command.payload.action.path),
            'existing',
            [resource.projectRoot, resource.worktreeRoot],
          );
        } else if (command.payload.action.kind === 'download') {
          await this.assertContainedPath(
            path.resolve(resource.worktreeRoot, command.payload.action.destination),
            'prospective',
            [resource.projectRoot, resource.worktreeRoot],
          );
        }
        classification = this.browserPolicy.classifyBrowserAction(command.payload.action, risk);
        break;
      }
      case 'browser.script':
        this.requireResource(command.payload.tabId, command.payload.generation, 'browser_tab');
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        classification = classifyBrowserScript();
        break;
    }
    this.assertCapabilityLease(command, target, classification.capability);
    return { target, classification };
  }

  private assertCapabilityLease(
    command: Extract<ControlCommand, {
      kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script';
    }>,
    target: LeaseTarget,
    capability: SurfaceCapability,
  ): void {
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

  private enqueueAgentSurfaceEffect(
    command: Extract<ControlCommand, {
      kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script';
    }>,
    target: LeaseTarget,
    run: () => Promise<ActionReceipt>,
  ): Promise<CommandOutcome> {
    const key = resourceKey(target);
    const queue = this.queueForResource(key);
    queue.activeEffects += 1;
    this.setActionStatus(command, target, 'queued');
    return new Promise<CommandOutcome>((resolve) => {
      queue.tail = queue.tail.then(async () => {
        await Promise.all([...queue.blockers]);
        this.setActionStatus(command, target, 'running');
        let outcome: CommandOutcome;
        try {
          outcome = succeededOutcome(await run());
        } catch (error) {
          outcome = safeSurfaceFailure(error);
          this.recordReceipt(
            command, target, outcome.status === 'unknown' ? 'unknown' : 'failed',
            outcome.status === 'succeeded' ? undefined : outcome.code,
          );
        }
        resolve(await this.appendTerminal(command, outcome));
      }).catch(async (error: unknown) => {
        resolve(await this.appendTerminal(command, safeSurfaceFailure(error)));
      }).finally(() => {
        queue.activeEffects -= 1;
        this.cleanupResourceQueue(key, queue);
      });
    });
  }

  private async invokeAgentSurfaceHandler(
    command: Extract<ControlCommand, {
      kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script';
    }>,
    target: LeaseTarget,
  ): Promise<ActionReceipt> {
    try {
      switch (command.kind) {
        case 'pane.observe':
          await requireHandler(this.handlers.observePane, command.kind)(command.payload);
          break;
        case 'pane.action':
          await requireHandler(this.handlers.actOnPane, command.kind)(command.payload);
          break;
        case 'browser.inspect':
          await requireHandler(this.handlers.inspectBrowser, command.kind)(command.payload);
          break;
        case 'browser.action':
          await requireHandler(this.handlers.actOnBrowser, command.kind)(command.payload);
          break;
        case 'browser.script':
          await requireHandler(this.handlers.runBrowserScript, command.kind)(command.payload);
          break;
      }
      return this.recordReceipt(command, target, 'succeeded');
    } catch (error) {
      if (isAmbiguous(error)) throw codedError('effect_unknown', 'surface effect outcome is unknown', true);
      throw error;
    }
  }

  private enqueuePaneCommand(
    command: ControlCommand,
    paneId: string,
    run: () => Promise<CommandOutcome>,
  ): Promise<CommandOutcome> {
    const queue = this.queueForResource(paneId);
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
      const queue = this.resourceQueues.get(item.paneId);
      queue?.items.delete(item);
      if (queue) this.cleanupResourceQueue(item.paneId, queue);
      if (!this.resourceQueues.has(item.paneId)) {
        this.paneBarrierGenerations.delete(item.paneId);
      }
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
          return this.requestCapabilityLease(command);
        case 'lease.grant':
          return this.grantCapabilityLease(command);
        case 'lease.release':
          return this.releaseCapabilityLease(command);
        case 'lease.revoke':
          return this.revokeCapabilityLease(command);
        case 'approval.resolve':
          return await this.resolveApproval(command);
        case 'provider.resource.upsert':
          return await this.upsertResource(command);
        case 'provider.resource.remove':
          return this.removeResource(command);
        case 'pane.observe':
        case 'pane.action':
        case 'browser.inspect':
        case 'browser.action':
        case 'browser.script':
          throw codedError('command_not_implemented', 'surface effect bypassed its transaction');
        case 'pane.delegate':
        case 'pane.takeover':
          throw new Error(`lease command reached side-effect executor: ${command.kind}`);
      }
    } catch (error) {
      return failedOutcome(error);
    }
  }

  private requestCapabilityLease(
    command: Extract<ControlCommand, { kind: 'lease.request' }>,
  ): CommandOutcome {
    if (command.actor.kind !== 'psyche') return operatorRejected('agents request capability leases');
    validateGrants(command.payload.grants, command.projectRoot, this.surfaces, false);
    if (this.leaseRequests.size >= MAX_LEASE_REQUESTS) {
      throw codedError('capability_denied', 'too many pending lease requests');
    }
    const request: LeaseRequestState = Object.freeze({
      id: command.id,
      actorId: command.actor.id,
      taskId: command.payload.taskId,
      ttlMs: command.payload.ttlMs,
      grants: immutableCopy(command.payload.grants),
      createdAt: command.createdAt,
      status: 'pending',
    });
    this.leaseRequests.set(request.id, request);
    return succeededOutcome({ requestId: request.id });
  }

  private grantCapabilityLease(
    command: Extract<ControlCommand, { kind: 'lease.grant' }>,
  ): CommandOutcome {
    if (command.actor.kind !== 'human') return operatorRejected('only an operator may grant capability leases');
    validateGrants(command.payload.grants, command.projectRoot, this.surfaces, true);
    const request = this.leaseRequests.get(command.payload.requestId);
    if (!request || request.status !== 'pending' || (
      request.actorId !== command.payload.actorId
      || request.taskId !== command.payload.taskId
      || request.ttlMs !== command.payload.ttlMs
      || !sameGrants(request.grants, command.payload.grants)
    )) throw codedError('capability_denied', 'lease grant does not match the canonical request');
    const lease = this.capabilityLeases.grant({
      ...command.payload,
      grantedBy: command.actor.id,
    });
    this.leaseRequests.delete(request.id);
    return succeededOutcome({ leaseId: lease.id, leaseRevision: lease.revision, expiresAt: lease.expiresAt });
  }

  private releaseCapabilityLease(
    command: Extract<ControlCommand, { kind: 'lease.release' }>,
  ): CommandOutcome {
    const lease = this.capabilityLeases.snapshot().find(({ id }) => id === command.payload.leaseId);
    if (!lease) throw codedError('lease_missing', 'capability lease is missing');
    if (
      command.actor.kind !== 'psyche'
      || lease.actorId !== command.actor.id
      || lease.taskId !== command.payload.taskId
      || lease.revision !== command.payload.leaseRevision
    ) throw codedError('capability_denied', 'agent may only release its exact capability lease');
    this.capabilityLeases.release(lease.id);
    this.approvals.revokeForLease(lease.id);
    return succeededOutcome(undefined);
  }

  private revokeCapabilityLease(
    command: Extract<ControlCommand, { kind: 'lease.revoke' }>,
  ): CommandOutcome {
    if (command.actor.kind !== 'human') return operatorRejected('only an operator may revoke capability leases');
    const revoked = this.capabilityLeases.revoke(command.payload.leaseId);
    this.approvals.revokeForLease(command.payload.leaseId);
    return succeededOutcome({ revoked: Boolean(revoked) });
  }

  private async resolveApproval(
    command: Extract<ControlCommand, { kind: 'approval.resolve' }>,
  ): Promise<CommandOutcome> {
    if (command.actor.kind !== 'human') return operatorRejected('only an operator may resolve approvals');
    const pending = this.pendingApprovals.get(command.payload.approvalId);
    if (!pending) throw codedError('approval_missing', 'approval is missing');
    const resolved = command.payload.decision === 'approve'
      ? this.approvals.approve(pending.approval.id, command.actor.id, command.payload.payloadDigest)
      : this.approvals.deny(pending.approval.id, command.actor.id, command.payload.payloadDigest);
    if (resolved.status === 'denied') {
      this.pendingApprovals.delete(resolved.id);
      const receipt = this.recordReceipt(
        pending.command, pending.approval.resource, 'denied', 'approval_denied',
      );
      await this.appendTerminal(pending.command, outcomeForReceipt(receipt));
      return succeededOutcome(receipt);
    }
    let current: Awaited<ReturnType<ControlRuntime['prepareAgentSurfaceEffect']>>;
    try {
      current = await this.prepareAgentSurfaceEffect(pending.command);
      if (
        current.classification.decision !== 'approval'
        || current.classification.capability !== pending.classification.capability
      ) throw codedError('approval_identity_mismatch', 'trusted action risk changed before approval consumption');
      this.approvals.consume({
        approvalId: resolved.id,
        payloadDigest: command.payload.payloadDigest,
        actionId: pending.command.id,
        ownerEpoch: pending.command.ownerEpoch,
        leaseId: pending.command.payload.leaseId,
        leaseRevision: pending.command.payload.leaseRevision,
        resource: current.target,
        capability: current.classification.capability,
        effect: pending.approval.effect,
        actionPayload: pending.command.payload,
      });
    } catch (error) {
      const outcome = safeSurfaceFailure(error);
      const receipt = this.recordReceipt(
        pending.command,
        pending.approval.resource,
        outcome.status === 'unknown' ? 'unknown' : 'failed',
        outcome.status === 'succeeded' ? undefined : outcome.code,
      );
      await this.appendTerminal(pending.command, outcome);
      this.pendingApprovals.delete(resolved.id);
      return outcome;
    }
    this.pendingApprovals.delete(resolved.id);
    this.setActionStatus(pending.command, current.target, 'queued');
    return new Promise<CommandOutcome>((resolve) => {
      const key = resourceKey(current.target);
      const queue = this.queueForResource(key);
      queue.activeEffects += 1;
      queue.tail = queue.tail.then(async () => {
        await Promise.all([...queue.blockers]);
        this.setActionStatus(pending.command, current.target, 'running');
        const revalidated = await this.prepareAgentSurfaceEffect(pending.command);
        if (
          revalidated.classification.decision !== 'approval'
          || revalidated.classification.capability !== pending.classification.capability
        ) throw codedError('approval_identity_mismatch', 'trusted action risk changed before approved effect');
        const receipt = await this.invokeAgentSurfaceHandler(pending.command, current.target);
        const outcome = outcomeForReceipt(receipt);
        resolve(await this.appendTerminal(pending.command, outcome));
      }).catch(async (error: unknown) => {
        const outcome = safeSurfaceFailure(error);
        this.recordReceipt(
          pending.command,
          current.target,
          outcome.status === 'unknown' ? 'unknown' : 'failed',
          outcome.status === 'succeeded' ? undefined : outcome.code,
        );
        resolve(await this.appendTerminal(pending.command, outcome));
      }).finally(() => {
        queue.activeEffects -= 1;
        this.cleanupResourceQueue(key, queue);
      });
    });
  }

  private async upsertResource(
    command: Extract<ControlCommand, { kind: 'provider.resource.upsert' }>,
  ): Promise<CommandOutcome> {
    if (command.actor.kind === 'psyche') return operatorRejected('agents cannot publish provider resources');
    const [canonicalRoot, resourceRoot, worktreeRoot] = await Promise.all([
      this.canonicalizePath(command.projectRoot, 'prospective'),
      this.canonicalizePath(command.payload.resource.projectRoot, 'prospective'),
      this.canonicalizePath(command.payload.resource.worktreeRoot, 'prospective'),
    ]);
    if (resourceRoot !== canonicalRoot) {
      throw codedError('capability_denied', 'provider resource belongs to another project');
    }
    const worktreeRelative = path.relative(canonicalRoot, worktreeRoot);
    if (worktreeRelative === '..' || worktreeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(worktreeRelative)) {
      throw codedError('capability_denied', 'provider worktree escapes the canonical project');
    }
    const previous = this.surfaces.get(command.payload.resource.id);
    const resource = this.surfaces.upsertBrowserTab(command.payload.resource);
    if (previous && previous.generation !== resource.generation) {
      this.revokeTargetAuthority(resourceTarget(previous));
    }
    return succeededOutcome({ id: resource.id, generation: resource.generation });
  }

  private removeResource(
    command: Extract<ControlCommand, { kind: 'provider.resource.remove' }>,
  ): CommandOutcome {
    if (command.actor.kind === 'psyche') return operatorRejected('agents cannot remove provider resources');
    const resource = this.surfaces.require(command.payload.id, command.payload.generation);
    if (resource.kind !== 'browser_tab') {
      throw codedError('command_not_implemented', 'pane provider removal is not implemented');
    }
    const removed = this.surfaces.removeByProvider(resource.providerId);
    for (const item of removed) {
      const target = resourceTarget(item);
      this.revokeTargetAuthority(target);
      this.resourceQueues.delete(resourceKey(target));
    }
    return succeededOutcome({ removed: removed.map(({ id, generation }) => ({ id, generation })) });
  }

  private requireResource(id: string, generation: number, kind: SurfaceResource['kind']): SurfaceResource {
    const resource = this.surfaces.require(id, generation);
    if (resource.kind !== kind) throw codedError('resource_replaced', 'surface resource kind was replaced');
    return resource;
  }

  private registeredRoots(projectRoot: string): string[] {
    return [
      projectRoot,
      ...this.surfaces.list()
        .filter((resource) => resource.projectRoot === projectRoot)
        .map((resource) => resource.worktreeRoot),
    ];
  }

  private async assertContainedPath(
    candidate: string,
    mode: 'existing' | 'prospective',
    roots: readonly string[],
  ): Promise<void> {
    let canonicalCandidate: string;
    let canonicalRoots: string[];
    try {
      [canonicalCandidate, ...canonicalRoots] = await Promise.all([
        this.canonicalizePath(candidate, mode),
        ...roots.map((root) => this.canonicalizePath(root, 'prospective')),
      ]);
    } catch {
      throw codedError('filesystem_target_unavailable', 'filesystem target could not be canonicalized');
    }
    if (!canonicalRoots.some((root) => isPathWithin(root, canonicalCandidate))) {
      throw codedError('capability_denied', 'filesystem target escapes the canonical project');
    }
  }

  private assertCurrentOwner(ownerEpoch: number): void {
    if (ownerEpoch !== this.ownerEpoch) throw codedError('owner_restarted', 'control owner restarted');
  }

  private revokeTargetAuthority(target: LeaseTarget): void {
    for (const lease of this.capabilityLeases.revokeTarget(target)) {
      this.approvals.revokeForLease(lease.id);
    }
  }

  private recordReceipt(
    command: ControlCommand,
    resource: LeaseTarget,
    state: ActionReceipt['state'],
    code?: string,
  ): ActionReceipt {
    const receipt: ActionReceipt = Object.freeze({
      schema: 'psyche.control.receipt/v1',
      actionId: command.id,
      state,
      resource: immutableCopy(resource),
      createdAt: command.createdAt,
      ...(state === 'approval_required' ? {} : { completedAt: new Date().toISOString() }),
      ...(code ? { code } : {}),
    });
    const previous = this.receipts.findIndex(({ actionId }) => actionId === command.id);
    if (previous >= 0) this.receipts.splice(previous, 1);
    this.receipts.push(receipt);
    this.actionStatuses.set(command.id, receipt);
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
    return receipt;
  }

  private setActionStatus(
    command: ControlCommand,
    resource: LeaseTarget,
    state: 'queued' | 'running',
  ): void {
    const receipt: ActionReceipt = Object.freeze({
      schema: 'psyche.control.receipt/v1', actionId: command.id, state,
      resource: immutableCopy(resource), createdAt: command.createdAt,
    });
    this.actionStatuses.set(command.id, receipt);
    const existing = this.receipts.findIndex(({ actionId }) => actionId === command.id);
    if (existing >= 0) this.receipts.splice(existing, 1);
    this.receipts.push(receipt);
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
  }

  private terminalizeAgentAction(
    command: ControlCommand,
    outcome: CommandOutcome,
    forcedState?: 'denied',
  ): Promise<CommandOutcome> {
    const target = targetForCommand(command);
    const state = forcedState
      ?? (outcome.status === 'unknown' ? 'unknown' : outcome.status === 'rejected' ? 'denied' : 'failed');
    this.recordReceipt(command, target, state, outcome.status === 'succeeded' ? undefined : outcome.code);
    return this.appendTerminal(command, outcome);
  }

  private setCanonicalActionOutcome(command: ControlCommand, outcome: CommandOutcome): void {
    this.outcomesByIdempotencyKey.set(command.idempotencyKey, outcome);
    this.outcomesByCommandId.set(command.id, outcome);
    const record = this.commandRecords.get(command.id);
    if (record) record.outcome = outcome;
  }

  private async reconcileOrphanedApprovals(): Promise<void> {
    for (const [actionId, status] of this.actionStatuses) {
      if (status.state !== 'approval_required') continue;
      const receipt: ActionReceipt = Object.freeze({
        ...status,
        state: 'unknown',
        code: 'owner_restarted',
        completedAt: new Date().toISOString(),
      });
      this.actionStatuses.set(actionId, receipt);
      const existing = this.receipts.findIndex((candidate) => candidate.actionId === actionId);
      if (existing >= 0) this.receipts.splice(existing, 1);
      this.receipts.push(receipt);
      const idempotencyKey = this.idempotencyKeysByCommandId.get(actionId);
      await this.journal.append('command.unknown', {
        commandId: actionId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        status: 'unknown', code: 'owner_restarted', message: 'command outcome is unknown', receipt,
      });
      const outcome: CommandOutcome = {
        status: 'unknown', code: 'owner_restarted', message: 'command outcome is unknown',
      };
      this.outcomesByCommandId.set(actionId, outcome);
      if (idempotencyKey) this.outcomesByIdempotencyKey.set(idempotencyKey, outcome);
    }
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
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
      intentDigest: commandFingerprint(command),
    });
    this.idempotencyKeysByCommandId.set(command.id, command.idempotencyKey);
    this.commandIdsByIdempotencyKey.set(command.idempotencyKey, command.id);
    this.retainCommandRecord(command.id, { command, sequence: event.sequence });
    return event;
  }

  private async appendTerminal(command: ControlCommand, outcome: CommandOutcome): Promise<CommandOutcome> {
    const receipt = this.terminalReceiptOverrides.get(command.id)
      ?? [...this.receipts].reverse().find(({ actionId }) => actionId === command.id);
    let event: RuntimeEvent;
    try {
      event = await this.journal.append(terminalKindForOutcome(outcome), {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        ...payloadForOutcome(outcome),
        ...(receipt ? { receipt } : {}),
      });
    } catch {
      const unknown: CommandOutcome = {
        status: 'unknown', code: 'effect_unknown', message: 'terminal persistence failed after effect',
      };
      if (isAgentSurfaceEffect(command)) {
        this.recordReceipt(command, targetForCommand(command), 'unknown', 'effect_unknown');
      }
      this.setCanonicalActionOutcome(command, unknown);
      return unknown;
    }
    this.outcomesByIdempotencyKey.set(command.idempotencyKey, outcome);
    this.outcomesByCommandId.set(command.id, outcome);
    const record = this.commandRecords.get(command.id);
    if (record) {
      record.outcome = outcome;
      record.sequence = event.sequence;
    } else {
      this.retainCommandRecord(command.id, { command, outcome, sequence: event.sequence });
    }
    this.terminalReceiptOverrides.delete(command.id);
    this.compactTerminalIndexes();
    return outcome;
  }

  private compactTerminalIndexes(): void {
    while (this.outcomesByCommandId.size > MAX_STATUS_INDEX) {
      const candidate = [...this.outcomesByCommandId].find(([commandId]) => {
        const receipt = this.actionStatuses.get(commandId);
        return !receipt || (receipt.state !== 'queued' && receipt.state !== 'running' && receipt.state !== 'approval_required');
      });
      if (!candidate) break;
      const [commandId] = candidate;
      const idempotencyKey = this.idempotencyKeysByCommandId.get(commandId);
      this.actionStatuses.delete(commandId);
      this.outcomesByCommandId.delete(commandId);
      this.fingerprintsByCommandId.delete(commandId);
      this.idempotencyKeysByCommandId.delete(commandId);
      if (idempotencyKey) {
        this.outcomesByIdempotencyKey.delete(idempotencyKey);
        this.fingerprintsByIdempotencyKey.delete(idempotencyKey);
        this.commandIdsByIdempotencyKey.delete(idempotencyKey);
      }
    }
  }

  private lookupPersistedCommand(command: ControlCommand, fingerprint: string): CommandOutcome | undefined {
    if (this.outcomesByCommandId.has(command.id) || this.outcomesByIdempotencyKey.has(command.idempotencyKey)) return undefined;
    const events = this.journal.read(0);
    const requested = events.find((event) => event.kind === 'command.requested' && (
      event.payload.commandId === command.id || event.payload.idempotencyKey === command.idempotencyKey
    ));
    if (!requested) return undefined;
    if (
      requested.payload.commandId !== command.id
      || requested.payload.idempotencyKey !== command.idempotencyKey
      || requested.payload.intentDigest !== fingerprint
    ) return commandConflictOutcome();
    const terminal = [...events].reverse().find((event) => (
      TERMINAL_EVENT_KINDS.has(event.kind) && event.payload.commandId === command.id
    ));
    const receipt = terminal ? receiptPayload(terminal) : undefined;
    return terminal ? (receipt?.actionId === command.id ? outcomeForReceipt(receipt) : outcomeFromEvent(terminal)) : {
      status: 'unknown', code: 'effect_unknown', message: 'persisted command outcome is unresolved',
    };
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
      if (event.kind === 'command.requested') {
        const commandId = stringPayload(event, 'commandId');
        const idempotencyKey = stringPayload(event, 'idempotencyKey');
        const intentDigest = stringPayload(event, 'intentDigest');
        if (commandId && idempotencyKey && intentDigest) {
          this.fingerprintsByCommandId.set(commandId, intentDigest);
          this.fingerprintsByIdempotencyKey.set(idempotencyKey, intentDigest);
          this.idempotencyKeysByCommandId.set(commandId, idempotencyKey);
          this.commandIdsByIdempotencyKey.set(idempotencyKey, commandId);
        }
      }
      if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
      const idempotencyKey = stringPayload(event, 'idempotencyKey');
      if (!idempotencyKey) continue;
      const outcome = outcomeFromEvent(event);
      this.outcomesByIdempotencyKey.set(idempotencyKey, outcome);
      const commandId = stringPayload(event, 'commandId');
      if (commandId) this.outcomesByCommandId.set(commandId, outcome);
      const receipt = receiptPayload(event);
      if (receipt) {
        this.receipts.push(receipt);
        this.actionStatuses.set(receipt.actionId, receipt);
        const receiptOutcome = outcomeForReceipt(receipt);
        this.outcomesByCommandId.set(receipt.actionId, receiptOutcome);
        const actionIdempotencyKey = this.idempotencyKeysByCommandId.get(receipt.actionId);
        if (actionIdempotencyKey) {
          this.outcomesByIdempotencyKey.set(actionIdempotencyKey, receiptOutcome);
        }
      }
    }
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
    this.compactTerminalIndexes();
  }

  private queueForResource(paneId: string): ResourceQueueState {
    let queue = this.resourceQueues.get(paneId);
    if (!queue) {
      queue = { items: new Set<QueuedCommand>(), blockers: new Set(), activeEffects: 0, tail: Promise.resolve() };
      this.resourceQueues.set(paneId, queue);
    }
    return queue;
  }

  private cleanupResourceQueue(key: string, queue: ResourceQueueState): void {
    if (
      this.resourceQueues.get(key) === queue
      && queue.activeEffects === 0
      && queue.items.size === 0
      && queue.blockers.size === 0
    ) {
      this.resourceQueues.delete(key);
      this.paneBarrierGenerations.delete(key);
    }
  }

  private waitForPaneBlocker(paneId: string): Promise<void> {
    const blockers = this.resourceQueues.get(paneId)?.blockers;
    return blockers ? Promise.all([...blockers]).then(() => undefined) : Promise.resolve();
  }

  private bumpPaneBarrier(paneId: string): void {
    this.paneBarrierGenerations.set(paneId, (this.paneBarrierGenerations.get(paneId) ?? 0) + 1);
  }

  private preemptQueuedAutomation(paneId: string): Promise<CommandOutcome>[] {
    const queue = this.resourceQueues.get(paneId);
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
    return 'value' in outcome && isActionReceipt(outcome.value)
      ? { status: outcome.status, receipt: outcome.value }
      : { status: outcome.status };
  }
  const message = outcome.status === 'unknown'
    ? 'command outcome is unknown'
    : outcome.status === 'rejected'
      ? 'command was rejected'
      : 'command failed';
  return { status: outcome.status, code: outcome.code, message };
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

function receiptPayload(event: RuntimeEvent): ActionReceipt | undefined {
  const value = event.payload.receipt ?? event.payload.value;
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as Partial<ActionReceipt>;
  const resource = receipt.resource;
  if (
    receipt.schema !== 'psyche.control.receipt/v1'
    || typeof receipt.actionId !== 'string'
    || !RECEIPT_STATES.has(receipt.state as ActionReceipt['state'])
    || typeof receipt.createdAt !== 'string'
    || !resource
    || !isExactLeaseTarget(resource)
  ) return undefined;
  return Object.freeze({
    schema: 'psyche.control.receipt/v1',
    actionId: receipt.actionId,
    state: receipt.state as ActionReceipt['state'],
    resource: immutableCopy(resource),
    createdAt: receipt.createdAt,
    ...(typeof receipt.completedAt === 'string' ? { completedAt: receipt.completedAt } : {}),
    ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
  });
}

const RECEIPT_STATES: ReadonlySet<ActionReceipt['state']> = new Set([
  'queued', 'running', 'approval_required', 'succeeded',
  'failed', 'denied', 'expired', 'unknown',
]);

function outcomeForReceipt(receipt: ActionReceipt): CommandOutcome {
  switch (receipt.state) {
    case 'unknown':
      return { status: 'unknown', code: receipt.code ?? 'effect_unknown', message: 'surface effect outcome is unknown' };
    case 'failed':
    case 'expired':
      return { status: 'failed', code: receipt.code ?? 'command_failed', message: 'surface command failed' };
    case 'denied':
      return { status: 'rejected', code: receipt.code ?? 'capability_denied', message: 'surface command denied' };
    default:
      return succeededOutcome(receipt);
  }
}

function isReceiptResult(value: unknown): value is { receiptId?: string } {
  return typeof value === 'object' && value !== null &&
    (!('receiptId' in value) || typeof (value as { receiptId?: unknown }).receiptId === 'string');
}

function isActionReceipt(value: unknown): value is ActionReceipt {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as { schema?: unknown }).schema === 'psyche.control.receipt/v1',
  );
}

function isAgentSurfaceEffect(command: ControlCommand): command is Extract<ControlCommand, {
  kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script';
}> {
  return command.kind === 'pane.observe'
    || command.kind === 'pane.action'
    || command.kind === 'browser.inspect'
    || command.kind === 'browser.action'
    || command.kind === 'browser.script';
}

function resourceKey(target: LeaseTarget): string {
  return target.kind === 'project'
    ? `project:${target.id}:0`
    : `${target.kind}:${target.id}:${target.generation}`;
}

function resourceTarget(resource: SurfaceResource): LeaseTarget {
  return { kind: resource.kind, id: resource.id, generation: resource.generation };
}

function targetForCommand(command: ControlCommand): LeaseTarget {
  switch (command.kind) {
    case 'pane.observe':
      return { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
    case 'pane.action':
      return 'projectId' in command.payload
        ? { kind: 'project', id: 'canonical-project' }
        : { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
    case 'browser.inspect':
    case 'browser.action':
    case 'browser.script':
      return { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
    default:
      return { kind: 'project', id: 'canonical-project' };
  }
}

function redactTarget(target: LeaseTarget): LeaseTarget {
  return target.kind === 'project'
    ? { kind: 'project', id: 'canonical-project' }
    : { kind: target.kind, id: target.id, generation: target.generation };
}

function approvalEffectFor(
  command: Extract<ControlCommand, { kind: 'pane.action' | 'browser.action' | 'browser.script' }>,
): RedactedApprovalEffect {
  if (command.kind === 'browser.script') return { kind: 'script', target: 'browser script' };
  const action = command.payload.action;
  switch (action.kind) {
    case 'submit':
      return { kind: 'submit', target: 'browser element' };
    case 'type':
      return { kind: 'secret_input', target: 'browser field' };
    case 'upload':
      return { kind: 'upload', target: 'browser upload' };
    case 'download':
      return { kind: 'download', target: 'browser download' };
    case 'permission_response':
      return { kind: 'permission_response', target: 'browser permission' };
    case 'close':
      return { kind: 'close', target: command.kind === 'pane.action' ? 'pane' : 'browser tab' };
    case 'click':
      return { kind: 'submit', target: 'browser element' };
    default:
      throw codedError('capability_denied', 'action does not have an approval effect');
  }
}

function browserCapabilityForAction(kind: BrowserSemanticAction['kind']): SurfaceCapability {
  switch (kind) {
    case 'navigate':
      return 'browser.navigate';
    case 'reload':
    case 'back':
    case 'forward':
      return 'browser.history';
    case 'screenshot':
      return 'browser.screenshot';
    case 'close':
      return 'browser.close';
    default:
      return 'browser.interact';
  }
}

function assertBrowserBinding(
  payload: Payload<'browser.action'>,
  binding: CanonicalBrowserElementBinding | undefined,
): void {
  if (!('snapshotId' in payload) || !('elementRef' in payload.action)) return;
  if (
    !binding
    || binding.tabId !== payload.tabId
    || binding.generation !== payload.generation
    || binding.snapshotId !== payload.snapshotId
    || binding.elementRef !== payload.action.elementRef
    || binding.actionKind !== payload.action.kind
    || (payload.action.kind === 'click' && typeof binding.submit !== 'boolean')
    || (payload.action.kind === 'type' && typeof binding.secret !== 'boolean')
  ) throw codedError('snapshot_stale', 'canonical element binding is stale or mismatched');
}

function requireHandler<T extends (payload: never) => Promise<unknown>>(
  handler: T | undefined,
  kind: string,
): T {
  if (!handler) throw codedError('command_not_implemented', `${kind} handler is not implemented`);
  return handler;
}

function validateGrants(
  grants: readonly { target: LeaseTarget; capabilities: readonly SurfaceCapability[] }[],
  canonicalProjectRoot: string,
  surfaces: SurfaceRegistry,
  requireExisting: boolean,
): void {
  for (const grant of grants) {
    if (!grant.target || !isExactLeaseTarget(grant.target)) {
      throw codedError('capability_denied', 'lease target is invalid');
    }
    if (grant.capabilities.some((capability) => !SURFACE_CAPABILITIES.has(capability))) {
      throw codedError('capability_denied', 'lease contains an unknown capability');
    }
    if (grant.target.kind === 'project') {
      if (
        grant.target.id !== canonicalProjectRoot
        || grant.capabilities.some((capability) => capability !== 'pane.create')
      ) throw codedError('capability_denied', 'project leases only authorize pane.create on the canonical project');
      continue;
    }
    const expectedPrefix = grant.target.kind === 'pane' ? 'pane.' : 'browser.';
    if (grant.capabilities.some((capability) => !capability.startsWith(expectedPrefix))) {
      throw codedError('capability_denied', 'capability is incompatible with its surface target');
    }
    if (requireExisting) {
      const resource = surfaces.require(grant.target.id, grant.target.generation);
      if (resource.kind !== grant.target.kind) {
        throw codedError('capability_denied', 'lease target kind does not match the surface');
      }
    }
  }
}

function isExactLeaseTarget(target: LeaseTarget): boolean {
  if (!target || typeof target !== 'object' || Object.getPrototypeOf(target) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(target);
  const ownKeys = Reflect.ownKeys(target);
  if (ownKeys.some((key) => typeof key === 'symbol')) return false;
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) return false;
  }
  const kind = descriptors.kind?.value;
  const expected = kind === 'project'
    ? ['id', 'kind']
    : kind === 'pane' || kind === 'browser_tab'
      ? ['generation', 'id', 'kind']
      : [];
  const actual = ownKeys.map(String).sort();
  if (expected.length === 0 || actual.length !== expected.length) return false;
  if (!actual.every((key, index) => key === expected[index])) return false;
  const id = descriptors.id?.value;
  if (typeof id !== 'string' || id.trim() === '') return false;
  if (kind === 'project') return true;
  const generation = descriptors.generation?.value;
  return Number.isSafeInteger(generation) && generation >= 0;
}

function validateCommandLeaseTargets(command: ControlCommand): void {
  if (command.kind === 'provider.resource.upsert') {
    if (!isExactBrowserResource(command.payload.resource)) {
      throw codedError('capability_denied', 'provider resource is incomplete or malformed');
    }
    return;
  }
  if (command.kind !== 'lease.request' && command.kind !== 'lease.grant') return;
  if (!Array.isArray(command.payload.grants)) {
    throw codedError('capability_denied', 'lease grants are invalid');
  }
  for (const grant of command.payload.grants) {
    const descriptor = Object.getOwnPropertyDescriptor(grant, 'target');
    if (!descriptor || !('value' in descriptor) || !isExactLeaseTarget(descriptor.value as LeaseTarget)) {
      throw codedError('capability_denied', 'lease target is invalid');
    }
  }
}

function isExactBrowserResource(value: unknown): boolean {
  if (!isExactPlainDataObject(value, [
    'generation', 'id', 'kind', 'loading', 'projectRoot', 'providerId',
    'title', 'url', 'viewport', 'webviewLabel', 'worktreeRoot',
  ])) return false;
  const resource = value as Record<string, unknown>;
  return resource.kind === 'browser_tab'
    && ['id', 'projectRoot', 'providerId', 'title', 'url', 'webviewLabel', 'worktreeRoot']
      .every((key) => typeof resource[key] === 'string')
    && typeof resource.loading === 'boolean'
    && isNonnegativeSafeInteger(resource.generation)
    && isExactPlainDataObject(resource.viewport, ['height', 'width'])
    && isNonnegativeSafeInteger((resource.viewport as Record<string, unknown>).width)
    && isNonnegativeSafeInteger((resource.viewport as Record<string, unknown>).height);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function canonicalizeFilesystemPath(
  candidate: string,
  mode: 'existing' | 'prospective' = 'existing',
): Promise<string> {
  const resolved = path.resolve(candidate);
  if (mode === 'existing') return realpath(resolved);

  const remainder: string[] = [];
  let ancestor = resolved;
  for (;;) {
    try {
      return path.resolve(await realpath(ancestor), ...remainder.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        const entry = await lstat(ancestor);
        if (entry.isSymbolicLink()) {
          throw Object.assign(new Error('filesystem target contains a dangling symlink'), {
            code: 'filesystem_target_unavailable',
          });
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      remainder.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isExactPlainDataObject(value: unknown, expectedKeys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return false;
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

const SURFACE_CAPABILITIES: ReadonlySet<SurfaceCapability> = new Set([
  'pane.observe', 'pane.input', 'pane.interrupt', 'pane.focus', 'pane.resize',
  'pane.create', 'pane.close', 'browser.inspect', 'browser.screenshot',
  'browser.navigate', 'browser.interact', 'browser.history', 'browser.close',
  'browser.script',
]);

function sameGrants(
  left: readonly { target: LeaseTarget; capabilities: readonly SurfaceCapability[] }[],
  right: readonly { target: LeaseTarget; capabilities: readonly SurfaceCapability[] }[],
): boolean {
  return digestActionPayload(left) === digestActionPayload(right);
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function commandFingerprint(command: ControlCommand): string {
  const { id: _id, idempotencyKey: _idempotencyKey, actor, ...intent } = command;
  return digestActionPayload({
    ...intent,
    actor: { id: actor.id, kind: actor.kind },
  });
}

function commandConflictOutcome(): CommandOutcome {
  return {
    status: 'rejected',
    code: 'command_conflict',
    message: 'command id or idempotency key was reused for another intent',
  };
}

function operatorRejected(message: string): CommandOutcome {
  return { status: 'rejected', code: 'operator_required', message };
}

function redactOutcome(outcome: CommandOutcome): CommandOutcome {
  if (outcome.status === 'succeeded') return { status: 'succeeded' };
  const message = outcome.status === 'unknown'
    ? 'command outcome is unknown'
    : outcome.status === 'rejected'
      ? 'command was rejected'
      : 'command failed';
  return { status: outcome.status, code: outcome.code, message };
}

function safeSurfaceFailure(error: unknown): CommandOutcome {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'command_failed';
  if (code === 'effect_unknown' || isAmbiguous(error)) {
    return { status: 'unknown', code: 'effect_unknown', message: 'surface effect outcome is unknown' };
  }
  return { status: 'failed', code, message: safeMessageForCode(code) };
}

function safeMessageForCode(code: string): string {
  const messages: Record<string, string> = {
    lease_missing: 'capability lease is missing',
    lease_expired: 'capability lease expired',
    lease_revision_mismatch: 'capability lease revision mismatch',
    owner_restarted: 'control owner restarted',
    capability_denied: 'capability denied',
    resource_missing: 'surface resource is missing',
    resource_replaced: 'surface resource was replaced',
    snapshot_stale: 'browser snapshot is stale',
    approval_missing: 'approval is missing',
    approval_expired: 'approval expired',
    approval_denied: 'approval denied',
    approval_digest_mismatch: 'approval digest mismatch',
    approval_identity_mismatch: 'approval identity mismatch',
    command_not_implemented: 'surface command is not implemented',
  };
  return messages[code] ?? 'surface command failed';
}

function isAmbiguous(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    (error as { ambiguous?: unknown }).ambiguous === true
    || (error as { code?: unknown }).code === 'effect_unknown'
  ));
}

function codedError(code: string, message: string, ambiguous = false): Error & { code: string; ambiguous?: boolean } {
  return Object.assign(new Error(message), { code, ...(ambiguous ? { ambiguous: true } : {}) });
}
