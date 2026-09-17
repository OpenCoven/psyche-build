/**
 * Disposable recovery harness for #199.
 *
 * Each scenario builds a throwaway project workspace, injects one bounded
 * failure, drives the real production recovery path, and asserts the
 * invariants that failure must preserve. Nothing here mocks the code under
 * test: the point is to observe what actually happens to bytes on disk when a
 * failure is injected, which unit tests with mocked services cannot show.
 *
 * Every field in the emitted evidence is either a member of a closed union
 * declared in this file, a boolean, or a SHA-256 digest. The types are the
 * enforcement, not a convention: there is no field a future change could set
 * to a path, a file's contents, or a raw error message without first widening
 * a union here.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observeInterruptedCleanup, RecoveryCleanupRetentionError } from './recoveryCleanup.js';
import {
  observeReplacedTmuxIdentity,
  RecoveryTmuxUnavailableError,
} from './recoveryTmuxIdentity.js';
import { observeMidMutationCleanup } from './recoveryMidMutationCleanup.js';
import {
  observeApplicationRestart,
  RecoveryRestartUnavailableError,
} from './recoveryApplicationRestart.js';

import { CapabilityLeaseStore } from '../control/capabilityLeases.js';
import { ControlJournal, exactCommandOutcomeDigest } from '../control/journal.js';
import {
  listWorktreeRecoveryMarkers,
  writeWorktreeRecoveryMarker,
} from '../services/WorktreeRecoveryMarker.js';
import {
  PROJECT_CONFIG_SCHEMA_VERSION,
  ProjectPaneConfigError,
  UNVERSIONED_PROJECT_CONFIG_SCHEMA,
  acquireProjectPaneConfigLock,
  mutateProjectPaneConfig,
  projectConfigSnapshotDirectory,
  projectPaneConfigPath,
  readProjectPaneConfig,
  readProjectPaneConfigWithSchema,
} from '../services/ProjectPaneConfig.js';
import { createCovenClient } from '../daemon/bridge.js';
import {
  AgenticCapabilityRouter,
  CapabilityRoutingError,
  createCovenNativeCapabilityStrategy,
} from '../orchestration/capabilityRouter.js';
import { listCovenSessionsFromDaemon } from '../utils/covenSessions.js';
import { runTmuxDoctor } from '../utils/tmuxDoctor.js';
import { buildPsycheManagedTmuxConfigBlock } from '../utils/tmuxManagedConfig.js';

export type RecoveryScenarioId =
  | 'corrupt-pane-config'
  | 'stale-pane-config-lock'
  | 'unwritable-state-storage'
  | 'duplicate-command-retry'
  | 'stale-owner-epoch'
  | 'interrupted-cleanup-recovery-marker'
  | 'interrupted-cleanup-owner'
  | 'unavailable-providers'
  | 'stale-pane-identity'
  | 'interrupted-git-mutation'
  | 'upgrade-recovery'
  | 'application-restart';

export type RecoveryInjectionId =
  | 'pane-config-replaced-with-invalid-json'
  | 'pane-config-lock-held-by-dead-owner'
  | 'state-directory-made-read-only'
  | 'command-replayed-after-journal-restart'
  | 'lease-asserted-with-pre-restart-owner-epoch'
  | 'cleanup-abandoned-after-marker-publication'
  | 'cleanup-owner-killed-before-git-mutation'
  | 'capability-provider-unregistered-and-daemon-socket-absent'
  | 'tmux-server-replaced-reusing-recorded-pane-id'
  | 'cleanup-owner-killed-during-supervised-git-mutation'
  | 'pane-config-aged-across-schema-versions'
  | 'application-quit-and-relaunched';

export type RecoveryClassification =
  | 'config_corrupt'
  | 'config_newer_schema'
  | 'config_snapshot_failed'
  | 'config_unreadable'
  | 'lock_taken_over'
  | 'persistence_failed'
  | 'injection_ineffective'
  | 'outcome_reconciled'
  | 'owner_restart_fenced'
  | 'cleanup_recoverable'
  | 'provider_unavailable'
  | 'stale_identity_rejected'
  | 'tmux_unavailable'
  | 'workspace_restored'
  | 'restart_unavailable'
  | 'unexpected_success'
  | 'unexpected_error';

/** Closed set of invariant identifiers; no free-text invariant label exists. */
export type RecoveryInvariantId =
  | 'failure-classified-as-corrupt'
  | 'corrupt-bytes-preserved'
  | 'uncommitted-work-untouched'
  | 'stale-lease-taken-over'
  | 'stale-lease-released'
  | 'persisted-config-unchanged'
  | 'persisted-config-readable'
  | 'persistence-failure-surfaced'
  | 'effect-executed-exactly-once'
  | 'retry-reconciles-canonical-outcome'
  | 'reconciliation-survives-restart'
  | 'stale-epoch-assertion-rejected'
  | 'current-epoch-assertion-accepted'
  | 'worktree-retained-after-interruption'
  | 'recovery-marker-discoverable'
  | 'recovery-marker-names-the-worktree'
  | 'recovery-marker-carries-operator-instructions'
  | 'cleanup-owner-interrupted'
  | 'cleanup-project-lease-recovered'
  | 'cleanup-retry-blocked-by-marker'
  | 'worktree-branch-unchanged'
  | 'clean-worktree-control-removed'
  | 'provider-failure-classified'
  | 'available-provider-still-executes'
  | 'plain-terminal-lane-remains-usable'
  | 'first-run-reached-workspace'
  | 'normal-quit-ended-cockpit'
  | 'restart-restored-workspace'
  | 'restart-preserved-project-identity'
  | 'restart-did-not-duplicate-projects'
  | 'restart-did-not-duplicate-panes'
  | 'restart-did-not-duplicate-sessions'
  | 'restart-did-not-duplicate-worktrees'
  | 'restart-did-not-duplicate-managed-panes'
  | 'mutation-observed-in-flight'
  | 'cleanup-owner-killed-during-mutation'
  | 'worktree-state-self-consistent'
  | 'interrupted-mutation-left-no-orphan'
  | 'replaced-server-reused-pane-id'
  | 'stale-pane-identity-reported'
  | 'reused-pane-id-not-adopted'
  | 'live-pane-rebinds-to-current-identity'
  | 'rebind-clears-stale-background-windows'
  | 'newer-schema-refused'
  | 'newer-schema-config-preserved'
  | 'unversioned-config-adopted-by-named-migration'
  | 'pre-migration-snapshot-retained'
  | 'adopted-config-carries-current-schema';

/** Closed set of digest keys, so digest maps cannot carry derived names. */
export type RecoveryDigestId =
  | 'configBefore'
  | 'configInjected'
  | 'configAfter'
  | 'workAfter'
  | 'effectLog'
  | 'worktreeWorkAfter';

export interface RecoveryInvariantResult {
  readonly id: RecoveryInvariantId;
  readonly held: boolean;
}

export interface RecoveryScenarioEvidence {
  readonly schemaVersion: 1;
  readonly scenario: RecoveryScenarioId;
  readonly injection: RecoveryInjectionId;
  readonly classification: RecoveryClassification;
  readonly invariants: readonly RecoveryInvariantResult[];
  /** SHA-256 digests prove preservation without retaining content. */
  readonly digests: Readonly<Partial<Record<RecoveryDigestId, string>>>;
  readonly outcome: 'passed' | 'failed';
  readonly elapsedMs: number;
}

export interface RecoveryHarnessReport {
  readonly schemaVersion: 1;
  readonly scenarioCount: number;
  readonly passedCount: number;
  readonly outcome: 'passed' | 'failed';
  readonly scenarios: readonly RecoveryScenarioEvidence[];
}

/** A pid that cannot belong to a live process on any supported platform. */
const UNREACHABLE_OWNER_PID = 2_147_483_646;

const VALID_CONFIG = {
  projectName: 'disposable',
  panes: [{ id: 'pane-1', paneId: '%1', slug: 'pane-1' }],
  settings: {},
  lastUpdated: '2026-01-01T00:00:00.000Z',
} as const;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Creates a throwaway project root outside the repository, holding a valid
 * pane config plus a file standing in for uncommitted user work. Callers must
 * dispose it; every scenario does so in a `finally`.
 */
async function createDisposableWorkspace(): Promise<{
  projectRoot: string;
  workPath: string;
  dispose: () => Promise<void>;
}> {
  // The product canonicalizes project and worktree paths, and on macOS the
  // system temp directory is a symlink (`/var` -> `/private/var`). Canonicalize
  // here so a scenario comparing a stored path against its own path is
  // comparing like with like rather than failing on the symlink form.
  const projectRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), 'psyche-recovery-')),
  );
  await mkdir(path.join(projectRoot, '.psyche'), { recursive: true });
  await writeFile(
    projectPaneConfigPath(projectRoot),
    `${JSON.stringify(VALID_CONFIG, null, 2)}\n`,
    'utf8',
  );
  const workPath = path.join(projectRoot, 'uncommitted-work.txt');
  await writeFile(workPath, 'the only copy of this work\n', 'utf8');
  return {
    projectRoot,
    workPath,
    dispose: () => rm(projectRoot, { recursive: true, force: true }),
  };
}

function evidence(
  scenario: RecoveryScenarioId,
  injection: RecoveryInjectionId,
  classification: RecoveryClassification,
  invariants: readonly RecoveryInvariantResult[],
  digests: Readonly<Partial<Record<RecoveryDigestId, string>>>,
  startedAt: number,
): RecoveryScenarioEvidence {
  return {
    schemaVersion: 1,
    scenario,
    injection,
    classification,
    invariants,
    digests,
    outcome: invariants.every((invariant) => invariant.held) ? 'passed' : 'failed',
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}

/**
 * Observed in #239 and remediated by PR #283: a corrupt pane config must be
 * reported and preserved, never silently overwritten with a fresh default.
 * Overwriting would destroy the only record of a user's pane layout.
 */
async function runCorruptPaneConfig(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const corruptBytes = '{"panes": [ this is not valid JSON';
    await writeFile(configPath, corruptBytes, 'utf8');
    const workBefore = digest(await readFile(workspace.workPath));

    let classification: RecoveryClassification = 'unexpected_success';
    try {
      await readProjectPaneConfig(workspace.projectRoot);
    } catch (error) {
      classification = error instanceof ProjectPaneConfigError
        ? error.code
        : 'unexpected_error';
    }

    const configAfter = await readFile(configPath, 'utf8');
    const workAfter = digest(await readFile(workspace.workPath));

    return evidence(
      'corrupt-pane-config',
      'pane-config-replaced-with-invalid-json',
      classification,
      [
        { id: 'failure-classified-as-corrupt', held: classification === 'config_corrupt' },
        { id: 'corrupt-bytes-preserved', held: configAfter === corruptBytes },
        { id: 'uncommitted-work-untouched', held: workAfter === workBefore },
      ],
      { configInjected: digest(corruptBytes), configAfter: digest(configAfter), workAfter },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

/**
 * Observed in #239: a lease left behind by a process that no longer exists
 * must not strand the project forever. Takeover must succeed while leaving
 * persisted state intact.
 */
async function runStalePaneConfigLock(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const lockDir = path.join(
      workspace.projectRoot,
      '.psyche',
      'runtime',
      'pane-config.lock',
    );
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, 'lease.json'),
      JSON.stringify({
        pid: UNREACHABLE_OWNER_PID,
        nonce: 'stale-owner-nonce',
        acquiredAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf8',
    );

    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const configBefore = digest(await readFile(configPath));
    const workBefore = digest(await readFile(workspace.workPath));

    let classification: RecoveryClassification = 'unexpected_error';
    let takenOver = false;
    let released = false;
    try {
      const lock = await acquireProjectPaneConfigLock(workspace.projectRoot, {
        // The owner pid is deliberately unreachable; state it explicitly so the
        // scenario does not depend on the host's pid allocation.
        isProcessAlive: (pid) => pid !== UNREACHABLE_OWNER_PID,
        timeoutMs: 2_000,
        pollIntervalMs: 25,
      });
      takenOver = true;
      classification = 'lock_taken_over';
      await lock.release();

      // Prove the release actually freed the lease rather than trusting the
      // call to have worked. A lease still held by this live process is not
      // stale, so a second acquisition would block and time out instead of
      // taking over — which is exactly the failure this check must catch.
      const reacquired = await acquireProjectPaneConfigLock(workspace.projectRoot, {
        timeoutMs: 1_000,
        pollIntervalMs: 25,
      });
      released = true;
      await reacquired.release();
    } catch {
      classification = takenOver ? 'lock_taken_over' : 'unexpected_error';
    }

    const configAfter = digest(await readFile(configPath));
    const workAfter = digest(await readFile(workspace.workPath));
    let stillReadable = false;
    try {
      await readProjectPaneConfig(workspace.projectRoot);
      stillReadable = true;
    } catch {
      stillReadable = false;
    }

    return evidence(
      'stale-pane-config-lock',
      'pane-config-lock-held-by-dead-owner',
      classification,
      [
        { id: 'stale-lease-taken-over', held: takenOver },
        { id: 'stale-lease-released', held: released },
        { id: 'persisted-config-unchanged', held: configAfter === configBefore },
        { id: 'persisted-config-readable', held: stillReadable },
        { id: 'uncommitted-work-untouched', held: workAfter === workBefore },
      ],
      { configBefore, configAfter, workAfter },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

/**
 * Listed unproven in #239: unwritable state storage must not be reported as a
 * successful persist. The `.psyche` directory is made read-only after its
 * runtime subdirectory exists, so the lease can still be acquired and the
 * failure isolates to the config write rather than to lock setup.
 */
async function runUnwritableStateStorage(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  const stateDir = path.join(workspace.projectRoot, '.psyche');
  let restored = false;
  try {
    await mkdir(path.join(stateDir, 'runtime'), { recursive: true });
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const configBefore = digest(await readFile(configPath));
    const workBefore = digest(await readFile(workspace.workPath));

    await chmod(stateDir, 0o500);

    // A process running as root ignores the mode bits, which would defeat the
    // injection. Prove the directory is genuinely unwritable before drawing
    // any conclusion, so an ineffective setup is never reported as a product
    // failure.
    const probePath = path.join(stateDir, '.harness-write-probe');
    let injectionEffective = false;
    try {
      await writeFile(probePath, 'probe', 'utf8');
      await rm(probePath, { force: true });
    } catch {
      injectionEffective = true;
    }

    let classification: RecoveryClassification = injectionEffective
      ? 'unexpected_success'
      : 'injection_ineffective';
    if (injectionEffective) {
      try {
        await mutateProjectPaneConfig(
          workspace.projectRoot,
          (config) => {
            config.panes = [];
          },
          { timeoutMs: 2_000, pollIntervalMs: 25 },
        );
      } catch {
        classification = 'persistence_failed';
      }
    }

    await chmod(stateDir, 0o700);
    restored = true;

    const configAfter = digest(await readFile(configPath));
    const workAfter = digest(await readFile(workspace.workPath));

    return evidence(
      'unwritable-state-storage',
      'state-directory-made-read-only',
      classification,
      [
        { id: 'persistence-failure-surfaced', held: classification === 'persistence_failed' },
        { id: 'persisted-config-unchanged', held: configAfter === configBefore },
        { id: 'uncommitted-work-untouched', held: workAfter === workBefore },
      ],
      { configBefore, configAfter, workAfter },
      startedAt,
    );
  } finally {
    if (!restored) {
      await chmod(stateDir, 0o700).catch(() => undefined);
    }
    await workspace.dispose();
  }
}

/**
 * Listed unproven in #239: a duplicate retry must reconcile the canonical
 * outcome rather than repeat the effect. The journal is reopened between the
 * two attempts, so a pass proves durable reconciliation rather than an
 * in-memory cache hit that a restart would lose.
 */
async function runDuplicateCommandRetry(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    await mkdir(path.join(workspace.projectRoot, '.psyche', 'runtime'), { recursive: true });
    const idempotencyKey = 'harness-duplicate-retry';
    const effectPath = path.join(workspace.projectRoot, 'effect-log.txt');
    const workBefore = digest(await readFile(workspace.workPath));
    let effectCount = 0;

    // Models the real reconciliation path: consult the journal first, perform
    // the effect only when no canonical outcome exists, then record it.
    const attempt = async (journal: ControlJournal) => {
      const existing = await journal.loadOutcome(idempotencyKey);
      if (existing) return existing;
      effectCount += 1;
      await writeFile(effectPath, `effect ${effectCount}\n`, 'utf8');
      const outcome = { status: 'succeeded' as const, value: { applied: true } };
      await journal.storeOutcome(idempotencyKey, outcome);
      return outcome;
    };

    const first = await ControlJournal.open(workspace.projectRoot, 1);
    const firstOutcome = await attempt(first);

    // Reopen rather than reuse: durability is the property under test.
    const second = await ControlJournal.open(workspace.projectRoot, 1);
    const retriedOutcome = await attempt(second);
    const reloaded = await second.loadOutcome(idempotencyKey);

    const workAfter = digest(await readFile(workspace.workPath));
    const sameOutcome = exactCommandOutcomeDigest(firstOutcome)
      === exactCommandOutcomeDigest(retriedOutcome);
    const executedOnce = effectCount === 1;
    const survivedRestart = reloaded !== undefined;

    // Reconciliation means all three held. Reporting it on the effect count
    // alone would let the classification claim success while the retry
    // returned a different outcome or the restart lookup found nothing.
    const reconciled = executedOnce && sameOutcome && survivedRestart;

    return evidence(
      'duplicate-command-retry',
      'command-replayed-after-journal-restart',
      reconciled ? 'outcome_reconciled' : 'unexpected_success',
      [
        { id: 'effect-executed-exactly-once', held: executedOnce },
        { id: 'retry-reconciles-canonical-outcome', held: sameOutcome },
        { id: 'reconciliation-survives-restart', held: survivedRestart },
        { id: 'uncommitted-work-untouched', held: workAfter === workBefore },
      ],
      { effectLog: digest(await readFile(effectPath)), workAfter },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

/**
 * Listed in #199 as "old owner epochs": an actor holding authority from before
 * an owner restart must not be able to act after it. The scenario asserts a
 * currently-valid lease using the pre-restart epoch, which is what a client
 * that never observed the restart would present.
 *
 * The current-epoch assertion is a deliberate positive control. Without it a
 * change that rejected every assertion would pass the rejection invariant
 * while breaking all authority.
 */
async function runStaleOwnerEpoch(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const target = { kind: 'project' as const, id: 'harness-project' };
  const grant = {
    requestId: 'harness-request',
    actorId: 'harness-actor',
    taskId: 'harness-task',
    grantedBy: 'harness',
    grants: [{ target, capabilities: ['pane.observe' as const] }],
    ttlMs: 60_000,
  };
  const assertion = {
    revision: 1,
    actorId: grant.actorId,
    taskId: grant.taskId,
    target,
    capability: 'pane.observe' as const,
  };

  // The owner has restarted, so the live store runs at the newer epoch while a
  // stale client still believes it is talking to the previous one.
  const restartedEpoch = 2;
  const preRestartEpoch = 1;
  const store = new CapabilityLeaseStore(() => new Date(), restartedEpoch);
  const lease = store.grant(grant);

  let staleRejectedCode: string | undefined;
  try {
    store.assert({ ...assertion, leaseId: lease.id, ownerEpoch: preRestartEpoch });
  } catch (error) {
    staleRejectedCode = (error as { code?: string }).code;
  }

  let currentAccepted = false;
  try {
    store.assert({ ...assertion, leaseId: lease.id, ownerEpoch: restartedEpoch });
    currentAccepted = true;
  } catch {
    currentAccepted = false;
  }

  const staleRejected = staleRejectedCode === 'owner_restarted';

  return evidence(
    'stale-owner-epoch',
    'lease-asserted-with-pre-restart-owner-epoch',
    staleRejected && currentAccepted ? 'owner_restart_fenced' : 'unexpected_success',
    [
      { id: 'stale-epoch-assertion-rejected', held: staleRejected },
      { id: 'current-epoch-assertion-accepted', held: currentAccepted },
    ],
    {},
    startedAt,
  );
}

/**
 * #196 and #239 require that a close or cleanup never silently discards the
 * only copy of uncommitted work, and that an interrupted cleanup leaves an
 * explicit reconciliation action rather than an unexplained missing worktree.
 *
 * Scope, stated precisely: this drives the durable-evidence half of that
 * contract — the recovery marker is published, the worktree and its
 * uncommitted file survive, and the marker names the worktree and carries
 * operator instructions. It does not interrupt `WorktreeCleanupService`
 * mid-flight, so it must not be read as covering the full cleanup path.
 */
async function runInterruptedCleanupRecoveryMarker(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const worktreePath = path.join(workspace.projectRoot, 'worktree-pane-1');
    await mkdir(worktreePath, { recursive: true });
    const worktreeWorkPath = path.join(worktreePath, 'uncommitted-in-worktree.txt');
    await writeFile(worktreeWorkPath, 'the only copy of this worktree work\n', 'utf8');
    const worktreeWorkBefore = digest(await readFile(worktreeWorkPath));
    const workBefore = digest(await readFile(workspace.workPath));

    // Cleanup publishes its recovery marker and is then abandoned, which is
    // the state a crash between marker publication and worktree removal
    // leaves behind.
    await writeWorktreeRecoveryMarker({
      projectRoot: workspace.projectRoot,
      worktreePath,
      pane: { id: 'harness-pane', paneId: '%1', slug: 'harness-pane' },
      operation: 'cleanup',
      reason: 'harness interrupted cleanup',
    });

    const markers = await listWorktreeRecoveryMarkers(workspace.projectRoot);
    const marker = markers.find((entry) => entry.worktreePath === worktreePath);

    let worktreeWorkAfter: string | undefined;
    try {
      worktreeWorkAfter = digest(await readFile(worktreeWorkPath));
    } catch {
      worktreeWorkAfter = undefined;
    }
    const workAfter = digest(await readFile(workspace.workPath));

    const retained = worktreeWorkAfter === worktreeWorkBefore;
    const discoverable = markers.length > 0;
    const namesWorktree = marker !== undefined;
    const actionable = typeof marker?.operatorInstructions === 'string'
      && marker.operatorInstructions.length > 0;

    return evidence(
      'interrupted-cleanup-recovery-marker',
      'cleanup-abandoned-after-marker-publication',
      retained && discoverable && namesWorktree && actionable
        ? 'cleanup_recoverable'
        : 'unexpected_success',
      [
        { id: 'worktree-retained-after-interruption', held: retained },
        { id: 'recovery-marker-discoverable', held: discoverable },
        { id: 'recovery-marker-names-the-worktree', held: namesWorktree },
        { id: 'recovery-marker-carries-operator-instructions', held: actionable },
        { id: 'uncommitted-work-untouched', held: workAfter === workBefore },
      ],
      {
        workAfter,
        ...(worktreeWorkAfter ? { worktreeWorkAfter } : {}),
      },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

async function runInterruptedCleanupOwner(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  let retainWorkspace = false;
  try {
    const workBefore = digest(await readFile(workspace.workPath));
    const configBefore = digest(await readFile(projectPaneConfigPath(workspace.projectRoot)));
    const observed = await observeInterruptedCleanup(workspace.projectRoot);
    const workAfter = digest(await readFile(workspace.workPath));
    const configAfter = digest(await readFile(projectPaneConfigPath(workspace.projectRoot)));
    const invariants: RecoveryInvariantResult[] = [
      { id: 'cleanup-owner-interrupted', held: observed.interrupted },
      { id: 'cleanup-project-lease-recovered', held: observed.recovered },
      { id: 'cleanup-retry-blocked-by-marker', held: observed.retryBlocked },
      { id: 'worktree-retained-after-interruption', held: observed.retained },
      { id: 'worktree-branch-unchanged', held: observed.branchUnchanged },
      { id: 'clean-worktree-control-removed', held: observed.controlRemoved },
      { id: 'uncommitted-work-untouched', held: workBefore === workAfter },
      { id: 'persisted-config-unchanged', held: configBefore === configAfter },
    ];
    return evidence(
      'interrupted-cleanup-owner',
      'cleanup-owner-killed-before-git-mutation',
      invariants.every((entry) => entry.held) ? 'cleanup_recoverable' : 'unexpected_error',
      invariants,
      {
        workAfter, configBefore, configAfter,
        ...(observed.workAfter ? { worktreeWorkAfter: digest(observed.workAfter) } : {}),
      },
      startedAt,
    );
  } catch (error) {
    retainWorkspace = error instanceof RecoveryCleanupRetentionError;
    throw error;
  } finally {
    if (!retainWorkspace) await workspace.dispose();
  }
}

/**
 * Listed in #199 as "unavailable providers". An optional provider that is not
 * registered, or a daemon that is not running, must fail closed as a
 * classified outcome and must not cost the operator the plain terminal lane,
 * their pane configuration, or their uncommitted work.
 *
 * Three real production paths are driven, none of them mocked:
 *   1. `AgenticCapabilityRouter.execute` with an unregistered provider, which
 *      raises `capability_provider_unavailable` before any strategy runs.
 *   2. `listCovenSessionsFromDaemon` against a socket path that has no
 *      listener, which classifies rather than throws.
 *   3. `runTmuxDoctor` with agent detection returning nothing, which must
 *      still report the host as able to run.
 *
 * The registered-provider execution is a deliberate positive control. Without
 * it, a change that rejected every provider would satisfy the fail-closed
 * invariant while removing all optional capability.
 *
 * Scope: this observes the routing and detection boundary. It does not prove
 * that an agent CLI which disappears mid-session degrades gracefully. That
 * command is sent into a live shell and the product has no classification for
 * its failure, so a passing run here must not be read as covering it.
 */
async function runUnavailableProviders(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const configBefore = digest(await readFile(configPath));

    // The router is built with only the native provider registered, so a
    // request naming the other provider reaches a genuinely absent strategy.
    const router = new AgenticCapabilityRouter({
      strategies: [createCovenNativeCapabilityStrategy()],
    });
    const request = {
      taskId: 'harness-task',
      capability: 'planning' as const,
      input: { prompt: 'harness', harness: 'recovery-harness' },
      context: { projectRoot: workspace.projectRoot, cwd: workspace.projectRoot },
    };

    let routingCode: string | undefined;
    try {
      await router.execute({ ...request, provider: 'psyche' });
    } catch (error) {
      routingCode = error instanceof CapabilityRoutingError ? error.code : 'unexpected_error';
    }

    let registeredProviderExecuted = false;
    try {
      const execution = await router.execute({ ...request, provider: 'coven-native' });
      registeredProviderExecuted = execution.trace.provider === 'coven-native';
    } catch {
      registeredProviderExecuted = false;
    }

    // No listener is ever created at this path, so the client observes a real
    // connection failure rather than a simulated one. A regression that threw
    // instead of classifying must surface as a failed invariant here, not as
    // an unhandled rejection that costs the run its evidence.
    let daemonClassified = false;
    try {
      const daemonState = await listCovenSessionsFromDaemon({
        client: createCovenClient({
          socketPath: path.join(workspace.projectRoot, '.psyche', 'absent-coven.sock'),
        }),
      });
      daemonClassified = daemonState.status === 'unavailable';
    } catch {
      daemonClassified = false;
    }

    await writeFile(
      path.join(workspace.projectRoot, '.tmux.conf'),
      buildPsycheManagedTmuxConfigBlock('dark'),
      'utf8',
    );
    const doctor = await runTmuxDoctor({
      runtime: {
        homeDir: workspace.projectRoot,
        env: {},
        findAgentCommand: () => null,
        run: (command, args) => {
          if (command === 'tmux' && args.join(' ') === '-V') {
            return { status: 0, stdout: 'tmux 3.4\n', stderr: '' };
          }
          if (command === 'git' && args.join(' ') === '--version') {
            return { status: 0, stdout: 'git version 2.45.0\n', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: '' };
        },
      },
    });
    const agentCheck = doctor.checks.find((check) => check.id === 'agent-cli-guidance');

    const configAfter = digest(await readFile(configPath));
    const workAfter = digest(await readFile(workspace.workPath));

    const classified = routingCode === 'capability_provider_unavailable' && daemonClassified;
    const terminalLaneUsable = doctor.canRun && agentCheck?.severity === 'warning';

    return evidence(
      'unavailable-providers',
      'capability-provider-unregistered-and-daemon-socket-absent',
      classified ? 'provider_unavailable' : 'unexpected_success',
      [
        { id: 'provider-failure-classified', held: classified },
        { id: 'available-provider-still-executes', held: registeredProviderExecuted },
        { id: 'plain-terminal-lane-remains-usable', held: terminalLaneUsable },
        { id: 'persisted-config-unchanged', held: configAfter === configBefore },
        { id: 'uncommitted-work-untouched', held: workAfter === digest('the only copy of this work\n') },
      ],
      { configBefore, configAfter, workAfter },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

/**
 * Named in #196 and left partially covered by #199: a stale or replaced tmux
 * identity must be reported and never rebound to unrelated state. Every other
 * scenario in this harness ages a *lease*; this one ages the pane identity
 * itself, which production recovery treats as a separate path.
 *
 * The injection replaces a real tmux server. The replacement restarts pane
 * numbering, so the recorded `%0` is handed to a pane the persisted record
 * never owned — the collision that makes a restart able to resize, kill, or
 * type into someone else's pane.
 *
 * Two real production paths are driven, neither mocked:
 *   1. `paneTmuxIdentityIsCurrent`, which must refuse the reused ID because
 *      its server generation differs, not merely because the ID is absent.
 *   2. `rebindPaneByTitle`, which must leave the stale record alone rather
 *      than adopting the reused ID that its title now resolves to.
 *
 * `live-pane-rebinds-to-current-identity` is a deliberate positive control:
 * refusing every rebind would satisfy the fail-closed invariants while
 * stranding every pane that legitimately moved across the restart.
 *
 * Scope: this observes the identity and rebinding boundary that persisted
 * records pass through on load. It does not prove that a pane which dies
 * mid-command reports a terminal outcome, and it does not observe the
 * application itself restarting; both remain #199 gaps.
 */
async function runStalePaneIdentity(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const configBefore = digest(await readFile(configPath));

    let observed: Awaited<ReturnType<typeof observeReplacedTmuxIdentity>> | undefined;
    let classification: RecoveryClassification = 'unexpected_error';
    try {
      observed = await observeReplacedTmuxIdentity(workspace.projectRoot);
      classification = observed.reusedRecordedPaneId
        ? 'stale_identity_rejected'
        : 'injection_ineffective';
    } catch (error) {
      // A host that cannot run tmux observes nothing. The scenario records why
      // and fails, rather than reporting an unexercised path as passed.
      classification = error instanceof RecoveryTmuxUnavailableError
        ? 'tmux_unavailable'
        : 'unexpected_error';
    }

    const configAfter = digest(await readFile(configPath));
    const workAfter = digest(await readFile(workspace.workPath));

    return evidence(
      'stale-pane-identity',
      'tmux-server-replaced-reusing-recorded-pane-id',
      classification,
      [
        { id: 'replaced-server-reused-pane-id', held: observed?.reusedRecordedPaneId === true },
        { id: 'stale-pane-identity-reported', held: observed?.staleIdentityReported === true },
        { id: 'reused-pane-id-not-adopted', held: observed?.reusedPaneIdNotAdopted === true },
        { id: 'live-pane-rebinds-to-current-identity', held: observed?.livePaneRebound === true },
        {
          id: 'rebind-clears-stale-background-windows',
          held: observed?.backgroundBindingsCleared === true,
        },
        { id: 'persisted-config-unchanged', held: configAfter === configBefore },
        { id: 'uncommitted-work-untouched', held: workAfter === digest('the only copy of this work\n') },
      ],
      { configBefore, configAfter, workAfter },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

/**
 * The mid-flight half of the cleanup story. `interrupted-cleanup-owner` kills
 * the real cleanup queue at the safe boundary — after its project lease is
 * durable, before any Git mutation can begin. This kills it at the dangerous
 * one: the supervised `git worktree remove` is live, its leases are claimed,
 * and its process group is tracked, but Git has not reported a result.
 *
 * Documented until now as deliberately uncovered. The invariants are about the
 * state a user is left in, not about which side of the race won:
 *
 *   - the worktree is never half-removed — gone and unregistered, or present
 *     and still registered, never a directory removed while its registration
 *     survives or the reverse;
 *   - no Git process from the interrupted mutation outlives the interruption,
 *     which is what would keep mutating a repository nobody is supervising;
 *   - the project lifecycle lease is recoverable afterwards rather than
 *     stranded by an owner that died holding it;
 *   - the branch and the only copy of uncommitted work are untouched.
 *
 * `mutation-observed-in-flight` is the injection's positive control. Without
 * it a run that never reached the mutation would report every preservation
 * invariant as held while having proved nothing.
 *
 * Scope: the interruption lands between the product handing off to Git and Git
 * answering. It does not prove interruption *after* Git has begun writing;
 * that needs a fault inside Git rather than around it.
 */
async function runInterruptedGitMutation(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  // An interrupted mutation that cannot be confirmed finished keeps its
  // workspace: deleting a repository a live Git process may still be writing
  // to would destroy the evidence and undercut that process.
  let retainWorkspace = false;
  try {
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const configBefore = digest(await readFile(configPath));

    let observed: Awaited<ReturnType<typeof observeMidMutationCleanup>> | undefined;
    let classification: RecoveryClassification = 'unexpected_error';
    try {
      observed = await observeMidMutationCleanup(workspace.projectRoot);
      retainWorkspace = observed.retentionRequired;
      classification = observed.mutationObservedInFlight
        ? 'cleanup_recoverable'
        : 'injection_ineffective';
    } catch (error) {
      retainWorkspace = error instanceof RecoveryCleanupRetentionError;
      classification = 'unexpected_error';
    }

    const configAfter = digest(await readFile(configPath));
    const workAfter = digest(await readFile(workspace.workPath));

    return evidence(
      'interrupted-git-mutation',
      'cleanup-owner-killed-during-supervised-git-mutation',
      classification,
      [
        { id: 'mutation-observed-in-flight', held: observed?.mutationObservedInFlight === true },
        {
          id: 'cleanup-owner-killed-during-mutation',
          held: observed?.ownerKilledDuringMutation === true,
        },
        {
          id: 'worktree-state-self-consistent',
          held: observed?.worktreeStateSelfConsistent === true,
        },
        {
          id: 'interrupted-mutation-left-no-orphan',
          held: observed?.mutationLeftNoOrphan === true,
        },
        {
          id: 'cleanup-project-lease-recovered',
          held: observed?.projectLeaseRecovered === true,
        },
        { id: 'worktree-branch-unchanged', held: observed?.branchUnchanged === true },
        { id: 'uncommitted-work-untouched', held: observed?.workPreserved === true },
        { id: 'persisted-config-unchanged', held: configAfter === configBefore },
      ],
      { configBefore, configAfter, workAfter },
      startedAt,
    );
  } finally {
    if (!retainWorkspace) await workspace.dispose();
  }
}

/**
 * The upgrade-recovery scenario #199 held open.
 *
 * It was deliberately absent while the persisted project config carried no
 * schema version: a scenario cannot assert on behavior the product does not
 * implement, and asserting an invented one is worse than having no coverage.
 * With a stamped version, a read-side gate, a named migration registry and a
 * durable pre-migration snapshot in place, both halves of an upgrade are now
 * observable.
 *
 * Downgrade half: an older Psyche opening a project a newer one wrote must
 * refuse and preserve every field, including the ones it cannot represent.
 * Upgrade half: a Psyche meeting a config written before versions existed must
 * adopt it through a named migration and leave the superseded bytes on disk.
 *
 * This exercises the source path, not two real installed builds. It is not
 * evidence that an installed upgrade recovers.
 */
async function runUpgradeRecovery(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const workBefore = digest(await readFile(workspace.workPath));

    // Downgrade half: a config from a newer Psyche, carrying a field this
    // version has no representation for.
    const newerConfig = `${JSON.stringify({
      ...VALID_CONFIG,
      schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION + 1,
      fieldThisVersionCannotRepresent: { retained: true },
    }, null, 2)}\n`;
    await writeFile(configPath, newerConfig, 'utf8');

    let classification: RecoveryClassification = 'unexpected_success';
    try {
      await readProjectPaneConfig(workspace.projectRoot);
    } catch (error) {
      classification = error instanceof ProjectPaneConfigError
        ? error.code
        : 'unexpected_error';
    }
    const afterRefusal = await readFile(configPath, 'utf8');

    // Upgrade half: a config written before the stamp existed.
    const unversioned = `${JSON.stringify(VALID_CONFIG, null, 2)}\n`;
    await writeFile(configPath, unversioned, 'utf8');
    const read = await readProjectPaneConfigWithSchema(workspace.projectRoot);
    await mutateProjectPaneConfig(workspace.projectRoot, (config) => ({
      config,
      result: undefined,
    }));

    const adopted = await readFile(configPath, 'utf8');
    const adoptedVersion = (JSON.parse(adopted) as { schemaVersion?: unknown }).schemaVersion;
    let retainedSnapshot = '';
    try {
      const directory = projectConfigSnapshotDirectory(workspace.projectRoot);
      const [snapshot] = (await readdir(directory)).sort();
      if (snapshot) retainedSnapshot = await readFile(path.join(directory, snapshot), 'utf8');
    } catch {
      // No snapshot directory: the invariant below reports it as not held.
    }

    return evidence(
      'upgrade-recovery',
      'pane-config-aged-across-schema-versions',
      classification,
      [
        { id: 'newer-schema-refused', held: classification === 'config_newer_schema' },
        { id: 'newer-schema-config-preserved', held: afterRefusal === newerConfig },
        {
          id: 'unversioned-config-adopted-by-named-migration',
          held: read.schemaVersion === UNVERSIONED_PROJECT_CONFIG_SCHEMA
            && read.migrations.length > 0,
        },
        {
          id: 'adopted-config-carries-current-schema',
          held: adoptedVersion === PROJECT_CONFIG_SCHEMA_VERSION,
        },
        { id: 'pre-migration-snapshot-retained', held: retainedSnapshot === unversioned },
        { id: 'uncommitted-work-untouched', held: digest(await readFile(workspace.workPath)) === workBefore },
      ],
      {
        configInjected: digest(newerConfig),
        configAfter: digest(adopted),
        workAfter: digest(await readFile(workspace.workPath)),
      },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

/**
 * Listed first in #199 and uncovered until now: no scenario launched,
 * terminated and relaunched the application. The restart-adjacent scenarios
 * reopen the control journal or construct a restarted owner epoch in process,
 * which is not the same claim.
 *
 * This launches the real cockpit in a disposable project, completes first-run
 * onboarding, quits it the way a person does — the cockpit confirms on the
 * first Ctrl+C and exits on the second — relaunches it, and checks the
 * workspace comes back without duplicating what it restored. #196 asks exactly
 * this: restore "without duplicate projects, panes, sessions, or worktrees".
 *
 * `first-run-reached-workspace` is the setup control. Without it a run where
 * the cockpit never started would report every restart invariant as failed for
 * the wrong reason, and `restart_unavailable` says so explicitly.
 *
 * This scenario is **not** in the default harness run. Two real launches cost
 * tens of seconds and depend on onboarding prompt text, which is a flake
 * surface no required check should carry. Run it with `pnpm recovery:restart`.
 *
 * Scope: it observes quit and relaunch of a workspace with no panes running
 * agents. It does not observe a crash mid-transition, a restart with live
 * agent panes, or the packaged application bundle.
 */
async function runApplicationRestart(): Promise<RecoveryScenarioEvidence> {
  const startedAt = Date.now();
  const workspace = await createDisposableWorkspace();
  try {
    const configPath = projectPaneConfigPath(workspace.projectRoot);
    const configBefore = digest(await readFile(configPath));

    let observed: Awaited<ReturnType<typeof observeApplicationRestart>> | undefined;
    let classification: RecoveryClassification = 'unexpected_error';
    try {
      observed = await observeApplicationRestart(workspace.projectRoot);
      classification = observed.firstRunReachedWorkspace
        ? 'workspace_restored'
        : 'restart_unavailable';
    } catch (error) {
      // A host that cannot launch the cockpit observes nothing, and says which
      // rather than reporting an unexercised path as passed.
      classification = error instanceof RecoveryRestartUnavailableError
        ? 'restart_unavailable'
        : 'unexpected_error';
    }

    // The cockpit runs against its own project directory inside this
    // workspace, so the workspace's own config and work file must be
    // untouched: a restart that wandered outside its project would show here.
    const configAfter = digest(await readFile(configPath));
    const workAfter = digest(await readFile(workspace.workPath));

    return evidence(
      'application-restart',
      'application-quit-and-relaunched',
      classification,
      [
        { id: 'first-run-reached-workspace', held: observed?.firstRunReachedWorkspace === true },
        { id: 'normal-quit-ended-cockpit', held: observed?.quitEndedCockpitProcess === true },
        { id: 'restart-restored-workspace', held: observed?.restartRestoredWorkspace === true },
        {
          id: 'restart-preserved-project-identity',
          held: observed?.projectIdentityStable === true,
        },
        {
          id: 'restart-did-not-duplicate-projects',
          held: observed?.noDuplicateProjects === true,
        },
        { id: 'restart-did-not-duplicate-panes', held: observed?.noDuplicatePanes === true },
        {
          id: 'restart-did-not-duplicate-sessions',
          held: observed?.noDuplicateSessions === true,
        },
        {
          id: 'restart-did-not-duplicate-worktrees',
          held: observed?.noDuplicateWorktrees === true,
        },
        {
          id: 'restart-did-not-duplicate-managed-panes',
          held: observed?.noDuplicateManagedPanes === true,
        },
        { id: 'uncommitted-work-untouched', held: observed?.workPreserved === true },
        { id: 'persisted-config-unchanged', held: configAfter === configBefore },
      ],
      { configBefore, configAfter, workAfter },
      startedAt,
    );
  } finally {
    await workspace.dispose();
  }
}

const SCENARIOS: Readonly<
  Record<RecoveryScenarioId, () => Promise<RecoveryScenarioEvidence>>
> = {
  'corrupt-pane-config': runCorruptPaneConfig,
  'stale-pane-config-lock': runStalePaneConfigLock,
  'unwritable-state-storage': runUnwritableStateStorage,
  'duplicate-command-retry': runDuplicateCommandRetry,
  'stale-owner-epoch': runStaleOwnerEpoch,
  'interrupted-cleanup-recovery-marker': runInterruptedCleanupRecoveryMarker,
  'interrupted-cleanup-owner': runInterruptedCleanupOwner,
  'unavailable-providers': runUnavailableProviders,
  'stale-pane-identity': runStalePaneIdentity,
  'interrupted-git-mutation': runInterruptedGitMutation,
  'upgrade-recovery': runUpgradeRecovery,
  'application-restart': runApplicationRestart,
};

/**
 * Scenarios excluded from the default run. They launch real applications, so
 * they cost seconds and depend on interface text. They are run deliberately —
 * `pnpm recovery:restart` — never as part of a required check.
 */
const OPT_IN_SCENARIOS: ReadonlySet<RecoveryScenarioId> = new Set(['application-restart']);

/** The opt-in scenarios, for a runner that wants them by name. */
export function optInRecoveryScenarioIds(): readonly RecoveryScenarioId[] {
  return [...OPT_IN_SCENARIOS];
}

export function recoveryScenarioIds(): readonly RecoveryScenarioId[] {
  return (Object.keys(SCENARIOS) as RecoveryScenarioId[])
    .filter((id) => !OPT_IN_SCENARIOS.has(id));
}

/**
 * Runs every scenario and returns one bounded, sanitized report. Scenarios are
 * independent and each disposes its own workspace, so a failure in one does
 * not mask or corrupt another.
 */
export async function runRecoveryHarness(
  ids: readonly RecoveryScenarioId[] = recoveryScenarioIds(),
): Promise<RecoveryHarnessReport> {
  const scenarios: RecoveryScenarioEvidence[] = [];
  for (const id of ids) {
    scenarios.push(await SCENARIOS[id]());
  }
  const passedCount = scenarios.filter((entry) => entry.outcome === 'passed').length;
  return {
    schemaVersion: 1,
    scenarioCount: scenarios.length,
    passedCount,
    outcome: passedCount === scenarios.length ? 'passed' : 'failed',
    scenarios,
  };
}
