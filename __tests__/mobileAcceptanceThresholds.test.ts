import { describe, expect, it } from 'vitest';
import {
  MOBILE_ACCEPTANCE_THRESHOLD_SET_V1,
  MOBILE_ACCEPTANCE_THRESHOLDS_V1,
  THRESHOLD_SET_VERSION,
  evaluateObservation,
  findThreshold,
  ThresholdEvaluationError,
  validateThresholdSet,
  type ThresholdDefinition,
} from '../src/perf/acceptanceThresholds.js';

/**
 * Mutable deep clone for rejection tests. The production const stays frozen;
 * every mutation below goes through this clone.
 */
type MutableSet = {
  version: number;
  groups: {
    id: string;
    label: string;
    thresholds: Record<string, unknown>[];
  }[];
};

function cloneSet(): MutableSet {
  return JSON.parse(
    JSON.stringify(MOBILE_ACCEPTANCE_THRESHOLD_SET_V1),
  ) as MutableSet;
}

function replaceFirstThreshold(threshold: Record<string, unknown>): MutableSet {
  const set = cloneSet();
  set.groups[0].thresholds[0] = threshold;
  return set;
}

function cloneFirstThreshold(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups[0].thresholds[0]),
  ) as Record<string, unknown>;
}

function issuePaths(set: unknown): string[] {
  return validateThresholdSet(set).issues.map((i) => i.path);
}

describe('mobile acceptance threshold set v1 (psyche-i7c.10.4 / #213)', () => {
  it('is versioned and covers the four matrix areas', () => {
    expect(MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.version).toBe(THRESHOLD_SET_VERSION);
    expect(THRESHOLD_SET_VERSION).toBe(1);
    const groupIds = MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups.map((g) => g.id);
    expect(groupIds).toEqual([
      'workspaceSerialization',
      'eventStreamBounds',
      'memorySessionCaps',
      'navigationResponsiveness',
    ]);
  });

  it('gives every threshold an id, label, unit, direction, status, and rationale', () => {
    const ids: string[] = [];
    for (const group of MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups) {
      expect(group.label.trim().length).toBeGreaterThan(0);
      for (const threshold of group.thresholds) {
        ids.push(threshold.id);
        expect(threshold.label.trim().length).toBeGreaterThan(0);
        expect(['ms', 'bytes', 'count']).toContain(threshold.unit);
        expect(['max', 'min']).toContain(threshold.direction);
        expect(['production-mirror', 'proposal', 'to-be-measured']).toContain(
          threshold.status,
        );
        expect(threshold.rationale.trim().length).toBeGreaterThanOrEqual(8);
        expect(threshold.owner === null || typeof threshold.owner === 'string').toBe(true);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(12);
  });

  it('bases production-mirror values on cited source constants', () => {
    const mirrors = MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups
      .flatMap((g) => g.thresholds)
      .filter((t) => t.status === 'production-mirror');
    expect(mirrors.length).toBeGreaterThanOrEqual(6);
    for (const mirror of mirrors) {
      expect(mirror.value).not.toBeNull();
      expect(mirror.rationale).toMatch(/src\/[A-Za-z0-9._/-]+\.(ts|swift|rs)/);
    }
    // Spot-check two exact mirrors of shipped constants.
    expect(MOBILE_ACCEPTANCE_THRESHOLDS_V1.paneOutputRingBytes?.value).toBe(256 * 1024);
    expect(MOBILE_ACCEPTANCE_THRESHOLDS_V1.controlStreamsPerConnection?.value).toBe(4);
  });

  it('marks ungrounded values null + "to be measured" with an owner instead of inventing them', () => {
    const deferred = MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups
      .flatMap((g) => g.thresholds)
      .filter((t) => t.status === 'to-be-measured');
    expect(deferred.length).toBeGreaterThanOrEqual(3);
    for (const threshold of deferred) {
      expect(threshold.value).toBeNull();
      expect(threshold.warnValue).toBeNull();
      expect(threshold.rationale).toMatch(/to be measured/i);
      expect(threshold.owner).toMatch(/^#?\d+$|^[A-Za-z0-9/-]+#\d+$/);
    }
    expect(MOBILE_ACCEPTANCE_THRESHOLDS_V1.workspaceCacheBytes?.owner).toBe('#210');
    expect(MOBILE_ACCEPTANCE_THRESHOLDS_V1.deviceResidentMemoryBytes?.owner).toBe('#213');
  });

  it('keeps proposals explicit and justified pending #213 evidence', () => {
    const proposals = MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups
      .flatMap((g) => g.thresholds)
      .filter((t) => t.status === 'proposal');
    expect(proposals.length).toBeGreaterThanOrEqual(3);
    for (const proposal of proposals) {
      expect(proposal.value).not.toBeNull();
      expect(proposal.rationale).toMatch(/proposal/i);
    }
  });

  it('exposes a flat lookup consistent with the grouped set', () => {
    const grouped = MOBILE_ACCEPTANCE_THRESHOLD_SET_V1.groups.flatMap((g) => g.thresholds);
    expect(Object.keys(MOBILE_ACCEPTANCE_THRESHOLDS_V1).length).toBe(grouped.length);
    for (const threshold of grouped) {
      expect(MOBILE_ACCEPTANCE_THRESHOLDS_V1[threshold.id]).toBe(threshold);
      expect(findThreshold(threshold.id)).toBe(threshold);
    }
    expect(findThreshold('noSuchThreshold')).toBeUndefined();
  });
});

describe('validateThresholdSet', () => {
  it('accepts the shipped v1 set with no issues', () => {
    const result = validateThresholdSet(MOBILE_ACCEPTANCE_THRESHOLD_SET_V1);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects non-object sets', () => {
    for (const bad of [null, 'set', 42, []]) {
      const result = validateThresholdSet(bad);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects a wrong version', () => {
    const set = cloneSet();
    set.version = 2;
    expect(issuePaths(set)).toContain('version');
  });

  it('rejects unknown fields at every level', () => {
    const withTopField = cloneSet() as unknown as Record<string, unknown>;
    withTopField.sneaky = true;
    expect(issuePaths(withTopField)).toContain('sneaky');

    const withGroupField = cloneSet();
    (withGroupField.groups[0] as unknown as Record<string, unknown>).extra = 1;
    expect(issuePaths(withGroupField)).toContain('groups[0].extra');

    const threshold = cloneFirstThreshold();
    threshold.secret = 1;
    expect(issuePaths(replaceFirstThreshold(threshold))).toContain(
      'groups[0].thresholds[0].secret',
    );
  });

  it('rejects negative, NaN, infinite, and non-positive values', () => {
    const base = cloneFirstThreshold();

    const negative = { ...base, value: -1 };
    expect(issuePaths(replaceFirstThreshold(negative))).toContain(
      'groups[0].thresholds[0].value',
    );

    const nan = { ...base, value: Number.NaN };
    expect(issuePaths(replaceFirstThreshold(nan))).toContain(
      'groups[0].thresholds[0].value',
    );

    const infinite = { ...base, value: Number.POSITIVE_INFINITY };
    expect(issuePaths(replaceFirstThreshold(infinite))).toContain(
      'groups[0].thresholds[0].value',
    );

    const zeroMs = { ...base, value: 0 };
    expect(issuePaths(replaceFirstThreshold(zeroMs))).toContain(
      'groups[0].thresholds[0].value',
    );

    const fractionalCount = {
      ...MOBILE_ACCEPTANCE_THRESHOLDS_V1.controlStreamsPerConnection,
      value: 2.5,
    };
    expect(issuePaths(replaceFirstThreshold(fractionalCount))).toContain(
      'groups[0].thresholds[0].value',
    );
  });

  it('rejects unknown unit, direction, and status values', () => {
    const base = cloneFirstThreshold();
    for (const [key, value] of [
      ['unit', 'cubits'],
      ['direction', 'sideways'],
      ['status', 'vibes'],
    ] as const) {
      const bad = { ...base, [key]: value };
      expect(issuePaths(replaceFirstThreshold(bad))).toContain(
        `groups[0].thresholds[0].${key}`,
      );
    }
  });

  it('rejects duplicate threshold ids', () => {
    const set = cloneSet();
    set.groups[0].thresholds.push({ ...set.groups[0].thresholds[0] });
    const paths = issuePaths(set);
    expect(paths.some((p) => p.endsWith('.id') && p.includes('thresholds'))).toBe(true);
  });

  it('enforces the to-be-measured ↔ null-value ↔ owner invariants', () => {
    const unmeasured = MOBILE_ACCEPTANCE_THRESHOLDS_V1
      .snapshotEncodedBytes as unknown as Record<string, unknown>;

    const measuredWhenDeferred = { ...unmeasured, value: 1024 };
    expect(issuePaths(replaceFirstThreshold(measuredWhenDeferred))).toContain(
      'groups[0].thresholds[0].value',
    );

    const deferredWithoutOwner = { ...unmeasured, owner: null };
    expect(issuePaths(replaceFirstThreshold(deferredWithoutOwner))).toContain(
      'groups[0].thresholds[0].owner',
    );

    const measured = cloneFirstThreshold();
    measured.value = null;
    expect(issuePaths(replaceFirstThreshold(measured))).toContain(
      'groups[0].thresholds[0].value',
    );
  });

  it('requires source provenance for production-mirror rationales', () => {
    const mirror = JSON.parse(
      JSON.stringify(MOBILE_ACCEPTANCE_THRESHOLDS_V1.paneOutputRingBytes),
    ) as Record<string, unknown>;
    mirror.rationale = 'Mirrors a constant somewhere in the codebase.';
    expect(issuePaths(replaceFirstThreshold(mirror))).toContain(
      'groups[0].thresholds[0].rationale',
    );
  });

  it('rejects malformed rationale, label, and owner fields', () => {
    const base = cloneFirstThreshold();

    const shortRationale = { ...base, rationale: 'short' };
    expect(issuePaths(replaceFirstThreshold(shortRationale))).toContain(
      'groups[0].thresholds[0].rationale',
    );

    const emptyLabel = { ...base, label: '   ' };
    expect(issuePaths(replaceFirstThreshold(emptyLabel))).toContain(
      'groups[0].thresholds[0].label',
    );

    const badOwner = { ...base, owner: 'the cache issue' };
    expect(issuePaths(replaceFirstThreshold(badOwner))).toContain(
      'groups[0].thresholds[0].owner',
    );
  });

  it('rejects warn bands that contradict the threshold direction', () => {
    const maxThreshold = cloneFirstThreshold();
    maxThreshold.warnValue = 1_000_000; // value is 100 (max) → warn above limit
    expect(issuePaths(replaceFirstThreshold(maxThreshold))).toContain(
      'groups[0].thresholds[0].warnValue',
    );

    const negativeWarn = cloneFirstThreshold();
    negativeWarn.warnValue = -5;
    expect(issuePaths(replaceFirstThreshold(negativeWarn))).toContain(
      'groups[0].thresholds[0].warnValue',
    );
  });
});

describe('evaluateObservation', () => {
  const ring = MOBILE_ACCEPTANCE_THRESHOLDS_V1.paneOutputRingBytes as ThresholdDefinition;
  const streams = MOBILE_ACCEPTANCE_THRESHOLDS_V1
    .controlStreamsPerConnection as ThresholdDefinition;
  const deferred = MOBILE_ACCEPTANCE_THRESHOLDS_V1.snapshotEncodedBytes as ThresholdDefinition;

  it('classifies exactly-at-limit observations as within (inclusive boundary)', () => {
    const result = evaluateObservation(ring, 256 * 1024);
    expect(result.classification).toBe('within');
  });

  it('classifies strictly-beyond-limit observations as breach', () => {
    expect(evaluateObservation(ring, 256 * 1024 + 1).classification).toBe('breach');
  });

  it('classifies the warn band between warnValue and value', () => {
    expect(ring.warnValue).toBe(209_715);
    expect(evaluateObservation(ring, 209_715).classification).toBe('within');
    expect(evaluateObservation(ring, 209_716).classification).toBe('warn');
    expect(evaluateObservation(ring, 262_143).classification).toBe('warn');
    expect(evaluateObservation(ring, 0).classification).toBe('within');
  });

  it('handles thresholds without a warn band', () => {
    expect(streams.warnValue).toBeNull();
    expect(evaluateObservation(streams, 3).classification).toBe('within');
    expect(evaluateObservation(streams, 4).classification).toBe('within');
    expect(evaluateObservation(streams, 5).classification).toBe('breach');
  });

  it('returns stable machine-parseable detail with units', () => {
    const result = evaluateObservation(ring, 250_000);
    expect(result.thresholdId).toBe('paneOutputRingBytes');
    expect(result.limit).toBe(256 * 1024);
    expect(result.warnValue).toBe(209_715);
    expect(result.detail).toBe(
      'observed=250000 bytes max=262144 bytes warn=209715 bytes classification=warn',
    );
  });

  it('mirrors the boundary semantics for min thresholds', () => {
    const minThreshold: ThresholdDefinition = {
      id: 'probeMinMs',
      label: 'Synthetic min threshold for boundary tests',
      unit: 'ms',
      direction: 'min',
      value: 50,
      warnValue: 80,
      status: 'proposal',
      rationale: 'proposal test rationale for min-direction boundary checks',
      owner: null,
    };
    expect(evaluateObservation(minThreshold, 50).classification).toBe('within');
    expect(evaluateObservation(minThreshold, 49).classification).toBe('breach');
    expect(evaluateObservation(minThreshold, 79).classification).toBe('warn');
    expect(evaluateObservation(minThreshold, 80).classification).toBe('within');
    expect(evaluateObservation(minThreshold, 120).classification).toBe('within');
  });

  it('refuses to evaluate thresholds that are still "to be measured"', () => {
    expect(deferred.value).toBeNull();
    expect(() => evaluateObservation(deferred, 1024)).toThrow(ThresholdEvaluationError);
    expect(() => evaluateObservation(deferred, 1024)).toThrow(/to be measured/);
  });

  it('refuses malformed thresholds and invalid observations', () => {
    expect(() =>
      evaluateObservation({} as unknown as ThresholdDefinition, 1),
    ).toThrow(ThresholdEvaluationError);
    expect(() => evaluateObservation(ring, Number.NaN)).toThrow(ThresholdEvaluationError);
    expect(() => evaluateObservation(ring, Number.POSITIVE_INFINITY)).toThrow(
      ThresholdEvaluationError,
    );
    expect(() => evaluateObservation(ring, -1)).toThrow(ThresholdEvaluationError);
  });
});
