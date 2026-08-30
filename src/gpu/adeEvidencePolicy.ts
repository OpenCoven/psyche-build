/**
 * GPU ADE acceleration evidence policy — schema v1.
 *
 * This module is the machine-checkable counterpart of the evidence-policy
 * section of `docs/gpu/ADE-EPIC-CHARTER.md` (OpenCoven/psyche-build#228, Bead
 * `psyche-z7c`; canonical outcome gh-199). It defines, as pure deterministic
 * functions and typed constants:
 *
 * - the closed acceleration-evidence vocabulary (`accelerated`, `software`,
 *   `unknown`, `unavailable`),
 * - `classifyRenderer()`, which classifies one renderer probe's facts,
 * - `resolveEvidenceConflict()`, which merges two collectors' classifications,
 * - `mergeEvidenceReports()`, the deterministic native+browser report merge.
 *
 * Deliberate policy decisions (each enforced by the focused tests):
 *
 * - Every value comes from runtime observation. Nothing in this module
 *   defaults, backfills, or infers a field: a field no collector supplied —
 *   or that a collector explicitly declared unsupported — is omitted from the
 *   merged report and named in `omittedFields`, never replaced with a
 *   placeholder.
 * - Conflicting evidence classifies `unknown`. A conflict needs two
 *   affirmative claims; a collector that reports `unknown` (masked or
 *   unsupported probe) provides absence of evidence, not a contradiction.
 * - A successful ordinary WebGL context alone never proves acceleration:
 *   `accelerated` requires a strict (`failIfMajorPerformanceCaveat`) context
 *   or a WebGPU adapter plus renderer evidence that identifies no software
 *   implementation.
 * - The software-marker and hardware-backend token lists are versioned
 *   constants, so marker detection is testable and reproducible.
 * - Engine identity (user agent, WebView family) is reportable as identity
 *   data only; nothing in this module treats it as acceleration evidence.
 *
 * Scope note: this is the epic-level evidence policy for the GPU ADE family.
 * The slice modules that produce or present these reports (stress harness
 * #230, diagnostics surface #231, verification matrix #232) own their own
 * files; this module never reads runtime state, the DOM, or the network.
 */

/** Schema/policy version implemented by this module. */
export const ADE_EVIDENCE_POLICY_VERSION = 1;

/**
 * Closed acceleration-evidence vocabulary. Every classification this policy
 * produces is one of these four values; `unknown` and `unavailable` exist so
 * missing or contradictory evidence is representable without guessing.
 */
export const ADE_ACCELERATION_EVIDENCE = [
  'accelerated',
  'software',
  'unknown',
  'unavailable',
] as const;
export type AdeAccelerationEvidence = (typeof ADE_ACCELERATION_EVIDENCE)[number];

/**
 * Reportable graphics identity fields. Each field is present in a merged
 * report only when a collector observed it; see `mergeEvidenceReports()`.
 */
export const ADE_EVIDENCE_FIELDS = [
  'webviewEngine',
  'webviewVersion',
  'gpuBackend',
  'gpuAdapter',
] as const;
export type AdeEvidenceField = (typeof ADE_EVIDENCE_FIELDS)[number];

/** The two evidence collectors named by the ADE design. */
export const ADE_EVIDENCE_COLLECTORS = ['native', 'browser'] as const;
export type AdeEvidenceCollector = (typeof ADE_EVIDENCE_COLLECTORS)[number];

/**
 * Known software-renderer markers, from the ADE design's tested list,
 * compared case-insensitively as substrings. A match means the rendering
 * path is a software implementation — never classified `accelerated`.
 */
export const ADE_SOFTWARE_RENDER_MARKERS = [
  'swiftshader',
  'llvmpipe',
  'softpipe',
  'software rasterizer',
  'microsoft basic render driver',
] as const;

/**
 * Hardware graphics-backend tokens. A renderer/adapter string that clearly
 * identifies one of these backends is affirmative hardware evidence; it is
 * used only to detect conflicting evidence, never to promote a soft claim.
 */
export const ADE_HARDWARE_BACKEND_TOKENS = [
  'metal',
  'direct3d',
  'vulkan',
  'opengl',
] as const;

/**
 * Closed reason vocabulary returned with every renderer classification, so a
 * caller can audit why a classification was produced without re-deriving it.
 */
export const ADE_RENDERER_CLASSIFICATION_REASONS = [
  'no-usable-context',
  'conflicting-renderer-evidence',
  'software-renderer-markers',
  'strict-context-with-clean-renderer-evidence',
  'webgpu-adapter-with-clean-renderer-evidence',
  'renderer-evidence-masked',
  'probe-unsupported',
] as const;
export type AdeRendererClassificationReason =
  (typeof ADE_RENDERER_CLASSIFICATION_REASONS)[number];

/** One collector's evidence report. Fields exist only when observed. */
export interface AdeEvidenceReportV1 {
  /** Which collector produced this report. */
  readonly collector: AdeEvidenceCollector;
  /**
   * The collector's own acceleration classification, when it could classify.
   * Absence means the collector did not classify — never a hidden verdict.
   */
  readonly acceleration?: AdeAccelerationEvidence;
  /** WebView engine identity (e.g. `WKWebView`, `WebView2`, `WebKitGTK`). */
  readonly webviewEngine?: string;
  /** Engine version, only when a runtime API or unambiguous token supplied it. */
  readonly webviewVersion?: string;
  /** Graphics backend when a renderer string clearly identified it. */
  readonly gpuBackend?: string;
  /** GPU adapter when WebGPU adapter info or unmasked WebGL data supplied it. */
  readonly gpuAdapter?: string;
  /**
   * Reportable fields this collector could not observe (masked, unsupported,
   * or omitted by a degraded collector). A field named here is omitted from
   * the merged report even if the other collector supplies a value: the merge
   * never adjudicates between a masked claim and an observed claim.
   */
  readonly unsupportedFields?: readonly AdeEvidenceField[];
  /** Bounded probe warning (e.g. which field was masked and why). */
  readonly probeWarning?: string;
}

/** Deterministic merge result: evidence-backed fields only, never guesses. */
export interface AdeMergedEvidenceReportV1 {
  /** Policy version of the merge that produced this report. */
  readonly policyVersion: typeof ADE_EVIDENCE_POLICY_VERSION;
  /** Merged acceleration classification (see `resolveEvidenceConflict()`). */
  readonly acceleration: AdeAccelerationEvidence;
  /** Present only when the field rules below kept a value. */
  readonly webviewEngine?: string;
  readonly webviewVersion?: string;
  readonly gpuBackend?: string;
  readonly gpuAdapter?: string;
  /**
   * Reportable fields absent from the merged report because no collector
   * supplied them, a collector declared them unsupported, or their values
   * conflicted. Canonical order, never a guessed placeholder.
   */
  readonly omittedFields: readonly AdeEvidenceField[];
  /** Subset of `omittedFields` where two collectors supplied differing values. */
  readonly conflictedFields: readonly AdeEvidenceField[];
}

/** The raw facts one renderer probe observed. Absence means not observed. */
export interface AdeRendererProbeFacts {
  /**
   * `true` only when a WebGL context was created with
   * `failIfMajorPerformanceCaveat` and succeeded; `false` only when that
   * attempt was made and failed; absent when the probe never ran.
   */
  readonly strictContextCreated?: boolean;
  /** Same contract for a WebGPU adapter request. */
  readonly webgpuAdapterObtained?: boolean;
  /** Unmasked WebGL renderer string (`UNMASKED_RENDERER_WEBGL`), when exposed. */
  readonly rendererString?: string;
  /** WebGPU adapter identity string, when adapter info is available. */
  readonly adapterString?: string;
}

/** One classification outcome with its auditable reason token. */
export interface AdeRendererClassification {
  readonly acceleration: AdeAccelerationEvidence;
  readonly reason: AdeRendererClassificationReason;
}

function observedValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim() === '' ? undefined : value;
}

function lowercase(value: string | undefined): string | undefined {
  const observed = observedValue(value);
  return observed === undefined ? undefined : observed.toLowerCase();
}

/**
 * Return the software-renderer markers contained in `value`, in canonical
 * list order, deduplicated. Empty or absent input yields an empty list —
 * never an inferred marker.
 */
export function detectSoftwareMarkers(value: string | undefined): string[] {
  const haystack = lowercase(value);
  if (haystack === undefined) {
    return [];
  }
  return ADE_SOFTWARE_RENDER_MARKERS.filter((marker) => haystack.includes(marker));
}

/**
 * Return the hardware-backend tokens contained in `value`, in canonical list
 * order, deduplicated. Empty or absent input yields an empty list.
 */
export function detectHardwareBackendTokens(value: string | undefined): string[] {
  const haystack = lowercase(value);
  if (haystack === undefined) {
    return [];
  }
  return ADE_HARDWARE_BACKEND_TOKENS.filter((token) => haystack.includes(token));
}

/**
 * True when the two probe strings conflict: one string matches a software
 * marker while the other, marker-free, affirmatively identifies a hardware
 * backend. Marker and backend token inside the same string is not a conflict
 * (the marker identifies the whole renderer); conflicting *strings* are,
 * because this policy refuses to pick a winner.
 */
function probeStringsConflict(
  rendererString: string | undefined,
  adapterString: string | undefined,
): boolean {
  const rendererMarkers = detectSoftwareMarkers(rendererString);
  const adapterMarkers = detectSoftwareMarkers(adapterString);
  if (rendererMarkers.length > 0 && adapterMarkers.length === 0) {
    if (detectHardwareBackendTokens(adapterString).length > 0) {
      return true;
    }
  }
  if (adapterMarkers.length > 0 && rendererMarkers.length === 0) {
    if (detectHardwareBackendTokens(rendererString).length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Classify one renderer probe deterministically. Decision order:
 *
 * 1. both context probes conclusively failed → `unavailable`;
 * 2. one probe string matches a software marker while the other affirmatively
 *    identifies a hardware backend → `unknown` (conflict, never a guess);
 * 3. any software marker → `software`, even with a successful strict context;
 * 4. a strict context or WebGPU adapter succeeded → `accelerated` only with
 *    available renderer evidence, otherwise `unknown` (masked evidence);
 * 5. otherwise → `unknown` (probe unsupported or never produced a verdict).
 */
export function classifyRenderer(facts: AdeRendererProbeFacts): AdeRendererClassification {
  if (facts.strictContextCreated === false && facts.webgpuAdapterObtained === false) {
    return { acceleration: 'unavailable', reason: 'no-usable-context' };
  }

  const rendererString = observedValue(facts.rendererString);
  const adapterString = observedValue(facts.adapterString);

  if (probeStringsConflict(rendererString, adapterString)) {
    return { acceleration: 'unknown', reason: 'conflicting-renderer-evidence' };
  }

  const markers = [...detectSoftwareMarkers(rendererString), ...detectSoftwareMarkers(adapterString)];
  if (markers.length > 0) {
    return { acceleration: 'software', reason: 'software-renderer-markers' };
  }

  const hasContextEvidence =
    facts.strictContextCreated === true || facts.webgpuAdapterObtained === true;
  if (hasContextEvidence) {
    if (rendererString !== undefined || adapterString !== undefined) {
      return {
        acceleration: 'accelerated',
        reason:
          facts.strictContextCreated === true
            ? 'strict-context-with-clean-renderer-evidence'
            : 'webgpu-adapter-with-clean-renderer-evidence',
      };
    }
    return { acceleration: 'unknown', reason: 'renderer-evidence-masked' };
  }

  return { acceleration: 'unknown', reason: 'probe-unsupported' };
}

/**
 * Resolve two collectors' acceleration classifications into one.
 *
 * Decision table (symmetric in its arguments, deterministic):
 *
 * - both affirmative and equal → that value;
 * - both affirmative and different → `unknown` (conflict; no tie-breaking);
 * - exactly one affirmative, the other `unknown` or absent → the affirmative
 *   value stands: `unknown` is absence of evidence, not a contradiction, and
 *   a masked field is omitted by the field rules rather than flipping the
 *   classification;
 * - otherwise → `unknown`: with no affirmative evidence on either side the
 *   merge classifies `unknown` and never guesses.
 *
 * `accelerated`, `software`, and `unavailable` are affirmative claims; the
 * value `unknown` (like `undefined`) reports that this collector could not
 * classify, so it never wins a merge and never manufactures a conflict.
 */
export function resolveEvidenceConflict(
  native: AdeAccelerationEvidence | undefined,
  browser: AdeAccelerationEvidence | undefined,
): AdeAccelerationEvidence {
  const affirmative = (value: AdeAccelerationEvidence | undefined): value is Exclude<AdeAccelerationEvidence, 'unknown'> =>
    value !== undefined && value !== 'unknown';
  const nativeAffirmative = affirmative(native);
  const browserAffirmative = affirmative(browser);
  if (nativeAffirmative && browserAffirmative) {
    return native === browser ? native : 'unknown';
  }
  if (nativeAffirmative) {
    return native;
  }
  if (browserAffirmative) {
    return browser;
  }
  return 'unknown';
}

const CANONICAL_FIELD_ORDER: readonly AdeEvidenceField[] = ADE_EVIDENCE_FIELDS;

function canonicalFieldOrder(fields: Iterable<AdeEvidenceField>): AdeEvidenceField[] {
  const present = new Set(fields);
  return CANONICAL_FIELD_ORDER.filter((field) => present.has(field));
}

/**
 * Deterministically merge the native and browser evidence reports into one
 * merged startup/runtime report.
 *
 * Field rules, applied per reportable field in canonical order:
 *
 * - A value a collector supplied is kept only if it is non-empty and the
 *   collector did not declare the field unsupported. Empty strings are
 *   treated as "not supplied" — never as a value.
 * - If either collector declares the field unsupported, the field is omitted
 *   from the merged report (and named in `omittedFields`), even when the
 *   other collector supplies a value.
 * - If both collectors supply the field and the values differ, the field is
 *   omitted and named in both `omittedFields` and `conflictedFields`.
 * - If exactly one collector supplies the field, that observed value is kept.
 * - If neither supplies it, the field is omitted from the output object
 *   entirely: the merge introduces no fields of its own.
 *
 * The acceleration classification comes from `resolveEvidenceConflict()` over
 * the two collectors' own classifications. Inputs are never mutated.
 */
export function mergeEvidenceReports(
  native: AdeEvidenceReportV1,
  browser: AdeEvidenceReportV1,
): AdeMergedEvidenceReportV1 {
  const reports: readonly AdeEvidenceReportV1[] = [native, browser];

  const omitted = new Set<AdeEvidenceField>();
  const conflicted = new Set<AdeEvidenceField>();
  const merged: {
    policyVersion: typeof ADE_EVIDENCE_POLICY_VERSION;
    acceleration: AdeAccelerationEvidence;
    webviewEngine?: string;
    webviewVersion?: string;
    gpuBackend?: string;
    gpuAdapter?: string;
    omittedFields: readonly AdeEvidenceField[];
    conflictedFields: readonly AdeEvidenceField[];
  } = {
    policyVersion: ADE_EVIDENCE_POLICY_VERSION,
    acceleration: resolveEvidenceConflict(native.acceleration, browser.acceleration),
    omittedFields: [],
    conflictedFields: [],
  };

  for (const field of CANONICAL_FIELD_ORDER) {
    const declaredUnsupported = reports.some(
      (report) => report.unsupportedFields?.includes(field) === true,
    );
    const supplied: string[] = [];
    for (const report of reports) {
      if (declaredUnsupported) {
        continue;
      }
      const value = observedValue(report[field]);
      if (value !== undefined) {
        supplied.push(value);
      }
    }

    if (declaredUnsupported) {
      omitted.add(field);
      continue;
    }
    if (supplied.length === 0) {
      omitted.add(field);
      continue;
    }
    if (supplied.length === 2 && supplied[0] !== supplied[1]) {
      omitted.add(field);
      conflicted.add(field);
      continue;
    }
    merged[field] = supplied[0];
  }

  merged.omittedFields = canonicalFieldOrder(omitted);
  merged.conflictedFields = canonicalFieldOrder(conflicted);
  return merged;
}
