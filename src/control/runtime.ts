import { createHash } from 'node:crypto';
import path from 'node:path';
import { LaneLeaseStore } from './leases.js';
import { PromptDispatcher } from './promptDispatch.js';
import { ApprovalStore, createRedactedApprovalEffect, type Approval, type RedactedApprovalEffect } from './approvals.js';
import {
  CapabilityLeaseStore,
  type CapabilityLease,
  type CapabilityLeaseAssertion,
  type LeaseTarget,
  type SurfaceCapability,
} from './capabilityLeases.js';
import type { ControlTaskCredentialReference } from './credentials.js';
import {
  classifyBrowserAction,
  assertBrowserActionFields,
  classifyBrowserScript,
  classifyPaneAction,
  type CanonicalElementSemantics,
  type PolicyClassification,
} from './policy.js';
import { SurfaceRegistry } from './surfaces.js';
import { AGENT_CONTROL_LIMITS } from './limits.js';
import {
  COMMAND_OUTCOME_ATTESTED_KIND,
  agentControlJournalPayload,
  commandTransactionKey,
  createAgentControlJournalResource,
  exactCommandOutcomeDigest,
  type AgentControlJournalReceipt,
  type DurableReceiptRecord,
  type JournalMutationGuard,
  type JournalSnapshotFile,
} from './journal.js';
import { canonicalizeBoundedJson } from './boundedJson.js';
import { isActionReceipt, isJournalActionReceipt } from './types.js';
import type {
  ActionReceipt,
  ActionStatusReceipt,
  CommandOutcome,
  CommandRecord,
  ControlCommand,
  ControlSnapshot,
  JournalActionReceipt,
  LeaseGrant,
  PromptEnvelope,
} from './types.js';

const STABLE_SURFACE_EFFECT_CODES = new Set([
  'action_timeout',
  'args_too_large',
  'automation_failed',
  'backend_unavailable',
  'element_missing',
  'provider_busy',
  'provider_unavailable',
  'resource_missing',
  'resource_replaced',
  'mutation_not_allowed',
  'mutation_plan_invalid',
  'mutation_target_stale',
  'result_too_large',
  'script_source_too_large',
  'script_args_invalid',
  'script_args_too_large',
  'serialization_failed',
  'snapshot_too_large',
  'snapshot_stale',
  'target_unavailable',
]);

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

/**
 * A journal that can drop its own history once a snapshot covers it.
 *
 * Kept separate from RuntimeJournal and feature-detected rather than folded
 * into it: an in-memory journal has nothing to compact, and requiring every
 * one to implement the durable half would be ceremony with no behaviour
 * behind it.
 */
export interface CompactableJournal extends RuntimeJournal {
  readonly sequence: number;
  readonly firstSequence: number;
  loadOutcome(key: string): Promise<CommandOutcome | undefined>;
  storeOutcome(key: string, outcome: CommandOutcome): Promise<void>;
  loadSnapshot(): Promise<JournalSnapshotFile | undefined>;
  writeSnapshot(file: JournalSnapshotFile, guard?: JournalMutationGuard): Promise<void>;
  compact(coveredSequence: number, guard?: JournalMutationGuard): Promise<void>;
}

function asCompactable(journal: RuntimeJournal): CompactableJournal | undefined {
  const candidate = journal as Partial<CompactableJournal>;
  return typeof candidate.compact === 'function'
    && typeof candidate.loadOutcome === 'function'
    && typeof candidate.storeOutcome === 'function'
    && typeof candidate.loadSnapshot === 'function'
    && typeof candidate.writeSnapshot === 'function'
    && typeof candidate.sequence === 'number'
    && typeof candidate.firstSequence === 'number'
    ? (journal as CompactableJournal)
    : undefined;
}

interface ControlRuntimeOptions {
  ownerEpoch: number;
  handlers: ControlHandlers;
  journal: RuntimeJournal;
  surfaces?: SurfaceRegistry;
  capabilityLeases?: CapabilityLeaseStore;
  approvals?: ApprovalStore;
  readActiveTaskCredential?: (taskId: string) => Promise<ControlTaskCredentialReference | null>;
  resolveBrowserElementSemantics?: (input: {
    tabId: string;
    generation: number;
    snapshotId: string;
    elementRef: string;
  }) => CanonicalElementSemantics | Promise<CanonicalElementSemantics>;
}

interface LeaseRequestRecord {
  id: string;
  ownerEpoch: number;
  actorId: string;
  taskId: string;
  status: 'pending' | 'granted' | 'released' | 'revoked';
  createdAt: string;
  ttlMs: number;
  grants: readonly LeaseGrant[];
}

interface RetainedReceipt {
  taskId?: string;
  receipt: ActionStatusReceipt;
}

interface DirtyTerminalOutcome {
  sequence: number;
  outcome?: CommandOutcome;
}

interface ActiveCompactionAttempt {
  coveredSequence: number;
  invalidated: boolean;
}

interface SurfaceActionContext {
  command: Extract<ControlCommand, { kind: 'pane.observe' | 'pane.action' | 'browser.inspect' | 'browser.action' | 'browser.script' }>;
  target: LeaseTarget;
  ownership: TrustedActionOwnership;
  classification: PolicyClassification;
  effect?: RedactedApprovalEffect;
  executablePayloadDigest: string;
}

type TrustedReceiptOwnership = Required<Pick<ActionReceipt, 'taskId' | 'actorId'>>
  & Pick<ActionReceipt, 'leaseId' | 'leaseRevision'>;
type TrustedActionOwnership = Required<Pick<ActionReceipt, 'taskId' | 'actorId' | 'leaseId' | 'leaseRevision'>>;
type TaskSubjectAuthorityStatus = 'active' | 'inactive' | 'unavailable' | 'untracked';

interface PaneQueueState {
  readonly target: LeaseTarget;
  readonly items: Set<QueuedCommand>;
  pendingEffects: number;
  quarantined: boolean;
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
 * transactions. Exact terminal outcomes still live durably in the journal's
 * disk-backed sidecar store and are reloaded on cold misses.
 */
const MAX_COMMAND_RECORDS = 1000;

/**
 * Events kept in the journal after compaction.
 *
 * Deliberately equal to MAX_COMMAND_RECORDS: recent events can still satisfy
 * cold retries from the retained journal tail, while older keys fall back to
 * the durable outcome sidecar.
 */
const JOURNAL_RETAINED_EVENTS = MAX_COMMAND_RECORDS;

/** Compact only once the journal is well past the retained window. */
const JOURNAL_COMPACTION_TRIGGER = MAX_COMMAND_RECORDS * 2;

const DIRTY_TERMINAL_OUTCOME_LIMIT = AGENT_CONTROL_LIMITS.pendingCommands;

export class ControlRuntime {
  public readonly leases = new LaneLeaseStore();
  public readonly surfaces: SurfaceRegistry;
  public readonly capabilityLeases: CapabilityLeaseStore;
  public readonly approvals: ApprovalStore;

  private readonly outcomesByIdempotencyKey = new Map<string, CommandOutcome>();
  private readonly legacySnapshotOutcomeKeys = new Set<string>();
  private readonly pendingByIdempotencyKey = new Map<string, Promise<CommandOutcome>>();
  // Dedup lookups can exceed this; only cold misses that actually execute
  // fresh work consume the bounded pending-command capacity.
  private readonly activeFreshExecutions = new Set<string>();
  private readonly commandRecords = new Map<string, {
    command: ControlCommand;
    outcome?: CommandOutcome;
    sequence: number;
  }>();
  private readonly paneBarrierGenerations = new Map<string, number>();
  private readonly promptDispatcher: PromptDispatcher;
  private readonly resourceQueues = new Map<string, PaneQueueState>();
  private readonly leaseRequests = new Map<string, LeaseRequestRecord>();
  private readonly leaseRequestTombstones = new Set<string>();
  private readonly pendingApprovals = new Map<string, SurfaceActionContext>();
  private readonly receipts = new Map<string, RetainedReceipt>();
  private readonly dirtyTerminalOutcomes = new Map<string, DirtyTerminalOutcome>();
  private readonly approvalTerminalizations = new Map<string, Promise<void>>();
  private readonly readActiveTaskCredential?: ControlRuntimeOptions['readActiveTaskCredential'];
  private readonly compactable?: CompactableJournal;
  private activeCompaction?: ActiveCompactionAttempt;
  private compactionBlockedByDurability = false;
  private compactionInFlight = false;
  private compactionPromise?: Promise<void>;

  private constructor(
    private readonly ownerEpoch: number,
    private readonly handlers: ControlHandlers,
    private readonly journal: RuntimeJournal,
    options: ControlRuntimeOptions,
  ) {
    this.surfaces = options.surfaces ?? new SurfaceRegistry();
    this.capabilityLeases = options.capabilityLeases ?? new CapabilityLeaseStore(undefined, ownerEpoch);
    this.approvals = options.approvals ?? new ApprovalStore();
    this.readActiveTaskCredential = options.readActiveTaskCredential;
    this.resolveBrowserElementSemantics = options.resolveBrowserElementSemantics;
    this.compactable = asCompactable(options.journal);
    this.promptDispatcher = new PromptDispatcher(async (envelope) => {
      const result = await this.handlers.sendPrompt(envelope);
      if (isReceiptResult(result)) return result;
      return undefined;
    });
  }

  static async create(opts: ControlRuntimeOptions): Promise<ControlRuntime> {
    const recovered = await opts.journal.recoverNonterminalCommands();
    const runtime = new ControlRuntime(opts.ownerEpoch, opts.handlers, opts.journal, opts);

    // A compacted journal no longer holds the whole history, so the durable
    // receipt state it dropped comes from the snapshot and only the tail is
    // replayed. Legacy snapshot outcome keys remain only as fail-closed
    // markers: exact replay now comes from the retained journal tail and the
    // disk-backed outcome store, never from snapshot hot-cache seeding.
    const snapshot = await runtime.compactable?.loadSnapshot();
    const covered = snapshot?.coveredSequence ?? 0;
    const restored = snapshot?.receiptRecords ?? [];
    const durableRecords = () => mergeDurableReceiptRecords(
      restored,
      latestDurableReceiptRecords(opts.journal.read(covered)),
    );

    await runtime.persistRecoveredTerminalOutcomes(recovered);
    await runtime.recoverRestartedApprovalReceipts(durableRecords());
    if (snapshot) runtime.rememberLegacySnapshotOutcomeKeys(snapshot.outcomes);
    // Read the tail again: recovery appends the invalidation events whose
    // receipts must win over the approval_required ones they replace.
    await runtime.restoreRetainedOutcomes(opts.journal.read(covered));
    runtime.rehydrateReceipts(durableRecords());
    return runtime;
  }

  private readonly resolveBrowserElementSemantics?: ControlRuntimeOptions['resolveBrowserElementSemantics'];

  submit(command: ControlCommand): Promise<CommandOutcome> {
    this.pruneInactiveResourceQueues();
    const prior = this.outcomesByIdempotencyKey.get(command.idempotencyKey);
    if (prior) return Promise.resolve(prior);
    const dirty = this.dirtyTerminalOutcomes.get(command.idempotencyKey)?.outcome;
    if (dirty) return Promise.resolve(dirty);

    const pending = this.pendingByIdempotencyKey.get(command.idempotencyKey);
    if (pending) return pending;

    const execution = this.lookupOutcomeOrSubmitFresh(command).finally(() => {
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
    const capabilityLeases = this.capabilityLeases.snapshot();
    const approvals = this.refreshApprovalState(capabilityLeases);
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
      resources: this.surfaces.list(),
      capabilityLeases,
      leaseHistory: this.capabilityLeases.history(),
      leaseRequests: [...this.leaseRequests.values()].map((request) => ({
        ...request,
        grants: request.grants.map((grant) => ({
          target: { ...grant.target },
          capabilities: [...grant.capabilities],
        })),
      })),
      approvals,
      receipts: [...this.receipts.values()].map((owned) => owned.receipt),
    };
  }

  receipt(actionId: string): ActionStatusReceipt | undefined {
    return this.receipts.get(actionId)?.receipt;
  }

  receiptForTask(actionId: string, taskId: string): ActionStatusReceipt | undefined {
    const owned = this.receipts.get(actionId);
    return owned?.taskId === taskId ? owned.receipt : undefined;
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
    // Everything below the journal's first retained sequence has been
    // compacted away. A reader resuming from there cannot be served the
    // events it asked for, and has to be told rather than handed a short read.
    const firstRetained = this.compactable?.firstSequence ?? 1;
    return { events, nextSequence, gap: afterSequence < firstRetained - 1 };
  }

  blockPaneQueue(paneId: string): () => void {
    return this.blockResourceQueue(this.resourceTargetForPane(paneId));
  }

  blockResourceQueue(target: LeaseTarget): () => void {
    const key = resourceKey(target);
    const queue = this.queueForResource(target);
    let released = false;
    let release!: () => void;
    queue.blocker = new Promise<void>((resolve) => { release = resolve; });
    return () => {
      if (released) return;
      released = true;
      const current = queue.blocker;
      const tail = queue.tail;
      release();
      if (queue.blocker === current) delete queue.blocker;
      void tail.then(() => this.pruneResourceQueue(key, queue, tail));
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

  private async lookupOutcomeOrSubmitFresh(command: ControlCommand): Promise<CommandOutcome> {
    const retained = this.journal.findByIdempotencyKey(command.idempotencyKey);
    if (retained && TERMINAL_EVENT_KINDS.has(retained.kind)) {
      if (!this.compactable) {
        const outcome = outcomeFromEvent(retained);
        this.rememberOutcome(command.idempotencyKey, outcome);
        return outcome;
      }
      const currentEvents = this.journal.read(0);
      const commandKind = retainedCommandKind(currentEvents, retained);
      const transactionKey = transactionKeyForTerminalEvent(retained);
      const attestedDigest = transactionKey
        ? retainedOutcomeAttestations(currentEvents).get(transactionKey)
        : undefined;
      const stored = await this.loadRetainedReplayOutcome(retained, commandKind, attestedDigest);
      if (stored) {
        this.clearDirtyTerminalOutcome(command.idempotencyKey, retained.sequence);
        this.rememberOutcome(command.idempotencyKey, stored);
        return stored;
      }
      const outcome = reconstructRetainedOutcome(retained, commandKind);
      if (!outcome) {
        this.markDirtyTerminalOutcome(command.idempotencyKey, retained.sequence);
        throw missingRetainedOutcomeSidecarError();
      }
      this.markDirtyTerminalOutcome(command.idempotencyKey, retained.sequence, outcome);
      this.rememberOutcome(command.idempotencyKey, outcome);
      return outcome;
    }

    const stored = await this.compactable?.loadOutcome(command.idempotencyKey);
    if (stored) {
      this.rememberOutcome(command.idempotencyKey, stored);
      return stored;
    }
    if (this.legacySnapshotOutcomeKeys.has(command.idempotencyKey)) {
      throw missingLegacySnapshotOutcomeSidecarError();
    }

    return this.submitFreshWhenCapacityAvailable(command);
  }

  private async submitFreshWhenCapacityAvailable(command: ControlCommand): Promise<CommandOutcome> {
    if (!await this.ensureDurabilityReadyForFreshExecution()) {
      return rejectedOutcome(
        'durability_unavailable',
        'durable outcome persistence is unavailable; refusing a new effect',
      );
    }
    await this.flushDirtyTerminalOutcomesBeforeFreshReservation();
    const reservation = this.tryReserveFreshExecution(command.idempotencyKey);
    if (reservation === 'durability_unavailable') {
      return rejectedOutcome('durability_unavailable', 'durable outcome persistence capacity is exhausted');
    }
    if (reservation === 'runtime_busy') {
      return rejectedOutcome('runtime_busy', 'control runtime pending command capacity exceeded');
    }
    try {
      return await this.submitFresh(command);
    } finally {
      this.activeFreshExecutions.delete(command.idempotencyKey);
    }
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
    const validationFailureOwnership = isSurfaceActionCommand(command)
      ? this.trustedValidationFailureOwnership(command)
      : undefined;
    try {
      if (requiresOperator(command.kind) && command.actor.kind !== 'human') {
        return this.appendTerminal(command, rejectedOutcome('operator_required', 'command requires an operator'));
      }
      switch (command.kind) {
        case 'lease.request': {
          await this.assertTaskSubjectActive(command.payload.taskId, command.actor.id);
          if (this.leaseRequests.has(command.id) || this.leaseRequestTombstones.has(command.id)
            || this.capabilityLeases.snapshot().some((lease) => lease.requestId === command.id)) {
            throw codedRuntimeError('lease_request_conflict', 'lease request ID already exists');
          }
          if (this.leaseRequests.size >= AGENT_CONTROL_LIMITS.leaseRequestPending) {
            throw codedRuntimeError('lease_request_capacity', 'lease request capacity is exhausted');
          }
          this.assertLeaseRequestBounds(command);
          const request: LeaseRequestRecord = Object.freeze({
            id: command.id, ownerEpoch: command.ownerEpoch,
            actorId: command.actor.id, taskId: command.payload.taskId,
            status: 'pending', createdAt: command.createdAt,
            ttlMs: command.payload.ttlMs,
            grants: Object.freeze(command.payload.grants.map((grant) => Object.freeze({
              target: Object.freeze({ ...grant.target }),
              capabilities: Object.freeze([...grant.capabilities]),
            }))),
          });
          this.leaseRequests.set(request.id, request);
          return this.appendTerminal(command, succeededOutcome({ requestId: request.id }));
        }
        case 'lease.grant': {
          const request = this.leaseRequests.get(command.payload.requestId);
          if (!request) {
            if (this.leaseRequestTombstones.has(command.payload.requestId)
              || this.capabilityLeases.snapshot().some((lease) => lease.requestId === command.payload.requestId)) {
              throw codedRuntimeError('lease_request_consumed', 'lease request has already been resolved');
            }
            throw codedRuntimeError('lease_request_missing', 'lease request does not exist');
          }
          if (request.ownerEpoch !== this.ownerEpoch || request.ownerEpoch !== command.ownerEpoch) {
            throw codedRuntimeError('lease_request_stale', 'lease request belongs to another owner epoch');
          }
          if (request.status !== 'pending') {
            throw codedRuntimeError('lease_request_consumed', 'lease request has already been resolved');
          }
          await this.assertTaskSubjectActive(request.taskId, request.actorId);
          this.assertGrantTargets(request.grants, command.projectRoot);
          const lease = this.capabilityLeases.grant({
            requestId: request.id,
            actorId: request.actorId,
            taskId: request.taskId,
            ttlMs: request.ttlMs,
            grants: request.grants,
            grantedBy: command.actor.id,
          });
          this.leaseRequests.delete(request.id);
          this.rememberLeaseRequestIdentity(request.id);
          return this.appendTerminal(command, succeededOutcome({ lease }));
        }
        case 'lease.release': {
          const lease = this.capabilityLeases.snapshot().find((item) => item.id === command.payload.leaseId);
          if (!lease || lease.actorId !== command.actor.id || lease.taskId !== command.payload.taskId
            || lease.revision !== command.payload.leaseRevision) {
            throw codedRuntimeError('capability_denied', 'only the owning task may release a capability lease');
          }
          await this.assertTaskSubjectActive(command.payload.taskId, command.actor.id);
          this.capabilityLeases.release(lease.id);
          await this.revokeApprovalsForLease(lease.id);
          this.rememberLeaseRequestIdentity(lease.requestId);
          return this.appendTerminal(command, succeededOutcome());
        }
        case 'lease.revoke': {
          const lease = this.capabilityLeases.revoke(command.payload.leaseId);
          if (lease) {
            await this.revokeApprovalsForLease(lease.id);
            this.rememberLeaseRequestIdentity(lease.requestId);
          }
          return this.appendTerminal(command, succeededOutcome());
        }
        case 'provider.resource.upsert': {
          this.assertProviderResourceScope(command.payload.resource, command.projectRoot);
          const previous = this.surfaces.get(command.payload.resource.id);
          const resource = this.surfaces.upsertBrowserTab(command.payload.resource);
          if (previous?.kind === 'browser_tab' && previous.generation !== resource.generation) {
            await this.revokeTarget({
              kind: 'browser_tab', id: previous.id, generation: previous.generation,
            });
          }
          return this.appendTerminal(command, succeededOutcome({ resource }));
        }
        case 'provider.resource.remove': {
          const current = this.surfaces.require(command.payload.id, command.payload.generation);
          if (current.kind !== 'browser_tab') throw codedRuntimeError('resource_missing', 'browser resource is missing');
          this.surfaces.remove(current.id);
          await this.revokeTarget({ kind: 'browser_tab', id: current.id, generation: current.generation });
          return this.appendTerminal(command, succeededOutcome());
        }
        case 'approval.resolve':
          return await this.resolveApproval(command);
        default: {
          const context = await this.prepareSurfaceAction(command);
          if (context.classification.decision === 'approval') {
            if (!context.effect) throw codedRuntimeError('approval_payload_invalid', 'approval effect is missing');
            this.refreshApprovalState();
            const immutableContext = freezeContext(context);
            const subjectId = taskSubjectId(command.payload.taskId, command.actor.id);
            const approval = this.approvals.requestCurrent({
              actionId: command.id,
              ownerEpoch: command.ownerEpoch,
              taskId: command.payload.taskId,
              actorId: command.actor.id,
              ...(subjectId ? { subjectId } : {}),
              leaseId: command.payload.leaseId,
              leaseRevision: command.payload.leaseRevision,
              resource: context.target,
              capability: context.classification.capability,
              effect: context.effect,
              executablePayloadDigest: context.executablePayloadDigest,
            });
            if (!this.pendingApprovals.has(approval.id)) {
              this.pendingApprovals.set(approval.id, immutableContext);
            }
            const journalEvent = agentControlJournalPayload({ kind: 'approval.requested',
              commandId: command.id,
              approvalId: approval.id,
              payloadDigest: approval.payloadDigest,
              taskId: approval.taskId,
              actorId: approval.actorId,
              ...(approval.subjectId ? { subjectId: approval.subjectId } : {}),
              leaseId: approval.leaseId,
              leaseRevision: approval.leaseRevision,
              resource: createAgentControlJournalResource(approval.resource),
              capability: approval.capability,
              effect: approval.effect,
            });
            await this.journal.append(journalEvent.kind, journalEvent.payload);
            const receipt = this.makeReceipt(command, context.target, 'approval_required', {
              value: { approvalId: approval.id, payloadDigest: approval.payloadDigest },
            }, context.ownership);
            this.rememberReceipt(receipt, context.ownership.taskId);
            return this.appendTerminal(command, succeededOutcome({
              ...receipt,
              approvalId: approval.id,
              payloadDigest: approval.payloadDigest,
            }), receipt);
          }
          const receipt = await this.enqueueSurfaceEffect(context);
          return this.appendTerminal(command, outcomeForReceipt(receipt), receipt);
        }
      }
    } catch (error) {
      if (errorCodeIs(error, 'approval_action_conflict')) {
        return this.appendTerminal(command, failedOutcome(error));
      }
      if (isSurfaceActionCommand(command)) {
        const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'action_validation_failed';
        return this.terminalizeValidationFailure(command, targetForSurfaceAction(command),
          code === 'task_subject_inactive'
            ? 'action_invalidated'
            : code === 'task_credential_unavailable'
              ? 'backend_unavailable'
              : code === 'script_source_too_large' || code === 'script_args_invalid' || code === 'script_args_too_large'
            ? code
            : 'action_validation_failed', validationFailureOwnership);
      }
      return this.appendTerminal(command, failedOutcome(error));
    }
  }

  private async prepareSurfaceAction(
    command: SurfaceActionContext['command'],
  ): Promise<SurfaceActionContext> {
    this.assertCommandCurrent(command);
    let preparedCommand = command;
    let target: LeaseTarget;
    let classification: PolicyClassification;
    let effect: RedactedApprovalEffect | undefined;
    let canonicalSemantic: CanonicalElementSemantics | undefined;
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
        assertBrowserActionFields(action);
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
        canonicalSemantic = semantic;
        break;
      }
      case 'browser.script':
        if (Buffer.byteLength(command.payload.source, 'utf8') > AGENT_CONTROL_LIMITS.scriptSourceBytes) {
          throw codedRuntimeError('script_source_too_large', 'browser script source exceeds maximum size');
        }
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        if (command.payload.args !== undefined) {
          const canonicalArgs = canonicalizeBoundedJson(command.payload.args, {
            maxBytes: AGENT_CONTROL_LIMITS.scriptResultBytes,
            invalidCode: 'script_args_invalid',
            sizeCode: 'script_args_too_large',
            label: 'browser script arguments',
          });
          preparedCommand = {
            ...command,
            payload: { ...command.payload, args: canonicalArgs.value },
          } as SurfaceActionContext['command'];
        }
        classification = classifyBrowserScript();
        effect = createRedactedApprovalEffect({ kind: 'script', target: command.payload.source });
        break;
    }
    await this.assertSurfaceAndLease(command, target, classification.capability);
    return {
      command: preparedCommand,
      target,
      ownership: trustedOwnershipForCommand(preparedCommand),
      classification,
      executablePayloadDigest: digestExecutablePayload(preparedCommand, canonicalSemantic),
      ...(effect ? { effect } : {}),
    };
  }

  private async resolveApproval(
    command: Extract<ControlCommand, { kind: 'approval.resolve' }>,
  ): Promise<CommandOutcome> {
    const context = this.pendingApprovals.get(command.payload.approvalId);
    if (context) {
      await this.assertTaskSubjectActive(context.command.payload.taskId, context.command.actor.id);
    }
    let approval: Approval;
    try {
      approval = command.payload.decision === 'approve'
        ? this.approvals.approve(command.payload.approvalId, command.actor.id, command.payload.payloadDigest)
        : this.approvals.deny(command.payload.approvalId, command.actor.id, command.payload.payloadDigest);
    } catch (error) {
      if (
        context
        && isApprovalInvalidationError(error)
      ) {
        await this.finalizeApproval(
          command.payload.approvalId,
          errorCodeIs(error, 'approval_expired') ? 'approval_expired' : 'action_invalidated',
          context,
        );
      }
      throw error;
    }
    if (!context) throw codedRuntimeError('approval_missing', 'original approval command is unavailable');
    if (command.payload.decision === 'deny') {
      const receipt = this.makeReceipt(
        context.command,
        context.target,
        'denied',
        { code: 'approval_denied' },
        context.ownership,
      );
      this.rememberReceipt(receipt, context.ownership.taskId);
      this.pendingApprovals.delete(approval.id);
      await this.appendTerminal(context.command, outcomeForReceipt(receipt), receipt);
      return this.appendTerminal(command, succeededOutcome(receipt));
    }
    if (!context.effect) throw codedRuntimeError('approval_payload_invalid', 'approval effect is unavailable');
    try {
      await this.assertSurfaceAndLease(context.command, context.target, context.classification.capability);
      const subjectId = taskSubjectId(context.command.payload.taskId, context.command.actor.id);
      this.approvals.consume({
        approvalId: approval.id,
        payloadDigest: command.payload.payloadDigest,
        actionId: context.command.id,
        ownerEpoch: context.command.ownerEpoch,
        taskId: context.command.payload.taskId,
        actorId: context.command.actor.id,
        ...(subjectId ? { subjectId } : {}),
        leaseId: context.command.payload.leaseId,
        leaseRevision: context.command.payload.leaseRevision,
        resource: context.target,
        capability: context.classification.capability,
        effect: context.effect,
        executablePayloadDigest: context.executablePayloadDigest,
      });
      this.pendingApprovals.delete(approval.id);
      const receipt = await this.enqueueSurfaceEffect(context);
      await this.appendTerminal(context.command, outcomeForReceipt(receipt), receipt);
      return this.appendTerminal(command, outcomeForReceipt(receipt), receipt);
    } catch (error) {
      await this.revokeApprovalsForLease(approval.leaseId);
      this.pendingApprovals.delete(approval.id);
      throw error;
    }
  }

  private async enqueueSurfaceEffect(context: SurfaceActionContext): Promise<ActionReceipt> {
    const queue = this.queueForResource(context.target);
    if (queue.quarantined) {
      const receipt = this.makeReceipt(
        context.command,
        context.target,
        'unknown',
        { code: 'effect_unknown' },
        context.ownership,
      );
      this.rememberReceipt(receipt, context.ownership.taskId);
      return receipt;
    }
    if (queue.pendingEffects >= AGENT_CONTROL_LIMITS.resourceQueueDepth) {
      const receipt = this.makeReceipt(
        context.command,
        context.target,
        'failed',
        { code: 'queue_full' },
        context.ownership,
      );
      this.rememberReceipt(receipt, context.ownership.taskId);
      return receipt;
    }
    queue.pendingEffects += 1;
    const key = resourceKey(context.target);
    const prior = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => { release = resolve; });
    const tail = queue.tail;
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
        }, context.ownership);
        this.rememberReceipt(receipt, context.ownership.taskId);
        return receipt;
      }
      let value: unknown;
      try {
        const effect = (() => {
          switch (context.command.kind) {
            case 'pane.observe': return this.handlers.observePane(context.command.payload);
            case 'pane.action': return this.handlers.actOnPane(context.command.payload);
            case 'browser.inspect': return this.handlers.inspectBrowser(context.command.payload);
            case 'browser.action': return this.handlers.actOnBrowser(executableBrowserPayload(context.command.payload));
            case 'browser.script': return this.handlers.runBrowserScript(context.command.payload);
          }
        })();
        value = await withTimeout(
          effect,
          context.command.kind === 'browser.script'
            ? AGENT_CONTROL_LIMITS.scriptTimeoutMs
            : AGENT_CONTROL_LIMITS.actionTimeoutMs,
        );
      } catch (error) {
        const ambiguous = Boolean(error && typeof error === 'object' && (error as { ambiguous?: unknown }).ambiguous);
        if (errorCodeIs(error, 'effect_timeout')) queue.quarantined = true;
        const receipt = this.makeReceipt(
          context.command,
          context.target,
          ambiguous ? 'unknown' : 'failed',
          { code: ambiguous ? 'effect_unknown' : stableSurfaceEffectCode(error) },
          context.ownership,
        );
        this.rememberReceipt(receipt, context.ownership.taskId);
        return receipt;
      }
      let receipt: ActionReceipt;
      try {
        receipt = context.command.kind === 'browser.script'
          ? this.makeScriptReceipt(context.command, context.target, value, context.ownership)
          : this.makeReceipt(context.command, context.target, 'succeeded', { value }, context.ownership);
      } catch (error) {
        receipt = this.makeReceipt(
          context.command,
          context.target,
          'failed',
          { code: stableSurfaceEffectCode(error) },
          context.ownership,
        );
      }
      this.rememberReceipt(receipt, context.ownership.taskId);
      return receipt;
    } finally {
      queue.pendingEffects -= 1;
      release();
      void tail.then(() => this.pruneResourceQueue(key, queue, tail));
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
      const tail = queue.tail
        .then(() => this.runQueuedItem(item, run))
        .catch((error: unknown) => item.reject(error));
      queue.tail = tail;
      void tail.then(() => this.pruneResourceQueue(queueKey, queue, tail));
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
          await this.assertCapabilityLease({
            leaseId: command.payload.leaseId,
            revision: command.payload.leaseRevision,
            ownerEpoch: command.ownerEpoch,
            actorId: command.actor.id,
            taskId: command.payload.taskId,
            target: { kind: 'project', id: command.projectRoot },
            capability: 'pane.create',
          });
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
        if (resource.projectRoot !== projectRoot) {
          throw codedRuntimeError('resource_scope_mismatch', 'surface belongs to another project');
        }
      }
    }
  }

  private assertLeaseRequestBounds(command: Extract<ControlCommand, { kind: 'lease.request' }>): void {
    const textValues = [
      command.id,
      command.actor.id,
      command.payload.taskId,
      ...command.payload.grants.flatMap((grant) => [grant.target.kind, grant.target.id]),
    ];
    const tooLarge = command.payload.grants.length > AGENT_CONTROL_LIMITS.leaseRequestGrants
      || command.payload.grants.some((grant) => (
        grant.capabilities.length > AGENT_CONTROL_LIMITS.leaseRequestCapabilitiesPerGrant
        || grant.capabilities.some((capability) => (
          Buffer.byteLength(capability, 'utf8') > AGENT_CONTROL_LIMITS.leaseRequestCapabilityBytes
        ))
      ))
      || textValues.some((value) => (
        Buffer.byteLength(value, 'utf8') > AGENT_CONTROL_LIMITS.leaseRequestTextBytes
      ));
    if (tooLarge) {
      throw codedRuntimeError(
        'lease_request_too_large',
        'lease request exceeds the operator display limits',
      );
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

  private async assertSurfaceAndLease(
    command: SurfaceActionContext['command'],
    target: LeaseTarget,
    capability: SurfaceCapability,
  ): Promise<void> {
    if (target.kind !== 'project') {
      const resource = this.surfaces.require(target.id, target.generation);
      if (resource.kind !== target.kind) {
        throw codedRuntimeError('resource_missing', 'surface target kind does not match the registered resource');
      }
      if (resource.projectRoot !== command.projectRoot) {
        throw codedRuntimeError('resource_scope_mismatch', 'surface belongs to another project');
      }
    } else if (target.id !== command.projectRoot) {
      throw codedRuntimeError('resource_missing', 'project target does not match the command project');
    }
    await this.assertCapabilityLease({
      leaseId: command.payload.leaseId,
      revision: command.payload.leaseRevision,
      ownerEpoch: command.ownerEpoch,
      actorId: command.actor.id,
      taskId: command.payload.taskId,
      target,
      capability,
    });
  }

  private async assertCapabilityLease(assertion: CapabilityLeaseAssertion): Promise<void> {
    await this.assertTaskSubjectActive(assertion.taskId, assertion.actorId);
    this.capabilityLeases.assert(assertion);
  }

  private async assertTaskSubjectActive(taskId: string, actorId: string): Promise<void> {
    const status = await this.readTaskSubjectStatus(taskId, actorId);
    if (status === 'active' || status === 'untracked') return;
    if (status === 'inactive') {
      await this.invalidateTaskSubjectAuthority(taskId, actorId);
      throw codedRuntimeError('task_subject_inactive', 'task subject is no longer active');
    }
    throw codedRuntimeError('task_credential_unavailable', 'task credential state is unavailable');
  }

  private async readTaskSubjectStatus(
    taskId: string,
    actorId: string,
  ): Promise<TaskSubjectAuthorityStatus> {
    if (!this.readActiveTaskCredential) return 'untracked';
    const reference = taskSubjectCredentialReference(taskId, actorId);
    if (!reference) return 'untracked';
    let current: ControlTaskCredentialReference | null;
    try {
      current = await this.readActiveTaskCredential(taskId);
    } catch {
      return 'unavailable';
    }
    if (!current) return 'inactive';
    return current.principalId === reference.principalId
      && current.taskBinding.subjectId === reference.taskBinding.subjectId
      ? 'active'
      : 'inactive';
  }

  private async invalidateTaskSubjectAuthority(taskId: string, actorId: string): Promise<void> {
    for (const request of [...this.leaseRequests.values()]) {
      if (request.taskId !== taskId || request.actorId !== actorId) continue;
      this.leaseRequests.delete(request.id);
      this.rememberLeaseRequestIdentity(request.id);
    }
    await this.revokeApprovalsForTaskSubject(taskId, actorId);
    for (const lease of this.capabilityLeases.revokeActorTask(actorId, taskId)) {
      await this.revokeApprovalsForLease(lease.id);
      this.rememberLeaseRequestIdentity(lease.requestId);
    }
  }

  private async revokeTarget(target: LeaseTarget): Promise<void> {
    for (const lease of this.capabilityLeases.revokeTarget(target)) {
      await this.revokeApprovalsForLease(lease.id);
      this.rememberLeaseRequestIdentity(lease.requestId);
    }
  }

  private rememberLeaseRequestIdentity(requestId: string): void {
    this.leaseRequestTombstones.delete(requestId);
    this.leaseRequestTombstones.add(requestId);
    while (this.leaseRequestTombstones.size > AGENT_CONTROL_LIMITS.leaseRequestRecords) {
      const oldest = this.leaseRequestTombstones.values().next().value;
      if (oldest === undefined) break;
      this.leaseRequestTombstones.delete(oldest);
    }
  }

  private assertProviderResourceScope(
    resource: Extract<ControlCommand, { kind: 'provider.resource.upsert' }>['payload']['resource'],
    projectRoot: string,
  ): void {
    if (path.resolve(resource.projectRoot) !== path.resolve(projectRoot)) {
      throw codedRuntimeError('resource_scope_mismatch', 'provider resource project does not match owner');
    }
    const relative = path.relative(path.resolve(projectRoot), path.resolve(resource.worktreeRoot));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw codedRuntimeError('resource_scope_mismatch', 'provider worktree is outside the project scope');
    }
  }

  private approvalAlreadyTerminalized(actionId: string): boolean {
    const receipt = this.receipts.get(actionId)?.receipt;
    return receipt !== undefined && receipt.state !== 'approval_required';
  }

  private async finalizeApproval(
    approvalId: string,
    code: 'action_invalidated' | 'approval_expired',
    fallbackContext?: SurfaceActionContext,
  ): Promise<void> {
    const existing = this.approvalTerminalizations.get(approvalId);
    if (existing) {
      await existing;
      return;
    }
    const context = this.pendingApprovals.get(approvalId) ?? fallbackContext;
    if (!context) return;
    if (this.approvalAlreadyTerminalized(context.command.id)) {
      this.pendingApprovals.delete(approvalId);
      return;
    }
    let finalization!: Promise<void>;
    finalization = (async () => {
      try {
        const activeContext = this.pendingApprovals.get(approvalId) ?? context;
        if (this.approvalAlreadyTerminalized(activeContext.command.id)) return;
        await this.terminalizeValidationFailure(
          activeContext.command,
          activeContext.target,
          code,
          activeContext.ownership,
        );
      } finally {
        this.pendingApprovals.delete(approvalId);
      }
    })();
    this.approvalTerminalizations.set(approvalId, finalization);
    void finalization.finally(() => this.approvalTerminalizations.delete(approvalId));
    await finalization;
  }

  private async finalizeApprovals(
    approvals: readonly Approval[],
    code: 'action_invalidated' | 'approval_expired',
  ): Promise<void> {
    await Promise.all(approvals.map((approval) => this.finalizeApproval(approval.id, code)));
  }

  private async revokeApprovalsForTaskSubject(taskId: string, actorId: string): Promise<void> {
    const subjectId = taskSubjectId(taskId, actorId);
    const ownedApprovalIds = this.approvals.peek()
      .filter((approval) => isLiveApproval(approval)
        && approvalMatchesTaskSubject(approval, taskId, actorId, subjectId))
      .map((approval) => approval.id);
    await this.finalizeApprovals(
      this.approvals.revokeForApprovalIds(ownedApprovalIds),
      'action_invalidated',
    );
  }

  private async revokeApprovalsForLease(leaseId: string): Promise<void> {
    this.refreshApprovalState();
    await this.finalizeApprovals(this.approvals.revokeForLease(leaseId), 'action_invalidated');
  }

  private async recoverRestartedApprovalReceipts(
    records: readonly DurableReceiptRecord[],
  ): Promise<void> {
    for (const record of records) {
      if (record.receipt.state !== 'approval_required') continue;
      if (this.compactable) {
        await this.compactable.storeOutcome(
          record.idempotencyKey,
          restartInvalidatedOutcome(),
        );
      }
      await this.journal.append('command.failed', restartInvalidatedPayload(record));
    }
    this.capabilityLeases.revokeAll();
    this.approvals.revokeAll();
  }

  private refreshApprovalState(
    activeLeases: readonly CapabilityLease[] = this.capabilityLeases.snapshot(),
  ): readonly Approval[] {
    for (const approval of this.approvals.expire()) {
      void this.finalizeApproval(approval.id, 'approval_expired');
    }
    const activeLeasesById = new Map(activeLeases.map((lease) => [lease.id, lease] as const));
    const staleApprovalIds = this.approvals.peek()
      .filter((approval) => isLiveApproval(approval)
        && !approvalLeaseCurrent(approval, activeLeasesById.get(approval.leaseId)))
      .map((approval) => approval.id);
    for (const approval of this.approvals.revokeForApprovalIds(staleApprovalIds)) {
      void this.finalizeApproval(approval.id, 'action_invalidated');
    }
    const approvals = this.approvals.peek();
    this.prunePendingApprovals(approvals);
    return approvals;
  }

  private trustedValidationFailureOwnership(
    command: SurfaceActionContext['command'],
  ): TrustedReceiptOwnership | undefined {
    const reference = taskSubjectCredentialReference(command.payload.taskId, command.actor.id);
    if (!reference) return undefined;
    const ownership: TrustedReceiptOwnership = {
      taskId: reference.taskBinding.taskId,
      actorId: reference.principalId,
    };
    const target = targetForSurfaceOwnership(command);
    const capability = capabilityForSurfaceCommand(command);
    if (!target || !capability) return ownership;
    const lease = this.capabilityLeases.get(command.payload.leaseId);
    if (
      !lease
      || lease.ownerEpoch !== this.ownerEpoch
      || lease.actorId !== reference.principalId
      || lease.taskId !== reference.taskBinding.taskId
      || !lease.grants.some((grant) => (
        leaseTargetsEqual(grant.target, target) && grant.capabilities.includes(capability)
      ))
    ) {
      return ownership;
    }
    return {
      ...ownership,
      leaseId: lease.id,
      leaseRevision: lease.revision,
    };
  }

  private makeReceipt(
    command: SurfaceActionContext['command'],
    target: LeaseTarget,
    state: ActionReceipt['state'],
    details: { code?: string; message?: string; value?: unknown; sourceDigest?: string;
      sourceBytes?: number; resultBytes?: number; durationMs?: number } = {},
    ownership?: TrustedReceiptOwnership,
  ): ActionReceipt {
    return Object.freeze({
      schema: 'psyche.control.receipt/v1' as const,
      actionId: command.id,
      state,
      resource: Object.freeze({ ...target }),
      createdAt: command.createdAt,
      ...(ownership ? {
        taskId: ownership.taskId,
        actorId: ownership.actorId,
        ...(ownership.leaseId ? { leaseId: ownership.leaseId } : {}),
        ...(ownership.leaseRevision !== undefined ? { leaseRevision: ownership.leaseRevision } : {}),
      } : {}),
      ...(state === 'approval_required' ? {} : { completedAt: new Date().toISOString() }),
      ...details,
    });
  }

  private makeScriptReceipt(
    command: Extract<ControlCommand, { kind: 'browser.script' }>,
    target: LeaseTarget,
    result: unknown,
    ownership: TrustedActionOwnership,
  ): ActionReceipt {
    let canonicalEnvelope: unknown;
    try {
      canonicalEnvelope = canonicalizeBoundedJson(result, {
        maxBytes: AGENT_CONTROL_LIMITS.scriptResultBytes + 1024,
        invalidCode: 'serialization_failed',
        sizeCode: 'result_too_large',
        label: 'browser script result envelope',
      }).value;
    } catch (error) {
      throw error;
    }
    if (!canonicalEnvelope || typeof canonicalEnvelope !== 'object' || Array.isArray(canonicalEnvelope)) {
      throw codedRuntimeError('serialization_failed', 'browser script returned an invalid result envelope');
    }
    const keys = Object.keys(canonicalEnvelope);
    if (keys.length !== 3 || !keys.includes('value') || !keys.includes('resultBytes') || !keys.includes('durationMs')) {
      throw codedRuntimeError('serialization_failed', 'browser script returned an invalid result envelope');
    }
    const envelope = canonicalEnvelope as { value: unknown; resultBytes: unknown; durationMs: unknown };
    if (!Number.isSafeInteger(envelope.resultBytes) || (envelope.resultBytes as number) < 0
      || (envelope.resultBytes as number) > AGENT_CONTROL_LIMITS.scriptResultBytes
      || !Number.isFinite(envelope.durationMs) || (envelope.durationMs as number) < 0
      || (envelope.durationMs as number) > AGENT_CONTROL_LIMITS.scriptTimeoutMs) {
      throw codedRuntimeError('serialization_failed', 'browser script returned invalid result metadata');
    }
    const canonicalValue = canonicalizeBoundedJson(envelope.value, {
      maxBytes: AGENT_CONTROL_LIMITS.scriptResultBytes,
      invalidCode: 'serialization_failed',
      sizeCode: 'result_too_large',
      label: 'browser script result',
    });
    if (canonicalValue.bytes !== envelope.resultBytes) {
      throw codedRuntimeError('serialization_failed', 'browser script returned a mismatched result byte count');
    }
    return this.makeReceipt(command, target, 'succeeded', {
      value: canonicalValue.value,
      sourceDigest: createHash('sha256').update(command.payload.source, 'utf8').digest('hex'),
      sourceBytes: Buffer.byteLength(command.payload.source, 'utf8'),
      resultBytes: envelope.resultBytes as number,
      durationMs: envelope.durationMs as number,
    }, ownership);
  }

  private rememberReceipt(receipt: ActionStatusReceipt, taskId?: string): void {
    const redacted = redactReceipt(receipt);
    this.receipts.delete(receipt.actionId);
    this.receipts.set(receipt.actionId, { taskId, receipt: redacted });
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
    ownership?: TrustedReceiptOwnership,
  ): Promise<CommandOutcome> {
    const receipt = this.makeReceipt(command, target, 'failed', { code }, ownership);
    this.rememberReceipt(receipt, ownership?.taskId);
    const outcome = outcomeForReceipt(receipt);
    return this.appendTerminal(command, outcome, receipt);
  }

  private prunePendingApprovals(approvals: readonly { id: string; status: string }[]): void {
    const active = new Set(
      approvals.filter((approval) => approval.status === 'pending' || approval.status === 'approved')
        .map((approval) => approval.id),
    );
    for (const id of this.pendingApprovals.keys()) {
      if (!active.has(id) && !this.approvalTerminalizations.has(id)) {
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
    if (isSurfaceControlCommand(command)) {
      const built = agentControlJournalPayload({ kind: 'command.requested',
        commandId: command.id, idempotencyKey: command.idempotencyKey,
        commandKind: command.kind, ownerEpoch: command.ownerEpoch });
      const event = await this.journal.append(built.kind, built.payload);
      return event;
    }
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
    const outcomeDigest = exactCommandOutcomeDigest(outcome);
    if (isSurfaceControlCommand(command)) {
      const built = agentControlJournalPayload({
        kind: terminalKindForOutcome(outcome), commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        status: outcome.status,
        outcomeDigest,
        ...(outcome.status === 'succeeded' ? {} : { code: 'surface_command_failed' }),
        ...(receipt ? { receipt: journalReceiptMetadata(receipt) } : {}),
      });
      const event = await this.journal.append(built.kind, built.payload);
      this.rememberOutcome(command.idempotencyKey, outcome);
      await this.persistTerminalOutcomeOrLeaveDirty(command.idempotencyKey, event.sequence, outcome);
      return outcome;
    }
    const event = await this.journal.append(terminalKindForOutcome(outcome), {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      ...payloadForOutcome(outcome, outcomeDigest),
    });
    const record = this.commandRecords.get(command.id);
    if (record) {
      record.outcome = outcome;
      record.sequence = event.sequence;
    } else if (!isSurfaceControlCommand(command)) {
      this.retainCommandRecord(command.id, { command, outcome, sequence: event.sequence });
    }
    this.rememberOutcome(command.idempotencyKey, outcome);
    await this.persistTerminalOutcomeOrLeaveDirty(command.idempotencyKey, event.sequence, outcome);
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

  /**
   * Bounded hot-cache replay protection for idempotency keys.
   *
   * Exact outcomes are also written to the journal's disk-backed sidecar, so
   * evicted or restarted keys still replay on a cold lookup instead of
   * executing again.
   */
  private rememberOutcome(idempotencyKey: string, outcome: CommandOutcome): void {
    this.outcomesByIdempotencyKey.delete(idempotencyKey);
    this.outcomesByIdempotencyKey.set(idempotencyKey, outcome);
    while (this.outcomesByIdempotencyKey.size > MAX_COMMAND_RECORDS) {
      const oldest = this.outcomesByIdempotencyKey.keys().next().value;
      if (oldest === undefined) break;
      this.outcomesByIdempotencyKey.delete(oldest);
    }
  }

  private reduceOutcomes(events: RuntimeEvent[]): void {
    for (const event of events) {
      if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
      const idempotencyKey = stringPayload(event, 'idempotencyKey');
      if (!idempotencyKey) continue;
      this.rememberOutcome(idempotencyKey, outcomeFromEvent(event));
    }
  }

  private rehydrateReceipts(records: readonly DurableReceiptRecord[]): void {
    this.receipts.clear();
    for (const record of records) {
      this.rememberReceipt(record.receipt, record.receipt.taskId);
    }
  }

  private rememberLegacySnapshotOutcomeKeys(outcomes: Record<string, CommandOutcome>): void {
    for (const idempotencyKey of Object.keys(outcomes)) {
      this.legacySnapshotOutcomeKeys.add(idempotencyKey);
    }
  }

  private async persistRecoveredTerminalOutcomes(events: readonly RuntimeEvent[]): Promise<void> {
    if (!this.compactable) return;
    for (const event of events) {
      if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
      const idempotencyKey = stringPayload(event, 'idempotencyKey');
      if (!idempotencyKey) continue;
      const outcome = outcomeFromEvent(event);
      this.rememberOutcome(idempotencyKey, outcome);
      await this.persistTerminalOutcomeOrLeaveDirty(idempotencyKey, event.sequence, outcome);
    }
  }

  private async loadRetainedOutcomeSidecar(
    terminalEvent: RuntimeEvent,
  ): Promise<CommandOutcome | undefined> {
    if (!this.compactable) return undefined;
    const idempotencyKey = stringPayload(terminalEvent, 'idempotencyKey');
    if (!idempotencyKey) return undefined;
    try {
      return await this.compactable.loadOutcome(idempotencyKey);
    } catch (error) {
      this.invalidateActiveCompactionForSequence(terminalEvent.sequence);
      throw error;
    }
  }

  private async loadRetainedReplayOutcome(
    terminalEvent: RuntimeEvent,
    commandKind?: ControlCommand['kind'] | string,
    attestedDigest?: string,
  ): Promise<CommandOutcome | undefined> {
    const stored = await this.loadRetainedOutcomeSidecar(terminalEvent);
    if (!stored) return undefined;
    const verification = verifyExactOutcomeAgainstTerminalEvent(
      stored,
      terminalEvent,
      commandKind,
      attestedDigest,
    );
    if (!verification.ok) {
      this.invalidateActiveCompactionForSequence(terminalEvent.sequence);
      throw verification.error;
    }
    return stored;
  }

  private async restoreRetainedOutcomes(events: RuntimeEvent[]): Promise<void> {
    if (!this.compactable) {
      this.reduceOutcomes(events);
      return;
    }
    const currentEvents = this.journal.read(0);
    const commandKinds = retainedCommandKinds(currentEvents);
    const attestations = retainedOutcomeAttestations(currentEvents);
    for (const event of latestTerminalEvents(events)) {
      const idempotencyKey = stringPayload(event, 'idempotencyKey');
      if (!idempotencyKey) continue;
      const commandId = stringPayload(event, 'commandId');
      const transactionKey = commandId ? commandTransactionKey(commandId, idempotencyKey) : undefined;
      const commandKind = commandId
        ? commandKinds.get(commandTransactionKey(commandId, idempotencyKey))
        : undefined;
      const attestedDigest = transactionKey ? attestations.get(transactionKey) : undefined;
      let stored: CommandOutcome | undefined;
      if (legacyRetainedOutcomeNeedsAttestation(event, commandKind, attestedDigest)) {
        stored = await this.loadRetainedOutcomeSidecar(event);
        if (stored) {
          const digest = await this.attestRetainedOutcome(event, stored);
          if (transactionKey) attestations.set(transactionKey, digest);
        }
      } else {
        stored = await this.loadRetainedReplayOutcome(event, commandKind, attestedDigest);
      }
      if (stored) {
        this.clearDirtyTerminalOutcome(idempotencyKey, event.sequence);
        this.rememberOutcome(idempotencyKey, stored);
        continue;
      }
      const reconstructed = reconstructRetainedOutcome(event, commandKind);
      if (!reconstructed) {
        this.markDirtyTerminalOutcome(idempotencyKey, event.sequence);
        throw missingRetainedOutcomeSidecarError();
      }
      this.markDirtyTerminalOutcome(idempotencyKey, event.sequence, reconstructed);
      this.rememberOutcome(idempotencyKey, reconstructed);
    }
    await this.flushDirtyTerminalOutcomesThrough(Number.POSITIVE_INFINITY);
  }

  private async attestRetainedOutcome(
    event: RuntimeEvent,
    outcome: CommandOutcome,
  ): Promise<string> {
    const commandId = stringPayload(event, 'commandId');
    const idempotencyKey = stringPayload(event, 'idempotencyKey');
    if (!commandId || !idempotencyKey) throw missingRetainedOutcomeDigestError();
    const outcomeDigest = exactCommandOutcomeDigest(outcome);
    await this.journal.append(COMMAND_OUTCOME_ATTESTED_KIND, {
      commandId,
      idempotencyKey,
      outcomeDigest,
    });
    return outcomeDigest;
  }

  private async flushDirtyTerminalOutcomesBeforeFreshReservation(): Promise<void> {
    if (!this.compactable) return;
    if (this.dirtyTerminalOutcomes.size + this.activeFreshExecutions.size < DIRTY_TERMINAL_OUTCOME_LIMIT) {
      return;
    }
    await this.flushDirtyTerminalOutcomesThrough(Number.POSITIVE_INFINITY);
  }

  private tryReserveFreshExecution(
    idempotencyKey: string,
  ): 'reserved' | 'durability_unavailable' | 'runtime_busy' {
    if (
      this.compactable
      && this.dirtyTerminalOutcomes.size + this.activeFreshExecutions.size >= DIRTY_TERMINAL_OUTCOME_LIMIT
    ) {
      return 'durability_unavailable';
    }
    if (this.activeFreshExecutions.size >= AGENT_CONTROL_LIMITS.pendingCommands) {
      return 'runtime_busy';
    }
    this.activeFreshExecutions.add(idempotencyKey);
    return 'reserved';
  }

  private markDirtyTerminalOutcome(
    idempotencyKey: string,
    sequence: number,
    outcome?: CommandOutcome,
  ): void {
    if (!this.compactable) return;
    this.invalidateActiveCompactionForSequence(sequence);
    const prior = this.dirtyTerminalOutcomes.get(idempotencyKey);
    if (!prior && this.dirtyTerminalOutcomes.size >= DIRTY_TERMINAL_OUTCOME_LIMIT) {
      throw codedRuntimeError(
        'durability_unavailable',
        'durable outcome persistence capacity is exhausted',
      );
    }
    if (!prior || sequence >= prior.sequence) {
      this.dirtyTerminalOutcomes.set(idempotencyKey, { sequence, outcome: outcome ?? prior?.outcome });
      return;
    }
    if (prior.outcome === undefined && outcome !== undefined) {
      this.dirtyTerminalOutcomes.set(idempotencyKey, { sequence: prior.sequence, outcome });
    }
  }

  private clearDirtyTerminalOutcome(idempotencyKey: string, sequence?: number): void {
    if (!this.compactable) return;
    const prior = this.dirtyTerminalOutcomes.get(idempotencyKey);
    if (!prior) return;
    if (sequence === undefined || prior.sequence <= sequence) {
      this.dirtyTerminalOutcomes.delete(idempotencyKey);
    }
  }

  private async persistTerminalOutcome(
    idempotencyKey: string,
    sequence: number,
    outcome: CommandOutcome,
  ): Promise<void> {
    if (!this.compactable) return;
    await this.compactable.storeOutcome(idempotencyKey, outcome);
    this.clearDirtyTerminalOutcome(idempotencyKey, sequence);
  }

  private async persistTerminalOutcomeOrLeaveDirty(
    idempotencyKey: string,
    sequence: number,
    outcome: CommandOutcome,
  ): Promise<void> {
    this.markDirtyTerminalOutcome(idempotencyKey, sequence, outcome);
    try {
      await this.persistTerminalOutcome(idempotencyKey, sequence, outcome);
    } catch (error) {
      console.error(
        `[control-runtime] durable outcome persistence failed for ${idempotencyKey}`,
        error,
      );
    } finally {
      this.maybeCompact();
    }
  }

  private async flushDirtyTerminalOutcomesThrough(coveredSequence: number): Promise<void> {
    if (!this.compactable) return;
    for (const [idempotencyKey, dirty] of this.dirtyTerminalOutcomes) {
      if (dirty.sequence > coveredSequence || dirty.outcome === undefined) continue;
      try {
        await this.persistTerminalOutcome(idempotencyKey, dirty.sequence, dirty.outcome);
      } catch {
        // Fail closed: compaction checks the dirty map after the retry pass.
      }
    }
  }

  private hasDirtyTerminalOutcomesThrough(coveredSequence: number): boolean {
    for (const dirty of this.dirtyTerminalOutcomes.values()) {
      if (dirty.sequence <= coveredSequence) return true;
    }
    return false;
  }

  private beginCompactionAttempt(coveredSequence: number): ActiveCompactionAttempt {
    const attempt = { coveredSequence, invalidated: false };
    this.activeCompaction = attempt;
    return attempt;
  }

  private finishCompactionAttempt(attempt: ActiveCompactionAttempt): void {
    if (this.activeCompaction === attempt) this.activeCompaction = undefined;
  }

  private invalidateActiveCompactionForSequence(sequence: number): void {
    const active = this.activeCompaction;
    if (!active || sequence > active.coveredSequence) return;
    active.invalidated = true;
  }

  private compactionShouldAbort(attempt: ActiveCompactionAttempt): boolean {
    return this.activeCompaction !== attempt
      || attempt.invalidated
      || this.hasDirtyTerminalOutcomesThrough(attempt.coveredSequence);
  }

  private coveredTerminalSequences(
    journal: CompactableJournal,
    coveredSequence: number,
  ): Map<string, {
    sequence: number;
    event: RuntimeEvent;
    commandKind?: ControlCommand['kind'] | string;
    attestedDigest?: string;
  }> {
    const covered = new Map<string, {
      sequence: number;
      event: RuntimeEvent;
      commandKind?: ControlCommand['kind'] | string;
      attestedDigest?: string;
    }>();
    const events = journal.read(0);
    const commandKinds = retainedCommandKinds(events);
    const attestations = retainedOutcomeAttestations(events);
    const latestByIdempotencyKey = new Map<string, RuntimeEvent>();
    for (const event of events) {
      if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
      const idempotencyKey = stringPayload(event, 'idempotencyKey');
      if (!idempotencyKey) continue;
      latestByIdempotencyKey.set(idempotencyKey, event);
      if (event.sequence > coveredSequence) continue;
      covered.set(idempotencyKey, {
        sequence: event.sequence,
        event,
      });
    }
    for (const [idempotencyKey, item] of covered) {
      const latest = latestByIdempotencyKey.get(idempotencyKey) ?? item.event;
      const commandId = stringPayload(latest, 'commandId');
      const transactionKey = commandId ? commandTransactionKey(commandId, idempotencyKey) : undefined;
      covered.set(idempotencyKey, {
        sequence: item.sequence,
        event: latest,
        commandKind: transactionKey ? commandKinds.get(transactionKey) : undefined,
        attestedDigest: transactionKey ? attestations.get(transactionKey) : undefined,
      });
    }
    return covered;
  }

  private async verifyCoveredTerminalOutcomes(
    journal: CompactableJournal,
    attempt: ActiveCompactionAttempt,
  ): Promise<boolean> {
    if (!this.compactable) return true;
    for (const [idempotencyKey, covered] of this.coveredTerminalSequences(journal, attempt.coveredSequence)) {
      if (this.compactionShouldAbort(attempt)) return false;
      try {
        const stored = await this.compactable.loadOutcome(idempotencyKey);
        if (stored) {
          const verification = verifyExactOutcomeAgainstTerminalEvent(
            stored,
            covered.event,
            covered.commandKind,
            covered.attestedDigest,
          );
          if (verification.ok) continue;
        }
      } catch {
        // Compaction fails closed: unreadable exact replay keeps the journal.
      }
      this.invalidateActiveCompactionForSequence(covered.sequence);
      return false;
    }
    return !this.compactionShouldAbort(attempt);
  }

  /**
   * Compacts once the journal has grown well past the window the runtime can
   * actually use, so the rewrite cost is amortised rather than paid per append.
   */
  private maybeCompact(): void {
    const journal = this.compactable;
    if (!journal) return;
    if (journal.sequence - journal.firstSequence + 1 <= JOURNAL_COMPACTION_TRIGGER) return;
    void this.compactJournal(journal);
  }

  private async compactJournal(journal: CompactableJournal): Promise<void> {
    if (this.compactionPromise) return this.compactionPromise;
    this.compactionInFlight = true;
    const running = this.performCompaction(journal)
      .catch((error) => {
        this.markCompactionBlockedByDurability(error);
      })
      .finally(() => {
        this.compactionInFlight = false;
        this.compactionPromise = undefined;
      });
    this.compactionPromise = running;
    return running;
  }

  private async performCompaction(journal: CompactableJournal): Promise<void> {
    const coveredSequence = journal.sequence - JOURNAL_RETAINED_EVENTS;
    if (coveredSequence < journal.firstSequence) {
      this.compactionBlockedByDurability = false;
      return;
    }
    const attempt = this.beginCompactionAttempt(coveredSequence);
    const guard: JournalMutationGuard = {
      shouldAbort: () => this.compactionShouldAbort(attempt),
    };
    try {
      await this.flushDirtyTerminalOutcomesThrough(coveredSequence);
      if (this.compactionShouldAbort(attempt)) {
        this.markCompactionBlockedByDurability();
        return;
      }
      if (!await this.verifyCoveredTerminalOutcomes(journal, attempt)) {
        this.markCompactionBlockedByDurability();
        return;
      }

      // Records older than the retained window survive only in the previous
      // snapshot, so the new one is the union rather than a fresh projection.
      // Exact outcomes still remain authoritative in the sidecar store.
      const previous = await journal.loadSnapshot();
      const records = mergeDurableReceiptRecords(
        previous?.receiptRecords ?? [],
        latestDurableReceiptRecords(journal.read(previous?.coveredSequence ?? 0)),
      ).slice(-MAX_COMMAND_RECORDS);

      // The snapshot must be durable before the events it covers are dropped.
      // Exact outcomes stay in the sidecar, so new snapshots no longer duplicate
      // them.
      await journal.writeSnapshot({
        snapshot: this.snapshot(),
        coveredSequence,
        outcomes: {},
        receiptRecords: records,
      }, guard);
      if (this.compactionShouldAbort(attempt)) {
        this.markCompactionBlockedByDurability();
        return;
      }
      await journal.compact(coveredSequence, guard);
      if (this.compactionShouldAbort(attempt)) {
        this.markCompactionBlockedByDurability();
        return;
      }
      this.compactionBlockedByDurability = false;
    } finally {
      this.finishCompactionAttempt(attempt);
    }
  }

  private async ensureDurabilityReadyForFreshExecution(): Promise<boolean> {
    if (!this.compactionBlockedByDurability) return true;
    const journal = this.compactable;
    if (!journal) return false;
    await this.compactJournal(journal);
    return !this.compactionBlockedByDurability;
  }

  private markCompactionBlockedByDurability(error?: unknown): void {
    if (!this.compactionBlockedByDurability) {
      if (error === undefined) {
        console.error('[control-runtime] deferred compaction until durable outcomes are repaired');
      } else {
        console.error('[control-runtime] deferred compaction until durable outcomes are repaired', error);
      }
    }
    this.compactionBlockedByDurability = true;
  }

  private queueForPane(paneId: string): PaneQueueState {
    return this.queueForResource(this.resourceTargetForPane(paneId));
  }

  private queueForResource(target: LeaseTarget): PaneQueueState {
    const key = resourceKey(target);
    let queue = this.resourceQueues.get(key);
    if (!queue) {
      queue = {
        target: Object.freeze({ ...target }), items: new Set<QueuedCommand>(), pendingEffects: 0,
        quarantined: false, tail: Promise.resolve(),
      };
      this.resourceQueues.set(key, queue);
    }
    return queue;
  }

  private pruneInactiveResourceQueues(): void {
    for (const [key, queue] of this.resourceQueues) {
      if (!queue.quarantined || queue.items.size > 0 || queue.pendingEffects > 0 || queue.blocker !== undefined) {
        continue;
      }
      if (queue.target.kind === 'project') continue;
      const current = this.surfaces.get(queue.target.id);
      if (!current || current.kind !== queue.target.kind || current.generation !== queue.target.generation) {
        this.resourceQueues.delete(key);
      }
    }
    this.pruneRetiredPaneBarriers();
  }

  /**
   * Drop the takeover barrier of a pane that has no surface and no queue.
   *
   * Queued automation is compared against these generations, so a pane with
   * work still parked on it must keep its counter: resetting it would make
   * that work read as preempted. Both conditions together mean nothing is left
   * to compare, and a pane that returns starts from 0 exactly as a pane the
   * runtime has never seen does.
   */
  private pruneRetiredPaneBarriers(): void {
    if (this.paneBarrierGenerations.size === 0) return;
    // Queues are keyed by surface generation, and a retired pane reports
    // generation 0, so a queue must be matched on pane id rather than by
    // rebuilding its key.
    const queuedPaneIds = new Set<string>();
    for (const queue of this.resourceQueues.values()) {
      if (queue.target.kind === 'pane') queuedPaneIds.add(queue.target.id);
    }
    for (const paneId of [...this.paneBarrierGenerations.keys()]) {
      if (this.surfaces.get(paneId)) continue;
      if (queuedPaneIds.has(paneId)) continue;
      this.paneBarrierGenerations.delete(paneId);
    }
  }

  private pruneResourceQueue(key: string, queue: PaneQueueState, tail: Promise<void>): void {
    if (
      this.resourceQueues.get(key) === queue
      && queue.tail === tail
      && queue.items.size === 0
      && queue.pendingEffects === 0
      && !queue.quarantined
      && queue.blocker === undefined
    ) {
      this.resourceQueues.delete(key);
    }
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

async function withTimeout<T>(effect: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error('surface effect timed out'), {
        ambiguous: true,
        code: 'effect_timeout',
      }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([effect, expired]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function stableSurfaceEffectCode(error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  return STABLE_SURFACE_EFFECT_CODES.has(code) ? code : 'effect_failed';
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

function targetForSurfaceOwnership(command: SurfaceActionContext['command']): LeaseTarget | undefined {
  switch (command.kind) {
    case 'pane.observe':
      return { kind: 'pane', id: command.payload.paneId, generation: command.payload.generation };
    case 'pane.action':
      if (command.payload.action.kind === 'create') {
        return { kind: 'project', id: command.projectRoot };
      }
      if (!command.payload.paneId || command.payload.generation === undefined) return undefined;
      return {
        kind: 'pane',
        id: command.payload.paneId,
        generation: command.payload.generation,
      };
    case 'browser.inspect':
    case 'browser.action':
    case 'browser.script':
      return { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
  }
}

function capabilityForSurfaceCommand(command: SurfaceActionContext['command']): SurfaceCapability | undefined {
  switch (command.kind) {
    case 'pane.observe':
      return 'pane.observe';
    case 'pane.action': {
      const kind = command.payload.action?.kind;
      switch (kind) {
        case 'send_text':
        case 'send_keys':
          return 'pane.input';
        case 'interrupt':
          return 'pane.interrupt';
        case 'focus':
          return 'pane.focus';
        case 'resize':
          return 'pane.resize';
        case 'create':
          return 'pane.create';
        case 'close':
          return 'pane.close';
        default:
          return undefined;
      }
    }
    case 'browser.inspect':
      return command.payload.includeScreenshot ? 'browser.screenshot' : 'browser.inspect';
    case 'browser.action': {
      const action = command.payload.action as { kind?: unknown } | undefined;
      switch (action?.kind) {
        case 'click':
        case 'type':
        case 'select':
        case 'submit':
        case 'upload':
        case 'download':
        case 'scroll':
        case 'focus':
        case 'permission_response':
          return 'browser.interact';
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
          return undefined;
      }
    }
    case 'browser.script':
      return 'browser.script';
  }
}

function trustedOwnershipForCommand(command: SurfaceActionContext['command']): TrustedActionOwnership {
  return {
    taskId: command.payload.taskId,
    actorId: command.actor.id,
    leaseId: command.payload.leaseId,
    leaseRevision: command.payload.leaseRevision,
  };
}

function taskSubjectCredentialReference(
  taskId: string,
  actorId: string,
): ControlTaskCredentialReference | undefined {
  const prefix = 'task-subject:';
  if (!actorId.startsWith(prefix)) return undefined;
  const subjectId = actorId.slice(prefix.length).trim();
  if (!subjectId) return undefined;
  return {
    taskBinding: { taskId, subjectId },
    principalId: actorId,
  };
}

function taskSubjectId(taskId: string, actorId: string): string | undefined {
  return taskSubjectCredentialReference(taskId, actorId)?.taskBinding.subjectId;
}

function isLiveApproval(approval: Approval): boolean {
  return approval.status === 'pending' || approval.status === 'approved';
}

function approvalMatchesTaskSubject(
  approval: Approval,
  taskId: string,
  actorId: string,
  subjectId?: string,
): boolean {
  return approval.taskId === taskId
    && (approval.actorId === actorId || (subjectId !== undefined && approval.subjectId === subjectId));
}

function approvalLeaseCurrent(
  approval: Approval,
  lease: CapabilityLease | undefined,
): boolean {
  return lease !== undefined
    && lease.ownerEpoch === approval.ownerEpoch
    && lease.revision === approval.leaseRevision
    && (typeof approval.actorId !== 'string' || lease.actorId === approval.actorId)
    && (typeof approval.taskId !== 'string' || lease.taskId === approval.taskId);
}

function leaseTargetsEqual(left: LeaseTarget, right: LeaseTarget): boolean {
  return left.kind === right.kind
    && left.id === right.id
    && (left.kind === 'project' || right.kind === 'project' || left.generation === right.generation);
}

function isApprovalInvalidationError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'approval_denied'
    || code === 'approval_expired'
    || code === 'approval_missing'
    || code === 'approval_identity_mismatch';
}

function errorCodeIs(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === code);
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
        kind: 'permission_response',
        target: `${action.decision} ${action.permission} for ${action.origin}`,
      });
    case 'close':
      return createRedactedApprovalEffect({ kind: 'close', target: 'browser tab' });
    default:
      return undefined;
  }
}

function executableBrowserPayload(
  payload: Extract<ControlCommand, { kind: 'browser.action' }>['payload'],
): Extract<ControlCommand, { kind: 'browser.action' }>['payload'] {
  const { semantic: _untrustedSemantic, ...action } = payload.action as (
    typeof payload.action & { semantic?: unknown }
  );
  return { ...payload, action } as Extract<ControlCommand, { kind: 'browser.action' }>['payload'];
}

function digestExecutablePayload(
  command: SurfaceActionContext['command'],
  canonicalSemantic?: CanonicalElementSemantics,
): string {
  let payload: unknown = command.payload;
  if (command.kind === 'browser.action') {
    const { semantic: _clientSemantic, ...action } = command.payload.action as (
      typeof command.payload.action & { semantic?: unknown }
    );
    payload = {
      ...command.payload,
      action: {
        ...action,
        ...(canonicalSemantic ? { semantic: canonicalSemantic } : {}),
      },
    };
  }
  return createHash('sha256').update(stableRuntimeJson(payload), 'utf8').digest('hex');
}

function stableRuntimeJson(value: unknown): string {
  return JSON.stringify(sortRuntimeKeys(value));
}

function sortRuntimeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRuntimeKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        sortRuntimeKeys((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
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
    && left.executablePayloadDigest === right.executablePayloadDigest
    && JSON.stringify(left.effect) === JSON.stringify(right.effect);
}

function redactedPayloadForOutcome(
  outcome: CommandOutcome,
  explicitReceipt?: ActionReceipt,
): Record<string, unknown> {
  const outcomeDigest = exactCommandOutcomeDigest(outcome);
  const receipt = explicitReceipt
    ?? (outcome.status === 'succeeded' && 'value' in outcome && isActionReceipt(outcome.value)
      ? outcome.value
      : undefined);
  if (receipt) return { status: outcome.status, outcomeDigest, receipt: redactReceipt(receipt) };
  return {
    status: outcome.status,
    outcomeDigest,
    ...(outcome.status === 'succeeded' ? {} : { code: 'surface_command_failed' }),
  };
}

function redactReceipt<T extends ActionStatusReceipt>(receipt: T): T {
  const { value: _sensitiveValue, message: _sensitiveMessage, ...safeReceipt } = receipt as T & {
    value?: unknown;
    message?: string;
  };
  return Object.freeze(safeReceipt) as T;
}

function journalReceiptMetadata(receipt: ActionReceipt): AgentControlJournalReceipt {
  return Object.freeze({
    schema: receipt.schema,
    actionId: receipt.actionId,
    state: receipt.state,
    resource: createAgentControlJournalResource(receipt.resource),
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

function terminalKindForOutcome(outcome: CommandOutcome):
  'command.succeeded' | 'command.failed' | 'command.unknown' | 'command.rejected' {
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

function payloadForOutcome(outcome: CommandOutcome, outcomeDigest = exactCommandOutcomeDigest(outcome)): Record<string, unknown> {
  if (outcome.status === 'succeeded') {
    return 'value' in outcome
      ? { status: outcome.status, outcomeDigest, value: outcome.value }
      : { status: outcome.status, outcomeDigest };
  }
  return { status: outcome.status, outcomeDigest, code: outcome.code, message: outcome.message };
}

function verifyExactOutcomeAgainstTerminalEvent(
  outcome: CommandOutcome,
  event: RuntimeEvent,
  commandKind?: ControlCommand['kind'] | string,
  attestedDigest?: string,
): { ok: true } | { ok: false; error: Error } {
  const expected = terminalOutcomeDigestForVerification(event, commandKind, attestedDigest);
  if (!expected.ok) return expected;
  return exactCommandOutcomeDigest(outcome) === expected.digest
    ? { ok: true }
    : { ok: false, error: retainedOutcomeDigestMismatchError() };
}

function outcomeFromEvent(event: RuntimeEvent): CommandOutcome {
  const receipt = durableJournalReceiptPayload(event);
  switch (event.kind) {
    case 'command.succeeded':
      return receipt
        ? { status: 'succeeded' }
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

function reconstructRetainedOutcome(
  event: RuntimeEvent,
  commandKind?: ControlCommand['kind'] | string,
): CommandOutcome | undefined {
  if (isRecoveredNonterminalRetainedOutcome(event)) return outcomeFromEvent(event);
  if (!isRetainedNonSurfaceCommandKind(commandKind) || durableJournalReceiptPayload(event)) return undefined;
  return outcomeFromEvent(event);
}

function missingRetainedOutcomeSidecarError(): Error {
  return new Error('durable outcome sidecar is required for retained surface or unknown terminal events');
}

function terminalOutcomeDigestForVerification(
  event: RuntimeEvent,
  commandKind?: ControlCommand['kind'] | string,
  attestedDigest?: string,
): { ok: true; digest: string } | { ok: false; error: Error } {
  const digest = event.payload.outcomeDigest;
  if (digest !== undefined) {
    return typeof digest === 'string' && isSha256Digest(digest)
      ? { ok: true, digest }
      : { ok: false, error: invalidRetainedOutcomeDigestError() };
  }
  if (attestedDigest !== undefined) {
    return isSha256Digest(attestedDigest)
      ? { ok: true, digest: attestedDigest }
      : { ok: false, error: invalidRetainedOutcomeDigestError() };
  }
  const reconstructed = reconstructRetainedOutcome(event, commandKind);
  if (!reconstructed) {
    return { ok: false, error: missingRetainedOutcomeDigestError() };
  }
  return { ok: true, digest: exactCommandOutcomeDigest(reconstructed) };
}

function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function missingRetainedOutcomeDigestError(): Error {
  return new Error('retained surface or unknown terminal events require an exact outcome digest');
}

function invalidRetainedOutcomeDigestError(): Error {
  return new Error('retained terminal outcome digest is invalid');
}

function retainedOutcomeDigestMismatchError(): Error {
  return new Error('durable outcome sidecar does not match retained terminal event');
}

function isRecoveredNonterminalRetainedOutcome(event: RuntimeEvent): boolean {
  return event.kind === 'command.unknown'
    && stringPayload(event, 'reason') === 'recovered-nonterminal'
    && typeof event.payload.outcomeDigest === 'string'
    && isSha256Digest(event.payload.outcomeDigest)
    && durableJournalReceiptPayload(event) === undefined;
}

function missingLegacySnapshotOutcomeSidecarError(): Error {
  return new Error('durable outcome sidecar is required for compacted snapshot outcomes');
}

// DurableReceiptRecord now lives in journal.ts: it is the durable shape the
// snapshot file persists, not just an in-flight projection of journal events.

function durableJournalReceiptPayload(event: RuntimeEvent): JournalActionReceipt | undefined {
  const receipt = event.payload.receipt;
  if (!isJournalActionReceipt(receipt)) return undefined;
  const candidate = receipt;
  const resource = candidate.resource;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return undefined;
  if (Object.prototype.hasOwnProperty.call(candidate, 'value')
    || Object.prototype.hasOwnProperty.call(candidate, 'message')) {
    return undefined;
  }
  return Object.freeze({
    ...candidate,
    resource: Object.freeze({ ...resource }),
  });
}

function stringPayload(event: RuntimeEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function retainedCommandKinds(events: readonly RuntimeEvent[]): Map<string, ControlCommand['kind'] | string> {
  const kinds = new Map<string, ControlCommand['kind'] | string>();
  for (const event of events) {
    if (event.kind !== 'command.requested') continue;
    const commandId = stringPayload(event, 'commandId');
    const idempotencyKey = stringPayload(event, 'idempotencyKey');
    const kind = stringPayload(event, 'kind');
    if (!commandId || !idempotencyKey || !kind) continue;
    kinds.set(commandTransactionKey(commandId, idempotencyKey), kind);
  }
  return kinds;
}

function retainedOutcomeAttestations(events: readonly RuntimeEvent[]): Map<string, string> {
  const attestations = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== COMMAND_OUTCOME_ATTESTED_KIND) continue;
    const transactionKey = transactionKeyForTerminalEvent(event);
    const digest = event.payload.outcomeDigest;
    if (!transactionKey || typeof digest !== 'string' || !isSha256Digest(digest)) continue;
    attestations.set(transactionKey, digest);
  }
  return attestations;
}

function transactionKeyForTerminalEvent(event: RuntimeEvent): string | undefined {
  const commandId = stringPayload(event, 'commandId');
  const idempotencyKey = stringPayload(event, 'idempotencyKey');
  return commandId && idempotencyKey ? commandTransactionKey(commandId, idempotencyKey) : undefined;
}

function legacyRetainedOutcomeNeedsAttestation(
  event: RuntimeEvent,
  commandKind?: ControlCommand['kind'] | string,
  attestedDigest?: string,
): boolean {
  return event.payload.outcomeDigest === undefined
    && attestedDigest === undefined
    && reconstructRetainedOutcome(event, commandKind) === undefined;
}

function latestTerminalEvents(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const latest = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
    const idempotencyKey = stringPayload(event, 'idempotencyKey');
    if (!idempotencyKey) continue;
    latest.set(idempotencyKey, event);
  }
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

function retainedCommandKind(
  events: readonly RuntimeEvent[],
  terminalEvent: RuntimeEvent,
): ControlCommand['kind'] | string | undefined {
  const commandId = stringPayload(terminalEvent, 'commandId');
  const idempotencyKey = stringPayload(terminalEvent, 'idempotencyKey');
  if (!commandId || !idempotencyKey) return undefined;
  return retainedCommandKinds(events).get(commandTransactionKey(commandId, idempotencyKey));
}

function isRetainedNonSurfaceCommandKind(kind?: ControlCommand['kind'] | string): kind is ControlCommand['kind'] {
  switch (kind) {
    case 'orchestration.execute':
    case 'pane.spawn':
    case 'pane.prompt':
    case 'pane.interrupt':
    case 'pane.delegate':
    case 'pane.takeover':
    case 'pane.input':
    case 'pane.terminal.open':
    case 'pane.resize':
    case 'pane.focus':
    case 'pane.kill':
    case 'pane.respawn':
    case 'pane.conflict.open':
    case 'pane.option.update':
    case 'pane.meta.update':
    case 'ritual.launch':
    case 'coven.session.launch':
    case 'coven.session.open':
    case 'coven.desktop.action':
    case 'coven.capability.execute':
      return true;
    default:
      return false;
  }
}

function isReceiptResult(value: unknown): value is { receiptId?: string } {
  return typeof value === 'object' && value !== null &&
    (!('receiptId' in value) || typeof (value as { receiptId?: unknown }).receiptId === 'string');
}

function latestDurableReceiptRecords(events: readonly RuntimeEvent[]): DurableReceiptRecord[] {
  const latest = new Map<string, DurableReceiptRecord>();
  for (const event of events) {
    if (!TERMINAL_EVENT_KINDS.has(event.kind)) continue;
    const receipt = durableJournalReceiptPayload(event);
    const commandId = stringPayload(event, 'commandId');
    const idempotencyKey = stringPayload(event, 'idempotencyKey');
    if (!receipt || !commandId || !idempotencyKey) continue;
    latest.set(receipt.actionId, {
      sequence: event.sequence,
      commandId,
      idempotencyKey,
      receipt,
    });
  }
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

/**
 * Latest-wins union of the receipts a snapshot preserved and those still in
 * the journal tail. The tail is newer by construction, so it overwrites.
 */
function mergeDurableReceiptRecords(
  restored: readonly DurableReceiptRecord[],
  replayed: readonly DurableReceiptRecord[],
): DurableReceiptRecord[] {
  const latest = new Map<string, DurableReceiptRecord>();
  for (const record of restored) latest.set(record.receipt.actionId, record);
  for (const record of replayed) latest.set(record.receipt.actionId, record);
  return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
}

function restartInvalidatedPayload(record: DurableReceiptRecord): Record<string, unknown> {
  const outcomeDigest = exactCommandOutcomeDigest(restartInvalidatedOutcome());
  return {
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    status: 'failed',
    outcomeDigest,
    receipt: {
      schema: record.receipt.schema,
      actionId: record.receipt.actionId,
      state: 'failed',
      resource: {
        kind: record.receipt.resource.kind,
        idDigest: record.receipt.resource.idDigest,
        ...(record.receipt.resource.kind === 'project'
          ? {}
          : { generation: record.receipt.resource.generation }),
      },
      createdAt: record.receipt.createdAt,
      ...(record.receipt.taskId ? { taskId: record.receipt.taskId } : {}),
      ...(record.receipt.actorId ? { actorId: record.receipt.actorId } : {}),
      ...(record.receipt.leaseId ? { leaseId: record.receipt.leaseId } : {}),
      ...(record.receipt.leaseRevision !== undefined
        ? { leaseRevision: record.receipt.leaseRevision }
        : {}),
      completedAt: new Date().toISOString(),
      code: 'action_invalidated',
    },
  };
}

function restartInvalidatedOutcome(): CommandOutcome {
  return {
    status: 'failed',
    code: 'action_invalidated',
    message: 'surface effect failed',
  };
}
