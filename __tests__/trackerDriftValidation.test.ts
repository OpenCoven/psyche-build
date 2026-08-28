import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TRACKER_DRIFT_FINDING_LIMIT,
  validateTrackerDrift,
  type DriftBead,
  type DriftManagedIssue,
} from '../scripts/beads-project-sync/drift.mjs';
import {
  loadPublicGitHubIssues,
  runTrackerDriftCheck,
} from '../scripts/validate-beads-tracker.mjs';

const canonicalTargets = {
  'gh-200': { issue: 200, title: 'iOS internal beta and continuity', priority: 1 as const },
  'gh-246': { issue: 246, title: 'Cross-platform Vim and keyboard-mode parity', priority: 2 as const },
};

function body(
  status: string,
  priority: number,
  hash?: string,
  beadId = 'psyche-test',
): string {
  const renderedBody = [
    `<!-- psyche-bead-sync:v1 bead-id=${beadId} -->`,
    '',
    '## Source metadata',
    `- Source status: ${status}`,
    `- Source priority: P${priority}`,
  ].join('\n');
  const renderHash = hash ?? createHash('sha256').update(renderedBody).digest('hex');
  return `${renderedBody}\n\n<!-- psyche-bead-sync:v1 render-hash=${renderHash} -->`;
}

function issue(overrides: Partial<DriftManagedIssue> = {}): DriftManagedIssue {
  const managedBody = overrides.body ?? body('closed', 1);
  const renderHash = Object.hasOwn(overrides, 'renderHash')
    ? overrides.renderHash
    : managedBody?.match(/render-hash=([a-f0-9]{64})/u)?.[1] ?? null;
  return {
    beadId: 'psyche-test',
    number: 206,
    state: 'closed',
    labels: ['bead', 'priority:P1'],
    body: managedBody,
    renderHash,
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

function rawIssue(
  beadId: string,
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    state: 'open',
    body: body('open', 1, undefined, beadId),
    user: { login: 'BunsDev' },
    labels: [{ name: 'bead' }, { name: 'priority:P1' }],
    ...overrides,
  };
}

function outputBuffer(): { write: (value: string) => boolean; value: () => string } {
  let output = '';
  return {
    write(value) {
      output += value;
      return true;
    },
    value: () => output,
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

    expect(report.findings).toEqual([
      {
        kind: 'priority_mismatch',
        beadId: 'psyche-test',
        issueNumber: 206,
        sourcePriority: 1,
      },
      {
        kind: 'source_priority_metadata_mismatch',
        beadId: 'psyche-test',
        issueNumber: 206,
        sourcePriority: 1,
        mirrorSourcePriority: 0,
      },
      {
        kind: 'source_status_metadata_mismatch',
        beadId: 'psyche-test',
        issueNumber: 206,
        sourceStatus: 'in_progress',
        mirrorState: 'open',
        mirrorSourceStatus: 'open',
      },
    ]);
  });

  it('detects a stale valid-looking render hash without exposing issue body content', () => {
    const privateBody = 'PRIVATE-STALE-RENDER-SENTINEL';
    const managedBody = body('closed', 1).replace(
      '\n\n<!-- psyche-bead-sync:v1 render-hash=',
      `\n\n${privateBody}\n\n<!-- psyche-bead-sync:v1 render-hash=`,
    );
    const report = validateTrackerDrift(
      [bead()],
      [issue({ body: managedBody })],
      canonicalTargets,
    );

    expect(report.findings).toContainEqual({
      kind: 'render_hash_mismatch',
      beadId: 'psyche-test',
      issueNumber: 206,
    });
    expect(JSON.stringify(report)).not.toContain(privateBody);
  });

  it('rejects extra managed priority labels and obsolete release-blocker metadata', () => {
    const report = validateTrackerDrift(
      [bead()],
      [issue({
        labels: [
          'bead',
          'priority:P1',
          'priority:P0',
          'release-blocker',
          'unrelated-public-label',
        ],
      })],
      canonicalTargets,
    );

    expect(report.findings).toEqual([
      {
        kind: 'obsolete_blocker_metadata',
        beadId: 'psyche-test',
        issueNumber: 206,
      },
      {
        kind: 'priority_mismatch',
        beadId: 'psyche-test',
        issueNumber: 206,
        sourcePriority: 1,
      },
    ]);
  });

  it('rejects noncanonical labels in the managed priority namespace', () => {
    const report = validateTrackerDrift(
      [bead()],
      [issue({ labels: ['bead', 'priority:P1', 'priority:urgent', 'triage'] })],
      canonicalTargets,
    );

    expect(report.findings).toEqual([{
      kind: 'priority_mismatch',
      beadId: 'psyche-test',
      issueNumber: 206,
      sourcePriority: 1,
    }]);
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

  it('reports canonical mapping failures as bounded source-side drift', () => {
    const beads = [
      bead({ id: 'canonical-missing', status: 'open', externalRef: null }),
      bead({ id: 'canonical-malformed', status: 'open', externalRef: 'issue-200' }),
      bead({ id: 'canonical-unknown', status: 'open', externalRef: 'gh-999' }),
      bead({ id: 'canonical-priority', status: 'open', priority: 0, externalRef: 'gh-200' }),
    ];
    const issues = beads.map((source, index) => issue({
      beadId: source.id,
      number: 400 + index,
      state: 'open',
      labels: [`priority:P${source.priority}`],
      body: body(source.status, source.priority),
    }));

    const report = validateTrackerDrift(beads, issues, canonicalTargets);

    expect(report.result).toBe('fail');
    expect(report.canonicalOutcomeCount).toBe(1);
    expect(report.findings).toEqual([
      {
        kind: 'canonical_mapping_malformed',
        beadId: 'canonical-malformed',
        sourceStatus: 'open',
        sourcePriority: 1,
      },
      {
        kind: 'canonical_mapping_missing',
        beadId: 'canonical-missing',
        sourceStatus: 'open',
        sourcePriority: 1,
      },
      {
        kind: 'canonical_priority_mismatch',
        beadId: 'canonical-priority',
        issueNumber: 200,
        sourceStatus: 'open',
        sourcePriority: 0,
      },
      {
        kind: 'canonical_mapping_unknown',
        beadId: 'canonical-unknown',
        issueNumber: 999,
        sourceStatus: 'open',
        sourcePriority: 1,
      },
    ]);
    expect(JSON.stringify(report)).not.toContain('issue-200');
  });

  it('counts canonical drift omitted beyond the retained finding limit', () => {
    const beads = Array.from({ length: TRACKER_DRIFT_FINDING_LIMIT + 25 }, (_, index) =>
      bead({
        id: `canonical-missing-${String(index).padStart(3, '0')}`,
        status: 'open',
        externalRef: null,
      }));
    const issues = beads.map((source, index) => issue({
      beadId: source.id,
      number: 500 + index,
      state: 'open',
      labels: ['priority:P1'],
      body: body('open', 1),
    }));

    const report = validateTrackerDrift(beads, issues, canonicalTargets);

    expect(report.result).toBe('fail');
    expect(report.findingCount).toBe(TRACKER_DRIFT_FINDING_LIMIT + 25);
    expect(report.findings).toHaveLength(TRACKER_DRIFT_FINDING_LIMIT);
    expect(report.findingsOmitted).toBe(25);
  });

  it('returns exit 1 with JSON evidence for canonical source drift', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads-canonical-drift.jsonl',
      '--issues-file',
      '__tests__/fixtures/beads-project-sync/tracker-issues.json',
    ], { stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    expect(JSON.parse(stdout.value())).toMatchObject({
      result: 'fail',
      findings: [{
        kind: 'canonical_mapping_missing',
        beadId: 'tracker-open',
        sourceStatus: 'open',
        sourcePriority: 1,
      }],
    });
  });

  it('returns exit 1 with bounded drift for a malformed active external_ref', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads-malformed-ref.jsonl',
      '--issues-file',
      '__tests__/fixtures/beads-project-sync/tracker-issues.json',
    ], { stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    expect(JSON.parse(stdout.value())).toMatchObject({
      result: 'fail',
      findings: [{
        kind: 'canonical_mapping_malformed',
        beadId: 'tracker-open',
        sourceStatus: 'open',
        sourcePriority: 1,
      }],
    });
    expect(stdout.value()).not.toContain('issue-PRIVATE-TARGET');
  });

  it('returns exit 2 when inventory evidence cannot be established', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/invalid-timestamp.jsonl',
    ], { rawIssues: [], stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stdout.value()).toBe('');
    expect(stderr.value()).toMatch(/^Tracker drift validation failed:/u);
  });

  it('reports malformed managed markers without aborting the remaining inventory', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const privateBody = 'PRIVATE-BODY-SENTINEL';
    const rawIssues = [
      rawIssue('tracker-open', 301, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=tracker-open -->',
          '<!-- psyche-bead-sync:v1 bead-id=tracker-open -->',
          `<!-- psyche-bead-sync:v1 render-hash=${'c'.repeat(64)} -->`,
          `<!-- psyche-bead-sync:v1 render-hash=${'d'.repeat(64)} -->`,
          privateBody,
        ].join('\n'),
      }),
      rawIssue('unused', 303, {
        body: `<!-- psyche-bead-sync:v1 bead-id= -->\n${privateBody}`,
      }),
      rawIssue('tracker-closed', 302, {
        state: 'closed',
        body: body('closed', 0, undefined, 'tracker-closed'),
        labels: [{ name: 'bead' }, { name: 'priority:P0' }],
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    const report = JSON.parse(stdout.value());
    expect(report.managedMirrorCount).toBe(3);
    expect(report.findings).toEqual(expect.arrayContaining([
      { kind: 'duplicate_bead_marker', beadId: 'tracker-open', issueNumber: 301 },
      { kind: 'empty_bead_marker', issueNumber: 303 },
      {
        kind: 'missing_mirror',
        beadId: 'tracker-open',
        sourceStatus: 'open',
        sourcePriority: 1,
      },
    ]));
    expect(stdout.value()).not.toContain(privateBody);
    expect(stderr.value()).not.toContain(privateBody);
  });

  it('reports independent Bead and render-hash marker findings before identity checks', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const privateBody = 'PRIVATE-COMBINED-MARKER-SENTINEL';
    const rawIssues = [
      rawIssue('unused', 301, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=not a valid id -->',
          '<!-- psyche-bead-sync:v1 render-hash -->',
          privateBody,
        ].join('\n'),
      }),
      rawIssue('tracker-closed', 302, {
        body: body('closed', 0, undefined, 'tracker-closed'),
        labels: [{ name: 'bead' }, { name: 'priority:P0' }],
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    const report = JSON.parse(stdout.value());
    expect(report.managedMirrorCount).toBe(2);
    expect(report.findings).toEqual([
      { kind: 'malformed_bead_marker', issueNumber: 301 },
      { kind: 'malformed_render_hash_marker', issueNumber: 301 },
      {
        kind: 'state_mismatch',
        beadId: 'tracker-closed',
        issueNumber: 302,
        sourceStatus: 'closed',
        mirrorState: 'open',
      },
      {
        kind: 'missing_mirror',
        beadId: 'tracker-open',
        sourceStatus: 'open',
        sourcePriority: 1,
      },
    ]);
    expect(stdout.value()).not.toContain(privateBody);
    expect(stderr.value()).not.toContain(privateBody);
  });

  it('treats a generated Bead marker missing equals as malformed but ignores prose', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const privateBody = 'PRIVATE-MISSING-EQUALS-SENTINEL';
    const rawIssues = [
      rawIssue('unused', 305, {
        body: [
          'Generated mirrors mention bead-id in documentation.',
          '<!-- psyche-bead-sync:v1 bead-id -->',
          `<!-- psyche-bead-sync:v1 render-hash=${'a'.repeat(64)} -->`,
          privateBody,
        ].join('\n'),
      }),
      rawIssue('unused', 306, {
        body: 'Ordinary issue prose can mention bead-id without becoming managed.',
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    const report = JSON.parse(stdout.value());
    expect(report.managedMirrorCount).toBe(1);
    expect(report.findings).toContainEqual({
      kind: 'malformed_bead_marker',
      issueNumber: 305,
    });
    expect(report.findings).not.toContainEqual(expect.objectContaining({ issueNumber: 306 }));
    expect(stdout.value()).not.toContain(privateBody);
    expect(stderr.value()).not.toContain(privateBody);
  });

  it('rejects marker case variants and retains render-only managed metadata', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const rawIssues = [
      rawIssue('tracker-open', 305, {
        body: [
          '<!-- PSYCHE-BEAD-SYNC:V1 BEAD-ID=tracker-open -->',
          '<!-- PSYCHE-BEAD-SYNC:V1 RENDER-HASH=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -->',
        ].join('\n'),
      }),
      rawIssue('unused', 306, {
        body: `<!-- psyche-bead-sync:v1 render-hash=${'b'.repeat(64)} -->`,
      }),
      rawIssue('tracker-open', 307, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=tracker-open  -->',
          `<!-- psyche-bead-sync:v1 render-hash=${'c'.repeat(64)} -->`,
        ].join('\n'),
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    const report = JSON.parse(stdout.value());
    expect(report.managedMirrorCount).toBe(3);
    expect(report.findings).toEqual(expect.arrayContaining([
      { kind: 'malformed_bead_marker', issueNumber: 305 },
      { kind: 'malformed_render_hash_marker', issueNumber: 305 },
      { kind: 'missing_bead_marker', issueNumber: 306 },
      { kind: 'malformed_bead_marker', issueNumber: 307 },
    ]));
  });

  it('reports malformed render-hash markers without aborting the remaining inventory', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const privateBody = 'PRIVATE-RENDER-HASH-SENTINEL';
    const rawIssues = [
      rawIssue('tracker-open', 301, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=tracker-open -->',
          '',
          '## Source metadata',
          '- Source status: open',
          '- Source priority: P1',
          '',
          `<!-- psyche-bead-sync:v1 render-hash=${'c'.repeat(64)} -->`,
          `<!-- psyche-bead-sync:v1 render-hash=${'d'.repeat(64)} -->`,
          privateBody,
        ].join('\n'),
      }),
      rawIssue('tracker-empty', 303, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=tracker-empty -->',
          '<!-- psyche-bead-sync:v1 render-hash= -->',
          privateBody,
        ].join('\n'),
      }),
      rawIssue('tracker-malformed', 304, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=tracker-malformed -->',
          '<!-- psyche-bead-sync:v1 render-hash=not-a-sha -->',
          privateBody,
        ].join('\n'),
      }),
      rawIssue('tracker-closed', 302, {
        body: body('closed', 0, undefined, 'tracker-closed'),
        labels: [{ name: 'bead' }, { name: 'priority:P0' }],
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    const report = JSON.parse(stdout.value());
    expect(report.managedMirrorCount).toBe(4);
    expect(report.findings).toEqual([
      {
        kind: 'state_mismatch',
        beadId: 'tracker-closed',
        issueNumber: 302,
        sourceStatus: 'closed',
        mirrorState: 'open',
      },
      { kind: 'empty_render_hash_marker', beadId: 'tracker-empty', issueNumber: 303 },
      {
        kind: 'orphan_mirror',
        beadId: 'tracker-empty',
        issueNumber: 303,
        mirrorState: 'open',
      },
      { kind: 'malformed_render_hash_marker', beadId: 'tracker-malformed', issueNumber: 304 },
      {
        kind: 'orphan_mirror',
        beadId: 'tracker-malformed',
        issueNumber: 304,
        mirrorState: 'open',
      },
      { kind: 'duplicate_render_hash_marker', beadId: 'tracker-open', issueNumber: 301 },
    ]);
    expect(stdout.value()).not.toContain(privateBody);
    expect(stderr.value()).not.toContain(privateBody);
  });

  it('reports an empty render-hash marker even when another valid marker is present', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const rawIssues = [
      rawIssue('tracker-open', 301, {
        body: [
          '<!-- psyche-bead-sync:v1 bead-id=tracker-open -->',
          '<!-- psyche-bead-sync:v1 render-hash= -->',
          `<!-- psyche-bead-sync:v1 render-hash=${'a'.repeat(64)} -->`,
        ].join('\n'),
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(stderr.value()).toBe('');
    expect(JSON.parse(stdout.value()).findings).toEqual(expect.arrayContaining([
      { kind: 'duplicate_render_hash_marker', beadId: 'tracker-open', issueNumber: 301 },
      { kind: 'empty_render_hash_marker', beadId: 'tracker-open', issueNumber: 301 },
    ]));
  });

  it('matches trusted GitHub authors case-insensitively', async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const rawIssues = [
      rawIssue('tracker-open', 301, { user: { login: 'BUNSDEV' } }),
      rawIssue('tracker-closed', 302, {
        state: 'closed',
        body: body('closed', 0, undefined, 'tracker-closed'),
        labels: [{ name: 'bead' }, { name: 'priority:P0' }],
        user: { login: 'BuNsDeV' },
      }),
    ];

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
    ], { rawIssues, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stderr.value()).toBe('');
    expect(JSON.parse(stdout.value())).toMatchObject({
      result: 'pass',
      managedMirrorCount: 2,
    });
  });

  it('loads more than ten GitHub issue pages without ambient authorization', async () => {
    const requests: Array<{ url: string; headers: RequestInit['headers'] }> = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      const page = Number(new URL(url).searchParams.get('page'));
      requests.push({ url, headers: init?.headers });
      const items = page <= 11
        ? Array.from({ length: 100 }, (_, index) => ({
          number: ((page - 1) * 100) + index + 1,
          pull_request: {},
        }))
        : [];
      const headers = page <= 11
        ? { Link: `<https://api.github.com/repositories/1319246194/issues?state=all&per_page=100&page=${page + 1}>; rel="next"` }
        : {};
      return new Response(JSON.stringify(items), { status: 200, headers });
    };

    const issues = await loadPublicGitHubIssues(
      { owner: 'OpenCoven', repository: 'psyche-build' },
      fetchImpl,
    );

    expect(issues).toHaveLength(1_100);
    expect(requests).toHaveLength(12);
    for (const request of requests) {
      expect(new Headers(request.headers).has('Authorization')).toBe(false);
    }
  });

  it('terminates pagination at the configured safety bound', async () => {
    let requests = 0;
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      requests += 1;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page'));
      const items = Array.from({ length: 100 }, (_, index) => ({
        number: ((page - 1) * 100) + index + 1,
      }));
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          Link: `<https://api.github.com/repositories/1319246194/issues?state=all&per_page=100&page=${page + 1}>; rel="next"`,
        },
      });
    };

    const exitCode = await runTrackerDriftCheck([
      '--inventory-file',
      '__tests__/fixtures/beads-project-sync/tracker-beads.jsonl',
      '--max-issue-pages',
      '3',
    ], { fetchImpl, stdout, stderr });

    expect(exitCode).toBe(2);
    expect(requests).toBe(3);
    expect(stdout.value()).toBe('');
    expect(stderr.value()).toMatch(/exceeded the configured safety bound of 3 pages/i);
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

  it('handles invalid CLI options without stack traces or argument disclosure', () => {
    const privateArgument = 'PRIVATE-OPTION-SENTINEL';
    const result = spawnSync(process.execPath, [
      'scripts/validate-beads-tracker.mjs',
      `--invalid-${privateArgument}`,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_TOKEN: 'PRIVATE-TOKEN-SENTINEL',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Tracker drift validation failed: invalid command-line options\n$/u);
    expect(result.stderr).not.toContain(privateArgument);
    expect(result.stderr).not.toContain('PRIVATE-TOKEN-SENTINEL');
    expect(result.stderr).not.toContain('at ');
  });

  it('handles missing private input paths without disclosing paths or raw filesystem errors', () => {
    const privatePath = join(
      process.cwd(),
      '.private',
      'PRIVATE-PATH-SENTINEL',
      'inventory.jsonl',
    );
    const result = spawnSync(process.execPath, [
      'scripts/validate-beads-tracker.mjs',
      '--inventory-file',
      privatePath,
      '--issues-file',
      '__tests__/fixtures/beads-project-sync/tracker-issues.json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BEADS_PROJECT_TOKEN: 'PRIVATE-TOKEN-SENTINEL',
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      /^Tracker drift validation failed: unable to read or parse inventory input\n$/u,
    );
    expect(result.stderr).not.toContain(privatePath);
    expect(result.stderr).not.toContain('PRIVATE-PATH-SENTINEL');
    expect(result.stderr).not.toContain('PRIVATE-TOKEN-SENTINEL');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('at ');
  });
});
