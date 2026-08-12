import { describe, expect, it } from 'vitest';
import {
  ApprovalStore,
  digestActionPayload,
  type ApprovalConsumeAssertion,
  type ApprovalRequest,
} from '../src/control/approvals.js';
import { AGENT_CONTROL_LIMITS } from '../src/control/limits.js';

const baseActionPayload = () => ({
  snapshotId: 'snapshot-1',
  action: { kind: 'submit', elementRef: 'button-1' },
});

const baseRequest = (): ApprovalRequest => ({
  actionId: 'action-1',
  ownerEpoch: 7,
  leaseId: 'lease-1',
  leaseRevision: 2,
  resource: { kind: 'browser_tab', id: 'tab-1', generation: 3 },
  capability: 'browser.interact',
  effect: { kind: 'submit', target: 'Create issue' },
  actionPayload: baseActionPayload(),
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
  actionPayload: baseActionPayload(),
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
    actionPayload: baseActionPayload(),
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
  | 'actionPayload';
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
  actionPayload: true,
};
void requiredConsumeFields;
const consumeHasNoCallerDigest: 'actionPayloadDigest' extends keyof ApprovalConsumeAssertion
  ? never
  : true = true;
void consumeHasNoCallerDigest;

function assertConsumeRejectsCallerDigest(
  store: ApprovalStore,
  approval: ReturnType<ApprovalStore['request']>,
): void {
  store.consume({
    ...assertionFor(approval),
    // @ts-expect-error Caller-supplied action digests are not authorization inputs.
    actionPayloadDigest: approval.actionPayloadDigest,
  });
}
void assertConsumeRejectsCallerDigest;

function collectSensitiveStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return /[A-Z][A-Z_]+|\/private\//.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(collectSensitiveStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectSensitiveStrings);
  }
  return [];
}

describe('ApprovalStore', () => {
  it('creates a deterministic digest and consumes an operator approval once', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request(baseRequest());

    expect(pending.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
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
    ['action payload', { actionPayload: { changed: true } }],
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
    'actionPayload',
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
      actionPayload: { changed: true },
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

  it('canonically hashes JSON payloads without key-order dependence', () => {
    expect(digestActionPayload({ b: [true, null, 'x'], a: 1 }))
      .toBe(digestActionPayload({ a: 1, b: [true, null, 'x'] }));
  });

  it('hashes normal, deeply frozen, and sealed dense arrays identically', () => {
    const normal = [1, { a: [2] }];
    const frozen = Object.freeze([
      1,
      Object.freeze({ a: Object.freeze([2]) }),
    ]);
    const sealedNested = Object.seal([2]);
    const sealedObject = Object.seal({ a: sealedNested });
    const sealed = Object.seal([1, sealedObject]);

    expect(digestActionPayload(frozen)).toBe(digestActionPayload(normal));
    expect(digestActionPayload(sealed)).toBe(digestActionPayload(normal));
  });

  it('losslessly distinguishes lone surrogates from replacement characters', () => {
    expect(digestActionPayload({ text: '\uD800' }))
      .not.toBe(digestActionPayload({ text: '\uFFFD' }));
    const first = new ApprovalStore().request({ ...baseRequest(), effect: { kind: 'submit', target: '\uD800' } });
    const second = new ApprovalStore().request({ ...baseRequest(), effect: { kind: 'submit', target: '\uFFFD' } });
    expect(first.effect.targetDigest).not.toBe(second.effect.targetDigest);
  });

  it.each([
    undefined,
    Number.NaN,
    Infinity,
    1n,
    Symbol('unsupported'),
    () => 'unsupported',
    { value: undefined },
    new Date('2026-08-12T12:00:00.000Z'),
  ])('rejects unsupported non-JSON action payload value %#', (payload) => {
    expect(() => digestActionPayload(payload)).toThrowError(
      expect.objectContaining({ code: 'approval_payload_invalid' }),
    );
  });

  it.each([
    'accessor index',
    'symbol property',
    'non-enumerable extra',
  ] as const)(
    'rejects canonical arrays with %s',
    (variant) => {
      const payload = ['safe'];
      if (variant === 'accessor index') {
        Object.defineProperty(payload, '0', { get: () => 'unsafe', enumerable: true });
      } else if (variant === 'symbol property') {
        Object.defineProperty(payload, Symbol('unsafe'), { value: true });
      } else {
        Object.defineProperty(payload, 'hidden', { value: 'unsafe', enumerable: false });
      }
      expect(() => digestActionPayload(payload)).toThrowError(
        expect.objectContaining({ code: 'approval_payload_invalid' }),
      );
    },
  );

  it.each([
    ['typed secret text', { snapshotId: 'snap', action: { kind: 'type', elementRef: 'field', text: 'SECRET_TEXT_A' } }, { snapshotId: 'snap', action: { kind: 'type', elementRef: 'field', text: 'SECRET_TEXT_B' } }],
    ['script source', { source: 'SCRIPT_SOURCE_A', args: null }, { source: 'SCRIPT_SOURCE_B', args: null }],
    ['upload path', { snapshotId: 'snap', action: { kind: 'upload', elementRef: 'upload', path: '/private/UPLOAD_PATH_A' } }, { snapshotId: 'snap', action: { kind: 'upload', elementRef: 'upload', path: '/private/UPLOAD_PATH_B' } }],
    ['download path', { snapshotId: 'snap', action: { kind: 'download', elementRef: 'download', destination: '/private/DOWNLOAD_PATH_A' } }, { snapshotId: 'snap', action: { kind: 'download', elementRef: 'download', destination: '/private/DOWNLOAD_PATH_B' } }],
    ['permission decision', { action: { kind: 'permission_response', permission: 'camera', origin: 'https://ORIGIN_A.test', decision: 'deny' } }, { action: { kind: 'permission_response', permission: 'camera', origin: 'https://ORIGIN_A.test', decision: 'allow' } }],
    ['permission origin', { action: { kind: 'permission_response', permission: 'camera', origin: 'https://ORIGIN_A.test', decision: 'deny' } }, { action: { kind: 'permission_response', permission: 'camera', origin: 'https://ORIGIN_B.test', decision: 'deny' } }],
    ['snapshot id', { snapshotId: 'SNAPSHOT_A', action: { kind: 'click', elementRef: 'button' } }, { snapshotId: 'SNAPSHOT_B', action: { kind: 'click', elementRef: 'button' } }],
    ['element ref', { snapshotId: 'snap', action: { kind: 'click', elementRef: 'ELEMENT_A' } }, { snapshotId: 'snap', action: { kind: 'click', elementRef: 'ELEMENT_B' } }],
  ] as const)('binds and discards raw %s', (_label, originalPayload, changedPayload) => {
    const originalActionDigest = digestActionPayload(originalPayload);
    const changedActionDigest = digestActionPayload(changedPayload);
    const originalStore = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = originalStore.request({ ...baseRequest(), actionPayload: originalPayload });
    originalStore.approve(pending.id, 'operator', pending.payloadDigest);
    const changed = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z')).request({
      ...baseRequest(),
      actionPayload: changedPayload,
    });

    expect(changedActionDigest).not.toBe(originalActionDigest);
    expect(changed.payloadDigest).not.toBe(pending.payloadDigest);
    expect(() => originalStore.consume(assertionFor(pending, {
      actionPayload: changedPayload,
    }))).toThrowError(expect.objectContaining({ code: 'approval_digest_mismatch' }));
    const serialized = JSON.stringify({ pending, snapshot: originalStore.snapshot() });
    for (const marker of collectSensitiveStrings(originalPayload)) expect(serialized).not.toContain(marker);
  });

  it('recomputes the current payload and ignores a forged stored digest field', () => {
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const pending = store.request({ ...baseRequest(), actionPayload: { text: 'PAYLOAD_A' } });
    store.approve(pending.id, 'operator', pending.payloadDigest);
    const forged = {
      ...assertionFor(pending, { actionPayload: { text: 'PAYLOAD_B' } }),
      actionPayloadDigest: pending.actionPayloadDigest,
    } as ApprovalConsumeAssertion;

    expect(() => store.consume(forged)).toThrowError(
      expect.objectContaining({ code: 'approval_digest_mismatch' }),
    );
    expect(JSON.stringify(store.snapshot())).not.toContain('PAYLOAD_A');
    expect(JSON.stringify(store.snapshot())).not.toContain('PAYLOAD_B');
  });

  it('hashes then discards adversarial display targets and all extra keys', () => {
    const unsafeTargets = [
      '/Users/valentina/private/SENSITIVE_UPLOAD_PATH.txt',
      'password=SENSITIVE_PASSWORD page text SENSITIVE_PAGE_TEXT',
      'Authorization: Bearer SENSITIVE_HEADER_VALUE',
      'Cookie: session=SENSITIVE_COOKIE_VALUE',
      'document.cookie; SENSITIVE_SCRIPT_SOURCE',
    ];
    const store = new ApprovalStore(() => new Date('2026-08-12T12:00:00.000Z'));
    const approvals = unsafeTargets.map((target, index) => store.request({
      ...baseRequest(),
      actionId: `unsafe-${index}`,
      effect: {
        kind: 'submit',
        target,
        rawPayload: `SENSITIVE_RAW_PAYLOAD_${index}`,
      },
      typedValue: `SENSITIVE_TYPED_VALUE_${index}`,
      terminalOutput: `SENSITIVE_TERMINAL_OUTPUT_${index}`,
      headers: { Authorization: `SENSITIVE_EXTRA_HEADER_${index}` },
    } as ApprovalRequest));
    const serialized = JSON.stringify({ approvals, snapshot: store.snapshot() });

    for (const marker of [
      ...unsafeTargets,
      'SENSITIVE_RAW_PAYLOAD',
      'SENSITIVE_TYPED_VALUE',
      'SENSITIVE_TERMINAL_OUTPUT',
      'SENSITIVE_EXTRA_HEADER',
    ]) {
      expect(serialized).not.toContain(marker);
    }
    for (const approval of approvals) {
      expect(approval.effect).toEqual({
        kind: 'submit',
        targetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(approval.effect).not.toHaveProperty('target');
    }
  });

  it('binds consumption to the normalized digest of the exact display target', () => {
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
    expect(pending.effect).toEqual({
      kind: 'submit',
      targetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
