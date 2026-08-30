import { describe, expect, it } from 'vitest';

import {
  PHASE10_CHILDREN,
  PHASE10_DEPENDENCY_EDGES,
  PHASE10_GATE_RECORD_VERSION,
  PHASE10_PHASE_ID,
  PHASE10_PARENT_ISSUE,
  gateOrder,
  phaseClosureReadiness,
  validatePhaseGateRecord,
  type Phase10ChildId,
  type Phase10GateEntry,
  type Phase10GateRecord,
} from '../src/mobile/phase10Gate.js';

const ALL_CHILDREN: readonly Phase10ChildId[] = [
  'psyche-i7c.10.1',
  'psyche-i7c.10.2',
  'psyche-i7c.10.3',
  'psyche-i7c.10.4',
  'psyche-i7c.10.5',
  'psyche-i7c.10.6',
];

function entry(childId: Phase10ChildId, status: Phase10GateEntry['status']): Phase10GateEntry {
  return {
    childId,
    status,
    evidence: `docs/working-records/issue-${209 + Number(childId.slice(-1))}-phase10-child.md`,
  };
}

function record(
  entries: readonly Phase10GateEntry[],
  overrides: { phaseClosed?: boolean } = {},
): Phase10GateRecord {
  return {
    version: PHASE10_GATE_RECORD_VERSION,
    phaseClosed: overrides.phaseClosed ?? false,
    entries,
  };
}

function allPass(): Phase10GateRecord {
  return record(ALL_CHILDREN.map((childId) => entry(childId, 'pass')));
}

describe('phase10Gate child registry', () => {
  it('declares exactly the six Phase 10 children with mirror issues 210-215', () => {
    expect(PHASE10_CHILDREN.map((child) => child.childId)).toEqual(ALL_CHILDREN);
    expect(PHASE10_CHILDREN.map((child) => child.mirrorIssue)).toEqual([
      210, 211, 212, 213, 214, 215,
    ]);
    expect(PHASE10_PHASE_ID).toBe('psyche-i7c.10');
    expect(PHASE10_PARENT_ISSUE).toBe(209);
  });

  it('keeps the explicit edge list consistent with the dependsOn lists', () => {
    const edgesByDependent = new Map<Phase10ChildId, Set<Phase10ChildId>>();
    for (const edge of PHASE10_DEPENDENCY_EDGES) {
      const set = edgesByDependent.get(edge.dependent) ?? new Set<Phase10ChildId>();
      set.add(edge.prerequisite);
      edgesByDependent.set(edge.dependent, set);
    }
    for (const child of PHASE10_CHILDREN) {
      const fromEdges = [...(edgesByDependent.get(child.childId) ?? [])].sort();
      expect(fromEdges, child.childId).toEqual([...child.dependsOn].sort());
    }
    for (const edge of PHASE10_DEPENDENCY_EDGES) {
      expect(ALL_CHILDREN, edge.prerequisite).toContain(edge.prerequisite);
      expect(ALL_CHILDREN, edge.dependent).toContain(edge.dependent);
    }
  });
});

describe('gateOrder', () => {
  it('returns every child exactly once', () => {
    const order = gateOrder();
    expect(order).toHaveLength(ALL_CHILDREN.length);
    expect(new Set(order).size).toBe(ALL_CHILDREN.length);
    expect([...order].sort()).toEqual([...ALL_CHILDREN].sort());
  });

  it('respects every declared dependency edge', () => {
    const order = gateOrder();
    for (const edge of PHASE10_DEPENDENCY_EDGES) {
      const prerequisiteIndex = order.indexOf(edge.prerequisite);
      const dependentIndex = order.indexOf(edge.dependent);
      expect(
        prerequisiteIndex,
        `${edge.prerequisite} must integrate before ${edge.dependent}`,
      ).toBeGreaterThanOrEqual(0);
      expect(prerequisiteIndex).toBeLessThan(dependentIndex);
    }
  });

  it('is deterministic across calls', () => {
    expect(gateOrder()).toEqual(gateOrder());
  });
});

describe('validatePhaseGateRecord', () => {
  it('accepts a well-formed all-pass record with evidence pointers', () => {
    expect(validatePhaseGateRecord(allPass())).toEqual([]);
  });

  it('accepts a not-run record that does not claim closure', () => {
    const notRunRecord = record(ALL_CHILDREN.map((childId) => entry(childId, 'not-run')));
    expect(validatePhaseGateRecord(notRunRecord)).toEqual([]);
  });

  it('rejects an unknown child id', () => {
    const bad = {
      ...allPass(),
      entries: [
        ...allPass().entries.slice(0, 5),
        // Runtime surfaces may submit ids outside the registry; the validator
        // must fail closed rather than trust the cast.
        entry('psyche-i7c.10.9' as Phase10ChildId, 'pass'),
      ],
    };
    const problems = validatePhaseGateRecord(bad);
    expect(problems.map((problem) => problem.code)).toContain('unknown-child');
    expect(problems.map((problem) => problem.code)).toContain('missing-child');
  });

  it('rejects a missing child entry', () => {
    const bad = {
      ...allPass(),
      entries: allPass().entries.filter((e) => e.childId !== 'psyche-i7c.10.4'),
    };
    const problems = validatePhaseGateRecord(bad);
    expect(problems.map((problem) => problem.code)).toEqual(['missing-child']);
    expect(problems[0]?.childId).toBe('psyche-i7c.10.4');
  });

  it('rejects a duplicate child entry', () => {
    const entries = allPass().entries;
    const bad = record([
      ...entries.slice(0, 5),
      entries[4]!,
      ...entries.slice(5),
    ]);
    const problems = validatePhaseGateRecord(bad);
    expect(problems.map((problem) => problem.code)).toContain('duplicate-child');
  });

  it('rejects a missing or blank evidence pointer on any status', () => {
    for (const status of ['pass', 'fail', 'not-run'] as const) {
      const entries = ALL_CHILDREN.map((childId) =>
        childId === 'psyche-i7c.10.3'
          ? { childId, status, evidence: '   ' }
          : entry(childId, 'pass'),
      );
      const problems = validatePhaseGateRecord(record(entries));
      expect(problems.map((problem) => problem.code)).toContain('missing-evidence');
    }
  });

  it('rejects an invalid status value', () => {
    const bad = {
      ...allPass(),
      entries: allPass().entries.map((e) =>
        e.childId === 'psyche-i7c.10.2'
          ? { ...e, status: 'skipped' as unknown as Phase10GateEntry['status'] }
          : e,
      ),
    };
    const problems = validatePhaseGateRecord(bad);
    expect(problems.map((problem) => problem.code)).toContain('invalid-status');
  });

  it('rejects closure while any child is not-run', () => {
    const entries = ALL_CHILDREN.map((childId) =>
      childId === 'psyche-i7c.10.5' ? entry(childId, 'not-run') : entry(childId, 'pass'),
    );
    const problems = validatePhaseGateRecord(record(entries, { phaseClosed: true }));
    expect(problems.map((problem) => problem.code)).toContain('invalid-closure');
    expect(problems.find((problem) => problem.code === 'invalid-closure')?.childId).toBe(
      'psyche-i7c.10.5',
    );
  });

  it('rejects closure while any child is failed', () => {
    const entries = ALL_CHILDREN.map((childId) =>
      childId === 'psyche-i7c.10.2' ? entry(childId, 'fail') : entry(childId, 'pass'),
    );
    const problems = validatePhaseGateRecord(record(entries, { phaseClosed: true }));
    expect(problems.map((problem) => problem.code)).toContain('invalid-closure');
  });

  it('rejects a wrong record version', () => {
    const bad = { ...allPass(), version: 2 as unknown as typeof PHASE10_GATE_RECORD_VERSION };
    expect(validatePhaseGateRecord(bad).map((problem) => problem.code)).toContain(
      'invalid-version',
    );
  });

  it('fails closed on a malformed record instead of throwing', () => {
    const malformed = null as unknown as Phase10GateRecord;
    expect(validatePhaseGateRecord(malformed).map((problem) => problem.code)).toContain(
      'invalid-record',
    );
    const noEntries = { version: 1, phaseClosed: false } as unknown as Phase10GateRecord;
    expect(validatePhaseGateRecord(noEntries).map((problem) => problem.code)).toContain(
      'invalid-record',
    );
  });
});

describe('phaseClosureReadiness', () => {
  it('reports readiness when every child has passed', () => {
    const readiness = phaseClosureReadiness(allPass());
    expect(readiness.canClose).toBe(true);
    expect(readiness.recordValid).toBe(true);
    expect(readiness.blockedChildren).toEqual([]);
    expect(readiness).toMatchObject({
      totalChildren: 6,
      passedCount: 6,
      failedCount: 0,
      notRunCount: 0,
    });
  });

  it('blocks on a not-run child and its dependents', () => {
    const entries = ALL_CHILDREN.map((childId) =>
      childId === 'psyche-i7c.10.1' ? entry(childId, 'not-run') : entry(childId, 'pass'),
    );
    const readiness = phaseClosureReadiness(record(entries));
    expect(readiness.canClose).toBe(false);
    const blockedIds = readiness.blockedChildren.map((blocked) => blocked.childId);
    expect(blockedIds).toContain('psyche-i7c.10.1');
    // #211 depends on #210; #213 and #214 depend on it transitively.
    expect(blockedIds).toContain('psyche-i7c.10.2');
    expect(blockedIds).toContain('psyche-i7c.10.4');
    expect(blockedIds).toContain('psyche-i7c.10.5');
  });

  it('blocks a child that self-reports pass over an unpassed prerequisite', () => {
    const entries = ALL_CHILDREN.map((childId) => {
      if (childId === 'psyche-i7c.10.1') {
        return entry(childId, 'fail');
      }
      return entry(childId, 'pass');
    });
    const readiness = phaseClosureReadiness(record(entries));
    expect(readiness.canClose).toBe(false);
    expect(readiness.failedCount).toBe(1);
    const blockedTwo = readiness.blockedChildren.find(
      (blocked) => blocked.childId === 'psyche-i7c.10.2',
    );
    expect(blockedTwo?.reasons.join(' ')).toContain('prerequisite psyche-i7c.10.1');
  });

  it('reports not closed for a valid open record', () => {
    const readiness = phaseClosureReadiness(
      record(ALL_CHILDREN.map((childId) => entry(childId, 'not-run'))),
    );
    expect(readiness.canClose).toBe(false);
    expect(readiness.notRunCount).toBe(6);
    expect(readiness.blockedChildren).toHaveLength(6);
  });

  it('cannot close an invalid record even if statuses look complete', () => {
    const bad = {
      ...allPass(),
      phaseClosed: true,
      entries: [
        ...allPass().entries.slice(0, 5),
        { ...allPass().entries[5]!, evidence: '' },
      ],
    };
    const readiness = phaseClosureReadiness(bad);
    expect(readiness.recordValid).toBe(false);
    expect(readiness.canClose).toBe(false);
    expect(readiness.problems.map((problem) => problem.code)).toContain('missing-evidence');
  });
});
