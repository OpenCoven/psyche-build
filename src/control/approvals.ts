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

declare const actionPayloadDigestBrand: unique symbol;
export type ActionPayloadDigest = string & {
  readonly [actionPayloadDigestBrand]: 'psyche.action-payload/v1';
};

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

export interface NormalizedApprovalEffect {
  readonly kind: ApprovalEffectKind;
  readonly targetDigest: string;
}

export interface ApprovalRequest {
  readonly actionId: string;
  readonly ownerEpoch: number;
  readonly leaseId: string;
  readonly leaseRevision: number;
  readonly resource: LeaseTarget;
  readonly capability: SurfaceCapability;
  readonly effect: RedactedApprovalEffect;
  /** Transient immutable typed payload; canonicalized and discarded by request. */
  readonly actionPayload: unknown;
}

interface ApprovalIdentity {
  readonly actionId: string;
  readonly ownerEpoch: number;
  readonly leaseId: string;
  readonly leaseRevision: number;
  readonly resource: LeaseTarget;
  readonly capability: SurfaceCapability;
  readonly effect: NormalizedApprovalEffect;
  readonly actionPayloadDigest: ActionPayloadDigest;
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
  readonly effect: NormalizedApprovalEffect;
  /** Current immutable typed payload; canonicalized and discarded by consume. */
  readonly actionPayload: unknown;
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
  readonly effect: NormalizedApprovalEffect;
  readonly actionPayloadDigest: ActionPayloadDigest;
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
  assertIdentityFields(input);
  return {
    actionId: input.actionId,
    ownerEpoch: input.ownerEpoch,
    leaseId: input.leaseId,
    leaseRevision: input.leaseRevision,
    resource: copyTarget(input.resource),
    capability: input.capability,
    effect: normalizeEffect(input.effect),
    actionPayloadDigest: digestActionPayload(input.actionPayload),
  };
}

function copyAssertion(input: ApprovalConsumeAssertion): NormalizedApprovalConsumeAssertion {
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
    effect: copyNormalizedEffect(input.effect),
    actionPayloadDigest: digestActionPayload(input.actionPayload),
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
  if (!target || !isNonemptyString(target.id)) {
    throw codedError('approval_identity_mismatch', 'approval resource identity is missing');
  }
  if (target.kind === 'project') {
    return Object.freeze({ kind: target.kind, id: target.id });
  }
  if (
    (target.kind !== 'pane' && target.kind !== 'browser_tab')
    || !isAuthorityInteger(target.generation)
  ) {
    throw codedError('approval_identity_mismatch', 'approval resource identity is invalid');
  }
  return Object.freeze({ kind: target.kind, id: target.id, generation: target.generation });
}

function normalizeEffect(effect: RedactedApprovalEffect): NormalizedApprovalEffect {
  if (typeof effect?.target !== 'string') {
    throw codedError('approval_denied', 'approval effect target must be redacted display metadata');
  }
  switch (effect.kind) {
    case 'submit':
    case 'secret_input':
    case 'upload':
    case 'download':
    case 'permission_response':
    case 'close':
    case 'script':
      return Object.freeze({
        kind: effect.kind,
        targetDigest: digestCanonical('psyche.approval-effect-target/v1', effect.target),
      });
    default:
      return invalidEffect(effect);
  }
}

function copyNormalizedEffect(effect: NormalizedApprovalEffect): NormalizedApprovalEffect {
  if (!/^[a-f0-9]{64}$/.test(effect?.targetDigest)) {
    throw codedError('approval_digest_mismatch', 'normalized approval effect digest is invalid');
  }
  switch (effect.kind) {
    case 'submit':
    case 'secret_input':
    case 'upload':
    case 'download':
    case 'permission_response':
    case 'close':
    case 'script':
      return Object.freeze({ kind: effect.kind, targetDigest: effect.targetDigest });
    default:
      return invalidEffect(effect.kind);
  }
}

function invalidEffect(effect: never): never {
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
    lease: { id: identity.leaseId, revision: identity.leaseRevision },
    resource,
    capability: identity.capability,
    effect: { kind: identity.effect.kind, targetDigest: identity.effect.targetDigest },
    actionPayloadDigest: identity.actionPayloadDigest,
  };
  return digestCanonical('psyche.approval-payload/v1', payload);
}

export function digestActionPayload(payload: unknown): ActionPayloadDigest {
  return digestCanonical('psyche.action-payload/v1', payload) as ActionPayloadDigest;
}

function digestCanonical(domain: string, value: unknown): string {
  const encoded = canonicalEncode(value, new WeakSet<object>());
  const framed = `${domain.length}:${domain}|${encoded.length}:${encoded}`;
  return createHash('sha256').update(framed, 'utf8').digest('hex');
}

function canonicalEncode(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null;';
  if (typeof value === 'boolean') return value ? 'bool:1;' : 'bool:0;';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidPayload('numbers must be finite');
    return `number:${Object.is(value, -0) ? '-0' : value.toString()};`;
  }
  if (typeof value !== 'object') return invalidPayload(`unsupported ${typeof value} value`);
  if (ancestors.has(value)) return invalidPayload('cyclic values are unsupported');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return invalidPayload('array symbol properties are unsupported');
      }
      const keys = Object.keys(value);
      const propertyNames = Object.getOwnPropertyNames(value);
      if (
        keys.length !== value.length
        || keys.some((key, index) => key !== String(index))
        || propertyNames.length !== value.length + 1
        || !propertyNames.includes('length')
      ) return invalidPayload('sparse arrays and extra array properties are unsupported');
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        !lengthDescriptor
        || !('value' in lengthDescriptor)
        || lengthDescriptor.value !== value.length
        || lengthDescriptor.enumerable
        || lengthDescriptor.configurable
      ) return invalidPayload('array length descriptor is invalid');
      let encoded = `array:${value.length}:[`;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          !descriptor
          || !('value' in descriptor)
          || !descriptor.enumerable
        ) {
          return invalidPayload('array indices must be enumerable data properties');
        }
        encoded += canonicalEncode(descriptor.value, ancestors);
      }
      return `${encoded}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidPayload('only plain JSON objects are supported');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return invalidPayload('symbol keys are unsupported');
    }
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== keys.length) {
      return invalidPayload('non-enumerable properties are unsupported');
    }
    let encoded = `object:${keys.length}:{`;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return invalidPayload('accessor properties are unsupported');
      encoded += encodeString(key);
      encoded += canonicalEncode(descriptor.value, ancestors);
    }
    return `${encoded}}`;
  } finally {
    ancestors.delete(value);
  }
}

function encodeString(value: string): string {
  let codeUnits = '';
  for (let index = 0; index < value.length; index += 1) {
    codeUnits += value.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `string:${value.length}:${codeUnits};`;
}

function invalidPayload(reason: string): never {
  throw codedError('approval_payload_invalid', `action payload is not canonical JSON: ${reason}`);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isAuthorityInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is ActionPayloadDigest {
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
    effect: copyNormalizedEffect(approval.effect),
  });
}

function codedError(code: ApprovalErrorCode, message: string): Error & { code: ApprovalErrorCode } {
  return Object.assign(new Error(message), { code });
}
