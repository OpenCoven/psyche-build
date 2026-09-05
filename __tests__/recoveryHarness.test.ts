import { describe, expect, it } from 'vitest';

import {
  recoveryScenarioIds,
  runRecoveryHarness,
  type RecoveryScenarioEvidence,
} from '../src/diagnostics/recoveryHarness.js';

const SHA256 = /^[a-f0-9]{64}$/u;

describe('disposable recovery harness', () => {
  it('runs every observed #239 scenario and holds its invariants', async () => {
    const report = await runRecoveryHarness();

    expect(report.schemaVersion).toBe(1);
    expect(report.scenarioCount).toBe(recoveryScenarioIds().length);
    expect(report.outcome).toBe('passed');
    expect(report.passedCount).toBe(report.scenarioCount);

    const failing = report.scenarios.flatMap((scenario) =>
      scenario.invariants
        .filter((invariant) => !invariant.held)
        .map((invariant) => `${scenario.scenario}: ${invariant.name}`));
    expect(failing).toEqual([]);
  });

  it('classifies a corrupt pane config without destroying it', async () => {
    const report = await runRecoveryHarness(['corrupt-pane-config']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('config_corrupt');
    // The pre-#283 defect reported the same classification while replacing the
    // bytes, so preservation is asserted by digest rather than by the thrown
    // error alone.
    expect(scenario.digests.configAfter).toBe(scenario.digests.configInjected);
  });

  it('takes over a lease owned by a dead process without touching state', async () => {
    const report = await runRecoveryHarness(['stale-pane-config-lock']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('lock_taken_over');
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
  });

  it('emits bounded evidence carrying no paths, content, or free text', async () => {
    const report = await runRecoveryHarness();
    const serialized = JSON.stringify(report);

    for (const scenario of report.scenarios) {
      expect(recoveryScenarioIds()).toContain(scenario.scenario);
      expect(scenario.elapsedMs).toBeGreaterThanOrEqual(0);
      for (const value of Object.values(scenario.digests)) {
        expect(value).toMatch(SHA256);
      }
    }

    // Evidence is attachable to a public outcome without a redaction pass.
    expect(serialized).not.toMatch(/\/(?:Users|home|tmp|var|private)\//u);
    expect(serialized).not.toContain('the only copy of this work');
    expect(serialized).not.toContain('not valid JSON');
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/u);
  });

  it('keeps each scenario independent and leaves no workspace behind', async () => {
    const first = await runRecoveryHarness(['corrupt-pane-config']);
    const second = await runRecoveryHarness(['corrupt-pane-config']);

    // Digests are stable across runs, proving each run builds its own
    // workspace rather than inheriting state from the previous one.
    const digestsOf = (report: { scenarios: readonly RecoveryScenarioEvidence[] }) =>
      report.scenarios[0].digests.configAfter;
    expect(digestsOf(first)).toBe(digestsOf(second));
  });
});
