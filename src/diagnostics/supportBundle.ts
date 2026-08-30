import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

/** The public format is deliberately separate from the control-plane schemas. */
export const SUPPORT_BUNDLE_SCHEMA = 'psyche.diagnostics/v1' as const;
export const SUPPORT_BUNDLE_VERSION = 1 as const;

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
  readonly actionId: string;
  readonly state: SupportActionState;
  readonly resource: Readonly<{
    kind: string;
    idDigest: string;
    generation?: number;
  }>;
  readonly createdAt: string;
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
  readonly terminalLinesOmitted: number;
  readonly bytesOmitted: number;
  readonly fieldsTruncated: number;
  readonly totalPayloadBounded: boolean;
}

export interface SupportBundle {
  readonly schema: typeof SUPPORT_BUNDLE_SCHEMA;
  readonly version: typeof SUPPORT_BUNDLE_VERSION;
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
  categories: Map<string, number>;
}

const ROOT_FIELDS = new Set([
  'generatedAt',
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
]);

const SENSITIVE_KEY = /(?:^|[_-])(token|secret|password|credential|authorization|cookie|private(?:[_-]?key)?|api(?:[_-]?key)?|access(?:[_-]?token)?)(?:$|[_-])/i;
const CONTENT_KEY = /(?:prompt|transcript|terminal(?:[_-]?output)?|repository(?:[_-]?contents?)?|diff|environment|env(?:ironment)?|source(?:[_-]?contents?)?)/i;
const URL_KEY = /(?:url|uri|endpoint|remote|host)/i;
const PATH_KEY = /(?:^|[_-])(?:path|file|directory|cwd|root)(?:$|[_-])/i;
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const ABSOLUTE_PATH_FRAGMENT = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])[^\s"'`]+/g;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi;
const API_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g;
const SENSITIVE_ASSIGNMENT = /\b(?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|PRIVATE_KEY))\s*=\s*[^\s]+/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

function scrubText(value: string, audit: MutableAudit, key: string): string {
  let result = value.replace(ANSI, '');
  let changed = result !== value;
  for (const [pattern, category] of [
    [PEM, 'certificate-or-key'],
    [BEARER, 'authorization'],
    [API_TOKEN, 'token'],
    [SENSITIVE_ASSIGNMENT, 'secret-assignment'],
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
    if (ABSOLUTE_PATH.test(value)) {
      const normalized = normalizeHomePath(value, homeDirectory);
      if (normalized !== value && !ABSOLUTE_PATH.test(normalized)) return boundedText(normalized, audit, key);
      return redact(value, audit, 'absolute-path');
    }
    if (PATH_KEY.test(key) && ABSOLUTE_PATH.test(value)) {
      const normalized = normalizeHomePath(value, homeDirectory);
      if (normalized === value || ABSOLUTE_PATH.test(normalized)) return redact(value, audit, 'absolute-path');
      return boundedText(normalized, audit, key);
    }
    return boundedText(value, audit, key);
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
  const entries = Object.entries(value).slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys);
  for (const [childKey, childValue] of entries) {
    const safe = safeUnknown(childValue, audit, childKey, depth + 1, homeDirectory);
    if (safe !== undefined) output[childKey] = safe;
  }
  if (Object.keys(value).length > entries.length) {
    audit.fieldsTruncated += Object.keys(value).length - entries.length;
    note(audit, 'attribute-keys');
  }
  return output;
}

function textField(input: Record<string, unknown>, key: string, audit: MutableAudit, homeDirectory?: string): string | undefined {
  const value = input[key];
  if (SENSITIVE_KEY.test(key)) return redact(value, audit, 'secret-field');
  if (CONTENT_KEY.test(key)) return omit(audit, 'content-field');
  if (URL_KEY.test(key) && typeof value === 'string' && /^\w+:\/\//.test(value)) return redact(value, audit, 'infrastructure-url');
  if (PATH_KEY.test(key) && typeof value === 'string' && ABSOLUTE_PATH.test(value)) {
    const normalized = normalizeHomePath(value, homeDirectory);
    return normalized === value || ABSOLUTE_PATH.test(normalized)
      ? redact(value, audit, 'absolute-path')
      : boundedText(normalized, audit, key);
  }
  return boundedText(value, audit, key);
}

function safeMap(value: unknown, audit: MutableAudit, homeDirectory?: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, SUPPORT_BUNDLE_LIMITS.maxAttributeKeys)) {
    const safe = safeUnknown(child, audit, key, 0, homeDirectory);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function sanitizeProvenance(value: unknown, audit: MutableAudit): SupportProvenance {
  const input = isRecord(value) ? value : {};
  const get = (key: string, fallback: string): string => boundedText(input[key], audit, key) ?? fallback;
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
  const idDigest = createHash('sha256').update(String(identity), 'utf8').digest('hex');
  const name = textField(value, 'name', audit, homeDirectory);
  const relativePath = typeof value.relativePath === 'string' && !ABSOLUTE_PATH.test(value.relativePath)
    ? boundedText(value.relativePath, audit, 'relativePath')
    : value.relativePath === undefined ? undefined : redact(value.relativePath, audit, 'absolute-path');
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
  return 'complete';
}

function sanitizeActionState(value: unknown, audit: MutableAudit): SupportActionState {
  if ((SUPPORT_ACTION_STATES as readonly unknown[]).includes(value)) return value as SupportActionState;
  if (value !== undefined) note(audit, 'invalid-action-state');
  return 'unknown';
}

function sanitizeRecord(value: unknown, audit: MutableAudit, homeDirectory?: string): SupportRecord | undefined {
  if (!isRecord(value)) return undefined;
  const sequence = finiteNonNegativeInteger(value.sequence);
  const at = boundedText(value.at, audit, 'at');
  const component = textField(value, 'component', audit, homeDirectory);
  const event = textField(value, 'event', audit, homeDirectory);
  if (sequence === undefined || !at || !component || !event) return undefined;
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  const outcome = textField(value, 'outcome', audit, homeDirectory);
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

function sanitizeReceipt(value: unknown, audit: MutableAudit): SupportReceipt | undefined {
  if (!isRecord(value) || !isRecord(value.resource)) return undefined;
  const actionId = boundedText(value.actionId, audit, 'actionId');
  const createdAt = boundedText(value.createdAt, audit, 'createdAt');
  const kind = boundedText(value.resource.kind, audit, 'resource-kind');
  const idDigest = /^[0-9a-f]{16,128}$/i.test(String(value.resource.idDigest ?? ''))
    ? String(value.resource.idDigest)
    : undefined;
  if (!actionId || !createdAt || !kind || !idDigest) return undefined;
  const generation = finiteNonNegativeInteger(value.resource.generation);
  const completedAt = boundedText(value.completedAt, audit, 'completedAt');
  const code = textField(value, 'code', audit);
  const durationMs = typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0
    ? Math.min(Math.floor(value.durationMs), 86_400_000)
    : undefined;
  return {
    actionId,
    state: sanitizeActionState(value.state, audit),
    resource: { kind, idDigest, ...(generation !== undefined ? { generation } : {}) },
    createdAt,
    ...(completedAt ? { completedAt } : {}),
    ...(code ? { code } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function sanitizeError(value: unknown, audit: MutableAudit): SupportCollectionError | undefined {
  if (!isRecord(value)) return undefined;
  const collector = textField(value, 'collector', audit) ?? 'unknown';
  const code = textField(value, 'code', audit) ?? 'collection_failed';
  const at = boundedText(value.at, audit, 'at') ?? 'unknown';
  const message = textField(value, 'message', audit);
  return {
    collector,
    code,
    at,
    ...(message ? { message } : {}),
    ...(value.recoveryRequired === true ? { recoveryRequired: true } : {}),
  };
}

function sanitizeTerminalTail(value: unknown, audit: MutableAudit): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  let bytes = 0;
  for (const item of value.slice(-SUPPORT_BUNDLE_LIMITS.maxTerminalLines)) {
    if (typeof item !== 'string') {
      note(audit, 'terminal-field');
      continue;
    }
    const line = boundedText(item.replace(ANSI, ''), audit, 'terminalTail');
    if (!line) continue;
    const nextBytes = bytes + Buffer.byteLength(line, 'utf8') + (lines.length > 0 ? 1 : 0);
    if (nextBytes > SUPPORT_BUNDLE_LIMITS.maxTerminalBytes) {
      audit.fieldsTruncated += 1;
      note(audit, 'terminal-bytes');
      continue;
    }
    lines.push(line);
    bytes = nextBytes;
  }
  return lines;
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

function fitBundle(
  bundle: SupportBundle,
  maxBundleBytes: number,
): { bundle: SupportBundle; bytesOmitted: number; recordsOmitted: number; terminalLinesOmitted: number } {
  let candidate = bundle;
  let recordsOmitted = 0;
  let terminalLinesOmitted = 0;
  const originalBytes = byteLength(serializeForSize(candidate));
  while (byteLength(serializeForSize(candidate)) > maxBundleBytes && candidate.records.length > 0) {
    recordsOmitted += 1;
    candidate = { ...candidate, records: candidate.records.slice(1) };
  }
  while (byteLength(serializeForSize(candidate)) > maxBundleBytes && candidate.terminalTail.length > 0) {
    terminalLinesOmitted += 1;
    candidate = { ...candidate, terminalTail: candidate.terminalTail.slice(1) };
  }
  const currentBytes = byteLength(serializeForSize(candidate));
  if (currentBytes > maxBundleBytes) {
    // Every field entering here is bounded. Keep the safety contract explicit if
    // an integrator supplies an unusually small custom cap.
    throw Object.assign(new Error('support bundle exceeds the maximum payload size'), {
      code: 'support_bundle_size_exceeded',
      bytes: currentBytes,
      maxBytes: maxBundleBytes,
    });
  }
  return {
    bundle: candidate,
    bytesOmitted: Math.max(0, originalBytes - currentBytes),
    recordsOmitted,
    terminalLinesOmitted,
  };
}

export function buildSupportBundle(input: SupportBundleInput, options: SupportBundleOptions = {}): SupportBundle {
  const audit: MutableAudit = { redactedFields: 0, omittedFields: 0, fieldsTruncated: 0, categories: new Map() };
  const homeDirectory = options.homeDirectory;
  const records: SupportRecord[] = [];
  const rawRecords = Array.isArray(input.records) ? input.records : [];
  for (const raw of rawRecords.slice(0, options.maxRecords ?? SUPPORT_BUNDLE_LIMITS.maxRecords)) {
    const record = sanitizeRecord(raw, audit, homeDirectory);
    if (!record) {
      audit.omittedFields += 1;
      note(audit, 'invalid-record');
      continue;
    }
    const recordBytes = byteLength(JSON.stringify(stableValue(record)));
    if (recordBytes > (options.maxRecordBytes ?? SUPPORT_BUNDLE_LIMITS.maxRecordBytes)) {
      audit.fieldsTruncated += 1;
      note(audit, 'record-size');
      const compact: SupportRecord = {
        sequence: record.sequence,
        at: record.at,
        component: record.component,
        event: record.event,
        truncated: true,
      };
      if (byteLength(JSON.stringify(compact)) <= (options.maxRecordBytes ?? SUPPORT_BUNDLE_LIMITS.maxRecordBytes)) records.push(compact);
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
  records.sort((a, b) => a.sequence - b.sequence || a.at.localeCompare(b.at));

  const receipts: SupportReceipt[] = [];
  const rawReceipts = Array.isArray(input.receipts) ? input.receipts : [];
  for (const raw of rawReceipts.slice(0, options.maxReceipts ?? SUPPORT_BUNDLE_LIMITS.maxReceipts)) {
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
  errors.sort((a, b) => a.at.localeCompare(b.at) || a.collector.localeCompare(b.collector));

  const inputKeys = Object.keys(input);
  for (const key of inputKeys) {
    if (!ROOT_FIELDS.has(key)) omit(audit, 'unknown-root-field');
  }

  const generatedAt = boundedText(input.generatedAt, audit, 'generatedAt') ?? new Date(options.now?.() ?? Date.now()).toISOString();
  const project = sanitizeProject(input.project, audit, homeDirectory);
  const base: SupportBundle = {
    schema: SUPPORT_BUNDLE_SCHEMA,
    version: SUPPORT_BUNDLE_VERSION,
    generatedAt,
    status: sanitizeStatus(input.status, audit),
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
      recordsOmitted: 0,
      terminalLinesOmitted: 0,
      bytesOmitted: 0,
      fieldsTruncated: audit.fieldsTruncated,
      totalPayloadBounded: false,
    },
  };
  const fitted = fitBundle(base, options.maxBundleBytes ?? SUPPORT_BUNDLE_LIMITS.maxBundleBytes);
  return {
    ...fitted.bundle,
    truncation: {
      ...fitted.bundle.truncation,
      recordsOmitted: fitted.recordsOmitted,
      terminalLinesOmitted: fitted.terminalLinesOmitted,
      bytesOmitted: fitted.bytesOmitted,
      totalPayloadBounded: true,
    },
  };
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  const serialized = JSON.stringify(stableValue(bundle));
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
  const startedAt = options.now?.() ?? Date.now();
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
    }, options.maxElapsedMs ?? SUPPORT_BUNDLE_LIMITS.maxElapsedMs);
  });
  const rejectOnAbort = (): void => rejectDeadline?.(controller.signal.reason ?? new Error('support bundle collection cancelled'));
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  const merged: SupportBundleInput = { generatedAt: new Date(startedAt).toISOString(), records: [], errors: [] };
  const records: SupportRecord[] = [];
  const errors: SupportCollectionError[] = [];
  try {
    await Promise.all(collectors.map(async (collector) => {
      try {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('collection cancelled');
        const result = await Promise.race([collector.collect(controller.signal), deadline]);
        for (const [key, value] of Object.entries(result)) {
          if (key === 'records' && Array.isArray(value)) records.push(...value as SupportRecord[]);
          else if (key === 'errors' && Array.isArray(value)) errors.push(...value as SupportCollectionError[]);
          else if (!(key in merged)) (merged as Record<string, unknown>)[key] = value;
        }
      } catch (error) {
        const timedOut = controller.signal.aborted;
        errors.push({
          collector: collector.name,
          code: timedOut ? 'collection_timeout_or_cancelled' : 'collection_failed',
          at: new Date(options.now?.() ?? Date.now()).toISOString(),
          ...(error instanceof Error ? { message: error.message } : {}),
          ...(timedOut ? { recoveryRequired: true } : {}),
        });
      }
    }));
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.signal.removeEventListener('abort', rejectOnAbort);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
  const status: SupportBundleStatus = errors.some((error) => error.recoveryRequired)
    ? 'recovery_required'
    : errors.length > 0 ? 'partial' : 'complete';
  (merged as Record<string, unknown>).records = records;
  (merged as Record<string, unknown>).errors = errors;
  (merged as Record<string, unknown>).status = status;
  return buildSupportBundle(merged, options);
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
      actionId: 'fixture-action',
      state: 'succeeded',
      resource: { kind: 'project', idDigest: '0123456789abcdef0123456789abcdef' },
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.010Z',
      code: 'fixture_ok',
      durationMs: 10,
    }],
  });
}
