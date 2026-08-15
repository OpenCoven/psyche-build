import { createHash } from 'node:crypto';
import path from 'node:path';
import { LaneLeaseStore } from './leases.js';
import { PromptDispatcher } from './promptDispatch.js';
__OURS__
  CommandOutcome,
  CommandRecord,
  ControlCommand,
  ControlSnapshot,
  JournalActionReceipt,
  LeaseGrant,
  PromptEnvelope,
  LeaseRequestState,
  PaneObservationResult,
  PaneActionPostcondition,
  BrowserActionDurableSummary,
  BrowserScriptDurableSummary,
  BrowserScriptResult,
  RecentReceiptSummary,
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
__OURS__
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
__OURS__
  readonly items: Set<QueuedCommand>;
  pendingEffects: number;
  quarantined: boolean;
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
  readonly queueKey: string;
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
  readonly browserBinding?: CanonicalBrowserElementBinding;
  readonly scriptContext?: CanonicalBrowserScriptContext;
  readonly approvalPayload: unknown;
  readonly effect: RedactedApprovalEffect;
}

interface AgentSurfaceHandlerResult {
  readonly receipt: ActionReceipt;
  readonly livePaneObservation?: PaneObservationResult;
  readonly liveBrowserScript?: BrowserScriptResult;
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
__OURS__

  private constructor(
    private readonly ownerEpoch: number,
    private readonly handlers: ControlHandlers,
    private readonly journal: RuntimeJournal,
__OURS__
    this.promptDispatcher = new PromptDispatcher(async (envelope) => {
      const result = await this.handlers.sendPrompt(envelope);
      if (isReceiptResult(result)) return result;
      return undefined;
    });
  }

  static async create(opts: ControlRuntimeOptions): Promise<ControlRuntime> {
    await opts.journal.recoverNonterminalCommands();
__OURS__
    return runtime;
  }

  private readonly resolveBrowserElementSemantics?: ControlRuntimeOptions['resolveBrowserElementSemantics'];

  submit(command: ControlCommand): Promise<CommandOutcome> {
__OURS__
    if (prior) return Promise.resolve(prior);

    const pending = this.pendingByIdempotencyKey.get(immutable.idempotencyKey);
    if (pending) return pending;

__OURS__
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

  /** Provider lifecycle seam: revoke leases and approvals for one exact generation. */
  revokeSurfaceAuthority(target: LeaseTarget): void {
    this.revokeTargetAuthority(target);
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
    const approvals = this.approvals.snapshot();
    this.reconcilePendingApprovalState(approvals);
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
__OURS__
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
__OURS__
    };
  }

  private submitFresh(command: ControlCommand): Promise<CommandOutcome> {
__OURS__

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
__OURS__
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
        const approvalPayload = approvalPayloadFor(command, prepared.scriptContext);
        const approval = this.approvals.request({
          actionId: command.id,
          ownerEpoch: command.ownerEpoch,
          leaseId: command.payload.leaseId,
          leaseRevision: command.payload.leaseRevision,
          resource: prepared.target,
          capability: prepared.classification.capability,
          effect,
          actionPayload: approvalPayload,
        });
        this.pendingApprovals.set(approval.id, { approval, command, classification: prepared.classification,
          ...(prepared.browserBinding ? { browserBinding: freezeBrowserBinding(prepared.browserBinding) } : {}), effect,
          approvalPayload,
          ...(prepared.scriptContext ? { scriptContext: Object.freeze({ ...prepared.scriptContext }) } : {}) });
        const receipt = this.recordReceipt(command, prepared.target, 'approval_required', 'approval_required');
        return this.appendTerminal(command, succeededOutcome(receipt));
      }
      return this.enqueueAgentSurfaceEffect(command, prepared.target, async () => {
        const current = await this.prepareAgentSurfaceEffect(command);
        assertPreparedIdentity(prepared, current);
        return this.invokeAgentSurfaceHandler(command, prepared.target, prepared.browserBinding);
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
  ): Promise<{ target: LeaseTarget; classification: PolicyClassification; browserBinding?: CanonicalBrowserElementBinding;
    scriptContext?: CanonicalBrowserScriptContext }> {
    this.assertCurrentOwner(command.ownerEpoch);
    let target: LeaseTarget;
    let classification: PolicyClassification;
    let browserBinding: CanonicalBrowserElementBinding | undefined;
    let scriptContext: CanonicalBrowserScriptContext | undefined;
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
          browserBinding = await this.resolveBrowserSnapshot(command.payload);
          assertBrowserBinding(command.payload, browserBinding);
          if (browserBinding?.actionKind === 'click') {
            risk = this.browserPolicy.resolveFromCanonicalSnapshot({ actionKind: 'click', submit: browserBinding.submit === true });
          } else if (browserBinding?.actionKind === 'type') {
            risk = this.browserPolicy.resolveFromCanonicalSnapshot({ actionKind: 'type', secret: browserBinding.secret === true });
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
        if (Buffer.byteLength(command.payload.source, 'utf8') > AGENT_CONTROL_LIMITS.scriptSourceBytes) {
          throw codedError('script_source_too_large', 'browser script source exceeds the control limit');
        }
        this.requireResource(command.payload.tabId, command.payload.generation, 'browser_tab');
        target = { kind: 'browser_tab', id: command.payload.tabId, generation: command.payload.generation };
        classification = classifyBrowserScript();
        this.assertCapabilityLease(command, target, classification.capability);
        scriptContext = validateBrowserScriptContext(
          command.payload,
          await this.resolveBrowserScriptContext({ tabId: command.payload.tabId, generation: command.payload.generation }),
        );
        break;
    }
    this.assertCapabilityLease(command, target, classification.capability);
    this.captureReceiptScope(command, target);
    return { target, classification, ...(browserBinding ? { browserBinding } : {}),
      ...(scriptContext ? { scriptContext } : {}) };
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
    run: () => Promise<AgentSurfaceHandlerResult>,
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
        let livePaneObservation: PaneObservationResult | undefined;
        try {
          const result = await run();
          outcome = succeededOutcome(result.receipt);
          livePaneObservation = result.livePaneObservation;
        } catch (error) {
          outcome = safeSurfaceFailure(error);
          this.recordReceipt(
            command, target, outcome.status === 'unknown' ? 'unknown' : 'failed',
            outcome.status === 'succeeded' ? undefined : outcome.code,
            browserScriptSummaryFromError(error),
          );
        }
        const durableOutcome = await this.appendTerminal(command, outcome);
        resolve(
          livePaneObservation && durableOutcome.status === 'succeeded'
            ? succeededOutcome(livePaneObservation)
            : durableOutcome,
        );
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
    browserBinding?: CanonicalBrowserElementBinding,
    scriptContext?: CanonicalBrowserScriptContext,
  ): Promise<AgentSurfaceHandlerResult> {
    try {
      let livePaneObservation: PaneObservationResult | undefined;
      let liveBrowserScript: BrowserScriptResult | undefined;
      let postcondition: PaneActionPostcondition | BrowserActionPostcondition | undefined;
      let scriptSummary: BrowserScriptDurableSummary | undefined;
      switch (command.kind) {
        case 'pane.observe': {
          const result = await requireHandler(this.handlers.observePane, command.kind)(command.payload);
          livePaneObservation = normalizePaneObservation(command.payload.paneId, result);
          break;
        }
        case 'pane.action': {
          const result = await requireHandler(this.handlers.actOnPane, command.kind)(command.payload);
          postcondition = normalizePaneActionPostcondition(command, result);
          break;
        }
        case 'browser.inspect':
          await requireHandler(this.handlers.inspectBrowser, command.kind)(command.payload, command.id);
          break;
        case 'browser.action':
          {
            const value = await requireHandler(this.handlers.actOnBrowser, command.kind)(
              command.payload, command.id, browserBinding,
            );
            try {
              postcondition = normalizeBrowserActionPostcondition(command.payload.action.kind, value);
            } catch {
              throw codedError('effect_unknown', 'browser effect returned invalid evidence', true);
            }
          }
          break;
        case 'browser.script': {
          if (!scriptContext) throw codedError('approval_identity_mismatch', 'browser script context is missing');
          try {
            const result = await requireHandler(this.handlers.runBrowserScript, command.kind)(
              command.payload, command.id, scriptContext,
            );
            liveBrowserScript = normalizeBrowserScriptResult(result);
            scriptSummary = browserScriptDurableSummary(
              command, 'succeeded', liveBrowserScript.durationMs, liveBrowserScript.byteCount,
            );
          } catch (error) {
            const failure = safeSurfaceFailure(error);
            throw browserScriptSummaryError(error, browserScriptDurableSummary(
              command,
              failure.status === 'unknown' ? 'unknown' : 'failed',
              browserScriptDurationFromError(error),
              0,
            ));
          }
          break;
        }
      }
      return {
        receipt: this.recordReceipt(command, target, 'succeeded', undefined, scriptSummary ?? postcondition),
        ...(livePaneObservation ? { livePaneObservation } : {}),
        ...(liveBrowserScript ? { liveBrowserScript } : {}),
      };
    } catch (error) {
      if (errorCode(error) === 'action_timeout') throw error;
      if (isAmbiguous(error)) {
        const unknown = codedError('effect_unknown', 'surface effect outcome is unknown', true);
        const summary = browserScriptSummaryFromError(error);
        throw summary ? browserScriptSummaryError(unknown, summary) : unknown;
      }
      throw error;
    }
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
            this.rememberReceipt(receipt);
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
      this.rememberReceipt(receipt);
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
      this.rememberReceipt(receipt);
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
      this.rememberReceipt(receipt);
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
        this.rememberReceipt(receipt);
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
        this.rememberReceipt(receipt);
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
      this.rememberReceipt(receipt);
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
__OURS__
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
__OURS__
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
    this.reconcilePendingApprovalState(this.approvals.snapshot());
    return succeededOutcome(undefined);
  }

  private revokeCapabilityLease(
    command: Extract<ControlCommand, { kind: 'lease.revoke' }>,
  ): CommandOutcome {
    if (command.actor.kind !== 'human') return operatorRejected('only an operator may revoke capability leases');
    const revoked = this.capabilityLeases.revoke(command.payload.leaseId);
    this.approvals.revokeForLease(command.payload.leaseId);
    this.reconcilePendingApprovalState(this.approvals.snapshot());
    return succeededOutcome({ revoked: Boolean(revoked) });
  }

  private async resolveApproval(
    command: Extract<ControlCommand, { kind: 'approval.resolve' }>,
  ): Promise<CommandOutcome> {
    if (command.actor.kind !== 'human') return operatorRejected('only an operator may resolve approvals');
    this.reconcilePendingApprovalState(this.approvals.snapshot());
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
        !sameClassification(current.classification, pending.classification)
        || !sameBrowserBinding(current.browserBinding, pending.browserBinding)
        || !sameBrowserScriptContext(current.scriptContext, pending.scriptContext)
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
        actionPayload: pending.approvalPayload,
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
          !sameClassification(revalidated.classification, pending.classification)
          || !sameBrowserBinding(revalidated.browserBinding, pending.browserBinding)
          || !sameBrowserScriptContext(revalidated.scriptContext, pending.scriptContext)
        ) throw codedError('approval_identity_mismatch', 'trusted action risk changed before approved effect');
        const { receipt, liveBrowserScript } = await this.invokeAgentSurfaceHandler(
          pending.command, current.target, pending.browserBinding, pending.scriptContext,
        );
        const outcome = outcomeForReceipt(receipt);
        const durable = await this.appendTerminal(pending.command, outcome);
        resolve(liveBrowserScript && durable.status === 'succeeded'
          ? succeededOutcome(liveBrowserScript)
          : durable);
      }).catch(async (error: unknown) => {
        const outcome = safeSurfaceFailure(error);
        this.recordReceipt(
          pending.command,
          current.target,
          outcome.status === 'unknown' ? 'unknown' : 'failed',
          outcome.status === 'succeeded' ? undefined : outcome.code,
          browserScriptSummaryFromError(error),
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
    this.reconcilePendingApprovalState(this.approvals.snapshot());
  }

  private reconcilePendingApprovalState(approvals: readonly Approval[]): void {
    const byId = new Map(approvals.map((approval) => [approval.id, approval]));
    for (const [approvalId, pending] of this.pendingApprovals) {
      const approval = byId.get(approvalId);
      if (approval && (approval.status === 'pending' || approval.status === 'approved')) continue;
      const state: ActionReceipt['state'] = approval?.status === 'denied' || approval?.status === 'revoked'
        ? 'denied' : 'expired';
      this.recordReceipt(pending.command, pending.approval.resource, state,
        state === 'denied' ? 'approval_denied' : 'approval_expired');
      this.pendingApprovals.delete(approvalId);
      this.receiptScopes.delete(pending.command.id);
    }
  }

  private recordReceipt(
    command: ControlCommand,
    resource: LeaseTarget,
    state: ActionReceipt['state'],
    code?: string,
    value?: PaneActionPostcondition | BrowserActionPostcondition | BrowserScriptDurableSummary,
  ): ActionReceipt {
    const durableValue = value ?? (command.kind === 'browser.script' && (state === 'failed' || state === 'unknown')
      ? browserScriptDurableSummary(command, state, 0, 0)
      : undefined);
    const receipt: ActionReceipt = Object.freeze({
      schema: 'psyche.control.receipt/v1',
      actionId: command.id,
      state,
      resource: immutableCopy(resource),
      createdAt: command.createdAt,
      ...(state === 'approval_required' ? {} : { completedAt: new Date().toISOString() }),
      ...(code ? { code } : {}),
      ...(durableValue ? { value: durableValue } : {}),
    });
    const previous = this.receipts.findIndex(({ actionId }) => actionId === command.id);
    if (previous >= 0) this.receipts.splice(previous, 1);
    this.receipts.push(receipt);
    this.actionStatuses.set(command.id, receipt);
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
    this.recordRecentReceipt(command, receipt);
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
    this.recordRecentReceipt(command, receipt);
  }

  private captureReceiptScope(command: ControlCommand, resource: LeaseTarget): void {
    if (command.ownerEpoch !== this.ownerEpoch) return;
    let projectRoot: string;
    let worktreeRoot: string;
    if (resource.kind === 'project') {
      if (resource.id !== command.projectRoot) return;
      projectRoot = command.projectRoot;
      worktreeRoot = command.projectRoot;
    } else {
      const surface = this.surfaces.get(resource.id);
      if (!surface || surface.kind !== resource.kind || surface.generation !== resource.generation
          || surface.projectRoot !== command.projectRoot) return;
      projectRoot = surface.projectRoot;
      worktreeRoot = surface.worktreeRoot;
    }
    if (projectRoot.length === 0 || projectRoot.length > 4096 || worktreeRoot.length === 0 || worktreeRoot.length > 4096) return;
    this.receiptScopes.set(command.id, Object.freeze({
      projectRoot, worktreeRoot, resource: immutableCopy(resource),
    }));
  }

  private recordRecentReceipt(command: ControlCommand, receipt: ActionReceipt): void {
    const terminal = !['queued', 'running', 'approval_required'].includes(receipt.state);
    if (!this.receiptScopes.has(command.id)) this.captureReceiptScope(command, receipt.resource);
    const scope = this.receiptScopes.get(command.id);
    if (!scope || command.id.length === 0 || command.id.length > 512 || command.actor.id.length > 512) {
      if (terminal) this.receiptScopes.delete(command.id);
      return;
    }
    const payload = command.payload as { taskId?: unknown };
    const taskId = typeof payload.taskId === 'string' && payload.taskId.length <= 512 ? payload.taskId : '';
    const summary: RecentReceiptSummary = Object.freeze({
      commandId: command.id,
      actionKind: command.kind,
      outcome: receipt.state,
      timestamp: receipt.completedAt ?? receipt.createdAt,
      agentId: command.actor.kind === 'psyche' ? command.actor.id : '',
      taskId,
      projectRoot: scope.projectRoot,
      worktreeRoot: scope.worktreeRoot,
      resource: immutableCopy(scope.resource),
      redacted: true,
      result: 'result_unavailable',
    });
    const previous = this.recentReceipts.findIndex(({ commandId }) => commandId === command.id);
    if (previous >= 0) this.recentReceipts.splice(previous, 1);
    this.recentReceipts.push(summary);
    while (this.recentReceipts.length > MAX_RECEIPTS) this.recentReceipts.shift();
    if (terminal) this.receiptScopes.delete(command.id);
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
        code: 'effect_unknown',
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
        status: 'unknown', code: 'effect_unknown', message: 'command outcome is unknown', receipt,
      });
      const outcome: CommandOutcome = {
        status: 'unknown', code: 'effect_unknown', message: 'command outcome is unknown',
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
    const receipt = this.receipts.get(actionId);
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

  private async recoverRestartedApprovalReceipts(): Promise<void> {
    for (const record of latestDurableReceiptRecords(this.journal.read(0))) {
      if (record.receipt.state !== 'approval_required') continue;
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

  private rememberReceipt(receipt: ActionStatusReceipt): void {
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
    ownership?: TrustedReceiptOwnership,
  ): Promise<CommandOutcome> {
    const receipt = this.makeReceipt(command, target, 'failed', { code }, ownership);
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
      intentDigest: commandFingerprint(command),
    });
__OURS__
    const record = this.commandRecords.get(command.id);
    if (record) {
      record.outcome = canonicalOutcome;
      record.sequence = event.sequence;
__OURS__
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
      } else {
        const orphanCandidate = approvalRequiredReceiptForReconciliation(event);
        if (orphanCandidate) {
          this.receipts.push(orphanCandidate);
          this.actionStatuses.set(orphanCandidate.actionId, orphanCandidate);
        }
      }
    }
    while (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
    this.compactTerminalIndexes();
  }

__OURS__
    }
    return queue;
  }

__OURS__
  }

  private bumpPaneBarrier(paneId: string): void {
    this.paneBarrierGenerations.set(paneId, (this.paneBarrierGenerations.get(paneId) ?? 0) + 1);
  }

  private preemptQueuedAutomation(paneId: string): Promise<CommandOutcome>[] {
__OURS__
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
  const receipt = explicitReceipt
    ?? (outcome.status === 'succeeded' && 'value' in outcome && isActionReceipt(outcome.value)
      ? outcome.value
      : undefined);
  if (receipt) return { status: outcome.status, receipt: redactReceipt(receipt) };
  return {
    status: outcome.status,
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

function payloadForOutcome(outcome: CommandOutcome, durableReceipt?: ActionReceipt): Record<string, unknown> {
  if (outcome.status === 'succeeded') {
    return durableReceipt && 'value' in outcome && isActionReceipt(outcome.value)
      ? { status: outcome.status, receipt: durableReceipt }
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

interface DurableReceiptRecord {
  readonly sequence: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly receipt: JournalActionReceipt;
}

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
  if (!receiptMatchesTerminalEvent(event, receipt)) return undefined;
  const postcondition = resource.kind === 'pane'
    ? normalizeStoredPanePostcondition(resource.id, resource.generation, receipt.value)
    : normalizeStoredBrowserScriptSummary(receipt.value, receipt.state as ActionReceipt['state'], receipt.code)
      ?? normalizeStoredBrowserActionSummary(receipt.value);
  return Object.freeze({
    schema: 'psyche.control.receipt/v1',
    actionId: receipt.actionId,
    state: receipt.state as ActionReceipt['state'],
    resource: immutableCopy(resource),
    createdAt: receipt.createdAt,
    ...(typeof receipt.completedAt === 'string' ? { completedAt: receipt.completedAt } : {}),
    ...(typeof receipt.code === 'string' ? { code: receipt.code } : {}),
    ...(postcondition ? { value: postcondition } : {}),
  });
}

function receiptMatchesTerminalEvent(event: RuntimeEvent, receipt: Partial<ActionReceipt>): boolean {
  const commandId = stringPayload(event, 'commandId');
  const payloadActionId = stringPayload(event, 'actionId');
  if (!commandId || receipt.actionId !== commandId
      || (payloadActionId !== undefined && payloadActionId !== receipt.actionId)) return false;
  const receiptCode = typeof receipt.code === 'string' ? receipt.code : undefined;
  switch (event.kind) {
    case 'command.succeeded':
      return event.payload.status === 'succeeded'
        && !Object.prototype.hasOwnProperty.call(event.payload, 'code')
        && receipt.state === 'succeeded'
        && !Object.prototype.hasOwnProperty.call(receipt, 'code');
    case 'command.failed': {
      const eventCode = stringPayload(event, 'code');
      return event.payload.status === 'failed'
        && Boolean(eventCode && eventCode !== 'effect_unknown')
        && receipt.state === 'failed' && receiptCode === eventCode;
    }
    case 'command.unknown':
      return event.payload.status === 'unknown' && stringPayload(event, 'code') === 'effect_unknown'
        && receipt.state === 'unknown' && receiptCode === 'effect_unknown';
    case 'command.rejected': {
      const eventCode = stringPayload(event, 'code');
      return event.payload.status === 'rejected' && Boolean(eventCode)
        && receipt.state === 'denied' && receiptCode === eventCode;
    }
    default:
      return false;
  }
}

function approvalRequiredReceiptForReconciliation(event: RuntimeEvent): ActionReceipt | undefined {
  if (event.kind !== 'command.succeeded' || event.payload.status !== 'succeeded'
      || Object.prototype.hasOwnProperty.call(event.payload, 'code')) return undefined;
  const value = event.payload.receipt;
  if (!isExactPlainDataObject(value, [
    'schema', 'actionId', 'state', 'resource', 'createdAt', 'code',
  ])) return undefined;
  const receipt = value as Partial<ActionReceipt>;
  const commandId = stringPayload(event, 'commandId');
  if (!commandId || receipt.schema !== 'psyche.control.receipt/v1' || receipt.actionId !== commandId
      || receipt.state !== 'approval_required' || receipt.code !== 'approval_required'
      || Object.prototype.hasOwnProperty.call(receipt, 'value') || typeof receipt.createdAt !== 'string'
      || !receipt.resource || !isExactLeaseTarget(receipt.resource)) return undefined;
  return Object.freeze({ schema: 'psyche.control.receipt/v1', actionId: commandId,
    state: 'approval_required', resource: immutableCopy(receipt.resource), createdAt: receipt.createdAt,
    code: 'approval_required' });
}

const BROWSER_ACTION_RESULT_KINDS: ReadonlySet<BrowserSemanticAction['kind']> = new Set([
  'focus', 'type', 'select', 'scroll', 'click', 'submit', 'upload', 'download',
  'navigate', 'reload', 'back', 'forward', 'screenshot', 'close', 'permission_response',
]);

function normalizeStoredBrowserActionSummary(value: unknown): BrowserActionDurableSummary | undefined {
  if (isExactPlainDataObject(value, ['kind', 'result'])) {
    const summary = value as Record<string, unknown>;
    if (typeof summary.kind === 'string'
        && BROWSER_ACTION_RESULT_KINDS.has(summary.kind as BrowserSemanticAction['kind'])
        && summary.result === 'result_unavailable') {
      return Object.freeze({ kind: summary.kind as BrowserSemanticAction['kind'], result: 'result_unavailable' });
    }
    return undefined;
  }
  const legacy = normalizeBrowserActionPostcondition(undefined, value, false);
  return legacy ? Object.freeze({ kind: legacy.kind, result: 'result_unavailable' }) : undefined;
}

function normalizeStoredBrowserScriptSummary(
  value: unknown, receiptState: ActionReceipt['state'], receiptCode?: string,
): BrowserScriptDurableSummary | undefined {
  if (!isExactPlainDataObject(value, [
    'argsBytes', 'durationMs', 'outcome', 'resultBytes', 'sourceBytes', 'sourceDigest',
  ])) return undefined;
  const summary = value as Record<string, unknown>;
  if (typeof summary.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(summary.sourceDigest)
      || !isNonnegativeSafeInteger(summary.sourceBytes)
      || summary.sourceBytes > AGENT_CONTROL_LIMITS.scriptSourceBytes
      || !isNonnegativeSafeInteger(summary.argsBytes)
      || summary.argsBytes > AGENT_CONTROL_LIMITS.scriptArgsBytes
      || !isNonnegativeSafeInteger(summary.resultBytes)
      || summary.resultBytes > AGENT_CONTROL_LIMITS.scriptResultBytes
      || typeof summary.durationMs !== 'number' || !Number.isFinite(summary.durationMs)
      || summary.durationMs < 0 || summary.durationMs > AGENT_CONTROL_LIMITS.scriptTimeoutMs
      || !['succeeded', 'failed', 'unknown'].includes(String(summary.outcome))) return undefined;
  if (summary.outcome !== receiptState
      || (summary.outcome !== 'succeeded' && summary.resultBytes !== 0)
      || (receiptState === 'succeeded' && receiptCode !== undefined)
      || (receiptState === 'unknown' && receiptCode !== 'effect_unknown')
      || (receiptState === 'failed' && (typeof receiptCode !== 'string'
        || receiptCode.length === 0 || receiptCode === 'effect_unknown'))
      || (receiptCode === 'action_timeout' && (summary.outcome !== 'failed'
        || summary.durationMs !== AGENT_CONTROL_LIMITS.scriptTimeoutMs || summary.resultBytes !== 0))) return undefined;
  return Object.freeze({
    sourceDigest: summary.sourceDigest,
    sourceBytes: summary.sourceBytes,
    argsBytes: summary.argsBytes,
    resultBytes: summary.resultBytes,
    durationMs: summary.durationMs,
    outcome: summary.outcome as BrowserScriptDurableSummary['outcome'],
  });
}

function durableReceiptForJournal(receipt: ActionReceipt): ActionReceipt {
  if (receipt.resource.kind !== 'browser_tab' || !receipt.value || !('kind' in receipt.value)) return receipt;
  return Object.freeze({ ...receipt, value: Object.freeze({
    kind: receipt.value.kind, result: 'result_unavailable' as const,
  }) });
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

__OURS__
