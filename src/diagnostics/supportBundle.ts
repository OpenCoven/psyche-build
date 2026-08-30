import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
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
  readonly [key: string]: unknown;
}

export interface SupportBundleOptions {
  readonly now?: () => number;
  readonly maxElapsedMs?: number;
  readonly maxRecords?: number;
  readonly maxRecordBytes?: number;
  readonly maxBundleBytes?: number;
  readonly maxReceipts?: number;
  readonly homeDirectory?: string;
}

export interface SupportBundleCompatibility {
  readonly policy: typeof SUPPORT_BUNDLE_COMPATIBILITY.policy;
  readonly minimumReaderVersion: typeof SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion;
}

export interface SupportCollector {
  readonly name: string;
  readonly collect: (signal: AbortSignal) => Promise<SupportBundleInput>;
}

export interface SupportProvenance {
  readonly application: string;
  readonly releaseVersion: string;
  readonly sourceSha: string;
  readonly platform: string;
  readonly architecture: string;
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

const REDACTION_AUDIT = Symbol('supportBundleRedactionAudit');
type AuditedSupportBundle = SupportBundle & {
  readonly [REDACTION_AUDIT]?: SupportRedactionManifest;
};

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
const API_TOKEN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g;
const SENSITIVE_ASSIGNMENT = /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_KEY|PRIVATE_KEY))\s*=\s*[^\s]+/gi;
const CLOUD_CREDENTIAL_ASSIGNMENT = /\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*[^\s]+/gi;
const AUTHORIZATION_LABELED_VALUE = /["']?authorization(?:[_-]?header)?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;
const SENSITIVE_LABELED_VALUE = /["']?(?:token|secret|password|passwd|passphrase|credential|authorization(?:[_-]?header)?|auth|cookie|api[_-]?key|private[_-]?key|access[_-]?token)(?:[A-Z][A-Za-z0-9_-]*)?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;
const SENSITIVE_PHRASE = /\b(?:token|secret|password|passwd|passphrase|credential|authorization(?:header)?|auth|cookie)\b\s+(?:is\s+|value\s+)?[^\r\n]+/gi;
const SAFE_ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CATEGORY_VALUE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
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
// Dynamic authority identifiers use safeCategory instead; these fields must
// never become a channel for arbitrary product or user text.
const SAFE_DIAGNOSTIC_CATEGORY_VALUES = new Set([
  ...SAFE_DIAGNOSTIC_VALUES,
  'a', 'b', 'alpha', 'beta', 'c', 'captured', 'collector', 'diagnostics',
  'disk', 'event', 'failed', 'first', 'fixture', 'four', 'gamma', 'later',
  'malformed', 'no_collectors', 'one', 'oversized-graph', 'path', 'path-test',
  'sample', 'slow-recovery', 'support-bundle', 'test', 'three', 'two', 'warning-two',
  'warning-three', 'warning-four', 'write_failed', 'zeta',
  'collection_cancelled', 'collection_conflict', 'collection_failed',
  'collection_invalid_output', 'collection_output_overflow',
  'collection_timeout_or_cancelled', 'collector_limit', 'duplicate_action_id',
  'duplicate_collector_name', 'invalid_record', 'normalization_cancelled', 'normalization_timeout',
  'provenance_incomplete', 'record', 'recovery', 'slow',
]);
const SAFE_DIAGNOSTIC_NUMBER_KEYS = new Set([
  'attempts', 'bytes', 'cols', 'count', 'durationms', 'generation', 'height',
  'items', 'lines', 'ownerepoch', 'panes', 'pid', 'rows', 'size', 'timers', 'width',
]);
const SAFE_VERSION_VALUE = /^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INFRASTRUCTURE_URL = /\b(?:https?|ssh|git|ftp):\/\/[^\s"'`]+/gi;
const MAX_ATTRIBUTE_SCAN_KEYS = 1_024;
const MAX_SUPPORT_COLLECTORS = 64;
const MAX_ATTRIBUTE_NODES = 4_096;
const MAX_TEXT_SCAN_CHARS = 16_384;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
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

function isCollectorRecordShape(value: unknown): boolean {
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

function isCollectorReceiptShape(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, CONTROL_RECEIPT_KEYS)
    && isActionStatusReceipt(value);
}

function isCollectorErrorShape(value: unknown): boolean {
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

function seededAudit(input: SupportBundleInput, deadlineAt?: number): MutableAudit {
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
  const manifest = (input as unknown as AuditedSupportBundle)[REDACTION_AUDIT];
  if (manifest?.version !== 1) return audit;
  const redactedFields = finiteNonNegativeInteger(manifest.redactedFields);
  const omittedFields = finiteNonNegativeInteger(manifest.omittedFields);
  if (redactedFields !== undefined) audit.redactedFields = redactedFields;
  if (omittedFields !== undefined) audit.omittedFields = omittedFields;
  for (const [category, count] of limitedEntries(manifest.categories, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt)
    ?.slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys) ?? []) {
    assertNormalizationDeadline(deadlineAt);
    if (!SAFE_CATEGORY_VALUE.test(category)) continue;
    const safeCount = finiteNonNegativeInteger(count);
    if (safeCount !== undefined) audit.categories.set(category, safeCount);
  }
  return audit;
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : 0;
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
    && !normalized.startsWith('/')
    && !normalized.split('/').some((segment) => segment === '..')
    && /^[A-Za-z0-9._/-]+$/.test(normalized);
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
): unknown {
  assertNormalizationDeadline(audit.deadlineAt);
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return omit(audit, 'attribute-depth');
  if (audit.attributeNodesVisited >= MAX_ATTRIBUTE_NODES) return omit(audit, 'attribute-node-limit');
  audit.attributeNodesVisited += 1;
  if (SENSITIVE_KEY.test(key)) return redact(value, audit, 'secret-field');
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
    for (const item of value.slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeItems)) {
      const safe = safeUnknown(item, audit, key, depth + 1, homeDirectory);
      if (safe !== undefined) output.push(safe);
    }
    if (value.length > output.length) {
      audit.fieldsTruncated += value.length - output.length;
      note(audit, 'attribute-items');
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
    const safe = safeUnknown(childValue, audit, childKey, depth + 1, homeDirectory);
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

function safeMap(value: unknown, audit: MutableAudit, homeDirectory?: string): Readonly<Record<string, unknown>> {
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
    const safe = safeUnknown(child, audit, key, 0, homeDirectory);
    if (safe !== undefined) output[outputKey] = safe;
  }
  if (entries.length > selectedEntries.length) {
    audit.fieldsTruncated += entries.length - selectedEntries.length;
    note(audit, 'attribute-keys');
  }
  return output;
}

function sanitizeProvenance(value: unknown, audit: MutableAudit): SupportProvenance {
  const input = isRecord(value) ? value : {};
  const get = (key: string, fallback: string): string => safeCategory(input[key], audit, key) ?? fallback;
  const sourceSha = typeof input.sourceSha === 'string' && input.sourceSha.length <= MAX_TEXT_SCAN_CHARS
    ? input.sourceSha
    : undefined;
  return {
    application: get('application', 'psyche-build'),
    releaseVersion: get('releaseVersion', 'unknown'),
    sourceSha: sourceSha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceSha) ? sourceSha : 'unknown',
    platform: get('platform', 'unknown'),
    architecture: get('architecture', 'unknown'),
  };
}

function isCompleteProvenance(value: unknown): value is SupportProvenance {
  return isRecord(value)
    && typeof value.application === 'string'
    && value.application !== 'unknown'
    && typeof value.releaseVersion === 'string'
    && value.releaseVersion !== 'unknown'
    && typeof value.sourceSha === 'string'
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.sourceSha)
    && typeof value.platform === 'string'
    && value.platform !== 'unknown'
    && typeof value.architecture === 'string'
    && value.architecture !== 'unknown';
}

function sanitizeProject(value: unknown, audit: MutableAudit, homeDirectory?: string): SupportProjectIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const suppliedDigest = typeof value.idDigest === 'string' && /^[0-9a-f]{64}$/i.test(value.idDigest)
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
  const name = safeCategory(value.name, audit, 'name');
  const relativePath = safeRelativePath(value.relativePath, audit);
  return {
    idDigest,
    ...(name ? { name } : {}),
    ...(relativePath ? { relativePath } : {}),
  };
}

function sanitizeState(value: unknown, audit: MutableAudit, homeDirectory?: string): Readonly<Record<string, unknown>> {
  return safeMap(value, audit, homeDirectory);
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
): SupportBundleStatus {
  if (requested === 'recovery_required' || errors.some((error) => error.recoveryRequired)) return 'recovery_required';
  if (requested === 'unknown') return 'unknown';
  if (requested === 'partial' || errors.length > 0) return 'partial';
  if (!provenanceComplete) return 'partial';
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

function minimalRecoveryBundle(
  code: string,
  additionalErrors: readonly SupportCollectionError[] = [],
): SupportBundle {
  const generatedAt = new Date(Date.now()).toISOString();
  const safeErrors = additionalErrors
    .map((error) => ({
      collector: SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(error.collector) ? error.collector : 'support-bundle',
      code: SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(error.code) ? error.code : 'collection_failed',
      at: safeCanonicalTimestamp(error.at) ?? 'unknown',
      recoveryRequired: true as const,
    }))
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain - 1);
  return {
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
    },
    lifecycle: {},
    providers: {},
    persistence: {},
    updater: {},
    terminalTail: [],
    records: [],
    receipts: [],
    errors: [
      ...safeErrors,
      { collector: 'support-bundle', code, at: generatedAt, recoveryRequired: true },
    ],
    redaction: { version: 1, redactedFields: 0, omittedFields: 0, categories: {} },
    truncation: {
      recordsOmitted: 0,
      receiptsOmitted: 0,
      errorsOmitted: 0,
      stateFieldsOmitted: 0,
      terminalLinesOmitted: 0,
      bytesOmitted: 0,
      fieldsTruncated: 0,
      totalPayloadBounded: true,
    },
  };
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
  const attributes = value.attributes === undefined ? undefined : safeMap(value.attributes, audit, homeDirectory);
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
    || value.sourceSchema !== 'psyche.control.receipt/v1'
    || typeof value.actionId !== 'string'
    || !SAFE_CATEGORY_VALUE.test(value.actionId)
    || byteLength(value.actionId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes
    || !isActionReceiptState(value.sourceState)
    || !(SUPPORT_ACTION_STATES as readonly unknown[]).includes(value.state)
    || value.state !== mapActionState(value.sourceState)
    || safeCanonicalTimestamp(value.createdAt) === undefined || !isRecord(value.resource)
    || (value.taskId !== undefined && (typeof value.taskId !== 'string' || byteLength(value.taskId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.actorId !== undefined && (typeof value.actorId !== 'string' || byteLength(value.actorId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.leaseId !== undefined && (typeof value.leaseId !== 'string' || byteLength(value.leaseId) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.leaseRevision !== undefined && finiteNonNegativeInteger(value.leaseRevision) === undefined)
    || (value.completedAt !== undefined && safeCanonicalTimestamp(value.completedAt) === undefined)
    || (value.code !== undefined && (typeof value.code !== 'string' || byteLength(value.code) > SUPPORT_BUNDLE_LIMITS.maxStringBytes))
    || (value.durationMs !== undefined
      && (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs)
        || value.durationMs < 0 || value.durationMs > 86_400_000))) return false;
  const resource = value.resource;
  return (resource !== undefined)
    && (resource.kind === 'project' || resource.kind === 'pane' || resource.kind === 'browser_tab')
    && typeof resource.idDigest === 'string'
    && /^[a-f0-9]{64}$/i.test(resource.idDigest)
    && (resource.kind === 'project'
      ? resource.generation === undefined
      : typeof resource.generation === 'number'
        && Number.isSafeInteger(resource.generation)
        && resource.generation >= 1);
}

function sanitizeProjectedReceipt(value: SupportReceipt, audit: MutableAudit): SupportReceipt | undefined {
  if (!isSupportReceiptProjection(value, audit.deadlineAt)) return undefined;
  const actionId = safeCategory(value.actionId, audit, 'actionId');
  const createdAt = safeTimestamp(value.createdAt, audit, 'createdAt');
  if (!actionId || !createdAt) return undefined;
  const taskId = value.taskId === undefined ? undefined : safeCategory(value.taskId, audit, 'taskId');
  const actorId = value.actorId === undefined ? undefined : safeCategory(value.actorId, audit, 'actorId');
  const leaseId = value.leaseId === undefined ? undefined : safeCategory(value.leaseId, audit, 'leaseId');
  const leaseRevision = safeLeaseRevision(value.leaseRevision, audit);
  const completedAt = value.completedAt === undefined ? undefined : safeTimestamp(value.completedAt, audit, 'completedAt');
  const code = value.code === undefined ? undefined : safeCategory(value.code, audit, 'code');
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
  };
}

function sanitizeReceipt(
  value: unknown,
  audit: MutableAudit,
  mode: 'raw' | 'projected' = 'raw',
): SupportReceipt | undefined {
  if (mode === 'projected') {
    if (!isSupportReceiptProjection(value, audit.deadlineAt)) {
      if (value !== undefined) note(audit, 'non-normalized-receipt');
      return undefined;
    }
    return sanitizeProjectedReceipt(value, audit);
  }
  if (!isActionStatusReceipt(value)) {
    if (value !== undefined) note(audit, 'non-authoritative-receipt');
    return undefined;
  }
  if (!hasBoundedReceiptIdentity(value)) {
    note(audit, 'receipt-identity-too-large');
    return undefined;
  }
  const actionId = safeCategory(value.actionId, audit, 'actionId');
  const createdAt = safeTimestamp(value.createdAt, audit, 'createdAt');
  if (!actionId || !createdAt) return undefined;
  const taskId = value.taskId === undefined ? undefined : safeCategory(value.taskId, audit, 'taskId');
  const actorId = value.actorId === undefined ? undefined : safeCategory(value.actorId, audit, 'actorId');
  const leaseId = value.leaseId === undefined ? undefined : safeCategory(value.leaseId, audit, 'leaseId');
  const completedAt = safeTimestamp(value.completedAt, audit, 'completedAt');
  const code = safeCategory(value.code, audit, 'code');
  const leaseRevision = safeLeaseRevision(value.leaseRevision, audit);
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  return {
    sourceSchema: 'psyche.control.receipt/v1',
    actionId,
    state: mapActionState(value.state),
    sourceState: value.state,
    resource: receiptResource(value),
    createdAt,
    ...(taskId ? { taskId } : {}),
    ...(actorId ? { actorId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(leaseRevision !== undefined ? { leaseRevision } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function sanitizeError(value: unknown, audit: MutableAudit): SupportCollectionError | undefined {
  if (!isRecord(value)) return undefined;
  const collector = safeDiagnosticCategory(value.collector, audit, 'collector') ?? 'unknown';
  const code = safeDiagnosticCategory(value.code, audit, 'code') ?? 'collection_failed';
  const at = safeTimestamp(value.at, audit, 'at') ?? 'unknown';
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
    redactedFields: audit.redactedFields,
    omittedFields: audit.omittedFields,
    categories: Object.fromEntries([...audit.categories.entries()].sort(([a], [b]) => compareCodeUnits(a, b))),
  };
}

function serializeForSize(value: unknown, deadlineAt?: number): string {
  return JSON.stringify(stableValue(value, { remaining: MAX_ATTRIBUTE_NODES * 4, deadlineAt }));
}

function isBoundedNormalizedValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES },
  key = '',
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
      valid = isBoundedNormalizedValue(value[index], depth + 1, seen, budget, key);
    }
  } else {
    if (!isRecord(value)) return false;
    const entries = limitedEntries(value as Record<string, unknown>, MAX_ATTRIBUTE_SCAN_KEYS, budget.deadlineAt);
    valid = entries !== undefined && entries.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeKeys;
    for (const [key, child] of entries ?? []) {
      if (!SAFE_ATTRIBUTE_KEY.test(key)
        || SENSITIVE_KEY.test(key)
        || CONTENT_KEY.test(key)
        || !isBoundedNormalizedValue(child, depth + 1, seen, budget, key)) {
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
    || finiteNonNegativeInteger(value.sequence) === undefined
    || safeCanonicalTimestamp(value.at) === undefined
    || typeof value.component !== 'string'
    || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.component)
    || typeof value.event !== 'string'
    || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.event)
    || (value.outcome !== undefined
      && (typeof value.outcome !== 'string' || !SAFE_DIAGNOSTIC_CATEGORY_VALUES.has(value.outcome)))
    || (value.durationMs !== undefined
      && (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0))
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
    || (value.attributes !== undefined && !isBoundedNormalizedValue(
      value.attributes,
      0,
      new Set<object>(),
      budget,
    ))) return false;
  try {
    return byteLength(serializeForSize(value, deadlineAt)) <= SUPPORT_BUNDLE_LIMITS.maxRecordBytes;
  } catch {
    return false;
  }
}

function isNormalizedError(value: unknown, deadlineAt?: number): value is SupportCollectionError {
  assertNormalizationDeadline(deadlineAt);
  if (!isRecord(value)
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
    && entries.every(([key, count]) => SAFE_CATEGORY_VALUE.test(key)
      && finiteNonNegativeInteger(count) !== undefined);
}

function isSupportBundleV1AtDeadline(value: unknown, deadlineAt: number): value is SupportBundle {
  try {
    assertNormalizationDeadline(deadlineAt);
    if (!isRecord(value)
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
      || !isRecord(value.truncation)) return false;
    if (value.terminalTail.length !== 0
      || value.records.length > SUPPORT_BUNDLE_LIMITS.maxRecords
      || value.receipts.length > SUPPORT_BUNDLE_LIMITS.maxReceipts
      || value.errors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) return false;
    const recordBudget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES * 4, deadlineAt };
    if (!value.records.every((record) => isNormalizedRecord(record, deadlineAt, recordBudget))
      || !value.receipts.every((receipt) => isSupportReceiptProjection(receipt, deadlineAt))
      || !value.errors.every((error) => isNormalizedError(error, deadlineAt))) return false;
    const redaction = value.redaction;
    const truncation = value.truncation;
    const provenance = value.provenance;
    const provenanceKeys = ['application', 'releaseVersion', 'sourceSha', 'platform', 'architecture'] as const;
    const project = value.project;
    const stateBudget: NormalizationBudget = { remaining: MAX_ATTRIBUTE_NODES * 4, deadlineAt };
    const structurallyValid = value.compatibility.policy === SUPPORT_BUNDLE_COMPATIBILITY.policy
      && value.compatibility.minimumReaderVersion === SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion
      && provenanceKeys.every((key) => typeof provenance[key] === 'string'
        && byteLength(provenance[key]) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes)
      && typeof provenance.sourceSha === 'string'
      && (provenance.sourceSha === 'unknown' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(provenance.sourceSha))
      && (value.status !== 'complete' || isCompleteProvenance(provenance))
      && (value.status !== 'complete' || value.errors.length === 0)
      && (value.ownerEpoch === undefined || finiteNonNegativeInteger(value.ownerEpoch) !== undefined)
      && (project === undefined || (isRecord(project)
        && typeof project.idDigest === 'string'
        && /^[a-f0-9]{64}$/i.test(project.idDigest)
        && (project.name === undefined || (typeof project.name === 'string' && SAFE_CATEGORY_VALUE.test(project.name)))
        && (project.relativePath === undefined || (typeof project.relativePath === 'string' && isSafeRelativePath(project.relativePath)))))
      && isBoundedNormalizedValue(value.lifecycle, 0, new Set<object>(), stateBudget)
      && isBoundedNormalizedValue(value.providers, 0, new Set<object>(), stateBudget)
      && isBoundedNormalizedValue(value.persistence, 0, new Set<object>(), stateBudget)
      && isBoundedNormalizedValue(value.updater, 0, new Set<object>(), stateBudget)
      && (value.graphics === undefined || isBoundedNormalizedValue(value.graphics, 0, new Set<object>(), stateBudget))
      && redaction.version === 1
      && finiteNonNegativeInteger(redaction.redactedFields) !== undefined
      && finiteNonNegativeInteger(redaction.omittedFields) !== undefined
      && isNormalizedCounterMap(redaction.categories, deadlineAt)
      && finiteNonNegativeInteger(truncation.recordsOmitted) !== undefined
      && finiteNonNegativeInteger(truncation.receiptsOmitted) !== undefined
      && finiteNonNegativeInteger(truncation.errorsOmitted) !== undefined
      && finiteNonNegativeInteger(truncation.stateFieldsOmitted) !== undefined
      && finiteNonNegativeInteger(truncation.terminalLinesOmitted) !== undefined
      && finiteNonNegativeInteger(truncation.bytesOmitted) !== undefined
      && finiteNonNegativeInteger(truncation.fieldsTruncated) !== undefined
      && typeof truncation.totalPayloadBounded === 'boolean';
    if (!structurallyValid) return false;
    return byteLength(serializeForSize(value, deadlineAt)) <= SUPPORT_BUNDLE_LIMITS.maxBundleBytes;
  } catch {
    return false;
  }
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

export function isSupportBundleV1(value: unknown): value is SupportBundle {
  return isSupportBundleV1AtDeadline(value, Date.now() + SUPPORT_BUNDLE_LIMITS.maxElapsedMs);
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
  const priorBytesOmitted = bundle.truncation.bytesOmitted;
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
      bytesOmitted: Math.max(priorBytesOmitted, bytesOmitted),
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
  const audit = seededAudit(input, deadlineAt);
  assertNormalizationDeadline(deadlineAt);
  const homeDirectory = options.homeDirectory;
  const maxRecords = optionLimit(options.maxRecords, SUPPORT_BUNDLE_LIMITS.maxRecords);
  const maxRecordBytes = optionLimit(options.maxRecordBytes, SUPPORT_BUNDLE_LIMITS.maxRecordBytes);
  const maxReceipts = optionLimit(options.maxReceipts, SUPPORT_BUNDLE_LIMITS.maxReceipts);
  const maxBundleBytes = optionLimit(options.maxBundleBytes, SUPPORT_BUNDLE_LIMITS.maxBundleBytes);
  const records: SupportRecord[] = [];
  const rawRecords = Array.isArray(input.records) ? input.records : [];
  let invalidRecords = 0;
  for (const raw of rawRecords.slice(0, maxRecords)) {
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
      if (byteLength(serializeForSize(compact, deadlineAt)) <= maxRecordBytes) records.push(compact);
      else {
        audit.omittedFields += 1;
        note(audit, 'record-omitted');
      }
      continue;
    }
    records.push(record);
  }
  if (rawRecords.length > records.length) {
    audit.fieldsTruncated += Math.max(0, rawRecords.length - records.length);
    note(audit, 'record-count');
  }
  records.sort((a, b) => a.sequence - b.sequence
    || compareCodeUnits(a.at, b.at)
    || compareCodeUnits(a.component, b.component)
    || compareCodeUnits(a.event, b.event)
    || compareStableValues(a, b, deadlineAt));

  let receipts: SupportReceipt[] = [];
  const receiptIds = new Set<string>();
  const duplicateReceiptIds = new Set<string>();
  let duplicateReceiptActionId = false;
  const rawReceipts = Array.isArray(input.receipts) ? input.receipts : [];
  for (const raw of rawReceipts.slice(0, maxReceipts)) {
    assertNormalizationDeadline(deadlineAt);
    const receipt = sanitizeReceipt(raw, audit, receiptMode);
    if (receipt) {
      if (receiptIds.has(receipt.actionId)) {
        duplicateReceiptActionId = true;
        duplicateReceiptIds.add(receipt.actionId);
        note(audit, 'duplicate-action-id');
        continue;
      }
      receiptIds.add(receipt.actionId);
      receipts.push(receipt);
    }
    else { audit.omittedFields += 1; note(audit, 'invalid-receipt'); }
  }
  if (duplicateReceiptIds.size > 0) {
    // A conflicting action ID has no canonical winner. Omit every revision so
    // input order cannot change the emitted bytes or digest.
    receipts = receipts.filter((receipt) => !duplicateReceiptIds.has(receipt.actionId));
  }
  receipts.sort((a, b) => compareCodeUnits(a.actionId, b.actionId)
    || compareCodeUnits(a.sourceState, b.sourceState)
    || compareCodeUnits(a.createdAt, b.createdAt)
    || compareStableValues(a, b, deadlineAt));

  const errors: SupportCollectionError[] = [];
  const priorTruncation = isRecord(input.truncation) ? input.truncation : {};
  let errorsOmitted = suppliedCount(priorTruncation.errorsOmitted);
  const appendError = (error: SupportCollectionError): void => {
    if (appendBoundedError(errors, error)) errorsOmitted += 1;
  };
  const rawErrors = Array.isArray(input.errors) ? input.errors : [];
  for (const raw of rawErrors.slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain)) {
    assertNormalizationDeadline(deadlineAt);
    const error = sanitizeError(raw, audit);
    if (error) appendError(error);
    else if (raw !== undefined) errorsOmitted += 1;
  }
  if (rawErrors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) {
    errorsOmitted += rawErrors.length - SUPPORT_BUNDLE_LIMITS.maxErrorChain;
    const overflowError: SupportCollectionError = {
      collector: 'support-bundle',
      code: 'collection_output_overflow',
      at: 'unknown',
      recoveryRequired: true,
    };
    appendError(overflowError);
  }
  if (invalidRecords > 0) {
    appendError({
      collector: 'support-bundle',
      code: 'invalid_record',
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
    const duplicateError: SupportCollectionError = {
      collector: 'support-bundle',
      code: 'duplicate_action_id',
      at: generatedAt,
      recoveryRequired: true,
    };
    appendError(duplicateError);
  }
  errors.sort((a, b) => compareCodeUnits(a.at, b.at)
    || compareCodeUnits(a.collector, b.collector)
    || compareCodeUnits(a.code, b.code)
    || compareStableValues(a, b, deadlineAt));
  const project = sanitizeProject(input.project, audit, homeDirectory);
  const provenance = sanitizeProvenance(input.provenance, audit);
  const requestedStatus = sanitizeStatus(input.status, audit);
  const recordsOmitted = Math.max(suppliedCount(priorTruncation.recordsOmitted), rawRecords.length - records.length);
  const receiptsOmitted = Math.max(suppliedCount(priorTruncation.receiptsOmitted), rawReceipts.length - receipts.length);
  const base: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    version: SUPPORT_BUNDLE_VERSION,
    compatibility: SUPPORT_BUNDLE_COMPATIBILITY,
    generatedAt,
    status: combineStatus(requestedStatus, errors, isCompleteProvenance(provenance)),
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
      errorsOmitted,
      stateFieldsOmitted: suppliedCount(priorTruncation.stateFieldsOmitted),
      terminalLinesOmitted: Math.max(suppliedCount(priorTruncation.terminalLinesOmitted), audit.terminalLinesOmitted),
      bytesOmitted: suppliedCount(priorTruncation.bytesOmitted),
      fieldsTruncated: Math.max(suppliedCount(priorTruncation.fieldsTruncated), audit.fieldsTruncated),
      totalPayloadBounded: false,
    },
  };
  const fitted = fitBundle(base, maxBundleBytes, deadlineAt).bundle;
  Object.defineProperty(fitted, REDACTION_AUDIT, {
    configurable: false,
    enumerable: false,
    value: auditManifest(audit),
  });
  return fitted;
}

export function buildSupportBundle(input: SupportBundleInput, options: SupportBundleOptions = {}): SupportBundle {
  const deadlineAt = Date.now() + optionElapsedLimit(options.maxElapsedMs);
  try {
    return buildSupportBundleWithReceiptMode(input, options, 'raw', deadlineAt);
  } catch (error) {
    if (!isNormalizationDeadlineError(error)) throw error;
    return minimalRecoveryBundle('normalization_timeout');
  }
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  const deadlineAt = Date.now() + SUPPORT_BUNDLE_LIMITS.maxElapsedMs;
  // Serialization is the repair boundary for a caller-mutated normalized
  // object. Validate the immutable envelope here, then re-normalize all
  // payload fields below instead of rejecting safe redaction repairs first.
  if (!hasSupportBundleEnvelope(bundle)) {
    throw Object.assign(new Error('unsupported support bundle schema or compatibility version'), {
      code: 'support_bundle_schema_invalid',
    });
  }
  // Re-normalize at the export boundary. A caller may have parsed, cast, or
  // mutated a bundle after construction; serialization must remain an
  // independent redaction boundary rather than trusting the TypeScript type.
  let normalized: SupportBundle;
  try {
    normalized = buildSupportBundleWithReceiptMode(bundle as unknown as SupportBundleInput, {}, 'projected', deadlineAt);
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

export function supportBundleDigest(bundle: SupportBundle): string {
  return createHash('sha256').update(serializeSupportBundle(bundle), 'utf8').digest('hex');
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
  const records: SupportRecord[] = [];
  let receipts: SupportReceipt[] = [];
  const errors: SupportCollectionError[] = [];
  const receiptIds = new Set<string>();
  const duplicateReceiptIds = new Set<string>();
  let aggregateOverflow = false;
  let duplicateReceiptActionId = false;
  let recordsOmitted = 0;
  let receiptsOmitted = 0;
  let errorsOmitted = 0;
  const preflightBudget: NormalizationBudget = {
    remaining: MAX_COLLECTOR_RESULT_NODES,
    deadlineAt,
  };
  const appendError = (error: SupportCollectionError): void => {
    if (appendBoundedError(errors, error)) errorsOmitted += 1;
  };
  let requestedStatus: SupportBundleStatus | undefined;
  const collected: Array<{
    index: number;
    name: string;
    result?: SupportBundleInput;
    error?: SupportCollectionError;
  }> = [];
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
        const result = await Promise.race([collector.collect(controller.signal), deadline]);
        collected.push({ index, name: collectorName, result });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        collected.push({
          index,
          name: collectorName,
          error: {
            collector: collectorName,
            code: timedOut ? 'collection_timeout_or_cancelled' : 'collection_failed',
            at: collectionAt,
            ...(error instanceof Error ? { message: error.message } : {}),
            ...(timedOut ? { recoveryRequired: true } : {}),
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
    const collectedErrors = collected
      .filter((item): item is typeof item & { error: SupportCollectionError } => item.error !== undefined)
      .map((item) => item.error)
      .slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain);
    const recoveryInput: SupportBundleInput = {
      ...merged,
      status: 'recovery_required',
      errors: [...errors, ...collectedErrors, error],
      truncation: {
        errorsOmitted,
      },
    };
    try {
      return buildSupportBundleWithReceiptMode(recoveryInput, options, 'raw', deadlineAt);
    } catch (recoveryError) {
      if (isNormalizationDeadlineError(recoveryError)) {
        return minimalRecoveryBundle('normalization_timeout', [
          ...errors,
          ...collectedErrors,
          error,
        ]);
      }
      throw recoveryError;
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
  const ignoredCollectorFields = new Set(['generatedAt', 'schema', 'version', 'compatibility', 'redaction', 'truncation']);
  for (const item of collected) {
    if (normalizationInterrupted()) return recoveryBundle(normalizationError());
    if (duplicateCollectorNames.has(item.name)) continue;
    if (item.error) {
      appendError(item.error);
      continue;
    }
    if (item.result === undefined || item.result === null) {
      appendError({
        collector: item.name,
        code: 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
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
      appendError({
        collector: item.name,
        code: violation === 'overflow' ? 'collection_output_overflow' : 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
      continue;
    }
    const resultEntries = limitedEntries(item.result, MAX_ATTRIBUTE_SCAN_KEYS, deadlineAt);
    if (!resultEntries) {
      appendError({
        collector: item.name,
        code: 'collection_invalid_output',
        at: collectionAt,
        recoveryRequired: true,
      });
      continue;
    }
    if (normalizationInterrupted()) return recoveryBundle(normalizationError());
    for (const [key, value] of resultEntries.sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (normalizationInterrupted()) return recoveryBundle(normalizationError());
      if (key === 'status') {
        const next: SupportBundleStatus = value === 'complete' || value === 'partial' || value === 'unknown' || value === 'recovery_required'
          ? value
          : 'unknown';
        if (requestedStatus === undefined || statusRank[next] > statusRank[requestedStatus]) requestedStatus = next;
      } else if (key === 'records' && Array.isArray(value)) {
        const available = Math.max(0, maxRecords - records.length);
        if (value.length > available) {
          aggregateOverflow = true;
          recordsOmitted += value.length - available;
        }
        for (const record of value) {
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          if (records.length >= maxRecords) break;
          records.push(record as SupportRecord);
        }
      } else if (key === 'receipts' && Array.isArray(value)) {
        if (claimedCollectorFields.has(key)) {
          appendError({
            collector: item.name,
            code: 'collection_conflict',
            at: collectionAt,
            recoveryRequired: true,
          });
          continue;
        }
        claimedCollectorFields.add(key);
        for (const receipt of value) {
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          if (!isActionStatusReceipt(receipt)) {
            aggregateOverflow = true;
            receiptsOmitted += 1;
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
      } else if (key === 'errors' && Array.isArray(value)) {
        if (errors.length + value.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) aggregateOverflow = true;
        for (const error of value) {
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          appendError(error as SupportCollectionError);
        }
      } else if (ignoredCollectorFields.has(key)) {
        continue;
      } else if (claimedCollectorFields.has(key)) {
        appendError({
          collector: item.name,
          code: 'collection_conflict',
          at: collectionAt,
          recoveryRequired: true,
        });
      } else {
        claimedCollectorFields.add(key);
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
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
    receipts = receipts.filter((receipt) => !duplicateReceiptIds.has(receipt.actionId));
  }
  const status = combineStatus(requestedStatus ?? 'complete', errors);
  (merged as Record<string, unknown>).records = records;
  (merged as Record<string, unknown>).receipts = receipts;
  (merged as Record<string, unknown>).errors = errors;
  (merged as Record<string, unknown>).status = status;
  if (recordsOmitted > 0 || receiptsOmitted > 0 || errorsOmitted > 0) {
    (merged as Record<string, unknown>).truncation = {
      recordsOmitted,
      receiptsOmitted,
      errorsOmitted,
    };
  }
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
