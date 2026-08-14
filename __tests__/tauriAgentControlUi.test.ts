import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error Native web runtime is plain JavaScript by design.
import { badgeAccessibleName, normalizeAgentControlState, resourceBadgeFor } from '../native/desktop/psyche-build-tauri/web/control/agent-control-model.mjs';
// @ts-expect-error Native web runtime is plain JavaScript by design.
import { createAgentControlDrawer } from '../native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs';

const web = new URL('../native/desktop/psyche-build-tauri/web/', import.meta.url);
const source = (name: string) => readFileSync(new URL(name, web), 'utf8');

function snapshot(ownerEpoch = 7) {
  return {
    ownerEpoch,
    resources: [
      { kind: 'pane', id: 'pane-1', generation: 3 },
      { kind: 'browser_tab', id: 'tab-1', generation: 9 },
      { kind: 'pane', id: 'pane-2', generation: 4 },
      { kind: 'pane', id: 'pane-3', generation: 1 },
    ],
    leaseRequests: [
      { id: 'request-pending', actorId: 'agent-a', taskId: 'task-a', ttlMs: 60_000,
        createdAt: '2026-08-14T12:00:00.000Z', status: 'pending', grants: [
          { target: { kind: 'pane', id: 'pane-1', generation: 3 }, capabilities: ['pane.observe', 'pane.input'] },
        ] },
      { id: 'request-active', actorId: 'agent-b', taskId: 'task-b', ttlMs: 60_000,
        createdAt: '2026-08-14T12:00:00.000Z', status: 'granted', grants: [
          { target: { kind: 'browser_tab', id: 'tab-1', generation: 9 }, capabilities: ['browser.inspect'] },
        ] },
      { id: 'request-revoked', actorId: 'agent-c', taskId: 'task-c', ttlMs: 60_000,
        createdAt: '2026-08-14T12:00:00.000Z', status: 'granted', grants: [
          { target: { kind: 'pane', id: 'pane-2', generation: 4 }, capabilities: ['pane.observe'] },
        ] },
    ],
    capabilityLeases: [
      { id: 'lease-active', requestId: 'request-active', revision: 4, ownerEpoch,
        actorId: 'agent-b', taskId: 'task-b', grantedBy: 'operator',
        createdAt: '2026-08-14T12:00:01.000Z', expiresAt: '2026-08-14T12:30:00.000Z', grants: [
          { target: { kind: 'browser_tab', id: 'tab-1', generation: 9 }, capabilities: ['browser.inspect', 'browser.interact'] },
        ] },
      { id: 'lease-expired', requestId: 'request-expired', revision: 2, ownerEpoch,
        actorId: 'agent-d', taskId: 'task-d', grantedBy: 'operator',
        createdAt: '2026-08-14T11:00:00.000Z', expiresAt: '2026-08-14T11:30:00.000Z', grants: [
          { target: { kind: 'pane', id: 'pane-3', generation: 1 }, capabilities: ['pane.focus'] },
        ] },
    ],
    leaseHistory: [
      { id: 'lease-revoked', requestId: 'request-revoked', revision: 1, ownerEpoch,
        actorId: 'agent-c', taskId: 'task-c', grantedBy: 'operator', status: 'revoked',
        endedAt: '2026-08-14T12:04:00.000Z', createdAt: '2026-08-14T12:00:00.000Z',
        expiresAt: '2026-08-14T12:30:00.000Z', grants: [
          { target: { kind: 'pane', id: 'pane-2', generation: 4 }, capabilities: ['pane.observe'] },
        ] },
    ],
    approvals: [
      { id: 'approval-1', status: 'pending', actionId: 'action-1', ownerEpoch,
        leaseId: 'lease-active', leaseRevision: 4,
        resource: { kind: 'browser_tab', id: 'tab-1', generation: 9 },
        capability: 'browser.interact', effect: { kind: 'submit', targetDigest: 'b'.repeat(64) },
        payloadDigest: 'a'.repeat(64), createdAt: '2026-08-14T12:00:02.000Z',
        expiresAt: '2026-08-14T12:10:00.000Z' },
    ],
  };
}

describe('native agent control model', () => {
  function expectNoAuthority(model: ReturnType<typeof normalizeAgentControlState>) {
    expect(model.groups.requested.every((item: { canGrant: boolean }) => !item.canGrant)).toBe(true);
    expect(model.groups.active.every((item: { canRevoke: boolean }) => !item.canRevoke)).toBe(true);
    expect(model.approvals.every((item: { canApprove: boolean; canDeny: boolean }) => !item.canApprove && !item.canDeny)).toBe(true);
    expect(model.badges).toEqual([]);
  }

  it('groups requested, active, expired, and revoked leases with exact bounded details', () => {
    const model = normalizeAgentControlState(snapshot(), {
      now: '2026-08-14T12:05:00.000Z', operator: true,
    });
    expect(model.groups.requested.map((item: { id: string }) => item.id)).toEqual(['request-pending']);
    expect(model.groups.active.map((item: { id: string }) => item.id)).toEqual(['lease-active']);
    expect(model.groups.expired.map((item: { id: string }) => item.id)).toEqual(['lease-expired']);
    expect(model.groups.revoked.map((item: { id: string }) => item.id)).toEqual(['lease-revoked']);
    expect(model.groups.active[0]).toMatchObject({
      agent: 'agent-b', task: 'task-b', leaseId: 'lease-active', revision: 4,
      expiresAt: '2026-08-14T12:30:00.000Z', canRevoke: true,
      resources: [{ kind: 'browser_tab', id: 'tab-1', generation: 9,
        capabilities: ['browser.inspect', 'browser.interact'] }],
    });
    expect(model.groups.requested[0]).toMatchObject({
      requestedAt: '2026-08-14T12:00:00.000Z', leaseDurationMs: 60_000,
    });
    expect(model.groups.requested[0]).not.toHaveProperty('expiresAt');
  });

  it('exposes only bounded redacted receipts for the exact current resource generation', () => {
    const receipt = { commandId: 'action-recent', actionKind: 'browser.action', outcome: 'succeeded',
      timestamp: '2026-08-14T12:04:00.000Z', agentId: 'agent-a', taskId: 'task-a', redacted: true,
      result: 'result_unavailable', projectRoot: '/project-a', worktreeRoot: '/project-a/worktree-a',
      resource: { kind: 'browser_tab', id: 'tab-1', generation: 9 },
      value: 'secret result', code: 'private-code', message: 'private message', url: 'https://private.test' };
    const receipts = Array.from({ length: 25 }, (_, index) => ({ ...receipt, commandId: `action-${index}`,
      timestamp: `2026-08-14T12:04:${String(index).padStart(2, '0')}.000Z` })).reverse();
    receipts.push(...Array.from({ length: 30 }, (_, index) => ({ ...receipt, commandId: `sibling-${index}`,
      timestamp: `2026-08-14T12:05:${String(index).padStart(2, '0')}.000Z`, worktreeRoot: '/project-a/worktree-b' })));
    receipts.push({ ...receipt, commandId: 'other-project', projectRoot: '/project-b', worktreeRoot: '/project-b' });
    receipts.push({ ...receipt, commandId: 'stale', resource: { kind: 'browser_tab', id: 'tab-1', generation: 8 } });
    const legacyUnscoped: Record<string, unknown> = { ...receipt, commandId: 'legacy-unscoped' };
    delete legacyUnscoped.projectRoot;
    delete legacyUnscoped.worktreeRoot;
    receipts.push(legacyUnscoped as typeof receipt);
    const model = normalizeAgentControlState({ ...snapshot(), receipts }, {
      now: '2026-08-14T12:05:00.000Z', operator: true,
      projectRoot: '/project-a', worktreeRoot: '/project-a/worktree-a',
    });
    expect(model.recentActivity.map(({ id }: { id: string }) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `action-${index + 5}`),
    );
    expect(model.recentActivity.at(-1)).toEqual({
      id: 'action-24', action: 'browser.action', outcome: 'succeeded',
      timestamp: '2026-08-14T12:04:24.000Z', agent: 'agent-a', task: 'task-a',
      projectRoot: '/project-a', worktreeRoot: '/project-a/worktree-a',
      resource: { kind: 'browser_tab', id: 'tab-1', generation: 9 },
      redacted: true, result: 'result_unavailable',
    });
    expect(JSON.stringify(model.recentActivity)).not.toMatch(/secret result|private-code|private message|private\.test/);
  });

  it('preserves a bounded sanitized fetch error without inventing empty authority', () => {
    const model = normalizeAgentControlState({}, { operator: true, fetchError: `unavailable\n${'x'.repeat(300)}` });
    expect(model.fetchError).toHaveLength(160);
    expect(model.fetchError).not.toContain('\n');
    expect(model.groups).toEqual({ requested: [], active: [], expired: [], revoked: [] });
    expect(model.recentActivity).toEqual([]);
  });

  it('keeps approvals redacted and uses only server approval identity', () => {
    const model = normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z', operator: true });
    expect(model.approvals).toEqual([expect.objectContaining({
      id: 'approval-1', payloadDigest: 'a'.repeat(64),
      effect: { kind: 'submit', targetDigest: 'b'.repeat(64) },
      canApprove: true, canDeny: true,
    })]);
    expect(JSON.stringify(model)).not.toContain('actionPayload');
  });

  it('maps badges to exact lease identity and drops stale owner epochs immediately', () => {
    const current = normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z', operator: true });
    expect(resourceBadgeFor(current, { kind: 'browser_tab', id: 'tab-1', generation: 9 }))
      .toMatchObject({ leaseId: 'lease-active', revision: 4, agent: 'agent-b', task: 'task-b' });
    const restarted = normalizeAgentControlState({ ...snapshot(8), capabilityLeases: snapshot(7).capabilityLeases }, {
      now: '2026-08-14T12:05:00.000Z', operator: true,
    });
    expect(restarted.groups.active).toEqual([]);
    expect(restarted.badges).toEqual([]);
    const replacedResource = normalizeAgentControlState({ ...snapshot(), resources: [
      { kind: 'browser_tab', id: 'tab-1', generation: 10 },
    ] }, { now: '2026-08-14T12:05:00.000Z', operator: true });
    expect(replacedResource.badges).toEqual([]);
  });

  it('returns every matching lease badge in deterministic newest-first order', () => {
    const second = { ...snapshot().capabilityLeases[0], id: 'lease-newer', revision: 6,
      expiresAt: '2026-08-14T12:40:00.000Z' };
    const model = normalizeAgentControlState({ ...snapshot(), capabilityLeases: [
      snapshot().capabilityLeases[0], second,
    ] }, { now: '2026-08-14T12:05:00.000Z', operator: true, contextToken: 'project-a:7' });
    expect(model.contextToken).toBe('project-a:7');
    expect(model.resourceBadgesFor({ kind: 'browser_tab', id: 'tab-1', generation: 9 })
      .map((badge: { leaseId: string }) => badge.leaseId)).toEqual(['lease-newer', 'lease-active']);
    expect(resourceBadgeFor(model, { kind: 'browser_tab', id: 'tab-1', generation: 9 })?.leaseId)
      .toBe('lease-newer');
    expect(badgeAccessibleName(model.badges[0])).toContain('lease lease-newer revision 6');
    expect(badgeAccessibleName(model.badges[0])).toContain('browser_tab tab-1 generation 9');
  });

  it('fails closed for malformed approvals and exposes exact redacted decision context', () => {
    const valid = normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z', operator: true });
    expect(valid.approvals[0]).toMatchObject({
      agent: 'agent-b', task: 'task-b', leaseId: 'lease-active', leaseRevision: 4,
      resource: { kind: 'browser_tab', id: 'tab-1', generation: 9 }, canApprove: true,
    });
    for (const approval of [
      { ...snapshot().approvals[0], expiresAt: 'not-a-date' },
      { ...snapshot().approvals[0], id: '' },
      { ...snapshot().approvals[0], payloadDigest: '' },
      { ...snapshot().approvals[0], payloadDigest: { secret: 'never stringify me' } },
      { ...snapshot().approvals[0], resource: { kind: 'browser_tab', id: '', generation: 9 } },
      { ...snapshot().approvals[0], leaseId: 'missing-lease' },
      { ...snapshot().approvals[0], leaseRevision: 99 },
      { ...snapshot().approvals[0], capability: 'browser.navigate' },
    ]) {
      const model = normalizeAgentControlState({ ...snapshot(), approvals: [approval] },
        { now: '2026-08-14T12:05:00.000Z', operator: true });
      expect(model.approvals[0]).toMatchObject({ canApprove: false, canDeny: false });
      expect(model.approvals[0].payloadDigest).toEqual(expect.any(String));
    }
  });

  it('never enables operator controls in agent state', () => {
    const model = normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z', operator: false });
    expect(model.groups.requested[0].canGrant).toBe(false);
    expect(model.groups.active[0].canRevoke).toBe(false);
    expect(model.approvals[0]).toMatchObject({ canApprove: false, canDeny: false });
  });

  it('fails closed for invalid clocks and owner epochs without coercing authority', () => {
    for (const now of ['not-a-time', Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expectNoAuthority(normalizeAgentControlState(snapshot(), { now, operator: true }));
    }
    for (const ownerEpoch of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expectNoAuthority(normalizeAgentControlState(snapshot(ownerEpoch), {
        now: '2026-08-14T12:05:00.000Z', operator: true,
      }));
    }
  });

  it('rejects every malformed lease identity, resource, capability, revision, and expiry near-miss', () => {
    const base = snapshot().capabilityLeases[0];
    const malformed = [
      { ...base, id: '' }, { ...base, id: ' lease ' }, { ...base, id: 'x'.repeat(513) },
      { ...base, requestId: '' }, { ...base, actorId: '' }, { ...base, taskId: ' ' },
      { ...base, revision: 0 }, { ...base, revision: -1 }, { ...base, revision: Number.NaN },
      { ...base, revision: Number.POSITIVE_INFINITY }, { ...base, revision: 1.5 },
      { ...base, expiresAt: 'not-a-time' }, { ...base, expiresAt: '2026-08-14 12:30:00Z' },
      { ...base, createdAt: '2026-08-14T13:00:00.000Z' }, { ...base, status: 'revoked' },
      { ...base, grants: [] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'browser_tab', id: '', generation: 9 } }] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'browser_tab', id: 'tab-1', generation: -1 } }] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'browser_tab', id: 'tab-1', generation: Number.NaN } }] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'browser_tab', id: 'tab-1', generation: Number.POSITIVE_INFINITY } }] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'browser_tab', id: 'tab-1', generation: 1.5 } }] },
      { ...base, grants: [{ ...base.grants[0], capabilities: [] }] },
      { ...base, grants: [{ ...base.grants[0], capabilities: ['browser.inspect', 'browser.not-real'] }] },
    ];
    for (const lease of malformed) {
      const model = normalizeAgentControlState({ ...snapshot(), capabilityLeases: [lease], leaseRequests: [], approvals: [] }, {
        now: '2026-08-14T12:05:00.000Z', operator: true,
      });
      expect(model.groups.active).toEqual([]);
      expectNoAuthority(model);
    }
  });

  it('renders only complete canonical pending requests as actionable', () => {
    const base = snapshot().leaseRequests[0];
    const malformed = [
      { ...base, id: '' }, { ...base, id: ' request ' }, { ...base, actorId: '' }, { ...base, taskId: '' },
      { ...base, createdAt: 'not-a-time' }, { ...base, createdAt: '2026-08-14 12:00:00Z' },
      { ...base, createdAt: '+275760-09-13T00:00:00.000Z' },
      { ...base, ttlMs: 0 }, { ...base, ttlMs: -1 }, { ...base, ttlMs: Number.NaN },
      { ...base, ttlMs: Number.POSITIVE_INFINITY }, { ...base, ttlMs: 1.5 }, { ...base, grants: [] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'pane', id: '', generation: 3 } }] },
      { ...base, grants: [{ ...base.grants[0], target: { kind: 'pane', id: 'pane-1', generation: -1 } }] },
      { ...base, grants: [{ ...base.grants[0], capabilities: [] }] },
      { ...base, grants: [{ ...base.grants[0], capabilities: ['pane.observe', 'pane.not-real'] }] },
      { ...base, status: 'granted' },
    ];
    for (const request of malformed) {
      const model = normalizeAgentControlState({ ...snapshot(), leaseRequests: [request], capabilityLeases: [], approvals: [] }, {
        now: '2026-08-14T12:05:00.000Z', operator: true,
      });
      expect(model.groups.requested).toEqual([]);
      expectNoAuthority(model);
    }
    const valid = normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z', operator: true });
    expect(valid.groups.requested[0]).toMatchObject({ canGrant: true, requestId: 'request-pending' });
  });

  it('requires canonical lowercase sha256 approval and bounded exact approval identity', () => {
    const digest = 'a'.repeat(64);
    const validSnapshot = { ...snapshot(), approvals: [{ ...snapshot().approvals[0], payloadDigest: digest }] };
    expect(normalizeAgentControlState(validSnapshot, {
      now: '2026-08-14T12:05:00.000Z', operator: true,
    }).approvals[0]).toMatchObject({ payloadDigest: digest, canApprove: true, canDeny: true });
    for (const approval of [
      { ...validSnapshot.approvals[0], payloadDigest: 'A'.repeat(64) },
      { ...validSnapshot.approvals[0], payloadDigest: 'a'.repeat(63) },
      { ...validSnapshot.approvals[0], payloadDigest: `${'a'.repeat(63)}g` },
      { ...validSnapshot.approvals[0], id: ' approval ' },
      { ...validSnapshot.approvals[0], id: 'x'.repeat(513) },
      { ...validSnapshot.approvals[0], leaseId: ' lease-active ' },
      { ...validSnapshot.approvals[0], leaseRevision: 0 },
      { ...validSnapshot.approvals[0], expiresAt: '2026-08-14 12:10:00Z' },
      { ...validSnapshot.approvals[0], status: 'almost-pending' },
    ]) {
      const model = normalizeAgentControlState({ ...validSnapshot, approvals: [approval] }, {
        now: '2026-08-14T12:05:00.000Z', operator: true,
      });
      expect(model.approvals[0]).toMatchObject({ canApprove: false, canDeny: false });
    }
  });

  it('rejects target-incompatible capabilities before lease or approval authority', () => {
    const base = snapshot().capabilityLeases[0];
    for (const grant of [
      { target: { kind: 'pane', id: 'pane-1', generation: 3 }, capabilities: ['browser.interact'] },
      { target: { kind: 'browser_tab', id: 'tab-1', generation: 9 }, capabilities: ['pane.input'] },
      { target: { kind: 'pane', id: 'pane-1', generation: 3 }, capabilities: ['pane.create'] },
      { target: { kind: 'project', id: '/project' }, capabilities: ['pane.input'] },
    ]) {
      const model = normalizeAgentControlState({ ...snapshot(), leaseRequests: [], approvals: [],
        capabilityLeases: [{ ...base, grants: [grant] }] }, {
        now: '2026-08-14T12:05:00.000Z', operator: true,
      });
      expect(model.groups.active).toEqual([]);
      expectNoAuthority(model);
    }
    const valid = normalizeAgentControlState({ ...snapshot(), leaseRequests: [], approvals: [],
      capabilityLeases: [{ ...base, grants: [
        { target: { kind: 'pane', id: 'pane-1', generation: 3 }, capabilities: ['pane.input'] },
        { target: { kind: 'browser_tab', id: 'tab-1', generation: 9 }, capabilities: ['browser.interact'] },
        { target: { kind: 'project', id: '/project' }, capabilities: ['pane.create'] },
      ] }] }, { now: '2026-08-14T12:05:00.000Z', operator: true });
    expect(valid.groups.active[0]).toMatchObject({ canRevoke: true });
  });

  it('requires pending approval chronology to be created no later than now and before expiry', () => {
    const base = { ...snapshot().approvals[0], payloadDigest: 'a'.repeat(64) };
    for (const approval of [
      { ...base, createdAt: '2026-08-14T12:05:00.001Z' },
      { ...base, createdAt: base.expiresAt },
      { ...base, createdAt: '2026-08-14T12:11:00.000Z', expiresAt: '2026-08-14T12:10:00.000Z' },
    ]) {
      const model = normalizeAgentControlState({ ...snapshot(), approvals: [approval] }, {
        now: '2026-08-14T12:05:00.000Z', operator: true,
      });
      expect(model.approvals[0]).toMatchObject({ status: 'invalid', canApprove: false, canDeny: false });
    }
    expect(normalizeAgentControlState({ ...snapshot(), approvals: [{ ...base,
      createdAt: '2026-08-14T12:05:00.000Z' }] }, {
      now: '2026-08-14T12:05:00.000Z', operator: true,
    }).approvals[0]).toMatchObject({ status: 'pending', canApprove: true });
  });
});

describe('native agent control drawer', () => {
  it('retains the failed command card and keyboard focus while exposing a bounded exact error', async () => {
    const button = { dataset: { controlFocus: 'revoke:lease-active' }, focus: vi.fn() };
    const root: any = {
      hidden: true, ownerDocument: { activeElement: button },
      replaceChildren: vi.fn(), querySelector: vi.fn(() => button),
      addEventListener: vi.fn(), contains: vi.fn(() => true),
    };
    const drawer = createAgentControlDrawer({ root, onGrant: vi.fn(), onDeny: vi.fn(),
      onApprove: vi.fn(), onRevoke: vi.fn().mockRejectedValue(new Error('exact operator failure')) });
    drawer.render(normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z', operator: true }));
    await drawer.run('revoke', { leaseId: 'lease-active' }, button as any);
    expect(drawer.error()).toBe('exact operator failure');
    expect(root.replaceChildren).toHaveBeenCalledTimes(2);
    expect(button.focus).toHaveBeenCalled();
  });

  it('keeps a failed card after polling removes it and suppresses failures after a context switch', async () => {
    let rejectCommand!: (error: Error) => void;
    const command = new Promise((_resolve, reject) => { rejectCommand = reject; });
    const button = { dataset: { controlFocus: 'revoke:lease-active:4:browser_tab:tab-1:9' },
      textContent: 'Revoke browser_tab tab-1', focus: vi.fn() };
    const root: any = { hidden: true, ownerDocument: { activeElement: button },
      replaceChildren: vi.fn(), querySelector: vi.fn(() => button), addEventListener: vi.fn() };
    let contextToken = 'project-a:7';
    const drawer = createAgentControlDrawer({ root, getContextToken: () => contextToken,
      onGrant: vi.fn(), onDeny: vi.fn(), onApprove: vi.fn(), onRevoke: vi.fn(() => command) });
    const first = normalizeAgentControlState(snapshot(), { now: '2026-08-14T12:05:00.000Z',
      operator: true, contextToken });
    const pending = drawer.run('revoke', { leaseId: 'lease-active', leaseRevision: 4 }, button as any,
      first.groups.active[0]);
    const fetchFailure = normalizeAgentControlState({ ...snapshot(), capabilityLeases: [] }, {
      now: '2026-08-14T12:05:00.000Z', operator: false, contextToken,
      projectRoot: '/project-a', worktreeRoot: '/project-a/worktree-a',
      fetchError: 'Agent control state is temporarily unavailable',
    });
    drawer.render(fetchFailure);
    expect(fetchFailure).toMatchObject({ contextToken, fetchError: 'Agent control state is temporarily unavailable' });
    expect(fetchFailure.groups.active).toEqual([]);
    rejectCommand(new Error('retained same-context failure'));
    await pending;
    expect(drawer.error()).toBe('retained same-context failure');
    expect(button.focus).toHaveBeenCalled();

    let rejectOld!: (error: Error) => void;
    const oldCommand = new Promise((_resolve, reject) => { rejectOld = reject; });
    const switched = createAgentControlDrawer({ root, getContextToken: () => contextToken,
      onGrant: vi.fn(), onDeny: vi.fn(), onApprove: vi.fn(), onRevoke: vi.fn(() => oldCommand) });
    const oldPending = switched.run('revoke', { leaseId: 'lease-active' }, button as any,
      first.groups.active[0]);
    contextToken = 'project-b:8';
    rejectOld(new Error('must not cross contexts'));
    await oldPending;
    expect(switched.error()).toBe('');
  });

  it('focuses Close when empty, traps Tab across actions and Close, and returns Escape to the opener', () => {
    let keydown!: (event: any) => void;
    const document: any = { activeElement: null };
    const focusable = (name: string) => ({ hidden: false, disabled: false, name, focus: vi.fn(function (this: any) {
      document.activeElement = this;
    }) });
    const action = focusable('action');
    const close = focusable('close');
    const opener = focusable('opener');
    const dialog: any = { querySelectorAll: vi.fn(() => [action, close]),
      addEventListener: vi.fn((_name, listener) => { keydown = listener; }) };
    const root: any = { hidden: true, ownerDocument: document, replaceChildren: vi.fn(),
      querySelector: vi.fn(() => null) };
    let drawer: ReturnType<typeof createAgentControlDrawer>;
    const onClose = vi.fn(() => drawer.close());
    drawer = createAgentControlDrawer({ root, dialog, closeButton: close, opener,
      onClose, onGrant: vi.fn(), onDeny: vi.fn(), onApprove: vi.fn(), onRevoke: vi.fn() });
    drawer.open();
    expect(close.focus).toHaveBeenCalled();
    document.activeElement = close;
    const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    keydown(tab);
    expect(action.focus).toHaveBeenCalled();
    document.activeElement = action;
    keydown({ key: 'Tab', shiftKey: true, preventDefault: vi.fn() });
    expect(close.focus).toHaveBeenCalledTimes(2);
    const escape = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    keydown(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(opener.focus).toHaveBeenCalled();
  });
});

describe('native agent control shell contracts', () => {
  it('ships the persistent drawer, exact limitation copy, badges, and typed wiring', () => {
    const html = source('index.html');
    const css = source('styles.css');
    const main = source('main.js');
    const entry = source('control/control-entry.js');
    expect(html).toContain('id="agent-control-toggle"');
    expect(html).toContain('id="agent-control-drawer"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Application-defined effects behind a generic click cannot be perfectly predicted.');
    expect(css).toContain('.agent-control-badge');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(main).toContain('control_state');
    expect(main).toContain('control_operator_submit');
    expect(main).toContain('window.PsycheControl.createAgentControlPoller');
    expect(main).toMatch(/captureContext: captureAgentControlContext[\s\S]*contextMatches: agentControlContextMatches/);
    expect(main).toMatch(/visibilitychange[\s\S]*handleVisibilityChange|handleVisibilityChange[\s\S]*visibilitychange/);
    expect(main).toMatch(/document\.hidden[\s\S]*stopAgentControlPolling[\s\S]*startAgentControlPolling/);
    expect(main).toMatch(/beforeunload[\s\S]*stopAgentControlPolling/);
    expect(main).toMatch(/event\.defaultPrevented\) return/);
    expect(main).toContain('fetchError: "Agent control state is temporarily unavailable"');
    expect(main).toMatch(/function invalidateAgentControlContext/);
    expect(main).toMatch(/function selectAgentControlWorktree[\s\S]*invalidateAgentControlContext[\s\S]*project\.selectedWorktreePath = worktreePath[\s\S]*scheduleAgentControlRefresh/);
    expect(main).toMatch(/function activatePaneLayoutFocus[\s\S]*selectAgentControlWorktree\(project, worktreePath\)/);
    expect(main).toMatch(/function refreshProjectWorktrees[\s\S]*selectAgentControlWorktree\(project,\s*selected \? selected\.path : project\.root/);
    expect(main).toMatch(/async function setActiveProject[\s\S]*invalidateAgentControlContext/);
    expect(main).toMatch(/async function focusThread[\s\S]*invalidateAgentControlContext/);
    expect(main).toMatch(/async function removeProject[\s\S]*invalidateAgentControlContext/);
    expect(main).toContain('function resetBrowserControlProvider(projectRoot)');
    expect(main).not.toMatch(/agentControlDrawerEl\.addEventListener\("keydown"/);
    expect(main).toMatch(/response\.code[\s\S]*response\.message/);
    expect(main).not.toMatch(/control_operator_submit[\s\S]{0,800}actionPayload/);
    expect(entry).toContain('normalizeAgentControlState');
    expect(entry).toContain('createAgentControlDrawer');
    expect(entry).toContain('createAgentControlPoller');
    const drawer = source('control/agent-control-drawer.mjs');
    expect(drawer).toMatch(/\['Approval', item\.approvalId\]/);
    expect(drawer).toMatch(/\['Digest', item\.payloadDigest\]/);
    expect(drawer).toContain('focusTargets = new Map');
    expect(drawer).not.toContain('querySelector(`[data-control-focus="${focusKey}"]`)');
    expect(drawer).toContain('Revoke lease · all ${count} resources');
    const boot = main.slice(main.lastIndexOf('async function boot'));
    expect(boot).toMatch(/startCovenPolling\(\);\s*startAgentControlPolling\(\);/);
  });
});
