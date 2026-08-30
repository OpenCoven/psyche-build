/**
 * Design-stage identity and correlation contracts for the Psyche Build →
 * Psyche convergence (issue #201).
 *
 * DESIGN ARTIFACT — NOT PRODUCT CODE.
 *
 * This module exists so the proposed shapes are compile-checked instead of
 * guessed in prose. It is deliberately inert:
 *
 * 1. No product code may import it. `__tests__/protocolIdentityDesign.test.ts`
 *    enforces that boundary by scanning `src/` for imports of this file.
 * 2. Nothing here claims Psyche protocol conformance. Canonical ownership of
 *    every name in this module belongs to `OpenCoven/psyche` after the
 *    publication gate (`OpenCoven/psyche#11`) and the ownership gate
 *    (`OpenCoven/psyche#12`) pass. Until then these are recommendations.
 * 3. The design record that motivates every type below is
 *    `docs/superpowers/specs/2026-08-30-psyche-identity-convergence-design.md`.
 *
 * The three required objects from issue #201 — familiar identity snapshot,
 * Psyche execution correlation, and execution attempt/runtime embodiment — are
 * modeled as three distinct record kinds that a binding envelope may link but
 * never collapse.
 */

import { createHash } from 'node:crypto';

/**
 * Content digest of an exact byte sequence. Lowercase hexadecimal SHA-256,
 * matching the digest discipline already used by the control journal
 * (`src/control/journal.ts`) and approval payload binding
 * (`src/control/approvals.ts`).
 */
export type ContentDigest = `sha256:${string}`;

/**
 * Reference syntax: `<namespace>.<opaque unique id>` minted by the owning
 * authority. References are opaque — no path, branch, pane, provider, tracker,
 * or UI information is encoded in the id itself. The prefix only names the
 * owning namespace so a misuse (a task id in a lane field) is visible.
 */
export type FamiliarRootRef = `oc.famroot.${string}`;
export type FamiliarRevisionRef = `oc.famrev.${string}`;
export type PrincipalRef = `oc.principal.${string}`;
export type AuthorizationDecisionRef = `oc.authz.${string}`;
export type ProjectRef = `oc.project.${string}`;
export type GraphRef = `oc.graph.${string}`;
export type TaskRef = `oc.task.${string}`;
export type LaneRef = `oc.lane.${string}`;
export type DelegationRef = `oc.delegation.${string}`;
export type AttemptRef = `oc.attempt.${string}`;
export type ActionRef = `oc.action.${string}`;
export type ApprovalRef = `oc.approval.${string}`;
export type ArtifactRef = `oc.artifact.${string}`;
export type ReceiptRef = `oc.receipt.${string}`;
export type RuntimeSessionRef = `oc.rtsession.${string}`;
export type HostRef = `oc.host.${string}`;
export type DeviceRef = `oc.device.${string}`;
export type BindingRef = `oc.binding.${string}`;

/** RFC 3339 UTC timestamp string (the convention used across control records). */
export type Rfc3339Timestamp = string;

/* ──────────────────────────────────────────────────────────────────────────
 * Object 1 — Familiar identity snapshot (immutable, Familiar-Contract-owned)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Object 1 of the required object separation: the stable familiar root, the
 * exact authorized identity revision, and its principal/authorization
 * references. Immutable once captured — any new authorization creates a new
 * revision, it never mutates this record.
 */
export interface FamiliarIdentitySnapshot {
  readonly object: 'psyche.identity.snapshot.v1';
  readonly familiarRoot: FamiliarRootRef;
  /** Monotonic revision within the familiar root. */
  readonly revision: number;
  /** Digest of the exact authorized identity revision bytes. */
  readonly digest: ContentDigest;
  /** Stable principal reference — never a configured display name or actor string. */
  readonly principal: PrincipalRef;
  /** Threads-owned protected-surface decisions constraining this snapshot. */
  readonly authorization: readonly AuthorizationDecisionRef[];
  readonly capturedAt: Rfc3339Timestamp;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Object 2 — Psyche execution correlation (canonical orchestration identity)
 * ──────────────────────────────────────────────────────────────────────── */

export type CancellationRef = `oc.cancel.${string}`;
export type RecoveryRef = `oc.recovery.${string}`;

/**
 * Object 2 of the required object separation: the canonical task, graph, lane,
 * delegation, action, approval, receipt, cancellation, and recovery
 * identities. Psyche owns this record; Build only projects it. This view is a
 * point-in-time projection — the lifecycle truth lives in Psyche.
 */
export interface PsycheExecutionCorrelation {
  readonly object: 'psyche.execution.correlation.v1';
  /** Correlation root. Mutable lifecycle state hangs off the task, never off the binding envelope. */
  readonly task: TaskRef;
  readonly graph?: GraphRef;
  readonly lanes: readonly LaneRef[];
  readonly delegations: readonly DelegationRef[];
  readonly actions: readonly ActionRef[];
  readonly approvals: readonly ApprovalRef[];
  readonly receipts: readonly ReceiptRef[];
  readonly cancellation?: CancellationRef;
  readonly recovery?: RecoveryRef;
  /** When this projection was read; proves staleness instead of implying freshness. */
  readonly observedAt: Rfc3339Timestamp;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Object 3 — Execution attempt / runtime embodiment
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One concrete attempt at executing work for a task. The attempt — not the
 * pane, process, session, or worktree — is the unit that runtime handles
 * attach to; panes and sessions remain replaceable execution locators
 * (`src/control/surfaces.ts` generations already fence exactly this).
 */
export const ATTEMPT_STATES = [
  'pending',
  'embodied',
  'running',
  'terminating',
  'succeeded',
  'failed',
  'unknown',
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export interface ExecutionAttempt {
  readonly object: 'psyche.execution.attempt.v1';
  readonly attempt: AttemptRef;
  readonly task: TaskRef;
  readonly lane?: LaneRef;
  readonly delegation?: DelegationRef;
  /** The daemon/runtime session executing this attempt — a reference, never the attempt identity. */
  readonly runtimeSession: RuntimeSessionRef;
  readonly host: HostRef;
  readonly device?: DeviceRef;
  /** Bumped on runtime restart; the current owner-epoch analog (`src/control/ownerLock.ts`). */
  readonly resourceGeneration: number;
  /**
   * The exact familiar revision this attempt embodies. Must equal the
   * identity snapshot's root/revision/digest triple for the binding to be
   * valid — this is the "every session proves the exact familiar revision
   * embodied" acceptance criterion.
   */
  readonly embodiedFamiliar: {
    readonly familiarRoot: FamiliarRootRef;
    readonly revision: number;
    readonly digest: ContentDigest;
  };
  readonly state: AttemptState;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Binding envelope — links the three objects without collapsing them
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The record that references all three objects at once. It is deliberately a
 * triple of distinct, individually digest-addressed members: the immutable
 * identity facts, the canonical correlation root, and the concrete attempt.
 * It carries no lifecycle state of its own, so there is nothing here to
 * collapse into.
 */
export interface ExecutionBindingV1 {
  readonly object: 'psyche.execution.binding.v1';
  readonly binding: BindingRef;
  /** Object 1 — exact immutable identity facts (digest-addressed). */
  readonly identity: {
    readonly familiarRoot: FamiliarRootRef;
    readonly revision: number;
    readonly digest: ContentDigest;
  };
  /** Object 2 — canonical correlation root only; never an embedded mutable set. */
  readonly correlation: { readonly task: TaskRef };
  /** Object 3 — the concrete attempt facts. */
  readonly attempt: {
    readonly attempt: AttemptRef;
    readonly runtimeSession: RuntimeSessionRef;
    readonly host: HostRef;
    readonly resourceGeneration: number;
    /** Must equal `identity.digest` — the embodiment proof. */
    readonly embodiedDigest: ContentDigest;
  };
  /** Named conformance profile in force for this binding. */
  readonly profile: string;
  readonly schemaMajor: number;
}

/**
 * Reference digest derivation for the binding envelope, following the
 * domain-separated, length-prefixed tuple digest pattern already used by
 * `src/orchestration/operationIdentity.ts`. The digest covers each member
 * field so no member can be substituted without changing the digest.
 */
export function deriveExecutionBindingDigest(envelope: ExecutionBindingV1): ContentDigest {
  const hash = createHash('sha256');
  hash.update('psyche.execution.binding.v1', 'utf8');
  const fields: readonly string[] = [
    envelope.binding,
    envelope.object,
    envelope.identity.familiarRoot,
    String(envelope.identity.revision),
    envelope.identity.digest,
    envelope.correlation.task,
    envelope.attempt.attempt,
    envelope.attempt.runtimeSession,
    envelope.attempt.host,
    String(envelope.attempt.resourceGeneration),
    envelope.attempt.embodiedDigest,
    envelope.profile,
    String(envelope.schemaMajor),
  ];
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    hash.update(`:${bytes.byteLength}:`, 'utf8');
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Receipts and content-addressed artifacts
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Terminal outcome of one action. Mirrors the current receipt discipline:
 * outcomes come from the authoritative effect path (`src/control/runtime.ts`,
 * `src/control/journal.ts`), never from UI or process state, and `unknown` is
 * a first-class terminal outcome (`command.unknown` in the current journal).
 */
export const RECEIPT_OUTCOMES = ['succeeded', 'failed', 'denied', 'unknown'] as const;
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

export interface ActionReceiptV1 {
  readonly object: 'psyche.receipt.v1';
  readonly receipt: ReceiptRef;
  readonly action: ActionRef;
  readonly attempt: AttemptRef;
  readonly task: TaskRef;
  readonly outcome: ReceiptOutcome;
  /** Digest of the exact executable payload whose effect this receipt terminates. */
  readonly effectDigest: ContentDigest;
  /** Local retry correlation; the receipt, not the key, is the durable truth. */
  readonly idempotencyKey?: string;
  readonly evidence: readonly ArtifactRef[];
  readonly observedAt: Rfc3339Timestamp;
}

export const ARTIFACT_KINDS = [
  'patch',
  'commit',
  'test-result',
  'research',
  'plan',
  'screenshot',
  'build',
  'decision',
  'release',
  'handoff',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Content-addressed evidence record. The artifact content lives behind its
 * digest; the record carries bounded metadata and provenance only, so
 * protected-data rules (no raw prompts, no unredacted paths) stay enforceable
 * by shape.
 */
export interface ArtifactRecordV1 {
  readonly object: 'psyche.artifact.v1';
  readonly artifact: ArtifactRef;
  readonly kind: ArtifactKind;
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly task: TaskRef;
  readonly attempt?: AttemptRef;
  readonly action?: ActionRef;
  /** `exact` proves the retained bytes are the effect; `redacted` marks a bounded projection. */
  readonly redaction: 'exact' | 'redacted';
  readonly createdAt: Rfc3339Timestamp;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Lifecycle and connection states
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Approval lifecycle, mirroring `ApprovalStatus` in `src/control/approvals.ts`
 * exactly: consume-once, expiry, denial, and revocation are preserved rather
 * than collapsed into a boolean.
 */
export const APPROVAL_STATES = [
  'pending',
  'approved',
  'denied',
  'consumed',
  'expired',
  'revoked',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

/**
 * Client-visible connection health. Disconnected or reconciling clients must
 * expose these states rather than implying freshness (issue #201 principles);
 * the iOS mirror consumes the same enumeration.
 */
export const CONNECTION_HEALTH_STATES = [
  'fresh',
  'stale',
  'reconciling',
  'degraded',
  'unavailable',
] as const;
export type ConnectionHealthState = (typeof CONNECTION_HEALTH_STATES)[number];

/* ──────────────────────────────────────────────────────────────────────────
 * Version negotiation and bounded durable-state adapter
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Profile negotiation record. Unknown major versions, unknown profiles, and
 * requested downgrades fail closed; see the design record for the exact
 * rules and the canary vectors that prove them.
 */
export interface ProfileNegotiationV1 {
  readonly object: 'psyche.profile.negotiation.v1';
  /** Named conformance profile — a generic "compliant" label is not a claim. */
  readonly profile: string;
  readonly schemaMajor: number;
  readonly schemaMinor: number;
  readonly consumer: string;
  readonly consumerSha: string;
  /** True only when the consumer explicitly declares downgrade capability. */
  readonly downgrade: boolean;
}

/**
 * Bounded durable-state adapter contract (issue #201 design scope): any
 * persistence provider — AgentFS or otherwise — implements this bounded
 * surface and remains replaceable; it can never become an identity layer.
 */
export interface BoundedDurableStateAdapter<S> {
  readonly name: string;
  load(key: string): Promise<S | undefined>;
  store(key: string, value: S, expectedRevision?: number): Promise<void>;
  migrate(fromSchemaVersion: number, toSchemaVersion: number): Promise<MigrationResult>;
  rollback(toRevision: number): Promise<void>;
  readonly bounds: {
    readonly maxRecordBytes: number;
    readonly maxRecords: number;
    readonly retentionDays: number;
  };
}

export type MigrationResult =
  | { readonly ok: true; readonly from: number; readonly to: number }
  | {
      readonly ok: false;
      readonly reason:
        | 'unsupported-major'
        | 'corrupt'
        | 'bounded-capacity-exceeded';
    };

/* ──────────────────────────────────────────────────────────────────────────
 * Golden examples
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Golden example of Object 1: an immutable familiar identity snapshot with a
 * stable principal and a Threads authorization decision reference.
 */
export const goldenFamiliarIdentitySnapshot: FamiliarIdentitySnapshot = {
  object: 'psyche.identity.snapshot.v1',
  familiarRoot: 'oc.famroot.01JGQP3F7Z4MJVWJ9Q6Y5N8A2C',
  revision: 17,
  digest: 'sha256:1d2f30c4a5b6978e8f0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7',
  principal: 'oc.principal.01JGQP3F7Z9KXW2M4N6P8R0T2V',
  authorization: ['oc.authz.01JGQP3GW9BGTQ9YR57CPK5TM1'],
  capturedAt: '2026-08-30T12:00:00.000Z',
} as const;

/**
 * Golden example of Object 2: a point-in-time projection of Psyche-owned
 * orchestration identity for the correlation task.
 */
export const goldenExecutionCorrelation: PsycheExecutionCorrelation = {
  object: 'psyche.execution.correlation.v1',
  task: 'oc.task.01JGQP3G3A211R0FZ6YXXMWBV2',
  graph: 'oc.graph.01JGQP3GABSJ8SQ067NE4NKW23',
  lanes: ['oc.lane.01JGQP3GHCG3FTEHD8CZBPAD94'],
  delegations: ['oc.delegation.01JGQP3GRD7MPV52M93GJQ1YG5'],
  actions: ['oc.action.01JGQP3GZEY5XWWKVAT1SRRFQ6'],
  approvals: ['oc.approval.01JGQP3G6FNP4XK42BHJ0SF0Y7'],
  receipts: ['oc.receipt.01JGQP3GDGC7BYAN9C837T6H58'],
  observedAt: '2026-08-30T12:05:00.000Z',
} as const;

/**
 * Golden example of Object 3: one concrete attempt, its runtime embodiment,
 * and the exact familiar revision it embodies.
 */
export const goldenExecutionAttempt: ExecutionAttempt = {
  object: 'psyche.execution.attempt.v1',
  attempt: 'oc.attempt.01JGQP3GMH3RJZ16GDZMEVX2C9',
  task: 'oc.task.01JGQP3G3A211R0FZ6YXXMWBV2',
  lane: 'oc.lane.01JGQP3GHCG3FTEHD8CZBPAD94',
  runtimeSession: 'oc.rtsession.01JGQP3GVJT9S0RQQEP5NWMKKA',
  host: 'oc.host.01JGQP3G2KHT01F8YFDPWXB4TB',
  resourceGeneration: 3,
  embodiedFamiliar: {
    familiarRoot: 'oc.famroot.01JGQP3F7Z4MJVWJ9Q6Y5N8A2C',
    revision: 17,
    digest: 'sha256:1d2f30c4a5b6978e8f0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7',
  },
  state: 'running',
} as const;

/**
 * Golden binding envelope linking all three objects without collapsing them.
 * `attempt.embodiedDigest` equals `identity.digest` — the embodiment proof.
 */
export const goldenExecutionBinding: ExecutionBindingV1 = {
  object: 'psyche.execution.binding.v1',
  binding: 'oc.binding.01JGQP3G9M8B726S5G473Y2N1C',
  identity: {
    familiarRoot: goldenFamiliarIdentitySnapshot.familiarRoot,
    revision: goldenFamiliarIdentitySnapshot.revision,
    digest: goldenFamiliarIdentitySnapshot.digest,
  },
  correlation: { task: goldenExecutionCorrelation.task },
  attempt: {
    attempt: goldenExecutionAttempt.attempt,
    runtimeSession: goldenExecutionAttempt.runtimeSession,
    host: goldenExecutionAttempt.host,
    resourceGeneration: goldenExecutionAttempt.resourceGeneration,
    embodiedDigest: goldenFamiliarIdentitySnapshot.digest,
  },
  profile: 'psyche.consumer.desktop-cockpit.v1',
  schemaMajor: 1,
} as const;

/** Digest of {@link goldenExecutionBinding} computed by the reference derivation. */
export const goldenExecutionBindingDigest: ContentDigest =
  deriveExecutionBindingDigest(goldenExecutionBinding);

/** Golden receipt terminating the golden action with bounded evidence. */
export const goldenActionReceipt: ActionReceiptV1 = {
  object: 'psyche.receipt.v1',
  receipt: 'oc.receipt.01JGQP3GDGC7BYAN9C837T6H58',
  action: 'oc.action.01JGQP3GZEY5XWWKVAT1SRRFQ6',
  attempt: goldenExecutionAttempt.attempt,
  task: goldenExecutionCorrelation.task,
  outcome: 'succeeded',
  effectDigest: 'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a0978695a4b3c2d1e0f9182736455c6d7e',
  evidence: ['oc.artifact.01JGQP3GGNZWE3XACHVRAZS68D'],
  observedAt: '2026-08-30T12:06:30.000Z',
} as const;

/** Golden content-addressed artifact record (a redacted screenshot projection). */
export const goldenArtifactRecord: ArtifactRecordV1 = {
  object: 'psyche.artifact.v1',
  artifact: 'oc.artifact.01JGQP3GGNZWE3XACHVRAZS68D',
  kind: 'screenshot',
  digest: 'sha256:aa11bb22cc33dd44ee55ff6600778899aabbccddeeff00112233445566778899',
  byteLength: 20480,
  mediaType: 'image/png',
  task: goldenExecutionCorrelation.task,
  attempt: goldenExecutionAttempt.attempt,
  action: goldenActionReceipt.action,
  redaction: 'redacted',
  createdAt: '2026-08-30T12:06:29.000Z',
} as const;

/**
 * Golden restart/resume proof: after a daemon restart and reconnect, the same
 * identity resumes under a fresh resource generation and a fresh runtime
 * session — same familiar digest, same task, same lane, new locators.
 */
export const goldenRestartResume: {
  readonly before: ExecutionBindingV1;
  readonly after: ExecutionBindingV1;
} = {
  before: goldenExecutionBinding,
  after: {
    object: 'psyche.execution.binding.v1',
    binding: 'oc.binding.01JGQP3GQPPDN4MVKJJ9H0GQFE',
    identity: goldenExecutionBinding.identity,
    correlation: goldenExecutionBinding.correlation,
    attempt: {
      attempt: 'oc.attempt.01JGQP3GYQDYW5BCTK9TR178PF',
      runtimeSession: 'oc.rtsession.01JGQP3G5R4F362X1M0BZ2YSXG',
      host: goldenExecutionAttempt.host,
      resourceGeneration: goldenExecutionAttempt.resourceGeneration + 1,
      embodiedDigest: goldenFamiliarIdentitySnapshot.digest,
    },
    profile: goldenExecutionBinding.profile,
    schemaMajor: goldenExecutionBinding.schemaMajor,
  },
} as const;
