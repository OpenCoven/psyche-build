import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { STABLE_SURFACE_EFFECT_CODES } from '../control/effectCodes.js';
import { isActionReceiptState, isActionStatusReceipt } from '../control/types.js';
import type { ActionStatusReceipt, ActionReceiptState } from '../control/types.js';

/** The public format is deliberately separate from the control-plane schemas. */
export const SUPPORT_BUNDLE_SCHEMA = 'psyche.diagnostics/v1' as const;
export const SUPPORT_BUNDLE_VERSION = 1 as const;
export const SUPPORT_BUNDLE_COMPATIBILITY = Object.freeze({
  policy: 'readers-reject-unknown-major-and-ignore-unknown-fields-within-major',
  minimumReaderVersion: 1,
} as const);

export const SUPPORT_BUNDLE_LIMITS = Object.freeze({
  maxElapsedMs: 30_000,
  maxRecords: 256,
  maxRecordBytes: 4 * 1024,
  maxBundleBytes: 64 * 1024,
  maxStringBytes: 512,
  maxAttributeKeys: 32,
  maxAttributeItems: 32,
  maxAttributeDepth: 5,
  maxErrorChain: 4,
  maxReceipts: 64,
  maxTerminalLines: 64,
  maxTerminalBytes: 4 * 1024,
});

export const SUPPORT_ACTION_STATES = [
  'pending',
  'executing',
  'succeeded',
  'failed',
  'unknown',
  'invalidated',
] as const;

export type SupportActionState = typeof SUPPORT_ACTION_STATES[number];
export type SupportBundleStatus = 'complete' | 'partial' | 'unknown' | 'recovery_required';

export interface SupportBundleInput {
  readonly generatedAt?: unknown;
  readonly status?: unknown;
  readonly provenance?: unknown;
  readonly ownerEpoch?: unknown;
  readonly project?: unknown;
  readonly lifecycle?: unknown;
  readonly providers?: unknown;
  readonly persistence?: unknown;
  readonly updater?: unknown;
  readonly graphics?: unknown;
  readonly terminalTail?: unknown;
  readonly records?: unknown;
  readonly receipts?: unknown;
  readonly errors?: unknown;
  readonly accountingProof?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Application-held signing boundary for serialized support-bundle metadata.
 * The codec key must remain in the control-plane/runtime boundary; callers
 * cannot manufacture a verified bundle from shape-valid JSON alone.
 */
export interface SupportBundleCodec {
  readonly sign: (canonicalPayload: string) => string;
  readonly verify: (canonicalPayload: string, proof: string) => boolean;
}

export interface SupportBundleOptions {
  readonly now?: () => number;
  readonly maxElapsedMs?: number;
  readonly maxRecords?: number;
  readonly maxRecordBytes?: number;
  readonly maxBundleBytes?: number;
  readonly maxReceipts?: number;
  readonly homeDirectory?: string;
  /** Only the control-plane bridge can hold this opaque capability. */
  readonly authority?: SupportBundleAuthority;
  /** Optional application-held codec used to authenticate serialized metadata. */
  readonly codec?: SupportBundleCodec;
}

declare const SUPPORT_BUNDLE_AUTHORITY_BRAND: unique symbol;
export type SupportBundleAuthority = {
  readonly [SUPPORT_BUNDLE_AUTHORITY_BRAND]: true;
};

export interface SupportBundleCompatibility {
  readonly policy: typeof SUPPORT_BUNDLE_COMPATIBILITY.policy;
  readonly minimumReaderVersion: typeof SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion;
}

export interface SupportCollector {
  readonly name: string;
  /**
   * The callback must yield while doing work so the shared deadline can be
   * observed. JavaScript cannot preempt a synchronous callback; native
   * bridges must perform blocking work off-thread and return a promise.
   */
  readonly collect: (signal: AbortSignal) => Promise<SupportBundleInput>;
}

export interface SupportProvenance {
  readonly application: string;
  readonly releaseVersion: string;
  readonly sourceSha: string;
  readonly platform: string;
  readonly architecture: string;
  /** Present when the values were supplied without a control-plane proof. */
  readonly verification?: 'unverified';
}

export interface SupportProjectIdentity {
  readonly idDigest: string;
  readonly name?: string;
  readonly relativePath?: string;
}

export interface SupportRecord {
  readonly sequence: number;
  readonly at: string;
  readonly component: string;
  readonly event: string;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly truncated?: boolean;
}

export interface SupportReceipt {
  readonly sourceSchema: 'psyche.control.receipt/v1';
  readonly actionId: string;
  readonly state: SupportActionState;
  readonly sourceState: ActionReceiptState;
  readonly resource: Readonly<{
    kind: 'project' | 'pane' | 'browser_tab';
    idDigest: string;
    generation?: number;
  }>;
  readonly createdAt: string;
  readonly taskId?: string;
  readonly actorId?: string;
  readonly leaseId?: string;
  readonly leaseRevision?: number;
  readonly completedAt?: string;
  readonly code?: string;
  readonly durationMs?: number;
  /** Present when the receipt shape was supplied without a control-plane proof. */
  readonly verification?: 'unverified';
}

export interface SupportCollectionError {
  readonly collector: string;
  readonly code: string;
  readonly at: string;
  readonly message?: string;
  readonly recoveryRequired?: boolean;
}

export interface SupportRedactionManifest {
  readonly version: 1;
  readonly redactedFields: number;
  readonly omittedFields: number;
  readonly categories: Readonly<Record<string, number>>;
}

export interface SupportTruncationManifest {
  readonly recordsOmitted: number;
  readonly receiptsOmitted: number;
  readonly errorsOmitted: number;
  readonly stateFieldsOmitted: number;
  readonly terminalLinesOmitted: number;
  readonly bytesOmitted: number;
  readonly fieldsTruncated: number;
  readonly totalPayloadBounded: boolean;
}

export interface SupportBundle {
  readonly schema: typeof SUPPORT_BUNDLE_SCHEMA;
  readonly version: typeof SUPPORT_BUNDLE_VERSION;
  readonly compatibility: SupportBundleCompatibility;
  readonly generatedAt: string;
  readonly status: SupportBundleStatus;
  readonly provenance: SupportProvenance;
  readonly ownerEpoch?: number;
  readonly project?: SupportProjectIdentity;
  readonly lifecycle: Readonly<Record<string, unknown>>;
  readonly providers: Readonly<Record<string, unknown>>;
  readonly persistence: Readonly<Record<string, unknown>>;
  readonly updater: Readonly<Record<string, unknown>>;
  readonly graphics?: Readonly<Record<string, unknown>>;
  readonly terminalTail: readonly string[];
  readonly records: readonly SupportRecord[];
  readonly receipts: readonly SupportReceipt[];
  readonly errors: readonly SupportCollectionError[];
  readonly redaction: SupportRedactionManifest;
  readonly truncation: SupportTruncationManifest;
  /** HMAC-like proof over the canonical bundle with this field excluded. */
  readonly accountingProof?: string;
}

type RecoveryTruncationCounts = Partial<Pick<SupportTruncationManifest,
  'recordsOmitted' | 'receiptsOmitted' | 'errorsOmitted' | 'stateFieldsOmitted'
  | 'terminalLinesOmitted' | 'bytesOmitted' | 'fieldsTruncated'>>;

interface RecoveryPayloadSnapshot {
  readonly records?: readonly unknown[];
  readonly receipts?: readonly unknown[];
  readonly terminalTail?: readonly unknown[];
  readonly truncation?: RecoveryTruncationCounts;
}

interface MutableAudit {
  redactedFields: number;
  omittedFields: number;
  fieldsTruncated: number;
  terminalLinesOmitted: number;
  attributeNodesVisited: number;
  categories: Map<string, number>;
  deadlineAt?: number;
}

interface NormalizationBudget {
  remaining: number;
  deadlineAt?: number;
}

// Normalized metadata is an internal trust boundary. A symbol is still
// discoverable and mutable through reflection, so keep the provenance and
// truncation state outside the caller-visible object graph.
const REDACTION_AUDITS = new WeakMap<object, SupportRedactionManifest>();
const TRUSTED_TRUNCATIONS = new WeakMap<object, Partial<SupportTruncationManifest>>();
type TrustedSupportField = 'provenance' | 'receipts';
const TRUSTED_SUPPORT_FIELDS = new WeakMap<object, ReadonlySet<TrustedSupportField>>();
const SUPPORT_BUNDLE_CODECS = new WeakMap<object, SupportBundleCodec>();
const NORMALIZED_SOURCE_FINGERPRINTS = new WeakMap<object, string>();
// This capability is intentionally not exported as a value. The future
// control-plane bridge must keep its own private integration point; arbitrary
// support-bundle callers can only produce unverified/partial metadata.
const CONTROL_PLANE_AUTHORITY = Object.freeze({}) as SupportBundleAuthority;
const LEGACY_PUBLISHED_FIXTURE_CODEC_KEY = Buffer.from('psyche-build-support-fixture-v1', 'utf8');

const ROOT_FIELDS = new Set([
  'generatedAt',
  'schema',
  'version',
  'compatibility',
  'status',
  'provenance',
  'ownerEpoch',
  'project',
  'lifecycle',
  'providers',
  'persistence',
  'updater',
  'graphics',
  'terminalTail',
  'records',
  'receipts',
  'errors',
  'redaction',
  'truncation',
  'accountingProof',
]);

const COLLECTOR_ARRAY_FIELDS = ['terminalTail', 'records', 'receipts', 'errors'] as const;
const COLLECTOR_MAP_FIELDS = [
  'provenance',
  'project',
  'lifecycle',
  'providers',
  'persistence',
  'updater',
  'graphics',
] as const;

const SENSITIVE_KEY = /(?:^|[_-]|(?<=[a-z]))(?:token|secret|password|passwd|passphrase|credential|authorization|auth|cookie|private(?:[_-]?key)?|api(?:[_-]?key)?|access(?:[_-]?token)?)(?=$|[_-]|[A-Z])/i;
const CONTENT_KEY = /(?:prompt|transcript|terminal(?:[_-]?output)?|repository(?:[_-]?contents?)?|diff|environment|env(?:ironment)?|source(?:[_-]?contents?)?)/i;
const URL_KEY = /(?:url|uri|endpoint|remote|host)/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const ABSOLUTE_PATH_FRAGMENT = /(?<![A-Za-z0-9])(?:\/[^\s"'`<>|]+(?:[ \t]+[^\s"'`<>|]+)*|[A-Za-z]:[\\/][^\r\n"'`<>|]+|\\\\[^\r\n"'`<>|]+)/g;
const ANSI = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001bP[\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-2A-Za-z]|\u001b[=>])/g;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi;
const API_TOKEN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g;
const SENSITIVE_ASSIGNMENT = /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_KEY|PRIVATE_KEY))\s*=\s*[^\s]+/gi;
const CLOUD_CREDENTIAL_ASSIGNMENT = /\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*[^\s]+/gi;
const AUTHORIZATION_LABELED_VALUE = /["']?authorization(?:[_-]?header)?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;
const SENSITIVE_LABELED_VALUE = /["']?(?:token|secret|password|passwd|passphrase|credential|authorization(?:[_-]?header)?|auth|cookie|api[_-]?key|private[_-]?key|access[_-]?token)(?:[A-Z][A-Za-z0-9_-]*)?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;
const SENSITIVE_PHRASE = /\b(?:token|secret|password|passwd|passphrase|credential|authorization(?:header)?|auth|cookie)\b\s+(?:is\s+|value\s+)?[^\r\n]+/gi;
const SAFE_ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CATEGORY_VALUE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SENSITIVE_RELATIVE_PATH = /(?:^|\/)(?:\.ssh(?:\/|$)|\.env(?:$|[./])|credentials?(?:$|[._/-])|passwords?(?:$|[._/-])|secrets?(?:$|[._/-])|tokens?(?:$|[._/-])|id_(?:rsa|dsa|ecdsa|ed25519)(?:$|[._/-]))/i;
const SAFE_DIAGNOSTIC_VALUES = new Set([
  'accelerated', 'active', 'available', 'cancelled', 'complete', 'connected',
  'current', 'degraded', 'denied', 'disabled', 'enabled', 'executing', 'expired',
  'failed', 'fallback', 'healthy', 'idle', 'invalidated', 'linux', 'macos',
  'missing', 'none', 'offline', 'online', 'partial', 'pending', 'queued', 'ready',
  'recovery_required', 'running', 'stale', 'stopped', 'succeeded', 'unknown',
  'unavailable', 'unsupported', 'waiting', 'webgl', 'windows', 'x11', 'wayland',
  'arm64', 'aarch64', 'x86_64',
]);
// Record and collection error identifiers are a closed diagnostic vocabulary.
// Dynamic authority identifiers use safeIdentifierDigest instead; these fields must
// never become a channel for arbitrary product or user text.
const SAFE_DIAGNOSTIC_CATEGORY_VALUES = new Set([
  ...SAFE_DIAGNOSTIC_VALUES,
  'a', 'b', 'alpha', 'beta', 'c', 'captured', 'collector', 'diagnostics',
  'disk', 'event', 'failed', 'first', 'fixture', 'four', 'gamma', 'later',
  'malformed', 'no_collectors', 'one', 'oversized-graph', 'path', 'path-test',
  'sample', 'slow-recovery', 'support-bundle', 'test', 'three', 'two', 'warning-two',
  'warning-three', 'warning-four', 'write_failed', 'zeta', 'fixture_ok',
  'collection_cancelled', 'collection_conflict', 'collection_failed',
  'collection_invalid_output', 'collection_output_overflow',
  'collection_timeout_or_cancelled', 'collector_limit', 'duplicate_action_id',
  'duplicate_collector_name', 'invalid_record', 'normalization_cancelled', 'normalization_timeout',
  'provenance_incomplete', 'record', 'recovery', 'slow', 'action_invalidated',
  'action_validation_failed', 'approval_denied', 'approval_expired', 'effect_failed',
  'effect_unknown', 'queue_full', ...STABLE_SURFACE_EFFECT_CODES,
]);
const SAFE_REDACTION_CATEGORY_VALUES = new Set([
  'absolute-path', 'attribute-depth', 'attribute-items', 'attribute-keys',
  'attribute-map-too-large', 'attribute-node-limit', 'authorization', 'bounded-text',
  'duplicate-action-id',
  'certificate-or-key', 'content-field', 'error-message', 'infrastructure-url',
  'invalid-lease-revision', 'invalid-record', 'invalid-receipt', 'invalid-status',
  'invalid-timestamp',
  'non-authoritative-receipt', 'non-finite-number', 'non-normalized-receipt',
  'record-count', 'record-omitted', 'record-size', 'receipt-count', 'receipt-identity-too-large',
  'secret-assignment', 'secret-field', 'secret-labeled-value', 'secret-phrase',
  'sensitive-text', 'terminal-field', 'terminal-omitted', 'terminal-redaction',
  'token', 'untyped-category', 'untyped-number', 'untyped-string', 'unknown-root-field',
  'unknown-root-field-limit', 'unsafe-category', 'unsafe-field-name', 'unsafe-relative-path',
  'unsupported-value', 'relative-path-too-long', 'project-identity-too-large', 'unsafe-state-key',
  'collection-invalid-output', 'identifier-too-large', 'unsafe-identifier',
]);
const SAFE_PROVENANCE_APPLICATION_VALUES = new Set(['psyche-build']);
const SAFE_PROVENANCE_PLATFORM_VALUES = new Set([
  'android', 'darwin', 'freebsd', 'ios', 'linux', 'macos', 'web', 'windows', 'unknown',
]);
const SAFE_PROVENANCE_ARCHITECTURE_VALUES = new Set([
  'aarch64', 'arm64', 'arm64-sim', 'wasm32', 'unknown', 'x64', 'x86', 'x86_64',
]);
const SAFE_DIAGNOSTIC_NUMBER_KEYS = new Set([
  'attempts', 'bytes', 'cols', 'count', 'durationms', 'generation', 'height',
  'items', 'lines', 'ownerepoch', 'panes', 'pid', 'rows', 'size', 'timers', 'width',
]);
const SAFE_VERSION_VALUE = /^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z][A-Za-z0-9.-]{0,31})?$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INFRASTRUCTURE_URL = /\b(?:https?|ssh|git|ftp):\/\/[^\s"'`]+/gi;
const MAX_ATTRIBUTE_SCAN_KEYS = 1_024;
const MAX_SUPPORT_COLLECTORS = 64;
const MAX_ATTRIBUTE_NODES = 4_096;
// Audit metadata is itself part of the bounded public format. Keep enough
// room for every bounded input node plus collector overhead, while rejecting
// caller-injected values that are merely plausible-looking counters.
const MAX_AUDIT_COUNT = MAX_ATTRIBUTE_NODES * 8;
// A bundle can contain bounded records plus bounded state maps before the
// payload fitter removes data. Keep byte accounting bounded independently of
// count metadata so a large but valid pre-fit bundle remains structurally
// valid after fitting.
const MAX_BYTES_OMITTED = MAX_ATTRIBUTE_SCAN_KEYS * SUPPORT_BUNDLE_LIMITS.maxRecordBytes;
const MAX_TEXT_SCAN_CHARS = 16_384;
const SHA256_DIGEST = /^[a-f0-9]{64}$/i;
const ACCOUNTING_PROOF = /^[a-f0-9]{64}$/i;
const ACCOUNTING_PROOF_PLACEHOLDER = '0'.repeat(64);

function isNonZeroDigest(value: string): boolean {
  return SHA256_DIGEST.test(value) && !/^0+$/i.test(value);
}

function isCanonicalDigest(value: string): boolean {
  return isNonZeroDigest(value) && value === value.toLowerCase();
}

function isNonZeroSourceSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) && !/^0+$/i.test(value);
}

function isCanonicalSourceSha(value: string): boolean {
  return isNonZeroSourceSha(value) && value === value.toLowerCase();
}

function isAccountingProof(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNTING_PROOF.test(value);
}

/** Create a deterministic application-held HMAC-SHA-256 bundle codec. */
export function createSupportBundleCodec(secret: string | Uint8Array): SupportBundleCodec {
  const key = Buffer.from(secret);
  if (key.length < 16) {
    throw new TypeError('support bundle codec secrets must be at least 16 bytes');
  }
  if (key.length === LEGACY_PUBLISHED_FIXTURE_CODEC_KEY.length
    && timingSafeEqual(key, LEGACY_PUBLISHED_FIXTURE_CODEC_KEY)) {
    throw new TypeError('published fixture keys cannot be used for support bundle authentication');
  }
  return Object.freeze({
    sign: (canonicalPayload: string): string => createHmac('sha256', key)
      .update(canonicalPayload, 'utf8')
      .digest('hex'),
    verify: (canonicalPayload: string, proof: string): boolean => {
      if (!isAccountingProof(proof)) return false;
      try {
        const expected = createHmac('sha256', key).update(canonicalPayload, 'utf8').digest();
        const provided = Buffer.from(proof, 'hex');
        return provided.length === expected.length && timingSafeEqual(provided, expected);
      } catch {
        return false;
      }
    },
  });
}
// A collector result is preflighted with one shared graph budget. This keeps
// the synchronous validation/normalization work bounded across all of its
// state maps, records, receipt payloads, and nested attributes.
const MAX_COLLECTOR_RESULT_NODES = MAX_ATTRIBUTE_NODES * 4;

const CONTROL_RECEIPT_KEYS = new Set([
  'schema', 'actionId', 'state', 'resource', 'createdAt', 'taskId', 'actorId',
  'leaseId', 'leaseRevision', 'completedAt', 'code', 'sourceDigest', 'sourceBytes',
  'resultBytes', 'durationMs', 'message', 'value',
]);
const NORMALIZED_RECORD_KEYS = new Set([
  'sequence', 'at', 'component', 'event', 'outcome', 'durationMs', 'attributes', 'truncated',
]);
const COLLECTOR_ERROR_KEYS = new Set(['collector', 'code', 'at', 'message', 'recoveryRequired']);
const NORMALIZED_ERROR_KEYS = new Set(['collector', 'code', 'at', 'recoveryRequired']);
const SUPPORT_PROVENANCE_KEYS = new Set([
  'application', 'releaseVersion', 'sourceSha', 'platform', 'architecture', 'verification',
]);
const SUPPORT_PROJECT_KEYS = new Set(['idDigest', 'relativePath']);
const SUPPORT_RECEIPT_KEYS = new Set([
  'sourceSchema', 'actionId', 'state', 'sourceState', 'resource', 'createdAt', 'taskId', 'actorId',
  'leaseId', 'leaseRevision', 'completedAt', 'code', 'durationMs', 'verification',
]);
const SUPPORT_RECEIPT_RESOURCE_KEYS = new Set(['kind', 'idDigest', 'generation']);
const SUPPORT_REDACTION_KEYS = new Set(['version', 'redactedFields', 'omittedFields', 'categories']);
const SUPPORT_TRUNCATION_KEYS = new Set([
  'recordsOmitted', 'receiptsOmitted', 'errorsOmitted', 'stateFieldsOmitted',
  'terminalLinesOmitted', 'bytesOmitted', 'fieldsTruncated', 'totalPayloadBounded',
]);
const SUPPORT_COMPATIBILITY_KEYS = new Set(['policy', 'minimumReaderVersion']);
// State maps are intentionally narrower than record attributes. A state key
// is part of the public diagnostic vocabulary, not an arbitrary identifier
// supplied by a collector.
const SAFE_STATE_KEYS = new Set([
  ...SAFE_DIAGNOSTIC_VALUES,
  'accelerated', 'backend', 'browser', 'capability', 'connected', 'diagnosticNote',
  'engine', 'fallback', 'graphics', 'healthy', 'mode', 'panes', 'provider',
  'recoveryRequired', 'renderer', 'safeState', 'status', 'state', 'surface',
  'supported', 'support', 'tmux', 'version', 'visible', 'webgl', 'wayland', 'x11',
  ...SAFE_DIAGNOSTIC_NUMBER_KEYS,
]);
// Record attributes are intentionally a smaller vocabulary than arbitrary
// collector objects. This prevents boolean/null values under caller-chosen
// keys from becoming an unbounded disclosure channel.
const SAFE_RECORD_ATTRIBUTE_KEYS = new Set([
  ...SAFE_STATE_KEYS,
  'relativePath',
  'safe',
  'values',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  try {
    return typeof (value as { then?: unknown }).then === 'function';
  } catch {
    return false;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNormalizationDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw Object.assign(new Error('support bundle normalization deadline exceeded'), {
      code: 'support_bundle_normalization_timeout',
    });
  }
}

function isNormalizationDeadlineError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  try {
    return (error as { code?: unknown }).code === 'support_bundle_normalization_timeout';
  } catch {
    return false;
  }
}

function limitedEntries(
  value: Record<string, unknown>,
  limit = MAX_ATTRIBUTE_SCAN_KEYS,
  deadlineAt?: number,
): Array<[string, unknown]> | undefined {
  try {
    const entries: Array<[string, unknown]> = [];
    let scanned = 0;
    for (const key in value) {
      assertNormalizationDeadline(deadlineAt);
      scanned += 1;
      if (scanned > limit) return undefined;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      entries.push([key, value[key]]);
    }
    return entries;
  } catch (error) {
    if (isNormalizationDeadlineError(error)) throw error;
    return undefined;
  }
}

type CollectorPayloadField = typeof COLLECTOR_ARRAY_FIELDS[number];

interface CollectorArraySnapshot {
  readonly length: number;
  readonly values?: readonly unknown[];
}

// Collector results are untrusted objects. Read payload arrays through a
// bounded snapshot so a throwing field/element getter cannot escape the
// recovery path, and avoid copying an array whose length is already too large.
function safeCollectorArrayValueSnapshot(value: unknown): CollectorArraySnapshot | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    if (length > MAX_ATTRIBUTE_SCAN_KEYS) return { length };
    const values: unknown[] = [];
    try {
      for (let index = 0; index < length; index += 1) values.push(value[index]);
      return { length, values };
    } catch {
      return { length };
    }
  } catch {
    return undefined;
  }
}

function safeCollectorArraySnapshot(value: unknown, field: CollectorPayloadField): CollectorArraySnapshot | undefined {
  try {
    if (!isRecord(value)) return undefined;
    return safeCollectorArrayValueSnapshot(value[field]);
  } catch {
    return undefined;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  deadlineAt?: number,
): boolean {
  const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
  return entries !== undefined && entries.every(([key]) => allowed.has(key));
}

function isBoundedInputValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES },
): boolean {
  assertNormalizationDeadline(budget.deadlineAt);
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth || budget.remaining <= 0) return false;
  budget.remaining -= 1;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_TEXT_SCAN_CHARS;
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.length <= MAX_ATTRIBUTE_SCAN_KEYS;
    for (let index = 0; valid && index < value.length; index += 1) {
      valid = isBoundedInputValue(value[index], depth + 1, seen, budget);
    }
  } else {
    if (!isRecord(value)) return false;
    const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, budget.deadlineAt);
    valid = entries !== undefined;
    for (const [key, child] of entries ?? []) {
      if (key.length > MAX_TEXT_SCAN_CHARS || !isBoundedInputValue(child, depth + 1, seen, budget)) {
        valid = false;
        break;
      }
    }
  }
  seen.delete(value);
  return valid;
}

function isCollectorRecordShape(value: unknown): value is SupportRecord {
  if (!isRecord(value)
    || !hasOnlyKeys(value, NORMALIZED_RECORD_KEYS)
    || finiteNonNegativeInteger(value.sequence) === undefined
    || safeCanonicalTimestamp(value.at) === undefined
    || typeof value.component !== 'string'
    || value.component.length === 0
    || value.component.length > MAX_TEXT_SCAN_CHARS
    || typeof value.event !== 'string'
    || value.event.length === 0
    || value.event.length > MAX_TEXT_SCAN_CHARS
    || (value.outcome !== undefined && (typeof value.outcome !== 'string' || value.outcome.length > MAX_TEXT_SCAN_CHARS))
    || (value.durationMs !== undefined
      && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0))
    || (value.attributes !== undefined && !isRecord(value.attributes))
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return false;
  return true;
}

function isCollectorReceiptShape(value: unknown): value is ActionStatusReceipt {
  return isRecord(value)
    && hasOnlyKeys(value, CONTROL_RECEIPT_KEYS)
    && isActionStatusReceipt(value);
}

function isCollectorErrorShape(value: unknown): value is SupportCollectionError {
  if (!isRecord(value)
    || !hasOnlyKeys(value, COLLECTOR_ERROR_KEYS)
    || typeof value.collector !== 'string'
    || value.collector.length === 0
    || value.collector.length > MAX_TEXT_SCAN_CHARS
    || typeof value.code !== 'string'
    || value.code.length === 0
    || value.code.length > MAX_TEXT_SCAN_CHARS
    || typeof value.at !== 'string'
    || value.at.length > MAX_TEXT_SCAN_CHARS
    || (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > MAX_TEXT_SCAN_CHARS))
    || (value.recoveryRequired !== undefined && typeof value.recoveryRequired !== 'boolean')) return false;
  return true;
}

function safeCollectorRecordShape(value: unknown): value is SupportRecord {
  try {
    return isCollectorRecordShape(value);
  } catch {
    return false;
  }
}

function safeCollectorReceiptShape(value: unknown): value is ActionStatusReceipt {
  try {
    return isCollectorReceiptShape(value);
  } catch {
    return false;
  }
}

function safeCollectorErrorShape(value: unknown): value is SupportCollectionError {
  try {
    return isCollectorErrorShape(value);
  } catch {
    return false;
  }
}

function collectorResultViolation(
  value: unknown,
  maxRecords: number = SUPPORT_BUNDLE_LIMITS.maxRecords,
  maxReceipts: number = SUPPORT_BUNDLE_LIMITS.maxReceipts,
  budget: NormalizationBudget = { remaining: MAX_COLLECTOR_RESULT_NODES },
): 'invalid' | 'overflow' | undefined {
  if (!isRecord(value)) return 'invalid';
  const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, budget.deadlineAt);
  if (!entries || entries.length === 0 || entries.length > ROOT_FIELDS.size
    || entries.some(([key]) => key.length > MAX_TEXT_SCAN_CHARS || !ROOT_FIELDS.has(key))) return 'invalid';
  if (!isBoundedInputValue(value, 0, new Set<object>(), budget)) return 'invalid';
  if (value.status !== undefined
    && value.status !== 'complete'
    && value.status !== 'partial'
    && value.status !== 'unknown'
    && value.status !== 'recovery_required') return 'invalid';
  if (value.generatedAt !== undefined && safeCanonicalTimestamp(value.generatedAt) === undefined) return 'invalid';
  if (value.ownerEpoch !== undefined && finiteNonNegativeInteger(value.ownerEpoch) === undefined) return 'invalid';
  for (const key of COLLECTOR_MAP_FIELDS) {
    if (value[key] !== undefined && !isRecord(value[key])) return 'invalid';
  }
  for (const key of COLLECTOR_ARRAY_FIELDS) {
    if (value[key] !== undefined && !Array.isArray(value[key])) return 'invalid';
  }
  if (Array.isArray(value.records) && value.records.length > maxRecords) return 'overflow';
  if (Array.isArray(value.receipts) && value.receipts.length > maxReceipts) return 'overflow';
  if (Array.isArray(value.errors) && value.errors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) return 'overflow';
  if (Array.isArray(value.terminalTail) && value.terminalTail.length > SUPPORT_BUNDLE_LIMITS.maxTerminalLines) return 'overflow';
  if (Array.isArray(value.records) && !value.records.every((item) => isCollectorRecordShape(item))) return 'invalid';
  if (Array.isArray(value.receipts) && !value.receipts.every((item) => isCollectorReceiptShape(item))) return 'invalid';
  if (Array.isArray(value.errors) && !value.errors.every((item) => isCollectorErrorShape(item))) return 'invalid';
  if (Array.isArray(value.terminalTail)
    && !value.terminalTail.every((item) => typeof item === 'string' && item.length <= MAX_TEXT_SCAN_CHARS)) return 'invalid';
  const hasPayload = entries.some(([key, item]) => {
    if (key === 'ownerEpoch') return true;
    if (COLLECTOR_ARRAY_FIELDS.includes(key as typeof COLLECTOR_ARRAY_FIELDS[number])) {
      return Array.isArray(item) && item.length > 0;
    }
    if (COLLECTOR_MAP_FIELDS.includes(key as typeof COLLECTOR_MAP_FIELDS[number])) {
      return isRecord(item) && (limitedEntries(item, MAX_ATTRIBUTE_SCAN_KEYS, budget.deadlineAt)?.length ?? 0) > 0;
    }
    return false;
  });
  if (!hasPayload) return 'invalid';
  return undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundedMetadataCount(value: unknown): number | undefined {
  const count = finiteNonNegativeInteger(value);
  return count !== undefined && count <= MAX_AUDIT_COUNT ? count : undefined;
}

function boundedByteCount(value: unknown): number | undefined {
  const count = finiteNonNegativeInteger(value);
  return count !== undefined && count <= MAX_BYTES_OMITTED ? count : undefined;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_AUDIT_COUNT)
    : 0;
}

function boundedBytes(value: number): number {
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_BYTES_OMITTED)
    : 0;
}

function seededAudit(
  input: SupportBundleInput,
  deadlineAt?: number,
  allowPrivateMetadata = false,
): MutableAudit {
  const audit: MutableAudit = {
    redactedFields: 0,
    omittedFields: 0,
    fieldsTruncated: 0,
    terminalLinesOmitted: 0,
    attributeNodesVisited: 0,
    categories: new Map(),
    deadlineAt,
  };
  // A caller-provided enumerable manifest is data, not evidence. Only a
  // manifest attached by our own normalization pass may be carried through a
  // second serialization pass; this prevents forged counters/categories.
  const manifest = allowPrivateMetadata && isRecord(input) ? REDACTION_AUDITS.get(input) : undefined;
  if (manifest?.version !== 1) return audit;
  const redactedFields = boundedMetadataCount(manifest.redactedFields);
  const omittedFields = boundedMetadataCount(manifest.omittedFields);
  if (redactedFields !== undefined) audit.redactedFields = redactedFields;
  if (omittedFields !== undefined) audit.omittedFields = omittedFields;
  for (const [category, count] of limitedEntries(manifest.categories, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt)
    ?.slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys) ?? []) {
    assertNormalizationDeadline(deadlineAt);
    if (!SAFE_REDACTION_CATEGORY_VALUES.has(category)) continue;
    const safeCount = boundedMetadataCount(count);
    if (safeCount !== undefined) audit.categories.set(category, safeCount);
  }
  return audit;
}

function normalizedSourceFingerprint(value: object, deadlineAt?: number): string | undefined {
  try {
    const entries = limitedEntries(value as Record<string, unknown>, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
    if (entries === undefined) return undefined;
    const source = Object.fromEntries(entries.filter(([key]) =>
      key !== 'redaction' && key !== 'truncation' && key !== 'accountingProof'));
    // Fingerprinting runs before sanitization when checking a previously
    // normalized object. Reject unbounded or hostile values before hashing so
    // that trust validation cannot become an unbounded raw-input operation.
    if (!isBoundedInputValue(source, 0, new Set<object>(), {
      remaining: MAX_COLLECTOR_RESULT_NODES,
      deadlineAt,
    })) return undefined;
    return createHash('sha256').update(serializeForSize(source, deadlineAt), 'utf8').digest('hex');
  } catch {
    return undefined;
  }
}

function metadataMatches(
  actual: unknown,
  expected: unknown,
  deadlineAt?: number,
): boolean {
  try {
    return serializeForSize(actual, deadlineAt) === serializeForSize(expected, deadlineAt);
  } catch {
    return false;
  }
}

function hasReusablePrivateMetadata(input: SupportBundleInput, deadlineAt?: number): boolean {
  try {
    if (!isRecord(input)) return false;
    const expectedFingerprint = NORMALIZED_SOURCE_FINGERPRINTS.get(input);
    if (expectedFingerprint === undefined
      || normalizedSourceFingerprint(input, deadlineAt) !== expectedFingerprint) return false;
    const manifest = REDACTION_AUDITS.get(input);
    if (manifest !== undefined && !metadataMatches(input.redaction, manifest, deadlineAt)) return false;
    const truncation = TRUSTED_TRUNCATIONS.get(input);
    if (truncation !== undefined
      && (input.truncation === undefined || !metadataMatches(input.truncation, truncation, deadlineAt))) return false;
    return manifest !== undefined
      || truncation !== undefined
      || TRUSTED_SUPPORT_FIELDS.has(input);
  } catch {
    return false;
  }
}

function safeLeaseRevision(value: unknown, audit: MutableAudit): number | undefined {
  if (value === undefined) return undefined;
  const revision = finiteNonNegativeInteger(value);
  return revision === undefined ? omit(audit, 'invalid-lease-revision') : revision;
}

function optionLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return ceiling;
  return Math.max(0, Math.min(ceiling, Math.floor(value)));
}

function optionElapsedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return SUPPORT_BUNDLE_LIMITS.maxElapsedMs;
  return Math.max(0, Math.min(SUPPORT_BUNDLE_LIMITS.maxElapsedMs, Math.floor(value)));
}

function suppliedCount(value: unknown): number {
  return boundedMetadataCount(value) ?? 0;
}

function boundedText(value: unknown, audit: MutableAudit, key = ''): string | undefined {
  assertNormalizationDeadline(audit.deadlineAt);
  if (typeof value !== 'string') return undefined;
  const scanInput = value.length > MAX_TEXT_SCAN_CHARS ? value.slice(0, MAX_TEXT_SCAN_CHARS) : value;
  const scrubbed = scrubText(scanInput, audit, key);
  assertNormalizationDeadline(audit.deadlineAt);
  const bytes = Buffer.byteLength(scrubbed, 'utf8');
  if (bytes <= SUPPORT_BUNDLE_LIMITS.maxStringBytes) return scrubbed;
  audit.fieldsTruncated += 1;
  note(audit, 'bounded-text');
  const suffix = '…';
  const prefixBytes = SUPPORT_BUNDLE_LIMITS.maxStringBytes - Buffer.byteLength(suffix, 'utf8');
  // Slice UTF-8 bytes once and let decoding discard a partial trailing code
  // point. This keeps hostile oversized strings linear instead of trimming
  // one JavaScript code unit at a time.
  const prefix = Buffer.from(scrubbed, 'utf8').subarray(0, prefixBytes).toString('utf8');
  return `${prefix}${suffix}`;
}

function safeCategory(value: unknown, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (!text) return undefined;
  if (SAFE_CATEGORY_VALUE.test(text)) return text;
  return omit(audit, 'unsafe-category');
}

function safeIdentifierDigest(
  value: unknown,
  audit: MutableAudit,
  key: string,
  acceptDigest = true,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string'
    || value.length > MAX_TEXT_SCAN_CHARS
    || byteLength(value) > SUPPORT_BUNDLE_LIMITS.maxStringBytes) {
    return omit(audit, 'identifier-too-large');
  }
  if (acceptDigest && isNonZeroDigest(value)) return value.toLowerCase();
  const text = boundedText(value, audit, key);
  if (!text || text !== value || !SAFE_CATEGORY_VALUE.test(text)) {
    return omit(audit, 'unsafe-identifier');
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function safeAllowlistedValue(
  value: unknown,
  audit: MutableAudit,
  key: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  const text = boundedText(value, audit, key);
  if (!text) return undefined;
  return allowed.has(text) ? text : omit(audit, 'untyped-category');
}

function safeDiagnosticCategory(value: unknown, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (!text) return undefined;
  if (SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(text)) return text;
  return omit(audit, 'untyped-category');
}

function safeDiagnosticValue(value: string, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (!text) return undefined;
  if (SAFE_DIAGNOSTIC_VALUES.has(text)
    || (key.toLowerCase().includes('version') && SAFE_VERSION_VALUE.test(text))) return text;
  return omit(audit, 'untyped-string');
}

function safeTimestamp(value: unknown, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (safeCanonicalTimestamp(text) === undefined) {
    return value === undefined ? undefined : omit(audit, 'invalid-timestamp');
  }
  return text;
}

function safeCanonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_TEXT_SCAN_CHARS || !ISO_TIMESTAMP.test(value)) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  const canonical = new Date(parsed).toISOString();
  return canonical === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? value : undefined;
}

function scrubText(value: string, audit: MutableAudit, key: string): string {
  assertNormalizationDeadline(audit.deadlineAt);
  let result = value.replace(ANSI, '');
  let changed = result !== value;
  for (const [pattern, category] of [
    [PEM, 'certificate-or-key'],
    [BEARER, 'authorization'],
    [API_TOKEN, 'token'],
    [SENSITIVE_ASSIGNMENT, 'secret-assignment'],
    [CLOUD_CREDENTIAL_ASSIGNMENT, 'secret-assignment'],
    [AUTHORIZATION_LABELED_VALUE, 'authorization'],
    [SENSITIVE_LABELED_VALUE, 'secret-labeled-value'],
    [SENSITIVE_PHRASE, 'secret-phrase'],
    [INFRASTRUCTURE_URL, 'infrastructure-url'],
  ] as const) {
    assertNormalizationDeadline(audit.deadlineAt);
    const next = result.replace(pattern, '[redacted]');
    const matched = next !== result;
    changed ||= matched;
    result = next;
    if (matched) note(audit, category);
  }
  assertNormalizationDeadline(audit.deadlineAt);
  const pathRedacted = result.replace(ABSOLUTE_PATH_FRAGMENT, '[redacted-path]');
  if (pathRedacted !== result) {
    result = pathRedacted;
    changed = true;
    note(audit, 'absolute-path');
  }
  if (changed) {
    audit.redactedFields += 1;
    note(audit, key.toLowerCase().includes('terminal') ? 'terminal-redaction' : 'sensitive-text');
  }
  return result;
}

function safeAttributeKey(key: string, audit: MutableAudit): string | undefined {
  if (!SAFE_ATTRIBUTE_KEY.test(key) || key.includes('/') || key.includes('\\')) {
    return omit(audit, 'unsafe-field-name');
  }
  return key;
}

function note(audit: MutableAudit, category: string): void {
  audit.categories.set(category, (audit.categories.get(category) ?? 0) + 1);
}

function redact(value: unknown, audit: MutableAudit, category: string): string {
  if (value === '[redacted]') return '[redacted]';
  audit.redactedFields += 1;
  note(audit, category);
  return '[redacted]';
}

function omit(audit: MutableAudit, category: string): undefined {
  audit.omittedFields += 1;
  note(audit, category);
  return undefined;
}

function normalizeHomePath(value: string, homeDirectory: string | undefined): string {
  if (!homeDirectory) return value;
  const normalizedHome = homeDirectory.replace(/[\\/]+$/, '');
  if (value === normalizedHome) return '~';
  if (value.startsWith(`${normalizedHome}/`) || value.startsWith(`${normalizedHome}\\`)) {
    return `~/${value.slice(normalizedHome.length + 1).replaceAll('\\', '/')}`;
  }
  return value;
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.length > 0
    && byteLength(normalized) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes
    && !normalized.startsWith('/')
    && !normalized.split('/').some((segment) => segment === '..')
    && !SENSITIVE_RELATIVE_PATH.test(normalized)
    && !hasSensitiveToken(normalized)
    && /^[A-Za-z0-9._/-]+$/.test(normalized);
}

function hasSensitiveToken(value: string): boolean {
  API_TOKEN.lastIndex = 0;
  const matched = API_TOKEN.test(value);
  API_TOKEN.lastIndex = 0;
  return matched;
}

function safeRelativePath(value: unknown, audit: MutableAudit): string | undefined {
  if (typeof value !== 'string') {
    return value === undefined ? undefined : omit(audit, 'unsafe-relative-path');
  }
  if (value.length > MAX_TEXT_SCAN_CHARS) {
    return omit(audit, 'relative-path-too-long');
  }
  const normalized = value.replaceAll('\\', '/');
  if (!isSafeRelativePath(normalized)) {
    return omit(audit, 'unsafe-relative-path');
  }
  if (scrubText(normalized, audit, 'relativePath') !== normalized) {
    return omit(audit, 'unsafe-relative-path');
  }
  if (byteLength(normalized) > SUPPORT_BUNDLE_LIMITS.maxStringBytes) {
    return omit(audit, 'relative-path-too-long');
  }
  if (normalized.length === 0) {
    return value === undefined ? undefined : omit(audit, 'unsafe-relative-path');
  }
  return normalized;
}

function safeUnknown(
  value: unknown,
  audit: MutableAudit,
  key: string,
  depth: number,
  homeDirectory: string | undefined,
  stateKeyPolicy = false,
  keyPolicy?: ReadonlySet<string>,
): unknown {
  assertNormalizationDeadline(audit.deadlineAt);
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return omit(audit, 'attribute-depth');
  if (audit.attributeNodesVisited >= MAX_ATTRIBUTE_NODES) return omit(audit, 'attribute-node-limit');
  audit.attributeNodesVisited += 1;
  if (SENSITIVE_KEY.test(key)) return omit(audit, 'secret-field');
  if (CONTENT_KEY.test(key)) return omit(audit, 'content-field');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return omit(audit, 'non-finite-number');
    return SAFE_DIAGNOSTIC_NUMBER_KEYS.has(key.toLowerCase())
      ? value
      : omit(audit, 'untyped-number');
  }
  if (typeof value === 'string') {
    if (URL_KEY.test(key) && /^\w+:\/\//.test(value)) return redact(value, audit, 'infrastructure-url');
    if (key === 'relativePath') return safeRelativePath(value, audit);
    if (ABSOLUTE_PATH.test(value)) {
      const normalized = normalizeHomePath(value, homeDirectory);
      if (normalized !== value && !ABSOLUTE_PATH.test(normalized)) return safeCategory(normalized, audit, key);
      return redact(value, audit, 'absolute-path');
    }
    return safeDiagnosticValue(value, audit, key);
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    try {
      const itemCount = Math.min(value.length, SUPPORT_BUNDLE_LIMITS.maxAttributeItems);
      for (let index = 0; index < itemCount; index += 1) {
        const safe = safeUnknown(value[index], audit, key, depth + 1, homeDirectory, stateKeyPolicy, keyPolicy);
        if (safe !== undefined) output.push(safe);
      }
      if (value.length > output.length) {
        audit.fieldsTruncated += value.length - output.length;
        note(audit, 'attribute-items');
      }
    } catch (error) {
      if (isNormalizationDeadlineError(error)) throw error;
      return omit(audit, 'unsupported-value');
    }
    return output;
  }
  if (!isRecord(value)) return omit(audit, 'unsupported-value');
  const entries = boundedEntries(value, audit);
  if (!entries) return {};
  const output: Record<string, unknown> = {};
  const selectedEntries = entries
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys);
  assertNormalizationDeadline(audit.deadlineAt);
  for (const [childKey, childValue] of selectedEntries) {
    const outputKey = safeAttributeKey(childKey, audit);
    if (!outputKey) continue;
    if (stateKeyPolicy && !SAFE_STATE_KEYS.has(childKey)) {
      omit(audit, 'unsafe-state-key');
      continue;
    }
    if (keyPolicy && !keyPolicy.has(childKey)) {
      omit(audit, SENSITIVE_KEY.test(childKey) ? 'secret-field' : 'unsafe-field-name');
      continue;
    }
    const safe = safeUnknown(childValue, audit, childKey, depth + 1, homeDirectory, stateKeyPolicy, keyPolicy);
    if (safe !== undefined) output[outputKey] = safe;
  }
  if (entries.length > selectedEntries.length) {
    audit.fieldsTruncated += entries.length - selectedEntries.length;
    note(audit, 'attribute-keys');
  }
  return output;
}

function boundedEntries(value: Record<string, unknown>, audit: MutableAudit): Array<[string, unknown]> | undefined {
  const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, audit.deadlineAt);
  if (entries !== undefined) return entries;
  audit.fieldsTruncated += 1;
  note(audit, 'attribute-map-too-large');
  return undefined;
}

function safeMap(
  value: unknown,
  audit: MutableAudit,
  homeDirectory?: string,
  stateKeyPolicy = false,
  keyPolicy?: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  assertNormalizationDeadline(audit.deadlineAt);
  if (!isRecord(value)) return {};
  const entries = boundedEntries(value, audit);
  if (!entries) return {};
  const output: Record<string, unknown> = {};
  const selectedEntries = entries
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys);
  assertNormalizationDeadline(audit.deadlineAt);
  for (const [key, child] of selectedEntries) {
    const outputKey = safeAttributeKey(key, audit);
    if (!outputKey) continue;
    if (stateKeyPolicy && !SAFE_STATE_KEYS.has(key)) {
      omit(audit, 'unsafe-state-key');
      continue;
    }
    if (keyPolicy && !keyPolicy.has(key)) {
      omit(audit, SENSITIVE_KEY.test(key) ? 'secret-field' : 'unsafe-field-name');
      continue;
    }
    const safe = safeUnknown(child, audit, key, 0, homeDirectory, stateKeyPolicy, keyPolicy);
    if (safe !== undefined) output[outputKey] = safe;
  }
  if (entries.length > selectedEntries.length) {
    audit.fieldsTruncated += entries.length - selectedEntries.length;
    note(audit, 'attribute-keys');
  }
  return output;
}

function sanitizeProvenance(
  value: unknown,
  audit: MutableAudit,
  trustedControlPlane = false,
): SupportProvenance {
  const input = isRecord(value) ? value : {};
  const application = safeAllowlistedValue(
    input.application,
    audit,
    'application',
    SAFE_PROVENANCE_APPLICATION_VALUES,
  ) ?? 'psyche-build';
  const releaseVersion = safeDiagnosticValue(input.releaseVersion as string, audit, 'releaseVersion') ?? 'unknown';
  const platform = safeAllowlistedValue(
    input.platform,
    audit,
    'platform',
    SAFE_PROVENANCE_PLATFORM_VALUES,
  ) ?? 'unknown';
  const architecture = safeAllowlistedValue(
    input.architecture,
    audit,
    'architecture',
    SAFE_PROVENANCE_ARCHITECTURE_VALUES,
  ) ?? 'unknown';
  const sourceSha = typeof input.sourceSha === 'string' && input.sourceSha.length <= MAX_TEXT_SCAN_CHARS
    ? input.sourceSha
    : undefined;
  return {
    application,
    releaseVersion,
    sourceSha: sourceSha
      && isNonZeroSourceSha(sourceSha)
      ? sourceSha.toLowerCase()
      : 'unknown',
    platform,
    architecture,
    ...(trustedControlPlane ? {} : { verification: 'unverified' as const }),
  };
}

function isNormalizedProvenance(value: unknown, deadlineAt?: number): value is SupportProvenance {
  return isRecord(value)
    && hasOnlyKeys(value, SUPPORT_PROVENANCE_KEYS, deadlineAt)
    && SAFE_PROVENANCE_APPLICATION_VALUES.has(value.application as string)
    && (value.releaseVersion === 'unknown'
      || (typeof value.releaseVersion === 'string' && SAFE_VERSION_VALUE.test(value.releaseVersion)))
    && (value.sourceSha === 'unknown'
      || (typeof value.sourceSha === 'string' && isCanonicalSourceSha(value.sourceSha)))
    && SAFE_PROVENANCE_PLATFORM_VALUES.has(value.platform as string)
    && SAFE_PROVENANCE_ARCHITECTURE_VALUES.has(value.architecture as string)
    && (value.verification === undefined || value.verification === 'unverified')
    && ['application', 'releaseVersion', 'sourceSha', 'platform', 'architecture']
      .every((key) => typeof value[key] === 'string' && byteLength(value[key] as string) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes);
}

function isCompleteProvenance(value: unknown): value is SupportProvenance {
  return isNormalizedProvenance(value)
    && value.verification === undefined
    && value.application !== 'unknown'
    && value.releaseVersion !== 'unknown'
      && isNonZeroSourceSha(value.sourceSha)
    && value.platform !== 'unknown'
    && value.architecture !== 'unknown';
}

function sanitizeProject(value: unknown, audit: MutableAudit, homeDirectory?: string): SupportProjectIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const suppliedDigest = typeof value.idDigest === 'string' && isNonZeroDigest(value.idDigest)
    ? value.idDigest.toLowerCase()
    : undefined;
  const identity = value.id ?? value.identity ?? value.name ?? value.relativePath;
  const identityText = typeof identity === 'string' && identity.length <= MAX_TEXT_SCAN_CHARS ? identity : undefined;
  if (!suppliedDigest && identity !== undefined && identityText === undefined) {
    omit(audit, 'project-identity-too-large');
    return undefined;
  }
  if (!suppliedDigest && identityText === undefined) return undefined;
  const idDigest = suppliedDigest ?? createHash('sha256').update(identityText!, 'utf8').digest('hex');
  const relativePath = safeRelativePath(value.relativePath, audit);
  return {
    idDigest,
    ...(relativePath ? { relativePath } : {}),
  };
}

function sanitizeState(value: unknown, audit: MutableAudit, homeDirectory?: string): Readonly<Record<string, unknown>> {
  return safeMap(value, audit, homeDirectory, true);
}

function sanitizeStatus(value: unknown, audit: MutableAudit): SupportBundleStatus {
  if (value === 'complete' || value === 'partial' || value === 'unknown' || value === 'recovery_required') return value;
  if (value !== undefined) note(audit, 'invalid-status');
  return value === undefined ? 'complete' : 'unknown';
}

function combineStatus(
  requested: SupportBundleStatus,
  errors: readonly SupportCollectionError[],
  provenanceComplete = true,
  receiptsAuthoritative = true,
): SupportBundleStatus {
  if (requested === 'recovery_required' || errors.some((error) => error.recoveryRequired)) return 'recovery_required';
  if (requested === 'unknown') return 'unknown';
  if (requested === 'partial' || errors.length > 0) return 'partial';
  if (!provenanceComplete) return 'partial';
  if (!receiptsAuthoritative) return 'partial';
  return 'complete';
}

function appendBoundedError(errors: SupportCollectionError[], error: SupportCollectionError): boolean {
  if (errors.length < SUPPORT_BUNDLE_LIMITS.maxErrorChain) {
    errors.push(error);
    return false;
  }
  const replacementIndex = errors.findIndex((item) => !item.recoveryRequired && item.code !== 'collection_conflict');
  if (error.code === 'collection_conflict' && !errors.some((item) => item.code === 'collection_conflict')) {
    errors[replacementIndex >= 0 ? replacementIndex : errors.length - 1] = error;
    return true;
  }
  if (error.recoveryRequired && !errors.some((item) => item.recoveryRequired)) {
    errors[replacementIndex >= 0 ? replacementIndex : errors.length - 1] = error;
    return true;
  }
  return true;
}

function compareSupportErrors(left: SupportCollectionError, right: SupportCollectionError): number {
  return compareCodeUnits(left.at, right.at)
    || compareCodeUnits(left.collector, right.collector)
    || compareCodeUnits(left.code, right.code)
    || Number(Boolean(left.recoveryRequired)) - Number(Boolean(right.recoveryRequired))
    || compareCodeUnits(left.message ?? '', right.message ?? '');
}

function safeRecoveryError(value: unknown): SupportCollectionError {
  try {
    const input = isRecord(value) ? value : {};
    const collector = typeof input.collector === 'string' && SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(input.collector)
      ? input.collector
      : 'support-bundle';
    const code = typeof input.code === 'string' && SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(input.code)
      ? input.code
      : 'collection_failed';
    const at = safeCanonicalTimestamp(input.at) ?? 'unknown';
    return {
      collector,
      code,
      at,
      recoveryRequired: true,
    };
  } catch {
    return {
      collector: 'support-bundle',
      code: 'collection_failed',
      at: 'unknown',
      recoveryRequired: true,
    };
  }
}

function attachRecoveryMetadata(
  bundle: SupportBundle,
  codec?: SupportBundleCodec,
): SupportBundle {
  REDACTION_AUDITS.set(bundle, freezeRedactionManifest(bundle.redaction));
  TRUSTED_TRUNCATIONS.set(bundle, Object.freeze({ ...bundle.truncation }));
  TRUSTED_SUPPORT_FIELDS.set(bundle, Object.freeze(new Set<TrustedSupportField>()));
  if (codec !== undefined) SUPPORT_BUNDLE_CODECS.set(bundle, codec);
  const sourceFingerprint = normalizedSourceFingerprint(bundle, undefined);
  if (sourceFingerprint !== undefined) NORMALIZED_SOURCE_FINGERPRINTS.set(bundle, sourceFingerprint);
  return bundle;
}

function minimalRecoveryBundle(
  code: string,
  additionalErrors: readonly unknown[] = [],
  codec?: SupportBundleCodec,
  maxBundleBytes = SUPPORT_BUNDLE_LIMITS.maxBundleBytes,
  snapshot: RecoveryPayloadSnapshot = {},
): SupportBundle {
  const generatedAt = new Date(Date.now()).toISOString();
  const safeAdditionalErrors = additionalErrors.map(safeRecoveryError).sort(compareSupportErrors);
  const retainedAdditionalErrors = safeAdditionalErrors.slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain - 1);
  const priorTruncation = snapshot.truncation ?? {};
  const bundle: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    version: SUPPORT_BUNDLE_VERSION,
    compatibility: SUPPORT_BUNDLE_COMPATIBILITY,
    generatedAt,
    status: 'recovery_required',
    provenance: {
      application: 'psyche-build',
      releaseVersion: 'unknown',
      sourceSha: 'unknown',
      platform: 'unknown',
      architecture: 'unknown',
      ...(codec === undefined ? { verification: 'unverified' as const } : {}),
    },
    lifecycle: {},
    providers: {},
    persistence: {},
    updater: {},
    terminalTail: [],
    records: [],
    receipts: [],
    errors: [
      ...retainedAdditionalErrors,
      { collector: 'support-bundle', code, at: generatedAt, recoveryRequired: true },
    ],
    redaction: { version: 1, redactedFields: 0, omittedFields: 0, categories: {} },
    truncation: {
      recordsOmitted: boundedCount(suppliedCount(priorTruncation.recordsOmitted)
        + (snapshot.records?.length ?? 0)),
      receiptsOmitted: boundedCount(suppliedCount(priorTruncation.receiptsOmitted)
        + (snapshot.receipts?.length ?? 0)),
      errorsOmitted: boundedCount(suppliedCount(priorTruncation.errorsOmitted)
        + safeAdditionalErrors.length - retainedAdditionalErrors.length),
      stateFieldsOmitted: suppliedCount(priorTruncation.stateFieldsOmitted),
      terminalLinesOmitted: boundedCount(suppliedCount(priorTruncation.terminalLinesOmitted)
        + (snapshot.terminalTail?.length ?? 0)),
      bytesOmitted: boundedBytes(suppliedCount(priorTruncation.bytesOmitted)),
      fieldsTruncated: suppliedCount(priorTruncation.fieldsTruncated),
      totalPayloadBounded: true,
    },
  };
  const fitInput = codec === undefined
    ? bundle
    : { ...bundle, accountingProof: ACCOUNTING_PROOF_PLACEHOLDER };
  const fitted = fitBundle(fitInput, maxBundleBytes).bundle;
  const output = codec === undefined
    ? fitted
    : { ...fitted, accountingProof: signAccountingProof(fitted, codec) };
  return attachRecoveryMetadata(output, codec);
}

function sanitizeRecord(value: unknown, audit: MutableAudit, homeDirectory?: string): SupportRecord | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = finiteNonNegativeInteger(value.sequence);
  const at = safeTimestamp(value.at, audit, 'at');
  const component = safeDiagnosticCategory(value.component, audit, 'component');
  const event = safeDiagnosticCategory(value.event, audit, 'event');
  if (sequence === undefined || !at || !component || !event) return undefined;
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  const outcome = safeDiagnosticCategory(value.outcome, audit, 'outcome');
  const attributes = value.attributes === undefined
    ? undefined
    : safeMap(value.attributes, audit, homeDirectory, false, SAFE_RECORD_ATTRIBUTE_KEYS);
  return {
    sequence,
    at,
    component,
    event,
    ...(outcome ? { outcome } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(attributes && limitedEntries(attributes)?.length ? { attributes } : {}),
  };
}

function mapActionState(state: ActionReceiptState): SupportActionState {
  switch (state) {
    case 'queued':
    case 'approval_required':
      return 'pending';
    case 'running':
      return 'executing';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'denied':
      return 'failed';
    case 'expired':
      return 'invalidated';
    case 'unknown':
      return 'unknown';
  }
}

function receiptResource(value: ActionStatusReceipt): SupportReceipt['resource'] {
  if (value.resource.kind === 'project') {
    return {
      kind: 'project',
      idDigest: 'id' in value.resource
        ? createHash('sha256').update(value.resource.id, 'utf8').digest('hex')
        : value.resource.idDigest,
    };
  }
  return {
    kind: value.resource.kind,
    idDigest: 'id' in value.resource
      ? createHash('sha256').update(value.resource.id, 'utf8').digest('hex')
      : value.resource.idDigest,
    generation: (value.resource as { generation: number }).generation,
  };
}

function hasBoundedReceiptIdentity(value: ActionStatusReceipt): boolean {
  const resource = value.resource;
  return !('id' in resource)
    || (typeof resource.id === 'string' && resource.id.length <= MAX_TEXT_SCAN_CHARS);
}

function isSupportReceiptProjection(value: unknown, deadlineAt?: number): value is SupportReceipt {
  assertNormalizationDeadline(deadlineAt);
  if (!isRecord(value)
    || !hasOnlyKeys(value, SUPPORT_RECEIPT_KEYS, deadlineAt)
    || value.sourceSchema !== 'psyche.control.receipt/v1'
    || typeof value.actionId !== 'string'
    || !isCanonicalDigest(value.actionId)
    || byteLength(value.actionId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes
    || !isActionReceiptState(value.sourceState)
    || !(SUPPORT_ACTION_STATES as readonly unknown[]).includes(value.state)
    || value.state !== mapActionState(value.sourceState)
    || safeCanonicalTimestamp(value.createdAt) === undefined || !isRecord(value.resource)
    || (value.taskId !== undefined && (typeof value.taskId !== 'string' || !isCanonicalDigest(value.taskId) || byteLength(value.taskId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.actorId !== undefined && (typeof value.actorId !== 'string' || !isCanonicalDigest(value.actorId) || byteLength(value.actorId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.leaseId !== undefined && (typeof value.leaseId !== 'string' || !isCanonicalDigest(value.leaseId) || byteLength(value.leaseId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.leaseRevision !== undefined && finiteNonNegativeInteger(value.leaseRevision) === undefined)
    || (value.completedAt !== undefined && safeCanonicalTimestamp(value.completedAt) === undefined)
    || (value.code !== undefined && (typeof value.code !== 'string'
      || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.code)
      || byteLength(value.code) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.durationMs !== undefined
      && (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs)
        || value.durationMs < 0 || value.durationMs > 86_400_000))
    || (value.verification !== undefined && value.verification !== 'unverified')) return false;
  const resource = value.resource;
  return (resource !== undefined)
    && hasOnlyKeys(
      resource,
      resource.kind === 'project' ? new Set(['kind', 'idDigest']) : SUPPORT_RECEIPT_RESOURCE_KEYS,
      deadlineAt,
    )
    && (resource.kind === 'project' || resource.kind === 'pane' || resource.kind === 'browser_tab')
    && typeof resource.idDigest === 'string'
    && isCanonicalDigest(resource.idDigest)
    && (resource.kind === 'project'
      ? resource.generation === undefined
      : typeof resource.generation === 'number'
        && Number.isSafeInteger(resource.generation)
        && resource.generation >= 1);
}

function sanitizeProjectedReceipt(
  value: SupportReceipt,
  audit: MutableAudit,
  trustedControlPlane = false,
): SupportReceipt | undefined {
  if (!isSupportReceiptProjection(value, audit.deadlineAt)) return undefined;
  const actionId = safeIdentifierDigest(value.actionId, audit, 'actionId');
  const createdAt = safeTimestamp(value.createdAt, audit, 'createdAt');
  if (!actionId || !createdAt) return undefined;
  const taskId = value.taskId === undefined ? undefined : safeIdentifierDigest(value.taskId, audit, 'taskId');
  const actorId = value.actorId === undefined ? undefined : safeIdentifierDigest(value.actorId, audit, 'actorId');
  const leaseId = value.leaseId === undefined ? undefined : safeIdentifierDigest(value.leaseId, audit, 'leaseId');
  const leaseRevision = safeLeaseRevision(value.leaseRevision, audit);
  const completedAt = value.completedAt === undefined ? undefined : safeTimestamp(value.completedAt, audit, 'completedAt');
  const code = value.code === undefined ? undefined : safeDiagnosticCategory(value.code, audit, 'code');
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  return {
    sourceSchema: 'psyche.control.receipt/v1',
    actionId,
    state: mapActionState(value.sourceState),
    sourceState: value.sourceState,
    resource: {
      kind: value.resource.kind,
      idDigest: value.resource.idDigest.toLowerCase(),
      ...(value.resource.generation !== undefined ? { generation: value.resource.generation } : {}),
    },
    createdAt,
    ...(taskId ? { taskId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(leaseRevision !== undefined ? { leaseRevision } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(value.verification === 'unverified' || !trustedControlPlane
      ? { verification: 'unverified' as const }
      : {}),
  };
}

function sanitizeReceipt(
  value: unknown,
  audit: MutableAudit,
  mode: 'raw' | 'projected' = 'raw',
  trustedControlPlane = false,
): SupportReceipt | undefined {
  if (mode === 'projected') {
    if (!isSupportReceiptProjection(value, audit.deadlineAt)) {
      if (value !== undefined) note(audit, 'non-normalized-receipt');
      return undefined;
    }
    return sanitizeProjectedReceipt(value, audit, trustedControlPlane);
  }
  if (!isActionStatusReceipt(value)) {
    if (value !== undefined) note(audit, 'non-authoritative-receipt');
    return undefined;
  }
  if (!hasBoundedReceiptIdentity(value)) {
    note(audit, 'receipt-identity-too-large');
    return undefined;
  }
  const resource = receiptResource(value);
  if (!isNonZeroDigest(resource.idDigest)) {
    note(audit, 'non-authoritative-receipt');
    return undefined;
  }
  const actionId = safeIdentifierDigest(value.actionId, audit, 'actionId', false);
  const createdAt = safeTimestamp(value.createdAt, audit, 'createdAt');
  if (!actionId || !createdAt) return undefined;
  const taskId = value.taskId === undefined ? undefined : safeIdentifierDigest(value.taskId, audit, 'taskId', false);
  const actorId = value.actorId === undefined ? undefined : safeIdentifierDigest(value.actorId, audit, 'actorId', false);
  const leaseId = value.leaseId === undefined ? undefined : safeIdentifierDigest(value.leaseId, audit, 'leaseId', false);
  const completedAt = safeTimestamp(value.completedAt, audit, 'completedAt');
  const code = safeDiagnosticCategory(value.code, audit, 'code');
  const leaseRevision = safeLeaseRevision(value.leaseRevision, audit);
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  return {
    sourceSchema: 'psyche.control.receipt/v1',
    actionId,
    state: mapActionState(value.state),
    sourceState: value.state,
    resource,
    createdAt,
    ...(taskId ? { taskId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(leaseRevision !== undefined ? { leaseRevision } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(trustedControlPlane ? {} : { verification: 'unverified' as const }),
  };
}

function sanitizeError(value: unknown, audit: MutableAudit): SupportCollectionError | undefined {
  if (!isRecord(value)) return undefined;
  const collector = safeDiagnosticCategory(value.collector, audit, 'collector') ?? 'unknown';
  const code = safeDiagnosticCategory(value.code, audit, 'code') ?? 'collection_failed';
  const at = value.at === 'unknown'
    ? 'unknown'
    : safeTimestamp(value.at, audit, 'at') ?? 'unknown';
  if (value.message !== undefined) omit(audit, 'error-message');
  return {
    collector,
    code,
    at,
    ...(value.recoveryRequired === true ? { recoveryRequired: true } : {}),
  };
}

function sanitizeTerminalTail(value: unknown, audit: MutableAudit): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    omit(audit, 'terminal-field');
    return [];
  }
  if (value.length === 0) return [];
  // Arbitrary terminal output is not a typed diagnostic contract. Do not try
  // to make it safe with increasingly clever regexes: omit it before reading
  // any line so secrets and paths beyond a scan window cannot survive.
  const omitted = Math.min(value.length, Number.MAX_SAFE_INTEGER);
  audit.terminalLinesOmitted += omitted;
  audit.omittedFields += omitted;
  note(audit, 'terminal-omitted');
  return [];
}

function stableValue(
  value: unknown,
  budget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES * 4 },
  seen = new Set<object>(),
): unknown {
  assertNormalizationDeadline(budget.deadlineAt);
  if (value === null || typeof value !== 'object') return value;
  if (budget.remaining <= 0 || seen.has(value)) throw new Error('support bundle normalization graph is not bounded');
  budget.remaining -= 1;
  seen.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    if (value.length > MAX_ATTRIBUTE_SCAN_KEYS) throw new Error('support bundle normalization array is not bounded');
    normalized = value.map((child) => stableValue(child, budget, seen));
  } else if (isRecord(value)) {
    const entries = limitedEntries(value as Record<string, unknown>, MAX_ATTRIBUTE_SCAN_KEYS, budget.deadlineAt);
    if (!entries) throw new Error('support bundle normalization map is not bounded');
    normalized = Object.fromEntries(entries
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, child]) => [key, stableValue(child, budget, seen)]));
  } else {
    throw new Error('support bundle normalization value is not supported');
  }
  seen.delete(value);
  return normalized;
}

function compareStableValues(left: unknown, right: unknown, deadlineAt?: number): number {
  assertNormalizationDeadline(deadlineAt);
  return compareCodeUnits(serializeForSize(left, deadlineAt), serializeForSize(right, deadlineAt));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function auditManifest(audit: MutableAudit): SupportRedactionManifest {
  return {
    version: 1,
    redactedFields: boundedCount(audit.redactedFields),
    omittedFields: boundedCount(audit.omittedFields),
    categories: Object.fromEntries([...audit.categories.entries()]
      .filter(([category, count]) => SAFE_REDACTION_CATEGORY_VALUES.has(category) && boundedMetadataCount(count) !== undefined)
      .map(([category, count]) => [category, boundedCount(count)] as const)
      .sort(([a], [b]) => compareCodeUnits(a, b))),
  };
}

function freezeRedactionManifest(manifest: SupportRedactionManifest): SupportRedactionManifest {
  return Object.freeze({
    ...manifest,
    categories: Object.freeze({ ...manifest.categories }),
  });
}

function serializeForSize(value: unknown, deadlineAt?: number): string {
  return JSON.stringify(stableValue(value, { remaining: MAX_ATTRIBUTE_NODES * 4, deadlineAt }));
}

/**
 * Accounting proofs cover the known v1 projection only. Unknown fields are
 * intentionally ignored by v1 readers and therefore cannot change the proof
 * payload; all known fields remain covered and tampering with them fails
 * verification. A future schema revision must add its fields to its own
 * canonical projection rather than widening this one implicitly.
 */
function accountingPayload(bundle: SupportBundle, deadlineAt?: number): string {
  const canonicalBundle = stripSupportBundleUnknownFields(bundle, deadlineAt ?? Date.now() + SUPPORT_BUNDLE_LIMITS.maxElapsedMs);
  if (canonicalBundle === undefined) {
    throw new Error('support bundle proof payload is not canonical');
  }
  const { accountingProof: _accountingProof, ...unsignedBundle } = canonicalBundle;
  return serializeForSize(unsignedBundle, deadlineAt);
}

function signAccountingProof(
  bundle: SupportBundle,
  codec: SupportBundleCodec,
  deadlineAt?: number,
): string {
  const payload = accountingPayload(bundle, deadlineAt);
  const proof = codec.sign(payload);
  const canonicalProof = typeof proof === 'string' ? proof.toLowerCase() : proof;
  if (!isAccountingProof(canonicalProof) || !codec.verify(payload, canonicalProof)) {
    throw Object.assign(new Error('support bundle codec returned an invalid accounting proof'), {
      code: 'support_bundle_accounting_proof_invalid',
    });
  }
  return canonicalProof;
}

function hasValidAccountingProof(
  bundle: unknown,
  codec: SupportBundleCodec,
  deadlineAt: number,
): bundle is SupportBundle {
  if (!isSupportBundleV1AtDeadline(bundle, deadlineAt)
    || !isAccountingProof(bundle.accountingProof)) return false;
  try {
    return codec.verify(accountingPayload(bundle, deadlineAt), bundle.accountingProof);
  } catch {
    return false;
  }
}

function verifiedSupportFields(bundle: SupportBundle): ReadonlySet<TrustedSupportField> {
  const fields = new Set<TrustedSupportField>();
  if (!(isRecord(bundle.provenance) && bundle.provenance.verification === 'unverified')) {
    fields.add('provenance');
  }
  if (!bundle.receipts.some((receipt) => receipt.verification === 'unverified')) {
    fields.add('receipts');
  }
  return Object.freeze(fields);
}

function isBoundedNormalizedValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES },
  key = '',
  stateKeyPolicy = false,
  keyPolicy?: ReadonlySet<string>,
): boolean {
  assertNormalizationDeadline(budget.deadlineAt);
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') {
    return Number.isFinite(value) && SAFE_DIAGNOSTIC_NUMBER_KEYS.has(key.toLowerCase());
  }
  if (typeof value === 'string') {
    return byteLength(value) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes
      && (key === 'relativePath'
        ? isSafeRelativePath(value)
        : SAFE_DIAGNOSTIC_VALUES.has(value)
          || (key.toLowerCase().includes('version') && SAFE_VERSION_VALUE.test(value)));
  }
  if (typeof value !== 'object') return false;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeItems;
    for (let index = 0; valid && index < value.length; index += 1) {
      valid = isBoundedNormalizedValue(value[index], depth + 1, seen, budget, key, stateKeyPolicy, keyPolicy);
    }
  } else {
    if (!isRecord(value)) return false;
    const entries = limitedEntries(value as Record<string, unknown>, MAX_ATTRIBUTE_SCAN_KEYS, budget.deadlineAt);
    valid = entries !== undefined && entries.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeKeys;
    for (const [key, child] of entries ?? []) {
      if (!SAFE_ATTRIBUTE_KEY.test(key)
        || (stateKeyPolicy && !SAFE_STATE_KEYS.has(key))
        || (keyPolicy !== undefined && !keyPolicy.has(key))
        || SENSITIVE_KEY.test(key)
        || CONTENT_KEY.test(key)
        || !isBoundedNormalizedValue(child, depth + 1, seen, budget, key, stateKeyPolicy, keyPolicy)) {
        valid = false;
        break;
      }
    }
  }
  seen.delete(value);
  return valid;
}

function isNormalizedRecord(
  value: unknown,
  deadlineAt?: number,
  budget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES },
): value is SupportRecord {
  assertNormalizationDeadline(deadlineAt);
  if (!isRecord(value)
    || !hasOnlyKeys(value, NORMALIZED_RECORD_KEYS, deadlineAt)
    || finiteNonNegativeInteger(value.sequence) === undefined
    || safeCanonicalTimestamp(value.at) === undefined
    || typeof value.component !== 'string'
    || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.component)
    || typeof value.event !== 'string'
    || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.event)
    || (value.outcome !== undefined
      && (typeof value.outcome !== 'string' || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.outcome)))
    || (value.durationMs !== undefined
      && (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs)
        || value.durationMs < 0 || value.durationMs > 86_400_000))
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
    || (value.attributes !== undefined && (!isRecord(value.attributes)
      || !isBoundedNormalizedValue(
        value.attributes,
        0,
        new Set<object>(),
        budget,
        '',
        false,
        SAFE_RECORD_ATTRIBUTE_KEYS,
      )))) return false;
  try {
    return byteLength(serializeForSize(value, deadlineAt)) <= SUPPORT_BUNDLE_LIMITS.maxRecordBytes;
  } catch {
    return false;
  }
}

function isNormalizedError(value: unknown, deadlineAt?: number): value is SupportCollectionError {
  assertNormalizationDeadline(deadlineAt);
  if (!isRecord(value)
    || !hasOnlyKeys(value, NORMALIZED_ERROR_KEYS, deadlineAt)
    || (typeof value.collector !== 'string' || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.collector))
    || (typeof value.code !== 'string' || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.code))
    || (value.at !== 'unknown' && safeCanonicalTimestamp(value.at) === undefined)
    || (value.recoveryRequired !== undefined && value.recoveryRequired !== true)) return false;
  return true;
}

function isNormalizedCounterMap(value: unknown, deadlineAt?: number): boolean {
  if (!isRecord(value)) return false;
  const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
  return entries !== undefined
    && entries.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeKeys
    && entries.every(([key, count]) => SAFE_REDACTION_CATEGORY_VALUES.has(key)
      && boundedMetadataCount(count) !== undefined);
}

function isSupportBundleV1AtDeadline(value: unknown, deadlineAt: number): value is SupportBundle {
  try {
    assertNormalizationDeadline(deadlineAt);
    if (!isRecord(value)
      || !hasOnlyKeys(value, ROOT_FIELDS, deadlineAt)
      || value.schema !== SUPPORT_BUNDLE_SCHEMA
      || value.version !== SUPPORT_BUNDLE_VERSION
      || !isRecord(value.compatibility)
      || safeCanonicalTimestamp(value.generatedAt) === undefined
      || !['complete', 'partial', 'unknown', 'recovery_required'].includes(String(value.status))
      || !isRecord(value.provenance)
      || !isRecord(value.lifecycle)
      || !isRecord(value.providers)
      || !isRecord(value.persistence)
      || !isRecord(value.updater)
      || !Array.isArray(value.terminalTail)
      || !Array.isArray(value.records)
      || !Array.isArray(value.receipts)
      || !Array.isArray(value.errors)
      || !isRecord(value.redaction)
      || !isRecord(value.truncation)
      || (value.accountingProof !== undefined
        && (!isAccountingProof(value.accountingProof)
          || value.accountingProof !== value.accountingProof.toLowerCase()))) return false;
    if (value.terminalTail.length !== 0
      || value.records.length > SUPPORT_BUNDLE_LIMITS.maxRecords
      || value.receipts.length > SUPPORT_BUNDLE_LIMITS.maxReceipts
      || value.errors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) return false;
    const recordBudget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES * 4, deadlineAt };
    const receiptIds = new Set<string>();
    const receiptsValid = value.receipts.every((receipt) => {
      if (!isSupportReceiptProjection(receipt, deadlineAt)) return false;
      const actionId = (receipt as SupportReceipt).actionId;
      if (receiptIds.has(actionId)) return false;
      receiptIds.add(actionId);
      return true;
    });
    if (!value.records.every((record) => isNormalizedRecord(record, deadlineAt, recordBudget))
      || !receiptsValid
      || !value.errors.every((error) => isNormalizedError(error, deadlineAt))) return false;
    const redaction = value.redaction;
    const truncation = value.truncation;
    const provenance = value.provenance;
    const provenanceKeys = ['application', 'releaseVersion', 'sourceSha', 'platform', 'architecture'] as const;
    const project = value.project;
    const stateBudget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES * 4, deadlineAt };
    const structurallyValid = hasOnlyKeys(value.compatibility, SUPPORT_COMPATIBILITY_KEYS, deadlineAt)
      && value.compatibility.policy === SUPPORT_BUNDLE_COMPATIBILITY.policy
      && value.compatibility.minimumReaderVersion === SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion
      && isNormalizedProvenance(provenance, deadlineAt)
      && provenanceKeys.every((key) => typeof provenance[key] === 'string'
        && byteLength(provenance[key]) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes)
      && (value.status !== 'complete' || isCompleteProvenance(provenance))
      && (value.status !== 'complete' || value.errors.length === 0)
      && (value.status !== 'complete' || value.receipts.every(
        (receipt) => isRecord(receipt) && receipt.verification === undefined,
      ))
      && (value.status !== 'complete' || isAccountingProof(value.accountingProof))
      && value.status === combineStatus(
        value.status as SupportBundleStatus,
        value.errors,
        isCompleteProvenance(provenance),
        value.receipts.every((receipt) => isRecord(receipt) && receipt.verification === undefined),
      )
      && (value.ownerEpoch === undefined || finiteNonNegativeInteger(value.ownerEpoch) !== undefined)
      && (project === undefined || (isRecord(project)
        && hasOnlyKeys(project, SUPPORT_PROJECT_KEYS, deadlineAt)
        && typeof project.idDigest === 'string'
        && isCanonicalDigest(project.idDigest)
        && project.name === undefined
        && (project.relativePath === undefined || (typeof project.relativePath === 'string'
          && byteLength(project.relativePath) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes
          && isSafeRelativePath(project.relativePath)))))
      && isBoundedNormalizedValue(value.lifecycle, 0, new Set<object>(), stateBudget, '', true)
      && isBoundedNormalizedValue(value.providers, 0, new Set<object>(), stateBudget, '', true)
      && isBoundedNormalizedValue(value.persistence, 0, new Set<object>(), stateBudget, '', true)
      && isBoundedNormalizedValue(value.updater, 0, new Set<object>(), stateBudget, '', true)
      && (value.graphics === undefined || (isRecord(value.graphics)
        && isBoundedNormalizedValue(value.graphics, 0, new Set<object>(), stateBudget, '', true)))
      && hasOnlyKeys(redaction, SUPPORT_REDACTION_KEYS, deadlineAt)
      && redaction.version === 1
      && boundedMetadataCount(redaction.redactedFields) !== undefined
      && boundedMetadataCount(redaction.omittedFields) !== undefined
      && isNormalizedCounterMap(redaction.categories, deadlineAt)
      && hasOnlyKeys(truncation, SUPPORT_TRUNCATION_KEYS, deadlineAt)
      && boundedMetadataCount(truncation.recordsOmitted) !== undefined
      && boundedMetadataCount(truncation.receiptsOmitted) !== undefined
      && boundedMetadataCount(truncation.errorsOmitted) !== undefined
      && boundedMetadataCount(truncation.stateFieldsOmitted) !== undefined
      && boundedMetadataCount(truncation.terminalLinesOmitted) !== undefined
      && boundedByteCount(truncation.bytesOmitted) !== undefined
      && boundedMetadataCount(truncation.fieldsTruncated) !== undefined
      && truncation.totalPayloadBounded === true;
    if (!structurallyValid) return false;
    return byteLength(serializeForSize(value, deadlineAt)) <= SUPPORT_BUNDLE_LIMITS.maxBundleBytes;
  } catch {
    return false;
  }
}

function stripKnownObjectFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  deadlineAt: number,
  nestedPolicy?: ReadonlySet<string>,
  depth = 0,
  budget: NormalizationBudget = { remaining: MAX_COLLECTOR_RESULT_NODES },
): unknown {
  if (!isRecord(value)) return value;
  assertNormalizationDeadline(deadlineAt);
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth || budget.remaining <= 0) {
    throw new Error('support bundle compatibility value is not bounded');
  }
  budget.remaining -= 1;
  const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
  if (entries === undefined) throw new Error('support bundle compatibility map is not bounded');
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (!allowed.has(key)) continue;
    output[key] = nestedPolicy === undefined
      ? child
      : stripNormalizedValue(child, nestedPolicy, deadlineAt, depth + 1, budget);
  }
  return output;
}

function stripNormalizedValue(
  value: unknown,
  keyPolicy: ReadonlySet<string>,
  deadlineAt: number,
  depth = 0,
  budget: NormalizationBudget = { remaining: MAX_COLLECTOR_RESULT_NODES },
): unknown {
  assertNormalizationDeadline(deadlineAt);
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth || budget.remaining <= 0) {
    throw new Error('support bundle compatibility value is not bounded');
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ATTRIBUTE_SCAN_KEYS) {
      throw new Error('support bundle compatibility array is not bounded');
    }
    budget.remaining -= 1;
    return value.map((child) => stripNormalizedValue(child, keyPolicy, deadlineAt, depth + 1, budget));
  }
  if (isRecord(value)) {
    return stripKnownObjectFields(value, keyPolicy, deadlineAt, keyPolicy, depth, budget);
  }
  budget.remaining -= 1;
  return value;
}

function stripSupportBundleUnknownFields(value: unknown, deadlineAt: number): SupportBundle | undefined {
  if (!isRecord(value)) return undefined;
  const budget: NormalizationBudget = { remaining: MAX_COLLECTOR_RESULT_NODES, deadlineAt };
  if (budget.remaining <= 0) return undefined;
  budget.remaining -= 1;
  const entries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
  if (entries === undefined) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (!ROOT_FIELDS.has(key)) continue;
    switch (key) {
      case 'compatibility':
        output[key] = stripKnownObjectFields(child, SUPPORT_COMPATIBILITY_KEYS, deadlineAt, undefined, 0, budget);
        break;
      case 'provenance':
        output[key] = stripKnownObjectFields(child, SUPPORT_PROVENANCE_KEYS, deadlineAt, undefined, 0, budget);
        break;
      case 'project':
        output[key] = stripKnownObjectFields(child, SUPPORT_PROJECT_KEYS, deadlineAt, undefined, 0, budget);
        break;
      case 'lifecycle':
      case 'providers':
      case 'persistence':
      case 'updater':
      case 'graphics':
        output[key] = stripNormalizedValue(child, SAFE_STATE_KEYS, deadlineAt, 0, budget);
        break;
      case 'records':
        output[key] = Array.isArray(child) ? child.map((record) => {
          if (!isRecord(record)) return record;
          const stripped = stripKnownObjectFields(
            record,
            NORMALIZED_RECORD_KEYS,
            deadlineAt,
            undefined,
            0,
            budget,
          ) as Record<string, unknown>;
          if (stripped.attributes !== undefined) {
            stripped.attributes = stripNormalizedValue(
              stripped.attributes,
              SAFE_RECORD_ATTRIBUTE_KEYS,
              deadlineAt,
              0,
              budget,
            );
          }
          return stripped;
        }) : child;
        break;
      case 'receipts':
        output[key] = Array.isArray(child) ? child.map((receipt) => {
          if (!isRecord(receipt)) return receipt;
          const stripped = stripKnownObjectFields(
            receipt,
            SUPPORT_RECEIPT_KEYS,
            deadlineAt,
            undefined,
            0,
            budget,
          ) as Record<string, unknown>;
          if (stripped.resource !== undefined) {
            stripped.resource = stripKnownObjectFields(
              stripped.resource,
              SUPPORT_RECEIPT_RESOURCE_KEYS,
              deadlineAt,
              undefined,
              0,
              budget,
            );
          }
          return stripped;
        }) : child;
        break;
      case 'errors':
        output[key] = Array.isArray(child)
          ? child.map((error) => stripKnownObjectFields(
            error,
            NORMALIZED_ERROR_KEYS,
            deadlineAt,
            undefined,
            0,
            budget,
          ))
          : child;
        break;
      case 'redaction': {
        const redaction = stripKnownObjectFields(
          child,
          SUPPORT_REDACTION_KEYS,
          deadlineAt,
          undefined,
          0,
          budget,
        ) as Record<string, unknown>;
        if (redaction.categories !== undefined) {
          redaction.categories = stripNormalizedValue(
            redaction.categories,
            SAFE_REDACTION_CATEGORY_VALUES,
            deadlineAt,
            0,
            budget,
          );
        }
        output[key] = redaction;
        break;
      }
      case 'truncation':
        output[key] = stripKnownObjectFields(child, SUPPORT_TRUNCATION_KEYS, deadlineAt, undefined, 0, budget);
        break;
      default:
        output[key] = child;
        break;
    }
  }
  return output as unknown as SupportBundle;
}

function hasSupportBundleEnvelope(value: unknown): value is SupportBundleInput {
  return isRecord(value)
    && value.schema === SUPPORT_BUNDLE_SCHEMA
    && value.version === SUPPORT_BUNDLE_VERSION
    && isRecord(value.compatibility)
    && value.compatibility.policy === SUPPORT_BUNDLE_COMPATIBILITY.policy
    && value.compatibility.minimumReaderVersion === SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion
    && safeCanonicalTimestamp(value.generatedAt) !== undefined;
}

export function isSupportBundleV1(value: unknown, codec?: SupportBundleCodec): value is SupportBundle {
  const deadlineAt = Date.now() + SUPPORT_BUNDLE_LIMITS.maxElapsedMs;
  if (!isSupportBundleV1AtDeadline(value, deadlineAt)) return false;
  const resolvedCodec = codec ?? SUPPORT_BUNDLE_CODECS.get(value);
  // Unsigned partial/recovery bundles are intentionally supported for callers
  // without the application-held codec. A supplied proof is different: it is
  // never evidence until a codec verifies it, regardless of bundle status.
  if (value.accountingProof !== undefined) {
    return resolvedCodec !== undefined && hasValidAccountingProof(value, resolvedCodec, deadlineAt);
  }
  return value.status !== 'complete';
}

function fitBundle(
  bundle: SupportBundle,
  maxBundleBytes: number,
  deadlineAt?: number,
): { bundle: SupportBundle } {
  let records = [...bundle.records];
  let receipts = [...bundle.receipts];
  let terminalTail = [...bundle.terminalTail];
  const stateSections: Array<keyof Pick<SupportBundle, 'lifecycle' | 'providers' | 'persistence' | 'updater' | 'graphics'>> = [
    'lifecycle', 'providers', 'persistence', 'updater', 'graphics',
  ];
  let recordsOmitted = bundle.truncation.recordsOmitted;
  let receiptsOmitted = bundle.truncation.receiptsOmitted;
  let terminalLinesOmitted = bundle.truncation.terminalLinesOmitted;
  let stateFieldsOmitted = bundle.truncation.stateFieldsOmitted;
  let source = bundle;
  const priorBytesOmitted = boundedByteCount(bundle.truncation.bytesOmitted) ?? 0;
  const withMetadata = (bytesOmitted: number): SupportBundle => ({
    ...source,
    records,
    receipts,
    terminalTail,
    truncation: {
      ...bundle.truncation,
      recordsOmitted,
      receiptsOmitted,
      terminalLinesOmitted,
      stateFieldsOmitted,
      bytesOmitted: boundedBytes(Math.max(priorBytesOmitted, bytesOmitted)),
      totalPayloadBounded: true,
    },
  });
  // Compare against the same final metadata shape used by candidates. The
  // previous false->true marker itself is metadata, not omitted payload.
  const originalBytes = byteLength(serializeForSize(withMetadata(0), deadlineAt));
  const stateCandidates = (): Array<{ section: typeof stateSections[number]; key: string; size: number }> => stateSections
    .flatMap((section) => {
      assertNormalizationDeadline(deadlineAt);
      const value = source[section];
      if (!value) return [];
      return (limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt) ?? []).map(([key, child]) => ({
        section,
        key,
        size: byteLength(serializeForSize(child, deadlineAt)),
      }));
    })
    .sort((a, b) => b.size - a.size
      || compareCodeUnits(a.section, b.section)
      || compareCodeUnits(a.key, b.key)
      || compareStableValues(a, b, deadlineAt));

  let candidate = withMetadata(0);
  while (true) {
    assertNormalizationDeadline(deadlineAt);
    const currentBytes = byteLength(serializeForSize(candidate, deadlineAt));
    if (currentBytes <= maxBundleBytes) {
      const finalCandidate = withMetadata(Math.max(0, originalBytes - currentBytes));
      const finalBytes = byteLength(serializeForSize(finalCandidate, deadlineAt));
      if (finalBytes <= maxBundleBytes) return { bundle: finalCandidate };
      candidate = finalCandidate;
    }

    if (records.length > 0) {
      recordsOmitted += 1;
      records = records.slice(1);
      candidate = withMetadata(0);
      continue;
    }
    if (terminalTail.length > 0) {
      terminalLinesOmitted += 1;
      terminalTail = terminalTail.slice(1);
      candidate = withMetadata(0);
      continue;
    }
    const state = stateCandidates().find((item) => {
      const current = source[item.section];
      return current !== undefined && item.key in current;
    });
    if (state) {
      const current = source[state.section];
      if (current) {
        const next = { ...current };
        delete next[state.key];
        source = { ...source, [state.section]: next };
        stateFieldsOmitted += 1;
        candidate = withMetadata(0);
        continue;
      }
    }
    if (receipts.length > 0) {
      receiptsOmitted += 1;
      receipts = receipts.slice(0, -1);
      candidate = withMetadata(0);
      continue;
    }

    // Every field entering here is bounded. Keep the safety contract explicit if
    // an integrator supplies an unusually small custom cap.
    const bytes = byteLength(serializeForSize(candidate, deadlineAt));
    throw Object.assign(new Error('support bundle exceeds the maximum payload size'), {
      code: 'support_bundle_size_exceeded',
      bytes,
      maxBytes: maxBundleBytes,
    });
  }
}

type ReceiptInputMode = 'raw' | 'projected';

function buildSupportBundleWithReceiptMode(
  input: SupportBundleInput,
  options: SupportBundleOptions,
  receiptMode: ReceiptInputMode,
  deadlineAt?: number,
): SupportBundle {
  const homeDirectory = options.homeDirectory;
  const controlPlaneAuthorized = options.authority === CONTROL_PLANE_AUTHORITY;
  const reusablePrivateMetadata = hasReusablePrivateMetadata(input, deadlineAt);
  const audit = seededAudit(input, deadlineAt, reusablePrivateMetadata);
  assertNormalizationDeadline(deadlineAt);
  const trustedInputFields = reusablePrivateMetadata && isRecord(input)
    ? TRUSTED_SUPPORT_FIELDS.get(input)
    : undefined;
  const trustedProvenance = receiptMode === 'raw'
    ? controlPlaneAuthorized || trustedInputFields?.has('provenance') === true
    : trustedInputFields?.has('provenance') === true;
  const maxRecords = optionLimit(options.maxRecords, SUPPORT_BUNDLE_LIMITS.maxRecords);
  const maxRecordBytes = optionLimit(options.maxRecordBytes, SUPPORT_BUNDLE_LIMITS.maxRecordBytes);
  const maxReceipts = optionLimit(options.maxReceipts, SUPPORT_BUNDLE_LIMITS.maxReceipts);
  const maxBundleBytes = optionLimit(options.maxBundleBytes, SUPPORT_BUNDLE_LIMITS.maxBundleBytes);
  const recordCandidates: SupportRecord[] = [];
  const rawRecords = Array.isArray(input.records) ? input.records : [];
  let invalidRecords = 0;
  const recordsInputOverflow = rawRecords.length > MAX_ATTRIBUTE_SCAN_KEYS;
  // Normalize the bounded candidate window before selecting the cap. This
  // makes over-cap inputs independent of collector/input insertion order.
  for (const raw of recordsInputOverflow ? [] : rawRecords) {
    assertNormalizationDeadline(deadlineAt);
    const record = sanitizeRecord(raw, audit, homeDirectory);
    if (!record) {
      invalidRecords += 1;
      audit.omittedFields += 1;
      note(audit, 'invalid-record');
      continue;
    }
    const recordBytes = byteLength(serializeForSize(record, deadlineAt));
    if (recordBytes > maxRecordBytes) {
      audit.fieldsTruncated += 1;
      note(audit, 'record-size');
      const compact: SupportRecord = {
        sequence: record.sequence,
        at: record.at,
        component: record.component,
        event: record.event,
        truncated: true,
      };
      if (byteLength(serializeForSize(compact, deadlineAt)) <= maxRecordBytes) recordCandidates.push(compact);
      else {
        audit.omittedFields += 1;
        note(audit, 'record-omitted');
      }
      continue;
    }
    recordCandidates.push(record);
  }
  recordCandidates.sort((a, b) => a.sequence - b.sequence
    || compareCodeUnits(a.at, b.at)
    || compareCodeUnits(a.component, b.component)
    || compareCodeUnits(a.event, b.event)
    || compareStableValues(a, b, deadlineAt));
  const records = recordCandidates.slice(0, maxRecords);
  if (rawRecords.length > records.length) {
    audit.fieldsTruncated += rawRecords.length - records.length;
    note(audit, 'record-count');
  }

  const receiptCandidates: SupportReceipt[] = [];
  let invalidReceipts = 0;
  const rawReceipts = Array.isArray(input.receipts) ? input.receipts : [];
  const trustedReceipts = receiptMode === 'raw'
    ? controlPlaneAuthorized || trustedInputFields?.has('receipts') === true
    : trustedInputFields?.has('receipts') === true;
  const receiptsInputOverflow = rawReceipts.length > MAX_ATTRIBUTE_SCAN_KEYS;
  for (const raw of receiptsInputOverflow ? [] : rawReceipts) {
    assertNormalizationDeadline(deadlineAt);
    const receipt = sanitizeReceipt(raw, audit, receiptMode, trustedReceipts);
    if (receipt) receiptCandidates.push(receipt);
    else {
      invalidReceipts += 1;
      audit.omittedFields += 1;
      note(audit, 'invalid-receipt');
    }
  }
  receiptCandidates.sort((a, b) => compareCodeUnits(a.actionId, b.actionId)
    || compareCodeUnits(a.sourceState, b.sourceState)
    || compareCodeUnits(a.createdAt, b.createdAt)
    || compareStableValues(a, b, deadlineAt));
  const receiptIds = new Set<string>();
  const duplicateReceiptIds = new Set<string>();
  let duplicateReceiptActionId = false;
  for (const receipt of receiptCandidates) {
    if (receiptIds.has(receipt.actionId)) {
      duplicateReceiptActionId = true;
      duplicateReceiptIds.add(receipt.actionId);
      note(audit, 'duplicate-action-id');
      continue;
    }
    receiptIds.add(receipt.actionId);
  }
  let receipts = receiptCandidates.filter((receipt) => !duplicateReceiptIds.has(receipt.actionId));
  receipts = receipts.slice(0, maxReceipts);
  if (rawReceipts.length > receipts.length) {
    audit.fieldsTruncated += rawReceipts.length - receipts.length;
    note(audit, 'receipt-count');
  }

  const errors: SupportCollectionError[] = [];
  // Only a prior result from this module can carry truncation accounting
  // forward. Public input is allowed to contain a similarly shaped field, but
  // its counters are data and must not be treated as audit evidence.
  const priorTruncation = reusablePrivateMetadata && isRecord(input)
    ? TRUSTED_TRUNCATIONS.get(input) ?? {}
    : {};
  let errorsOmitted = suppliedCount(priorTruncation.errorsOmitted);
  let invalidErrors = 0;
  const appendError = (error: SupportCollectionError): void => {
    if (appendBoundedError(errors, error)) errorsOmitted += 1;
  };
  const errorCandidates: SupportCollectionError[] = [];
  const rawErrors = Array.isArray(input.errors) ? input.errors : [];
  const errorsInputOverflow = rawErrors.length > MAX_ATTRIBUTE_SCAN_KEYS;
  if (errorsInputOverflow) {
    // Reject an unbounded array as a whole so a caller cannot change the
    // retained diagnostic prefix by merely reordering it.
    errorsOmitted += rawErrors.length;
  } else {
    for (const raw of rawErrors) {
      assertNormalizationDeadline(deadlineAt);
      const error = sanitizeError(raw, audit);
      if (error) errorCandidates.push(error);
      else {
        invalidErrors += 1;
        errorsOmitted += 1;
      }
    }
  }
  if (errorsInputOverflow || rawErrors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) {
    errorCandidates.push({
      collector: 'support-bundle',
      code: 'collection_output_overflow',
      at: 'unknown',
      recoveryRequired: true,
    });
  }
  if (invalidRecords > 0) {
    errorCandidates.push({
      collector: 'support-bundle',
      code: 'invalid_record',
      at: 'unknown',
      recoveryRequired: true,
    });
  }
  if (recordsInputOverflow || receiptsInputOverflow) {
    errorCandidates.push({
      collector: 'support-bundle',
      code: 'collection_output_overflow',
      at: 'unknown',
      recoveryRequired: true,
    });
  }
  if (invalidReceipts > 0 || invalidErrors > 0) {
    errorCandidates.push({
      collector: 'support-bundle',
      code: 'collection_invalid_output',
      at: 'unknown',
      recoveryRequired: true,
    });
  }

  const inputEntries = limitedEntries(input, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
  if (!inputEntries) {
    audit.fieldsTruncated += 1;
    note(audit, 'unknown-root-field-limit');
  } else {
    for (const [key] of inputEntries) {
      if (!ROOT_FIELDS.has(key)) omit(audit, 'unknown-root-field');
    }
  }

  const generatedAt = safeTimestamp(input.generatedAt, audit, 'generatedAt') ?? new Date(options.now?.() ?? Date.now()).toISOString();
  if (duplicateReceiptActionId) {
    errorCandidates.push({
      collector: 'support-bundle',
      code: 'duplicate_action_id',
      at: generatedAt,
      recoveryRequired: true,
    });
  }
  // Normalize every bounded candidate first, then choose the bounded error
  // projection. This makes over-limit errors independent of input order and
  // keeps recovery markers eligible for the deterministic replacement policy.
  errorCandidates.sort(compareSupportErrors);
  for (const error of errorCandidates) appendError(error);
  errors.sort(compareSupportErrors);
  const project = sanitizeProject(input.project, audit, homeDirectory);
  const provenance = sanitizeProvenance(input.provenance, audit, trustedProvenance);
  const requestedStatus = sanitizeStatus(input.status, audit);
  const recordsOmitted = boundedCount(Math.max(
    suppliedCount(priorTruncation.recordsOmitted) + rawRecords.length - records.length,
    0,
  ));
  const receiptsOmitted = boundedCount(Math.max(
    suppliedCount(priorTruncation.receiptsOmitted) + rawReceipts.length - receipts.length,
    0,
  ));
  const base: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    version: SUPPORT_BUNDLE_VERSION,
    compatibility: SUPPORT_BUNDLE_COMPATIBILITY,
    generatedAt,
    status: combineStatus(
      requestedStatus,
      errors,
      isCompleteProvenance(provenance),
      receipts.every((receipt) => receipt.verification === undefined),
    ),
    provenance,
    ...(finiteNonNegativeInteger(input.ownerEpoch) !== undefined ? { ownerEpoch: finiteNonNegativeInteger(input.ownerEpoch) } : {}),
    ...(project ? { project } : {}),
    lifecycle: sanitizeState(input.lifecycle, audit, homeDirectory),
    providers: sanitizeState(input.providers, audit, homeDirectory),
    persistence: sanitizeState(input.persistence, audit, homeDirectory),
    updater: sanitizeState(input.updater, audit, homeDirectory),
    ...(input.graphics !== undefined ? { graphics: sanitizeState(input.graphics, audit, homeDirectory) } : {}),
    terminalTail: sanitizeTerminalTail(input.terminalTail, audit),
    records,
    receipts,
    errors,
    redaction: auditManifest(audit),
    truncation: {
      recordsOmitted,
      receiptsOmitted,
      errorsOmitted: boundedCount(errorsOmitted),
      stateFieldsOmitted: suppliedCount(priorTruncation.stateFieldsOmitted),
      terminalLinesOmitted: boundedCount(
        suppliedCount(priorTruncation.terminalLinesOmitted) + audit.terminalLinesOmitted,
      ),
      bytesOmitted: boundedBytes(
        boundedByteCount(priorTruncation.bytesOmitted) ?? 0,
      ),
      fieldsTruncated: boundedCount(suppliedCount(priorTruncation.fieldsTruncated) + audit.fieldsTruncated),
      totalPayloadBounded: false,
    },
  };
  const codec = options.codec ?? (isRecord(input) ? SUPPORT_BUNDLE_CODECS.get(input) : undefined);
  const fitInput = codec === undefined
    ? base
    : { ...base, accountingProof: ACCOUNTING_PROOF_PLACEHOLDER };
  const fitted = fitBundle(fitInput, maxBundleBytes, deadlineAt).bundle;
  const output = codec === undefined
    ? fitted
    : { ...fitted, accountingProof: signAccountingProof(fitted, codec, deadlineAt) };
  REDACTION_AUDITS.set(output, freezeRedactionManifest(output.redaction));
  TRUSTED_TRUNCATIONS.set(output, Object.freeze({ ...output.truncation }));
  const trustedOutputFields = new Set<TrustedSupportField>();
  if (trustedProvenance) trustedOutputFields.add('provenance');
  if (trustedReceipts) trustedOutputFields.add('receipts');
  TRUSTED_SUPPORT_FIELDS.set(output, Object.freeze(trustedOutputFields));
  const sourceFingerprint = normalizedSourceFingerprint(output, deadlineAt);
  if (sourceFingerprint !== undefined) NORMALIZED_SOURCE_FINGERPRINTS.set(output, sourceFingerprint);
  if (codec !== undefined) SUPPORT_BUNDLE_CODECS.set(output, codec);
  return output;
}

export function buildSupportBundle(input: SupportBundleInput, options: SupportBundleOptions = {}): SupportBundle {
  const deadlineAt = Date.now() + optionElapsedLimit(options.maxElapsedMs);
  try {
    return buildSupportBundleWithReceiptMode(input, options, 'raw', deadlineAt);
  } catch (error) {
    if (!isNormalizationDeadlineError(error)) throw error;
    return minimalRecoveryBundle('normalization_timeout', [], options.codec,
      optionLimit(options.maxBundleBytes, SUPPORT_BUNDLE_LIMITS.maxBundleBytes));
  }
}

export function serializeSupportBundle(bundle: SupportBundle, codec?: SupportBundleCodec): string {
  const deadlineAt = Date.now() + SUPPORT_BUNDLE_LIMITS.maxElapsedMs;
  // Serialization is the repair boundary for a caller-mutated normalized
  // object. Validate the immutable envelope here, then re-normalize all
  // payload fields below instead of rejecting safe redaction repairs first.
  if (!hasSupportBundleEnvelope(bundle)) {
    throw Object.assign(new Error('unsupported support bundle schema or compatibility version'), {
      code: 'support_bundle_schema_invalid',
    });
  }
  const resolvedCodec = codec ?? SUPPORT_BUNDLE_CODECS.get(bundle);
  if (resolvedCodec !== undefined) {
    if (hasValidAccountingProof(bundle, resolvedCodec, deadlineAt)) {
      REDACTION_AUDITS.set(bundle, freezeRedactionManifest(bundle.redaction));
      TRUSTED_TRUNCATIONS.set(bundle, Object.freeze({ ...bundle.truncation }));
      TRUSTED_SUPPORT_FIELDS.set(bundle, verifiedSupportFields(bundle));
      SUPPORT_BUNDLE_CODECS.set(bundle, resolvedCodec);
      const sourceFingerprint = normalizedSourceFingerprint(bundle, deadlineAt);
      if (sourceFingerprint !== undefined) NORMALIZED_SOURCE_FINGERPRINTS.set(bundle, sourceFingerprint);
    } else {
      REDACTION_AUDITS.delete(bundle);
      TRUSTED_TRUNCATIONS.delete(bundle);
      TRUSTED_SUPPORT_FIELDS.delete(bundle);
      SUPPORT_BUNDLE_CODECS.delete(bundle);
      NORMALIZED_SOURCE_FINGERPRINTS.delete(bundle);
    }
  } else if (!hasReusablePrivateMetadata(bundle, deadlineAt)) {
    REDACTION_AUDITS.delete(bundle);
    TRUSTED_TRUNCATIONS.delete(bundle);
    TRUSTED_SUPPORT_FIELDS.delete(bundle);
    NORMALIZED_SOURCE_FINGERPRINTS.delete(bundle);
  }
  // Re-normalize at the export boundary. A caller may have parsed, cast, or
  // mutated a bundle after construction; serialization must remain an
  // independent redaction boundary rather than trusting the TypeScript type.
  let normalized: SupportBundle;
  try {
    normalized = buildSupportBundleWithReceiptMode(
      bundle as unknown as SupportBundleInput,
      resolvedCodec === undefined ? {} : { codec: resolvedCodec },
      'projected',
      deadlineAt,
    );
    assertNormalizationDeadline(deadlineAt);
  } catch (error) {
    if (isNormalizationDeadlineError(error)) {
      throw Object.assign(new Error('support bundle normalization deadline exceeded'), {
        code: 'support_bundle_normalization_timeout',
      });
    }
    throw error;
  }
  const serialized = JSON.stringify(stableValue(normalized, {
    remaining: MAX_ATTRIBUTE_NODES * 4,
    deadlineAt,
  }));
  if (byteLength(serialized) > SUPPORT_BUNDLE_LIMITS.maxBundleBytes) {
    throw Object.assign(new Error('support bundle exceeds the maximum payload size'), {
      code: 'support_bundle_size_exceeded',
    });
  }
  return serialized;
}

export function parseSupportBundle(serialized: string, codec?: SupportBundleCodec): SupportBundle {
  const deadlineAt = Date.now() + SUPPORT_BUNDLE_LIMITS.maxElapsedMs;
  if (byteLength(serialized) > SUPPORT_BUNDLE_LIMITS.maxBundleBytes) {
    throw Object.assign(new Error('support bundle exceeds the maximum payload size'), {
      code: 'support_bundle_size_exceeded',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw Object.assign(new Error('support bundle JSON is invalid'), {
      code: 'support_bundle_json_invalid',
    });
  }
  let normalized: SupportBundle | undefined;
  try {
    normalized = stripSupportBundleUnknownFields(parsed, deadlineAt);
  } catch (error) {
    if (isNormalizationDeadlineError(error)) {
      throw Object.assign(new Error('support bundle normalization deadline exceeded'), {
        code: 'support_bundle_normalization_timeout',
      });
    }
    throw Object.assign(new Error('support bundle schema is invalid'), {
      code: 'support_bundle_schema_invalid',
    });
  }
  if (normalized === undefined || !isSupportBundleV1AtDeadline(normalized, deadlineAt)) {
    throw Object.assign(new Error('support bundle schema is invalid'), {
      code: 'support_bundle_schema_invalid',
    });
  }
  if (codec === undefined) {
    const { accountingProof: _accountingProof, ...unsigned } = normalized;
    return buildSupportBundleWithReceiptMode(
      {
        ...unsigned,
        ...(normalized.status === 'complete' ? { status: 'partial' } : {}),
        accountingProof: undefined,
      },
      {},
      'projected',
      deadlineAt,
    );
  }
  if (!hasValidAccountingProof(normalized, codec, deadlineAt)) {
    throw Object.assign(new Error('support bundle accounting proof is invalid'), {
      code: 'support_bundle_accounting_proof_invalid',
    });
  }
  const bundle = normalized;
  REDACTION_AUDITS.set(bundle, freezeRedactionManifest(bundle.redaction));
  TRUSTED_TRUNCATIONS.set(bundle, Object.freeze({ ...bundle.truncation }));
  TRUSTED_SUPPORT_FIELDS.set(bundle, verifiedSupportFields(bundle));
  SUPPORT_BUNDLE_CODECS.set(bundle, codec);
  const sourceFingerprint = normalizedSourceFingerprint(bundle, deadlineAt);
  if (sourceFingerprint !== undefined) NORMALIZED_SOURCE_FINGERPRINTS.set(bundle, sourceFingerprint);
  return bundle;
}

export function supportBundleDigest(bundle: SupportBundle, codec?: SupportBundleCodec): string {
  return createHash('sha256').update(serializeSupportBundle(bundle, codec), 'utf8').digest('hex');
}

export async function collectSupportBundle(
  collectors: readonly SupportCollector[],
  options: SupportBundleOptions & { readonly signal?: AbortSignal } = {},
): Promise<SupportBundle> {
  const startedAt = options.now?.() ?? new Date().getTime();
  const wallStartedAt = Date.now();
  const deadlineAt = wallStartedAt + optionElapsedLimit(options.maxElapsedMs);
  const collectionAt = new Date(startedAt).toISOString();
  const maxElapsedMs = optionElapsedLimit(options.maxElapsedMs);
  const maxRecords = optionLimit(options.maxRecords, SUPPORT_BUNDLE_LIMITS.maxRecords);
  const maxReceipts = optionLimit(options.maxReceipts, SUPPORT_BUNDLE_LIMITS.maxReceipts);
  const collectionAuthorized = options.authority === CONTROL_PLANE_AUTHORITY;
  const boundedCollectors = collectors.slice(0, MAX_SUPPORT_COLLECTORS);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeoutError = Object.assign(new Error('support bundle collection timed out'), { code: 'collection_timeout' });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((reason?: unknown) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, maxElapsedMs);
  });
  void deadline.catch(() => undefined);
  const rejectOnAbort = (): void => rejectDeadline?.(controller.signal.reason ?? new Error('support bundle collection cancelled'));
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  const merged: SupportBundleInput = { generatedAt: collectionAt, records: [], errors: [] };
  const trustedMergedFields = new Set<TrustedSupportField>();
  const recordCandidates: SupportRecord[] = [];
  let records: SupportRecord[] = [];
  let receipts: SupportReceipt[] = [];
  const errors: SupportCollectionError[] = [];
  const errorCandidates: SupportCollectionError[] = [];
  const receiptIds = new Set<string>();
  const duplicateReceiptIds = new Set<string>();
  let aggregateOverflow = false;
  let duplicateReceiptActionId = false;
  let recordsOmitted = 0;
  let receiptsOmitted = 0;
  let errorsOmitted = 0;
  let stateFieldsOmitted = 0;
  let terminalLinesOmitted = 0;
  const preflightBudget: NormalizationBudget = {
    remaining: MAX_COLLECTOR_RESULT_NODES,
    deadlineAt,
  };
  const appendError = (error: SupportCollectionError): void => {
    errorCandidates.push(error);
  };
  const accountCollectorArrayLoss = (field: CollectorPayloadField, count: number): void => {
    if (field === 'records') recordsOmitted += count;
    else if (field === 'receipts') receiptsOmitted += count;
    else if (field === 'errors') errorsOmitted += count;
    else terminalLinesOmitted += count;
  };
  const accountCollectorMapLoss = (
    value: SupportBundleInput,
    includeField: (field: typeof COLLECTOR_MAP_FIELDS[number]) => boolean = () => true,
  ): void => {
    try {
      const resultEntries = limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS);
      if (resultEntries === undefined) return;
      for (const [key, state] of resultEntries) {
        if (!COLLECTOR_MAP_FIELDS.includes(key as typeof COLLECTOR_MAP_FIELDS[number]) || !isRecord(state)) continue;
        const field = key as typeof COLLECTOR_MAP_FIELDS[number];
        if (!includeField(field)) continue;
        stateFieldsOmitted = boundedCount(
          stateFieldsOmitted + (limitedEntries(state, MAX_ATTRIBUTE_SCAN_KEYS)?.length ?? 0),
        );
      }
    } catch {
      // The recovery error already reports an unreadable collector result.
    }
  };
  let requestedStatus: SupportBundleStatus | undefined;
  const collected: Array<{
    index: number;
    name: string;
    result?: SupportBundleInput;
    error?: SupportCollectionError;
  }> = [];
  type ActiveCollectorPayload = {
    readonly item: typeof collected[number];
    readonly field: 'records' | 'receipts' | 'errors';
    readonly values: readonly unknown[];
    nextIndex: number;
  };
  let activePayload: ActiveCollectorPayload | undefined;
  const processedCollectorItems = new Set<number>();
  const processedCollectorFields = new Set<string>();
  let recordsFinalized = false;
  if (collectors.length > boundedCollectors.length) {
    appendError({
      collector: 'support-bundle',
      code: 'collector_limit',
      at: collectionAt,
      recoveryRequired: true,
    });
  }
  if (boundedCollectors.length === 0) {
    appendError({
      collector: 'support-bundle',
      code: 'no_collectors',
      at: collectionAt,
      recoveryRequired: true,
    });
  }
  if (controller.signal.aborted) {
    appendError({
      collector: 'support-bundle',
      code: 'collection_cancelled',
      at: collectionAt,
      recoveryRequired: true,
    });
  }
  const collectorNames: string[] = [];
  const collectorNameCounts = new Map<string, number>();
  for (const [index, collector] of boundedCollectors.entries()) {
    let name: unknown;
    try {
      name = collector.name;
    } catch {
      name = undefined;
    }
    const safeName = typeof name === 'string'
      && name.length > 0
      && name.length <= MAX_TEXT_SCAN_CHARS
      && SAFE_CATEGORY_VALUE.test(name)
      ? name
      : `collector-${index}`;
    if (safeName !== name) {
      appendError({
        collector: 'support-bundle',
        code: 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
    }
    collectorNames.push(safeName);
    collectorNameCounts.set(safeName, (collectorNameCounts.get(safeName) ?? 0) + 1);
  }
  const duplicateCollectorNames = new Set(
    [...collectorNameCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );
  if (duplicateCollectorNames.size > 0) {
    appendError({
      collector: 'support-bundle',
      code: 'duplicate_collector_name',
      at: collectionAt,
      recoveryRequired: true,
    });
  }
  try {
    await Promise.all(boundedCollectors.map(async (collector, index) => {
      const collectorName = collectorNames[index] ?? `collector-${index}`;
      try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('collection cancelled');
        const result = await Promise.race([
          deadline,
          Promise.resolve().then(async () => {
            if (Date.now() >= deadlineAt) {
              controller.abort(timeoutError);
              throw timeoutError;
            }
            const collectedResult = collector.collect(controller.signal);
            if (Date.now() >= deadlineAt) {
              controller.abort(timeoutError);
              throw timeoutError;
            }
            if (!isPromiseLike(collectedResult)) {
              throw Object.assign(new Error('support bundle collectors must return a promise'), {
                code: 'collection_invalid_output',
                recoveryRequired: true,
              });
            }
            const resolvedResult = await collectedResult;
            if (Date.now() >= deadlineAt) {
              controller.abort(timeoutError);
              throw timeoutError;
            }
            return resolvedResult;
          }),
        ]);
        collected.push({ index, name: collectorName, result });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        const invalidCollector = error instanceof Error
          && (error as Error & { code?: unknown }).code === 'collection_invalid_output';
        collected.push({
          index,
          name: collectorName,
          error: {
            collector: collectorName,
            code: timedOut
              ? 'collection_timeout_or_cancelled'
              : invalidCollector ? 'collection_invalid_output' : 'collection_failed',
            at: collectionAt,
            ...(error instanceof Error ? { message: error.message } : {}),
            ...((timedOut || invalidCollector) ? { recoveryRequired: true } : {}),
          },
        });
      }
    }));
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.signal.removeEventListener('abort', rejectOnAbort);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
  const normalizationTimedOut = (): boolean => Date.now() >= deadlineAt;
  const normalizationInterrupted = (): boolean => controller.signal.aborted || normalizationTimedOut();
  const normalizationError = (): SupportCollectionError => ({
    collector: 'support-bundle',
    code: controller.signal.aborted && !normalizationTimedOut() ? 'normalization_cancelled' : 'normalization_timeout',
    at: collectionAt,
    recoveryRequired: true,
  });
  const recoveryBundle = (error: SupportCollectionError): SupportBundle => {
    const recoveryRecords = recordsFinalized ? [...records] : [...recordCandidates];
    const recoveryReceipts = [...receipts];
    const recoveryErrors: unknown[] = [...errorCandidates];
    let recoveryTerminalTail: readonly unknown[] | undefined = isRecord(merged)
      && Array.isArray(merged.terminalTail)
      ? merged.terminalTail
      : undefined;
    const orderedCollected = [...collected].sort((left, right) =>
      compareCodeUnits(left.name, right.name) || left.index - right.index);
    for (const item of orderedCollected) {
      if (item.error !== undefined && !processedCollectorItems.has(item.index)) {
        recoveryErrors.push(item.error);
      }
      if (item.result === undefined || item.result === null) continue;
      for (const field of ['records', 'receipts', 'errors', 'terminalTail'] as const) {
        const fieldKey = `${item.index}:${field}`;
        if (processedCollectorFields.has(fieldKey)) continue;
        const active = activePayload?.item.index === item.index && activePayload.field === field
          ? activePayload
          : undefined;
        const snapshot = active === undefined ? safeCollectorArraySnapshot(item.result, field) : undefined;
        if (active === undefined && snapshot === undefined) continue;
        const values = active?.values ?? snapshot?.values;
        if (values === undefined) {
          accountCollectorArrayLoss(field, snapshot?.length ?? 0);
          continue;
        }
        const pendingValue = active === undefined
          ? values
          : values.slice(active.nextIndex);
        if (field === 'records') recoveryRecords.push(...pendingValue as readonly SupportRecord[]);
        else if (field === 'receipts') recoveryReceipts.push(...pendingValue as readonly SupportReceipt[]);
        else if (field === 'errors') recoveryErrors.push(...pendingValue);
        else if (recoveryTerminalTail === undefined) recoveryTerminalTail = pendingValue;
        else terminalLinesOmitted += pendingValue.length;
      }
      accountCollectorMapLoss(
        item.result,
        (field) => !processedCollectorFields.has(`${item.index}:${field}`),
      );
    }
    recoveryErrors.push(error);
    const recoveryInput: SupportBundleInput = {
      ...merged,
      status: 'recovery_required',
      records: recoveryRecords,
      receipts: recoveryReceipts,
      errors: recoveryErrors,
      ...(recoveryTerminalTail !== undefined ? { terminalTail: recoveryTerminalTail } : {}),
      truncation: {
        recordsOmitted,
        receiptsOmitted,
        errorsOmitted,
        stateFieldsOmitted,
        terminalLinesOmitted,
      },
    };
    TRUSTED_SUPPORT_FIELDS.set(recoveryInput, Object.freeze(new Set(trustedMergedFields)));
    TRUSTED_TRUNCATIONS.set(recoveryInput, Object.freeze({
      recordsOmitted,
      receiptsOmitted,
      errorsOmitted,
      stateFieldsOmitted,
      terminalLinesOmitted,
    }));
    const recoveryFingerprint = normalizedSourceFingerprint(recoveryInput, deadlineAt);
    if (recoveryFingerprint !== undefined) NORMALIZED_SOURCE_FINGERPRINTS.set(recoveryInput, recoveryFingerprint);
    try {
      return buildSupportBundleWithReceiptMode(recoveryInput, options, 'raw', deadlineAt);
    } catch (recoveryError) {
      if (isNormalizationDeadlineError(recoveryError)) {
        return minimalRecoveryBundle('normalization_timeout', recoveryErrors, options.codec,
          optionLimit(options.maxBundleBytes, SUPPORT_BUNDLE_LIMITS.maxBundleBytes), {
            records: recoveryRecords,
            receipts: recoveryReceipts,
            terminalTail: recoveryTerminalTail,
            truncation: {
              recordsOmitted,
              receiptsOmitted,
              errorsOmitted,
              stateFieldsOmitted,
              terminalLinesOmitted,
            },
          });
      }
      return minimalRecoveryBundle('collection_invalid_output', recoveryErrors, options.codec,
        optionLimit(options.maxBundleBytes, SUPPORT_BUNDLE_LIMITS.maxBundleBytes), {
          records: recoveryRecords,
          receipts: recoveryReceipts,
          terminalTail: recoveryTerminalTail,
          truncation: {
            recordsOmitted,
            receiptsOmitted,
            errorsOmitted,
            stateFieldsOmitted,
            terminalLinesOmitted,
          },
        });
    }
  };
  if (normalizationInterrupted()) return recoveryBundle(normalizationError());
  try {
    collected.sort((a, b) => {
      assertNormalizationDeadline(deadlineAt);
      return compareCodeUnits(a.name, b.name) || a.index - b.index;
    });
  } catch (error) {
    if (isNormalizationDeadlineError(error)) return recoveryBundle(normalizationError());
    throw error;
  }
  const statusRank: Record<SupportBundleStatus, number> = {
    complete: 0,
    partial: 1,
    unknown: 2,
    recovery_required: 3,
  };
  const claimedCollectorFields = new Set<string>();
  const ignoredCollectorFields = new Set([
    'generatedAt', 'schema', 'version', 'compatibility', 'redaction', 'truncation', 'accountingProof',
  ]);
  for (const item of collected) {
    if (normalizationInterrupted()) return recoveryBundle(normalizationError());
    if (duplicateCollectorNames.has(item.name)) {
      processedCollectorItems.add(item.index);
      if (item.result !== undefined && item.result !== null) {
        for (const field of ['records', 'receipts', 'errors', 'terminalTail'] as const) {
          const snapshot = safeCollectorArraySnapshot(item.result, field);
          if (snapshot === undefined) continue;
          accountCollectorArrayLoss(field, snapshot.length);
          processedCollectorFields.add(`${item.index}:${field}`);
        }
        accountCollectorMapLoss(item.result);
        for (const field of COLLECTOR_MAP_FIELDS) processedCollectorFields.add(`${item.index}:${field}`);
      }
      continue;
    }
    if (item.error) {
      appendError(item.error);
      processedCollectorItems.add(item.index);
      continue;
    }
    if (item.result === undefined || item.result === null) {
      appendError({
        collector: item.name,
        code: 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
      processedCollectorItems.add(item.index);
      continue;
    }
    let violation: 'invalid' | 'overflow' | undefined;
    try {
      violation = collectorResultViolation(item.result, maxRecords, maxReceipts, preflightBudget);
    } catch (error) {
      if (isNormalizationDeadlineError(error)) return recoveryBundle(normalizationError());
      violation = 'invalid';
    }
    if (violation !== undefined) {
      // The collector is discarded as a unit after bounded preflight. Keep the
      // loss accounting honest for every bounded payload array it supplied,
      // including invalid results that cannot be projected safely.
      appendError({
        collector: item.name,
        code: violation === 'overflow' ? 'collection_output_overflow' : 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
      processedCollectorItems.add(item.index);
      for (const field of ['records', 'receipts', 'errors', 'terminalTail'] as const) {
        const snapshot = safeCollectorArraySnapshot(item.result, field);
        if (snapshot === undefined) continue;
        accountCollectorArrayLoss(field, snapshot.length);
        processedCollectorFields.add(`${item.index}:${field}`);
      }
      accountCollectorMapLoss(item.result);
      for (const field of COLLECTOR_MAP_FIELDS) processedCollectorFields.add(`${item.index}:${field}`);
      continue;
    }
    const resultTrustedFields = collectionAuthorized
      ? new Set<TrustedSupportField>(['provenance', 'receipts'])
      : hasReusablePrivateMetadata(item.result, deadlineAt)
        ? TRUSTED_SUPPORT_FIELDS.get(item.result)
        : undefined;
    const resultEntries = limitedEntries(item.result, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
    if (!resultEntries) {
      appendError({
        collector: item.name,
        code: 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
      processedCollectorItems.add(item.index);
      for (const field of ['records', 'receipts', 'errors', 'terminalTail'] as const) {
        const snapshot = safeCollectorArraySnapshot(item.result, field);
        if (snapshot === undefined) continue;
        accountCollectorArrayLoss(field, snapshot.length);
        processedCollectorFields.add(`${item.index}:${field}`);
      }
      accountCollectorMapLoss(item.result);
      for (const field of COLLECTOR_MAP_FIELDS) processedCollectorFields.add(`${item.index}:${field}`);
      continue;
    }
    if (normalizationInterrupted()) return recoveryBundle(normalizationError());
    const normalizedResultEntries: Array<[string, unknown]> = [];
    for (const [key, value] of resultEntries.sort(([a], [b]) => compareCodeUnits(a, b))) {
      if ((COLLECTOR_ARRAY_FIELDS as readonly string[]).includes(key)) {
        const snapshot = safeCollectorArrayValueSnapshot(value);
        if (snapshot?.values === undefined) {
          appendError({
            collector: item.name,
            code: 'collection_invalid_output',
            at: collectionAt,
            recoveryRequired: true,
          });
          if (snapshot !== undefined) accountCollectorArrayLoss(key as CollectorPayloadField, snapshot.length);
          processedCollectorFields.add(`${item.index}:${key}`);
          continue;
        }
        normalizedResultEntries.push([key, snapshot.values]);
      } else {
        normalizedResultEntries.push([key, value]);
      }
    }
    for (const [key, value] of normalizedResultEntries) {
      if (normalizationInterrupted()) return recoveryBundle(normalizationError());
      if (key === 'status') {
        const next: SupportBundleStatus = value === 'complete' || value === 'partial' || value === 'unknown' || value === 'recovery_required'
          ? value
          : 'unknown';
        if (requestedStatus === undefined || statusRank[next] > statusRank[requestedStatus]) requestedStatus = next;
      } else if (key === 'records') {
        const values = value as readonly unknown[];
        activePayload = { item, field: 'records', values, nextIndex: 0 };
        for (let index = 0; index < values.length; index += 1) {
          activePayload.nextIndex = index;
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          const record = values[index];
          if (!safeCollectorRecordShape(record)) {
            recordsOmitted += 1;
            appendError({
              collector: item.name,
              code: 'collection_invalid_output',
              at: collectionAt,
              recoveryRequired: true,
            });
            activePayload.nextIndex = index + 1;
            continue;
          }
          recordCandidates.push(record);
          activePayload.nextIndex = index + 1;
        }
        activePayload = undefined;
        processedCollectorFields.add(`${item.index}:records`);
      } else if (key === 'receipts') {
        const values = value as readonly unknown[];
        if (claimedCollectorFields.has(key)) {
          appendError({
            collector: item.name,
            code: 'collection_conflict',
            at: collectionAt,
            recoveryRequired: true,
          });
          accountCollectorArrayLoss('receipts', values.length);
          processedCollectorFields.add(`${item.index}:receipts`);
          continue;
        }
        claimedCollectorFields.add(key);
        if (resultTrustedFields?.has('receipts')) trustedMergedFields.add('receipts');
        activePayload = { item, field: 'receipts', values, nextIndex: 0 };
        for (let index = 0; index < values.length; index += 1) {
          activePayload.nextIndex = index;
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          const receipt = values[index];
          if (!safeCollectorReceiptShape(receipt)) {
            aggregateOverflow = true;
            receiptsOmitted += 1;
            appendError({
              collector: item.name,
              code: 'collection_invalid_output',
              at: collectionAt,
              recoveryRequired: true,
            });
            continue;
          }
          if (receiptIds.has(receipt.actionId)) {
            duplicateReceiptActionId = true;
            duplicateReceiptIds.add(receipt.actionId);
            receiptsOmitted += 1;
            continue;
          }
          receiptIds.add(receipt.actionId);
          if (receipts.length >= maxReceipts) {
            aggregateOverflow = true;
            receiptsOmitted += 1;
            continue;
          }
          receipts.push(receipt as unknown as SupportReceipt);
        }
        activePayload = undefined;
        processedCollectorFields.add(`${item.index}:receipts`);
      } else if (key === 'errors') {
        const values = value as readonly unknown[];
        if (errorCandidates.length + values.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) aggregateOverflow = true;
        activePayload = { item, field: 'errors', values, nextIndex: 0 };
        for (let index = 0; index < values.length; index += 1) {
          activePayload.nextIndex = index;
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          const error = values[index];
          if (!safeCollectorErrorShape(error)) {
            errorsOmitted += 1;
            appendError({
              collector: item.name,
              code: 'collection_invalid_output',
              at: collectionAt,
              recoveryRequired: true,
            });
            activePayload.nextIndex = index + 1;
            continue;
          }
          appendError(error);
          activePayload.nextIndex = index + 1;
        }
        activePayload.nextIndex = values.length;
        activePayload = undefined;
        processedCollectorFields.add(`${item.index}:errors`);
      } else if (ignoredCollectorFields.has(key)) {
        continue;
      } else if (claimedCollectorFields.has(key)) {
        appendError({
          collector: item.name,
          code: 'collection_conflict',
          at: collectionAt,
          recoveryRequired: true,
          });
        if (key === 'terminalTail') terminalLinesOmitted += (value as readonly unknown[]).length;
        if (COLLECTOR_MAP_FIELDS.includes(key as typeof COLLECTOR_MAP_FIELDS[number]) && isRecord(value)) {
          stateFieldsOmitted = boundedCount(
            stateFieldsOmitted + (limitedEntries(value, MAX_ATTRIBUTE_SCAN_KEYS)?.length ?? 0),
          );
          processedCollectorFields.add(`${item.index}:${key}`);
        }
        if (COLLECTOR_ARRAY_FIELDS.includes(key as CollectorPayloadField)) {
          processedCollectorFields.add(`${item.index}:${key}`);
        }
      } else {
        claimedCollectorFields.add(key);
        (merged as Record<string, unknown>)[key] = value;
        if (key === 'provenance' && resultTrustedFields?.has('provenance')) {
          trustedMergedFields.add('provenance');
        }
        if (COLLECTOR_MAP_FIELDS.includes(key as typeof COLLECTOR_MAP_FIELDS[number])) {
          processedCollectorFields.add(`${item.index}:${key}`);
        }
        if (key === 'terminalTail' && Array.isArray(value)) processedCollectorFields.add(`${item.index}:terminalTail`);
      }
    }
    processedCollectorItems.add(item.index);
  }
  if (recordCandidates.length > 0) {
    try {
      recordCandidates.sort((a, b) => a.sequence - b.sequence
        || compareCodeUnits(a.at, b.at)
        || compareCodeUnits(a.component, b.component)
        || compareCodeUnits(a.event, b.event)
        || compareStableValues(a, b, deadlineAt));
    } catch (error) {
      if (isNormalizationDeadlineError(error)) return recoveryBundle(normalizationError());
      return recoveryBundle({
        collector: 'support-bundle',
        code: 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
    }
  }
  if (recordCandidates.length > maxRecords) {
    aggregateOverflow = true;
    recordsOmitted += recordCandidates.length - maxRecords;
  }
  records = recordCandidates.slice(0, maxRecords);
  recordsFinalized = true;
  if (aggregateOverflow) {
    appendError({
      collector: 'support-bundle',
      code: 'collection_output_overflow',
      at: collectionAt,
      recoveryRequired: true,
    });
  }
  if (duplicateReceiptActionId) {
    appendError({
      collector: 'support-bundle',
      code: 'duplicate_action_id',
      at: collectionAt,
      recoveryRequired: true,
    });
  }
  if (duplicateReceiptIds.size > 0) {
    // A duplicate action ID invalidates the original retained receipt as well
    // as every later duplicate. Count that original before removing the whole
    // ambiguous identity group from the published projection.
    receiptsOmitted += duplicateReceiptIds.size;
    receipts = receipts.filter((receipt) => !duplicateReceiptIds.has(receipt.actionId));
  }
  const selectedErrors: SupportCollectionError[] = [];
  for (const error of [...errorCandidates].sort(compareSupportErrors)) {
    if (appendBoundedError(selectedErrors, error)) errorsOmitted += 1;
  }
  selectedErrors.sort(compareSupportErrors);
  errors.push(...selectedErrors);
  const status = combineStatus(requestedStatus ?? 'complete', errors);
  (merged as Record<string, unknown>).records = records;
  (merged as Record<string, unknown>).receipts = receipts;
  (merged as Record<string, unknown>).errors = errors;
  (merged as Record<string, unknown>).status = status;
  if (recordsOmitted > 0 || receiptsOmitted > 0 || errorsOmitted > 0
    || stateFieldsOmitted > 0 || terminalLinesOmitted > 0) {
    (merged as Record<string, unknown>).truncation = {
      recordsOmitted,
      receiptsOmitted,
      errorsOmitted,
      stateFieldsOmitted,
      terminalLinesOmitted,
    };
  }
  TRUSTED_TRUNCATIONS.set(merged, {
    recordsOmitted,
    receiptsOmitted,
    errorsOmitted,
    stateFieldsOmitted,
    terminalLinesOmitted,
  });
  TRUSTED_SUPPORT_FIELDS.set(merged, Object.freeze(new Set(trustedMergedFields)));
  const mergedSourceFingerprint = normalizedSourceFingerprint(merged, deadlineAt);
  if (mergedSourceFingerprint !== undefined) NORMALIZED_SOURCE_FINGERPRINTS.set(merged, mergedSourceFingerprint);
  if (normalizationInterrupted()) return recoveryBundle(normalizationError());
  let bundle: SupportBundle;
  try {
    bundle = buildSupportBundleWithReceiptMode(merged, options, 'raw', deadlineAt);
  } catch (error) {
    if (isNormalizationDeadlineError(error)) return recoveryBundle(normalizationError());
    throw error;
  }
  return normalizationInterrupted() ? recoveryBundle(normalizationError()) : bundle;
}

export function createSafeSupportBundleFixture(): SupportBundle {
  return buildSupportBundle({
    generatedAt: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    provenance: {
      application: 'psyche-build',
      releaseVersion: '0.0.2',
      sourceSha: '0123456789abcdef0123456789abcdef01234567',
      platform: 'darwin',
      architecture: 'arm64',
    },
    ownerEpoch: 7,
    project: { id: 'fixture-project', name: 'sample-project', relativePath: 'sample-project' },
    lifecycle: { panes: 2, state: 'ready' },
    providers: { tmux: 'available', browser: 'unavailable' },
    persistence: { state: 'healthy', recoveryRequired: false },
    updater: { state: 'current', version: '0.0.2' },
    records: [{ sequence: 1, at: '2026-01-01T00:00:00.000Z', component: 'fixture', event: 'ready', outcome: 'succeeded' }],
    receipts: [{
      schema: 'psyche.control.receipt/v1',
      actionId: 'fixture-action',
      state: 'succeeded',
      resource: { kind: 'project', id: 'fixture-project' },
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.010Z',
      code: 'fixture_ok',
      durationMs: 10,
    }],
  });
}
