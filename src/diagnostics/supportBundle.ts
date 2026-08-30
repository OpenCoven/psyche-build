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
  'requested',
  'accepted',
  'executing',
  'succeeded',
  'failed',
  'unknown',
  'invalidated',
  'recovery_required',
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

const SENSITIVE_KEY = /(?:^|[_-])(token|secret|password|credential|authorization|cookie|private(?:[_-]?key)?|api(?:[_-]?key)?|access(?:[_-]?token)?)(?:$|[_-])/i;
const CONTENT_KEY = /(?:prompt|transcript|terminal(?:[_-]?output)?|repository(?:[_-]?contents?)?|diff|environment|env(?:ironment)?|source(?:[_-]?contents?)?)/i;
const URL_KEY = /(?:url|uri|endpoint|remote|host)/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const ABSOLUTE_PATH_FRAGMENT = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])[^\s"'`]+/g;
const ANSI = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001bP[\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[()][0-2A-Za-z]|\u001b[=>])/g;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi;
const API_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
const SENSITIVE_ASSIGNMENT = /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY))\s*=\s*[^\s]+/gi;
const SAFE_ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_CATEGORY_VALUE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const INFRASTRUCTURE_URL = /\b(?:https?|ssh|git|ftp):\/\/[^\s"'`]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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
  const scrubbed = scrubText(value, audit, key);
  const bytes = Buffer.byteLength(scrubbed, 'utf8');
  if (bytes <= SUPPORT_BUNDLE_LIMITS.maxStringBytes) return scrubbed;
  audit.fieldsTruncated += 1;
  note(audit, 'bounded-text');
  let result = scrubbed;
  while (Buffer.byteLength(`${result}…`, 'utf8') > SUPPORT_BUNDLE_LIMITS.maxStringBytes) {
    result = result.slice(0, Math.max(0, result.length - 1));
  }
  return `${result}…`;
}

function safeCategory(value: unknown, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (!text) return undefined;
  if (SAFE_CATEGORY_VALUE.test(text)) return text;
  return omit(audit, 'unsafe-category');
}

function safeTimestamp(value: unknown, audit: MutableAudit, key: string): string | undefined {
  const text = boundedText(value, audit, key);
  if (!text || !ISO_TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) {
    return value === undefined ? undefined : omit(audit, 'invalid-timestamp');
  }
  return text;
}

function scrubText(value: string, audit: MutableAudit, key: string): string {
  let result = value.replace(ANSI, '');
  let changed = result !== value;
  for (const [pattern, category] of [
    [PEM, 'certificate-or-key'],
    [BEARER, 'authorization'],
    [API_TOKEN, 'token'],
    [SENSITIVE_ASSIGNMENT, 'secret-assignment'],
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

function safeRelativePath(value: unknown, audit: MutableAudit, key: string): string | undefined {
  if (typeof value !== 'string' || !isSafeRelativePath(value)) {
    return value === undefined ? undefined : omit(audit, 'unsafe-relative-path');
  }
  return boundedText(value.replaceAll('\\', '/'), audit, key);
}

function safeUnknown(
  value: unknown,
  audit: MutableAudit,
  key: string,
  depth: number,
  homeDirectory: string | undefined,
): unknown {
  if (depth > SUPPORT_BUNDLE_LIMITS.maxAttributeDepth) return omit(audit, 'attribute-depth');
  if (SENSITIVE_KEY.test(key)) return redact(value, audit, 'secret-field');
  if (CONTENT_KEY.test(key)) return omit(audit, 'content-field');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : omit(audit, 'non-finite-number');
  if (typeof value === 'string') {
    if (URL_KEY.test(key) && /^\w+:\/\//.test(value)) return redact(value, audit, 'infrastructure-url');
    if (key === 'relativePath') return safeRelativePath(value, audit, key);
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
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys);
  for (const [childKey, childValue] of entries) {
    const outputKey = safeAttributeKey(childKey, audit);
    if (!outputKey) continue;
    const safe = safeUnknown(childValue, audit, childKey, depth + 1, homeDirectory);
    if (safe !== undefined) output[outputKey] = safe;
  }
  if (Object.keys(value).length > entries.length) {
    audit.fieldsTruncated += Object.keys(value).length - entries.length;
    note(audit, 'attribute-keys');
  }
  return output;
}

function safeMap(value: unknown, audit: MutableAudit, homeDirectory?: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys);
  for (const [key, child] of entries) {
    const outputKey = safeAttributeKey(key, audit);
    if (!outputKey) continue;
    const safe = safeUnknown(child, audit, key, 0, homeDirectory);
    if (safe !== undefined) output[outputKey] = safe;
  }
  if (Object.keys(value).length > entries.length) {
    audit.fieldsTruncated += Object.keys(value).length - entries.length;
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
  const relativePath = safeRelativePath(value.relativePath, audit, 'relativePath');
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
    ...(attributes && Object.keys(attributes).length > 0 ? { attributes } : {}),
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
  if (!isRecord(value) || value.sourceSchema !== 'psyche.control.receipt/v1'
    || typeof value.actionId !== 'string' || !isActionReceiptState(value.sourceState)
    || !(SUPPORT_ACTION_STATES as readonly unknown[]).includes(value.state)
    || typeof value.createdAt !== 'string' || !isRecord(value.resource)) return false;
  const resource = value.resource;
  return (resource.kind === 'project' || resource.kind === 'pane' || resource.kind === 'browser_tab')
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
    ...(value.leaseRevision !== undefined ? { leaseRevision: value.leaseRevision } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function sanitizeReceipt(value: unknown, audit: MutableAudit): SupportReceipt | undefined {
  if (isSupportReceiptProjection(value)) return sanitizeProjectedReceipt(value, audit);
  if (!isActionStatusReceipt(value)) {
    if (value !== undefined) note(audit, 'non-authoritative-receipt');
    return undefined;
  }
  const actionId = safeCategory(value.actionId, audit, 'actionId');
  const createdAt = safeTimestamp(value.createdAt, audit, 'createdAt');
  if (!actionId || !createdAt) return undefined;
  const completedAt = safeTimestamp(value.completedAt, audit, 'completedAt');
  const code = safeCategory(value.code, audit, 'code');
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
    ...(value.taskId ? { taskId: safeCategory(value.taskId, audit, 'taskId') } : {}),
    ...(value.actorId ? { actorId: safeCategory(value.actorId, audit, 'actorId') } : {}),
    ...(value.leaseId ? { leaseId: safeCategory(value.leaseId, audit, 'leaseId') } : {}),
    ...(value.leaseRevision !== undefined ? { leaseRevision: value.leaseRevision } : {}),
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
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  let bytes = 0;
  const source = value.slice(-SUPPORT_BUNDLE_LIMITS.maxTerminalLines);
  if (value.length > source.length) {
    audit.terminalLinesOmitted += value.length - source.length;
    note(audit, 'terminal-line-count');
  }
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const item = source[index];
    if (typeof item !== 'string') {
      audit.terminalLinesOmitted += 1;
      note(audit, 'terminal-field');
      continue;
    }
    const line = boundedText(item.replace(ANSI, ''), audit, 'terminalTail');
    if (!line) continue;
    const nextBytes = bytes + Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    if (nextBytes > SUPPORT_BUNDLE_LIMITS.maxTerminalBytes) {
      audit.terminalLinesOmitted += 1;
      audit.fieldsTruncated += 1;
      note(audit, 'terminal-bytes');
      continue;
    }
    selected.push(line);
    bytes = nextBytes;
  }
  return selected.reverse();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function auditManifest(audit: MutableAudit): SupportRedactionManifest {
  return {
    version: 1,
    redactedFields: audit.redactedFields,
    omittedFields: audit.omittedFields,
    categories: Object.fromEntries([...audit.categories.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function serializeForSize(bundle: SupportBundle): string {
  return JSON.stringify(stableValue(bundle));
}

export function isSupportBundleV1(value: unknown): value is SupportBundle {
  if (!isRecord(value)
    || value.schema !== SUPPORT_BUNDLE_SCHEMA
    || value.version !== SUPPORT_BUNDLE_VERSION
    || !isRecord(value.compatibility)) return false;
  return value.compatibility.policy === SUPPORT_BUNDLE_COMPATIBILITY.policy
    && value.compatibility.minimumReaderVersion === SUPPORT_BUNDLE_COMPATIBILITY.minimumReaderVersion;
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
      return Object.entries(value).map(([key, child]) => ({
        section,
        key,
        size: byteLength(JSON.stringify(stableValue(child))),
      }));
    })
    .sort((a, b) => b.size - a.size || a.section.localeCompare(b.section) || a.key.localeCompare(b.key));

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

export function buildSupportBundle(input: SupportBundleInput, options: SupportBundleOptions = {}): SupportBundle {
  const audit: MutableAudit = {
    redactedFields: 0,
    omittedFields: 0,
    fieldsTruncated: 0,
    terminalLinesOmitted: 0,
    categories: new Map(),
  };
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
    || a.at.localeCompare(b.at)
    || a.component.localeCompare(b.component)
    || a.event.localeCompare(b.event)
    || JSON.stringify(stableValue(a)).localeCompare(JSON.stringify(stableValue(b))));

  const receipts: SupportReceipt[] = [];
  const rawReceipts = Array.isArray(input.receipts) ? input.receipts : [];
  for (const raw of rawReceipts.slice(0, maxReceipts)) {
    const receipt = sanitizeReceipt(raw, audit);
    if (receipt) receipts.push(receipt);
    else { audit.omittedFields += 1; note(audit, 'invalid-receipt'); }
  }
  receipts.sort((a, b) => a.actionId.localeCompare(b.actionId));

  const errors: SupportCollectionError[] = [];
  const rawErrors = Array.isArray(input.errors) ? input.errors : [];
  for (const raw of rawErrors.slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain)) {
    const error = sanitizeError(raw, audit);
    if (error) errors.push(error);
  }
  errors.sort((a, b) => a.at.localeCompare(b.at)
    || a.collector.localeCompare(b.collector)
    || a.code.localeCompare(b.code));

  const inputKeys = Object.keys(input);
  for (const key of inputKeys) {
    if (!ROOT_FIELDS.has(key)) omit(audit, 'unknown-root-field');
  }

  const generatedAt = safeTimestamp(input.generatedAt, audit, 'generatedAt') ?? new Date(options.now?.() ?? Date.now()).toISOString();
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

export function serializeSupportBundle(bundle: SupportBundle): string {
  if (!isSupportBundleV1(bundle)) {
    throw Object.assign(new Error('unsupported support bundle schema or compatibility version'), {
      code: 'support_bundle_schema_invalid',
    });
  }
  // Re-normalize at the export boundary. A caller may have parsed, cast, or
  // mutated a bundle after construction; serialization must remain an
  // independent redaction boundary rather than trusting the TypeScript type.
  const normalized = buildSupportBundle(bundle as unknown as SupportBundleInput);
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
  const errors: SupportCollectionError[] = [];
  let requestedStatus: SupportBundleStatus | undefined;
  const collected: Array<{
    index: number;
    name: string;
    result?: SupportBundleInput;
    error?: SupportCollectionError;
  }> = [];
  if (controller.signal.aborted) {
    errors.push({
      collector: 'support-bundle',
      code: 'collection_cancelled',
      at: new Date(options.now?.() ?? Date.now()).toISOString(),
      recoveryRequired: true,
    });
  }
  try {
    await Promise.all(collectors.map(async (collector, index) => {
      try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('collection cancelled');
        const result = await Promise.race([collector.collect(controller.signal), deadline]);
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
  collected.sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index);
  const statusRank: Record<SupportBundleStatus, number> = {
    complete: 0,
    partial: 1,
    unknown: 2,
    recovery_required: 3,
  };
  for (const item of collected) {
    if (item.error) {
      errors.push(item.error);
      continue;
    }
    if (!item.result) continue;
    for (const [key, value] of Object.entries(item.result).sort(([a], [b]) => a.localeCompare(b))) {
      if (key === 'status') {
        const next: SupportBundleStatus = value === 'complete' || value === 'partial' || value === 'unknown' || value === 'recovery_required'
          ? value
          : 'unknown';
        if (requestedStatus === undefined || statusRank[next] > statusRank[requestedStatus]) requestedStatus = next;
      } else if (key === 'records' && Array.isArray(value)) {
        for (const record of value) {
          if (records.length >= maxRecords) break;
          records.push(record as SupportRecord);
        }
      } else if (key === 'errors' && Array.isArray(value)) {
        for (const error of value.slice(0, SUPPORT_BUNDLE_LIMITS.maxErrorChain)) errors.push(error as SupportCollectionError);
      } else if (!(key in merged)) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  const status = combineStatus(requestedStatus ?? 'complete', errors);
  (merged as Record<string, unknown>).records = records;
  (merged as Record<string, unknown>).errors = errors;
  (merged as Record<string, unknown>).status = status;
  let bundle = buildSupportBundle(merged, options);
  if (Date.now() - wallStartedAt > maxElapsedMs && bundle.status === 'complete') {
    const elapsedError: SupportCollectionError = {
      collector: 'support-bundle',
      code: 'normalization_timeout',
      at: new Date(options.now?.() ?? Date.now()).toISOString(),
      recoveryRequired: true,
    };
    bundle = buildSupportBundle({
      ...merged,
      status: 'recovery_required',
      errors: [...errors, elapsedError],
    }, options);
  }
  return bundle;
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
