/**
 * GPU rendering stress harness — scenario and authorization contract, schema v1.
 *
 * This module is the machine-checkable counterpart of
 * `docs/gpu/STRESS-HARNESS-CONTRACT.md`. It defines, as typed constants and
 * pure functions:
 *
 * - the closed native fixture enum (`steady`, `burst`, `rewrite`),
 * - the deterministic 1/6/12/24-pane scenario definitions with the exact
 *   10 s warmup / 30 s measured / 5 s restore-and-context-loss phase timing,
 * - `authorizeStressRun()`, which requires an explicit debug-build flag AND a
 *   startup-environment authorization token — both or nothing,
 * - `validateScenarioRequest()` and `validateFixtureSelection()`, which accept
 *   only the fixed enums and known pane counts and reject arbitrary commands
 *   and parameters with typed rejection codes,
 * - the deterministic phase-transition table, and
 * - the cancellation cleanup plan and its closed set of cleanup states.
 *
 * Deliberate contract decisions:
 *
 * - Pure and dependency-free. No timers, no processes, no `process.env`
 *   reads: the startup authorization value is captured once by the caller and
 *   passed in, so authorization decisions are reproducible and testable.
 * - Closed vocabularies everywhere. Unknown scenarios, unknown pane counts,
 *   unknown fixtures, unknown events, unknown cleanup steps, and unknown
 *   fields are rejected with typed codes instead of being coerced.
 * - Command-shaped input is rejected with a dedicated
 *   `arbitrary-command-rejected` code: the harness spawns only the fixed
 *   native fixtures selected by name, never a caller-supplied command string.
 * - Nothing here claims physical graphics acceleration. The stress harness
 *   exercises rendering paths and produces measurements; acceleration
 *   classification is owned by the graphics probe and the verification matrix
 *   (`docs/gpu/VERIFICATION-MATRIX.md`, issue #232) on physical hardware.
 * - No CSP or capability expansion is required or performed by this contract;
 *   it is data, not a runtime surface.
 *
 * Scope note: this slice ships the contract, the deterministic tables, and
 * their tests. The runtime wiring (native spawn command, launcher script, and
 * in-app surface) belongs to the dependent diagnostics-surface slice (#231
 * chain) and is intentionally not implemented here.
 */

/** Schema version implemented by this module. */
export const GPU_STRESS_HARNESS_SCHEMA_VERSION = 1;

/**
 * Startup environment variable that must hold the authorization token at
 * process start. The value is captured once at startup and passed to
 * `authorizeStressRun()`; it is never read lazily from `process.env`.
 */
export const GPU_STRESS_STARTUP_ENV_VAR = 'PSYCHE_RENDER_DIAGNOSTICS';

/**
 * Closed native fixture enum. The native diagnostics spawn surface accepts
 * exactly these fixture names — never a command string, executable path, or
 * argument list. Each fixture is a fixed platform-native pattern that emits
 * sequence numbers and ANSI output until stopped:
 *
 * - `steady`: constant-rate output at a fixed pace,
 * - `burst`: fixed-size output bursts at a fixed duty cycle,
 * - `rewrite`: repeated in-place line rewrites of a fixed-width region.
 */
export const GPU_STRESS_FIXTURES = ['steady', 'burst', 'rewrite'] as const;
export type GpuStressFixture = (typeof GPU_STRESS_FIXTURES)[number];

/** Known stress scenarios, in execution order by pane count. */
export const GPU_STRESS_SCENARIO_IDS = [
  'panes-1',
  'panes-6',
  'panes-12',
  'panes-24',
] as const;
export type GpuStressScenarioId = (typeof GPU_STRESS_SCENARIO_IDS)[number];

/** Known pane counts, aligned one-to-one with the scenario ids. */
export const GPU_STRESS_PANE_COUNTS = [1, 6, 12, 24] as const;
export type GpuStressPaneCount = (typeof GPU_STRESS_PANE_COUNTS)[number];

/** Closed phase vocabulary for every scenario. */
export const GPU_STRESS_PHASES = ['warmup', 'measured', 'restore-context-loss'] as const;
export type GpuStressPhase = (typeof GPU_STRESS_PHASES)[number];

/**
 * Phase timing, identical for every scenario and pinned by the acceptance
 * criteria: 10 s warmup, 30 s measured interval, 5 s restore/context-loss
 * interval — 45 s per scenario.
 */
export const GPU_STRESS_PHASE_TIMING_MS: Readonly<Record<GpuStressPhase, number>> = {
  warmup: 10_000,
  measured: 30_000,
  'restore-context-loss': 5_000,
};

/** Total duration of one scenario, in milliseconds (10 + 30 + 5 seconds). */
export const GPU_STRESS_SCENARIO_DURATION_MS =
  GPU_STRESS_PHASE_TIMING_MS.warmup +
  GPU_STRESS_PHASE_TIMING_MS.measured +
  GPU_STRESS_PHASE_TIMING_MS['restore-context-loss'];

/** Closed transition-event vocabulary for the phase-transition table. */
export const GPU_STRESS_TRANSITION_EVENTS = [
  'create-surfaces',
  'begin-churn',
  'hide-panes',
  'minimize-window',
  'restore-window',
  'begin-context-loss',
  'dispose-all',
] as const;
export type GpuStressTransitionEvent = (typeof GPU_STRESS_TRANSITION_EVENTS)[number];

/**
 * Closed cancellation-cleanup-step vocabulary, in required execution order
 * (reverse acquisition order): churn timers and native fixtures stop first,
 * window state is restored, hidden panes are unhidden, then the acquired
 * surfaces are torn down last-to-first. Every cancelled or completed run must
 * end with every step `disposed`.
 */
export const GPU_STRESS_CLEANUP_STEPS = [
  'stop-focus-geometry-churn',
  'stop-native-fixtures',
  'restore-window-state',
  'unhide-panes',
  'close-local-browser-page',
  'dispose-editor-document',
  'close-terminal-panes',
] as const;
export type GpuStressCleanupStep = (typeof GPU_STRESS_CLEANUP_STEPS)[number];

/** Closed cleanup-state vocabulary for each cancellation-cleanup step. */
export const GPU_STRESS_CLEANUP_STATUSES = ['pending', 'disposed', 'failed'] as const;
export type GpuStressCleanupStatus = (typeof GPU_STRESS_CLEANUP_STATUSES)[number];

/** Closed rejection-code vocabulary returned by every validator. */
export const GPU_STRESS_REJECTION_CODES = [
  'missing-debug-build',
  'missing-startup-authorization',
  'invalid-startup-authorization',
  'unsupported-schema-version',
  'unknown-scenario',
  'unknown-pane-count',
  'conflicting-scenario-selection',
  'unknown-fixture',
  'arbitrary-command-rejected',
  'malformed-request',
  'unknown-field',
  'missing-cleanup-step',
  'unknown-cleanup-step',
  'cleanup-incomplete',
  'cleanup-failed',
] as const;
export type GpuStressRejectionCode = (typeof GPU_STRESS_REJECTION_CODES)[number];

/** Closed adjacency order of the surfaces every scenario creates. */
export const GPU_STRESS_SURFACE_ADJACENCY = [
  'editor-document',
  'terminal-panes',
  'local-browser-page',
] as const;
export type GpuStressSurface = (typeof GPU_STRESS_SURFACE_ADJACENCY)[number];

/** How hidden panes are selected, deterministically, within a scenario. */
export const GPU_STRESS_HIDDEN_PANE_SELECTION = 'odd-index' as const;

/** Churn and lifecycle constants shared by every scenario. */
export const GPU_STRESS_CHURN = {
  /** Focus cycles to the next pane every 250 ms during the measured phase. */
  focusIntervalMs: 250,
  /** Split/sidebar geometry churns on every animation frame while measured. */
  geometryChurn: 'per-frame',
  /** Exactly half of the panes are hidden during the measured interval. */
  hiddenPaneFraction: 0.5,
  /** Hidden-pane selection rule (1-based odd indexes: panes 1, 3, 5, ...). */
  hiddenPaneSelection: GPU_STRESS_HIDDEN_PANE_SELECTION,
  /** Window minimize fires 30 s into the scenario, inside the measured phase. */
  minimizeOffsetMs: 30_000,
  /** Window restore fires 35 s into the scenario, inside the measured phase. */
  restoreOffsetMs: 35_000,
} as const;

/** Structural limits enforced by the validators below. */
export const GPU_STRESS_LIMITS = {
  /** Required `schemaVersion`. */
  schemaVersion: GPU_STRESS_HARNESS_SCHEMA_VERSION,
  /** Known pane counts; any other count is rejected. */
  paneCounts: GPU_STRESS_PANE_COUNTS.length,
  /** Fixed native fixtures. */
  fixtures: GPU_STRESS_FIXTURES.length,
  /** Deterministic scenarios per plan. */
  scenarios: GPU_STRESS_SCENARIO_IDS.length,
  /** Total duration of one scenario, in milliseconds. */
  maxScenarioDurationMs: 45_000,
} as const;

/** One typed rejection: a closed-vocabulary code plus a bounded message. */
export interface GpuStressRejection {
  readonly code: GpuStressRejectionCode;
  readonly message: string;
}

/** Authorization decision: either authorized or a bounded rejection list. */
export type GpuStressAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejections: readonly GpuStressRejection[] };

/** A validated v1 scenario request. */
export interface GpuStressScenarioRequestV1 {
  readonly schemaVersion: typeof GPU_STRESS_HARNESS_SCHEMA_VERSION;
  /** Scenario selected by id, e.g. `panes-6`. */
  readonly scenarioId: GpuStressScenarioId;
  /** Scenario selected by pane count; always agrees with `scenarioId`. */
  readonly paneCount: GpuStressPaneCount;
}

/** Strict validation result shared by the request/fixture/cleanup validators. */
export type GpuStressValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejections: readonly GpuStressRejection[] };

/** Phase segment of a scenario: closed phase name plus exact timing. */
export interface GpuStressPhaseWindow {
  readonly phase: GpuStressPhase;
  readonly startOffsetMs: number;
  readonly durationMs: number;
}

/** Churn, lifecycle, and surface constants shared by every scenario. */
export interface GpuStressScenarioChurn {
  /** Focus churn cadence in milliseconds. */
  readonly focusIntervalMs: number;
  /** Geometry churn mode; `per-frame` while the measured phase is active. */
  readonly geometryChurn: 'per-frame' | 'none';
  /** Fraction of panes hidden during the measured phase (0.5 = half). */
  readonly hiddenPaneFraction: number;
  /** Deterministic selection rule for which panes are hidden. */
  readonly hiddenPaneSelection: typeof GPU_STRESS_HIDDEN_PANE_SELECTION;
  /** Scenario offset of the window minimize transition. */
  readonly minimizeOffsetMs: number;
  /** Scenario offset of the window restore transition. */
  readonly restoreOffsetMs: number;
}

/** Surfaces each scenario creates, in deterministic adjacency order. */
export interface GpuStressScenarioSurfaces {
  /** Adjacency order: editor document, terminal panes, local browser page. */
  readonly adjacency: readonly GpuStressSurface[];
  /** The editor document is a generated large document, never user content. */
  readonly editorDocument: 'generated-large-document';
  /** A local diagnostics browser page sits adjacent to the terminal panes. */
  readonly localBrowserPage: true;
}

/** One deterministic stress scenario (schema v1). */
export interface GpuStressScenarioV1 {
  readonly id: GpuStressScenarioId;
  readonly paneCount: number;
  readonly totalDurationMs: number;
  readonly phases: readonly GpuStressPhaseWindow[];
  readonly churn: GpuStressScenarioChurn;
  readonly surfaces: GpuStressScenarioSurfaces;
}

/** One row of the deterministic phase-transition table. */
export interface GpuStressPhaseTransition {
  /** Scenario offset at which this transition fires. */
  readonly atMs: number;
  /** Phase before the transition (`idle` before the first). */
  readonly from: GpuStressPhase | 'idle';
  /** Phase after the transition (`idle` after final dispose). */
  readonly to: GpuStressPhase | 'idle';
  /** Closed-vocabulary event performed by this transition. */
  readonly event: GpuStressTransitionEvent;
}

/** A completed cancellation-cleanup outcome for one cancelled scenario run. */
export interface GpuStressCleanupOutcomeV1 {
  readonly schemaVersion: typeof GPU_STRESS_HARNESS_SCHEMA_VERSION;
  readonly scenarioId: GpuStressScenarioId;
  readonly steps: ReadonlyArray<{
    readonly step: GpuStressCleanupStep;
    readonly status: GpuStressCleanupStatus;
  }>;
}

/** Internal: narrow an unknown value to a plain JSON object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard over the closed fixture enum. */
function isFixture(value: unknown): value is GpuStressFixture {
  return typeof value === 'string' && (GPU_STRESS_FIXTURES as readonly string[]).includes(value);
}

/** Type guard over the closed scenario-id enum. */
function isScenarioId(value: unknown): value is GpuStressScenarioId {
  return typeof value === 'string' && (GPU_STRESS_SCENARIO_IDS as readonly string[]).includes(value);
}

/** Type guard over the known pane counts. */
function isPaneCount(value: unknown): value is GpuStressPaneCount {
  return (
    typeof value === 'number' && Number.isInteger(value) && (GPU_STRESS_PANE_COUNTS as readonly number[]).includes(value)
  );
}

/** Total scenario-id → pane-count map (both directions stay closed). */
const PANE_COUNT_BY_SCENARIO: Record<GpuStressScenarioId, GpuStressPaneCount> = {
  'panes-1': 1,
  'panes-6': 6,
  'panes-12': 12,
  'panes-24': 24,
};

/** Total pane-count → scenario-id map (the inverse of the above). */
const SCENARIO_BY_PANE_COUNT: Record<GpuStressPaneCount, GpuStressScenarioId> = {
  1: 'panes-1',
  6: 'panes-6',
  12: 'panes-12',
  24: 'panes-24',
};

/**
 * True when a string looks like an attempted command rather than a fixture
 * name: shell metacharacters, path separators, quotes, whitespace, or leading
 * `--` flags all classify as command-shaped. Deliberately over-inclusive —
 * arbitrary input must fail closed.
 */
function isCommandShaped(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  return /[;&|`$<>\n\r\\/"']|--|\s/u.test(value);
}

/** Resolve a scenario id to its known pane count; unknown ids get `null`. */
export function paneCountForScenario(scenarioId: string): GpuStressPaneCount | null {
  return isScenarioId(scenarioId) ? PANE_COUNT_BY_SCENARIO[scenarioId] : null;
}

/** Resolve a pane count to its known scenario id; unknown counts get `null`. */
export function scenarioIdForPaneCount(paneCount: number): GpuStressScenarioId | null {
  return isPaneCount(paneCount) ? SCENARIO_BY_PANE_COUNT[paneCount] : null;
}

/** Immutable per-scenario phase plan, derived from the pinned timing. */
const PHASE_PLAN: readonly GpuStressPhaseWindow[] = [
  { phase: 'warmup', startOffsetMs: 0, durationMs: GPU_STRESS_PHASE_TIMING_MS.warmup },
  {
    phase: 'measured',
    startOffsetMs: GPU_STRESS_PHASE_TIMING_MS.warmup,
    durationMs: GPU_STRESS_PHASE_TIMING_MS.measured,
  },
  {
    phase: 'restore-context-loss',
    startOffsetMs: GPU_STRESS_PHASE_TIMING_MS.warmup + GPU_STRESS_PHASE_TIMING_MS.measured,
    durationMs: GPU_STRESS_PHASE_TIMING_MS['restore-context-loss'],
  },
];

/**
 * Build the four deterministic stress scenarios. Pure: every call returns a
 * deep-equal structure in the same execution order `[1, 6, 12, 24]` panes.
 */
export function buildStressScenarios(): GpuStressScenarioV1[] {
  return GPU_STRESS_PANE_COUNTS.map((paneCount, index) => ({
    id: GPU_STRESS_SCENARIO_IDS[index],
    paneCount,
    totalDurationMs: GPU_STRESS_LIMITS.maxScenarioDurationMs,
    phases: PHASE_PLAN.map((phase) => ({ ...phase })),
    churn: { ...GPU_STRESS_CHURN },
    surfaces: {
      adjacency: [...GPU_STRESS_SURFACE_ADJACENCY],
      editorDocument: 'generated-large-document' as const,
      localBrowserPage: true as const,
    },
  }));
}

/** Resolve a scenario id to its definition; unknown ids return `null`. */
export function findScenario(scenarioId: string): GpuStressScenarioV1 | null {
  const index = (GPU_STRESS_SCENARIO_IDS as readonly string[]).indexOf(scenarioId);
  if (index < 0) {
    return null;
  }
  return buildStressScenarios()[index];
}

/**
 * Native fixture assigned to a terminal pane: panes cycle through the closed
 * fixture enum in declaration order (`steady`, `burst`, `rewrite`) by
 * zero-based pane index, so every scenario exercises all three fixtures
 * deterministically.
 */
export function assignPaneFixture(paneIndex: number): GpuStressFixture {
  if (!Number.isInteger(paneIndex) || paneIndex < 0) {
    throw new Error('pane index must be a non-negative integer');
  }
  return GPU_STRESS_FIXTURES[paneIndex % GPU_STRESS_FIXTURES.length];
}

/**
 * Build the deterministic phase-transition table for one scenario.
 *
 * The table is identical for every scenario (the pane count changes the
 * workload, never the timing): surfaces are created at 0 ms, churn begins at
 * the 10 s measured boundary, half the panes are hidden at 15 s, the window
 * is minimized at 30 s and restored at 35 s, context loss begins at the 40 s
 * restore boundary (churn stops), and everything is disposed at 45 s.
 */
export function buildPhaseTransitionTable(
  scenarioId: GpuStressScenarioId,
): GpuStressPhaseTransition[] {
  if (paneCountForScenario(scenarioId) === null) {
    throw new Error(`unknown scenario id: ${scenarioId}`);
  }
  return [
    { atMs: 0, from: 'idle', to: 'warmup', event: 'create-surfaces' },
    { atMs: 10_000, from: 'warmup', to: 'measured', event: 'begin-churn' },
    { atMs: 15_000, from: 'measured', to: 'measured', event: 'hide-panes' },
    { atMs: 30_000, from: 'measured', to: 'measured', event: 'minimize-window' },
    { atMs: 35_000, from: 'measured', to: 'measured', event: 'restore-window' },
    { atMs: 40_000, from: 'measured', to: 'restore-context-loss', event: 'begin-context-loss' },
    { atMs: 45_000, from: 'restore-context-loss', to: 'idle', event: 'dispose-all' },
  ];
}

/**
 * Extract the startup authorization token from an environment map captured
 * once at process start. Returns `null` when the variable is absent so the
 * caller can pass the result straight to `authorizeStressRun()`.
 */
export function startupAuthorizationTokenFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const value = environment[GPU_STRESS_STARTUP_ENV_VAR];
  return typeof value === 'string' ? value : null;
}

/**
 * Authorize a stress run.
 *
 * Both inputs are required — an explicit debug-build flag AND the startup
 * environment authorization token (the exact `PSYCHE_RENDER_DIAGNOSTICS`
 * value captured at process start, which must be exactly `"1"`). Missing
 * either — including a production (non-debug) build that somehow carries the
 * token — is rejected with typed codes, mirroring the native
 * `stress_authorized_for` semantics where only
 * `debug_build && startup_value == "1"` authorizes. When both facts are
 * missing, both rejections are reported so operators see the full picture.
 */
export function authorizeStressRun(input: {
  debugBuild: unknown;
  startupAuthorizationToken: unknown;
}): GpuStressAuthorization {
  const rejections: GpuStressRejection[] = [];

  if (typeof input?.debugBuild !== 'boolean') {
    rejections.push({
      code: 'missing-debug-build',
      message: 'stress rendering requires an explicit debug-build flag; production builds are never authorized',
    });
  } else if (!input.debugBuild) {
    rejections.push({
      code: 'missing-debug-build',
      message: 'stress rendering is authorized in debug builds only; production context rejected',
    });
  }

  const token = input?.startupAuthorizationToken;
  if (token === null || token === undefined) {
    rejections.push({
      code: 'missing-startup-authorization',
      message: `stress rendering requires the startup environment authorization token ${GPU_STRESS_STARTUP_ENV_VAR}=1 captured at process start`,
    });
  } else if (token !== '1') {
    rejections.push({
      code: 'invalid-startup-authorization',
      message: `${GPU_STRESS_STARTUP_ENV_VAR} must be exactly "1" at startup; any other value is rejected`,
    });
  }

  if (rejections.length > 0) {
    return { ok: false, rejections };
  }
  return { ok: true };
}

const KNOWN_REQUEST_FIELDS = ['schemaVersion', 'scenarioId', 'paneCount'] as const;

/**
 * Object fields that mark an input as an attempted command description.
 * The native harness never executes caller-supplied commands, so any object
 * carrying one of these keys is rejected outright.
 */
const COMMAND_DESCRIPTION_KEYS = [
  'command',
  'exe',
  'executable',
  'argv',
  'args',
  'script',
] as const;

/**
 * Validate a native fixture selection. Only the closed enum members
 * `steady`, `burst`, and `rewrite` are accepted. Command-shaped strings and
 * objects carrying command/executable fields are rejected with the dedicated
 * `arbitrary-command-rejected` code — the native harness never executes a
 * caller-supplied command.
 */
export function validateFixtureSelection(input: unknown): GpuStressValidation<GpuStressFixture> {
  if (typeof input === 'string') {
    if (isFixture(input)) {
      return { ok: true, value: input };
    }
    if (isCommandShaped(input)) {
      return {
        ok: false,
        rejections: [
          {
            code: 'arbitrary-command-rejected',
            message: `fixture selection must be one of ${GPU_STRESS_FIXTURES.join(', ')}; command-like input is never executed`,
          },
        ],
      };
    }
    return {
      ok: false,
      rejections: [
        {
          code: 'unknown-fixture',
          message: `fixture must be one of ${GPU_STRESS_FIXTURES.join(', ')}`,
        },
      ],
    };
  }
  if (isPlainObject(input)) {
    const keys = Object.keys(input);
    if (keys.some((key) => (COMMAND_DESCRIPTION_KEYS as readonly string[]).includes(key))) {
      return {
        ok: false,
        rejections: [
          {
            code: 'arbitrary-command-rejected',
            message: 'fixture selection accepts only the fixed enum; command-shaped fields are rejected',
          },
        ],
      };
    }
  }
  return {
    ok: false,
    rejections: [
      {
        code: 'malformed-request',
        message: 'fixture selection must be one of the fixed fixture names',
      },
    ],
  };
}

/**
 * Validate an unknown value as a v1 stress scenario request.
 *
 * Accepts only `{ schemaVersion: 1 }` plus a known `scenarioId`, a known
 * `paneCount`, or both in agreement. Unknown fields, unknown scenarios,
 * unknown pane counts, and schema drift are rejected with typed codes.
 */
export function validateScenarioRequest(
  input: unknown,
): GpuStressValidation<GpuStressScenarioRequestV1> {
  const rejections: GpuStressRejection[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      rejections: [{ code: 'malformed-request', message: 'scenario request must be a JSON object' }],
    };
  }

  for (const key of Object.keys(input)) {
    if (!(KNOWN_REQUEST_FIELDS as readonly string[]).includes(key)) {
      rejections.push({ code: 'unknown-field', message: `unknown scenario request field "${key}"` });
    }
  }

  if (input.schemaVersion !== GPU_STRESS_LIMITS.schemaVersion) {
    rejections.push({
      code: 'unsupported-schema-version',
      message: `schemaVersion must be ${GPU_STRESS_LIMITS.schemaVersion}`,
    });
  }

  const hasScenarioId = input.scenarioId !== undefined && input.scenarioId !== null;
  const hasPaneCount = input.paneCount !== undefined && input.paneCount !== null;
  let scenarioId: GpuStressScenarioId | undefined;
  let paneCount: GpuStressPaneCount | undefined;

  if (hasScenarioId) {
    if (!isScenarioId(input.scenarioId)) {
      rejections.push({
        code: 'unknown-scenario',
        message: `scenarioId must be one of ${GPU_STRESS_SCENARIO_IDS.join(', ')}`,
      });
    } else {
      scenarioId = input.scenarioId;
    }
  }

  if (hasPaneCount) {
    if (!isPaneCount(input.paneCount)) {
      rejections.push({
        code: 'unknown-pane-count',
        message: `paneCount must be one of ${GPU_STRESS_PANE_COUNTS.join(', ')}`,
      });
    } else {
      paneCount = input.paneCount;
    }
  }

  if (!hasScenarioId && !hasPaneCount) {
    rejections.push({
      code: 'malformed-request',
      message: 'scenario request must include scenarioId, paneCount, or both',
    });
  }

  if (scenarioId !== undefined && paneCount !== undefined && paneCountForScenario(scenarioId) !== paneCount) {
    rejections.push({
      code: 'conflicting-scenario-selection',
      message: `scenarioId ${scenarioId} does not correspond to paneCount ${paneCount}`,
    });
  }

  if (rejections.length > 0) {
    return { ok: false, rejections };
  }

  // Both-absent is rejected above, and any pair present must agree (checked
  // above), so whichever half is missing is derived from the present half.
  const resolvedScenarioId = scenarioId ?? SCENARIO_BY_PANE_COUNT[paneCount as GpuStressPaneCount];
  const resolvedPaneCount = paneCount ?? PANE_COUNT_BY_SCENARIO[resolvedScenarioId];

  return {
    ok: true,
    value: {
      schemaVersion: GPU_STRESS_HARNESS_SCHEMA_VERSION,
      scenarioId: resolvedScenarioId,
      paneCount: resolvedPaneCount,
    },
  };
}

/**
 * Build the cancellation-cleanup plan for a scenario: the full ordered step
 * list in its initial `pending` state. The plan is identical no matter when
 * the run is cancelled — cleanup always disposes every acquired resource.
 */
export function buildCancellationCleanupPlan(
  scenarioId: GpuStressScenarioId,
): GpuStressCleanupOutcomeV1 {
  return {
    schemaVersion: GPU_STRESS_HARNESS_SCHEMA_VERSION,
    scenarioId,
    steps: GPU_STRESS_CLEANUP_STEPS.map((step) => ({ step, status: 'pending' as const })),
  };
}

const KNOWN_CLEANUP_OUTCOME_FIELDS = ['schemaVersion', 'scenarioId', 'steps'] as const;

/**
 * Validate a completed cancellation-cleanup outcome. Every cleanup step must
 * appear exactly once and be `disposed`; `pending` steps mean the harness
 * leaked a resource, `failed` steps fail closed, and unknown or missing steps
 * are structural violations.
 */
export function validateCancellationCleanupOutcome(
  input: unknown,
): GpuStressValidation<GpuStressCleanupOutcomeV1> {
  const rejections: GpuStressRejection[] = [];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      rejections: [{ code: 'malformed-request', message: 'cleanup outcome must be a JSON object' }],
    };
  }

  for (const key of Object.keys(input)) {
    if (!(KNOWN_CLEANUP_OUTCOME_FIELDS as readonly string[]).includes(key)) {
      rejections.push({ code: 'unknown-field', message: `unknown cleanup outcome field "${key}"` });
    }
  }

  if (input.schemaVersion !== GPU_STRESS_HARNESS_SCHEMA_VERSION) {
    rejections.push({
      code: 'unsupported-schema-version',
      message: `schemaVersion must be ${GPU_STRESS_HARNESS_SCHEMA_VERSION}`,
    });
  }

  const scenarioId = input.scenarioId;
  if (
    typeof scenarioId !== 'string' ||
    !(GPU_STRESS_SCENARIO_IDS as readonly string[]).includes(scenarioId)
  ) {
    rejections.push({
      code: 'unknown-scenario',
      message: `scenarioId must be one of ${GPU_STRESS_SCENARIO_IDS.join(', ')}`,
    });
  }

  const steps = input.steps;
  if (!Array.isArray(steps)) {
    rejections.push({ code: 'malformed-request', message: 'steps must be an array' });
  } else {
    const seen = new Set<string>();
    steps.forEach((entry, index) => {
      const path = `steps[${index}]`;
      if (!isPlainObject(entry)) {
        rejections.push({ code: 'malformed-request', message: `${path} must be an object` });
        return;
      }
      const step: unknown = entry.step;
      const status: unknown = entry.status;
      for (const key of Object.keys(entry)) {
        if (key !== 'step' && key !== 'status') {
          rejections.push({ code: 'unknown-field', message: `${path}.${key} is not a known field` });
        }
      }
      if (typeof step !== 'string' || !(GPU_STRESS_CLEANUP_STEPS as readonly string[]).includes(step)) {
        rejections.push({
          code: 'unknown-cleanup-step',
          message: `${path}.step is not a known cleanup step`,
        });
        return;
      }
      if (seen.has(step)) {
        rejections.push({
          code: 'unknown-cleanup-step',
          message: `${path}.step duplicates step ${step}`,
        });
        return;
      }
      seen.add(step);
      if (status === 'pending') {
        rejections.push({
          code: 'cleanup-incomplete',
          message: `${path}.status is pending; a cancelled run must dispose every acquired resource`,
        });
      } else if (status === 'failed') {
        rejections.push({
          code: 'cleanup-failed',
          message: `${path}.status is failed; a cancelled run must not leave failed cleanup behind`,
        });
      } else if (status !== 'disposed') {
        rejections.push({
          code: 'malformed-request',
          message: `${path}.status must be one of ${GPU_STRESS_CLEANUP_STATUSES.join(', ')}`,
        });
      }
    });
    for (const step of GPU_STRESS_CLEANUP_STEPS) {
      if (!seen.has(step)) {
        rejections.push({
          code: 'missing-cleanup-step',
          message: `cleanup step ${step} is missing from the outcome`,
        });
      }
    }
  }

  if (rejections.length > 0) {
    return { ok: false, rejections };
  }
  return { ok: true, value: input as unknown as GpuStressCleanupOutcomeV1 };
}

/**
 * Thrown-form typed rejection error for callers that prefer exceptions; the
 * code comes from the same closed vocabulary as the result-object rejections.
 */
export class GpuStressRejectionError extends Error {
  readonly code: GpuStressRejectionCode;

  constructor(code: GpuStressRejectionCode, message: string) {
    super(message);
    this.name = 'GpuStressRejectionError';
    this.code = code;
  }
}
