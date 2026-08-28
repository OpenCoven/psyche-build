import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  TRACKER_DRIFT_FINDING_LIMIT,
  validateTrackerDrift,
  type DriftBead,
  type DriftManagedIssue,
} from '../scripts/beads-project-sync/drift.mjs';

const canonicalTargets = {
  'gh-200': { issue: 200, title: 'iOS internal beta and continuity', priority: 1 as const },
  'gh-246': { issue: 246, title: 'Cross-platform Vim and keyboard-mode parity', priority: 2 as const },
};

function body(status: string, priority: number, hash = 'a'.repeat(64)): string {
  return [
    '<!-- psyche-bead-sync:v1 bead-id=psyche-test -->',
    '',
    '## Source metadata',
    `- Source status: ${status}`,
    `- Source priority: P${priority}`,
    '',
    `<!-- psyche-bead-sync:v1 render-hash=${hash} -->`,
  ].join('\n');
}

function issue(overrides: Partial<DriftManagedIssue> = {}): DriftManagedIssue {
  return {
    beadId: 'psyche-test',
    number: 206,
    state: 'closed',
    labels: ['bead', 'priority:P1'],
    body: body('closed', 1),
    renderHash: 'a'.repeat(64),
    ...overrides,
  };
}

function bead(overrides: Partial<DriftBead> = {}): DriftBead {
  return {
    id: 'psyche-test',
    status: 'closed',
    priority: 1,
    externalRef: 'gh-200',
    ...overrides,
  };
}

describe('tracker drift validation', () => {
  it('passes a reconciled closed Bead and closed generated mirror', () => {
    const report = validateTrackerDrift([bead()], [issue()], canonicalTargets);

    expect(report).toEqual({
      schemaVersion: 1,
      result: 'pass',
      sourceCount: 1,
      managedMirrorCount: 1,
      canonicalOutcomeCount: 0,
      findingCount: 0,
      findings: [],
      findingsOmitted: 0,
    });
  });

  it('detects the former psyche-310 class of source/mirror state mismatch', () => {
    const report = validateTrackerDrift(
      [bead({ status: 'closed' })],
      [issue({ state: 'open', body: body('closed', 1) })],
      canonicalTargets,
    );

    expect(report.result).toBe('fail');
    expect(report.findings).toContainEqual({
      kind: 'state_mismatch',
      beadId: 'psyche-test',
      issueNumber: 206,
      sourceStatus: 'closed',
      mirrorState: 'open',
    });
  });

  it('detects mirror priority and generated source-metadata drift', () => {
    const report = validateTrackerDrift(
      [bead({ status: 'in_progress', priority: 1, externalRef: 'gh-200' })],
      [issue({
        state: 'open',
        labels: ['bead', 'priority:P0'],
        body: body('open', 0),
      })],
      canonicalTargets,
    );

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      'priority_mismatch',
      'source_priority_metadata_mismatch',
      'source_status_metadata_mismatch',
    ]);
  });

  it('detects missing, duplicate, orphan, and unverifiable generated mirrors', () => {
    const report = validateTrackerDrift(
      [
        bead({ id: 'psyche-missing' }),
        bead({ id: 'psyche-test' }),
      ],
      [
        issue({ renderHash: null }),
        issue({ number: 207 }),
        issue({ beadId: 'psyche-orphan', number: 208 }),
      ],
      canonicalTargets,
    );

    expect(new Set(report.findings.map((finding) => finding.kind))).toEqual(new Set([
      'duplicate_mirror',
      'missing_mirror',
      'missing_render_hash',
      'orphan_mirror',
    ]));
  });

  it('retains only bounded identifiers and counts omitted findings', () => {
    const beads = Array.from({ length: TRACKER_DRIFT_FINDING_LIMIT + 25 }, (_, index) =>
      bead({ id: `psyche-missing-${String(index).padStart(3, '0')}` }));

    const report = validateTrackerDrift(beads, [], canonicalTargets);

    expect(report.result).toBe('fail');
    expect(report.findingCount).toBe(TRACKER_DRIFT_FINDING_LIMIT + 25);
    expect(report.findings).toHaveLength(TRACKER_DRIFT_FINDING_LIMIT);
    expect(report.findingsOmitted).toBe(25);
    expect(JSON.stringify(report)).not.toContain('description');
    expect(JSON.stringify(report)).not.toContain('prompt');
    expect(JSON.stringify(report)).not.toContain('path');
  });

  it('retains canonical outcome validation as the source-side P0/P1 contract', () => {
    expect(() => validateTrackerDrift(
      [bead({ status: 'in_progress', priority: 0, externalRef: 'gh-200' })],
      [issue({ state: 'open', labels: ['priority:P0'], body: body('in_progress', 0) })],
      canonicalTargets,
    )).toThrow(/priority P0 does not match gh-200 priority P1/i);
  });

  it('runs the documented offline command without network or Beads bootstrap', () => {
    const result = spawnSync(process.execPath, [
      'scripts/validate-beads-tracker.mjs',
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
      '--issues-file',
      '__tests__/fixtures/beads-project-sync/tracker-issues.json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_TOKEN: 'must-not-be-used',
        GITHUB_TOKEN: 'must-not-be-used',
        BEADS_PROJECT_TOKEN: 'must-not-be-used',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      result: 'pass',
      sourceCount: 2,
      managedMirrorCount: 2,
      canonicalOutcomeCount: 1,
      findingCount: 0,
    });
  });
});
