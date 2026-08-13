import { createHash, randomUUID } from 'node:crypto';
import type { LeaseTarget, SurfaceCapability } from './capabilityLeases.js';
import { AGENT_CONTROL_LIMITS } from './limits.js';

export type ApprovalErrorCode =
  | 'approval_missing'
  | 'approval_expired'
  | 'approval_denied'
  | 'approval_digest_mismatch'
  | 'approval_identity_mismatch'
  | 'approval_action_conflict'
  | 'approval_id_collision'
  | 'approval_payload_invalid';

export type ApprovalEffectKind =
  | 'submit'
  | 'secret_input'
  | 'upload'
  | 'download'
  | 'permission_response'
  | 'close'
  | 'script';

export type RedactedApprovalEffect =
  | { readonly kind: 'submit'; readonly target: string }
  | { readonly kind: 'secret_input'; readonly target: string }
  | { readonly kind: 'upload'; readonly target: string }
  | { readonly kind: 'download'; readonly target: string }
  | { readonly kind: 'permission_response'; readonly target: string }
  | { readonly kind: 'close'; readonly target: string }
  | { readonly kind: 'script'; readonly target: string };

export interface ApprovalRequest {
  readonly actionId: string;
  readonly ownerEpoch: number;
  readonly leaseId: string;
  readonly leaseRevision: number;
  readonly resource: LeaseTarget;
  readonly capability: SurfaceCapability;
  readonly effect: RedactedApprovalEffect;
}

interface ApprovalIdentity {
  readonly actionId: string;
  readonly ownerEpoch: number;
  readonly leaseId: string;
  readonly leaseRevision: number;
  readonly resource: LeaseTarget;
  readonly capability: SurfaceCapability;
  readonly effect: RedactedApprovalEffect;
}

export interface ApprovalConsumeAssertion {
  readonly approvalId: string;
  readonly payloadDigest: string;
  readonly actionId: string;
  readonly ownerEpoch: number;
  readonly leaseId: string;
  readonly leaseRevision: number;
  readonly resource: LeaseTarget;
  readonly capability: SurfaceCapability;
  readonly effect: RedactedApprovalEffect;
}

interface NormalizedApprovalConsumeAssertion extends ApprovalIdentity {
  readonly approvalId: string;
  readonly payloadDigest: string;
}

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'consumed'
  | 'expired'
  | 'revoked';

export interface Approval {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly actionId: string;
  readonly ownerEpoch: number;
  readonly leaseId: string;
  readonly leaseRevision: number;
  readonly resource: LeaseTarget;
  readonly capability: SurfaceCapability;
  readonly effect: RedactedApprovalEffect;
  readonly payloadDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
  readonly consumedAt?: string;
}

export class ApprovalStore {
  private readonly approvals = new Map<string, Approval>();
  private readonly approvalIdsByAction = new Map<string, string>();

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly generateId: () => string = randomUUID,
  ) {}

  request(input: ApprovalRequest): Approval {
    const now = this.clock();
    const identity = copyIdentity(input);
    const payloadDigest = digestIdentity(identity);
    const existingId = this.approvalIdsByAction.get(identity.actionId);
    if (existingId) {
      const existing = this.approvals.get(existingId);
      if (existing?.payloadDigest === payloadDigest) return existing;
      throw codedError('approval_action_conflict', 'action id was reused for another approval intent');
    }
    const id = this.generateId();
    if (!isNonemptyString(id) || this.approvals.has(id)) {
      throw codedError('approval_id_collision', 'generated approval id is invalid or already exists');
    }
    const approval = freezeApproval({
      id,
      status: 'pending',
      ...identity,
      payloadDigest,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AGENT_CONTROL_LIMITS.approvalTtlMs).toISOString(),
    });
    this.approvals.set(approval.id, approval);
    this.approvalIdsByAction.set(approval.actionId, approval.id);
    return approval;
  }

  approve(id: string, actorId: string, payloadDigest: string): Approval {
    return this.resolve(id, actorId, payloadDigest, 'approved');
  }

  deny(id: string, actorId: string, payloadDigest: string): Approval {
    return this.resolve(id, actorId, payloadDigest, 'denied');
  }

  consume(input: ApprovalConsumeAssertion): Approval {
    const now = this.clock();
    const assertion = copyAssertion(input);
    const approval = this.requireCurrent(assertion.approvalId, now);
    assertStoredDigest(approval);
    if (!assertionMatches(approval, assertion)) {
      throw codedError('approval_identity_mismatch', 'approval identity no longer matches');
    }
    const assertedDigest = digestIdentity(assertion);
    if (
      assertedDigest !== assertion.payloadDigest
      || assertedDigest !== approval.payloadDigest
    ) {
      throw codedError('approval_digest_mismatch', 'current approval intent digest mismatch');
    }
    if (approval.status !== 'approved') {
      throw codedError('approval_denied', 'approval is not available for consumption');
    }
    const consumed = freezeApproval({
      ...approval,
      status: 'consumed',
      consumedAt: now.toISOString(),
    });
    this.approvals.set(approval.id, consumed);
    return consumed;
  }

  expire(): readonly Approval[] {
    const now = this.clock();
    return this.expireAt(now);
  }

  private expireAt(now: Date): readonly Approval[] {
    const expired: Approval[] = [];
    for (const approval of this.approvals.values()) {
      if (isActive(approval) && Date.parse(approval.expiresAt) <= now.getTime()) {
        const replacement = freezeApproval({ ...approval, status: 'expired' });
        this.approvals.set(approval.id, replacement);
        expired.push(replacement);
      }
    }
    return Object.freeze(expired);
  }

  revokeForLease(leaseId: string): readonly Approval[] {
    const now = this.clock();
    return this.revokeWhere((approval) => approval.leaseId === leaseId, now);
  }

  revokeAll(): readonly Approval[] {
    const now = this.clock();
    return this.revokeWhere(() => true, now);
  }

  snapshot(): readonly Approval[] {
    const now = this.clock();
    this.expireAt(now);
    return Object.freeze([...this.approvals.values()]);
  }

  private resolve(
    id: string,
    actorId: string,
    payloadDigest: string,
    status: 'approved' | 'denied',
  ): Approval {
    const now = this.clock();
    if (!isNonemptyString(actorId) || actorId.trim().length === 0) {
      throw codedError('approval_identity_mismatch', 'operator identity is required');
    }
    const approval = this.requireCurrent(id, now);
    assertDigest(approval, payloadDigest);
    assertStoredDigest(approval);
    if (approval.status !== 'pending') {
      throw codedError('approval_denied', 'only pending approvals may be resolved');
    }
    const resolved = freezeApproval({
      ...approval,
      status,
      resolvedBy: actorId,
      resolvedAt: now.toISOString(),
    });
    this.approvals.set(id, resolved);
    return resolved;
  }

  private requireCurrent(id: string, now: Date): Approval {
    const approval = this.approvals.get(id);
    if (!approval) throw codedError('approval_missing', 'approval is missing');
    if (isActive(approval) && Date.parse(approval.expiresAt) <= now.getTime()) {
      const expired = freezeApproval({ ...approval, status: 'expired' });
      this.approvals.set(id, expired);
      throw codedError('approval_expired', 'approval expired');
    }
    if (approval.status === 'expired') {
      throw codedError('approval_expired', 'approval expired');
    }
    return approval;
  }

  private revokeWhere(predicate: (approval: Approval) => boolean, now: Date): readonly Approval[] {
    this.expireAt(now);
    const revoked: Approval[] = [];
    for (const approval of this.approvals.values()) {
      if (isActive(approval) && predicate(approval)) {
        const replacement = freezeApproval({ ...approval, status: 'revoked' });
        this.approvals.set(approval.id, replacement);
        revoked.push(replacement);
      }
    }
    return Object.freeze(revoked);
  }
}

function copyIdentity(input: ApprovalRequest): ApprovalIdentity {
  assertExactKeys(input, [
    'actionId', 'ownerEpoch', 'leaseId', 'leaseRevision', 'resource', 'capability', 'effect',
  ], 'approval request');
  assertIdentityFields(input);
  return {
    actionId: input.actionId,
    ownerEpoch: input.ownerEpoch,
    leaseId: input.leaseId,
    leaseRevision: input.leaseRevision,
    resource: copyTarget(input.resource),
    capability: input.capability,
    effect: copyEffect(input.effect),
  };
}

function copyAssertion(input: ApprovalConsumeAssertion): NormalizedApprovalConsumeAssertion {
  assertExactKeys(input, [
    'approvalId', 'payloadDigest', 'actionId', 'ownerEpoch', 'leaseId', 'leaseRevision',
    'resource', 'capability', 'effect',
  ], 'approval assertion');
  if (!isNonemptyString(input?.approvalId)) {
    throw codedError('approval_identity_mismatch', 'approval id is missing');
  }
  assertIdentityFields(input);
  if (!isSha256(input.payloadDigest)) {
    throw codedError('approval_digest_mismatch', 'approval payload digest is invalid');
  }
  return {
    approvalId: input.approvalId,
    payloadDigest: input.payloadDigest,
    actionId: input.actionId,
    ownerEpoch: input.ownerEpoch,
    leaseId: input.leaseId,
    leaseRevision: input.leaseRevision,
    resource: copyTarget(input.resource),
    capability: input.capability,
    effect: copyEffect(input.effect),
  };
}

const CAPABILITIES: ReadonlySet<SurfaceCapability> = new Set([
  'pane.observe', 'pane.input', 'pane.interrupt', 'pane.focus', 'pane.resize',
  'pane.create', 'pane.close', 'browser.inspect', 'browser.screenshot',
  'browser.navigate', 'browser.interact', 'browser.history', 'browser.close',
  'browser.script',
]);

function assertIdentityFields(input: ApprovalIdentity | ApprovalRequest | ApprovalConsumeAssertion): void {
  if (!isNonemptyString(input?.actionId) || !isNonemptyString(input?.leaseId)) {
    throw codedError('approval_identity_mismatch', 'approval action and lease ids must be nonempty');
  }
  if (!isAuthorityInteger(input.ownerEpoch) || !isAuthorityInteger(input.leaseRevision)) {
    throw codedError('approval_identity_mismatch', 'approval authority revisions must be safe integers');
  }
  if (!CAPABILITIES.has(input.capability)) {
    throw codedError('approval_identity_mismatch', 'approval capability is invalid');
  }
}

function copyTarget(target: LeaseTarget): LeaseTarget {
  assertPlainDataObject(target, 'approval resource');
  if (!isNonemptyString(target.id)) {
    throw codedError('approval_identity_mismatch', 'approval resource identity is missing');
  }
  if (target.kind === 'project') {
    assertExactKeys(target, ['kind', 'id'], 'approval resource');
    return Object.freeze({ kind: target.kind, id: target.id });
  }
  if (
    (target.kind !== 'pane' && target.kind !== 'browser_tab')
    || !isAuthorityInteger(target.generation)
  ) {
    throw codedError('approval_identity_mismatch', 'approval resource identity is invalid');
  }
  assertExactKeys(target, ['kind', 'id', 'generation'], 'approval resource');
  return Object.freeze({ kind: target.kind, id: target.id, generation: target.generation });
}

function copyEffect(effect: RedactedApprovalEffect): RedactedApprovalEffect {
  assertExactKeys(effect, ['kind', 'target'], 'approval effect');
  if (
    !isNonemptyString(effect.target)
    || Buffer.byteLength(effect.target, 'utf8') > AGENT_CONTROL_LIMITS.accessibleNameBytes
  ) {
    throw codedError('approval_payload_invalid', 'approval effect target must be bounded redacted metadata');
  }
  switch (effect.kind) {
    case 'submit':
    case 'secret_input':
    case 'upload':
    case 'download':
    case 'permission_response':
    case 'close':
    case 'script':
      return Object.freeze({ kind: effect.kind, target: effect.target });
    default:
      return invalidEffect(effect);
  }
}

function invalidEffect(effect: unknown): never {
  void effect;
  throw codedError('approval_identity_mismatch', 'approval effect is not allowlisted');
}

function digestIdentity(identity: ApprovalIdentity): string {
  const resource = identity.resource.kind === 'project'
    ? { kind: identity.resource.kind, id: identity.resource.id }
    : {
        kind: identity.resource.kind,
        id: identity.resource.id,
        generation: identity.resource.generation,
      };
  const payload = {
    actionId: identity.actionId,
    ownerEpoch: identity.ownerEpoch,
    leaseId: identity.leaseId,
    leaseRevision: identity.leaseRevision,
    resource,
    capability: identity.capability,
    effect: identity.effect,
  };
  return createHash('sha256').update(stableKeyJson(payload), 'utf8').digest('hex');
}

function stableKeyJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        sortObjectKeys((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
}

function assertPlainDataObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (
    !value
    || typeof value !== 'object'
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string')
    || Object.getOwnPropertyNames(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw codedError('approval_payload_invalid', `${label} must be a plain data object`);
  }
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  assertPlainDataObject(value, label);
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw codedError('approval_payload_invalid', `${label} contains unsupported fields`);
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAuthorityInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function assertDigest(approval: Approval, suppliedDigest: string): void {
  if (approval.payloadDigest !== suppliedDigest) {
    throw codedError('approval_digest_mismatch', 'approval payload digest mismatch');
  }
}

function assertStoredDigest(approval: Approval): void {
  if (digestIdentity(approval) !== approval.payloadDigest) {
    throw codedError('approval_identity_mismatch', 'stored approval identity is invalid');
  }
}

function assertionMatches(approval: Approval, assertion: NormalizedApprovalConsumeAssertion): boolean {
  return approval.ownerEpoch === assertion.ownerEpoch
    && approval.leaseId === assertion.leaseId
    && approval.leaseRevision === assertion.leaseRevision
    && approval.capability === assertion.capability
    && targetsEqual(approval.resource, assertion.resource);
}

function targetsEqual(left: LeaseTarget, right: LeaseTarget): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === 'project' || right.kind === 'project') return true;
  return left.generation === right.generation;
}

function isActive(approval: Approval): boolean {
  return approval.status === 'pending' || approval.status === 'approved';
}

function freezeApproval(approval: Approval): Approval {
  return Object.freeze({
    ...approval,
    resource: copyTarget(approval.resource),
    effect: copyEffect(approval.effect),
  });
}

function codedError(code: ApprovalErrorCode, message: string): Error & { code: ApprovalErrorCode } {
  return Object.assign(new Error(message), { code });
}
