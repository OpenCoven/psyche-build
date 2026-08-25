import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  activeBeads,
  buildBeadIndex,
  parseBeadExport,
  summarizeInventory,
} from '../scripts/beads-project-sync/model.mjs';

const fixturePath = new URL('./fixtures/beads-project-sync/issues.jsonl', import.meta.url);
const issuesJsonl = readFileSync(fixturePath, 'utf8');
const designDocPath =
  'docs/superpowers/specs/2026-08-21-public-beads-project-design.md';
const planDocPath =
  'docs/superpowers/plans/2026-08-21-public-beads-project.md';

function makeIssue(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'fixture-task';
  return {
    _type: 'issue',
    id,
    title: `Issue ${id}`,
    description: '## Work\nShip the model.',
    acceptance_criteria: '- Parse the export.',
    status: 'open',
    priority: 0,
    issue_type: 'task',
    owner: 'owner@example.com',
    created_at: '2026-08-20T00:00:00Z',
    created_by: 'Maintainer',
    updated_at: '2026-08-20T00:00:00Z',
    dependencies: [],
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
    ...overrides,
  };
}

function toJsonl(...records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

describe('Beads project model', () => {
  it('normalizes issues, resolves hierarchy and blockers, and maps assignees through config', () => {
    const beads = parseBeadExport(issuesJsonl, {
      assigneeMap: {
        'feature-owner@example.com': 'BunsDev',
      },
    });

    expect(beads).toMatchObject([
      {
        id: 'pb-epic',
        title: 'Publish a public Beads inventory',
        description: '## Objective\nPublish a safe public snapshot of the Beads project.',
        design: designDocPath,
        specId: planDocPath,
        acceptanceCriteria: '- Normalize supported issue records.',
        notes: null,
        status: 'open',
        priority: 0,
        type: 'epic',
        blocked: false,
        labels: ['public', 'inventory'],
        parentId: null,
        blockedByIds: [],
        githubAssignee: null,
        createdAt: '2026-08-20T08:00:00Z',
        updatedAt: '2026-08-20T08:30:00Z',
        closedAt: null,
      },
      {
        id: 'pb-feature',
        type: 'feature',
        parentId: 'pb-epic',
        blockedByIds: [],
        blocked: false,
        githubAssignee: 'BunsDev',
        notes: 'Only config-driven assignee mapping may reach GitHub output.',
      },
      {
        id: 'pb-blocked',
        type: 'task',
        parentId: 'pb-feature',
        blockedByIds: ['pb-closed', 'pb-in-progress'],
        blocked: true,
        githubAssignee: null,
      },
      {
        id: 'pb-in-progress',
        type: 'task',
        status: 'in_progress',
        parentId: 'pb-feature',
        blocked: false,
        blockedByIds: [],
      },
      {
        id: 'pb-closed',
        type: 'task',
        status: 'closed',
        parentId: 'pb-feature',
        blocked: false,
        blockedByIds: [],
        closedAt: '2026-08-20T12:30:00Z',
      },
    ]);
    expect(
      beads.every(
        (bead) => bead.design === designDocPath && bead.specId === planDocPath,
      ),
    ).toBe(true);
  });

  it('never exposes raw assignee values when a mapping is unavailable', () => {
    const beads = parseBeadExport(issuesJsonl, { assigneeMap: {} });
    const feature = beads.find((bead) => bead.id === 'pb-feature');

    expect(feature?.githubAssignee).toBeNull();
    expect(JSON.stringify(beads)).not.toContain('feature-owner@example.com');
  });

  it('uses one configured spelling for case-equivalent GitHub assignee mappings', () => {
    const beads = parseBeadExport(toJsonl(
      makeIssue({ id: 'one', assignee: 'first-owner' }),
      makeIssue({ id: 'two', assignee: 'second-owner' }),
    ), {
      assigneeMap: new Map([
        ['first-owner', 'BunsDev'],
        ['second-owner', 'bunsdev'],
      ]),
    });

    expect(beads.map((bead) => bead.githubAssignee)).toEqual([
      'BunsDev',
      'BunsDev',
    ]);
  });

  it('builds lookup indexes for ids, children, and blocker dependents', () => {
    const beads = parseBeadExport(issuesJsonl, {
      assigneeMap: {
        'feature-owner@example.com': 'BunsDev',
      },
    });
    const index = buildBeadIndex(beads);

    expect(index.byId.get('pb-feature')?.title).toBe('Model Beads project inventory');
    expect(index.childrenByParentId.get('pb-epic')?.map((bead) => bead.id)).toEqual(['pb-feature']);
    expect(index.childrenByParentId.get('pb-feature')?.map((bead) => bead.id)).toEqual([
      'pb-blocked',
      'pb-in-progress',
      'pb-closed',
    ]);
    expect(index.dependentsByBlockerId.get('pb-in-progress')?.map((bead) => bead.id)).toEqual([
      'pb-blocked',
    ]);
    expect(index.dependentsByBlockerId.get('pb-closed')?.map((bead) => bead.id)).toEqual([
      'pb-blocked',
    ]);
  });

  it('sorts blockedByIds deterministically regardless of export dependency order', () => {
    const dependencies = [
      { issue_id: 'stable-order', depends_on_id: 'zeta', type: 'blocks' },
      { issue_id: 'stable-order', depends_on_id: 'alpha', type: 'blocks' },
      { issue_id: 'stable-order', depends_on_id: 'beta.10', type: 'blocks' },
      { issue_id: 'stable-order', depends_on_id: 'parent-bead', type: 'parent-child' },
      { issue_id: 'stable-order', depends_on_id: 'beta-02', type: 'blocks' },
    ];
    const [forward] = parseBeadExport(toJsonl(makeIssue({
      id: 'stable-order',
      dependencies,
    })), { assigneeMap: {} });
    const [reversed] = parseBeadExport(toJsonl(makeIssue({
      id: 'stable-order',
      dependencies: [...dependencies].reverse(),
    })), { assigneeMap: {} });

    expect(forward.parentId).toBe('parent-bead');
    expect(reversed.parentId).toBe('parent-bead');
    expect(forward.blockedByIds).toEqual(['alpha', 'beta-02', 'beta.10', 'zeta']);
    expect(reversed.blockedByIds).toEqual(forward.blockedByIds);
  });

  it('filters active beads and summarizes inventory counts', () => {
    const beads = parseBeadExport(issuesJsonl, {
      assigneeMap: {
        'feature-owner@example.com': 'BunsDev',
      },
    });

    expect(activeBeads(beads).map((bead) => bead.id)).toEqual([
      'pb-epic',
      'pb-feature',
      'pb-blocked',
      'pb-in-progress',
    ]);
    expect(summarizeInventory(beads)).toEqual({
      total: 5,
      active: 4,
      closed: 1,
      blocked: 1,
      inProgress: 1,
      statusCounts: {
        open: 3,
        in_progress: 1,
        closed: 1,
      },
      typeCounts: {
        epic: 1,
        feature: 1,
        task: 3,
      },
    });
  });

  it('rejects malformed JSON, duplicate ids, empty ids, unsupported current fields, and multiple parents', () => {
    expect(() => parseBeadExport('{"_type":"issue"\n', { assigneeMap: {} })).toThrow(/line 1/i);
    expect(() => parseBeadExport(toJsonl(makeIssue({ id: 'dup' }), makeIssue({ id: 'dup' })), { assigneeMap: {} })).toThrow(/duplicate/i);
    expect(() => parseBeadExport(toJsonl(makeIssue({ id: '   ' })), { assigneeMap: {} })).toThrow(/empty id/i);
    expect(() => parseBeadExport(toJsonl(makeIssue({ current_status: 'open' })), { assigneeMap: {} })).toThrow(/current/i);
    expect(() => parseBeadExport(toJsonl(makeIssue({
      id: 'child',
      dependencies: [
        { issue_id: 'child', depends_on_id: 'parent-a', type: 'parent-child' },
        { issue_id: 'child', depends_on_id: 'parent-b', type: 'parent-child' },
      ],
    })), { assigneeMap: {} })).toThrow(/multiple parents/i);
  });

  it('validates and normalizes source timestamps during model parsing', () => {
    const [bead] = parseBeadExport(toJsonl(makeIssue({
      created_at: '2026-08-20T01:30:00+01:30',
      updated_at: '2026-08-20T00:00:00.125Z',
      closed_at: '2026-08-21T00:00:00Z',
    })), { assigneeMap: {} });

    expect(bead).toMatchObject({
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00.125Z',
      closedAt: '2026-08-21T00:00:00Z',
    });

    for (const [field, value] of [
      ['created_at', '2026-02-30T00:00:00Z'],
      ['updated_at', 'not-a-date'],
      ['closed_at', '2026-08-20'],
      ['closed_at', '999999-01-01T00:00:00Z'],
    ] as const) {
      expect(() => parseBeadExport(toJsonl(makeIssue({ [field]: value })), {
        assigneeMap: {},
      })).toThrow(new RegExp(`${field}.*date|date.*${field}`, 'i'));
    }
    expect(parseBeadExport(toJsonl(makeIssue({ closed_at: null })), {
      assigneeMap: {},
    })[0]?.closedAt).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['boolean', true],
    ['string', '1'],
    ['fractional', 1.5],
    ['negative', -1],
    ['above P4', 5],
  ])('rejects %s priority values before reconciliation', (_name, priority) => {
    expect(() => parseBeadExport(toJsonl(makeIssue({ priority })), {
      assigneeMap: {},
    })).toThrow(/priority.*integer.*0.*4|priority.*0.*4/i);
  });

  it.each([0, 1, 2, 3, 4])('accepts integer priority P%s', (priority) => {
    expect(parseBeadExport(toJsonl(makeIssue({ priority })), {
      assigneeMap: {},
    })[0]?.priority).toBe(priority);
  });

  it.each(['bad id', 'bad>id', 'bad]id'])(
    'rejects invalid Bead ids that are unsafe for markers/titles: %s',
    (id) => {
      expect(() => parseBeadExport(toJsonl(makeIssue({ id })), { assigneeMap: {} })).toThrow(/valid Bead id/i);
      expect(() => parseBeadExport(toJsonl(makeIssue({
        id: 'safe-id',
        dependencies: [
          { issue_id: 'safe-id', depends_on_id: id, type: 'blocks' },
        ],
      })), { assigneeMap: {} })).toThrow(/valid Bead id/i);
    },
  );

  it.each(['infrastructure', 'memory', 'template', 'gate', 'wisp'])(
    'rejects unsupported %s records',
    (type) => {
      expect(() => parseBeadExport(toJsonl(makeIssue({ id: `${type}-record`, issue_type: type })), {
        assigneeMap: {},
      })).toThrow(new RegExp(type));
    },
  );

  it.each(['epic', 'feature', 'task', 'bug', 'chore', 'decision'])(
    'accepts configured public Project bead type %s',
    (type) => {
      expect(parseBeadExport(toJsonl(makeIssue({
        id: `${type}-record`,
        issue_type: type,
      })), { assigneeMap: {} })[0]?.type).toBe(type);
    },
  );

  it('rejects custom bead types that cannot be represented by the configured Project field', () => {
    expect(() => parseBeadExport(toJsonl(makeIssue({
      id: 'merge-request-record',
      issue_type: 'merge-request',
    })), { assigneeMap: {} })).toThrow(/unsupported.*merge-request/i);
  });
});
