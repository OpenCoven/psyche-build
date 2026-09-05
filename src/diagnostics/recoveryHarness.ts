/**
 * Disposable recovery harness for #199.
 *
 * Each scenario builds a throwaway project workspace, injects one bounded
 * failure, drives the real production recovery path, and asserts the
 * invariants that failure must preserve. Nothing here mocks the code under
 * test: the point is to observe what actually happens to bytes on disk when a
 * failure is injected, which unit tests with mocked services cannot show.
 *
 * Evidence is bounded and sanitized by construction. Records carry enumerated
 * identifiers, booleans, and content digests only. No absolute path, file
 * content, project name, credential, or raw error message is retained, so a
 * report can be attached to a public outcome without a redaction pass.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ProjectPaneConfigError,
  acquireProjectPaneConfigLock,
  projectPaneConfigPath,
  readProjectPaneConfig,
} from '../services/ProjectPaneConfig.js';

/** Scenario identifiers are enumerated so evidence can never leak free text. */
export type RecoveryScenarioId =
  | 'corrupt-pane-config'
  | 'stale-pane-config-lock';

export type RecoveryInjectionId =
  | 'pane-config-replaced-with-invalid-json'
  | 'pane-config-lock-held-by-dead-owner';

export type RecoveryClassification =
  | 'config_corrupt'
  | 'config_unreadable'
  | 'lock_taken_over'
  | 'unexpected_success'
  | 'unexpected_error';

export interface RecoveryInvariantResult {
  readonly name: string;
  readonly held: boolean;
}

export interface RecoveryScenarioEvidence {
  readonly schemaVersion: 1;
  readonly scenario: RecoveryScenarioId;
  readonly injection: RecoveryInjectionId;
  readonly classification: RecoveryClassification;
  readonly invariants: readonly RecoveryInvariantResult[];
  /** sha256 digests prove preservation without retaining content. */
  readonly digests: Readonly<Record<string, string>>;
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
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'psyche-recovery-'));
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
  digests: Readonly<Record<string, string>>,
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
        { name: 'failure is classified as corrupt', held: classification === 'config_corrupt' },
        { name: 'corrupt bytes are preserved, not overwritten', held: configAfter === corruptBytes },
        { name: 'uncommitted work is untouched', held: workAfter === workBefore },
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
    let acquired = false;
    try {
      const lock = await acquireProjectPaneConfigLock(workspace.projectRoot, {
        // The owner pid is deliberately unreachable; state it explicitly so the
        // scenario does not depend on the host's pid allocation.
        isProcessAlive: (pid) => pid !== UNREACHABLE_OWNER_PID,
        timeoutMs: 2_000,
        pollIntervalMs: 25,
      });
      acquired = true;
      classification = 'lock_taken_over';
      await lock.release();
    } catch {
      classification = 'unexpected_error';
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
        { name: 'stale lease is taken over', held: acquired },
        { name: 'persisted config is unchanged', held: configAfter === configBefore },
        { name: 'persisted config remains readable', held: stillReadable },
        { name: 'uncommitted work is untouched', held: workAfter === workBefore },
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
};

export function recoveryScenarioIds(): readonly RecoveryScenarioId[] {
  return Object.keys(SCENARIOS) as RecoveryScenarioId[];
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
