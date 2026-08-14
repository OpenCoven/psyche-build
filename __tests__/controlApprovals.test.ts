import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ACTIVE_LIMIT,
  APPROVAL_TERMINAL_LIMIT,
  ApprovalStore,
  createRedactedApprovalEffect,
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
  effect: createRedactedApprovalEffect({ kind: 'submit', target: 'Create issue' }),
  executablePayloadDigest: 'b'.repeat(64),
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
  executablePayloadDigest: approval.executablePayloadDigest,
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
  | 'effect'
  | 'executablePayloadDigest';
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
  executablePayloadDigest: true,
};
void requiredConsumeFields;

describe('ApprovalStore', () => {
  it('creates a deterministic digest and consumes an operator approval once', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());

    expect(pending.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pending.payloadDigest).toBe(
      '2e738149fbe162c5ac8b14a39ccce67c402c6238634a29476a2923b4320c7fa3',
    );
    expect(store.request(baseRequest()).payloadDigest).toBe(pending.payloadDigest);
    expect(store.approve(pending.id, 'operator', pending.payloadDigest).status).toBe('approved');
    expect(() => store.consume(assertionFor(pending))).not.toThrow();
    expect(() => store.consume(assertionFor(pending))).toThrowError(
      expect.objectContaining({ code: 'approval_denied' }),
    );
  });

  it.each(['script source', 'secret text', 'same-basename path', 'permission decision'])(
    'rejects same-action substitution for changed %s hash',
    () => {
      const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
      store.request(baseRequest());
      expect(() => store.request({ ...baseRequest(), executablePayloadDigest: 'c'.repeat(64) }))
        .toThrowError(expect.objectContaining({ code: 'approval_action_conflict' }));
      expect(store.peek()).toHaveLength(1);
    },
  );

  it('keeps permission decisions visibly distinct while sanitizing origins', () => {
    const allow = createRedactedApprovalEffect({
      kind: 'permission_response',
      target: 'allow camera for https://user:pass@example.test/path?token=secret#fragment',
    });
    const deny = createRedactedApprovalEffect({
      kind: 'permission_response',
      target: 'deny camera for https://user:pass@example.test/path?token=secret#fragment',
    });
    expect(allow.target).toBe('allow camera for https://example.test/path');
    expect(deny.target).toBe('deny camera for https://example.test/path');
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const allowed = store.request({ ...baseRequest(), actionId: 'allow', effect: allow });
    const denied = store.request({ ...baseRequest(), actionId: 'deny', effect: deny });
    expect(allowed.payloadDigest).not.toBe(denied.payloadDigest);
  });

  it.each([
    'allow camera token=supersecret for https://example.test',
    'allow camera\ntoken for https://example.test',
    'allow camera\u0000token for https://example.test',
    `allow ${'a'.repeat(65)} for https://example.test`,
    'allow camera;download for https://example.test',
  ])('redacts unsafe permission label %j', (target) => {
    expect(createRedactedApprovalEffect({ kind: 'permission_response', target }).target)
      .toBe('[redacted]');
  });

  it.each([
    ['action id', { actionId: 'action-2' }],
    ['owner epoch', { ownerEpoch: 8 }],
    ['lease id', { leaseId: 'lease-2' }],
    ['lease revision', { leaseRevision: 3 }],
    ['resource id', { resource: { kind: 'browser_tab', id: 'tab-2', generation: 3 } }],
    ['resource generation', { resource: { kind: 'browser_tab', id: 'tab-1', generation: 4 } }],
    ['capability', { capability: 'browser.close' }],
    ['redacted effect', {
      effect: createRedactedApprovalEffect({ kind: 'submit', target: 'Merge pull request' }),
    }],
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
      effect: createRedactedApprovalEffect({
        kind: 'submit',
        target: typeof override === 'string' ? override : 'Create issue',
      }),
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

  it('peeks without causing an implicit expiry transition', () => {
    let now = Date.parse('2026-08-12T12:00:00.000Z');
    const store = new ApprovalStore(() => new Date(now));
    const pending = store.request(baseRequest());
    now += AGENT_CONTROL_LIMITS.approvalTtlMs;
    expect(store.peek()).toEqual([pending]);
    expect(store.expire()).toEqual([expect.objectContaining({ id: pending.id, status: 'expired' })]);
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
      effect: createRedactedApprovalEffect({ kind: 'submit', target: 'Changed intent' }),
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
  ])('rejects unsafe or unknown effect factory field %s', (field) => {
    expect(() => createRedactedApprovalEffect({
      kind: 'submit', target: 'safe label', [field]: 'SENSITIVE_VALUE',
    } as never)).toThrowError(
      expect.objectContaining({ code: 'approval_payload_invalid' }),
    );
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    expect(() => store.request({
      ...baseRequest(), [field]: 'SENSITIVE_VALUE',
    } as ApprovalRequest)).toThrowError(
      expect.objectContaining({ code: 'approval_payload_invalid' }),
    );
  });

  it('rejects raw, cloned, accessor-backed, and prototype-backed effects', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const canonical = createRedactedApprovalEffect({ kind: 'submit', target: 'Create issue' });
    const accessor = { kind: 'submit' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'target', { enumerable: true, get: () => 'stolen page text' });
    const candidates = [
      { kind: 'submit', target: 'Create issue' },
      { ...canonical },
      JSON.parse(JSON.stringify(canonical)),
      accessor,
      Object.assign(Object.create({ hidden: true }), { kind: 'submit', target: 'Create issue' }),
    ];

    for (const effect of candidates) {
      expect(() => store.request({ ...baseRequest(), effect } as ApprovalRequest)).toThrowError(
        expect.objectContaining({ code: 'approval_payload_invalid' }),
      );
    }
    expect(store.snapshot()).toEqual([]);
  });

  it.each([
    ['secret', 'password=hunter2 token=abc123', '[redacted]'],
    ['high entropy', 'AKIAIOSFODNN7EXAMPLE', '[redacted]'],
    ['script', 'document.cookie = window.localStorage.token', '[redacted]'],
    ['page text', 'Account settings\nEmail val@example.test\nPrivate content', '[redacted]'],
    ['url', 'https://alice:secret@example.test/path?token=secret#private', 'https://example.test/path'],
    ['url path token', 'https://example.test/AKIAIOSFODNN7EXAMPLE?view=1', '[redacted]'],
    ['upload path', '/Users/val/private/report.txt', 'report.txt'],
    ['download path', 'C:\\Users\\val\\private\\report.zip', 'report.zip'],
    ['controls', 'Close\u0000\u0007 tab', 'Close tab'],
  ] as const)('normalizes adversarial %s targets without retaining source payload', (_label, target, expected) => {
    const kind = _label === 'upload path'
      ? 'upload'
      : _label === 'download path'
        ? 'download'
        : 'submit';
    const effect = createRedactedApprovalEffect({ kind, target });
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const approval = store.request({ ...baseRequest(), effect });

    expect(approval.effect).toEqual({ kind, target: expected });
    expect(JSON.stringify(store.snapshot())).not.toContain(target);
  });

  it.each([
    ['script', 'alert(1)', '[redacted]'],
    ['secret_input', 'hunter2', '[redacted]'],
    ['upload', 'private/customer/report.txt', 'report.txt'],
    ['download', 'private\\customer\\report.zip', 'report.zip'],
  ] as const)('strictly redacts %s target %s', (kind, target, expected) => {
    const effect = createRedactedApprovalEffect({ kind, target });
    expect(effect).toEqual({ kind, target: expected });
  });

  it('caps normalized targets by UTF-8 bytes', () => {
    const effect = createRedactedApprovalEffect({ kind: 'submit', target: 'é'.repeat(400) });
    expect(Buffer.byteLength(effect.target, 'utf8')).toBeLessThanOrEqual(
      AGENT_CONTROL_LIMITS.accessibleNameBytes,
    );
  });

  it('rejects new active approvals at the fixed capacity without growing state', () => {
    const store = new ApprovalStore(
      () => new Date('2026-08-12T12:00:00.000Z'),
      (() => { let id = 0; return () => `approval-${id++}`; })(),
    );
    for (let index = 0; index < APPROVAL_ACTIVE_LIMIT; index += 1) {
      store.request({ ...baseRequest(), actionId: `action-${index}` });
    }

    expect(() => store.request({ ...baseRequest(), actionId: 'over-capacity' })).toThrowError(
      expect.objectContaining({ code: 'approval_capacity_exceeded' }),
    );
    expect(store.snapshot()).toHaveLength(APPROVAL_ACTIVE_LIMIT);
  });

  it('retains a bounded terminal idempotency window and evicts both indexes together', () => {
    let id = 0;
    const store = new ApprovalStore(
      () => new Date('2026-08-12T12:00:00.000Z'),
      () => `approval-${id++}`,
    );
    const active = store.request({ ...baseRequest(), actionId: 'active' });
    let last!: ReturnType<ApprovalStore['request']>;
    for (let index = 0; index <= APPROVAL_TERMINAL_LIMIT; index += 1) {
      const pending = store.request({ ...baseRequest(), actionId: `terminal-${index}` });
      last = store.deny(pending.id, 'operator', pending.payloadDigest);
    }

    expect(store.snapshot()).toHaveLength(APPROVAL_TERMINAL_LIMIT + 1);
    expect(store.request({ ...baseRequest(), actionId: 'active' })).toBe(active);
    expect(store.request({ ...baseRequest(), actionId: `terminal-${APPROVAL_TERMINAL_LIMIT}` }))
      .toBe(last);
    const replacement = store.request({ ...baseRequest(), actionId: 'terminal-0' });
    expect(replacement.id).not.toBe('approval-1');
    expect(store.snapshot()).toHaveLength(APPROVAL_TERMINAL_LIMIT + 2);
  });

  it('expires an identical retry at the exact TTL boundary before returning it', () => {
    let now = Date.parse('2026-08-12T12:00:00.000Z');
    const store = new ApprovalStore(() => new Date(now), () => 'approval-1');
    const pending = store.request(baseRequest());
    now += AGENT_CONTROL_LIMITS.approvalTtlMs;

    expect(store.request(baseRequest())).toEqual({ ...pending, status: 'expired' });
    expect(store.snapshot()).toEqual([expect.objectContaining({ id: pending.id, status: 'expired' })]);
  });

  it('binds consumption to the exact validated redacted effect', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());
    const changed = store.request({
      ...baseRequest(),
      actionId: 'changed-probe',
      effect: createRedactedApprovalEffect({ kind: 'submit', target: 'Changed target' }),
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
    expect(() => { (request.effect as { target: string }).target = 'caller-mutated'; }).toThrow();
    expect(pending.resource.id).toBe('tab-1');
    expect(pending.effect).toEqual({ kind: 'submit', target: 'Create issue' });
  });
});
