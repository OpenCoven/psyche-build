/**
 * GPU Slice 4 report merge — deterministic diagnostics evidence composition, schema v1.
 *
 * This module is the machine-checkable counterpart of
 * `docs/gpu/SLICE4-DIAGNOSTICS-CONTRACT.md`. It defines, as typed constants and
 * pure functions:
 *
 * - the closed native platform/architecture/engine vocabularies a native
 *   runtime report must use,
 * - the strict browser graphics probe evidence shape,
 * - `mergeSlice4Reports()`, a deterministic merge of native platform/process
 *   facts with classified browser graphics evidence,
 * - `classifyRenderer()`, the fail-closed renderer evidence classifier,
 * - `boundedMetricsWindow()` with explicit retention and polling-cadence
 *   constants for bounded rendering/transport metrics.
 *
 * Deliberate contract decisions:
 *
 * - Unknown fields are rejected at every level (merge input, native report,
 *   browser report, nested process snapshot, metric samples), so a report
 *   cannot silently grow unvalidated content.
 * - Fields the runtime could not observe are OMITTED from the merged report —
 *   never filled with placeholders such as `null`, `"unknown"`, or `"n/a"`.
 *   Field absence is the honest signal that a field was not observed; fields
 *   the driver stack did not expose are named in `unsupportedFields` instead
 *   of being guessed from OS, vendor, or user-agent strings.
 * - Classification is fail-closed: `accelerated` requires strict context or
 *   WebGPU adapter evidence plus a readable, marker-free renderer identity;
 *   software markers win over strict-context optimism; masked or conflicting
 *   evidence classifies as `unknown`; no usable graphics API is `unavailable`.
 * - The metrics window is bounded by explicit retention and polling-cadence
 *   constants. An oversize window is a typed rejection, never a silent
 *   truncation; the caller owns ring-buffering before handing samples over.
 * - Every returned report, classification, and window is deeply frozen, and
 *   the same inputs always produce the same output shape and key order.
 *
 * Scope note: this module owns the evidence-merge and classification contract
 * only. The process-spawning stress harness is owned by the bead mirrored as
 * OpenCoven/psyche-build#230, and the in-app diagnostics surface by #231; this
 * slice ships neither. No physical-GPU evidence was collected for this module —
 * hosted compilation and unit tests never prove physical GPU acceleration.
 */

/** Schema version implemented by this module. */
export const SLICE4_REPORT_MERGE_SCHEMA_VERSION = 1;

/** Closed acceleration-classification vocabulary. */
export const SLICE4_ACCELERATION_VALUES = [
  'accelerated',
  'software',
  'unknown',
  'unavailable',
] as const;
export type Slice4Acceleration = (typeof SLICE4_ACCELERATION_VALUES)[number];

/** Native desktop platforms a native runtime report may claim. */
export const SLICE4_NATIVE_PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type Slice4NativePlatform = (typeof SLICE4_NATIVE_PLATFORMS)[number];

/** CPU architectures accepted in native report provenance. */
export const SLICE4_NATIVE_ARCHITECTURES = ['x86_64', 'arm64'] as const;
export type Slice4NativeArchitecture = (typeof SLICE4_NATIVE_ARCHITECTURES)[number];

/** WebView engines the native shell can identify, from the Slice 1 mapping. */
export const SLICE4_NATIVE_ENGINES = ['WKWebView', 'WebView2', 'WebKitGTK'] as const;
export type Slice4NativeEngine = (typeof SLICE4_NATIVE_ENGINES)[number];

/** Graphics backend tokens recognized in renderer identity strings. */
export const SLICE4_GRAPHICS_BACKENDS = ['Metal', 'Direct3D', 'Vulkan', 'OpenGL'] as const;
export type Slice4GraphicsBackend = (typeof SLICE4_GRAPHICS_BACKENDS)[number];

/**
 * Probe paths a browser graphics probe may report, in decreasing preference
 * order. `none` means no usable graphics API existed in the webview.
 */
export const SLICE4_PROBE_PATHS = ['webgpu', 'webgl2', 'webgl', 'none'] as const;
export type Slice4ProbePath = (typeof SLICE4_PROBE_PATHS)[number];

/**
 * Versioned, case-insensitive software-renderer markers. A renderer identity
 * containing any marker is software renderer evidence regardless of how
 * capable the context claims to be. Extend this list only with a marker-list
 * version bump and a contract-document update; never by accepting arbitrary
 * markers at runtime.
 */
export const SLICE4_SOFTWARE_RENDERER_MARKERS_VERSION = 1;
export const SLICE4_SOFTWARE_RENDERER_MARKERS = [
  'swiftshader',
  'llvmpipe',
  'lavapipe',
  'softpipe',
  'microsoft basic render driver',
  'software rasterizer',
  'software renderer',
] as const;

/**
 * Bounded metric keys a metrics window may report. Keys outside this list are
 * rejected so windows stay comparable across platforms and runs.
 */
export const SLICE4_METRIC_KEYS = [
  'frame.deltaMs',
  'frames.droppedEstimated',
  'input.focusToPaintMs',
  'input.resizeToPaintMs',
  'pty.queueHighWater',
  'pty.ipcMessagesPerSecond',
  'pty.throughputBytesPerSecond',
  'process.cpuPercent',
  'process.rssMb',
] as const;
export type Slice4MetricKey = (typeof SLICE4_METRIC_KEYS)[number];

/**
 * Structural and cadence bounds enforced by this module. Every bound is a
 * named constant: nothing here is silently truncated or silently dropped.
 */
export const SLICE4_MERGE_LIMITS = {
  /** Required `schemaVersion` on both input reports and the merged report. */
  schemaVersion: SLICE4_REPORT_MERGE_SCHEMA_VERSION,
  /** Maximum length of short identity strings (os, arch, engine, version). */
  shortStringLength: 128,
  /** Maximum length of a renderer identity string. */
  rendererStringLength: 512,
  /** Inclusive upper bound for any reported metric value. */
  metricValueMax: 1_000_000_000,
  /** Maximum number of errors returned in one typed rejection. */
  errorsMax: 32,
} as const;

/**
 * Rendering/transport metrics bounds.
 *
 * - `SLICE4_FRAME_SAMPLE_RETENTION` is the fixed ring capacity from the slice
 *   4 plan (20,000 rAF delta samples). A metrics window may hold exactly this
 *   many samples and never more.
 * - `SLICE4_METRICS_POLL_INTERVAL_MS` is the required merge cadence for PTY
 *   and native process snapshots: snapshots are merged at one-second cadence.
 *   Per-frame polling is forbidden.
 * - `SLICE4_METRICS_MIN_POLL_INTERVAL_MS` rejects faster cadences outright;
 *   `SLICE4_METRICS_MAX_POLL_INTERVAL_MS` rejects values that are not a
 *   polling cadence at all.
 */
export const SLICE4_FRAME_SAMPLE_RETENTION = 20_000;
export const SLICE4_METRICS_POLL_INTERVAL_MS = 1_000;
export const SLICE4_METRICS_MIN_POLL_INTERVAL_MS = SLICE4_METRICS_POLL_INTERVAL_MS;
export const SLICE4_METRICS_MAX_POLL_INTERVAL_MS = 3_600_000;

/** Maximum samples accepted by `boundedMetricsWindow()` — a full ring. */
export const SLICE4_METRICS_WINDOW_MAX_SAMPLES = SLICE4_FRAME_SAMPLE_RETENTION;

/** Closed typed-rejection vocabulary for every result in this module. */
export const SLICE4_REJECTION_REASONS = [
  'schema-version',
  'unknown-field',
  'invalid-field',
  'oversize',
  'cadence-below-minimum',
  'cadence-above-maximum',
] as const;
export type Slice4RejectionReason = (typeof SLICE4_REJECTION_REASONS)[number];

/** Rejection reasons are reported in this deterministic priority order. */
const REJECTION_REASON_PRIORITY: readonly Slice4RejectionReason[] = [
  'schema-version',
  'unknown-field',
  'invalid-field',
  'oversize',
  'cadence-below-minimum',
  'cadence-above-maximum',
];

/**
 * Canonical fallback reasons. Exported so callers and tests can assert exact
 * classification outcomes without duplicating prose.
 */
export const SLICE4_FALLBACK_REASONS = Object.freeze({
  unavailable: 'no usable graphics probe path reported',
  maskedStrict: 'renderer identity masked; strict context alone cannot prove acceleration',
  maskedNonStrict: 'renderer identity masked and no strict context evidence',
  ordinaryContext: 'ordinary context without strict performance caveat evidence',
  conflictingAvailability: 'conflicting renderer evidence: identity availability and renderer string disagree',
  conflictingProbe: 'conflicting renderer evidence: no usable probe path but a renderer identity was reported',
} as const);

/** Graphics identity fields whose absence `unsupportedFields` may record. */
export const SLICE4_UNSUPPORTED_FIELD_ORDER = Object.freeze(['adapter', 'backend'] as const);

/** Native platform provenance carried by every native report. */
export interface Slice4ProcessSnapshotV1 {
  /** Process CPU percentage at sampling time; finite, non-negative. */
  cpuPercent: number;
  /** Resident set size in MiB at sampling time; finite, non-negative. */
  rssMb: number;
  /** ISO-8601 UTC sampling timestamp ending in `Z`. */
  sampledAt: string;
}

/** Native platform/process report, schema v1 (produced by the desktop shell). */
export interface Slice4NativeReportV1 {
  schemaVersion: typeof SLICE4_REPORT_MERGE_SCHEMA_VERSION;
  source: 'native';
  os: Slice4NativePlatform;
  arch: Slice4NativeArchitecture;
  engine: Slice4NativeEngine;
  /** Engine version when the runtime could observe it; omitted otherwise. */
  engineVersion?: string;
  /** True only for debug builds; production never authorizes stress runs. */
  debugBuild: boolean;
  /** Debug-build plus startup-environment authorization outcome. */
  stressAuthorized: boolean;
  /** Current-process resource snapshot when the runtime could sample one. */
  process?: Slice4ProcessSnapshotV1;
}

/** Strict browser graphics probe evidence, schema v1. */
export interface Slice4BrowserReportV1 {
  schemaVersion: typeof SLICE4_REPORT_MERGE_SCHEMA_VERSION;
  source: 'browser';
  /** Strongest usable probe path; `none` when no graphics API was usable. */
  probe: Slice4ProbePath;
  /** True when a strict context (`failIfMajorPerformanceCaveat`) or a WebGPU adapter was obtained. */
  strict: boolean;
  /** True when an unmasked renderer identity was readable through a supported API. */
  rendererIdentityAvailable: boolean;
  /** Unmasked renderer identity string when readable; omitted when masked. */
  renderer?: string;
}

/** Renderer-evidence classification derived only from browser probe facts. */
export interface Slice4RendererClassificationV1 {
  acceleration: Slice4Acceleration;
  backend?: Slice4GraphicsBackend;
  adapter?: string;
  /** Probe path that supports an `accelerated` verdict; omitted otherwise. */
  supportingProbe?: Slice4ProbePath;
  fallbackReason?: string;
  /** Matched software markers, in marker-list order. */
  softwareMarkers: string[];
  /** Graphics identity fields the driver stack did not expose. */
  unsupportedFields: string[];
}

/** Merged runtime graphics report, schema v1. */
export interface Slice4RuntimeGraphicsReportV1 {
  schemaVersion: typeof SLICE4_REPORT_MERGE_SCHEMA_VERSION;
  os: Slice4NativePlatform;
  arch: Slice4NativeArchitecture;
  engine: Slice4NativeEngine;
  engineVersion?: string;
  debugBuild: boolean;
  stressAuthorized: boolean;
  acceleration: Slice4Acceleration;
  backend?: Slice4GraphicsBackend;
  adapter?: string;
  supportingProbe?: Slice4ProbePath;
  fallbackReason?: string;
  softwareMarkers: string[];
  unsupportedFields: string[];
  process?: Slice4ProcessSnapshotV1;
}

/** One bounded metric observation. Values must be finite and non-negative. */
export interface Slice4MetricSampleV1 {
  key: Slice4MetricKey;
  value: number;
}

/** Bounded metrics window: at most `SLICE4_METRICS_WINDOW_MAX_SAMPLES` samples. */
export interface Slice4MetricsWindowV1 {
  samples: readonly Slice4MetricSampleV1[];
  /** Retention bound the window was validated against. */
  retention: typeof SLICE4_FRAME_SAMPLE_RETENTION;
  /** Validated polling cadence, present only when a cadence was supplied. */
  pollIntervalMs?: number;
}

/** Typed rejection: one highest-priority reason plus a bounded error list. */
export interface Slice4RejectionResult {
  ok: false;
  reason: Slice4RejectionReason;
  errors: readonly string[];
}

/** Deterministic merge result: either a frozen report or a typed rejection. */
export type Slice4MergeResult =
  | { ok: true; report: Slice4RuntimeGraphicsReportV1 }
  | Slice4RejectionResult;

/** Renderer classification result. */
export type Slice4ClassificationResult =
  | { ok: true; classification: Slice4RendererClassificationV1 }
  | Slice4RejectionResult;

/** Metrics window result. */
export type Slice4MetricsWindowResult =
  | { ok: true; window: Slice4MetricsWindowV1 }
  | Slice4RejectionResult;

/** Options accepted by `boundedMetricsWindow()`. */
export interface Slice4MetricsWindowOptions {
  /** Required merge cadence for transport/process snapshots, in ms. */
  pollIntervalMs?: number;
}

const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;
const ANGLE_RENDERER_PATTERN = /^ANGLE\s*\((.*)\)\s*$/u;
const ANGLE_METAL_RENDERER_PREFIX_PATTERN = /^ANGLE Metal Renderer:\s*/iu;

const NATIVE_REPORT_FIELDS = [
  'schemaVersion',
  'source',
  'os',
  'arch',
  'engine',
  'engineVersion',
  'debugBuild',
  'stressAuthorized',
  'process',
] as const;

const PROCESS_SNAPSHOT_FIELDS = ['cpuPercent', 'rssMb', 'sampledAt'] as const;

const BROWSER_REPORT_FIELDS = [
  'schemaVersion',
  'source',
  'probe',
  'strict',
  'rendererIdentityAvailable',
  'renderer',
] as const;

const METRIC_SAMPLE_FIELDS = ['key', 'value'] as const;

const MERGE_INPUT_FIELDS = ['native', 'browser'] as const;

const METRICS_OPTIONS_FIELDS = ['pollIntervalMs'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mutable error collector producing a deterministic, bounded error list. */
class Slice4ErrorCollector {
  readonly errors: string[] = [];
  readonly reasons = new Set<Slice4RejectionReason>();

  add(reason: Slice4RejectionReason, message: string): void {
    this.reasons.add(reason);
    if (this.errors.length < SLICE4_MERGE_LIMITS.errorsMax) {
      this.errors.push(message);
    } else if (this.errors.length === SLICE4_MERGE_LIMITS.errorsMax) {
      this.errors.push('additional errors suppressed (bounded error list)');
    }
  }

  rejection(): Slice4RejectionResult {
    for (const reason of REJECTION_REASON_PRIORITY) {
      if (this.reasons.has(reason)) {
        return { ok: false, reason, errors: [...this.errors] };
      }
    }
    return { ok: false, reason: 'invalid-field', errors: [...this.errors] };
  }

  get failed(): boolean {
    return this.reasons.size > 0;
  }
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  state: Slice4ErrorCollector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      state.add('unknown-field', `${path}.${key}: unknown field`);
    }
  }
}

function validateBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  state: Slice4ErrorCollector,
): value is string {
  if (typeof value !== 'string') {
    state.add('invalid-field', `${path}: must be a string`);
    return false;
  }
  if (value.length === 0) {
    state.add('invalid-field', `${path}: must not be empty`);
    return false;
  }
  if (value.length > maxLength) {
    state.add('invalid-field', `${path}: exceeds maximum length of ${maxLength}`);
    return false;
  }
  if (value.trim() !== value) {
    state.add('invalid-field', `${path}: must not have leading or trailing whitespace`);
    return false;
  }
  return true;
}

function validateOptionalBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  state: Slice4ErrorCollector,
): value is string | undefined {
  return value === undefined || validateBoundedString(value, path, maxLength, state);
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  state: Slice4ErrorCollector,
): value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    state.add('invalid-field', `${path}: must be one of ${allowed.join(', ')}`);
    return false;
  }
  return true;
}

function validateBoolean(
  value: unknown,
  path: string,
  state: Slice4ErrorCollector,
): value is boolean {
  if (typeof value !== 'boolean') {
    state.add('invalid-field', `${path}: must be a boolean`);
    return false;
  }
  return true;
}

function validateMetricNumber(
  value: unknown,
  path: string,
  state: Slice4ErrorCollector,
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    state.add('invalid-field', `${path}: must be a finite number`);
    return false;
  }
  if (value < 0 || value > SLICE4_MERGE_LIMITS.metricValueMax) {
    state.add(
      'invalid-field',
      `${path}: must be between 0 and ${SLICE4_MERGE_LIMITS.metricValueMax}`,
    );
    return false;
  }
  return true;
}

function validateIsoUtcTimestamp(
  value: unknown,
  path: string,
  state: Slice4ErrorCollector,
): value is string {
  if (!validateBoundedString(value, path, 32, state)) {
    return false;
  }
  if (!ISO_UTC_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    state.add('invalid-field', `${path}: must be an ISO-8601 UTC timestamp ending in Z`);
    return false;
  }
  return true;
}

function validateSchemaVersion(
  value: unknown,
  path: string,
  state: Slice4ErrorCollector,
): void {
  if (value !== SLICE4_REPORT_MERGE_SCHEMA_VERSION) {
    state.add(
      'schema-version',
      `${path}.schemaVersion: must be ${SLICE4_REPORT_MERGE_SCHEMA_VERSION}`,
    );
  }
}

function validateSource(
  value: unknown,
  expected: string,
  path: string,
  state: Slice4ErrorCollector,
): void {
  if (value !== expected) {
    state.add('invalid-field', `${path}.source: must be ${expected}`);
  }
}

function validateProcessSnapshot(
  value: unknown,
  state: Slice4ErrorCollector,
): Slice4ProcessSnapshotV1 | undefined {
  if (value === undefined) {
    return undefined;
  }
  const path = 'native.process';
  if (!isPlainObject(value)) {
    state.add('invalid-field', `${path}: must be an object`);
    return undefined;
  }
  rejectUnknownFields(value, PROCESS_SNAPSHOT_FIELDS, path, state);
  validateMetricNumber(value.cpuPercent, `${path}.cpuPercent`, state);
  validateMetricNumber(value.rssMb, `${path}.rssMb`, state);
  validateIsoUtcTimestamp(value.sampledAt, `${path}.sampledAt`, state);
  return value as unknown as Slice4ProcessSnapshotV1;
}

function validateNativeReport(value: unknown, state: Slice4ErrorCollector): void {
  const path = 'native';
  if (!isPlainObject(value)) {
    state.add('invalid-field', `${path}: must be an object`);
    return;
  }
  rejectUnknownFields(value, NATIVE_REPORT_FIELDS, path, state);
  validateSchemaVersion(value.schemaVersion, path, state);
  validateSource(value.source, 'native', path, state);
  validateEnum(value.os, SLICE4_NATIVE_PLATFORMS, `${path}.os`, state);
  validateEnum(value.arch, SLICE4_NATIVE_ARCHITECTURES, `${path}.arch`, state);
  validateEnum(value.engine, SLICE4_NATIVE_ENGINES, `${path}.engine`, state);
  validateOptionalBoundedString(
    value.engineVersion,
    `${path}.engineVersion`,
    SLICE4_MERGE_LIMITS.shortStringLength,
    state,
  );
  validateBoolean(value.debugBuild, `${path}.debugBuild`, state);
  validateBoolean(value.stressAuthorized, `${path}.stressAuthorized`, state);
  validateProcessSnapshot(value.process, state);
}

function validateBrowserReport(value: unknown, state: Slice4ErrorCollector): void {
  const path = 'browser';
  if (!isPlainObject(value)) {
    state.add('invalid-field', `${path}: must be an object`);
    return;
  }
  rejectUnknownFields(value, BROWSER_REPORT_FIELDS, path, state);
  validateSchemaVersion(value.schemaVersion, path, state);
  validateSource(value.source, 'browser', path, state);
  validateEnum(value.probe, SLICE4_PROBE_PATHS, `${path}.probe`, state);
  validateBoolean(value.strict, `${path}.strict`, state);
  validateBoolean(
    value.rendererIdentityAvailable,
    `${path}.rendererIdentityAvailable`,
    state,
  );
  validateOptionalBoundedString(
    value.renderer,
    `${path}.renderer`,
    SLICE4_MERGE_LIMITS.rendererStringLength,
    state,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** Split on top-level commas only, respecting nested parentheses. */
function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of input) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/**
 * Derive the adapter identity from a renderer string. Only ANGLE parenthesized
 * renderer identities and plain renderer strings are understood; the middle
 * ANGLE component carries the adapter, with the ANGLE Metal renderer prefix
 * removed when present. Returns undefined for empty input.
 */
function parseAdapter(renderer: string): string | undefined {
  const angleMatch = ANGLE_RENDERER_PATTERN.exec(renderer);
  if (angleMatch === null) {
    const trimmed = renderer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const parts = splitTopLevelCommas(angleMatch[1]);
  const middle = parts.length >= 2 ? parts[1] : parts[0];
  if (middle === undefined) {
    return undefined;
  }
  const withoutPrefix = middle.trim().replace(ANGLE_METAL_RENDERER_PREFIX_PATTERN, '');
  const adapter = withoutPrefix.trim();
  return adapter.length > 0 ? adapter : undefined;
}

/** Derive the graphics backend token from a renderer string, or undefined. */
function parseBackend(renderer: string): Slice4GraphicsBackend | undefined {
  const lower = renderer.toLowerCase();
  if (lower.includes('metal')) {
    return 'Metal';
  }
  if (lower.includes('direct3d') || lower.includes('d3d11') || lower.includes('d3d12')) {
    return 'Direct3D';
  }
  if (lower.includes('vulkan')) {
    return 'Vulkan';
  }
  if (lower.includes('opengl')) {
    return 'OpenGL';
  }
  return undefined;
}

/** Match the versioned software-marker list, case-insensitively, in list order. */
function matchSoftwareMarkers(renderer: string): string[] {
  const lowered = renderer.toLowerCase();
  return SLICE4_SOFTWARE_RENDERER_MARKERS.filter((marker) => lowered.includes(marker));
}

/** Build the unsupported-fields list in canonical order. */
function buildUnsupportedFields(fields: Iterable<string>): string[] {
  const present = new Set(fields);
  return SLICE4_UNSUPPORTED_FIELD_ORDER.filter((field) => present.has(field));
}

/** Wrap a derived classification as a frozen, successful result. */
function classificationResult(
  classification: Slice4RendererClassificationV1,
): Slice4ClassificationResult {
  return { ok: true, classification: deepFreeze(classification) };
}

/**
 * Derive adapter/backend evidence from a renderer identity string, recording
 * which graphics identity fields could not be derived.
 */
function parseRendererIdentity(renderer: string): {
  backend?: Slice4GraphicsBackend;
  adapter?: string;
  unsupportedFields: string[];
} {
  const adapter = parseAdapter(renderer);
  const backend = parseBackend(renderer);
  const missing: string[] = [];
  if (adapter === undefined) {
    missing.push('adapter');
  }
  if (backend === undefined) {
    missing.push('backend');
  }
  return {
    backend,
    adapter,
    unsupportedFields: buildUnsupportedFields(missing),
  };
}

/**
 * Classify browser graphics evidence without guessing.
 *
 * Fail-closed rules, in evaluation order:
 *
 * 1. `probe: 'none'` (no usable graphics API) → `unavailable`.
 * 2. Any versioned software marker in a readable renderer identity →
 *    `software`; markers are authoritative even against a strict context.
 * 3. Conflicting evidence — a renderer string present while identity
 *    availability is false, identity availability claimed with no usable
 *    probe path, or availability claimed without a renderer string — is
 *    `unknown`, never resolved by guessing.
 * 4. `accelerated` only when a strict context or WebGPU adapter exists AND an
 *    unmasked, marker-free renderer identity was read through a supported API.
 * 5. Everything else (masked renderer with strict context, ordinary context
 *    without the strict performance caveat) is `unknown`.
 *
 * Backend and adapter values come only from the renderer identity string.
 * Masked or absent identity omits both fields and lists them in
 * `unsupportedFields` — never placeholders. Vendor, OS, and user-agent data
 * cannot produce a backend or adapter.
 */
export function classifyRenderer(browser: Slice4BrowserReportV1): Slice4ClassificationResult {
  if (!isPlainObject(browser)) {
    return {
      ok: false,
      reason: 'invalid-field',
      errors: ['browser: must be an object'],
    };
  }
  const state = new Slice4ErrorCollector();
  rejectUnknownFields(browser, BROWSER_REPORT_FIELDS, 'browser', state);
  validateSchemaVersion(browser.schemaVersion, 'browser', state);
  validateSource(browser.source, 'browser', 'browser', state);
  validateEnum(browser.probe, SLICE4_PROBE_PATHS, 'browser.probe', state);
  validateBoolean(browser.strict, 'browser.strict', state);
  validateBoolean(
    browser.rendererIdentityAvailable,
    'browser.rendererIdentityAvailable',
    state,
  );
  validateOptionalBoundedString(
    browser.renderer,
    'browser.renderer',
    SLICE4_MERGE_LIMITS.rendererStringLength,
    state,
  );
  if (state.failed) {
    return state.rejection();
  }

  const probe: Slice4ProbePath = browser.probe;
  const strict = browser.strict as boolean;
  const identityAvailable = browser.rendererIdentityAvailable as boolean;
  const renderer: string | undefined = browser.renderer as string | undefined;
  const markers = renderer === undefined ? [] : matchSoftwareMarkers(renderer);

  // Rule 1: no usable graphics API at all.
  if (probe === 'none') {
    if (identityAvailable || renderer !== undefined) {
      return classificationResult({
        acceleration: 'unknown',
        fallbackReason: SLICE4_FALLBACK_REASONS.conflictingProbe,
        softwareMarkers: [],
        unsupportedFields: [...SLICE4_UNSUPPORTED_FIELD_ORDER],
      });
    }
    return classificationResult({
      acceleration: 'unavailable',
      fallbackReason: SLICE4_FALLBACK_REASONS.unavailable,
      softwareMarkers: [],
      unsupportedFields: [...SLICE4_UNSUPPORTED_FIELD_ORDER],
    });
  }

  // Rule 2: software markers are authoritative over strict-context optimism.
  if (markers.length > 0 && renderer !== undefined) {
    const parsed = parseRendererIdentity(renderer);
    return classificationResult({
      acceleration: 'software',
      ...(parsed.backend !== undefined ? { backend: parsed.backend } : {}),
      ...(parsed.adapter !== undefined ? { adapter: parsed.adapter } : {}),
      softwareMarkers: [...markers],
      unsupportedFields: parsed.unsupportedFields,
    });
  }

  // Rule 3: conflicting evidence never resolves to a confident verdict.
  if (identityAvailable !== (renderer !== undefined)) {
    return classificationResult({
      acceleration: 'unknown',
      fallbackReason: SLICE4_FALLBACK_REASONS.conflictingAvailability,
      softwareMarkers: [],
      unsupportedFields: [...SLICE4_UNSUPPORTED_FIELD_ORDER],
    });
  }

  // Rule 4: accelerated requires strict evidence AND readable marker-free identity.
  if (identityAvailable && renderer !== undefined && strict) {
    const parsed = parseRendererIdentity(renderer);
    return classificationResult({
      acceleration: 'accelerated',
      ...(parsed.backend !== undefined ? { backend: parsed.backend } : {}),
      ...(parsed.adapter !== undefined ? { adapter: parsed.adapter } : {}),
      supportingProbe: probe,
      softwareMarkers: [],
      unsupportedFields: parsed.unsupportedFields,
    });
  }

  // Rule 5: masked or non-strict evidence stays unknown.
  return classificationResult({
    acceleration: 'unknown',
    fallbackReason: strict
      ? SLICE4_FALLBACK_REASONS.maskedStrict
      : identityAvailable
        ? SLICE4_FALLBACK_REASONS.ordinaryContext
        : SLICE4_FALLBACK_REASONS.maskedNonStrict,
    softwareMarkers: [],
    unsupportedFields: [...SLICE4_UNSUPPORTED_FIELD_ORDER],
  });
}

/**
 * Merge a native platform/process report with a strict browser graphics
 * report into one deterministic runtime graphics report.
 *
 * Determinism: pure function of its inputs — no clock, no randomness, no I/O.
 * The same inputs always produce the same field set, values, and key order.
 *
 * Omission, not placeholder: `engineVersion`, `backend`, `adapter`,
 * `supportingProbe`, `fallbackReason`, and `process` appear in the merged
 * report only when the evidence actually observed them. Unsupported fields are
 * additionally named in `unsupportedFields`. Nothing is ever filled with
 * `null`, `"unknown"`, `"n/a"`, or a guessed adapter derived from the OS.
 *
 * Rejection: unknown fields at any level, wrong schema versions, wrong
 * `source` discriminators, malformed enums, oversize strings, or malformed
 * process snapshots produce a typed rejection with a bounded error list —
 * never a partially merged report.
 */
export function mergeSlice4Reports(input: {
  native: Slice4NativeReportV1;
  browser: Slice4BrowserReportV1;
}): Slice4MergeResult {
  if (!isPlainObject(input)) {
    return { ok: false, reason: 'invalid-field', errors: ['merge: must be an object'] };
  }
  const state = new Slice4ErrorCollector();
  rejectUnknownFields(input, MERGE_INPUT_FIELDS, 'merge', state);
  validateNativeReport(input.native, state);
  validateBrowserReport(input.browser, state);
  if (state.failed) {
    return state.rejection();
  }

  const native = input.native as unknown as Slice4NativeReportV1;
  const browser = input.browser as unknown as Slice4BrowserReportV1;
  const classificationResult = classifyRenderer(browser);
  if (!classificationResult.ok) {
    return classificationResult;
  }
  const classification = classificationResult.classification;

  const report: Slice4RuntimeGraphicsReportV1 = {
    schemaVersion: SLICE4_REPORT_MERGE_SCHEMA_VERSION,
    os: native.os,
    arch: native.arch,
    engine: native.engine,
    ...(native.engineVersion !== undefined ? { engineVersion: native.engineVersion } : {}),
    debugBuild: native.debugBuild,
    stressAuthorized: native.stressAuthorized,
    acceleration: classification.acceleration,
    ...(classification.backend !== undefined ? { backend: classification.backend } : {}),
    ...(classification.adapter !== undefined ? { adapter: classification.adapter } : {}),
    ...(classification.supportingProbe !== undefined
      ? { supportingProbe: classification.supportingProbe }
      : {}),
    ...(classification.fallbackReason !== undefined
      ? { fallbackReason: classification.fallbackReason }
      : {}),
    softwareMarkers: classification.softwareMarkers,
    unsupportedFields: classification.unsupportedFields,
    ...(native.process !== undefined ? { process: native.process } : {}),
  };
  return { ok: true, report: deepFreeze(report) };
}

/**
 * Build a bounded metrics window from collected samples.
 *
 * Bounds:
 * - At most `SLICE4_METRICS_WINDOW_MAX_SAMPLES` (= `SLICE4_FRAME_SAMPLE_RETENTION`,
 *   the fixed 20,000-sample rAF ring) samples are accepted. An oversize input
 *   is a typed `oversize` rejection — never a silent truncation. The caller
 *   owns ring-buffering before handing samples over.
 * - `pollIntervalMs`, when supplied, must be a positive integer between
 *   `SLICE4_METRICS_MIN_POLL_INTERVAL_MS` and `SLICE4_METRICS_MAX_POLL_INTERVAL_MS`.
 *   Faster cadences are rejected (`cadence-below-minimum`): per-frame polling
 *   of transport/process snapshots is forbidden by the contract.
 * - Sample keys must come from `SLICE4_METRIC_KEYS` and values must be finite,
 *   non-negative, and within `SLICE4_MERGE_LIMITS.metricValueMax`.
 *
 * Oversize input is never silently truncated; callers ring-buffer first.
 */
export function boundedMetricsWindow(
  samples: unknown,
  options?: Slice4MetricsWindowOptions,
): Slice4MetricsWindowResult {
  const path = 'samples';
  const state = new Slice4ErrorCollector();
  if (!Array.isArray(samples)) {
    state.add('invalid-field', `${path}: must be an array`);
    return state.rejection();
  }
  if (samples.length > SLICE4_METRICS_WINDOW_MAX_SAMPLES) {
    state.add(
      'oversize',
      `${path}: exceeds maximum of ${SLICE4_METRICS_WINDOW_MAX_SAMPLES} samples; the caller must ring-buffer before building a window (oversize input is rejected, never silently truncated)`,
    );
    return state.rejection();
  }

  let pollIntervalMs: number | undefined;
  if (options !== undefined) {
    if (!isPlainObject(options)) {
      state.add('invalid-field', 'options: must be an object');
    } else {
      rejectUnknownFields(options, METRICS_OPTIONS_FIELDS, 'options', state);
      if (options.pollIntervalMs !== undefined) {
        const cadence = options.pollIntervalMs;
        if (typeof cadence !== 'number' || !Number.isInteger(cadence)) {
          state.add(
            'invalid-field',
            'options.pollIntervalMs: must be an integer number of milliseconds',
          );
        } else if (cadence < SLICE4_METRICS_MIN_POLL_INTERVAL_MS) {
          state.add(
            'cadence-below-minimum',
            `options.pollIntervalMs: ${cadence} is below the minimum cadence of ${SLICE4_METRICS_MIN_POLL_INTERVAL_MS} ms; per-frame metrics polling is forbidden`,
          );
        } else if (cadence > SLICE4_METRICS_MAX_POLL_INTERVAL_MS) {
          state.add(
            'cadence-above-maximum',
            `options.pollIntervalMs: ${cadence} exceeds the maximum polling cadence of ${SLICE4_METRICS_MAX_POLL_INTERVAL_MS} ms`,
          );
        } else {
          pollIntervalMs = cadence;
        }
      }
    }
  }

  const validatedSamples: Slice4MetricSampleV1[] = [];
  samples.forEach((entry, index) => {
    const samplePath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      state.add('invalid-field', `${samplePath}: must be an object`);
      return;
    }
    rejectUnknownFields(entry, METRIC_SAMPLE_FIELDS, samplePath, state);
    if (!validateEnum(entry.key, SLICE4_METRIC_KEYS, `${samplePath}.key`, state)) {
      return;
    }
    if (validateMetricNumber(entry.value, `${samplePath}.value`, state)) {
      validatedSamples.push({
        key: entry.key as Slice4MetricKey,
        value: entry.value as number,
      });
    }
  });
  if (state.failed) {
    return state.rejection();
  }

  const window: Slice4MetricsWindowV1 = {
    samples: Object.freeze(validatedSamples),
    retention: SLICE4_FRAME_SAMPLE_RETENTION,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
  return { ok: true, window: deepFreeze(window) };
}
