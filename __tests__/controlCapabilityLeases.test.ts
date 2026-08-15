import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CapabilityLeaseStore, SURFACE_CAPABILITIES } from '../src/control/capabilityLeases.js';
import type {
  CapabilityLease,
  CapabilityLeaseErrorCode,
  LeaseTarget,
} from '../src/control/capabilityLeases.js';
import { AGENT_CONTROL_LIMITS } from '../src/control/limits.js';
import type {
  ActionReceipt,
  ActionStatusReceipt,
  BrowserSemanticAction,
  ControlCommand,
  LeaseGrant,
  PaneAction,
  SemanticSnapshot,
} from '../src/control/types.js';

const nowIso = '2026-08-12T12:00:00.000Z';

type PublicControlContracts =
  | ActionReceipt
  | ActionStatusReceipt
  | BrowserSemanticAction
  | LeaseGrant
  | PaneAction
  | SemanticSnapshot;

const commandBase = {
  id: 'command-1',
  idempotencyKey: 'idem-1',
  projectRoot: '/repo',
  actor: { id: 'agent-1', kind: 'psyche' },
  ownerEpoch: 7,
  createdAt: nowIso,
} as const;

const agentCommandFixture: ControlCommand = {
  ...commandBase,
  kind: 'browser.action',
  payload: {
    taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
    tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
    action: { kind: 'click', elementRef: 'e17', semantic: { role: 'button', name: 'Refresh', submit: false } },
  },
};
void (agentCommandFixture satisfies ControlCommand);
void (null as PublicControlContracts | null);

type PaneActionCommand = Extract<ControlCommand, { kind: 'pane.action' }>;
type BrowserActionCommand = Extract<ControlCommand, { kind: 'browser.action' }>;
type ProviderResourceUpsertCommand = Extract<ControlCommand, { kind: 'provider.resource.upsert' }>;

function assertActionStatusTyping(): void {
  const replay: ActionStatusReceipt = {
    schema: 'psyche.control.receipt/v1',
    actionId: 'replay-status',
    state: 'failed',
    resource: { kind: 'browser_tab', idDigest: 'a'.repeat(64), generation: 1 },
    createdAt: nowIso,
    code: 'action_invalidated',
  };

  if ('idDigest' in replay.resource) {
    replay.resource.idDigest satisfies string;
    // @ts-expect-error replay receipts do not expose a live resource id
    replay.resource.id;
  }
}
assertActionStatusTyping();

function assertAgentActionTypes(): void {
  const acceptsPaneAction = (_command: PaneActionCommand): void => {};
  const acceptsBrowserAction = (_command: BrowserActionCommand): void => {};
  const acceptsProviderResourceUpsert = (_command: ProviderResourceUpsertCommand): void => {};

  acceptsPaneAction({
    ...commandBase,
    kind: 'pane.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      paneId: 'pane-1', generation: 1,
      action: { kind: 'send_keys', keys: ['Enter', 'C-d'] },
    },
  });
  acceptsPaneAction({
    ...commandBase,
    kind: 'pane.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      paneId: 'pane-1', generation: 1,
      // @ts-expect-error Pane key input is restricted to the named-key allowlist.
      action: { kind: 'send_keys', keys: ['Space'] },
    },
  });

  acceptsPaneAction({
    ...commandBase,
    kind: 'pane.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      projectId: '/repo', action: { kind: 'create', cwd: '/repo' },
    },
  });
  acceptsPaneAction({
    ...commandBase,
    kind: 'pane.action',
    // @ts-expect-error Pane creation is project-scoped, not bound to a nonexistent pane generation.
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      paneId: 'pane-1', generation: 1, action: { kind: 'create', cwd: '/repo' },
    },
  });
  acceptsPaneAction({
    ...commandBase,
    kind: 'pane.action',
    // @ts-expect-error Existing-pane actions require pane identity and generation.
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      projectId: '/repo', action: { kind: 'close' },
    },
  });

  acceptsBrowserAction({
    ...commandBase,
    kind: 'browser.action',
    // @ts-expect-error Element actions require a snapshot identity.
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      tabId: 'tab-1', generation: 2,
      action: { kind: 'click', elementRef: 'e17' },
    },
  });

  acceptsProviderResourceUpsert({
    ...commandBase,
    kind: 'provider.resource.upsert',
    payload: {
      resource: {
        id: 'tab-1', kind: 'browser_tab', generation: 2,
        projectRoot: '/repo', worktreeRoot: '/repo',
        providerId: 'desktop-1', webviewLabel: 'browser-a',
        url: 'https://example.com', title: 'Example', loading: false,
        viewport: { width: 800, height: 600 },
      },
    },
  });
  acceptsProviderResourceUpsert({
    ...commandBase,
    kind: 'provider.resource.upsert',
    payload: {
      resource: {
        id: 'pane-1',
        // @ts-expect-error Provider resource commands accept browser tabs only.
        kind: 'pane', generation: 1,
        projectRoot: '/repo', worktreeRoot: '/repo',
        tmuxPaneId: '%3', writable: true, outputSequence: 0,
      },
    },
  });
  acceptsBrowserAction({
    ...commandBase,
    kind: 'browser.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
      // @ts-expect-error Type actions require text.
      action: { kind: 'type', elementRef: 'e17' },
    },
  });
  acceptsBrowserAction({
    ...commandBase,
    kind: 'browser.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
      action: {
        kind: 'click', elementRef: 'e17',
        // @ts-expect-error Semantic actions never accept selectors.
        selector: '#unsafe',
      },
    },
  });
  acceptsBrowserAction({
    ...commandBase,
    kind: 'browser.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      tabId: 'tab-1', generation: 2,
      action: {
        kind: 'permission_response', permission: 'camera',
        origin: 'https://example.com', decision: 'deny',
      },
    },
  });

  for (const action of [
    { kind: 'select', elementRef: 'e17' },
    { kind: 'upload', elementRef: 'e17' },
    { kind: 'download', elementRef: 'e17' },
  ] as const) {
    acceptsBrowserAction({
      ...commandBase,
      kind: 'browser.action',
      payload: {
        taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
        tabId: 'tab-1', generation: 2, snapshotId: 'snapshot-1',
        // @ts-expect-error Select, upload, and download actions require their typed argument.
        action,
      },
    });
  }

  acceptsBrowserAction({
    ...commandBase,
    kind: 'browser.action',
    payload: {
      taskId: 'task-1', leaseId: 'lease-1', leaseRevision: 1,
      tabId: 'tab-1', generation: 2,
      // @ts-expect-error Permission responses require permission, origin, and decision.
      action: { kind: 'permission_response', permission: 'camera' },
    },
  });
}
void assertAgentActionTypes;

function assertReadonlyLeaseTypes(lease: CapabilityLease, target: LeaseTarget): void {
  // @ts-expect-error Lease identity is immutable.
  lease.actorId = 'attacker';
  // @ts-expect-error Lease grant collections are immutable.
  lease.grants.push({ target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'] });
  // @ts-expect-error Individual grant targets are immutable.
  lease.grants[0]!.target.id = 'attacker';
  // @ts-expect-error Capability collections are immutable.
  lease.grants[0]!.capabilities[0] = 'pane.close';
  // @ts-expect-error Lease targets are immutable.
  target.id = 'attacker';
}
void assertReadonlyLeaseTypes;

function assertReadonlyCommandGrantTypes(grant: LeaseGrant): void {
  // @ts-expect-error Requested grant targets are immutable authority.
  grant.target = { kind: 'project', id: '/other' };
  // @ts-expect-error Requested capability lists are immutable authority.
  grant.capabilities = ['pane.close'];
}
void assertReadonlyCommandGrantTypes;

const stableLeaseErrorCodes: readonly CapabilityLeaseErrorCode[] = [
  'lease_missing',
  'lease_expired',
  'lease_revision_mismatch',
  'owner_restarted',
  'capability_denied',
];
void stableLeaseErrorCodes;

function grantPane(store: CapabilityLeaseStore, requestId = 'lease-request-1') {
  return store.grant({
    requestId,
    actorId: 'agent-1',
    taskId: 'task-1',
    grantedBy: 'operator',
    ttlMs: 60_000,
    grants: [{
      target: { kind: 'pane' as const, id: 'pane-1', generation: 2 },
      capabilities: ['pane.observe' as const, 'pane.input' as const],
    }],
  });
}

describe('CapabilityLeaseStore', () => {
  it('binds an agent task to exact resource generations and capabilities', () => {
    const store = new CapabilityLeaseStore(() => new Date(nowIso), 7);
    const lease = grantPane(store);
    expect(store.assert({
      leaseId: lease.id,
      revision: lease.revision,
      actorId: 'agent-1',
      taskId: 'task-1',
      ownerEpoch: 7,
      target: { kind: 'pane', id: 'pane-1', generation: 2 },
      capability: 'pane.input',
    }).id).toBe(lease.id);

    const base = {
      leaseId: lease.id,
      revision: lease.revision,
      actorId: 'agent-1',
      taskId: 'task-1',
      ownerEpoch: 7,
      target: { kind: 'pane' as const, id: 'pane-1', generation: 2 },
      capability: 'pane.input' as const,
    };
    for (const attempt of [
      { ...base, actorId: 'agent-2' },
      { ...base, taskId: 'task-2' },
      { ...base, target: { kind: 'pane' as const, id: 'pane-2', generation: 2 } },
      { ...base, capability: 'pane.close' as const },
    ]) {
      expect(() => store.assert(attempt)).toThrowError(
        expect.objectContaining({ code: 'capability_denied' }),
      );
    }
  });

  it('reports stable assertion failure codes', () => {
    let now = Date.parse(nowIso);
    const store = new CapabilityLeaseStore(() => new Date(now), 7);
    const lease = grantPane(store);
    const base = {
      leaseId: lease.id, revision: lease.revision, actorId: 'agent-1', taskId: 'task-1',
      ownerEpoch: 7, target: { kind: 'pane' as const, id: 'pane-1', generation: 2 },
      capability: 'pane.input' as const,
    };
    expect(() => store.assert({ ...base, leaseId: 'missing' }))
      .toThrowError(expect.objectContaining({ code: 'lease_missing' }));
    expect(() => store.assert({ ...base, revision: lease.revision + 1 }))
      .toThrowError(expect.objectContaining({ code: 'lease_revision_mismatch' }));
    expect(() => store.assert({ ...base, ownerEpoch: 8 }))
      .toThrowError(expect.objectContaining({ code: 'owner_restarted' }));
    now += 60_000;
    expect(() => store.assert(base))
      .toThrowError(expect.objectContaining({ code: 'lease_expired' }));
  });

  it('rejects future generations and clears all authority on restart', () => {
    const store = new CapabilityLeaseStore(() => new Date(nowIso), 7);
    const lease = store.grant({
      requestId: 'r', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
      ttlMs: 60_000, grants: [{
        target: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        capabilities: ['browser.inspect'],
      }],
    });
    expect(() => store.assert({
      leaseId: lease.id, revision: lease.revision,
      actorId: 'agent-1', taskId: 'task-1', ownerEpoch: 7,
      target: { kind: 'browser_tab', id: 'tab-1', generation: 2 },
      capability: 'browser.inspect',
    })).toThrowError(expect.objectContaining({ code: 'capability_denied' }));
    expect(new CapabilityLeaseStore(() => new Date(), 8).snapshot()).toEqual([]);
  });

  it('clamps TTL, freezes leases, and increments revision on renewal', () => {
    const store = new CapabilityLeaseStore(() => new Date(nowIso), 7);
    const first = store.grant({
      requestId: 'renew-me', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
      ttlMs: Number.MAX_SAFE_INTEGER, grants: [{
        target: { kind: 'project', id: '/repo' }, capabilities: ['pane.create'],
      }],
    });
    const renewed = store.grant({
      requestId: 'renew-me', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
      ttlMs: 60_000, grants: first.grants,
    });

    expect(first.expiresAt).toBe(new Date(Date.parse(nowIso) + AGENT_CONTROL_LIMITS.leaseTtlMs).toISOString());
    expect(Object.isFrozen(first)).toBe(true);
    expect(renewed).toMatchObject({ id: first.id, revision: first.revision + 1 });
  });

  it('rejects renewal attempts that change lease identity or authority', () => {
    const store = new CapabilityLeaseStore(() => new Date(nowIso), 7);
    const first = grantPane(store, 'immutable-renewal');
    const renewal = {
      requestId: first.requestId,
      actorId: first.actorId,
      taskId: first.taskId,
      grantedBy: first.grantedBy,
      ttlMs: 60_000,
      grants: first.grants,
    };
    for (const changed of [
      { ...renewal, actorId: 'agent-2' },
      { ...renewal, taskId: 'task-2' },
      { ...renewal, grantedBy: 'operator-2' },
      { ...renewal, grants: [{
        target: { kind: 'pane' as const, id: 'pane-2', generation: 2 },
        capabilities: ['pane.observe' as const, 'pane.input' as const],
      }] },
      { ...renewal, grants: [{
        target: { kind: 'pane' as const, id: 'pane-1', generation: 2 },
        capabilities: ['pane.observe' as const, 'pane.close' as const],
      }] },
      { ...renewal, grants: [{
        target: { kind: 'pane' as const, id: 'pane-1', generation: 2 },
        capabilities: ['pane.observe' as const],
      }] },
      { ...renewal, grants: [{
        target: { kind: 'pane' as const, id: 'pane-1', generation: 2 },
        capabilities: ['pane.observe' as const, 'pane.input' as const, 'pane.close' as const],
      }] },
    ]) {
      expect(() => store.grant(changed)).toThrowError(
        expect.objectContaining({ code: 'capability_denied' }),
      );
      expect(store.snapshot()).toEqual([first]);
    }
  });

  it('renews semantically identical authority regardless of order or duplicates', () => {
    const store = new CapabilityLeaseStore(() => new Date(nowIso), 7);
    const first = store.grant({
      requestId: 'set-renewal', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
      ttlMs: 60_000,
      grants: [
        {
          target: { kind: 'pane', id: 'pane-1', generation: 2 },
          capabilities: ['pane.observe', 'pane.input'],
        },
        {
          target: { kind: 'browser_tab', id: 'tab-1', generation: 3 },
          capabilities: ['browser.inspect', 'browser.screenshot'],
        },
      ],
    });
    const reordered = store.grant({
      requestId: first.requestId, actorId: first.actorId, taskId: first.taskId,
      grantedBy: first.grantedBy, ttlMs: 60_000,
      grants: [
        {
          target: { kind: 'browser_tab', id: 'tab-1', generation: 3 },
          capabilities: ['browser.screenshot', 'browser.inspect', 'browser.inspect'],
        },
        {
          target: { kind: 'pane', id: 'pane-1', generation: 2 },
          capabilities: ['pane.input', 'pane.observe'],
        },
        {
          target: { kind: 'pane', id: 'pane-1', generation: 2 },
          capabilities: ['pane.observe', 'pane.input'],
        },
      ],
    });

    expect(reordered).toMatchObject({ id: first.id, revision: first.revision + 1 });
    expect(reordered.grants).toEqual(first.grants);
  });

  it('rejects expired authority', () => {
    let now = Date.parse(nowIso);
    const store = new CapabilityLeaseStore(() => new Date(now), 7);
    const lease = grantPane(store);
    now += 60_001;
    expect(() => store.assert({
      leaseId: lease.id, revision: lease.revision,
      actorId: 'agent-1', taskId: 'task-1', ownerEpoch: 7,
      target: { kind: 'pane', id: 'pane-1', generation: 2 }, capability: 'pane.observe',
    })).toThrowError(expect.objectContaining({ code: 'lease_expired' }));
  });

  it('removes leases from snapshots at the exact expiry boundary', () => {
    let now = Date.parse(nowIso);
    const store = new CapabilityLeaseStore(() => new Date(now), 7);
    const lease = grantPane(store);
    now += 59_999;
    expect(store.snapshot()).toEqual([lease]);
    now += 1;
    expect(store.snapshot()).toEqual([]);
    expect(store.revokeAll()).toEqual([]);
  });

  it('returns leases invalidated by release and revocation operations', () => {
    const store = new CapabilityLeaseStore(() => new Date(nowIso), 7);
    const released = grantPane(store, 'release');
    expect(store.release(released.id)).toBe(released);
    expect(store.release(released.id)).toBeUndefined();

    const revoked = grantPane(store, 'revoke');
    expect(store.revoke(revoked.id)).toBe(revoked);

    const matching = grantPane(store, 'target-match');
    const other = store.grant({
      requestId: 'target-other', actorId: 'agent-2', taskId: 'task-2', grantedBy: 'operator',
      ttlMs: 60_000, grants: [{
        target: { kind: 'browser_tab', id: 'tab-1', generation: 1 },
        capabilities: ['browser.inspect'],
      }],
    });
    expect(store.revokeTarget({ kind: 'pane', id: 'pane-1', generation: 2 })).toEqual([matching]);
    expect(store.revokeAll()).toEqual([other]);
    expect(store.snapshot()).toEqual([]);
  });

  it('retains bounded non-authoritative expired and revoked lifecycle history', () => {
    let now = Date.parse(nowIso);
    const store = new CapabilityLeaseStore(() => new Date(now), 7, { historyLimit: 2, historyTtlMs: 120_000 });
    const expired = grantPane(store, 'expired-history');
    now += 60_000;
    expect(store.snapshot()).toEqual([]);
    const revoked = grantPane(store, 'revoked-history');
    store.revoke(revoked.id);
    const newest = grantPane(store, 'newest-history');
    store.release(newest.id);

    expect(store.history()).toEqual([
      expect.objectContaining({ id: revoked.id, status: 'revoked', actorId: 'agent-1', taskId: 'task-1' }),
      expect.objectContaining({ id: newest.id, status: 'revoked', actorId: 'agent-1', taskId: 'task-1' }),
    ]);
    expect(store.history()).not.toContainEqual(expect.objectContaining({ id: expired.id }));
    expect(store.snapshot()).toEqual([]);
    expect(() => store.assert({
      leaseId: newest.id, revision: newest.revision, ownerEpoch: 7,
      actorId: newest.actorId, taskId: newest.taskId,
      target: newest.grants[0].target, capability: newest.grants[0].capabilities[0],
    })).toThrowError(expect.objectContaining({ code: 'lease_missing' }));
    now += 120_001;
    expect(store.history()).toEqual([]);
  });

  it('matches every canonical surface capability in the shared provider contract', () => {
    const fixture = JSON.parse(readFileSync(new URL(
      '../protocol-fixtures/control-v1/provider-contract.json', import.meta.url), 'utf8')) as {
      surfaceCapabilities: string[];
    };
    expect(SURFACE_CAPABILITIES).toEqual(fixture.surfaceCapabilities);
    expect(new Set(SURFACE_CAPABILITIES).size).toBe(SURFACE_CAPABILITIES.length);
    expect(SURFACE_CAPABILITIES).not.toContain('browser.action');
  });
});
