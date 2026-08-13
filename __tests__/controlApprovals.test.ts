import { describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  type ApprovalConsumeAssertion,
  type ApprovalRequest,
} from '../src/control/approvals.js';
import { AGENT_CONTROL_LIMITS } from '../src/control/limits.js';

const baseRequest = (): ApprovalRequest => ({
  actionId: 'action-1',
  ownerEpoch: 7,
  leaseId: 'lease-1',
  leaseRevision: 2,
  resource: { kind: 'browser_tab', id: 'tab-1', generation: 3 },
  capability: 'browser.interact',
  effect: { kind: 'submit', target: 'Create issue' },
});

const assertionFor = (
  approval: ReturnType<ApprovalStore['request']>,
  overrides: Partial<ApprovalConsumeAssertion> = {},
): ApprovalConsumeAssertion => ({
  approvalId: approval.id,
  payloadDigest: approval.payloadDigest,
  actionId: approval.actionId,
  ownerEpoch: approval.ownerEpoch,
  leaseId: approval.leaseId,
  leaseRevision: approval.leaseRevision,
  resource: approval.resource,
  capability: approval.capability,
  effect: approval.effect,
  ...overrides,
});

function assertConsumeRequiresCompleteIntent(
  store: ApprovalStore,
  approval: ReturnType<ApprovalStore['request']>,
): void {
  // @ts-expect-error Digest-only consumption must not be available.
  store.consume(approval.id, approval.payloadDigest);
  // @ts-expect-error The current normalized effect identity is mandatory.
  store.consume({
    approvalId: approval.id,
    payloadDigest: approval.payloadDigest,
    actionId: approval.actionId,
    ownerEpoch: approval.ownerEpoch,
    leaseId: approval.leaseId,
    leaseRevision: approval.leaseRevision,
    resource: approval.resource,
    capability: approval.capability,
  });
  // @ts-expect-error The current owner epoch is mandatory.
  store.consume({ ...assertionFor(approval), ownerEpoch: undefined });
}
void assertConsumeRequiresCompleteIntent;

type RequiredConsumeField =
  | 'approvalId'
  | 'payloadDigest'
  | 'actionId'
  | 'ownerEpoch'
  | 'leaseId'
  | 'leaseRevision'
  | 'resource'
  | 'capability'
  | 'effect';
type OmissionIsRejected<K extends RequiredConsumeField> =
  Omit<ApprovalConsumeAssertion, K> extends ApprovalConsumeAssertion ? never : true;
const requiredConsumeFields: { readonly [K in RequiredConsumeField]: OmissionIsRejected<K> } = {
  approvalId: true,
  payloadDigest: true,
  actionId: true,
  ownerEpoch: true,
  leaseId: true,
  leaseRevision: true,
  resource: true,
  capability: true,
  effect: true,
};
void requiredConsumeFields;

describe('ApprovalStore', () => {
  it('creates a deterministic digest and consumes an operator approval once', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());

    expect(pending.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pending.payloadDigest).toBe(
      '094c6ccd0b81b4457f4d053873f20b789c56b6d0e76c3d3b6ce53e94065fa510',
    );
    expect(store.request(baseRequest()).payloadDigest).toBe(pending.payloadDigest);
    expect(store.approve(pending.id, 'operator', pending.payloadDigest).status).toBe('approved');
    expect(() => store.consume(assertionFor(pending))).not.toThrow();
    expect(() => store.consume(assertionFor(pending))).toThrowError(
      expect.objectContaining({ code: 'approval_denied' }),
    );
  });

  it.each([
    ['action id', { actionId: 'action-2' }],
    ['owner epoch', { ownerEpoch: 8 }],
    ['lease id', { leaseId: 'lease-2' }],
    ['lease revision', { leaseRevision: 3 }],
    ['resource id', { resource: { kind: 'browser_tab', id: 'tab-2', generation: 3 } }],
    ['resource generation', { resource: { kind: 'browser_tab', id: 'tab-1', generation: 4 } }],
    ['capability', { capability: 'browser.close' }],
    ['redacted effect', { effect: { kind: 'submit', target: 'Merge pull request' } }],
  ] as const)('changes the digest when %s changes', (_label, override) => {
    const clock = () => new Date('2026-08-12T12:00:00.000Z');
    const original = new ApprovalStore(clock).request(baseRequest());
    const changed = new ApprovalStore(clock).request({ ...baseRequest(), ...override } as ApprovalRequest);
    expect(changed.payloadDigest).not.toBe(original.payloadDigest);
  });

  it.each([
    ['owner epoch', { ownerEpoch: 8 }],
    ['lease id', { leaseId: 'lease-2' }],
    ['lease revision', { leaseRevision: 3 }],
    ['resource generation', { resource: { kind: 'browser_tab', id: 'tab-1', generation: 4 } }],
    ['capability', { capability: 'browser.close' }],
  ] as const)('revalidates %s at consumption', (_label, override) => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    store.approve(pending.id, 'operator', pending.payloadDigest);

    expect(() => store.consume(
      assertionFor(pending, override as Partial<ApprovalConsumeAssertion>),
    )).toThrowError(expect.objectContaining({ code: 'approval_identity_mismatch' }));
  });

  it.each<RequiredConsumeField>([
    'approvalId',
    'payloadDigest',
    'actionId',
    'ownerEpoch',
    'leaseId',
    'leaseRevision',
    'resource',
    'capability',
    'effect',
  ])('fails closed when the runtime assertion omits %s', (field) => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    store.approve(pending.id, 'operator', pending.payloadDigest);
    const incomplete = { ...assertionFor(pending) } as Record<string, unknown>;
    delete incomplete[field];

    expect(() => store.consume(incomplete as unknown as ApprovalConsumeAssertion)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^approval_/) }),
    );
  });

  it.each([
    ['action id', { actionId: 'action-2' }],
    ['redacted effect', 'Merge pull request'],
  ] as const)('revalidates the current %s at consumption', (_label, override) => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    const changedEffect = store.request({
      ...baseRequest(),
      actionId: 'effect-probe',
      effect: { kind: 'submit', target: typeof override === 'string' ? override : 'Create issue' },
    }).effect;
    store.approve(pending.id, 'operator', pending.payloadDigest);

    const assertionOverride = typeof override === 'string'
      ? { effect: changedEffect }
      : override;
    expect(() => store.consume(
      assertionFor(pending, assertionOverride as Partial<ApprovalConsumeAssertion>),
    )).toThrowError(expect.objectContaining({ code: 'approval_digest_mismatch' }));
  });

  it('rejects a changed digest at approval and consumption', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    const wrongDigest = '0'.repeat(64);
    expect(() => store.approve(pending.id, 'operator', wrongDigest)).toThrowError(
      expect.objectContaining({ code: 'approval_digest_mismatch' }),
    );
    store.approve(pending.id, 'operator', pending.payloadDigest);
    expect(() => store.consume(assertionFor(pending, { payloadDigest: wrongDigest }))).toThrowError(
      expect.objectContaining({ code: 'approval_digest_mismatch' }),
    );
  });

  it('denies explicitly and permits only pending approvals to transition', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    expect(store.deny(pending.id, 'operator', pending.payloadDigest).status).toBe('denied');
    expect(() => store.consume(assertionFor(pending))).toThrowError(
      expect.objectContaining({ code: 'approval_denied' }),
    );
    expect(() => store.approve(pending.id, 'operator', pending.payloadDigest)).toThrowError(
      expect.objectContaining({ code: 'approval_denied' }),
    );
  });

  it.each(['approve', 'deny'] as const)('requires an operator identity to %s', (transition) => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());

    expect(() => store[transition](pending.id, '', pending.payloadDigest)).toThrowError(
      expect.objectContaining({ code: 'approval_identity_mismatch' }),
    );
    expect(store.snapshot()[0].status).toBe('pending');
  });

  it('expires at the exact five-minute boundary', () => {
    let now = Date.parse('2026-08-12T12:00:00.000Z');
    const store = new ApprovalStore(() => new Date(now));
    const pending = store.request(baseRequest());
    store.approve(pending.id, 'operator', pending.payloadDigest);
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt))
      .toBe(AGENT_CONTROL_LIMITS.approvalTtlMs);
    now += AGENT_CONTROL_LIMITS.approvalTtlMs - 1;
    expect(store.snapshot()[0].status).toBe('approved');
    now += 1;
    expect(store.expire()).toEqual([expect.objectContaining({ id: pending.id, status: 'expired' })]);
    expect(() => store.consume(assertionFor(pending))).toThrowError(
      expect.objectContaining({ code: 'approval_expired' }),
    );
  });

  it('revokes approvals for a lease and all approvals fail closed', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const first = store.request(baseRequest());
    const second = store.request({ ...baseRequest(), actionId: 'action-2', leaseId: 'lease-2' });
    store.approve(first.id, 'operator', first.payloadDigest);
    store.approve(second.id, 'operator', second.payloadDigest);
    expect(store.revokeForLease('lease-1')).toEqual([
      expect.objectContaining({ id: first.id, status: 'revoked' }),
    ]);
    expect(() => store.consume(assertionFor(first))).toThrowError(
      expect.objectContaining({ code: 'approval_denied' }),
    );
    expect(store.revokeAll()).toEqual([
      expect.objectContaining({ id: second.id, status: 'revoked' }),
    ]);
    expect(() => store.consume(assertionFor(second))).toThrowError(
      expect.objectContaining({ code: 'approval_denied' }),
    );
  });

  it('uses stable missing errors', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    expect(() => store.consume(assertionFor(pending, { approvalId: 'missing' }))).toThrowError(
      expect.objectContaining({ code: 'approval_missing' }),
    );
  });

  it('returns the same approval for an identical action retry', () => {
    const ids = ['approval-1', 'approval-2'];
    const store = new ApprovalStore(
      () => new Date('2026-08-12T12:00:00.000Z'),
      () => ids.shift() ?? 'unexpected-id',
    );
    const first = store.request(baseRequest());
    const retry = store.request(baseRequest());

    expect(retry).toBe(first);
    expect(store.snapshot()).toEqual([first]);
    expect(ids).toEqual(['approval-2']);
  });

  it('rejects conflicting action id reuse with a stable code', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    store.request(baseRequest());
    expect(() => store.request({
      ...baseRequest(),
      effect: { kind: 'submit', target: 'Changed intent' },
    })).toThrowError(expect.objectContaining({ code: 'approval_action_conflict' }));
  });

  it('rejects generated approval id collisions with a stable code', () => {
    const store = new ApprovalStore(
      () => new Date('2026-08-12T12:00:00.000Z'),
      () => 'same-approval-id',
    );
    store.request(baseRequest());
    expect(() => store.request({ ...baseRequest(), actionId: 'action-2' })).toThrowError(
      expect.objectContaining({ code: 'approval_id_collision' }),
    );
  });

  it('uses one clock reading for an approval transition', () => {
    const base = Date.parse('2026-08-12T12:00:00.000Z');
    const readings = [
      base,
      base + AGENT_CONTROL_LIMITS.approvalTtlMs - 1,
      base + AGENT_CONTROL_LIMITS.approvalTtlMs + 1,
    ];
    const store = new ApprovalStore(() => new Date(readings.shift()!));
    const pending = store.request(baseRequest());
    const approved = store.approve(pending.id, 'operator', pending.payloadDigest);

    expect(approved.resolvedAt).toBe(new Date(base + AGENT_CONTROL_LIMITS.approvalTtlMs - 1).toISOString());
    expect(readings).toEqual([base + AGENT_CONTROL_LIMITS.approvalTtlMs + 1]);
  });

  it.each([
    ['owner epoch', { ownerEpoch: -1 }],
    ['owner epoch fraction', { ownerEpoch: 1.5 }],
    ['owner epoch unsafe', { ownerEpoch: Number.MAX_SAFE_INTEGER + 1 }],
    ['lease revision', { leaseRevision: Number.NaN }],
    ['resource generation', { resource: { kind: 'browser_tab', id: 'tab-1', generation: Infinity } }],
    ['empty action id', { actionId: '' }],
    ['empty lease id', { leaseId: '' }],
    ['empty resource id', { resource: { kind: 'browser_tab', id: '', generation: 3 } }],
    ['unknown capability', { capability: 'browser.unknown' }],
    ['unknown effect', { effect: { kind: 'future_effect', target: 'target' } }],
  ] as const)('rejects invalid %s with a stable identity code', (_label, override) => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    expect(() => store.request({ ...baseRequest(), ...override } as ApprovalRequest)).toThrowError(
      expect.objectContaining({ code: 'approval_identity_mismatch' }),
    );
  });

  it.each([
    'typedValue',
    'script',
    'terminalOutput',
    'pageText',
    'cookie',
    'header',
    'filePath',
    'arbitraryExtra',
  ])('rejects unsafe or unknown approval field %s', (field) => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));

    for (const request of [
      { ...baseRequest(), [field]: 'SENSITIVE_VALUE' },
      {
        ...baseRequest(),
        effect: { ...baseRequest().effect, [field]: 'SENSITIVE_VALUE' },
      },
    ]) {
      expect(() => store.request(request as ApprovalRequest)).toThrowError(
        expect.objectContaining({ code: 'approval_payload_invalid' }),
      );
    }
    expect(store.snapshot()).toEqual([]);
  });

  it('binds consumption to the exact validated redacted effect', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    const changed = store.request({
      ...baseRequest(),
      actionId: 'changed-probe',
      effect: { kind: 'submit', target: 'Changed target' },
    });
    store.approve(pending.id, 'operator', pending.payloadDigest);

    expect(changed.effect).not.toEqual(pending.effect);
    expect(() => store.consume(assertionFor(pending, { effect: changed.effect }))).toThrowError(
      expect.objectContaining({ code: 'approval_digest_mismatch' }),
    );
  });

  it('returns deeply immutable approvals and snapshots without caller aliases', () => {
    const request = baseRequest();
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(request);
    const snapshot = store.snapshot();

    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.resource)).toBe(true);
    expect(Object.isFrozen(pending.effect)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    (request.resource as { id: string }).id = 'caller-mutated';
    (request.effect as { target: string }).target = 'caller-mutated';
    expect(pending.resource.id).toBe('tab-1');
    expect(pending.effect).toEqual({ kind: 'submit', target: 'Create issue' });
  });
});
