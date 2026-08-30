/**
 * GPU verification matrix — evidence manifest contract, schema v1.
 *
 * This module is the machine-checkable counterpart of
 * `docs/gpu/VERIFICATION-MATRIX.md`. It defines, as typed constants:
 *
 * - the physical platform set that must produce acceleration evidence,
 * - the deterministic repository gates that must be recorded per platform,
 * - the 1/6/12/24-pane stress scenario ids,
 * - the bounded metric keys a manifest may report,
 * - the closed evidence-status vocabulary, and
 * - `validateEvidenceManifest()`, a strict structural validator.
 *
 * Deliberate contract decisions:
 *
 * - Unknown fields are rejected at every level, so an evidence manifest cannot
 *   silently grow unvalidated content.
 * - Records are bounded (exactly one record per gate and per scenario, capped
 *   metric counts), so a manifest cannot accumulate unbounded records.
 * - Provenance is mandatory: the exact released version, the full 40-hex commit
 *   SHA, platform, architecture, machine metadata, and driver metadata.
 * - Machine identity is recorded only as a SHA-256 hex digest; raw hostnames,
 *   paths, and other protected data fail validation instead of being stored.
 * - All evidence statuses come from a closed vocabulary including
 *   `unknown`, `unavailable`, and `not-run`, so missing physical evidence is
 *   representable and auditable — never guessed as success.
 *
 * A manifest that validates is still just evidence: it must be tied to a real
 * collection session on physical hardware per the verification matrix document.
 * Hosted CI results never substitute for physical acceleration evidence.
 *
 * Scope note: the bead mirrored by OpenCoven/psyche-build#232 is blocked by
 * #231 (in-app diagnostics surface). This slice ships the matrix and this
 * validator contract; execution evidence on physical platforms remains an
 * explicit open proof gap.
 */

/** Schema version implemented by this module. */
export const GPU_VERIFICATION_MATRIX_SCHEMA_VERSION = 1;

/** Physical desktop platforms that must each produce their own evidence. */
export const GPU_VERIFICATION_PLATFORMS = ['macos', 'windows', 'linux'] as const;
export type GpuVerificationPlatform = (typeof GPU_VERIFICATION_PLATFORMS)[number];

/** CPU architectures accepted in evidence provenance. */
export const GPU_VERIFICATION_ARCHITECTURES = ['x86_64', 'arm64'] as const;
export type GpuVerificationArchitecture = (typeof GPU_VERIFICATION_ARCHITECTURES)[number];

/**
 * Deterministic repository gates that must be recorded in every manifest, one
 * record each. These mirror the acceptance criteria of issue #232: the web
 * bundle build, the portable test/typecheck/build gates, smoke and pack smoke,
 * the three Rust gates for the desktop shell, and whitespace hygiene.
 */
export const GPU_VERIFICATION_GATES = [
  'build:web',
  'test',
  'typecheck',
  'build',
  'smoke',
  'smoke:pack',
  'rust:fmt',
  'rust:test',
  'rust:check',
  'git:diff-check',
] as const;
export type GpuVerificationGate = (typeof GPU_VERIFICATION_GATES)[number];

/** Stress scenario identifiers, in execution order by pane count. */
export const GPU_VERIFICATION_SCENARIO_IDS = [
  'panes-1',
  'panes-6',
  'panes-12',
  'panes-24',
] as const;
export type GpuVerificationScenarioId = (typeof GPU_VERIFICATION_SCENARIO_IDS)[number];

/**
 * Bounded metric keys a manifest may report. Keys outside this list are
 * rejected so metric records stay comparable across platforms and runs.
 */
export const GPU_VERIFICATION_METRIC_KEYS = [
  'frame.averageMs',
  'frame.p95Ms',
  'frame.maxMs',
  'frames.droppedEstimated',
  'input.focusToPaintMs',
  'input.resizeToPaintMs',
  'pty.queueHighWater',
  'pty.ipcMessagesPerSecond',
  'pty.throughputBytesPerSecond',
  'process.cpuPercent',
  'process.rssMb',
] as const;
export type GpuVerificationMetricKey = (typeof GPU_VERIFICATION_METRIC_KEYS)[number];

/**
 * Closed evidence-status vocabulary. `unknown` and `unavailable` exist so a
 * collector records reality; `not-run` marks a required check that never
 * executed; `recovery_required` marks a resilience check (for example context
 * loss) that only passed after a recovery path ran.
 */
export const GPU_VERIFICATION_STATUSES = [
  'succeeded',
  'failed',
  'unknown',
  'recovery_required',
  'unavailable',
  'not-run',
] as const;
export type GpuVerificationStatus = (typeof GPU_VERIFICATION_STATUSES)[number];

/**
 * Acceleration classification for the driver section. It mirrors the strict
 * graphics-probe vocabulary: `accelerated` requires a strict context or WebGPU
 * adapter plus non-software renderer evidence; everything else is recorded as
 * what it is, never promoted.
 */
export const GPU_VERIFICATION_ACCELERATION_VALUES = [
  'accelerated',
  'software',
  'unknown',
  'unavailable',
] as const;
export type GpuAccelerationEvidence = (typeof GPU_VERIFICATION_ACCELERATION_VALUES)[number];

/** Lifecycle checks that must each carry an explicit status. */
export const GPU_VERIFICATION_LIFECYCLE_CHECKS = [
  'contextLoss',
  'minimize',
  'background',
  'restore',
] as const;
export type GpuVerificationLifecycleCheck = (typeof GPU_VERIFICATION_LIFECYCLE_CHECKS)[number];

/** Verdicts allowed for the CSP and capability diff audit. */
export const GPU_VERIFICATION_DIFF_VERDICTS = [
  'unchanged',
  'weakened',
  'strengthened',
  'unknown',
] as const;
export type GpuVerificationDiffVerdict = (typeof GPU_VERIFICATION_DIFF_VERDICTS)[number];

/** Review outcomes for the final cumulative spec and code reviews. */
export const GPU_VERIFICATION_REVIEW_STATUSES = [
  'pending',
  'approved',
  'changes-requested',
] as const;
export type GpuVerificationReviewStatus = (typeof GPU_VERIFICATION_REVIEW_STATUSES)[number];

/** Structural limits enforced by `validateEvidenceManifest()`. */
export const GPU_VERIFICATION_LIMITS = {
  /** Required `schemaVersion`. */
  schemaVersion: GPU_VERIFICATION_MATRIX_SCHEMA_VERSION,
  /** Gate records must be exactly one per listed gate — no more, no fewer. */
  gateRecords: GPU_VERIFICATION_GATES.length,
  /** Scenario records must be exactly one per listed scenario. */
  scenarioRecords: GPU_VERIFICATION_SCENARIO_IDS.length,
  /** Maximum metric records attached to a single scenario. */
  metricsPerScenario: 8,
  /** Maximum host-level metric records on the manifest. */
  topLevelMetrics: 16,
  /** Maximum detected software-renderer marker strings in driver metadata. */
  softwareMarkers: 8,
  /** Maximum length of any free-form note field. */
  noteLength: 512,
  /** Maximum length of short identifiers (collector, os, engine, reviewer). */
  shortStringLength: 128,
  /** Maximum length of the release version string. */
  releaseVersionLength: 32,
  /** Inclusive upper bound for any reported metric value. */
  maxMetricValue: 1_000_000_000,
} as const;

/** Who and what produced the evidence, down to the exact release head. */
export interface GpuEvidenceProvenance {
  /** Exact released version the evidence is tied to, e.g. `0.0.2`. */
  releaseVersion: string;
  /** Full 40-hex commit SHA the build was made from. Short SHAs are rejected. */
  commitSha: string;
  /** Physical platform the evidence was collected on. */
  platform: GpuVerificationPlatform;
  /** CPU architecture of the collecting machine. */
  architecture: GpuVerificationArchitecture;
  /** ISO-8601 UTC collection timestamp ending in `Z`. */
  collectedAt: string;
  /** Bounded identifier of the collection path, e.g. `operator-manual`. */
  collector: string;
}

/**
 * Machine metadata, kept separate from driver metadata so GPU facts and host
 * facts can be audited independently. The host is identified only by a SHA-256
 * digest of its hostname; raw hostnames are protected data and fail validation.
 */
export interface GpuMachineMetadata {
  /** SHA-256 hex digest (64 lowercase hex chars) of the hostname. */
  hostnameDigest: string;
  /** Operating system name, e.g. `macOS`. */
  osName: string;
  /** Operating system version, e.g. `14.6.1`. */
  osVersion: string;
  /** False for any virtualized machine — its evidence cannot support targets. */
  physicalHardware: boolean;
}

/**
 * Driver and graphics-stack metadata, kept separate from machine metadata.
 * Fields the probe could not observe are omitted (never filled with
 * placeholders), and `acceleration` is exactly what the evidence supports.
 */
export interface GpuDriverMetadata {
  /** WebView engine identity, e.g. `WKWebView`, `WebView2`, `WebKitGTK`. */
  webviewEngine: string;
  /** Engine version when the runtime reports it. */
  webviewVersion?: string;
  /** Graphics backend when the probe could observe it (Metal, Direct3D, ...). */
  gpuBackend?: string;
  /** GPU adapter string when not masked by the driver stack. */
  gpuAdapter?: string;
  /** Strict acceleration classification; `accelerated` is required for claims. */
  acceleration: GpuAccelerationEvidence;
  /** Detected software-renderer markers (SwiftShader, llvmpipe, ...). */
  softwareMarkers: string[];
}

/** One deterministic repository gate outcome. Exactly one record per gate. */
export interface GpuGateRecord {
  gate: GpuVerificationGate;
  status: GpuVerificationStatus;
  note?: string;
}

/** One bounded metric observation. Values must be finite, non-negative. */
export interface GpuMetricRecord {
  key: GpuVerificationMetricKey;
  value: number;
  note?: string;
}

/** One stress scenario outcome. Exactly one record per scenario id. */
export interface GpuScenarioRecord {
  scenarioId: GpuVerificationScenarioId;
  status: GpuVerificationStatus;
  metrics: GpuMetricRecord[];
  note?: string;
}

/** Explicit statuses for every required lifecycle/resilience check. */
export interface GpuLifecycleOutcomes {
  contextLoss: GpuVerificationStatus;
  minimize: GpuVerificationStatus;
  background: GpuVerificationStatus;
  restore: GpuVerificationStatus;
}

/** CSP and capability diff audit outcome for the collection build. */
export interface GpuCspCapabilityAudit {
  /** CSP diff verdict versus the release base; `weakened` must fail review. */
  cspDiff: GpuVerificationDiffVerdict;
  /** Capability diff verdict versus the release base; no expansion allowed. */
  capabilityDiff: GpuVerificationDiffVerdict;
  note?: string;
}

/** One independent review outcome. */
export interface GpuReviewRecord {
  status: GpuVerificationReviewStatus;
  /** Bounded reviewer identifier; omit rather than placeholder. */
  reviewer?: string;
}

/** Final cumulative review requirements recorded in the manifest. */
export interface GpuReviewOutcomes {
  specReview: GpuReviewRecord;
  codeReview: GpuReviewRecord;
}

/** Evidence manifest, schema v1. See `docs/gpu/VERIFICATION-MATRIX.md`. */
export interface GpuEvidenceManifestV1 {
  schemaVersion: typeof GPU_VERIFICATION_MATRIX_SCHEMA_VERSION;
  provenance: GpuEvidenceProvenance;
  machine: GpuMachineMetadata;
  driver: GpuDriverMetadata;
  gates: GpuGateRecord[];
  scenarios: GpuScenarioRecord[];
  lifecycle: GpuLifecycleOutcomes;
  metrics: GpuMetricRecord[];
  cspCapabilityAudit: GpuCspCapabilityAudit;
  reviews: GpuReviewOutcomes;
}

/** Strict validation result: either a validated manifest or bounded errors. */
export type GpuEvidenceManifestValidation =
  | { ok: true; manifest: GpuEvidenceManifestV1 }
  | { ok: false; errors: string[] };

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const HOSTNAME_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}.${key}: unknown field`);
    }
  }
}

function validateBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
): value is string {
  if (typeof value !== 'string') {
    errors.push(`${path}: must be a string`);
    return false;
  }
  if (value.length === 0) {
    errors.push(`${path}: must not be empty`);
    return false;
  }
  if (value.length > maxLength) {
    errors.push(`${path}: exceeds maximum length of ${maxLength}`);
    return false;
  }
  if (value.trim() !== value) {
    errors.push(`${path}: must not have leading or trailing whitespace`);
    return false;
  }
  return true;
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: string[],
): value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    errors.push(`${path}: must be one of ${allowed.join(', ')}`);
    return false;
  }
  return true;
}

function validateOptionalBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }
  validateBoundedString(value, path, maxLength, errors);
}

function validateMetricRecords(
  value: unknown,
  path: string,
  maxRecords: number,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`);
    return;
  }
  if (value.length > maxRecords) {
    errors.push(`${path}: exceeds maximum of ${maxRecords} records`);
    return;
  }
  const seenKeys = new Set<string>();
  value.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    if (!isPlainObject(record)) {
      errors.push(`${recordPath}: must be an object`);
      return;
    }
    rejectUnknownFields(record, ['key', 'value', 'note'], recordPath, errors);
    if (!validateEnum(record.key, GPU_VERIFICATION_METRIC_KEYS, `${recordPath}.key`, errors)) {
      return;
    }
    const key = record.key as GpuVerificationMetricKey;
    if (seenKeys.has(key)) {
      errors.push(`${recordPath}.key: duplicate metric key ${key}`);
    }
    seenKeys.add(key);
    if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
      errors.push(`${recordPath}.value: must be a finite number`);
    } else if (record.value < 0 || record.value > GPU_VERIFICATION_LIMITS.maxMetricValue) {
      errors.push(
        `${recordPath}.value: must be between 0 and ${GPU_VERIFICATION_LIMITS.maxMetricValue}`,
      );
    }
    validateOptionalBoundedString(record.note, `${recordPath}.note`, GPU_VERIFICATION_LIMITS.noteLength, errors);
  });
}

function validateGateRecords(value: unknown, errors: string[]): void {
  const path = 'gates';
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`);
    return;
  }
  if (value.length !== GPU_VERIFICATION_LIMITS.gateRecords) {
    errors.push(
      `${path}: must contain exactly ${GPU_VERIFICATION_LIMITS.gateRecords} records, one per gate`,
    );
    return;
  }
  const seenGates = new Set<string>();
  value.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    if (!isPlainObject(record)) {
      errors.push(`${recordPath}: must be an object`);
      return;
    }
    rejectUnknownFields(record, ['gate', 'status', 'note'], recordPath, errors);
    if (!validateEnum(record.gate, GPU_VERIFICATION_GATES, `${recordPath}.gate`, errors)) {
      return;
    }
    const gate = record.gate as GpuVerificationGate;
    if (seenGates.has(gate)) {
      errors.push(`${recordPath}.gate: duplicate gate ${gate}`);
    }
    seenGates.add(gate);
    validateEnum(record.status, GPU_VERIFICATION_STATUSES, `${recordPath}.status`, errors);
    validateOptionalBoundedString(record.note, `${recordPath}.note`, GPU_VERIFICATION_LIMITS.noteLength, errors);
  });
}

function validateScenarioRecords(value: unknown, errors: string[]): void {
  const path = 'scenarios';
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`);
    return;
  }
  if (value.length !== GPU_VERIFICATION_LIMITS.scenarioRecords) {
    errors.push(
      `${path}: must contain exactly ${GPU_VERIFICATION_LIMITS.scenarioRecords} records, one per scenario`,
    );
    return;
  }
  const seenScenarios = new Set<string>();
  value.forEach((record, index) => {
    const recordPath = `${path}[${index}]`;
    if (!isPlainObject(record)) {
      errors.push(`${recordPath}: must be an object`);
      return;
    }
    rejectUnknownFields(record, ['scenarioId', 'status', 'metrics', 'note'], recordPath, errors);
    if (
      !validateEnum(
        record.scenarioId,
        GPU_VERIFICATION_SCENARIO_IDS,
        `${recordPath}.scenarioId`,
        errors,
      )
    ) {
      return;
    }
    const scenarioId = record.scenarioId as GpuVerificationScenarioId;
    if (seenScenarios.has(scenarioId)) {
      errors.push(`${recordPath}.scenarioId: duplicate scenario ${scenarioId}`);
    }
    seenScenarios.add(scenarioId);
    validateEnum(record.status, GPU_VERIFICATION_STATUSES, `${recordPath}.status`, errors);
    validateMetricRecords(
      record.metrics,
      `${recordPath}.metrics`,
      GPU_VERIFICATION_LIMITS.metricsPerScenario,
      errors,
    );
    validateOptionalBoundedString(record.note, `${recordPath}.note`, GPU_VERIFICATION_LIMITS.noteLength, errors);
  });
}

/**
 * Strictly validate an unknown value as a GPU evidence manifest (schema v1).
 *
 * Returns every structural violation found, in a bounded error list. Unknown
 * fields, missing provenance, unbounded or duplicated records, oversize
 * strings, bogus ids/statuses/metric keys, and raw machine identifiers are all
 * rejected. Passing validation is a structural fact only — it does not assert
 * that the evidence was actually collected.
 */
export function validateEvidenceManifest(input: unknown): GpuEvidenceManifestValidation {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: ['manifest: must be a JSON object'],
    };
  }

  rejectUnknownFields(
    input,
    [
      'schemaVersion',
      'provenance',
      'machine',
      'driver',
      'gates',
      'scenarios',
      'lifecycle',
      'metrics',
      'cspCapabilityAudit',
      'reviews',
    ],
    'manifest',
    errors,
  );

  if (input.schemaVersion !== GPU_VERIFICATION_LIMITS.schemaVersion) {
    errors.push(
      `schemaVersion: must be ${GPU_VERIFICATION_LIMITS.schemaVersion}`,
    );
  }

  // Provenance: exact release version, full commit SHA, platform, architecture,
  // collection timestamp, and collector identity are all mandatory.
  const provenance = input.provenance;
  if (!isPlainObject(provenance)) {
    errors.push('provenance: must be an object with releaseVersion, commitSha, platform, architecture, collectedAt, and collector');
  } else {
    rejectUnknownFields(
      provenance,
      ['releaseVersion', 'commitSha', 'platform', 'architecture', 'collectedAt', 'collector'],
      'provenance',
      errors,
    );
    if (
      validateBoundedString(
        provenance.releaseVersion,
        'provenance.releaseVersion',
        GPU_VERIFICATION_LIMITS.releaseVersionLength,
        errors,
      )
    ) {
      if (provenance.releaseVersion.trim() !== provenance.releaseVersion) {
        errors.push('provenance.releaseVersion: must not have leading or trailing whitespace');
      }
    }
    if (
      validateBoundedString(
        provenance.commitSha,
        'provenance.commitSha',
        40,
        errors,
      ) &&
      !COMMIT_SHA_PATTERN.test(provenance.commitSha)
    ) {
      errors.push('provenance.commitSha: must be a full 40-character lowercase hex commit SHA');
    }
    validateEnum(provenance.platform, GPU_VERIFICATION_PLATFORMS, 'provenance.platform', errors);
    validateEnum(
      provenance.architecture,
      GPU_VERIFICATION_ARCHITECTURES,
      'provenance.architecture',
      errors,
    );
    if (
      validateBoundedString(provenance.collectedAt, 'provenance.collectedAt', 32, errors) &&
      (!ISO_UTC_TIMESTAMP_PATTERN.test(provenance.collectedAt) ||
        Number.isNaN(Date.parse(provenance.collectedAt)))
    ) {
      errors.push('provenance.collectedAt: must be an ISO-8601 UTC timestamp ending in Z');
    }
    validateBoundedString(
      provenance.collector,
      'provenance.collector',
      GPU_VERIFICATION_LIMITS.shortStringLength,
      errors,
    );
  }

  // Machine metadata: digest-only host identity, OS facts, hardware honesty.
  const machine = input.machine;
  if (!isPlainObject(machine)) {
    errors.push('machine: must be an object with hostnameDigest, osName, osVersion, and physicalHardware');
  } else {
    rejectUnknownFields(
      machine,
      ['hostnameDigest', 'osName', 'osVersion', 'physicalHardware'],
      'machine',
      errors,
    );
    if (
      validateBoundedString(
        machine.hostnameDigest,
        'machine.hostnameDigest',
        64,
        errors,
      ) &&
      !HOSTNAME_DIGEST_PATTERN.test(machine.hostnameDigest)
    ) {
      errors.push('machine.hostnameDigest: must be a 64-character lowercase hex SHA-256 digest; raw hostnames are protected data');
    }
    validateBoundedString(machine.osName, 'machine.osName', GPU_VERIFICATION_LIMITS.shortStringLength, errors);
    validateBoundedString(machine.osVersion, 'machine.osVersion', GPU_VERIFICATION_LIMITS.shortStringLength, errors);
    if (typeof machine.physicalHardware !== 'boolean') {
      errors.push('machine.physicalHardware: must be a boolean');
    }
  }

  // Driver metadata: separate from machine metadata; omissions stay omitted.
  const driver = input.driver;
  if (!isPlainObject(driver)) {
    errors.push('driver: must be an object with webviewEngine and acceleration');
  } else {
    rejectUnknownFields(
      driver,
      ['webviewEngine', 'webviewVersion', 'gpuBackend', 'gpuAdapter', 'acceleration', 'softwareMarkers'],
      'driver',
      errors,
    );
    validateBoundedString(
      driver.webviewEngine,
      'driver.webviewEngine',
      GPU_VERIFICATION_LIMITS.shortStringLength,
      errors,
    );
    validateOptionalBoundedString(
      driver.webviewVersion,
      'driver.webviewVersion',
      GPU_VERIFICATION_LIMITS.shortStringLength,
      errors,
    );
    validateOptionalBoundedString(
      driver.gpuBackend,
      'driver.gpuBackend',
      GPU_VERIFICATION_LIMITS.shortStringLength,
      errors,
    );
    validateOptionalBoundedString(
      driver.gpuAdapter,
      'driver.gpuAdapter',
      GPU_VERIFICATION_LIMITS.shortStringLength,
      errors,
    );
    validateEnum(
      driver.acceleration,
      GPU_VERIFICATION_ACCELERATION_VALUES,
      'driver.acceleration',
      errors,
    );
    const softwareMarkers = driver.softwareMarkers;
    if (!Array.isArray(softwareMarkers)) {
      errors.push('driver.softwareMarkers: must be an array');
    } else if (softwareMarkers.length > GPU_VERIFICATION_LIMITS.softwareMarkers) {
      errors.push(`driver.softwareMarkers: exceeds maximum of ${GPU_VERIFICATION_LIMITS.softwareMarkers} entries`);
    } else {
      softwareMarkers.forEach((marker, index) => {
        validateBoundedString(marker, `driver.softwareMarkers[${index}]`, GPU_VERIFICATION_LIMITS.shortStringLength, errors);
      });
    }
  }

  validateGateRecords(input.gates, errors);
  validateScenarioRecords(input.scenarios, errors);

  // Lifecycle outcomes: every required check carries an explicit status.
  const lifecycle = input.lifecycle;
  if (!isPlainObject(lifecycle)) {
    errors.push('lifecycle: must be an object with contextLoss, minimize, background, and restore');
  } else {
    rejectUnknownFields(lifecycle, [...GPU_VERIFICATION_LIFECYCLE_CHECKS], 'lifecycle', errors);
    for (const check of GPU_VERIFICATION_LIFECYCLE_CHECKS) {
      validateEnum(lifecycle[check], GPU_VERIFICATION_STATUSES, `lifecycle.${check}`, errors);
    }
  }

  validateMetricRecords(input.metrics, 'metrics', GPU_VERIFICATION_LIMITS.topLevelMetrics, errors);

  // CSP and capability diff audit.
  const cspCapabilityAudit = input.cspCapabilityAudit;
  if (!isPlainObject(cspCapabilityAudit)) {
    errors.push('cspCapabilityAudit: must be an object with cspDiff and capabilityDiff');
  } else {
    rejectUnknownFields(
      cspCapabilityAudit,
      ['cspDiff', 'capabilityDiff', 'note'],
      'cspCapabilityAudit',
      errors,
    );
    validateEnum(
      cspCapabilityAudit.cspDiff,
      GPU_VERIFICATION_DIFF_VERDICTS,
      'cspCapabilityAudit.cspDiff',
      errors,
    );
    validateEnum(
      cspCapabilityAudit.capabilityDiff,
      GPU_VERIFICATION_DIFF_VERDICTS,
      'cspCapabilityAudit.capabilityDiff',
      errors,
    );
    validateOptionalBoundedString(
      cspCapabilityAudit.note,
      'cspCapabilityAudit.note',
      GPU_VERIFICATION_LIMITS.noteLength,
      errors,
    );
  }

  // Final cumulative reviews.
  const reviews = input.reviews;
  if (!isPlainObject(reviews)) {
    errors.push('reviews: must be an object with specReview and codeReview');
  } else {
    rejectUnknownFields(reviews, ['specReview', 'codeReview'], 'reviews', errors);
    const reviewFields: readonly (keyof GpuReviewOutcomes)[] = ['specReview', 'codeReview'];
    for (const field of reviewFields) {
      const record: unknown = reviews[field];
      const recordPath = `reviews.${field}`;
      if (!isPlainObject(record)) {
        errors.push(`${recordPath}: must be an object with a status`);
        continue;
      }
      rejectUnknownFields(record, ['status', 'reviewer'], recordPath, errors);
      validateEnum(record.status, GPU_VERIFICATION_REVIEW_STATUSES, `${recordPath}.status`, errors);
      validateOptionalBoundedString(
        record.reviewer,
        `${recordPath}.reviewer`,
        GPU_VERIFICATION_LIMITS.shortStringLength,
        errors,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: input as unknown as GpuEvidenceManifestV1 };
}
