import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LIFECYCLE_PARENT_MIRROR_ISSUE,
  LIFECYCLE_PARENT_PHASE_ID,
  LIFECYCLE_PHASE_ID,
  LIFECYCLE_PHASE_MIRROR_ISSUE,
  LIFECYCLE_REVIEW_CHECKLIST,
  LIFECYCLE_REVIEW_GROUP_IDS,
  LIFECYCLE_REVIEW_ITEM_IDS,
  LIFECYCLE_REVIEW_RECORD_VERSION,
  LIFECYCLE_REVIEW_ITEMS_BY_ID,
  isSecurityClassItem,
  phaseApproval,
  validatePhaseReview,
  type LifecycleReviewEntry,
  type LifecycleReviewItemId,
} from '../src/review/lifecycleReviewChecklist.js';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

function entry(
  itemId: LifecycleReviewItemId,
  status: LifecycleReviewEntry['status'],
  evidence = `docs/review/evidence/${itemId}.md`,
): LifecycleReviewEntry {
  return { itemId, status, evidence };
}

function record(
  entries: readonly unknown[],
  overrides: { phaseApproved?: boolean; version?: number; reviewer?: string; reviewedHead?: string } = {},
): Record<string, unknown> {
  return {
    version: LIFECYCLE_REVIEW_RECORD_VERSION,
    phaseApproved: overrides.phaseApproved ?? false,
    items: entries,
    ...(overrides.reviewer === undefined ? {} : { reviewer: overrides.reviewer }),
    ...(overrides.reviewedHead === undefined ? {} : { reviewedHead: overrides.reviewedHead }),
  };
}

function allPass(): LifecycleReviewEntry[] {
  return LIFECYCLE_REVIEW_ITEM_IDS.map((itemId) => entry(itemId, 'pass'));
}

function problemCodes(entries: readonly LifecycleReviewEntry[], overrides: { phaseApproved?: boolean } = {}): string[] {
  return validatePhaseReview(record(entries, overrides)).problems.map((problem) => problem.code);
}

describe('lifecycle review checklist registry', () => {
  it('declares the phase identity for psyche-i7c.9.5 / issue 221 under parent psyche-i7c.9 / issue 217', () => {
    expect(LIFECYCLE_PHASE_ID).toBe('psyche-i7c.9.5');
    expect(LIFECYCLE_PHASE_MIRROR_ISSUE).toBe(221);
    expect(LIFECYCLE_PARENT_PHASE_ID).toBe('psyche-i7c.9');
    expect(LIFECYCLE_PARENT_MIRROR_ISSUE).toBe(217);
    expect(LIFECYCLE_REVIEW_RECORD_VERSION).toBe(1);
  });

  it('declares unique, non-empty item ids with exactly the six protocol groups', () => {
    expect(new Set(LIFECYCLE_REVIEW_ITEM_IDS).size).toBe(LIFECYCLE_REVIEW_ITEM_IDS.length);
    expect(LIFECYCLE_REVIEW_ITEM_IDS.length).toBeGreaterThan(0);
    for (const id of LIFECYCLE_REVIEW_ITEM_IDS) {
      expect(id.length, id).toBeGreaterThan(0);
    }
    expect([...LIFECYCLE_REVIEW_GROUP_IDS]).toEqual([
      'host-suites',
      'core-suites',
      'ui-suites',
      'spec-review',
      'security-review',
      'quality-review',
    ]);
    const groups = new Set(LIFECYCLE_REVIEW_CHECKLIST.map((item) => item.group));
    expect([...groups].sort()).toEqual([...LIFECYCLE_REVIEW_GROUP_IDS].sort());
  });

  it('keeps the id list, the checklist, and the descriptor map consistent', () => {
    expect(LIFECYCLE_REVIEW_CHECKLIST.map((item) => item.id)).toEqual([
      ...LIFECYCLE_REVIEW_ITEM_IDS,
    ]);
    for (const item of LIFECYCLE_REVIEW_CHECKLIST) {
      expect(LIFECYCLE_REVIEW_ITEMS_BY_ID.get(item.id), item.id).toBe(item);
      expect(item.label.length, item.id).toBeGreaterThan(0);
      expect(item.requirement.length, item.id).toBeGreaterThan(0);
      expect(item.evidenceHint.length, item.id).toBeGreaterThan(0);
    }
  });

  it('marks exactly the five security no-bypass items and never a suite item', () => {
    const securityItems = LIFECYCLE_REVIEW_CHECKLIST.filter((item) => item.securityClass);
    expect(securityItems.map((item) => item.id)).toEqual([
      'security.merge-safeguard-preservation',
      'security.pr-review-safeguard-preservation',
      'security.stop-retention-boundary',
      'security.destructive-confirmation-integrity',
      'security.authority-scope-idempotency-preservation',
    ]);
    expect(securityItems.every((item) => item.group === 'security-review')).toBe(true);
    expect(isSecurityClassItem('security.merge-safeguard-preservation')).toBe(true);
    expect(isSecurityClassItem('host.merge-action-regressions')).toBe(false);
  });

  it('names only suite files that exist in this repository for mainline items', () => {
    const mainlineItems = LIFECYCLE_REVIEW_CHECKLIST.filter((item) => item.suites.length > 0);
    // Sanity: both mainline-backed and delivered-by-issue items exist.
    expect(mainlineItems.length).toBeGreaterThan(0);
    expect(
      LIFECYCLE_REVIEW_CHECKLIST.filter((item) => item.deliveredByIssue !== undefined).map(
        (item) => item.deliveredByIssue,
      ),
    ).toEqual([220, 220, 220]);
    for (const item of mainlineItems) {
      for (const suite of item.suites) {
        expect(existsSync(path.join(REPO_ROOT, suite)), `${item.id}: ${suite}`).toBe(true);
      }
    }
  });
});

describe('validatePhaseReview', () => {
  it('accepts a well-formed all-pass record with evidence pointers and provenance', () => {
    const result = validatePhaseReview(
      record(allPass(), { reviewer: 'review-agent', reviewedHead: 'abc123' }),
    );
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
    for (const verdict of Object.values(result.verdicts)) {
      expect(verdict).toBe('pass');
    }
  });

  it('accepts a not-run record that does not claim approval for non-security items', () => {
    const entries = LIFECYCLE_REVIEW_ITEM_IDS.map((itemId) =>
      entry(itemId, isSecurityClassItem(itemId) ? 'pass' : 'not-run'),
    );
    const result = validatePhaseReview(record(entries));
    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('treats a record where every item is not-run as invalid because security items cannot be not-run', () => {
    const entries = allPass().map((e) => ({ ...e, status: 'not-run' as const }));
    expect(problemCodes(entries).filter((code) => code === 'security-not-run')).toHaveLength(5);
  });

  it('blocks when a security no-bypass item is not-run, even without an approval claim', () => {
    const entries = allPass().map((e) =>
      e.itemId === 'security.merge-safeguard-preservation'
        ? { ...e, status: 'not-run' as const, evidence: 'review not started yet' }
        : e,
    );
    expect(problemCodes(entries)).toContain('security-not-run');
    const result = validatePhaseReview(record(entries));
    expect(result.valid).toBe(false);
    const problem = result.problems.find((p) => p.code === 'security-not-run');
    expect(problem?.itemId).toBe('security.merge-safeguard-preservation');
  });

  it('blocks when any item fails and reports the failing item', () => {
    const entries = allPass().map((e) =>
      e.itemId === 'core.merge-validation-regressions'
        ? { ...e, status: 'fail' as const, evidence: '__tests__/mergeValidation.test.ts run: 1 failed' }
        : e,
    );
    const result = validatePhaseReview(record(entries, { phaseApproved: false }));
    expect(result.valid).toBe(true);
    expect(result.verdicts['core.merge-validation-regressions']).toBe('fail');
    const summary = phaseApproval(record(entries));
    expect(summary.state).toBe('blocked');
    expect(summary.reasons.map((reason) => reason.code)).toContain('gate-failed');
  });

  it('rejects an unknown checklist item id', () => {
    const entries = [...allPass(), entry('quality.not-a-real-item' as LifecycleReviewItemId, 'pass')];
    const result = validatePhaseReview(record(entries));
    expect(result.problems.map((problem) => problem.code)).toContain('unknown-item');
    expect(result.valid).toBe(false);
  });

  it('rejects a missing checklist item entry', () => {
    const entries = allPass().filter((e) => e.itemId !== 'spec.phase-9-acceptance-criteria');
    const problems = validatePhaseReview(record(entries)).problems;
    expect(problems.map((problem) => problem.code)).toContain('missing-item');
    expect(problems.find((problem) => problem.code === 'missing-item')?.itemId).toBe(
      'spec.phase-9-acceptance-criteria',
    );
  });

  it('rejects a duplicate checklist item entry', () => {
    const entries = [...allPass(), allPass()[0]!];
    expect(validatePhaseReview(record(entries)).problems.map((problem) => problem.code)).toContain(
      'duplicate-item',
    );
  });

  it('rejects a missing, blank, or wrong-typed evidence pointer on any status', () => {
    for (const status of ['pass', 'fail', 'not-run'] as const) {
      for (const evidence of ['', '   ', undefined, 42]) {
        const entries = allPass().map((e) =>
          e.itemId === 'host.pr-action-regressions' ? { ...e, status, evidence } : e,
        );
        const problems = validatePhaseReview(record(entries)).problems;
        expect(problems.map((problem) => problem.code), `status=${status} evidence=${String(evidence)}`).toContain(
          'missing-evidence',
        );
        expect(problems.find((problem) => problem.code === 'missing-evidence')?.itemId).toBe(
          'host.pr-action-regressions',
        );
      }
    }
  });

  it('rejects an invalid status value', () => {
    const entries = allPass().map((e) =>
      e.itemId === 'quality.code-review-severity-triage'
        ? { ...e, status: 'not-applicable' as 'pass' }
        : e,
    );
    const result = validatePhaseReview(record(entries));
    expect(result.problems.map((problem) => problem.code)).toContain('invalid-status');
    expect(result.verdicts['quality.code-review-severity-triage']).toBe('missing');
  });

  it('rejects unknown fields at the record and entry level', () => {
    const badRecord = {
      ...record(allPass()),
      extra: true,
    };
    const badEntry = {
      ...record([
        ...allPass().slice(0, 1),
        { ...allPass()[0]!, itemId: allPass()[1]!.itemId, extra: 1 },
        ...allPass().slice(2),
      ]),
    };
    expect(validatePhaseReview(badRecord).problems.map((problem) => problem.code)).toContain('unknown-field');
    expect(validatePhaseReview(badEntry).problems.map((problem) => problem.code)).toContain('unknown-field');
  });

  it('rejects a wrong or missing record version', () => {
    expect(
      validatePhaseReview({ ...record(allPass()), version: 2 }).problems.map((problem) => problem.code),
    ).toContain('invalid-version');
    const { version: _version, ...noVersion } = record(allPass());
    expect(
      validatePhaseReview(noVersion).problems.map((problem) => problem.code),
    ).toContain('invalid-version');
  });

  it('rejects a non-boolean phaseApproved claim and non-string optional provenance', () => {
    const badClaim = { ...record(allPass()), phaseApproved: 'yes' };
    expect(
      validatePhaseReview(badClaim).problems.map((problem) => problem.code),
    ).toContain('invalid-field-type');
    const badReviewer = { ...record(allPass()), reviewer: 7 };
    expect(
      validatePhaseReview(badReviewer).problems.map((problem) => problem.code),
    ).toContain('invalid-field-type');
  });

  it('rejects an approval claim while any item is fail, not-run, or missing', () => {
    const failed = allPass().map((e) =>
      e.itemId === 'host.remote-action-dispatch' ? { ...e, status: 'fail' as const } : e,
    );
    expect(
      validatePhaseReview(record(failed, { phaseApproved: true })).problems.map(
        (problem) => problem.code,
      ),
    ).toContain('invalid-approval');

    const skipped = allPass().map((e) =>
      e.itemId === 'ui.merge-pr-interactive-fixtures' ? { ...e, status: 'not-run' as const } : e,
    );
    expect(
      validatePhaseReview(record(skipped, { phaseApproved: true })).problems.map(
        (problem) => problem.code,
      ),
    ).toContain('invalid-approval');

    const incomplete = allPass().slice(0, allPass().length - 1);
    expect(
      validatePhaseReview(record(incomplete, { phaseApproved: true })).problems.map(
        (problem) => problem.code,
      ),
    ).toContain('invalid-approval');
  });

  it('fails closed without throwing on malformed records', () => {
    for (const malformed of [null, undefined, 42, 'record', [], [allPass()[0]]]) {
      const result = validatePhaseReview(malformed);
      expect(result.valid, JSON.stringify(malformed)).toBe(false);
      expect(result.problems.map((problem) => problem.code)).toContain('invalid-record');
      expect(result.verdicts['host.merge-action-regressions']).toBe('missing');
    }
  });

  it('rejects a non-object entry', () => {
    const entries = [...allPass(), 'security.merge-safeguard-preservation'];
    const result = validatePhaseReview(record(entries));
    expect(result.problems.map((problem) => problem.code)).toContain('invalid-entry');
  });
});

describe('phaseApproval', () => {
  it('approves only a valid record where every checklist item passed', () => {
    const summary = phaseApproval(record(allPass(), { phaseApproved: true }));
    expect(summary.state).toBe('approved');
    expect(summary.approved).toBe(true);
    expect(summary.reasons).toEqual([]);
    expect(summary.recordValid).toBe(true);
    expect(summary.counts).toEqual({
      pass: LIFECYCLE_REVIEW_ITEM_IDS.length,
      fail: 0,
      notRun: 0,
      missing: 0,
      total: LIFECYCLE_REVIEW_ITEM_IDS.length,
    });
  });

  it('blocks with gate-failed reasons when a suite item failed', () => {
    const entries = allPass().map((e) =>
      e.itemId === 'core.mobile-gateway-action-boundary'
        ? { ...e, status: 'fail' as const, evidence: 'gateway scope regression observed' }
        : e,
    );
    const summary = phaseApproval(record(entries));
    expect(summary.approved).toBe(false);
    expect(summary.counts.fail).toBe(1);
    const reason = summary.reasons.find((r) => r.code === 'gate-failed');
    expect(reason?.itemId).toBe('core.mobile-gateway-action-boundary');
    expect(reason?.message).toContain('Mobile gateway action boundary regressions');
  });

  it('blocks with gate-not-run reasons while a non-security item is not run', () => {
    const entries = allPass().map((e) =>
      e.itemId === 'ui.stop-close-cleanup-fixtures'
        ? { ...e, status: 'not-run' as const, evidence: 'blocked by #220 fixture suites' }
        : e,
    );
    const summary = phaseApproval(record(entries));
    expect(summary.approved).toBe(false);
    expect(summary.state).toBe('blocked');
    expect(summary.counts.notRun).toBe(1);
    const reason = summary.reasons.find((r) => r.code === 'gate-not-run');
    expect(reason?.itemId).toBe('ui.stop-close-cleanup-fixtures');
  });

  it('blocks on a missing entry with a gate-missing reason', () => {
    const entries = allPass().filter((e) => e.itemId !== 'quality.code-review-severity-triage');
    const summary = phaseApproval(record(entries));
    expect(summary.approved).toBe(false);
    expect(summary.counts.missing).toBe(1);
    expect(summary.reasons.map((reason) => reason.code)).toContain('gate-missing');
  });

  it('blocks an invalid record and surfaces the security-not-run problem', () => {
    const entries = allPass().map((e) =>
      e.itemId === 'security.authority-scope-idempotency-preservation'
        ? { ...e, status: 'not-run' as const, evidence: 'security review pending' }
        : e,
    );
    const summary = phaseApproval(record(entries));
    expect(summary.recordValid).toBe(false);
    expect(summary.approved).toBe(false);
    expect(summary.problems.map((problem) => problem.code)).toContain('security-not-run');
    expect(summary.reasons[0]?.code).toBe('record-invalid');
    expect(summary.reasons.map((reason) => reason.code)).toContain('gate-not-run');
  });

  it('blocks structurally invalid records with a record-invalid reason', () => {
    const summary = phaseApproval(null);
    expect(summary.state).toBe('blocked');
    expect(summary.recordValid).toBe(false);
    expect(summary.reasons[0]?.code).toBe('record-invalid');
    expect(summary.counts.missing).toBe(LIFECYCLE_REVIEW_ITEM_IDS.length);
  });

  it('is deterministic across calls', () => {
    const input = record(allPass());
    expect(phaseApproval(input)).toEqual(phaseApproval(input));
  });
});
