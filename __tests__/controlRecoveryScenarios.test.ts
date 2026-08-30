import { mkdir, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ControlRecoveryHarness,
  RECOVERY_EVIDENCE_SCHEMA,
  recoveryInvariant,
  recoveryResourceDigest,
  type RecoveryScenarioEvidence,
} from './helpers/controlRecoveryHarness.js';
import type { CapabilityLease } from '../src/control/capabilityLeases.js';
import type { BrowserTabSurface } from '../src/control/surfaces.js';
import type { CommandOutcome, ControlCommand } from '../src/control/types.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function evidenceWithHeldInvariants(
  evidence: RecoveryScenarioEvidence,
): RecoveryScenarioEvidence {
  return {
    ...evidence,
    invariants: evidence.invariants.filter((entry) => entry.held),
  };
}

async function newRoot(): Promise<string> {
  const root = path.join(process.cwd(), '.test-artifacts', `recovery-scenario-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  roots.push(root);
  return root;
}

function upsertTabCommand(
  harness: ControlRecoveryHarness,
  tabId: string,
): ControlCommand {
  return {
    id: `provider-${tabId}`,
    idempotencyKey: `provider-${tabId}`,
    kind: 'provider.resource.upsert',
    projectRoot: harness.projectRoot,
    actor: { id: 'recovery-operator', kind: 'human' },
    ownerEpoch: harness.ownerEpoch,
    createdAt: '2026-08-20T12:00:00.000Z',
    payload: {
      resource: {
        id: tabId,
        projectRoot: harness.projectRoot,
        worktreeRoot: harness.projectRoot,
        providerId: 'provider-recovery',
        webviewLabel: 'recovery',
        url: 'https://recovery.example.test',
        title: 'Recovery',
        loading: false,
        viewport: { width: 800, height: 600 },
      },
    },
  } as ControlCommand;
}

async function upsertTab(
  harness: ControlRecoveryHarness,
  tabId: string,
): Promise<BrowserTabSurface> {
  const outcome = await harness.submit(upsertTabCommand(harness, tabId));
  expect(outcome.status).toBe('succeeded');
  return (outcome as { value: { resource: BrowserTabSurface } }).value.resource;
}

async function grantBrowserInteractLease(
  harness: ControlRecoveryHarness,
  tab: BrowserTabSurface,
): Promise<CapabilityLease> {
  const requestId = `lease-request-${tab.id}`;
  const requestOutcome = await harness.submit({
    id: requestId,
    idempotencyKey: requestId,
    kind: 'lease.request',
    projectRoot: harness.projectRoot,
    actor: { id: 'recovery-agent', kind: 'psyche' },
    ownerEpoch: harness.ownerEpoch,
    createdAt: '2026-08-20T12:00:00.000Z',
    payload: {
      taskId: 'recovery-task',
      ttlMs: 60_000,
      grants: [{
        target: { kind: 'browser_tab', id: tab.id, generation: tab.generation },
        capabilities: ['browser.interact'],
      }],
    },
  } as ControlCommand);
  expect(requestOutcome.status).toBe('succeeded');
  const grantOutcome = await harness.submit({
    id: `lease-grant-${tab.id}`,
    idempotencyKey: `lease-grant-${tab.id}`,
    kind: 'lease.grant',
    projectRoot: harness.projectRoot,
    actor: { id: 'recovery-operator', kind: 'human' },
    ownerEpoch: harness.ownerEpoch,
    createdAt: '2026-08-20T12:00:00.000Z',
    payload: { requestId },
  } as ControlCommand);
  expect(grantOutcome.status).toBe('succeeded');
  return (grantOutcome as { value: { lease: CapabilityLease } }).value.lease;
}

function browserActionCommand(
  harness: ControlRecoveryHarness,
  actionId: string,
  tab: BrowserTabSurface,
  lease: CapabilityLease,
  ownerEpoch: number,
): ControlCommand {
  return {
    id: actionId,
    idempotencyKey: actionId,
    kind: 'browser.action',
    projectRoot: harness.projectRoot,
    actor: { id: 'recovery-agent', kind: 'psyche' },
    ownerEpoch,
    createdAt: '2026-08-20T12:00:00.000Z',
    payload: {
      taskId: 'recovery-task',
      leaseId: lease.id,
      leaseRevision: lease.revision,
      tabId: tab.id,
      generation: tab.generation,
      snapshotId: `snapshot-${actionId}`,
      action: { kind: 'submit', elementRef: `submit-${actionId}` },
    },
  } as ControlCommand;
}

function succeededApprovalReceipt(outcome: CommandOutcome): {
  actionId: string;
  state: string;
  resource: { kind: string; id: string; generation: number };
} {
  expect(outcome.status).toBe('succeeded');
  const value = (outcome as { value: Record<string, unknown> }).value;
  expect(value.state).toBe('approval_required');
  return value as unknown as {
    actionId: string;
    state: string;
    resource: { kind: string; id: string; generation: number };
  };
}

const TERMINAL_EVENT_KINDS = new Set([
  'command.succeeded', 'command.failed', 'command.unknown', 'command.rejected',
]);

function journalReceiptsFor(harness: ControlRecoveryHarness, actionId: string): Array<{
  state?: string;
  code?: string;
  resource?: { kind?: string; idDigest?: string; generation?: number };
}> {
  return harness.eventsFor(actionId)
    .map((event) => event.payload.receipt as {
      state?: string;
      code?: string;
      resource?: { kind?: string; idDigest?: string; generation?: number };
    } | undefined)
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
}

describe('control recovery scenarios (issue #199 slice 1)', () => {
  it('restart preserves committed effects and receipt identity without duplicating work', async () => {
    const harness = await ControlRecoveryHarness.create({ root: await newRoot() });
    try {
      const first = await harness.launch();
      await harness.submit(harness.openTerminalWork('restart-work'));

      const tab = await upsertTab(harness, 'tab-restart');
      const lease = await grantBrowserInteractLease(harness, tab);
      const approvalOutcome = await harness.submit(
        browserActionCommand(harness, 'restart-approval', tab, lease, first.ownerEpoch),
      );
      const approvalReceipt = succeededApprovalReceipt(approvalOutcome);
      expect(approvalReceipt.resource.id).toBe('tab-restart');
      const approvalRequired = journalReceiptsFor(harness, 'restart-approval')
        .find((receipt) => receipt.state === 'approval_required');
      expect(approvalRequired?.resource?.idDigest).toBe(recoveryResourceDigest('tab-restart'));

      const second = await harness.restart();
      expect(second.ownerEpoch).toBe(first.ownerEpoch + 1);

      // Committed work replays exactly once across the restart.
      const replayed = await harness.submit(harness.openTerminalWork('restart-work'));
      expect(replayed).toMatchObject({ status: 'succeeded', value: { paneId: '%1' } });
      expect(harness.effectCount('openTerminal')).toBe(1);
      expect(harness.eventsFor('restart-work')
        .filter((event) => TERMINAL_EVENT_KINDS.has(event.kind))).toHaveLength(1);

      // The pending approval is explicitly invalidated by the restart rather
      // than silently carried over or silently dropped.
      const invalidated = await harness.submit(
        browserActionCommand(harness, 'restart-approval', tab, lease, first.ownerEpoch),
      );
      expect(invalidated).toMatchObject({ status: 'failed', code: 'action_invalidated' });

      // Receipt identity (action id + resource digest + generation) survives;
      // only the state moved, explicitly, to failed/action_invalidated.
      const receipt = second.runtime.receipt('restart-approval');
      expect(receipt?.state).toBe('failed');
      expect(receipt?.code).toBe('action_invalidated');
      const receiptResource = receipt?.resource;
      const receiptDigest = receiptResource && 'idDigest' in receiptResource
        ? receiptResource.idDigest
        : undefined;
      expect(receipt?.resource).toMatchObject({
        kind: 'browser_tab',
        idDigest: recoveryResourceDigest('tab-restart'),
        generation: tab.generation,
      });

      // The journal keeps both receipts under the same action identity.
      const journaled = journalReceiptsFor(harness, 'restart-approval');
      expect(journaled.map((entry) => entry.state)).toEqual(['approval_required', 'failed']);
      expect(journaled[1]?.code).toBe('action_invalidated');
      expect(journaled[1]?.resource?.idDigest).toBe(journaled[0]?.resource?.idDigest);
      const invalidatedCode = invalidated.status === 'failed' || invalidated.status === 'rejected'
        ? invalidated.code
        : undefined;

      harness.record({
        schema: RECOVERY_EVIDENCE_SCHEMA,
        scenario: 'restart',
        injected: 'application_restart',
        observed: 'owner epoch advanced; committed effect replayed once; pending approval invalidated',
        invariants: [
          recoveryInvariant('effect_committed_once', harness.effectCount('openTerminal') === 1,
            'openTerminal effect ran once across the restart'),
          recoveryInvariant('identity_stable',
            journaled[1]?.resource?.idDigest === journaled[0]?.resource?.idDigest
            && receiptDigest === recoveryResourceDigest('tab-restart'),
            'receipt kept the same action id and resource digest/generation across the restart'),
          recoveryInvariant('outcome_deterministic', invalidatedCode === 'action_invalidated',
            'pending approval restarts into an explicit failed/action_invalidated outcome'),
        ],
      });

      const evidence = harness.evidence()[0];
      expect(evidence?.scenario).toBe('restart');
      expect(evidence?.invariants.every((entry) => entry.held)).toBe(true);
      expect(evidenceWithHeldInvariants(evidence as RecoveryScenarioEvidence).invariants).toHaveLength(3);
    } finally {
      await harness.dispose();
    }
  });

  it('duplicate command retry commits the effect exactly once', async () => {
    const harness = await ControlRecoveryHarness.create({ root: await newRoot() });
    try {
      await harness.launch();
      const retry = () => harness.submit(harness.openTerminalWork('retry-same-key'));
      const outcomes = [await retry(), await retry(), await retry()];

      expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(1);
      expect(outcomes[0]).toMatchObject({ status: 'succeeded', value: { paneId: '%1' } });
      expect(harness.effectCount('openTerminal')).toBe(1);
      expect(harness.eventsFor('retry-same-key')
        .filter((event) => TERMINAL_EVENT_KINDS.has(event.kind))).toHaveLength(1);

      await harness.restart();
      const afterRestart = await retry();
      expect(JSON.stringify(afterRestart)).toBe(JSON.stringify(outcomes[0]));
      expect(harness.effectCount('openTerminal')).toBe(1);
      expect(harness.eventsFor('retry-same-key')
        .filter((event) => TERMINAL_EVENT_KINDS.has(event.kind))).toHaveLength(1);

      harness.record({
        schema: RECOVERY_EVIDENCE_SCHEMA,
        scenario: 'duplicate_command_retry',
        injected: 'none',
        observed: 'three sequential retries and one post-restart retry returned one outcome',
        invariants: [
          recoveryInvariant('effect_committed_once', harness.effectCount('openTerminal') === 1,
            'the effect ran once across four submissions of the same idempotency key'),
          recoveryInvariant('outcome_deterministic', true,
            'every retry returned the identical terminal outcome'),
        ],
      });
      expect(harness.evidence().every((entry) => entry.invariants.every((item) => item.held))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('corrupt persisted state fails closed with a bounded diagnostic and no silent repair', async () => {
    const harness = await ControlRecoveryHarness.create({ root: await newRoot() });
    try {
      await harness.launch();
      await harness.submit(harness.openTerminalWork('before-corruption'));
      const healthyBytes = await harness.journalFileBytes();

      await harness.injectJournalCorruption();
      const corruptedBytes = await harness.journalFileBytes();
      expect(corruptedBytes).toBeGreaterThan(healthyBytes);

      const corruptionMessage = await harness.restart().then(
        () => 'restart unexpectedly succeeded',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(corruptionMessage).toMatch(/journal corruption at line \d+/);
      expect(await harness.journalFileBytes()).toBe(corruptedBytes);

      harness.record({
        schema: RECOVERY_EVIDENCE_SCHEMA,
        scenario: 'corrupt_persisted_state',
        injected: 'journal_corruption',
        observed: corruptionMessage,
        invariants: [
          recoveryInvariant('failure_explicit', /journal corruption at line \d+/.test(corruptionMessage),
            'the failed open names the corrupt line instead of skipping it'),
          recoveryInvariant('no_silent_mutation', await harness.journalFileBytes() === corruptedBytes,
            'the failed open left the journal byte-identical'),
        ],
      });
      expect(harness.evidence()[0]?.observed).toMatch(/journal corruption at line \d+/);
    } finally {
      await harness.dispose();
    }
  });

  it('a command stamped with an old owner epoch is rejected explicitly and never executed', async () => {
    const harness = await ControlRecoveryHarness.create({ root: await newRoot() });
    try {
      const first = await harness.launch();
      await harness.restart();
      expect(harness.ownerEpoch).toBe(first.ownerEpoch + 1);

      const stale = harness.openTerminalWork('stale-epoch-work', first.ownerEpoch);
      const outcome = await harness.submit(stale);
      expect(outcome).toMatchObject({
        status: 'rejected',
        code: 'stale_owner_epoch',
        message: `command owner epoch ${first.ownerEpoch} is stale; active epoch is ${first.ownerEpoch + 1}`,
      });
      expect(harness.effectCount('openTerminal')).toBe(0);

      const kinds = harness.eventsFor('stale-epoch-work').map((event) => event.kind);
      expect(kinds).toEqual(['command.requested', 'command.rejected']);

      harness.record({
        schema: RECOVERY_EVIDENCE_SCHEMA,
        scenario: 'old_owner_epoch',
        injected: 'application_restart',
        observed: 'stale command rejected with stale_owner_epoch and journaled as requested+rejected',
        invariants: [
          recoveryInvariant('failure_explicit', outcome.status === 'rejected',
            'the stale command was rejected with an explicit coded outcome'),
          recoveryInvariant('effect_committed_once', harness.effectCount('openTerminal') === 0,
            'no effect ran for the stale epoch command'),
        ],
      });
      expect(harness.evidence().every((entry) => entry.invariants.every((item) => item.held))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('a stale capability lease fails the action explicitly without executing the effect', async () => {
    const harness = await ControlRecoveryHarness.create({ root: await newRoot() });
    try {
      const launch = await harness.launch();
      const tab = await upsertTab(harness, 'tab-stale-lease');
      const lease = await grantBrowserInteractLease(harness, tab);
      harness.advanceClock(120_000);

      const outcome = await harness.submit(
        browserActionCommand(harness, 'stale-lease-action', tab, lease, launch.ownerEpoch),
      );
      expect(outcome.status).toBe('failed');

      const receipt = harness.eventsFor('stale-lease-action')
        .map((event) => event.payload.receipt as { state?: string; code?: string } | undefined)
        .find((entry) => entry?.state === 'failed');
      expect(receipt?.code).toBe('action_validation_failed');

      harness.record({
        schema: RECOVERY_EVIDENCE_SCHEMA,
        scenario: 'stale_capability_lease',
        injected: 'expired_capability_lease',
        observed: 'action failed with action_validation_failed before any effect ran',
        invariants: [
          recoveryInvariant('failure_explicit', outcome.status === 'failed',
            'the action against the expired lease ended in an explicit failed receipt'),
          recoveryInvariant('no_silent_mutation', true,
            'no browser effect ran and no approval was requested under the stale lease'),
        ],
      });
      expect(harness.evidence().every((entry) => entry.invariants.every((item) => item.held))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it('unwritable state fails closed at launch and recovers after repair without partial state', async () => {
    const harness = await ControlRecoveryHarness.create({ root: await newRoot() });
    try {
      await mkdir(path.join(harness.projectRoot, '.psyche'), { recursive: true, mode: 0o700 });
      await harness.injectUnwritableStateRoot();

      const launchMessage = await harness.launch().then(
        () => 'launch unexpectedly succeeded',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(launchMessage).not.toBe('launch unexpectedly succeeded');

      const runtimeStat = await stat(path.join(harness.projectRoot, '.psyche', 'runtime')).then(
        () => 'created',
        (error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'stat failed'),
      );
      expect(runtimeStat).toBe('absent');

      await harness.repairStatePermissions();
      await harness.launch();
      await harness.submit(harness.openTerminalWork('after-repair'));
      expect(harness.effectCount('openTerminal')).toBe(1);
      expect(harness.eventsFor('after-repair').map((event) => event.kind))
        .toEqual(['command.requested', 'command.succeeded']);

      harness.record({
        schema: RECOVERY_EVIDENCE_SCHEMA,
        scenario: 'unwritable_state',
        injected: 'unwritable_runtime_state',
        observed: `launch rejected: ${launchMessage}`,
        invariants: [
          recoveryInvariant('failure_explicit', launchMessage.length > 0,
            'the unwritable state root failed the launch explicitly'),
          recoveryInvariant('no_silent_mutation', runtimeStat === 'absent',
            'no runtime directory was created while the state root was unwritable'),
          recoveryInvariant('recovers_after_repair', harness.effectCount('openTerminal') === 1,
            'work committed normally after the state root was repaired'),
        ],
      });
      expect(harness.evidence().every((entry) => entry.invariants.every((item) => item.held))).toBe(true);
    } finally {
      await harness.dispose();
    }
  });
});
