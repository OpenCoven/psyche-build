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
}

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

const COLLECTOR_STATE_FIELDS = [
  'provenance',
  'project',
  'lifecycle',
  'providers',
  'persistence',
  'updater',
  'graphics',
] as const;
const COLLECTOR_ARRAY_FIELDS = ['terminalTail', 'records', 'receipts', 'errors'] as const;

const SENSITIVE_KEY = /(?:^|[_-]|(?<=[a-z]))(?:token|secret|password|passwd|passphrase|credential|authorization|auth|cookie|private(?:[_-]?key)?|api(?:[_-]?key)?|access(?:[_-]?token)?)(?=$|[_-]|[A-Z])/i;
const CONTENT_KEY = /(?:prompt|transcript|terminal(?:[_-]?output)?|repository(?:[_-]?contents?)?|diff|environment|env(?:ironment)?|source(?:[_-]?contents?)?)/i;
const URL_KEY = /(?:url|uri|endpoint|remote|host)/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const ABSOLUTE_PATH_FRAGMENT = /(?<![A-Za-z0-9])(?:\/[^\s"'`<>|]+(?:[ \t]+[^\s"'`<>|]+)*|[A-Za-z]:[\\/][^\r\n"'`<>|]+|\\\\[^\r\n"'`<>|]+)/g;
const ANSI = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001bP[\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-2A-Za-z]|\u001b[=>])/g;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi;
const API_TOKEN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
const SENSITIVE_ASSIGNMENT = /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|API_KEY|PRIVATE_KEY))\s*=\s*[^\s]+/gi;
const CLOUD_CREDENTIAL_ASSIGNMENT = /\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)\s*=\s*[^\s]+/gi;
const AUTHORIZATION_LABELED_VALUE = /["']?authorization(?:[_-]?header)?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;
const SENSITIVE_LABELED_VALUE = /["']?(?:token|secret|password|passwd|passphrase|credential|authorization(?:[_-]?header)?|auth|cookie|api[_-]?key|private[_-]?key|access[_-]?token)(?:[A-Z][A-Za-z0-9_-]*)?["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;
const SENSITIVE_PHRASE = /\b(?:token|secret|password|passwd|passphrase|credential|authorization(?:header)?|auth|cookie)\b\s+(?:is\s+|value\s+)?[^\r\n]+/gi;
const SAFE_ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CATEGORY_VALUE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
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
const SUPPORT_RECEIPT_KEYS = new Set([
  'sourceSchema', 'actionId', 'state', 'sourceState', 'resource', 'createdAt',
  'taskId', 'actorId', 'leaseId', 'leaseRevision', 'completedAt', 'code', 'durationMs',
]);
const SUPPORT_RECEIPT_RESOURCE_KEYS = new Set(['kind', 'idDigest', 'generation']);
const NORMALIZED_RECORD_KEYS = new Set([
  'sequence', 'at', 'component', 'event', 'outcome', 'durationMs', 'attributes', 'truncated',
]);
const COLLECTOR_ERROR_KEYS = new Set(['collector', 'code', 'at', 'message', 'recoveryRequired']);
const NORMALIZED_ERROR_KEYS = new Set(['collector', 'code', 'at', 'recoveryRequired']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function limitedEntries(
  value: Record<string, unknown>,
  limit = MAX_ATTRIBUTE_SCAN_KEYS,
): Array<[string, unknown]> | undefined {
  const entries: Array<[string, unknown]> = [];
  let scanned = 0;
  for (const key in value) {
    scanned += 1;
    if (scanned > limit) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    entries.push([key, value[key]]);
  }
  return entries;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const entries = limitedEntries(value);
  return entries !== undefined && entries.every(([key]) => allowed.has(key));
}

function isBoundedInputValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: { remaining: number } = { remaining: MAX_ATTRIBUTE_NODES },
): boolean {
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_TEXT_SCAN_CHARS;
  if (typeof value !== 'object' || budget.remaining <= 0) return false;
  budget.remaining -= 1;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.length <= MAX_ATTRIBUTE_SCAN_KEYS;
    for (let index = 0; valid && index < value.length; index += 1) {
      valid = isBoundedInputValue(value[index], depth + 1, seen, budget);
    }
  } else {
    const entries = limitedEntries(value as Record<string, unknown>);
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

function isCollectorRecordShape(value: unknown, budget: { remaining: number }): boolean {
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
    || (value.attributes !== undefined && (!isRecord(value.attributes)
      || !isBoundedInputValue(value.attributes, 0, new Set<object>(), budget)))
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return false;
  return true;
}

function isCollectorReceiptShape(value: unknown, budget: { remaining: number }): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, CONTROL_RECEIPT_KEYS)
    && isBoundedInputValue(value, 0, new Set<object>(), budget)
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
): 'invalid' | 'overflow' | undefined {
  if (!isRecord(value)) return 'invalid';
  const entries = limitedEntries(value);
  if (!entries || entries.length === 0 || entries.length > ROOT_FIELDS.size
    || entries.some(([key]) => key.length > MAX_TEXT_SCAN_CHARS || !ROOT_FIELDS.has(key))) return 'invalid';
  const budget = { remaining: MAX_COLLECTOR_RESULT_NODES };
  if (value.status !== undefined
    && value.status !== 'complete'
    && value.status !== 'partial'
    && value.status !== 'unknown'
    && value.status !== 'recovery_required') return 'invalid';
  if (value.generatedAt !== undefined && safeCanonicalTimestamp(value.generatedAt) === undefined) return 'invalid';
  if (value.ownerEpoch !== undefined && finiteNonNegativeInteger(value.ownerEpoch) === undefined) return 'invalid';
  for (const key of COLLECTOR_STATE_FIELDS) {
    if (value[key] !== undefined && (!isRecord(value[key])
      || !isBoundedInputValue(value[key], 0, new Set<object>(), budget))) return 'invalid';
  }
  if (value.project !== undefined && (!isRecord(value.project)
    || !isBoundedInputValue(value.project, 0, new Set<object>(), budget))) return 'invalid';
  for (const key of COLLECTOR_ARRAY_FIELDS) {
    if (value[key] !== undefined && !Array.isArray(value[key])) return 'invalid';
  }
  if (Array.isArray(value.records) && value.records.length > maxRecords) return 'overflow';
  if (Array.isArray(value.receipts) && value.receipts.length > maxReceipts) return 'overflow';
  if (Array.isArray(value.errors) && value.errors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain) return 'overflow';
  if (Array.isArray(value.terminalTail) && value.terminalTail.length > SUPPORT_BUNDLE_LIMITS.maxTerminalLines) return 'overflow';
  if (Array.isArray(value.records) && !value.records.every((item) => isCollectorRecordShape(item, budget))) return 'invalid';
  if (Array.isArray(value.receipts) && !value.receipts.every((item) => isCollectorReceiptShape(item, budget))) return 'invalid';
  if (Array.isArray(value.errors) && !value.errors.every((item) => isCollectorErrorShape(item))) return 'invalid';
  if (Array.isArray(value.terminalTail)
    && !value.terminalTail.every((item) => typeof item === 'string' && item.length <= MAX_TEXT_SCAN_CHARS)) return 'invalid';
  return undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function seededAudit(input: SupportBundleInput): MutableAudit {
  const audit: MutableAudit = {
    redactedFields: 0,
    omittedFields: 0,
    fieldsTruncated: 0,
    terminalLinesOmitted: 0,
    attributeNodesVisited: 0,
    categories: new Map(),
  };
  const manifest = isRecord(input.redaction) ? input.redaction : undefined;
  if (manifest?.version !== 1) return audit;
  const redactedFields = finiteNonNegativeInteger(manifest.redactedFields);
  const omittedFields = finiteNonNegativeInteger(manifest.omittedFields);
  if (redactedFields !== undefined) audit.redactedFields = redactedFields;
  if (omittedFields !== undefined) audit.omittedFields = omittedFields;
  if (!isRecord(manifest.categories)) return audit;
  for (const [category, count] of limitedEntries(manifest.categories)?.slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys) ?? []) {
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
  if (typeof value !== 'string') return undefined;
  const scanInput = value.length > MAX_TEXT_SCAN_CHARS ? value.slice(0, MAX_TEXT_SCAN_CHARS) : value;
  const scrubbed = scrubText(scanInput, audit, key);
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

function safeTimestamp(value: unknown, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (safeCanonicalTimestamp(text) === undefined) {
    return value === undefined ? undefined : omit(audit, 'invalid-timestamp');
  }
  return text;
}

function safeCanonicalTimestamp(value: unknown): string | undefined {
  return typeof value === 'string'
    && value.length <= MAX_TEXT_SCAN_CHARS
    && ISO_TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

function scrubText(value: string, audit: MutableAudit, key: string): string {
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
    const next = result.replace(pattern, '[redacted]');
    const matched = next !== result;
    changed ||= matched;
    result = next;
    if (matched) note(audit, category);
  }
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
    && /^[A-Za-z0-9._~/-]+$/.test(normalized);
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
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return omit(audit, 'attribute-depth');
  if (audit.attributeNodesVisited >= MAX_ATTRIBUTE_NODES) return omit(audit, 'attribute-node-limit');
  audit.attributeNodesVisited += 1;
  if (SENSITIVE_KEY.test(key)) return redact(value, audit, 'secret-field');
  if (CONTENT_KEY.test(key)) return omit(audit, 'content-field');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : omit(audit, 'non-finite-number');
  if (typeof value === 'string') {
    if (URL_KEY.test(key) && /^\w+:\/\//.test(value)) return redact(value, audit, 'infrastructure-url');
    if (key === 'relativePath') return safeRelativePath(value, audit);
    if (ABSOLUTE_PATH.test(value)) {
      const normalized = normalizeHomePath(value, homeDirectory);
      if (normalized !== value && !ABSOLUTE_PATH.test(normalized)) return safeCategory(normalized, audit, key);
      return redact(value, audit, 'absolute-path');
    }
    return safeCategory(value, audit, key);
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
  const entries = limitedEntries(value);
  if (entries !== undefined) return entries;
  audit.fieldsTruncated += 1;
  note(audit, 'attribute-map-too-large');
  return undefined;
}

function safeMap(value: unknown, audit: MutableAudit, homeDirectory?: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const entries = boundedEntries(value, audit);
  if (!entries) return {};
  const output: Record<string, unknown> = {};
  const selectedEntries = entries
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys);
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
  return {
    application: get('application', 'psyche-build'),
    releaseVersion: get('releaseVersion', 'unknown'),
    sourceSha: /^[0-9a-f]{7,64}$/i.test(String(input.sourceSha ?? '')) ? String(input.sourceSha) : 'unknown',
    platform: get('platform', 'unknown'),
    architecture: get('architecture', 'unknown'),
  };
}

function sanitizeProject(value: unknown, audit: MutableAudit, homeDirectory?: string): SupportProjectIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const identity = value.id ?? value.identity ?? value.name ?? value.relativePath;
  if (identity === undefined) return undefined;
  const idDigest = typeof value.idDigest === 'string' && /^[0-9a-f]{64}$/i.test(value.idDigest)
    ? value.idDigest.toLowerCase()
    : createHash('sha256').update(String(identity), 'utf8').digest('hex');
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
): SupportBundleStatus {
  if (requested === 'recovery_required' || errors.some((error) => error.recoveryRequired)) return 'recovery_required';
  if (requested === 'unknown') return 'unknown';
  if (requested === 'partial' || errors.length > 0) return 'partial';
  return 'complete';
}

function sanitizeRecord(value: unknown, audit: MutableAudit, homeDirectory?: string): SupportRecord | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = finiteNonNegativeInteger(value.sequence);
  const at = safeTimestamp(value.at, audit, 'at');
  const component = safeCategory(value.component, audit, 'component');
  const event = safeCategory(value.event, audit, 'event');
  if (sequence === undefined || !at || !component || !event) return undefined;
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  const outcome = safeCategory(value.outcome, audit, 'outcome');
  const attributes = value.attributes === undefined ? undefined : safeMap(value.attributes, audit, homeDirectory);
  return {
    sequence,
    at,
    component,
    event,
    ...(outcome ? { outcome } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
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

function isSupportReceiptProjection(value: unknown): value is SupportReceipt {
  if (!isRecord(value) || !hasOnlyKeys(value, SUPPORT_RECEIPT_KEYS)
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
  return hasOnlyKeys(resource, SUPPORT_RECEIPT_RESOURCE_KEYS)
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
  if (!isSupportReceiptProjection(value)) return undefined;
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
    if (!isSupportReceiptProjection(value)) {
      if (value !== undefined) note(audit, 'non-normalized-receipt');
      return undefined;
    }
    return sanitizeProjectedReceipt(value, audit);
  }
  if (!isActionStatusReceipt(value)) {
    if (value !== undefined) note(audit, 'non-authoritative-receipt');
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
  const collector = safeCategory(value.collector, audit, 'collector') ?? 'unknown';
  const code = safeCategory(value.code, audit, 'code') ?? 'collection_failed';
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
  budget = { remaining: MAX_ATTRIBUTE_NODES * 4 },
  seen = new Set<object>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (budget.remaining <= 0 || seen.has(value)) throw new Error('support bundle normalization graph is not bounded');
  budget.remaining -= 1;
  seen.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    if (value.length > MAX_ATTRIBUTE_SCAN_KEYS) throw new Error('support bundle normalization array is not bounded');
    normalized = value.map((child) => stableValue(child, budget, seen));
  } else if (isRecord(value)) {
    const entries = limitedEntries(value as Record<string, unknown>);
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

function compareStableValues(left: unknown, right: unknown): number {
  return compareCodeUnits(serializeForSize(left), serializeForSize(right));
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

function serializeForSize(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function isBoundedNormalizedValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { remaining: MAX_ATTRIBUTE_NODES },
): boolean {
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return byteLength(value) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes;
  if (typeof value !== 'object') return false;
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  if (seen.has(value)) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    valid = value.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeItems;
    for (let index = 0; valid && index < value.length; index += 1) {
      valid = isBoundedNormalizedValue(value[index], depth + 1, seen, budget);
    }
  } else {
    const entries = limitedEntries(value as Record<string, unknown>);
    valid = entries !== undefined && entries.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeKeys;
    for (const [key, child] of entries ?? []) {
      if (!SAFE_ATTRIBUTE_KEY.test(key) || !isBoundedNormalizedValue(child, depth + 1, seen, budget)) {
        valid = false;
        break;
      }
    }
  }
  seen.delete(value);
  return valid;
}

function isNormalizedRecord(value: unknown): value is SupportRecord {
  if (!isRecord(value)
    || !hasOnlyKeys(value, NORMALIZED_RECORD_KEYS)
    || finiteNonNegativeInteger(value.sequence) === undefined
    || safeCanonicalTimestamp(value.at) === undefined
    || typeof value.component !== 'string'
    || !SAFE_CATEGORY_VALUE.test(value.component)
    || typeof value.event !== 'string'
    || !SAFE_CATEGORY_VALUE.test(value.event)
    || (value.outcome !== undefined
      && (typeof value.outcome !== 'string' || !SAFE_CATEGORY_VALUE.test(value.outcome)))
    || (value.durationMs !== undefined
      && (typeof value.durationMs !== 'number' || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0))
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
    || (value.attributes !== undefined && !isBoundedNormalizedValue(value.attributes))) return false;
  try {
    return byteLength(serializeForSize(value)) <= SUPPORT_BUNDLE_LIMITS.maxRecordBytes;
  } catch {
    return false;
  }
}

function isNormalizedError(value: unknown): value is SupportCollectionError {
  if (!isRecord(value)
    || !hasOnlyKeys(value, NORMALIZED_ERROR_KEYS)
    || (typeof value.collector !== 'string' || !SAFE_CATEGORY_VALUE.test(value.collector))
    || (typeof value.code !== 'string' || !SAFE_CATEGORY_VALUE.test(value.code))
    || (value.at !== 'unknown' && safeCanonicalTimestamp(value.at) === undefined)
    || (value.recoveryRequired !== undefined && value.recoveryRequired !== true)) return false;
  return true;
}

function isNormalizedCounterMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const entries = limitedEntries(value);
  return entries !== undefined
    && entries.length <= SUPPORT_BUNDLE_LIMITS.maxAttributeKeys
    && entries.every(([key, count]) => SAFE_CATEGORY_VALUE.test(key)
      && finiteNonNegativeInteger(count) !== undefined);
}

export function isSupportBundleV1(value: unknown): value is SupportBundle {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ROOT_FIELDS)
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
    || value.errors.length > SUPPORT_BUNDLE_LIMITS.maxErrorChain
    || !value.records.every((record) => isNormalizedRecord(record))
    || !value.receipts.every((receipt) => isSupportReceiptProjection(receipt))
    || !value.errors.every((error) => isNormalizedError(error))) return false;
  const redaction = value.redaction;
  const truncation = value.truncation;
  const provenance = value.provenance;
  const provenanceKeys = ['application', 'releaseVersion', 'sourceSha', 'platform', 'architecture'] as const;
  const project = value.project;
  if (!hasOnlyKeys(value.compatibility, new Set(['policy', 'minimumReaderVersion']))
    || !hasOnlyKeys(provenance, new Set(provenanceKeys))
    || (project !== undefined && (!isRecord(project) || !hasOnlyKeys(project, new Set(['idDigest', 'name', 'relativePath']))))
    || !hasOnlyKeys(redaction, new Set(['version', 'redactedFields', 'omittedFields', 'categories']))
    || !hasOnlyKeys(truncation, new Set([
      'recordsOmitted', 'receiptsOmitted', 'stateFieldsOmitted', 'terminalLinesOmitted',
      'bytesOmitted', 'fieldsTruncated', 'totalPayloadBounded',
    ]))) return false;
  const structurallyValid = value.compatibility.policy === SUPPORT_BUNDLE_COMPATIBILITY.policy
    && value.compatibility.minimumReaderVersion === SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion
    && provenanceKeys.every((key) => typeof provenance[key] === 'string'
      && byteLength(provenance[key]) <= SUPPORT_BUNDLE_LIMITS.maxStringBytes)
    && typeof provenance.sourceSha === 'string'
    && (provenance.sourceSha === 'unknown' || /^[0-9a-f]{7,64}$/i.test(provenance.sourceSha))
    && (value.ownerEpoch === undefined || finiteNonNegativeInteger(value.ownerEpoch) !== undefined)
    && (project === undefined || (isRecord(project)
      && typeof project.idDigest === 'string'
      && /^[a-f0-9]{64}$/i.test(project.idDigest)
      && (project.name === undefined || (typeof project.name === 'string' && SAFE_CATEGORY_VALUE.test(project.name)))
      && (project.relativePath === undefined || (typeof project.relativePath === 'string' && isSafeRelativePath(project.relativePath)))))
    && isBoundedNormalizedValue(value.lifecycle)
    && isBoundedNormalizedValue(value.providers)
    && isBoundedNormalizedValue(value.persistence)
    && isBoundedNormalizedValue(value.updater)
    && (value.graphics === undefined || isBoundedNormalizedValue(value.graphics))
    && redaction.version === 1
    && finiteNonNegativeInteger(redaction.redactedFields) !== undefined
    && finiteNonNegativeInteger(redaction.omittedFields) !== undefined
    && isNormalizedCounterMap(redaction.categories)
    && finiteNonNegativeInteger(truncation.recordsOmitted) !== undefined
    && finiteNonNegativeInteger(truncation.receiptsOmitted) !== undefined
    && finiteNonNegativeInteger(truncation.stateFieldsOmitted) !== undefined
    && finiteNonNegativeInteger(truncation.terminalLinesOmitted) !== undefined
    && finiteNonNegativeInteger(truncation.bytesOmitted) !== undefined
    && finiteNonNegativeInteger(truncation.fieldsTruncated) !== undefined
    && typeof truncation.totalPayloadBounded === 'boolean';
  if (!structurallyValid) return false;
  try {
    return byteLength(serializeForSize(value)) <= SUPPORT_BUNDLE_LIMITS.maxBundleBytes;
  } catch {
    return false;
  }
}

function fitBundle(
  bundle: SupportBundle,
  maxBundleBytes: number,
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
  const originalBytes = byteLength(serializeForSize(bundle));
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
  const stateCandidates = (): Array<{ section: typeof stateSections[number]; key: string; size: number }> => stateSections
    .flatMap((section) => {
      const value = source[section];
      if (!value) return [];
      return (limitedEntries(value) ?? []).map(([key, child]) => ({
        section,
        key,
        size: byteLength(JSON.stringify(stableValue(child))),
      }));
    })
    .sort((a, b) => b.size - a.size
      || compareCodeUnits(a.section, b.section)
      || compareCodeUnits(a.key, b.key)
      || compareStableValues(a, b));

  let candidate = withMetadata(0);
  while (true) {
    const currentBytes = byteLength(serializeForSize(candidate));
    if (currentBytes <= maxBundleBytes) {
      const finalCandidate = withMetadata(Math.max(0, originalBytes - currentBytes));
      const finalBytes = byteLength(serializeForSize(finalCandidate));
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
    const bytes = byteLength(serializeForSize(candidate));
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
): SupportBundle {
  const audit = seededAudit(input);
  const homeDirectory = options.homeDirectory;
  const maxRecords = optionLimit(options.maxRecords, SUPPORT_BUNDLE_LIMITS.maxRecords);
  const maxRecordBytes = optionLimit(options.maxRecordBytes, SUPPORT_BUNDLE_LIMITS.maxRecordBytes);
  const maxReceipts = optionLimit(options.maxReceipts, SUPPORT_BUNDLE_LIMITS.maxReceipts);
  const maxBundleBytes = optionLimit(options.maxBundleBytes, SUPPORT_BUNDLE_LIMITS.maxBundleBytes);
  const records: SupportRecord[] = [];
  const rawRecords = Array.isArray(input.records) ? input.records : [];
  for (const raw of rawRecords.slice(0, maxRecords)) {
    const record = sanitizeRecord(raw, audit, homeDirectory);
    if (!record) {
      audit.omittedFields += 1;
      note(audit, 'invalid-record');
      continue;
    }
    const recordBytes = byteLength(JSON.stringify(stableValue(record)));
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
      if (byteLength(JSON.stringify(compact)) <= maxRecordBytes) records.push(compact);
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
    || compareStableValues(a, b));

  const receipts: SupportReceipt[] = [];
  const receiptIds = new Set<string>();
  let duplicateReceiptActionId = false;
  const rawReceipts = Array.isArray(input.receipts) ? input.receipts : [];
  for (const raw of rawReceipts.slice(0, maxReceipts)) {
    const receipt = sanitizeReceipt(raw, audit, receiptMode);
    if (receipt) {
      if (receiptIds.has(receipt.actionId)) {
        duplicateReceiptActionId = true;
        note(audit, 'duplicate-action-id');
        continue;
      }
      receiptIds.add(receipt.actionId);
      receipts.push(receipt);
    }
    else { audit.omittedFields += 1; note(audit, 'invalid-receipt'); }
  }
  receipts.sort((a, b) => compareCodeUnits(a.actionId, b.actionId)
    || compareCodeUnits(a.sourceState, b.sourceState)
    || compareCodeUnits(a.createdAt, b.createdAt)
    || compareStableValues(a, b));

  const errors: SupportCollectionError[] = [];
  const rawErrors = Array.isArray(input.errors) ? input.errors : [];
  for (const raw of rawErrors.slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain)) {
    const error = sanitizeError(raw, audit);
    if (error) errors.push(error);
  }

  const inputEntries = limitedEntries(input);
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
    if (errors.length < SUPPORT_BUNDLE_LIMITS.maxErrorChain) errors.push(duplicateError);
    else errors[errors.length - 1] = duplicateError;
  }
  errors.sort((a, b) => compareCodeUnits(a.at, b.at)
    || compareCodeUnits(a.collector, b.collector)
    || compareCodeUnits(a.code, b.code)
    || compareStableValues(a, b));
  const project = sanitizeProject(input.project, audit, homeDirectory);
  const requestedStatus = sanitizeStatus(input.status, audit);
  const priorTruncation = isRecord(input.truncation) ? input.truncation : {};
  const recordsOmitted = Math.max(suppliedCount(priorTruncation.recordsOmitted), rawRecords.length - records.length);
  const receiptsOmitted = Math.max(suppliedCount(priorTruncation.receiptsOmitted), rawReceipts.length - receipts.length);
  const base: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    version: SUPPORT_BUNDLE_VERSION,
    compatibility: SUPPORT_BUNDLE_COMPATIBILITY,
    generatedAt,
    status: combineStatus(requestedStatus, errors),
    provenance: sanitizeProvenance(input.provenance, audit),
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
      stateFieldsOmitted: suppliedCount(priorTruncation.stateFieldsOmitted),
      terminalLinesOmitted: Math.max(suppliedCount(priorTruncation.terminalLinesOmitted), audit.terminalLinesOmitted),
      bytesOmitted: suppliedCount(priorTruncation.bytesOmitted),
      fieldsTruncated: Math.max(suppliedCount(priorTruncation.fieldsTruncated), audit.fieldsTruncated),
      totalPayloadBounded: false,
    },
  };
  return fitBundle(base, maxBundleBytes).bundle;
}

export function buildSupportBundle(input: SupportBundleInput, options: SupportBundleOptions = {}): SupportBundle {
  return buildSupportBundleWithReceiptMode(input, options, 'raw');
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  if (!isSupportBundleV1(bundle)) {
    throw Object.assign(new Error('unsupported support bundle schema or compatibility version'), {
      code: 'support_bundle_schema_invalid',
    });
  }
  // Re-normalize at the export boundary. A caller may have parsed, cast, or
  // mutated a bundle after construction; serialization must remain an
  // independent redaction boundary rather than trusting the TypeScript type.
  const normalized = buildSupportBundleWithReceiptMode(bundle as unknown as SupportBundleInput, {}, 'projected');
  const serialized = JSON.stringify(stableValue(normalized));
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
  const merged: SupportBundleInput = { generatedAt: new Date(startedAt).toISOString(), records: [], errors: [] };
  const records: SupportRecord[] = [];
  const receipts: SupportReceipt[] = [];
  const errors: SupportCollectionError[] = [];
  const receiptIds = new Set<string>();
  let aggregateOverflow = false;
  let duplicateReceiptActionId = false;
  const appendError = (error: SupportCollectionError): void => {
    if (errors.length < SUPPORT_BUNDLE_LIMITS.maxErrorChain) {
      errors.push(error);
      return;
    }
    if (error.recoveryRequired && !errors.some((item) => item.recoveryRequired)) errors[errors.length - 1] = error;
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
      at: new Date(options.now?.() ?? Date.now()).toISOString(),
      recoveryRequired: true,
    });
  }
  if (controller.signal.aborted) {
    appendError({
      collector: 'support-bundle',
      code: 'collection_cancelled',
      at: new Date(options.now?.() ?? Date.now()).toISOString(),
      recoveryRequired: true,
    });
  }
  try {
    await Promise.all(boundedCollectors.map(async (collector, index) => {
      try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('collection cancelled');
        const result = await Promise.race([collector.collect(controller.signal), deadline]);
        const violation = collectorResultViolation(result, maxRecords, maxReceipts);
        if (violation !== undefined) {
          collected.push({
            index,
            name: collector.name,
            error: {
              collector: collector.name,
              code: violation === 'overflow' ? 'collection_output_overflow' : 'collection_invalid_output',
              at: new Date(options.now?.() ?? Date.now()).toISOString(),
              recoveryRequired: true,
            },
          });
          return;
        }
        collected.push({ index, name: collector.name, result });
      } catch (error) {
        const timedOut = controller.signal.aborted;
        collected.push({
          index,
          name: collector.name,
          error: {
            collector: collector.name,
            code: timedOut ? 'collection_timeout_or_cancelled' : 'collection_failed',
            at: new Date(options.now?.() ?? Date.now()).toISOString(),
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
  const normalizationTimedOut = (): boolean => Date.now() - wallStartedAt >= maxElapsedMs;
  const normalizationInterrupted = (): boolean => controller.signal.aborted || normalizationTimedOut();
  const normalizationError = (): SupportCollectionError => ({
    collector: 'support-bundle',
    code: controller.signal.aborted && !normalizationTimedOut() ? 'normalization_cancelled' : 'normalization_timeout',
    at: new Date(options.now?.() ?? Date.now()).toISOString(),
    recoveryRequired: true,
  });
  const recoveryBundle = (error: SupportCollectionError): SupportBundle => {
    const collectedErrors = collected
      .filter((item): item is typeof item & { error: SupportCollectionError } => item.error !== undefined)
      .map((item) => item.error)
      .slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain);
    return buildSupportBundle({
      ...merged,
      status: 'recovery_required',
      errors: [...errors, ...collectedErrors, error],
    }, options);
  };
  if (normalizationInterrupted()) return recoveryBundle(normalizationError());
  collected.sort((a, b) => compareCodeUnits(a.name, b.name) || a.index - b.index);
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
    if (item.error) {
      appendError(item.error);
      continue;
    }
    if (!item.result) continue;
    for (const [key, value] of (limitedEntries(item.result) ?? []).sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (normalizationInterrupted()) return recoveryBundle(normalizationError());
      if (key === 'status') {
        const next: SupportBundleStatus = value === 'complete' || value === 'partial' || value === 'unknown' || value === 'recovery_required'
          ? value
          : 'unknown';
        if (requestedStatus === undefined || statusRank[next] > statusRank[requestedStatus]) requestedStatus = next;
      } else if (key === 'records' && Array.isArray(value)) {
        if (records.length + value.length > maxRecords) aggregateOverflow = true;
        for (const record of value) {
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          if (records.length >= maxRecords) break;
          records.push(record as SupportRecord);
        }
      } else if (key === 'receipts' && Array.isArray(value)) {
        for (const receipt of value) {
          if (normalizationInterrupted()) return recoveryBundle(normalizationError());
          if (!isActionStatusReceipt(receipt)) {
            aggregateOverflow = true;
            continue;
          }
          if (receiptIds.has(receipt.actionId)) {
            duplicateReceiptActionId = true;
            continue;
          }
          receiptIds.add(receipt.actionId);
          if (receipts.length >= maxReceipts) {
            aggregateOverflow = true;
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
          at: new Date(options.now?.() ?? Date.now()).toISOString(),
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
      at: new Date(options.now?.() ?? Date.now()).toISOString(),
      recoveryRequired: true,
    });
  }
  if (duplicateReceiptActionId) {
    appendError({
      collector: 'support-bundle',
      code: 'duplicate_action_id',
      at: new Date(options.now?.() ?? Date.now()).toISOString(),
      recoveryRequired: true,
    });
  }
  const status = combineStatus(requestedStatus ?? 'complete', errors);
  (merged as Record<string, unknown>).records = records;
  (merged as Record<string, unknown>).receipts = receipts;
  (merged as Record<string, unknown>).errors = errors;
  (merged as Record<string, unknown>).status = status;
  if (normalizationInterrupted()) return recoveryBundle(normalizationError());
  const bundle = buildSupportBundle(merged, options);
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
    terminalTail: ['fixture: diagnostics ready'],
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
