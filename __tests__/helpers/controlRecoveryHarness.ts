import { chmod, mkdir, readFile, rm, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ApprovalStore } from '../../src/control/approvals.js';
import { CapabilityLeaseStore } from '../../src/control/capabilityLeases.js';
import { ControlJournal } from '../../src/control/journal.js';
import { createCanonicalElementSemantics } from '../../src/control/policy.js';
import {
  ControlRuntime,
  type ControlHandlers,
  type RuntimeEvent,
} from '../../src/control/runtime.js';
import type { CommandOutcome, ControlCommand } from '../../src/control/types.js';

/**
 * Disposable recovery harness for issue #199 (slice 1).
 *
 * The harness launches a real control runtime over the real file-backed
 * journal inside a throwaway project root, injects bounded failures, restarts
 * the application through the real owner-lock/epoch protocol, asserts
 * recovery invariants, and retains a bounded evidence record per scenario.
 *
 * Evidence records are redacted by construction: they carry scenario and
 * invariant identifiers plus status/code enumerations only — never command
 * payloads, resource digests, or filesystem paths.
 */

export const RECOVERY_EVIDENCE_SCHEMA = 'psyche.recovery.evidence/v1';

export type RecoveryScenarioId =
  | 'restart'
  | 'duplicate_command_retry'
  | 'corrupt_persisted_state'
  | 'old_owner_epoch'
  | 'stale_capability_lease'
  | 'unwritable_state';

export type RecoveryInjectionId =
  | 'none'
  | 'application_restart'
  | 'journal_corruption'
  | 'expired_capability_lease'
  | 'unwritable_runtime_state';

export type RecoveryInvariantName =
  | 'effect_committed_once'
  | 'identity_stable'
  | 'outcome_deterministic'
  | 'failure_explicit'
  | 'no_silent_mutation'
  | 'recovers_after_repair';

export interface RecoveryInvariantRecord {
  readonly name: RecoveryInvariantName;
  readonly held: boolean;
  readonly detail: string;
}

export interface RecoveryScenarioEvidence {
  readonly schema: typeof RECOVERY_EVIDENCE_SCHEMA;
  readonly scenario: RecoveryScenarioId;
  readonly injected: RecoveryInjectionId;
  readonly observed: string;
  readonly invariants: readonly RecoveryInvariantRecord[];
}

export interface RecoveryHarnessLaunch {
  readonly ownerEpoch: number;
  readonly runtime: ControlRuntime;
  readonly journal: ControlJournal;
}

export interface ControlRecoveryHarnessOptions {
  /** Defaults to a disposable directory under the test artifact root. */
  readonly root?: string;
  /** Fixed instant the harness clock starts from; scenarios advance it. */
  readonly now?: string;
}

const DEFAULT_NOW = '2026-08-20T12:00:00.000Z';
const DETAIL_BYTES = 160;

export function recoveryInvariant(
  name: RecoveryInvariantName,
  held: boolean,
  detail: string,
): RecoveryInvariantRecord {
  return Object.freeze({ name, held, detail: detail.slice(0, DETAIL_BYTES) });
}

export class ControlRecoveryHarness {
  readonly projectRoot: string;

  private readonly cleanupRoots: string[] = [];
  private readonly effectCounts = new Map<string, number>();
  private readonly retainedEvidence: RecoveryScenarioEvidence[] = [];
  private ownerLock: { epoch: number; release: () => Promise<void> } | undefined;
  private launchState: RecoveryHarnessLaunch | undefined;
  private nowMs: number;
  private readonly clock = (): Date => new Date(this.nowMs);

  private constructor(projectRoot: string, now: Date) {
    this.projectRoot = projectRoot;
    this.nowMs = now.getTime();
  }

  static async create(options: ControlRecoveryHarnessOptions = {}): Promise<ControlRecoveryHarness> {
    const root = options.root
      ?? path.join(process.cwd(), '.test-artifacts', `recovery-${randomUUID()}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const harness = new ControlRecoveryHarness(root, new Date(options.now ?? DEFAULT_NOW));
    harness.cleanupRoots.push(root);
    return harness;
  }

  /**
   * Launches the application the way the product does: acquire the owner
   * lock (which advances the owner epoch), open the file-backed journal, and
   * build the runtime on top of it.
   */
  async launch(): Promise<RecoveryHarnessLaunch> {
    const lock = await this.acquireOwnerLock();
    const journal = await ControlJournal.open(this.projectRoot, lock.epoch);
    const runtime = await ControlRuntime.create({
      ownerEpoch: lock.epoch,
      handlers: this.handlers(),
      journal,
      capabilityLeases: new CapabilityLeaseStore(this.clock, lock.epoch),
      approvals: new ApprovalStore(this.clock, () => `approval-${randomUUID()}`),
      resolveBrowserElementSemantics: () =>
        createCanonicalElementSemantics({ role: 'button', submit: true }),
    });
    const state = Object.freeze({ ownerEpoch: lock.epoch, runtime, journal });
    this.launchState = state;
    return state;
  }

  /**
   * Restarts the application: releases the owner lock, re-acquires it (the
   * epoch advances exactly as a real restart does), and reopens the journal.
   */
  async restart(): Promise<RecoveryHarnessLaunch> {
    await this.ownerLock?.release();
    this.ownerLock = undefined;
    this.launchState = undefined;
    return this.launch();
  }

  async submit(command: ControlCommand): Promise<CommandOutcome> {
    return this.requireLaunch().runtime.submit(command);
  }

  /** Owner epoch of the current launch; the epoch advances on every restart. */
  get ownerEpoch(): number {
    return this.requireLaunch().ownerEpoch;
  }

  /** Launches counted work: one terminal pane command with a real effect. */
  openTerminalWork(idempotencyKey: string, ownerEpoch?: number): ControlCommand {
    return {
      id: `work-${idempotencyKey}`,
      idempotencyKey,
      kind: 'pane.terminal.open',
      projectRoot: this.projectRoot,
      actor: { id: 'recovery-operator', kind: 'human' },
      ownerEpoch: ownerEpoch ?? this.requireLaunch().ownerEpoch,
      createdAt: this.clock().toISOString(),
      payload: { cwd: this.projectRoot, title: 'recovery-work' },
    } as ControlCommand;
  }

  async injectJournalCorruption(): Promise<void> {
    // A damaged line that is not a trailing partial append must fail the next
    // open explicitly; the trailing incomplete line of a crashed append is
    // legitimately truncated instead.
    await appendFile(this.journalFilePath(), '{"sequence":999999,"broke":true}\n', 'utf8');
  }

  /**
   * Makes the persisted state root unwritable. The next launch must fail
   * closed instead of degrading silently.
   */
  async injectUnwritableStateRoot(): Promise<void> {
    await chmod(this.stateRootPath(), 0o500);
  }

  async repairStatePermissions(): Promise<void> {
    await chmod(this.stateRootPath(), 0o700);
  }

  /** Advances the harness clock, e.g. past a capability lease TTL. */
  advanceClock(ms: number): void {
    this.nowMs += ms;
  }

  effectCount(effect: 'openTerminal'): number {
    return this.effectCounts.get(effect) ?? 0;
  }

  events(): RuntimeEvent[] {
    return this.requireLaunch().journal.read(0);
  }

  /** Every journaled event (requested and terminal) carrying the key. */
  eventsFor(idempotencyKey: string): RuntimeEvent[] {
    return this.events().filter((event) => event.payload.idempotencyKey === idempotencyKey);
  }

  async journalFileBytes(): Promise<number> {
    return (await readFile(this.journalFilePath())).length;
  }

  record(evidence: RecoveryScenarioEvidence): void {
    this.retainedEvidence.push(Object.freeze({
      ...evidence,
      schema: RECOVERY_EVIDENCE_SCHEMA,
      observed: evidence.observed.slice(0, DETAIL_BYTES),
      invariants: evidence.invariants.map((entry) => Object.freeze(entry)),
    }));
  }

  evidence(): readonly RecoveryScenarioEvidence[] {
    return this.retainedEvidence;
  }

  async dispose(): Promise<void> {
    await this.repairStatePermissions().catch(() => undefined);
    await this.ownerLock?.release().catch(() => undefined);
    this.ownerLock = undefined;
    this.launchState = undefined;
    await Promise.all(
      this.cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  private async acquireOwnerLock(): Promise<{ epoch: number; release: () => Promise<void> }> {
    const { acquireOwnerLock } = await import('../../src/control/ownerLock.js');
    const lock = await acquireOwnerLock(this.projectRoot);
    this.ownerLock = lock;
    return lock;
  }

  private stateRootPath(): string {
    return path.join(this.projectRoot, '.psyche');
  }

  private runtimeDirectoryPath(): string {
    return path.join(this.stateRootPath(), 'runtime');
  }

  private journalFilePath(): string {
    return path.join(this.runtimeDirectoryPath(), 'events.ndjson');
  }

  private handlers(): ControlHandlers {
    const counted = <Args, Result>(
      effect: 'openTerminal',
      impl: (payload: Args) => Promise<Result>,
    ) => async (payload: Args): Promise<Result> => {
      this.effectCounts.set(effect, (this.effectCounts.get(effect) ?? 0) + 1);
      return impl(payload);
    };
    const absent = async () => undefined;
    return {
      executeOrchestration: absent,
      spawnPane: absent,
      sendPrompt: absent,
      interruptPane: absent,
      sendInput: absent,
      openTerminal: counted('openTerminal', async () => ({ paneId: '%1' })),
      resizePane: absent,
      focusPane: absent,
      killPane: absent,
      respawnPane: absent,
      openConflictPane: absent,
      updatePaneOption: absent,
      updatePaneMeta: absent,
      launchRitual: absent,
      launchCovenSession: absent,
      openCovenSession: absent,
      runCovenDesktopAction: absent,
      executeCovenCapability: absent,
      observePane: absent,
      actOnPane: absent,
      inspectBrowser: absent,
      actOnBrowser: absent,
      runBrowserScript: absent,
    };
  }

  private requireLaunch(): RecoveryHarnessLaunch {
    if (!this.launchState) throw new Error('recovery harness is not launched; call launch() first');
    return this.launchState;
  }
}

/** Stable digest used to prove resource identity survives a restart. */
export function recoveryResourceDigest(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}
