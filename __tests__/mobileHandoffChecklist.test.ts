import { describe, expect, it } from 'vitest';
import {
  HANDOFF_CHECKLIST,
  HANDOFF_CHECKLIST_ITEM_IDS,
  HANDOFF_PHASE_IDS,
  HANDOFF_RECORD_SCHEMA_VERSION,
  groupHandoffChecklistByPhase,
  handoffReadiness,
  validateHandoffRecord,
  type HandoffItemStatus,
  type HandoffRecord,
} from '../src/review/handoffChecklist.js';

const BASE_EVIDENCE = 'docs/review/MOBILE-BRANCH-HANDOFF.md handoff record';

function buildValidRecord(): HandoffRecord {
  return {
    schemaVersion: HANDOFF_RECORD_SCHEMA_VERSION,
    branch: 'feat/mobile-multiproject-cockpit',
    reviewedHead: 'a4546f4000000000000000000000000000000000',
    reviewer: 'final-review-agent',
    items: Object.fromEntries(
      HANDOFF_CHECKLIST.map((item) => [
        item.id,
        { status: 'pass' as const, evidence: `${BASE_EVIDENCE}#${item.id}` },
      ]),
    ),
  };
}

function setVerdict(
  record: HandoffRecord,
  itemId: string,
  status: HandoffItemStatus,
  evidence?: string,
): void {
  record.items[itemId] = evidence === undefined ? { status } : { status, evidence };
}

describe('mobile handoff checklist contract (schema v1)', () => {
  it('accepts a complete record where every gate passed with evidence', () => {
    const record = buildValidRecord();
    const validation = validateHandoffRecord(record);

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    for (const item of HANDOFF_CHECKLIST) {
      expect(validation.verdicts[item.id]).toBe('pass');
    }

    const readiness = handoffReadiness(record);
    expect(readiness.state).toBe('ready');
    expect(readiness.reasons).toEqual([]);
    expect(readiness.counts).toEqual({
      pass: HANDOFF_CHECKLIST.length,
      fail: 0,
      notRun: 0,
      notApplicable: 0,
      total: HANDOFF_CHECKLIST.length,
    });
  });

  it('blocks the handoff when a gate is failed', () => {
    const record = buildValidRecord();
    setVerdict(record, 'handoff.independent-review', 'fail', 'review notes with open Important finding');

    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(true);
    expect(validation.verdicts['handoff.independent-review']).toBe('fail');

    const readiness = handoffReadiness(record);
    expect(readiness.state).toBe('blocked');
    expect(readiness.reasons).toHaveLength(1);
    expect(readiness.reasons[0]).toMatchObject({
      code: 'gate-failed',
      itemId: 'handoff.independent-review',
    });
    expect(readiness.counts.fail).toBe(1);
  });

  it('blocks the handoff when a gate is explicitly not run', () => {
    const record = buildValidRecord();
    setVerdict(record, 'handoff.beads-lint', 'not-run');

    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(true);

    const readiness = handoffReadiness(record);
    expect(readiness.state).toBe('blocked');
    expect(readiness.reasons).toHaveLength(1);
    expect(readiness.reasons[0]).toMatchObject({
      code: 'gate-not-run',
      itemId: 'handoff.beads-lint',
    });
    expect(readiness.counts.notRun).toBe(1);
  });

  it('treats an omitted checklist item as not-run and blocks the handoff', () => {
    const record = buildValidRecord();
    delete record.items['i7c.10.4.performance-acceptance-matrix'];

    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues[0]).toMatchObject({
      code: 'missing-item',
      itemId: 'i7c.10.4.performance-acceptance-matrix',
    });

    const readiness = handoffReadiness(record);
    expect(readiness.state).toBe('blocked');
    expect(readiness.reasons.map((reason) => reason.code)).toEqual([
      'record-invalid',
      'gate-not-run',
    ]);
  });

  it('rejects unknown checklist item ids', () => {
    const record = buildValidRecord();
    setVerdict(
      record,
      'i7c.10.999.bogus-gate',
      'pass',
      `${BASE_EVIDENCE}#bogus`,
    );

    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues[0]).toMatchObject({
      code: 'unknown-item',
      field: 'items.i7c.10.999.bogus-gate',
    });
    expect(handoffReadiness(record).state).toBe('blocked');
  });

  it('requires an evidence pointer for every decided verdict', () => {
    for (const status of ['pass', 'fail', 'not-applicable'] as const) {
      const record = buildValidRecord();
      setVerdict(record, 'handoff.clean-worktree', status);

      const validation = validateHandoffRecord(record);
      expect(validation.valid).toBe(false);
      expect(validation.issues).toHaveLength(1);
      expect(validation.issues[0]).toMatchObject({
        code: 'missing-evidence',
        itemId: 'handoff.clean-worktree',
        field: 'evidence',
      });
      expect(handoffReadiness(record).state).toBe('blocked');
    }
  });

  it('rejects a whitespace-only evidence pointer', () => {
    const record = buildValidRecord();
    setVerdict(record, 'handoff.clean-worktree', 'pass', '   ');

    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(false);
    expect(validation.issues[0]).toMatchObject({ code: 'missing-evidence' });
  });

  it('rejects evidence claimed by a not-run item', () => {
    const record = buildValidRecord();
    setVerdict(record, 'handoff.beads-dep-cycles', 'not-run', `${BASE_EVIDENCE}#deps`);

    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(false);
    expect(validation.issues[0]).toMatchObject({
      code: 'evidence-not-allowed',
      itemId: 'handoff.beads-dep-cycles',
    });
  });

  it('rejects unknown fields at the record root and inside items', () => {
    const rootAugmented = buildValidRecord() as unknown as Record<string, unknown>;
    rootAugmented.autoApproved = true;
    const rootValidation = validateHandoffRecord(rootAugmented);
    expect(rootValidation.valid).toBe(false);
    expect(rootValidation.issues).toContainEqual(
      expect.objectContaining({ code: 'unknown-field', field: 'autoApproved' }),
    );

    const record = buildValidRecord();
    (record.items['handoff.spec-review'] as unknown as Record<string, unknown>).note = 'looks fine';
    const validation = validateHandoffRecord(record);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContainEqual(
      expect.objectContaining({
        code: 'unknown-field',
        itemId: 'handoff.spec-review',
        field: 'items.handoff.spec-review.note',
      }),
    );
    expect(handoffReadiness(record).state).toBe('blocked');
  });

  it('rejects missing, unsupported, or mistyped schema versions', () => {
    const missing = buildValidRecord();
    delete (missing as unknown as Record<string, unknown>).schemaVersion;
    expect(validateHandoffRecord(missing).issues).toContainEqual(
      expect.objectContaining({ code: 'schema-version-missing' }),
    );

    const unsupported = { ...buildValidRecord(), schemaVersion: 2 };
    expect(validateHandoffRecord(unsupported).issues).toContainEqual(
      expect.objectContaining({ code: 'schema-version-unsupported' }),
    );

    const mistyped = { ...buildValidRecord(), schemaVersion: '1' };
    expect(validateHandoffRecord(mistyped).issues).toContainEqual(
      expect.objectContaining({ code: 'invalid-field-type' }),
    );
  });

  it('rejects records that are not plain objects', () => {
    for (const record of [null, 'record', 42, []]) {
      const validation = validateHandoffRecord(record);
      expect(validation.valid).toBe(false);
      expect(validation.issues[0].code).toBe('invalid-record');
      expect(handoffReadiness(record).state).toBe('blocked');
    }
  });

  it('keeps the typed checklist ids, phases, and grouping consistent', () => {
    const ids = HANDOFF_CHECKLIST.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...HANDOFF_CHECKLIST_ITEM_IDS]);

    const grouped = groupHandoffChecklistByPhase();
    expect(Object.keys(grouped)).toEqual([...HANDOFF_PHASE_IDS]);
    expect(grouped['i7c.9'].every((item) => item.gate.bead.startsWith('psyche-i7c.9'))).toBe(true);
    expect(grouped['i7c.10'].every((item) => item.gate.bead.startsWith('psyche-i7c.10'))).toBe(true);
    expect(grouped.handoff.every((item) => item.gate.bead === 'handoff')).toBe(true);

    const regrouped = HANDOFF_PHASE_IDS.flatMap((phase) => grouped[phase].map((item) => item.id));
    expect(regrouped).toEqual(ids);

    for (const item of HANDOFF_CHECKLIST) {
      expect(item.evidenceHint.trim().length).toBeGreaterThan(0);
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });
});
