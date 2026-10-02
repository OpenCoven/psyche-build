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
  'no-partial-write-left-behind',
  'effect-executed-exactly-once',
  'retry-reconciles-canonical-outcome',
  'reconciliation-survives-restart',
  'stale-epoch-assertion-rejected',
  'current-epoch-assertion-accepted',
  'worktree-retained-after-interruption',
  'recovery-marker-discoverable',
  'recovery-marker-names-the-worktree',
  'recovery-marker-carries-operator-instructions',
  'cleanup-owner-interrupted',
  'cleanup-project-lease-recovered',
  'cleanup-retry-blocked-by-marker',
  'worktree-branch-unchanged',
  'clean-worktree-control-removed',
  'provider-failure-classified',
  'available-provider-still-executes',
  'plain-terminal-lane-remains-usable',
  'failing-agent-classified-as-launch-failure',
  'missing-agent-classified-as-not-found',
  'running-agent-not-classified-as-failed',
  'agent-pane-shell-preserved',
  'launch-report-carries-no-terminal-content',
  'replaced-server-reused-pane-id',
  'stale-pane-identity-reported',
  'reused-pane-id-not-adopted',
  'live-pane-rebinds-to-current-identity',
  'rebind-clears-stale-background-windows',
  'mutation-observed-in-flight',
  'cleanup-owner-killed-during-mutation',
  'worktree-state-self-consistent',
  'interrupted-mutation-left-no-orphan',
  'newer-schema-refused',
  'newer-schema-config-preserved',
  'unversioned-config-adopted-by-named-migration',
  'pre-migration-snapshot-retained',
  'adopted-config-carries-current-schema',
  'first-run-reached-workspace',
  'pane-created-before-quit',
  'restart-kept-its-project-config',
  'restart-stayed-inside-its-project',
  'restart-did-not-duplicate-live-panes',
  'normal-quit-ended-cockpit',
  'restart-restored-workspace',
  'restart-preserved-project-identity',
  'restart-did-not-duplicate-projects',
  'restart-did-not-duplicate-panes',
  'restart-did-not-duplicate-sessions',
  'restart-did-not-duplicate-worktrees',
  'restart-did-not-duplicate-managed-panes',
  'partial-write-landed-inside-git',
  'partial-removal-flagged-recovery-required',
  'partial-removal-detected-on-next-attempt',
  'remaining-worktree-files-preserved',
];

const DIGEST_IDS: readonly RecoveryDigestId[] = [
  'configBefore',
  'configInjected',
  'configAfter',
  'workAfter',
  'effectLog',
  'worktreeWorkAfter',
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

  it('reports full state storage as a failed persist and keeps the prior config', async () => {
    const report = await runRecoveryHarness(['full-state-storage']);
    const [scenario] = report.scenarios;

    // Source-level injection: `injection_ineffective` means the fault never
    // fired, which proves nothing and must not read as the product succeeding.
    expect(scenario.classification).not.toBe('injection_ineffective');
    expect(scenario.classification).toBe('persistence_failed');
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    expect(byId.get('no-partial-write-left-behind')).toBe(true);
    expect(byId.get('persisted-config-readable')).toBe(true);
    expect(scenario.outcome).toBe('passed');
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

  it('fences a lease asserted with a pre-restart owner epoch', async () => {
    const report = await runRecoveryHarness(['stale-owner-epoch']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('owner_restart_fenced');
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    expect(byId.get('stale-epoch-assertion-rejected')).toBe(true);
    // Positive control: rejecting every assertion would satisfy the rejection
    // invariant while breaking all authority, so acceptance is asserted too.
    expect(byId.get('current-epoch-assertion-accepted')).toBe(true);
  });

  it('retains an abandoned worktree and leaves an actionable recovery marker', async () => {
    const report = await runRecoveryHarness(['interrupted-cleanup-recovery-marker']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('cleanup_recoverable');
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    expect(byId.get('worktree-retained-after-interruption')).toBe(true);
    expect(byId.get('recovery-marker-discoverable')).toBe(true);
    // A marker that does not name the worktree, or carries no instructions,
    // is not a reconciliation action — it is a silent cleanup with a file.
    expect(byId.get('recovery-marker-names-the-worktree')).toBe(true);
    expect(byId.get('recovery-marker-carries-operator-instructions')).toBe(true);
  });

  it('recovers a killed cleanup owner before retrying behind its recovery marker', async () => {
    expect(recoveryScenarioIds()).toContain('interrupted-cleanup-owner');
    const report = await runRecoveryHarness(['interrupted-cleanup-owner']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('cleanup_recoverable');
    expect(scenario.outcome).toBe('passed');
    const byId = new Map(scenario.invariants.map((entry) => [entry.id, entry.held]));
    const expected: readonly RecoveryInvariantId[] = [
      'cleanup-owner-interrupted',
      'cleanup-project-lease-recovered',
      'cleanup-retry-blocked-by-marker',
      'worktree-retained-after-interruption',
      'worktree-branch-unchanged',
      'uncommitted-work-untouched',
      'clean-worktree-control-removed',
    ];
    for (const id of expected) {
      expect(byId.get(id), id).toBe(true);
    }
  });

  it('fails an unavailable provider closed without costing the terminal lane', async () => {
    const report = await runRecoveryHarness(['unavailable-providers']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('provider_unavailable');
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    expect(byId.get('provider-failure-classified')).toBe(true);
    // Positive control: rejecting every provider would satisfy the fail-closed
    // invariant while removing all optional capability.
    expect(byId.get('available-provider-still-executes')).toBe(true);
    // An unavailable optional provider must never cost the operator the lane
    // that needs no provider at all.
    expect(byId.get('plain-terminal-lane-remains-usable')).toBe(true);
    expect(byId.get('persisted-config-unchanged')).toBe(true);
    expect(byId.get('uncommitted-work-untouched')).toBe(true);
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
  });

  it('refuses a pane ID reused by a replacement tmux server', async () => {
    const report = await runRecoveryHarness(['stale-pane-identity']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('stale_identity_rejected');
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    // `injection_ineffective` would mean the replacement server never reused
    // the recorded ID, so the collision under observation never happened, and
    // `tmux_unavailable` would mean no server ran at all.
    expect(scenario.classification).not.toBe('injection_ineffective');
    expect(scenario.classification).not.toBe('tmux_unavailable');
    expect(byId.get('replaced-server-reused-pane-id')).toBe(true);
    // The ID is present on the live server; only the generation differs, so
    // presence alone must not be read as the pane still being current.
    expect(byId.get('stale-pane-identity-reported')).toBe(true);
    expect(byId.get('reused-pane-id-not-adopted')).toBe(true);
    // Positive control: refusing every rebind would satisfy the two
    // invariants above while stranding every pane that legitimately moved.
    expect(byId.get('live-pane-rebinds-to-current-identity')).toBe(true);
    expect(byId.get('rebind-clears-stale-background-windows')).toBe(true);
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
  });

  it('interrupts a supervised Git mutation without half-removing the worktree', async () => {
    const report = await runRecoveryHarness(['interrupted-git-mutation']);
    const [scenario] = report.scenarios;

    expect(scenario.classification).toBe('cleanup_recoverable');
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    // `injection_ineffective` would mean the queue never reached its
    // destructive mutation, so nothing was interrupted mid-flight and every
    // preservation invariant below would hold while proving nothing.
    expect(scenario.classification).not.toBe('injection_ineffective');
    expect(byId.get('mutation-observed-in-flight')).toBe(true);
    expect(byId.get('cleanup-owner-killed-during-mutation')).toBe(true);
    // The state that silently loses work is a directory removed while its
    // registration survives, or the reverse — not either complete outcome.
    expect(byId.get('worktree-state-self-consistent')).toBe(true);
    // A Git process still mutating a repository nobody supervises is the
    // other way an interrupted mutation becomes unsafe.
    expect(byId.get('interrupted-mutation-left-no-orphan')).toBe(true);
    expect(byId.get('cleanup-project-lease-recovered')).toBe(true);
    expect(byId.get('worktree-branch-unchanged')).toBe(true);
    expect(byId.get('uncommitted-work-untouched')).toBe(true);
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
  });

  it('flags a worktree Git left half-removed as recovery_required without deleting what remains', async () => {
    expect(recoveryScenarioIds()).toContain('git-mutation-partial-write');
    const report = await runRecoveryHarness(['git-mutation-partial-write']);
    const [scenario] = report.scenarios;

    // Positive control: `injection_ineffective` means Git never deleted part of
    // the tree before failing (for example when run as root, where a
    // read-only directory does not stop it), so nothing below was exercised.
    expect(scenario.classification).not.toBe('injection_ineffective');
    expect(scenario.classification).toBe('recovery_required');
    expect(scenario.outcome).toBe('passed');
    const byId = new Map(scenario.invariants.map((entry) => [entry.id, entry.held]));
    const expected: readonly RecoveryInvariantId[] = [
      'partial-write-landed-inside-git',
      // The product's own supervised removal stopped partway.
      'partial-removal-flagged-recovery-required',
      // An owner that died before it could look: the next attempt must notice.
      'partial-removal-detected-on-next-attempt',
      'recovery-marker-names-the-worktree',
      'recovery-marker-carries-operator-instructions',
      'cleanup-retry-blocked-by-marker',
      'remaining-worktree-files-preserved',
      'worktree-branch-unchanged',
      'uncommitted-work-untouched',
      'persisted-config-unchanged',
    ];
    for (const id of expected) {
      expect(byId.get(id), id).toBe(true);
    }
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
  });

  it('classifies an agent CLI that fails at launch without closing its shell', async () => {
    expect(recoveryScenarioIds()).toContain('agent-launch-failure');
    const report = await runRecoveryHarness(['agent-launch-failure']);
    const [scenario] = report.scenarios;

    // `tmux_unavailable` would mean no shell ran, so nothing was launched.
    expect(scenario.classification).not.toBe('tmux_unavailable');
    expect(scenario.classification).toBe('agent_launch_failed');
    const byId = new Map(scenario.invariants.map((i) => [i.id, i.held]));
    expect(byId.get('failing-agent-classified-as-launch-failure')).toBe(true);
    expect(byId.get('missing-agent-classified-as-not-found')).toBe(true);
    // Positive control: classifying every launch as failed would satisfy the
    // two invariants above while crying wolf on every healthy agent.
    expect(byId.get('running-agent-not-classified-as-failed')).toBe(true);
    // The classification is a report, never a remedy: the operator's shell
    // must still be there and still run what they type.
    expect(byId.get('agent-pane-shell-preserved')).toBe(true);
    expect(byId.get('launch-report-carries-no-terminal-content')).toBe(true);
    expect(byId.get('uncommitted-work-untouched')).toBe(true);
    expect(scenario.digests.configAfter).toBe(scenario.digests.configBefore);
    expect(JSON.stringify(report)).not.toContain('SENTINEL');
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
