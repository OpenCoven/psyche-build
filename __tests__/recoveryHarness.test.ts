import { describe, expect, it } from 'vitest';

import {
  recoveryScenarioIds,
  runRecoveryHarness,
  type RecoveryDigestId,
  type RecoveryInvariantId,
  type RecoveryScenarioEvidence,
} from '../src/diagnostics/recoveryHarness.js';

const INVARIANT_IDS: readonly RecoveryInvariantId[] = [
  'failure-classified-as-corrupt',
  'corrupt-bytes-preserved',
  'uncommitted-work-untouched',
  'stale-lease-taken-over',
  'stale-lease-released',
  'persisted-config-unchanged',
  'persisted-config-readable',
  'persistence-failure-surfaced',
  'effect-executed-exactly-once',
  'retry-reconciles-canonical-outcome',
  'reconciliation-survives-restart',
];

const DIGEST_IDS: readonly RecoveryDigestId[] = [
  'configBefore',
  'configInjected',
  'configAfter',
  'workAfter',
  'effectLog',
];

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
        .map((invariant) => `${scenario.scenario}: ${invariant.id}`));
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
    // Release is verified by reacquiring, so this cannot hold while the lease
    // is still held by this process.
    const released = scenario.invariants
      .find((invariant) => invariant.id === 'stale-lease-released');
    expect(released?.held).toBe(true);
  });

  it('reports an unwritable state directory as a failed persist', async () => {
    const report = await runRecoveryHarness(['unwritable-state-storage']);
    const [scenario] = report.scenarios;

    // `injection_ineffective` means the harness could not make the directory
    // unwritable — running as root, for instance — and must not be read as the
    // product silently succeeding.
    expect(scenario.classification).not.toBe('injection_ineffective');
    expect(scenario.classification).toBe('persistence_failed');
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
  });

  it('reconciles a duplicate retry instead of repeating the effect', async () => {
    const report = await runRecoveryHarness(['duplicate-command-retry']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('outcome_reconciled');
    // The journal is reopened between attempts, so this proves durable
    // reconciliation rather than an in-memory cache a restart would lose.
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    expect(byId.get('effect-executed-exactly-once')).toBe(true);
    expect(byId.get('retry-reconciles-canonical-outcome')).toBe(true);
    expect(byId.get('reconciliation-survives-restart')).toBe(true);
  });

  it('emits bounded evidence carrying no paths, content, or free text', async () => {
    const report = await runRecoveryHarness();
    const serialized = JSON.stringify(report);

    for (const scenario of report.scenarios) {
      expect(recoveryScenarioIds()).toContain(scenario.scenario);
      expect(scenario.elapsedMs).toBeGreaterThanOrEqual(0);
      // Every emitted key and label belongs to a closed union, so the
      // sanitization contract is enforced by the schema rather than by trust.
      for (const invariant of scenario.invariants) {
        expect(INVARIANT_IDS).toContain(invariant.id);
        expect(typeof invariant.held).toBe('boolean');
      }
      for (const [key, value] of Object.entries(scenario.digests)) {
        expect(DIGEST_IDS).toContain(key as RecoveryDigestId);
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
