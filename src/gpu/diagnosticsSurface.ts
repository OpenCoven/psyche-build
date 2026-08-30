/**
 * In-app developer GPU diagnostics surface — display contract, schema v1.
 *
 * This module is the machine-checkable counterpart of
 * `docs/gpu/DIAGNOSTICS-SURFACE-CONTRACT.md`. It defines, as pure functions and
 * typed constants, everything the development-only titlebar action and
 * diagnostics panel are allowed to show:
 *
 * - `isDiagnosticsAuthorized()` — the fail-closed dev-only gate (debug build
 *   plus explicit authorization token). Production builds never pass.
 * - `visibleRowsFor()` — the only row set the panel may render: present,
 *   safely displayable fields with their evidence class. Absent or unsupported
 *   fields are omitted, never filled with placeholders.
 * - `diagnosticsJson()` — deterministic, key-sorted, stable serialization for
 *   the copy-JSON action.
 * - `copyForA11y()` — accessible status text in which an active software
 *   fallback is the prominent first sentence.
 * - `canControlScenarios()` — authorization-gated scenario
 *   start/progress/cancel control.
 * - `GPU_DIAGNOSTICS_TRANSITION_PROPERTIES` plus filters — the only transition
 *   properties the panel styling may use (`transform`, `opacity`), mirroring
 *   the Slice 3 compositor audit (`__tests__/tauriCompositorCss.test.ts`).
 *
 * Deliberate contract decisions:
 *
 * - The module is pure: it never reads `process.env`, the DOM, or the network.
 *   The host application supplies the debug-build flag and the authorization
 *   token it observed at startup, so every rule here is unit-testable and the
 *   gate cannot be bypassed by re-reading the environment.
 * - Authorization fails closed: the token must match exactly — no trimming,
 *   no case-folding, no default. Missing debug flag or missing token means
 *   unauthorized, which means no titlebar action, no panel, and no controls.
 * - Only catalogued fields are displayable or serializable. Unknown keys and
 *   unpresentable values (oversize strings, non-finite numbers, out-of-range
 *   lists) are recorded by name in omission manifests — never serialized as
 *   values — so bounded enumerated state cannot leak arbitrary content.
 * - No capability, permission, or CSP expansion is possible through this
 *   module: it renders nothing, imports nothing, and grants nothing. It is a
 *   display contract over data the runtime already collected.
 * - Startup graphics logging is independent of this surface: the always-on
 *   `[psyche:graphics]` startup summary lives in the runtime entry path and
 *   must keep running even when this panel is absent or unauthorized.
 *
 * Scope note: the bead mirrored by OpenCoven/psyche-build#231 is blocked by
 * #230 (debug-authorized rendering stress harness). That harness owns the
 * stress *execution* path; this slice owns only the diagnostics *display*
 * contract, including the authorization gate the panel and its scenario
 * controls must pass. The Tauri UI panel integration (titlebar action, panel
 * markup, styles) is a documented open gap — see the working record.
 */

/** Schema version implemented by this module. */
export const GPU_DIAGNOSTICS_SURFACE_SCHEMA_VERSION = 1;

/** Stable identifier recorded in serialized diagnostics payloads. */
export const GPU_DIAGNOSTICS_SURFACE_ID = 'gpu-diagnostics';

/**
 * Environment variable the desktop launcher may set to carry the explicit
 * authorization token. This module never reads the environment; the host
 * application reads it once at startup and passes the value as
 * `authorizationToken`.
 */
export const GPU_DIAGNOSTICS_AUTHORIZATION_ENV = 'PSYCHE_RENDER_DIAGNOSTICS';

/**
 * The only authorization token value that grants access. Anything else —
 * including a missing value, an empty string, or a padded variant — fails
 * closed.
 */
export const GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN = '1';

/** Field groups the panel may display, in display order. */
export const GPU_DIAGNOSTICS_GROUPS = [
  'graphics',
  'runtime',
  'renderer',
  'transport',
  'frame',
  'process',
] as const;
export type GpuDiagnosticsGroup = (typeof GPU_DIAGNOSTICS_GROUPS)[number];

/** Closed evidence-class vocabulary attached to every visible row. */
export const GPU_DIAGNOSTICS_EVIDENCE_CLASSES = ['reported', 'measured', 'derived'] as const;
export type GpuDiagnosticsEvidenceClass = (typeof GPU_DIAGNOSTICS_EVIDENCE_CLASSES)[number];

/**
 * Acceleration states, mirroring the strict graphics-probe vocabulary used
 * across the GPU family (see `src/gpu/verificationMatrix.ts`): `accelerated`
 * requires strict-context or WebGPU evidence plus non-software renderer
 * markers; everything else is recorded as what it is, never promoted.
 */
export const GPU_DIAGNOSTICS_ACCELERATION_STATES = [
  'accelerated',
  'software',
  'unknown',
  'unavailable',
] as const;
export type GpuDiagnosticsAccelerationState = (typeof GPU_DIAGNOSTICS_ACCELERATION_STATES)[number];

/** The only transition properties diagnostics-panel styling may target. */
export const GPU_DIAGNOSTICS_TRANSITION_PROPERTIES = ['transform', 'opacity'] as const;
export type GpuDiagnosticsTransitionProperty = (typeof GPU_DIAGNOSTICS_TRANSITION_PROPERTIES)[number];

/** Structural bounds enforced on every displayed or serialized value. */
export const GPU_DIAGNOSTICS_LIMITS = {
  /** Maximum length of a displayable string value. Longer values are omitted. */
  stringValueLength: 512,
  /** Maximum length of an entry inside a string-list value. */
  stringListEntryLength: 128,
  /** Maximum entries in a string-list value. Longer lists are omitted. */
  stringListEntries: 8,
  /** Maximum number of unknown-key names recorded in an omission manifest. */
  omittedKeys: 64,
  /** Maximum number of unpresentable catalogued-key names recorded. */
  invalidKeys: 64,
} as const;

/** Graphics-probe evidence: identity facts reported by the strict probe. */
export interface GpuDiagnosticsGraphicsFields {
  acceleration?: GpuDiagnosticsAccelerationState;
  backend?: string;
  adapter?: string;
  softwareMarkers?: string[];
  fallbackReason?: string;
  supportingProbe?: string;
}

/** Runtime/WebView identity facts reported by the native runtime. */
export interface GpuDiagnosticsRuntimeFields {
  engine?: string;
  engineVersion?: string;
  os?: string;
  arch?: string;
}

/** Terminal renderer facts reported by the Slice 3 rendering path. */
export interface GpuDiagnosticsRendererFields {
  mode?: string;
}

/** PTY transport counters sampled by the bounded metrics collectors. */
export interface GpuDiagnosticsTransportFields {
  queueHighWater?: number;
  ipcMessagesPerSecond?: number;
  throughputBytesPerSecond?: number;
}

/** Frame-time statistics derived from bounded ring samples. */
export interface GpuDiagnosticsFrameFields {
  averageMs?: number;
  p95Ms?: number;
  maxMs?: number;
  droppedEstimated?: number;
}

/** Process resource samples reported by the native runtime. */
export interface GpuDiagnosticsProcessFields {
  cpuPercent?: number;
  rssMb?: number;
}

/**
 * One diagnostics snapshot. Every field is optional: the panel renders only
 * what the runtime actually observed. Unknown keys are never displayed or
 * serialized; they are recorded by name only in the omission manifest.
 */
export interface GpuDiagnosticsSnapshotV1 {
  graphics?: GpuDiagnosticsGraphicsFields;
  runtime?: GpuDiagnosticsRuntimeFields;
  renderer?: GpuDiagnosticsRendererFields;
  transport?: GpuDiagnosticsTransportFields;
  frame?: GpuDiagnosticsFrameFields;
  process?: GpuDiagnosticsProcessFields;
}

/** What the host application observed at startup; supplied, never inferred. */
export interface GpuDiagnosticsAuthorizationInput {
  /**
   * True only in a debug (non-production) build. Production builds must pass
   * `false`; the gate then denies authorization regardless of any token.
   */
  debugBuild: boolean;
  /**
   * The explicit authorization token observed at startup (for example the
   * value of `PSYCHE_RENDER_DIAGNOSTICS`), or null/undefined when absent.
   * Must equal `GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN` exactly.
   */
  authorizationToken?: string | null;
}

/** One displayable diagnostics row. Absent fields never produce a row. */
export interface GpuDiagnosticsRow {
  /** Dotted field key, e.g. `graphics.adapter` or `frame.p95Ms`. */
  key: string;
  /** Field group, in `GPU_DIAGNOSTICS_GROUPS`. */
  group: GpuDiagnosticsGroup;
  /** Stable human label for the panel row and status text. */
  label: string;
  /** Display-formatted value; already validated as present and bounded. */
  value: string;
  /** How this fact is known. */
  evidenceClass: GpuDiagnosticsEvidenceClass;
}

/** Descriptor for one catalogued diagnostics field. */
export interface GpuDiagnosticsFieldDescriptor {
  /** Leaf key inside its group object. */
  key: string;
  group: GpuDiagnosticsGroup;
  label: string;
  evidenceClass: GpuDiagnosticsEvidenceClass;
  kind: 'acceleration-state' | 'string' | 'number' | 'string-list';
}

/**
 * The closed field catalog: every row the panel may ever show, in display
 * order. Fields are `reported` (identity/stack facts from the probe or native
 * runtime), `measured` (direct counters: PTY transport, process resources), or
 * `derived` (statistics computed from bounded samples: frame percentiles and
 * dropped-frame estimates).
 */
export const GPU_DIAGNOSTICS_FIELDS: readonly GpuDiagnosticsFieldDescriptor[] = [
  { key: 'acceleration', group: 'graphics', label: 'Acceleration', evidenceClass: 'reported', kind: 'acceleration-state' },
  { key: 'backend', group: 'graphics', label: 'Backend', evidenceClass: 'reported', kind: 'string' },
  { key: 'adapter', group: 'graphics', label: 'Adapter', evidenceClass: 'reported', kind: 'string' },
  { key: 'softwareMarkers', group: 'graphics', label: 'Software renderer markers', evidenceClass: 'reported', kind: 'string-list' },
  { key: 'fallbackReason', group: 'graphics', label: 'Fallback reason', evidenceClass: 'reported', kind: 'string' },
  { key: 'supportingProbe', group: 'graphics', label: 'Supporting probe', evidenceClass: 'reported', kind: 'string' },
  { key: 'engine', group: 'runtime', label: 'WebView engine', evidenceClass: 'reported', kind: 'string' },
  { key: 'engineVersion', group: 'runtime', label: 'WebView engine version', evidenceClass: 'reported', kind: 'string' },
  { key: 'os', group: 'runtime', label: 'Operating system', evidenceClass: 'reported', kind: 'string' },
  { key: 'arch', group: 'runtime', label: 'Architecture', evidenceClass: 'reported', kind: 'string' },
  { key: 'mode', group: 'renderer', label: 'Terminal renderer mode', evidenceClass: 'reported', kind: 'string' },
  { key: 'queueHighWater', group: 'transport', label: 'PTY queue high-water', evidenceClass: 'measured', kind: 'number' },
  { key: 'ipcMessagesPerSecond', group: 'transport', label: 'PTY IPC messages per second', evidenceClass: 'measured', kind: 'number' },
  { key: 'throughputBytesPerSecond', group: 'transport', label: 'PTY throughput bytes per second', evidenceClass: 'measured', kind: 'number' },
  { key: 'averageMs', group: 'frame', label: 'Average frame time (ms)', evidenceClass: 'derived', kind: 'number' },
  { key: 'p95Ms', group: 'frame', label: 'p95 frame time (ms)', evidenceClass: 'derived', kind: 'number' },
  { key: 'maxMs', group: 'frame', label: 'Max frame time (ms)', evidenceClass: 'derived', kind: 'number' },
  { key: 'droppedEstimated', group: 'frame', label: 'Estimated dropped frames', evidenceClass: 'derived', kind: 'number' },
  { key: 'cpuPercent', group: 'process', label: 'Process CPU (percent)', evidenceClass: 'measured', kind: 'number' },
  { key: 'rssMb', group: 'process', label: 'Process resident memory (MB)', evidenceClass: 'measured', kind: 'number' },
];

const FIELD_INDEX: ReadonlyMap<string, GpuDiagnosticsFieldDescriptor> = new Map(
  GPU_DIAGNOSTICS_FIELDS.map((descriptor) => [`${descriptor.group}.${descriptor.key}`, descriptor]),
);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decide whether a raw value is present and safely presentable for its field
 * kind. This is the single omission rule for display and serialization:
 * anything failing it is omitted — never replaced with a placeholder, never
 * truncated.
 */
function isPresentValue(descriptor: GpuDiagnosticsFieldDescriptor, value: unknown): boolean {
  if (descriptor.kind === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (descriptor.kind === 'acceleration-state') {
    return (
      typeof value === 'string'
      && (GPU_DIAGNOSTICS_ACCELERATION_STATES as readonly string[]).includes(value)
    );
  }
  if (descriptor.kind === 'string') {
    return (
      typeof value === 'string'
      && value.length > 0
      && value.length <= GPU_DIAGNOSTICS_LIMITS.stringValueLength
    );
  }
  // string-list: non-empty, bounded count, bounded entries.
  if (!Array.isArray(value) || value.length === 0 || value.length > GPU_DIAGNOSTICS_LIMITS.stringListEntries) {
    return false;
  }
  return value.every(
    (entry) =>
      typeof entry === 'string'
      && entry.length > 0
      && entry.length <= GPU_DIAGNOSTICS_LIMITS.stringListEntryLength,
  );
}

function formatValue(descriptor: GpuDiagnosticsFieldDescriptor, value: unknown): string {
  if (descriptor.kind === 'number' && typeof value === 'number') {
    return String(value);
  }
  if (descriptor.kind === 'string-list' && Array.isArray(value)) {
    return value.join(', ');
  }
  return typeof value === 'string' ? value : String(value);
}

/**
 * Determine whether the developer diagnostics surface is authorized.
 *
 * Authorization requires BOTH:
 *
 * 1. a debug build (`debugBuild === true`) — production builds are denied even
 *    with a valid token, and
 * 2. the explicit authorization token matching
 *    `GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN` exactly — no trimming, no
 *    case-folding, no default.
 *
 * Anything else fails closed: no titlebar action, no panel, no controls.
 */
export function isDiagnosticsAuthorized(input: GpuDiagnosticsAuthorizationInput): boolean {
  if (!isPlainObject(input) || input.debugBuild !== true) {
    return false;
  }
  return (
    typeof input.authorizationToken === 'string'
    && input.authorizationToken === GPU_DIAGNOSTICS_AUTHORIZATION_TOKEN
  );
}

/**
 * Determine whether the rendering scenario controls (start, progress, cancel)
 * may be shown or operated. Scenario control uses exactly the same fail-closed
 * gate as the surface itself: when this returns false, the panel must not
 * render any scenario control, progress indicator, or cancellation affordance.
 * Stress execution itself is owned by the #230 harness and re-checks
 * authorization on its own side.
 */
export function canControlScenarios(input: GpuDiagnosticsAuthorizationInput): boolean {
  return isDiagnosticsAuthorized(input);
}

/**
 * Compute the rows the diagnostics panel may render for a snapshot.
 *
 * Returns exactly one row per catalogued field that is present and safely
 * presentable, in catalog order (group order, then field order). Absent,
 * unsupported, or unpresentable fields produce no row at all — the panel must
 * never render placeholders such as `N/A`, `unknown string`, or empty stubs.
 */
export function visibleRowsFor(snapshot: GpuDiagnosticsSnapshotV1): GpuDiagnosticsRow[] {
  if (!isPlainObject(snapshot)) {
    return [];
  }
  const rows: GpuDiagnosticsRow[] = [];
  for (const group of GPU_DIAGNOSTICS_GROUPS) {
    const groupValue = snapshot[group];
    if (!isPlainObject(groupValue)) {
      continue;
    }
    for (const descriptor of GPU_DIAGNOSTICS_FIELDS) {
      if (descriptor.group !== group) {
        continue;
      }
      const value = groupValue[descriptor.key];
      if (!isPresentValue(descriptor, value)) {
        continue;
      }
      rows.push({
        key: `${group}.${descriptor.key}`,
        group,
        label: descriptor.label,
        value: formatValue(descriptor, value),
        evidenceClass: descriptor.evidenceClass,
      });
    }
  }
  return rows;
}

/** Sorted omission manifests: names only, never values. */
export interface GpuDiagnosticsOmissionManifests {
  /** Keys present in the input but unknown to the catalog. */
  omittedKeys: string[];
  /** Catalogued keys whose value failed the presence/bound rules. */
  invalidKeys: string[];
}

/**
 * Collect omission manifests for a snapshot: unknown keys (group-level or
 * field-level, by dotted path) and catalogued keys whose values failed the
 * presence rules. Names only, capped at `GPU_DIAGNOSTICS_LIMITS`, sorted —
 * raw values are never recorded.
 */
export function omissionManifestsFor(snapshot: GpuDiagnosticsSnapshotV1): GpuDiagnosticsOmissionManifests {
  const omittedKeys: string[] = [];
  const invalidKeys: string[] = [];
  if (!isPlainObject(snapshot)) {
    return { omittedKeys, invalidKeys };
  }
  for (const groupKey of Object.keys(snapshot)) {
    const groupValue = snapshot[groupKey];
    if (!(GPU_DIAGNOSTICS_GROUPS as readonly string[]).includes(groupKey)) {
      // Unknown group: record the group path, descending one level into a
      // plain-object payload so field-level names stay auditable. Values are
      // never recorded.
      if (isPlainObject(groupValue)) {
        for (const fieldKey of Object.keys(groupValue)) {
          omittedKeys.push(`${groupKey}.${fieldKey}`);
        }
      } else {
        omittedKeys.push(groupKey);
      }
      continue;
    }
    if (!isPlainObject(groupValue)) {
      omittedKeys.push(groupKey);
      continue;
    }
    const catalogued = new Set(
      GPU_DIAGNOSTICS_FIELDS.filter((descriptor) => descriptor.group === groupKey).map(
        (descriptor) => descriptor.key,
      ),
    );
    for (const fieldKey of Object.keys(groupValue)) {
      if (!catalogued.has(fieldKey)) {
        omittedKeys.push(`${groupKey}.${fieldKey}`);
        continue;
      }
      const descriptor = FIELD_INDEX.get(`${groupKey}.${fieldKey}`);
      if (descriptor && !isPresentValue(descriptor, groupValue[fieldKey])) {
        invalidKeys.push(`${groupKey}.${fieldKey}`);
      }
    }
  }
  return {
    omittedKeys: omittedKeys
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, GPU_DIAGNOSTICS_LIMITS.omittedKeys),
    invalidKeys: invalidKeys
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, GPU_DIAGNOSTICS_LIMITS.invalidKeys),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

function serializeSnapshot(snapshot: GpuDiagnosticsSnapshotV1): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const group of GPU_DIAGNOSTICS_GROUPS) {
    const groupValue = snapshot[group];
    if (!isPlainObject(groupValue)) {
      continue;
    }
    const groupOut: Record<string, unknown> = {};
    for (const descriptor of GPU_DIAGNOSTICS_FIELDS) {
      if (descriptor.group !== group) {
        continue;
      }
      const value = groupValue[descriptor.key];
      if (isPresentValue(descriptor, value)) {
        // Raw values, not display strings, so the copy stays machine-readable.
        groupOut[descriptor.key] = value;
      }
    }
    if (Object.keys(groupOut).length > 0) {
      serialized[group] = groupOut;
    }
  }
  return serialized;
}

/**
 * Serialize a snapshot as deterministic, key-sorted JSON for the copy action.
 *
 * The payload contains only catalogued, presentable values (raw, not display
 * strings), grouped under `snapshot`, plus name-only omission manifests
 * (`omittedKeys`, `invalidKeys`). Object keys are sorted recursively and
 * numbers use the ECMAScript shortest-round-trip form, so the same snapshot
 * always produces byte-identical output regardless of property insertion
 * order. Array order (e.g. software markers) is preserved as observed.
 */
export function diagnosticsJson(snapshot: GpuDiagnosticsSnapshotV1): string {
  const { omittedKeys, invalidKeys } = omissionManifestsFor(snapshot);
  const payload = {
    schemaVersion: GPU_DIAGNOSTICS_SURFACE_SCHEMA_VERSION,
    surface: GPU_DIAGNOSTICS_SURFACE_ID,
    snapshot: serializeSnapshot(snapshot),
    omittedKeys,
    invalidKeys,
  };
  return JSON.stringify(canonicalize(payload), null, 2);
}

/** Options for `copyForA11y()`. */
export interface GpuDiagnosticsA11yOptions {
  /**
   * Whether scenario controls are authorized for this session (the result of
   * `canControlScenarios()`). The status text describes control availability
   * either way; the panel itself renders controls only when authorized.
   */
  scenarioControlsAuthorized?: boolean;
}

function accelerationStatusSentence(state: GpuDiagnosticsAccelerationState | undefined): string {
  switch (state) {
    case 'software':
      // Prominent by design: this must be the first sentence of the copy.
      return 'SOFTWARE FALLBACK: graphics are running in software, not hardware acceleration.';
    case 'accelerated':
      return 'Hardware graphics acceleration active.';
    case 'unknown':
      return 'Graphics acceleration state unknown.';
    case 'unavailable':
    default:
      return 'Graphics acceleration evidence unavailable.';
  }
}

/**
 * Build accessible status text for the diagnostics panel.
 *
 * When the snapshot reports a software fallback, that fact is the prominent
 * first sentence. Present fields follow as `label: value` pairs in catalog
 * order; absent fields are omitted. The text closes with the scenario-control
 * availability and an explicit omission count so screen-reader users know
 * nothing was silently dropped.
 */
export function copyForA11y(
  snapshot: GpuDiagnosticsSnapshotV1,
  options?: GpuDiagnosticsA11yOptions,
): string {
  const lines: string[] = [];
  const acceleration: GpuDiagnosticsAccelerationState | undefined =
    snapshot?.graphics?.acceleration;
  lines.push(accelerationStatusSentence(acceleration));

  if (acceleration === 'software' && typeof snapshot?.graphics?.fallbackReason === 'string') {
    lines.push(`Fallback reason: ${snapshot.graphics.fallbackReason}.`);
  }

  const rows = visibleRowsFor(snapshot);
  if (rows.length > 0) {
    lines.push(
      `Diagnostics (${rows.length} field${rows.length === 1 ? '' : 's'}): ${rows
        .map((row) => `${row.label}: ${row.value}`)
        .join('; ')}.`,
    );
  } else {
    lines.push('No diagnostic fields are present to display.');
  }

  lines.push(
    options?.scenarioControlsAuthorized === true
      ? 'Rendering scenario controls: available; start, progress, and cancel are authorized.'
      : 'Rendering scenario controls: not available without diagnostics authorization.',
  );

  const { omittedKeys, invalidKeys } = omissionManifestsFor(snapshot);
  const omittedCount = omittedKeys.length + invalidKeys.length;
  if (omittedCount > 0) {
    lines.push(
      `${omittedCount} field${omittedCount === 1 ? ' is' : 's are'} unavailable or unsupported and omitted rather than shown as placeholders.`,
    );
  }

  return lines.join('\n');
}

/** Result of filtering a proposed transition-property list. */
export interface GpuDiagnosticsTransitionFilter {
  /** Properties the panel styling may transition. */
  allowed: GpuDiagnosticsTransitionProperty[];
  /** Properties rejected by the allowlist, normalized (trimmed, lowercased). */
  rejected: string[];
}

/**
 * Filter a proposed transition-property list against the compositor allowlist.
 *
 * Only `transform` and `opacity` may ever pass — the same closed set the Slice
 * 3 compositor CSS audit (`__tests__/tauriCompositorCss.test.ts`) enforces on
 * the desktop stylesheet. Everything else (`all`, `color`, `width`,
 * `box-shadow`, paint-triggering properties of any class) is rejected, so the
 * diagnostics panel cannot introduce a non-compositor animation.
 */
export function filterDiagnosticTransitionProperties(
  properties: readonly string[],
): GpuDiagnosticsTransitionFilter {
  const allowed: GpuDiagnosticsTransitionProperty[] = [];
  const rejected: string[] = [];
  for (const property of properties) {
    const normalized = typeof property === 'string' ? property.trim().toLowerCase() : '';
    if (
      (GPU_DIAGNOSTICS_TRANSITION_PROPERTIES as readonly string[]).includes(normalized)
      && !allowed.includes(normalized as GpuDiagnosticsTransitionProperty)
    ) {
      allowed.push(normalized as GpuDiagnosticsTransitionProperty);
    } else {
      rejected.push(normalized);
    }
  }
  return { allowed, rejected };
}

/**
 * Check a single transition property against the allowlist (trimmed and
 * case-insensitive). Convenience wrapper over
 * `filterDiagnosticTransitionProperties`.
 */
export function isAllowedDiagnosticTransitionProperty(property: string): boolean {
  return filterDiagnosticTransitionProperties([property]).allowed.length === 1;
}
