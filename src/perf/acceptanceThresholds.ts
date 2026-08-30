/**
 * Mobile acceptance threshold contract (v1).
 *
 * Machine-checkable companion to `docs/perf/MOBILE-ACCEPTANCE-MATRIX.md` for
 * OpenCoven/psyche-build#213 (psyche-i7c.10.4, mobile cockpit Phase 10 family,
 * canonical outcome gh-200): the performance thresholds the acceptance matrix
 * gates on.
 *
 * Contract rules:
 * - `status: 'production-mirror'` entries mirror constants that already exist
 *   in production code; their rationale cites the exact source file, so the
 *   matrix cannot silently drift from shipped behavior.
 * - `status: 'proposal'` entries are proposal defaults with an explicit
 *   rationale, pending #213 execution evidence on iPhone/iPad hardware.
 * - `status: 'to-be-measured'` entries have `value: null`: no defensible
 *   number exists yet, so the contract records "to be measured" and the
 *   owning issue instead of inventing a number.
 * - Boundaries are inclusive: an observation exactly at `value` is `within`
 *   for both directions (matching e.g. `BoundedOutputBuffer`'s
 *   `<= maxBytes` behavior); only strictly beyond the limit is a breach.
 *
 * Upgrade path: bump `THRESHOLD_SET_VERSION`, keep `validateThresholdSet`
 * version-strict, and cite the measurement that justified each change in the
 * matrix document. Do not mutate v1 entries in place.
 */

/** Contract version. */
export const THRESHOLD_SET_VERSION = 1 as const;

export type ThresholdUnit = 'ms' | 'bytes' | 'count';
export type ThresholdDirection = 'max' | 'min';
export type ThresholdStatus = 'production-mirror' | 'proposal' | 'to-be-measured';

export interface ThresholdDefinition {
  /** Stable machine id, unique within a set. */
  readonly id: string;
  /** Human-readable label used in reports and the matrix document. */
  readonly label: string;
  /** Unit of `value`, `warnValue`, and any observation evaluated against this threshold. */
  readonly unit: ThresholdUnit;
  /**
   * `max`: observation must not exceed `value` (latency, sizes, counts).
   * `min`: observation must reach `value` (reserved for minimum-quality
   * budgets; v1 currently uses none).
   */
  readonly direction: ThresholdDirection;
  /**
   * The threshold itself, or `null` when it is "to be measured". `null` is
   * only valid with `status: 'to-be-measured'`; such thresholds cannot be
   * evaluated until the owning issue pins a number from measured evidence.
   */
  readonly value: number | null;
  /**
   * Absolute warn boundary in the same unit, or `null` for no warn band.
   * For `max`: observations strictly above `warnValue` and strictly below
   * `value` are `warn` (exactly at `value` is still `within`).
   * For `min`: observations strictly above `value` and strictly below
   * `warnValue` are `warn`.
   * Required to be `null` while `value` is `null`.
   */
  readonly warnValue: number | null;
  /** Provenance class; drives the validator's rationale requirements. */
  readonly status: ThresholdStatus;
  /**
   * Provenance/rationale comment. Required non-empty for every entry:
   * `production-mirror` must cite a source file, `proposal` must justify the
   * number, `to-be-measured` must say what will pin it.
   */
  readonly rationale: string;
  /** Owning issue for deferred entries, e.g. `#210`; otherwise `null`. */
  readonly owner: string | null;
}

export interface ThresholdGroup {
  readonly id: string;
  readonly label: string;
  readonly thresholds: readonly ThresholdDefinition[];
}

export interface ThresholdSet {
  readonly version: number;
  readonly groups: readonly ThresholdGroup[];
}

/** Validator size bounds (documentation hygiene, not product limits). */
export const MAX_GROUPS_PER_SET = 8;
export const MAX_THRESHOLDS_PER_GROUP = 32;
export const MAX_THRESHOLDS_PER_SET = 64;
/** Inclusive sanity upper bounds used by the validator, per unit. */
export const MAX_MS_VALUE = 3_600_000;
export const MAX_BYTES_VALUE = 2 ** 40;
export const MAX_COUNT_VALUE = 1_000_000;

/** Documented id grammar: `paneOutputRingBytes`, `reconnectToReadyMs`, ... */
export const THRESHOLD_ID_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;
/**
 * Documented owner grammar for deferred entries: `#213`, `#210`,
 * `psyche-build#210`, `OpenCoven/psyche-build#200`.
 */
export const THRESHOLD_OWNER_PATTERN = /^#?\d+$|^[A-Za-z0-9/-]+#\d+$/;
/** A production-mirror rationale must cite a concrete source file path. */
const MIRROR_SOURCE_PATH = /\/[A-Za-z0-9._/-]+\.(ts|tsx|swift|rs)(?![\w.])/;

export const THRESHOLD_UNITS = ['ms', 'bytes', 'count'] as const;
export const THRESHOLD_DIRECTIONS = ['max', 'min'] as const;
export const THRESHOLD_STATUSES = [
  'production-mirror',
  'proposal',
  'to-be-measured',
] as const;

const SET_KEYS = ['version', 'groups'] as const;
const GROUP_KEYS = ['id', 'label', 'thresholds'] as const;
const THRESHOLD_KEYS = [
  'id',
  'label',
  'unit',
  'direction',
  'value',
  'warnValue',
  'status',
  'rationale',
  'owner',
] as const;

export interface ThresholdValidationIssue {
  /** Dotted path to the offending value, e.g. `groups[0].thresholds[2].value`. */
  readonly path: string;
  readonly message: string;
}

export interface ThresholdValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ThresholdValidationIssue[];
}

/**
 * The v1 mobile acceptance threshold set.
 *
 * Every number is either a mirror of a production constant (with its source
 * file cited) or a clearly marked proposal with an explicit rationale;
 * anything without defensible grounding is `null` + "to be measured" with an
 * owning issue. #213 execution evidence is what upgrades `proposal` entries
 * to measured values — never silent edits.
 */
export const MOBILE_ACCEPTANCE_THRESHOLD_SET_V1: ThresholdSet = {
  version: 1,
  groups: [
    {
      id: 'workspaceSerialization',
      label: 'Workspace serialization and event application',
      thresholds: [
        {
          id: 'snapshotSerializationMs',
          label: 'Host workspace snapshot serialization',
          unit: 'ms',
          direction: 'max',
          value: 100,
          warnValue: 80,
          status: 'proposal',
          rationale:
            'Proposal: serializing one mobile.workspace.snapshot result runs on the ' +
            'authoritative host inside the control-connection loop, so it must stay ' +
            'inside the classic 100 ms instantaneous-response budget to keep the ' +
            'host responsive while a mobile client requests a snapshot; warn at 80% ' +
            'leaves measurement headroom. Pending #213 execution evidence.',
          owner: null,
        },
        {
          id: 'eventApplicationMs',
          label: 'Device snapshot/event application',
          unit: 'ms',
          direction: 'max',
          value: 16,
          warnValue: 13,
          status: 'proposal',
          rationale:
            'Proposal: applying a workspace snapshot or event on the device must fit ' +
            'inside one 60 Hz frame (~16.7 ms) so state application never delays the ' +
            'next Core Animation commit (docs/HIGH_REFRESH.md: the iOS app renders ' +
            'via Core Animation, which owns the final cadence). Pending #213 ' +
            'measurement on device.',
          owner: null,
        },
        {
          id: 'snapshotEncodedBytes',
          label: 'Encoded workspace snapshot size',
          unit: 'bytes',
          direction: 'max',
          value: null,
          warnValue: null,
          status: 'to-be-measured',
          rationale:
            'To be measured: no production bound exists for the encoded ' +
            'mobile.workspace.snapshot payload at the pinned baseline (main ' +
            'a4546f4); measure the largest observed encoded snapshot and pin the ' +
            'cap plus headroom before this gate can fail a run.',
          owner: '#213',
        },
      ],
    },
    {
      id: 'eventStreamBounds',
      label: 'Event-stream and transport bounds',
      thresholds: [
        {
          id: 'paneOutputRingBytes',
          label: 'Per-pane terminal output ring buffer',
          unit: 'bytes',
          direction: 'max',
          value: 256 * 1024,
          warnValue: 209_715,
          status: 'production-mirror',
          rationale:
            'Mirrors src/services/bridge/PaneOutputBuffer.ts DEFAULT_CAP (256 KiB): ' +
            'the byte-bounded ring buffer of PTY output each pane keeps for mobile ' +
            'replay via sinceSeq.',
          owner: null,
        },
        {
          id: 'clientFrameBytes',
          label: 'Bridge client frame size',
          unit: 'bytes',
          direction: 'max',
          value: 1024 * 1024,
          warnValue: 838_860,
          status: 'production-mirror',
          rationale:
            'Mirrors src/services/bridge/WSSListener.ts MAX_CLIENT_FRAME_BYTES ' +
            '(1 MiB): the WebSocketServer maxPayload for a single client frame.',
          owner: null,
        },
        {
          id: 'filePreviewBytes',
          label: 'Mobile file/diff preview payload',
          unit: 'bytes',
          direction: 'max',
          value: 200_000,
          warnValue: 160_000,
          status: 'production-mirror',
          rationale:
            'Mirrors src/utils/fileBrowser.ts MAX_PREVIEW_BYTES (200000): the file ' +
            'preview payload the mobile inspection path may return for one file.',
          owner: null,
        },
        {
          id: 'controlStreamsPerConnection',
          label: 'Terminal streams per mobile connection',
          unit: 'count',
          direction: 'max',
          value: 4,
          warnValue: null,
          status: 'production-mirror',
          rationale:
            'Mirrors src/services/bridge/BridgeDaemon.ts ' +
            'MAX_CONTROL_STREAMS_PER_CONNECTION (4): two visible terminals plus ' +
            'reattach headroom before the old stream detaches.',
          owner: null,
        },
        {
          id: 'rememberedSpawns',
          label: 'Remembered idempotent spawn fingerprints',
          unit: 'count',
          direction: 'max',
          value: 128,
          warnValue: 102,
          status: 'production-mirror',
          rationale:
            'Mirrors src/services/bridge/MobileControlGateway.ts MAX_REMEMBERED_SPAWNS ' +
            '(128): bounded deduplication memory for replayed pane spawn requests.',
          owner: null,
        },
        {
          id: 'pendingRemoteActions',
          label: 'Pending remote action sessions',
          unit: 'count',
          direction: 'max',
          value: 64,
          warnValue: 51,
          status: 'production-mirror',
          rationale:
            'Mirrors the RemoteActionSessions maxPending (64) configured in ' +
            'src/services/bridge/MobileControlGateway.ts for in-flight mobile actions.',
          owner: null,
        },
        {
          id: 'remoteActionSessionTtlMs',
          label: 'Remote action session lifetime',
          unit: 'ms',
          direction: 'max',
          value: 300_000,
          warnValue: 240_000,
          status: 'production-mirror',
          rationale:
            'Mirrors the RemoteActionSessions ttlMs (5 minutes) configured in ' +
            'src/services/bridge/MobileControlGateway.ts; a session must not ' +
            'outlive this window.',
          owner: null,
        },
        {
          id: 'pairingAttempts',
          label: 'Pairing code attempts before failure',
          unit: 'count',
          direction: 'max',
          value: 5,
          warnValue: null,
          status: 'production-mirror',
          rationale:
            'Mirrors src/services/bridge/PairingFlow.ts PAIR_MAX_ATTEMPTS (5) ' +
            'rejected pairing codes before the flow fails closed.',
          owner: null,
        },
      ],
    },
    {
      id: 'memorySessionCaps',
      label: 'Memory and session caps',
      thresholds: [
        {
          id: 'deviceResidentMemoryBytes',
          label: 'iOS app resident footprint',
          unit: 'bytes',
          direction: 'max',
          value: null,
          warnValue: null,
          status: 'to-be-measured',
          rationale:
            'To be measured: requires on-device footprint profiling (Instruments ' +
            'report), which cannot run on the Linux authoring host; #213 execution ' +
            'must measure and pin this cap before it gates anything.',
          owner: '#213',
        },
        {
          id: 'workspaceCacheBytes',
          label: 'Protected workspace cache size limit',
          unit: 'bytes',
          direction: 'max',
          value: null,
          warnValue: null,
          status: 'to-be-measured',
          rationale:
            'To be measured: the bounded protected workspace cache (atomic ' +
            'Application Support storage, host-identity keyed) is owned by ' +
            'psyche-build#210; pin the byte cap from that implementation and its ' +
            'acceptance tests, not from this contract.',
          owner: '#210',
        },
        {
          id: 'cachedDrafts',
          label: 'Cached draft count/length bound',
          unit: 'count',
          direction: 'max',
          value: null,
          warnValue: null,
          status: 'to-be-measured',
          rationale:
            'To be measured: draft count/length bounds are #210 deliverables for ' +
            'the workspace cache; this contract pins the accepted numbers only ' +
            'after that implementation and its acceptance tests exist.',
          owner: '#210',
        },
      ],
    },
    {
      id: 'navigationResponsiveness',
      label: 'Navigation responsiveness',
      thresholds: [
        {
          id: 'navigationInputToPaintMs',
          label: 'Navigation input-to-paint',
          unit: 'ms',
          direction: 'max',
          value: 100,
          warnValue: 80,
          status: 'proposal',
          rationale:
            'Proposal: a navigation (Now -> split -> pane switch -> back) must ' +
            'paint within the 100 ms instantaneous-feedback budget so the cockpit ' +
            'never reads as lagging; measured on device via signposts or ' +
            'transaction metrics. Pending #213 measurement.',
          owner: null,
        },
        {
          id: 'reconnectToReadyMs',
          label: 'Reconnect to ready after transport loss',
          unit: 'ms',
          direction: 'max',
          value: 2_000,
          warnValue: 1_600,
          status: 'proposal',
          rationale:
            'Proposal: a same-LAN reconnect (TLS resume plus snapshot request) ' +
            'should reach ready within 2 s so the stale/offline state from ' +
            'psyche-build#211 reads as transitional, never as the resting state. ' +
            'Pending #213 measurement on device.',
          owner: null,
        },
      ],
    },
  ],
};

/** Flat id-keyed view of the v1 threshold set. */
export const MOBILE_ACCEPTANCE_THRESHOLDS_V1: Readonly<
  Record<string, ThresholdDefinition>
> = (() => {
  const flat: Record<string, ThresholdDefinition> = {};
  for (const group of MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups) {
    for (const threshold of group.thresholds) {
      flat[threshold.id] = threshold;
    }
  }
  return flat;
})();

/** Returns the threshold with the given id from the v1 set, or undefined. */
export function findThreshold(
  thresholdId: string,
  set: ThresholdSet = MOBILE_ACCEPTANCE_THRESHOLD_SET_V1,
): ThresholdDefinition | undefined {
  for (const group of set.groups) {
    const found = group.thresholds.find((threshold) => threshold.id === thresholdId);
    if (found) return found;
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Applies the documented per-unit sanity bounds for a numeric value. */
function checkNumericBounds(
  path: string,
  unit: ThresholdUnit,
  value: number,
  issues: ThresholdValidationIssue[],
): void {
  if (unit === 'ms') {
    if (value <= 0) {
      issues.push({ path, message: 'ms values must be positive' });
    } else if (value > MAX_MS_VALUE) {
      issues.push({ path, message: `exceeds the ${MAX_MS_VALUE} ms sanity bound` });
    }
    return;
  }
  if (unit === 'bytes') {
    if (value <= 0) {
      issues.push({ path, message: 'byte values must be positive' });
    } else if (value > MAX_BYTES_VALUE) {
      issues.push({ path, message: `exceeds the ${MAX_BYTES_VALUE} bytes sanity bound` });
    }
    return;
  }
  if (!Number.isInteger(value) || value < 0) {
    issues.push({ path, message: 'count values must be non-negative integers' });
  } else if (value > MAX_COUNT_VALUE) {
    issues.push({ path, message: `exceeds the ${MAX_COUNT_VALUE} count sanity bound` });
  }
}

/**
 * Strictly validates a threshold set against the v1 contract. Returns every
 * violation found; `ok` is true only when the issue list is empty.
 *
 * Strictness (fail closed): unknown fields are rejected at every level, the
 * version must match exactly, and the value/warnValue/status/owner/rationale
 * relationships must all hold. An invalid set is never silently repaired.
 */
export function validateThresholdSet(set: unknown): ThresholdValidationResult {
  const issues: ThresholdValidationIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  if (!isPlainObject(set)) {
    return { ok: false, issues: [{ path: '', message: 'threshold set must be an object' }] };
  }
  for (const key of Object.keys(set)) {
    if (!SET_KEYS.includes(key as (typeof SET_KEYS)[number])) {
      push(key, `unknown top-level field '${key}'`);
    }
  }
  if (set.version !== THRESHOLD_SET_VERSION) {
    push('version', `expected version ${THRESHOLD_SET_VERSION}, got ${String(set.version)}`);
  }
  if (!Array.isArray(set.groups)) {
    push('groups', 'groups must be an array');
    return { ok: false, issues };
  }
  if (set.groups.length < 1 || set.groups.length > MAX_GROUPS_PER_SET) {
    push('groups', `expected 1..${MAX_GROUPS_PER_SET} groups`);
  }

  const seenIds = new Set<string>();
  let totalThresholds = 0;
  set.groups.forEach((group, groupIndex) => {
    const groupPath = `groups[${groupIndex}]`;
    if (!isPlainObject(group)) {
      push(groupPath, 'group must be an object');
      return;
    }
    for (const key of Object.keys(group)) {
      if (!GROUP_KEYS.includes(key as (typeof GROUP_KEYS)[number])) {
        push(`${groupPath}.${key}`, `unknown group field '${key}'`);
      }
    }
    if (typeof group.id !== 'string' || !THRESHOLD_ID_PATTERN.test(group.id)) {
      push(`${groupPath}.id`, 'group id must match the documented id pattern');
    }
    if (typeof group.label !== 'string' || group.label.trim().length === 0) {
      push(`${groupPath}.label`, 'group label must be a non-empty string');
    }
    if (!Array.isArray(group.thresholds)) {
      push(`${groupPath}.thresholds`, 'thresholds must be an array');
      return;
    }
    if (group.thresholds.length < 1 || group.thresholds.length > MAX_THRESHOLDS_PER_GROUP) {
      push(`${groupPath}.thresholds`, `expected 1..${MAX_THRESHOLDS_PER_GROUP} thresholds`);
    }
    group.thresholds.forEach((threshold, thresholdIndex) => {
      totalThresholds += 1;
      const path = `${groupPath}.thresholds[${thresholdIndex}]`;
      if (!isPlainObject(threshold)) {
        push(path, 'threshold must be an object');
        return;
      }
      for (const key of Object.keys(threshold)) {
        if (!THRESHOLD_KEYS.includes(key as (typeof THRESHOLD_KEYS)[number])) {
          push(`${path}.${key}`, `unknown threshold field '${key}'`);
        }
      }
      if (typeof threshold.id !== 'string' || !THRESHOLD_ID_PATTERN.test(threshold.id)) {
        push(`${path}.id`, 'threshold id must match the documented id pattern');
      } else if (seenIds.has(threshold.id)) {
        push(`${path}.id`, `duplicate threshold id '${threshold.id}'`);
      } else {
        seenIds.add(threshold.id);
      }
      if (typeof threshold.label !== 'string' || threshold.label.trim().length === 0) {
        push(`${path}.label`, 'label must be a non-empty string');
      }
      if (
        typeof threshold.unit !== 'string' ||
        !THRESHOLD_UNITS.includes(threshold.unit as ThresholdUnit)
      ) {
        push(`${path}.unit`, `unit must be one of: ${THRESHOLD_UNITS.join(', ')}`);
      }
      if (
        typeof threshold.direction !== 'string' ||
        !THRESHOLD_DIRECTIONS.includes(threshold.direction as ThresholdDirection)
      ) {
        push(`${path}.direction`, `direction must be one of: ${THRESHOLD_DIRECTIONS.join(', ')}`);
      }
      if (
        typeof threshold.status !== 'string' ||
        !THRESHOLD_STATUSES.includes(threshold.status as ThresholdStatus)
      ) {
        push(`${path}.status`, `status must be one of: ${THRESHOLD_STATUSES.join(', ')}`);
      }
      if (typeof threshold.rationale !== 'string' || threshold.rationale.trim().length < 8) {
        push(`${path}.rationale`, 'rationale must be a non-empty string (>= 8 chars)');
      }
      if (threshold.owner !== null && typeof threshold.owner !== 'string') {
        push(`${path}.owner`, 'owner must be null or an issue reference string');
      } else if (typeof threshold.owner === 'string' && !THRESHOLD_OWNER_PATTERN.test(threshold.owner)) {
        push(`${path}.owner`, 'owner must reference an issue (e.g. #210)');
      }
      if (
        threshold.status === 'production-mirror' &&
        (typeof threshold.rationale !== 'string' || !MIRROR_SOURCE_PATH.test(threshold.rationale))
      ) {
        push(
          `${path}.rationale`,
          'production-mirror rationale must cite a source file path (e.g. src/….ts)',
        );
      }
      if (threshold.status === 'to-be-measured') {
        if (threshold.value !== null) {
          push(`${path}.value`, 'status to-be-measured requires value to be null');
        }
        if (threshold.warnValue !== null) {
          push(`${path}.warnValue`, 'status to-be-measured requires warnValue to be null');
        }
        if (typeof threshold.owner !== 'string' || !THRESHOLD_OWNER_PATTERN.test(threshold.owner)) {
          push(`${path}.owner`, 'status to-be-measured requires an owning issue reference');
        }
        return;
      }
      const unit = threshold.unit as ThresholdUnit;
      const value = threshold.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        push(`${path}.value`, 'value must be a finite number (or null with to-be-measured)');
        return;
      }
      checkNumericBounds(`${path}.value`, unit, value, issues);
      const warnValue = threshold.warnValue;
      if (warnValue !== null) {
        if (typeof warnValue !== 'number' || !Number.isFinite(warnValue)) {
          push(`${path}.warnValue`, 'warnValue must be a finite number or null');
        } else if (warnValue < 0) {
          push(`${path}.warnValue`, 'warnValue must not be negative');
        } else if ((unit === 'ms' || unit === 'bytes') && warnValue <= 0) {
          push(`${path}.warnValue`, `warnValue must be positive for ${unit} thresholds`);
        } else if (threshold.direction === 'max' && warnValue > value) {
          push(`${path}.warnValue`, 'warnValue must not exceed value for a max threshold');
        } else if (threshold.direction === 'min' && warnValue < value) {
          push(`${path}.warnValue`, 'warnValue must not be below value for a min threshold');
        }
      }
    });
  });
  if (totalThresholds < 1 || totalThresholds > MAX_THRESHOLDS_PER_SET) {
    push('groups', `expected 1..${MAX_THRESHOLDS_PER_SET} thresholds in total`);
  }
  return { ok: issues.length === 0, issues };
}

export class ThresholdEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThresholdEvaluationError';
  }
}

export type ObservationClassification = 'within' | 'warn' | 'breach';

export interface ObservationResult {
  readonly thresholdId: string;
  readonly observed: number;
  readonly classification: ObservationClassification;
  /** The hard limit the observation was evaluated against. */
  readonly limit: number;
  /** The warn boundary actually applied, if one exists. */
  readonly warnValue: number | null;
  /** Stable, machine-parseable summary including unit and classification. */
  readonly detail: string;
}

function formatValue(value: number, unit: ThresholdUnit): string {
  return `${value} ${unit}`;
}

/**
 * Classifies one observed measurement against one threshold.
 *
 * Boundaries are inclusive: an observation exactly at `value` is `within`
 * (only strictly beyond the limit is a breach), matching how the production
 * bounded buffers treat `<= maxBytes` as inside the cap. The warn band sits
 * strictly between `warnValue` and `value` and never overlaps the limit
 * itself, so an at-limit observation is never escalated to `warn`.
 *
 * Throws {@link ThresholdEvaluationError} when the threshold is malformed,
 * when its value is still "to be measured" (null), or when the observation is
 * not a finite non-negative number: a contract that cannot be evaluated must
 * fail loudly rather than silently classify.
 */
export function evaluateObservation(
  threshold: ThresholdDefinition,
  observed: number,
): ObservationResult {
  if (!isPlainObject(threshold) || typeof threshold.id !== 'string') {
    throw new ThresholdEvaluationError('threshold definition is malformed');
  }
  if (
    !THRESHOLD_UNITS.includes(threshold.unit as ThresholdUnit) ||
    !THRESHOLD_DIRECTIONS.includes(threshold.direction as ThresholdDirection)
  ) {
    throw new ThresholdEvaluationError(
      `threshold '${threshold.id}' has an invalid unit/direction`,
    );
  }
  if (threshold.value === null || typeof threshold.value !== 'number') {
    throw new ThresholdEvaluationError(
      `threshold '${threshold.id}' is "to be measured" and cannot evaluate observations yet`,
    );
  }
  if (typeof observed !== 'number' || !Number.isFinite(observed) || observed < 0) {
    throw new ThresholdEvaluationError(
      `observation for '${threshold.id}' must be a finite non-negative number`,
    );
  }

  const limit = threshold.value;
  const unit = threshold.unit as ThresholdUnit;
  const warnValue =
    threshold.warnValue === null || typeof threshold.warnValue !== 'number'
      ? null
      : threshold.warnValue;
  const breached =
    threshold.direction === 'max' ? observed > limit : observed < limit;
  const warned =
    !breached &&
    warnValue !== null &&
    (threshold.direction === 'max'
      ? observed > warnValue && observed < limit
      : observed > limit && observed < warnValue);
  const classification: ObservationClassification = breached ? 'breach' : warned ? 'warn' : 'within';
  return {
    thresholdId: threshold.id,
    observed,
    classification,
    limit,
    warnValue,
    detail:
      `observed=${formatValue(observed, unit)} ` +
      `${threshold.direction}=${formatValue(limit, unit)} ` +
      `warn=${warnValue === null ? 'none' : formatValue(warnValue, unit)} ` +
      `classification=${classification}`,
  };
}
