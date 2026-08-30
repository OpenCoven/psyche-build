import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assignPaneFixture,
  authorizeStressRun,
  buildCancellationCleanupPlan,
  buildPhaseTransitionTable,
  buildStressScenarios,
  findScenario,
  GPU_STRESS_CHURN,
  GPU_STRESS_CLEANUP_STATUSES,
  GPU_STRESS_CLEANUP_STEPS,
  GPU_STRESS_FIXTURES,
  GPU_STRESS_HARNESS_SCHEMA_VERSION,
  GPU_STRESS_LIMITS,
  GPU_STRESS_PANE_COUNTS,
  GPU_STRESS_PHASES,
  GPU_STRESS_PHASE_TIMING_MS,
  GPU_STRESS_REJECTION_CODES,
  GPU_STRESS_SCENARIO_DURATION_MS,
  GPU_STRESS_SCENARIO_IDS,
  GPU_STRESS_STARTUP_ENV_VAR,
  GPU_STRESS_SURFACE_ADJACENCY,
  GPU_STRESS_TRANSITION_EVENTS,
  GpuStressRejectionError,
  paneCountForScenario,
  scenarioIdForPaneCount,
  startupAuthorizationTokenFromEnvironment,
  validateCancellationCleanupOutcome,
  validateFixtureSelection,
  validateScenarioRequest,
} from '../src/gpu/stressScenarios.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractDoc = readFileSync(resolve(root, 'docs', 'gpu', 'STRESS-HARNESS-CONTRACT.md'), 'utf8');

type AnyRecord = Record<string, unknown>;

const rejectionCodes = (result: {
  readonly ok: boolean;
  readonly rejections?: readonly { readonly code: string }[];
}): string[] => (result.rejections ?? []).map((rejection) => rejection.code);

/** A disposal-complete cleanup outcome for a scenario. */
const buildDisposedCleanupOutcome = (scenarioId: string): AnyRecord => ({
  schemaVersion: GPU_STRESS_HARNESS_SCHEMA_VERSION,
  scenarioId,
  steps: GPU_STRESS_CLEANUP_STEPS.map((step) => ({ step, status: 'disposed' })),
});

describe('stress harness contract constants', () => {
  it('pins the closed native fixture enum to exactly the three fixed fixtures', () => {
    expect([...GPU_STRESS_FIXTURES]).toEqual(['steady', 'burst', 'rewrite']);
  });

  it('pins the deterministic scenarios to 1/6/12/24 panes in execution order', () => {
    expect([...GPU_STRESS_SCENARIO_IDS]).toEqual(['panes-1', 'panes-6', 'panes-12', 'panes-24']);
    expect([...GPU_STRESS_PANE_COUNTS]).toEqual([1, 6, 12, 24]);
  });

  it('pins the acceptance-criteria phase timing to 10 s warmup, 30 s measured, 5 s restore', () => {
    expect([...GPU_STRESS_PHASES]).toEqual(['warmup', 'measured', 'restore-context-loss']);
    expect(GPU_STRESS_PHASE_TIMING_MS).toEqual({
      warmup: 10_000,
      measured: 30_000,
      'restore-context-loss': 5_000,
    });
    expect(GPU_STRESS_SCENARIO_DURATION_MS).toBe(45_000);
    expect(GPU_STRESS_LIMITS.maxScenarioDurationMs).toBe(45_000);
  });

  it('pins the churn, lifecycle, and adjacency constants', () => {
    expect(GPU_STRESS_CHURN).toEqual({
      focusIntervalMs: 250,
      geometryChurn: 'per-frame',
      hiddenPaneFraction: 0.5,
      hiddenPaneSelection: 'odd-index',
      minimizeOffsetMs: 30_000,
      restoreOffsetMs: 35_000,
    });
    expect([...GPU_STRESS_SURFACE_ADJACENCY]).toEqual([
      'editor-document',
      'terminal-panes',
      'local-browser-page',
    ]);
  });

  it('pins the closed vocabularies for events, cleanup, and rejections', () => {
    expect([...GPU_STRESS_TRANSITION_EVENTS]).toEqual([
      'create-surfaces',
      'begin-churn',
      'hide-panes',
      'minimize-window',
      'restore-window',
      'begin-context-loss',
      'dispose-all',
    ]);
    expect([...GPU_STRESS_CLEANUP_STEPS]).toEqual([
      'stop-focus-geometry-churn',
      'stop-native-fixtures',
      'restore-window-state',
      'unhide-panes',
      'close-local-browser-page',
      'dispose-editor-document',
      'close-terminal-panes',
    ]);
    expect([...GPU_STRESS_CLEANUP_STATUSES]).toEqual(['pending', 'disposed', 'failed']);
    for (const code of [
      'missing-debug-build',
      'missing-startup-authorization',
      'invalid-startup-authorization',
      'unknown-fixture',
      'arbitrary-command-rejected',
      'unknown-pane-count',
    ]) {
      expect(GPU_STRESS_REJECTION_CODES).toContain(code);
    }
  });
});

describe('buildStressScenarios is deterministic', () => {
  it('returns the four scenarios in pane order with the exact phase windows', () => {
    const scenarios = buildStressScenarios();
    expect(scenarios.map((scenario) => scenario.id)).toEqual([...GPU_STRESS_SCENARIO_IDS]);
    expect(scenarios.map((scenario) => scenario.paneCount)).toEqual([1, 6, 12, 24]);
    for (const scenario of scenarios) {
      expect(scenario.phases).toEqual([
        { phase: 'warmup', startOffsetMs: 0, durationMs: 10_000 },
        { phase: 'measured', startOffsetMs: 10_000, durationMs: 30_000 },
        { phase: 'restore-context-loss', startOffsetMs: 40_000, durationMs: 5_000 },
      ]);
      expect(scenario.totalDurationMs).toBe(45_000);
      expect(scenario.surfaces.adjacency).toEqual([...GPU_STRESS_SURFACE_ADJACENCY]);
      expect(scenario.surfaces.editorDocument).toBe('generated-large-document');
      expect(scenario.surfaces.localBrowserPage).toBe(true);
    }
  });

  it('returns deep-equal structures on every call', () => {
    expect(buildStressScenarios()).toEqual(buildStressScenarios());
  });

  it('resolves scenarios by id and by pane count, rejecting unknowns', () => {
    for (const [index, id] of GPU_STRESS_SCENARIO_IDS.entries()) {
      expect(findScenario(id)?.paneCount).toBe(GPU_STRESS_PANE_COUNTS[index]);
      expect(paneCountForScenario(id)).toBe(GPU_STRESS_PANE_COUNTS[index]);
      expect(scenarioIdForPaneCount(GPU_STRESS_PANE_COUNTS[index])).toBe(id);
    }
    expect(findScenario('panes-7')).toBeNull();
    expect(paneCountForScenario('panes-7')).toBeNull();
    expect(scenarioIdForPaneCount(7)).toBeNull();
  });

  it('assigns native fixtures to panes by cycling the closed enum', () => {
    expect([0, 1, 2, 3, 4, 5].map(assignPaneFixture)).toEqual([
      'steady',
      'burst',
      'rewrite',
      'steady',
      'burst',
      'rewrite',
    ]);
    expect(new Set([0, 1, 2, 3, 4, 5].map(assignPaneFixture))).toEqual(
      new Set(GPU_STRESS_FIXTURES),
    );
    expect(() => assignPaneFixture(-1)).toThrow();
    expect(() => assignPaneFixture(1.5)).toThrow();
  });
});

describe('buildPhaseTransitionTable is deterministic', () => {
  it('lists the exact seven transitions at the pinned offsets', () => {
    expect(buildPhaseTransitionTable('panes-6')).toEqual([
      { atMs: 0, from: 'idle', to: 'warmup', event: 'create-surfaces' },
      { atMs: 10_000, from: 'warmup', to: 'measured', event: 'begin-churn' },
      { atMs: 15_000, from: 'measured', to: 'measured', event: 'hide-panes' },
      { atMs: 30_000, from: 'measured', to: 'measured', event: 'minimize-window' },
      { atMs: 35_000, from: 'measured', to: 'measured', event: 'restore-window' },
      { atMs: 40_000, from: 'measured', to: 'restore-context-loss', event: 'begin-context-loss' },
      { atMs: 45_000, from: 'restore-context-loss', to: 'idle', event: 'dispose-all' },
    ]);
  });

  it('is identical for every scenario — pane count never changes timing', () => {
    const [first, , , last] = GPU_STRESS_SCENARIO_IDS;
    expect(buildPhaseTransitionTable(first)).toEqual(buildPhaseTransitionTable(last));
  });

  it('rejects unknown scenario ids', () => {
    // @ts-expect-error — deliberately invalid input from a dynamic caller
    expect(() => buildPhaseTransitionTable('panes-7')).toThrow('unknown scenario id');
  });
});

describe('authorizeStressRun requires debug build AND startup token', () => {
  it('authorizes only a debug build with the exact startup token "1"', () => {
    expect(authorizeStressRun({ debugBuild: true, startupAuthorizationToken: '1' })).toEqual({ ok: true });
  });

  it('rejects a production context even when the startup token is present', () => {
    const result = authorizeStressRun({ debugBuild: false, startupAuthorizationToken: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(rejectionCodes(result)).toEqual(['missing-debug-build']);
      expect(result.rejections[0].message).toMatch(/production context rejected/i);
    }
  });

  it('rejects a missing or non-boolean debug-build flag', () => {
    for (const debugBuild of [undefined, null, 'true', 1]) {
      const result = authorizeStressRun({ debugBuild, startupAuthorizationToken: '1' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['missing-debug-build']);
      }
    }
  });

  it('rejects a missing startup authorization token', () => {
    for (const startupAuthorizationToken of [undefined, null]) {
      const result = authorizeStressRun({ debugBuild: true, startupAuthorizationToken });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['missing-startup-authorization']);
      }
    }
  });

  it('rejects startup tokens other than the exact string "1"', () => {
    for (const startupAuthorizationToken of ['0', 'true', ' 1 ', '1 ', '', 1, true]) {
      const result = authorizeStressRun({ debugBuild: true, startupAuthorizationToken });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['invalid-startup-authorization']);
      }
    }
  });

  it('reports both rejections when neither the flag nor the token is present', () => {
    const result = authorizeStressRun({ debugBuild: undefined, startupAuthorizationToken: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(rejectionCodes(result)).toEqual(['missing-debug-build', 'missing-startup-authorization']);
    }
  });

  it('extracts the startup token from the captured startup environment only', () => {
    expect(
      startupAuthorizationTokenFromEnvironment({ PSYCHE_RENDER_DIAGNOSTICS: '1' }),
    ).toBe('1');
    expect(startupAuthorizationTokenFromEnvironment({ PSYCHE_RENDER_DIAGNOSTICS: '0' })).toBe('0');
    expect(startupAuthorizationTokenFromEnvironment({})).toBeNull();
    expect(startupAuthorizationTokenFromEnvironment({ OTHER: '1' })).toBeNull();
    expect(GPU_STRESS_STARTUP_ENV_VAR).toBe('PSYCHE_RENDER_DIAGNOSTICS');
  });

  it('exposes a thrown-form typed rejection error with a closed-vocabulary code', () => {
    const error = new GpuStressRejectionError('missing-debug-build', 'production context rejected');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GpuStressRejectionError');
    expect(error.code).toBe('missing-debug-build');
  });
});

describe('validateScenarioRequest accepts only fixed scenarios and known pane counts', () => {
  it('accepts a request by scenario id and resolves the pane count', () => {
    const result = validateScenarioRequest({ schemaVersion: 1, scenarioId: 'panes-12' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schemaVersion: 1, scenarioId: 'panes-12', paneCount: 12 });
    }
  });

  it('accepts a request by pane count and resolves the scenario id', () => {
    const result = validateScenarioRequest({ schemaVersion: 1, paneCount: 24 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schemaVersion: 1, scenarioId: 'panes-24', paneCount: 24 });
    }
  });

  it('accepts id and pane count when they agree', () => {
    const result = validateScenarioRequest({ schemaVersion: 1, scenarioId: 'panes-1', paneCount: 1 });
    expect(result.ok).toBe(true);
  });

  it('rejects scenario ids outside the fixed set', () => {
    for (const scenarioId of ['panes-7', 'panes-100', 'all', '']) {
      const result = validateScenarioRequest({ schemaVersion: 1, scenarioId });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toContain('unknown-scenario');
      }
    }
  });

  it('rejects unknown pane counts', () => {
    for (const paneCount of [0, 2, 7, 25, 100, -1, 6.5, Number.NaN, '6']) {
      const result = validateScenarioRequest({ schemaVersion: 1, paneCount });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toContain('unknown-pane-count');
      }
    }
  });

  it('rejects conflicting id and pane-count selections', () => {
    const result = validateScenarioRequest({ schemaVersion: 1, scenarioId: 'panes-6', paneCount: 12 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(rejectionCodes(result)).toContain('conflicting-scenario-selection');
    }
  });

  it('rejects unknown fields, wrong schema versions, empty selectors, and non-objects', () => {
    const unknownField = validateScenarioRequest({ schemaVersion: 1, scenarioId: 'panes-1', fixture: 'steady' });
    expect(unknownField.ok).toBe(false);
    if (!unknownField.ok) {
      expect(rejectionCodes(unknownField)).toContain('unknown-field');
    }

    for (const schemaVersion of [0, 2, '1']) {
      const result = validateScenarioRequest({ schemaVersion, scenarioId: 'panes-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toContain('unsupported-schema-version');
      }
    }

    const empty = validateScenarioRequest({ schemaVersion: 1 });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(rejectionCodes(empty)).toContain('malformed-request');
    }

    for (const input of [null, undefined, 'panes-1', 42, [], true]) {
      const result = validateScenarioRequest(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['malformed-request']);
      }
    }
  });
});

describe('validateFixtureSelection accepts only the closed fixture enum', () => {
  it('accepts exactly the three fixed fixtures', () => {
    for (const fixture of GPU_STRESS_FIXTURES) {
      expect(validateFixtureSelection(fixture)).toEqual({ ok: true, value: fixture });
    }
  });

  it('rejects command-shaped strings with the arbitrary-command code', () => {
    for (const command of [
      'sh -c "evil"',
      'steady; rm -rf /',
      '/bin/sh',
      'steady --verbose',
      'steady | tee /tmp/x',
      '`id`',
      'steady & burst',
      '',
    ]) {
      const result = validateFixtureSelection(command);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['arbitrary-command-rejected']);
      }
    }
  });

  it('rejects unknown fixture names without command semantics', () => {
    for (const fixture of ['spike', 'Steady', 'steady2']) {
      const result = validateFixtureSelection(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['unknown-fixture']);
      }
    }
  });

  it('rejects objects carrying command or executable fields outright', () => {
    for (const input of [
      { command: 'sh -c evil' },
      { exe: '/bin/sh' },
      { argv: ['stress', '--all'] },
      { args: ['--force'] },
      { script: 'while true; do done' },
    ]) {
      const result = validateFixtureSelection(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['arbitrary-command-rejected']);
      }
    }
  });

  it('rejects other malformed input', () => {
    for (const input of [null, undefined, 42, true, [], { fixture: 'steady' }]) {
      const result = validateFixtureSelection(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['malformed-request']);
      }
    }
  });
});

describe('cancellation cleanup states', () => {
  it('builds the full pending plan for every scenario', () => {
    for (const scenarioId of GPU_STRESS_SCENARIO_IDS) {
      const plan = buildCancellationCleanupPlan(scenarioId);
      expect(plan).toEqual({
        schemaVersion: 1,
        scenarioId,
        steps: GPU_STRESS_CLEANUP_STEPS.map((step) => ({ step, status: 'pending' })),
      });
    }
  });

  it('builds an identical plan regardless of when the run is cancelled', () => {
    // The plan is a pure function of the scenario: cancellation during warmup,
    // mid-measured, or restore all dispose the same resources in the same order.
    const atWarmup = buildCancellationCleanupPlan('panes-6');
    const atMeasured = buildCancellationCleanupPlan('panes-6');
    const atRestore = buildCancellationCleanupPlan('panes-6');
    expect(atWarmup).toEqual(atMeasured);
    expect(atMeasured).toEqual(atRestore);
  });

  it('accepts an outcome where every step is disposed', () => {
    const result = validateCancellationCleanupOutcome(buildDisposedCleanupOutcome('panes-1'));
    expect(result.ok).toBe(true);
  });

  it('rejects pending steps as incomplete cleanup', () => {
    const outcome = buildDisposedCleanupOutcome('panes-6');
    (outcome.steps as AnyRecord[])[0].status = 'pending';
    const result = validateCancellationCleanupOutcome(outcome);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(rejectionCodes(result)).toEqual(['cleanup-incomplete']);
    }
  });

  it('rejects failed steps — cleanup failures fail closed', () => {
    const outcome = buildDisposedCleanupOutcome('panes-6');
    (outcome.steps as AnyRecord[])[3].status = 'failed';
    const result = validateCancellationCleanupOutcome(outcome);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(rejectionCodes(result)).toEqual(['cleanup-failed']);
    }
  });

  it('rejects unknown, duplicated, and missing cleanup steps', () => {
    const unknown = buildDisposedCleanupOutcome('panes-6');
    (unknown.steps as AnyRecord[])[0].step = 'kill-everything';
    const unknownResult = validateCancellationCleanupOutcome(unknown);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(rejectionCodes(unknownResult)).toContain('unknown-cleanup-step');
      expect(rejectionCodes(unknownResult)).toContain('missing-cleanup-step');
    }

    const duplicated = buildDisposedCleanupOutcome('panes-6');
    (duplicated.steps as AnyRecord[])[1].step = 'stop-focus-geometry-churn';
    const duplicatedResult = validateCancellationCleanupOutcome(duplicated);
    expect(duplicatedResult.ok).toBe(false);
    if (!duplicatedResult.ok) {
      expect(rejectionCodes(duplicatedResult)).toContain('unknown-cleanup-step');
      expect(rejectionCodes(duplicatedResult)).toContain('missing-cleanup-step');
    }

    const missing = buildDisposedCleanupOutcome('panes-6');
    missing.steps = (missing.steps as AnyRecord[]).slice(0, -1);
    const missingResult = validateCancellationCleanupOutcome(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(rejectionCodes(missingResult)).toEqual(['missing-cleanup-step']);
    }
  });

  it('rejects unknown fields, wrong schema versions, and malformed input', () => {
    const unknownField = buildDisposedCleanupOutcome('panes-6');
    unknownField.force = true;
    const unknownFieldResult = validateCancellationCleanupOutcome(unknownField);
    expect(unknownFieldResult.ok).toBe(false);
    if (!unknownFieldResult.ok) {
      expect(rejectionCodes(unknownFieldResult)).toContain('unknown-field');
    }

    const wrongSchema = buildDisposedCleanupOutcome('panes-6');
    wrongSchema.schemaVersion = 2;
    const wrongSchemaResult = validateCancellationCleanupOutcome(wrongSchema);
    expect(wrongSchemaResult.ok).toBe(false);
    if (!wrongSchemaResult.ok) {
      expect(rejectionCodes(wrongSchemaResult)).toContain('unsupported-schema-version');
    }

    const wrongScenario = buildDisposedCleanupOutcome('panes-7');
    const wrongScenarioResult = validateCancellationCleanupOutcome(wrongScenario);
    expect(wrongScenarioResult.ok).toBe(false);
    if (!wrongScenarioResult.ok) {
      expect(rejectionCodes(wrongScenarioResult)).toContain('unknown-scenario');
    }

    for (const input of [null, undefined, 'disposed', 42]) {
      const result = validateCancellationCleanupOutcome(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(rejectionCodes(result)).toEqual(['malformed-request']);
      }
    }
  });
});

describe('stress harness documentation contract', () => {
  it('keeps the contract document aligned with the machine-checkable constants', () => {
    for (const fixture of GPU_STRESS_FIXTURES) {
      expect(contractDoc).toContain(`\`${fixture}\``);
    }
    for (const scenarioId of GPU_STRESS_SCENARIO_IDS) {
      expect(contractDoc).toContain(`\`${scenarioId}\``);
    }
    for (const phase of GPU_STRESS_PHASES) {
      expect(contractDoc).toContain(`\`${phase}\``);
    }
    for (const step of GPU_STRESS_CLEANUP_STEPS) {
      expect(contractDoc).toContain(`\`${step}\``);
    }
    expect(contractDoc).toContain('src/gpu/stressScenarios.ts');
    expect(contractDoc).toContain('authorizeStressRun()');
    expect(contractDoc).toContain('validateScenarioRequest()');
    expect(contractDoc).toContain('`PSYCHE_RENDER_DIAGNOSTICS`');
  });

  it('states the authorization rules, the launcher boundary, and the timing', () => {
    expect(contractDoc).toMatch(/10 s warmup/i);
    expect(contractDoc).toMatch(/30 s measured/i);
    expect(contractDoc).toMatch(/5 s restore/i);
    expect(contractDoc).toMatch(/debug build/i);
    expect(contractDoc).toMatch(/both or nothing|both inputs are required/i);
    expect(contractDoc).toContain('scripts/dev-tauri-diagnostics.mjs');
    expect(contractDoc).toMatch(/arbitrary commands/i);
  });

  it('never claims physical acceleration and records open runtime work as gaps', () => {
    expect(contractDoc).toMatch(/never claims physical acceleration|never claims hardware acceleration/i);
    expect(contractDoc).not.toMatch(/acceleration: confirmed|hardware acceleration confirmed/iu);
    expect(contractDoc).toMatch(/open gap/i);
    expect(contractDoc).toContain('#231');
  });
});
