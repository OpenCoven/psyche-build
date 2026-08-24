import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  applyReconciliation,
  assertSafePlan,
  planReconciliation,
  ReconciliationApplyError,
} from '../scripts/beads-project-sync/reconcile.mjs';
import {
  DEFAULT_ISSUE_MARKER,
  renderHashMarker,
} from '../scripts/beads-project-sync/markers.mjs';
import {
  GITHUB_ISSUE_BODY_MAX_CODE_POINTS,
  GITHUB_PROJECT_README_MAX_CODE_POINTS,
  renderIssueBody,
  renderIssueTitle,
  renderProjectReadme,
} from '../scripts/beads-project-sync/render.mjs';
import type { PublicBead } from '../scripts/beads-project-sync/sanitize.mjs';
import type { ReconciliationAdapters } from '../scripts/beads-project-sync/reconcile.mjs';

type FieldMap = Record<string, string | number | boolean | null>;

const baseContext = Object.freeze({
  inventoryTimestamp: '2026-08-22T20:00:00Z',
  projectName: 'Public Beads inventory',
  repositoryIdentity: 'OpenCoven/psyche-build',
  sourceRef: 'main',
  sourceRepositoryUrl: 'https://github.com/OpenCoven/psyche-build',
});
const MANAGED_BODY_HASH_SUFFIX =
  `\n\n${renderHashMarker(DEFAULT_ISSUE_MARKER, '0'.repeat(64))}`;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codePointLength(value: string): number {
  return [...value].length;
}

function makeBead(id: string, overrides: Partial<PublicBead> = {}): PublicBead {
  const bead: PublicBead = {
    id,
    title: `Ship ${id}`,
    description: `## Work\nDeliver ${id}.`,
    design: 'docs/superpowers/specs/2026-08-21-public-beads-project-design.md',
    specId: 'docs/superpowers/plans/2026-08-21-public-beads-project.md',
    acceptanceCriteria: `- ${id} is mirrored safely.`,
    notes: `Notes for ${id}.`,
    status: 'open',
    priority: 0,
    type: 'task',
    blocked: false,
    labels: ['beads'],
    parentId: null,
    blockedByIds: [],
    githubAssignee: null,
    createdAt: '2026-08-20T00:00:00Z',
    updatedAt: '2026-08-20T00:00:00Z',
    closedAt: null,
    ...overrides,
  };

  if (bead.status === 'closed' && bead.closedAt == null) {
    bead.closedAt = bead.updatedAt;
  }

  return bead;
}

function finalizeInventory(beads: readonly PublicBead[]): PublicBead[] {
  const byId = new Map(beads.map((bead) => [bead.id, bead]));
  return beads.map((bead) => ({
    ...bead,
    blocked: bead.status !== 'closed'
      && bead.blockedByIds.some((blockedById) => byId.get(blockedById)?.status !== 'closed'),
  }));
}

function inventoryById(inventory: readonly PublicBead[]): Map<string, PublicBead> {
  return new Map(inventory.map((bead) => [bead.id, bead]));
}

function canonicalIssueBody(
  bead: PublicBead,
  inventory: readonly PublicBead[],
  issueNumbers?: ReadonlyMap<string, number>,
): string {
  return renderIssueBody(bead, {
    ...baseContext,
    inventoryById: inventoryById(inventory),
    mirroredIssueUrlsByBeadId: issueNumbers == null
      ? undefined
      : new Map([...issueNumbers.entries()].map(([beadId, issueNumber]) => [
          beadId,
          `https://github.com/${baseContext.repositoryIdentity}/issues/${issueNumber}`,
        ])),
  });
}

function canonicalReadmeBody(inventory: readonly PublicBead[]): string {
  return renderProjectReadme(inventory, baseContext);
}

function makeBeadWithManagedBodyLength(
  id: string,
  targetCodePoints: number,
  fill: string,
  overrides: Partial<PublicBead> = {},
): PublicBead {
  const seedInventory = finalizeInventory([
    makeBead(id, {
      ...overrides,
      description: fill,
    }),
  ]);
  const seedBody = `${canonicalIssueBody(seedInventory[0]!, seedInventory)}${MANAGED_BODY_HASH_SUFFIX}`;
  const fixedCodePoints = codePointLength(seedBody) - codePointLength(fill);
  const fillCodePoints = codePointLength(fill);
  const requiredFillCodePoints = targetCodePoints - fixedCodePoints;
  if (fillCodePoints !== 1 || requiredFillCodePoints < 1) {
    throw new Error('Managed body test fixture requires a single-code-point fill');
  }

  return makeBead(id, {
    ...overrides,
    description: fill.repeat(requiredFillCodePoints),
  });
}

function recordingAdapters(
  record: (operationType: keyof ReconciliationAdapters) => void,
): ReconciliationAdapters {
  let nextIssueNumber = 1_000;
  return {
    createIssue() {
      record('createIssue');
      nextIssueNumber += 1;
      return { number: nextIssueNumber };
    },
    updateIssue() {
      record('updateIssue');
    },
    labelIssue() {
      record('labelIssue');
    },
    closeIssue() {
      record('closeIssue');
    },
    ensureProjectItem(operation) {
      record('ensureProjectItem');
      return { id: `item-${operation.beadId}` };
    },
    restoreItem() {
      record('restoreItem');
    },
    setFields() {
      record('setFields');
    },
    syncParent() {
      record('syncParent');
    },
    syncBlocker() {
      record('syncBlocker');
    },
    archiveItem() {
      record('archiveItem');
    },
    updateReadme() {
      record('updateReadme');
    },
  };
}

function desiredLabels(bead: PublicBead): string[] {
  const labels = ['bead', `priority:P${bead.priority}`];
  if (bead.type === 'epic' || bead.type === 'feature' || bead.type === 'task') {
    labels.splice(1, 0, `bead:${bead.type}`);
  }
  if (bead.blocked) {
    labels.push('status:blocked');
  }
  return labels;
}

function desiredFields(
  bead: Pick<
    PublicBead,
    'id' | 'status' | 'type' | 'priority' | 'blocked' | 'parentId' | 'updatedAt'
  >,
): FieldMap {
  return {
    beadId: bead.id,
    status: bead.status,
    type: bead.type,
    priority: bead.priority,
    blocked: bead.blocked,
    done: bead.status === 'closed',
    parentGoal: bead.parentId,
    sourceUpdated: bead.updatedAt.slice(0, 10),
  };
}

function activeIssueNumbersByBeadId(
  inventory: readonly PublicBead[],
  startNumber = 101,
): Map<string, number> {
  return new Map(
    inventory
      .filter((bead) => bead.status !== 'closed')
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((bead, index) => [bead.id, startNumber + index]),
  );
}

function desiredParentIssueNumber(
  bead: PublicBead,
  inventory: readonly PublicBead[],
  issueNumbers: ReadonlyMap<string, number>,
): number | null {
  if (!bead.parentId) {
    return null;
  }

  const parent = inventoryById(inventory).get(bead.parentId);
  if (!parent || parent.status === 'closed') {
    return null;
  }
  return issueNumbers.get(parent.id) ?? null;
}

function desiredBlockerIssueNumbers(
  bead: PublicBead,
  inventory: readonly PublicBead[],
  issueNumbers: ReadonlyMap<string, number>,
): number[] {
  const byId = inventoryById(inventory);
  return [...bead.blockedByIds]
    .filter((blockedById) => byId.get(blockedById)?.status !== 'closed')
    .sort(compareStrings)
    .map((blockedById) => issueNumbers.get(blockedById))
    .filter((issueNumber): issueNumber is number => issueNumber != null);
}

function managedIssue(
  bead: PublicBead,
  inventory: readonly PublicBead[],
  issueNumbers: ReadonlyMap<string, number>,
  overrides: Partial<{
    assignees: readonly string[],
    blockerIssues: readonly {
      id: number,
      nodeId: string,
      number: number,
      repository: string,
    }[] | null,
    blockerIssueNumbers: readonly number[] | null,
    body: string | null,
    labels: readonly string[] | null,
    parentIssue: {
      id: number,
      nodeId: string,
      number: number,
      repository: string,
    } | null,
    parentIssueNumber: number | null,
    projectItem: {
      id: string,
      archived?: boolean,
      fields?: FieldMap,
    } | null,
    renderHash: string | null,
    state: string | null,
    title: string | null,
  }> = {},
) {
  const issueNumber = issueNumbers.get(bead.id);
  if (issueNumber == null) {
    throw new Error(`Missing issue number for bead ${bead.id}`);
  }

  return {
    number: issueNumber,
    title: renderIssueTitle(bead),
    body: canonicalIssueBody(bead, inventory, issueNumbers),
    state: bead.status === 'closed' ? 'closed' : 'open',
    assignees: bead.githubAssignee == null ? [] : [bead.githubAssignee],
    labels: desiredLabels(bead),
    renderHash: null,
    projectItem: {
      id: `item-${issueNumber}`,
      archived: bead.status === 'closed',
      fields: desiredFields(bead),
    },
    parentIssueNumber: desiredParentIssueNumber(bead, inventory, issueNumbers),
    blockerIssueNumbers: desiredBlockerIssueNumbers(bead, inventory, issueNumbers),
    blockerIssues: desiredBlockerIssueNumbers(bead, inventory, issueNumbers).map((number) => ({
      id: 10_000 + number,
      nodeId: `ISSUE-${number}`,
      number,
      repository: baseContext.repositoryIdentity,
    })),
    ...overrides,
    repository: baseContext.repositoryIdentity,
    issueNodeId: `ISSUE-${issueNumber}`,
  };
}

describe('Beads project reconciliation', () => {
  it('accepts a complete ASCII managed issue body at exactly 65,536 code points', () => {
    const inventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        'pb-body-exact',
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS,
        'a',
      ),
    ]);

    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const createOperation = plan.operations.find(
      (operation) => operation.type === 'createIssue',
    );

    expect(createOperation?.type).toBe('createIssue');
    if (createOperation?.type !== 'createIssue') {
      throw new Error('Expected a create operation');
    }
    expect(codePointLength(createOperation.body)).toBe(GITHUB_ISSUE_BODY_MAX_CODE_POINTS);
  });

  it('rejects an over-limit ASCII body during planning before any adapter can run', () => {
    const beadId = 'pb-body-over';
    const inventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        beadId,
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS + 1,
        'a',
      ),
    ]);
    let adapterCalls = 0;

    expect(() => {
      const plan = planReconciliation({
        inventory,
        existingIssues: [],
        readme: null,
        renderContext: baseContext,
      });
      void applyReconciliation(
        plan,
        recordingAdapters(() => {
          adapterCalls += 1;
        }),
      );
    }).toThrow(
      `GitHub issue body for Bead "${beadId}" is 65537 characters; maximum is 65536`,
    );
    expect(adapterCalls).toBe(0);
  });

  it('counts emoji as one code point at the exact issue body boundary', () => {
    const inventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        'pb-body-emoji-exact',
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS,
        '😀',
      ),
    ]);

    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const createOperation = plan.operations.find(
      (operation) => operation.type === 'createIssue',
    );

    expect(createOperation?.type).toBe('createIssue');
    if (createOperation?.type !== 'createIssue') {
      throw new Error('Expected a create operation');
    }
    expect(codePointLength(createOperation.body)).toBe(GITHUB_ISSUE_BODY_MAX_CODE_POINTS);
    expect(createOperation.body.length).toBeGreaterThan(GITHUB_ISSUE_BODY_MAX_CODE_POINTS);
  });

  it('rejects an emoji body that exceeds the code-point limit by one', () => {
    const beadId = 'pb-body-emoji-over';
    const inventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        beadId,
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS + 1,
        '😀',
      ),
    ]);

    expect(() => planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    })).toThrow(
      `GitHub issue body for Bead "${beadId}" is 65537 characters; maximum is 65536`,
    );
  });

  it('preflights an over-limit body before planning an existing issue update', () => {
    const beadId = 'pb-body-update';
    const previousInventory = finalizeInventory([makeBead(beadId)]);
    const currentInventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        beadId,
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS + 1,
        'a',
        { title: 'Refresh the managed body' },
      ),
    ]);
    const issueNumbers = new Map([[beadId, 100]]);

    expect(() => planReconciliation({
      inventory: currentInventory,
      existingIssues: [
        managedIssue(previousInventory[0]!, previousInventory, issueNumbers),
      ],
      readme: { body: canonicalReadmeBody(currentInventory) },
      renderContext: baseContext,
    })).toThrow(
      `GitHub issue body for Bead "${beadId}" is 65537 characters; maximum is 65536`,
    );
  });

  it('preflights an over-limit managed body before planning a newly closed flow', () => {
    const beadId = 'pb-body-closed';
    const previousInventory = finalizeInventory([makeBead(beadId)]);
    const currentInventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        beadId,
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS + 1,
        'a',
        {
          status: 'closed',
          updatedAt: '2026-08-22T02:00:00Z',
          closedAt: '2026-08-22T02:00:00Z',
        },
      ),
    ]);
    const issueNumbers = new Map([[beadId, 101]]);

    expect(() => planReconciliation({
      inventory: currentInventory,
      existingIssues: [
        managedIssue(previousInventory[0]!, previousInventory, issueNumbers),
      ],
      readme: { body: canonicalReadmeBody(currentInventory) },
      renderContext: baseContext,
    })).toThrow(
      `GitHub issue body for Bead "${beadId}" is 65537 characters; maximum is 65536`,
    );
  });

  it('rejects an oversized planned issue body before applying any adapter', async () => {
    const beadId = 'pb-body-apply';
    const inventory = finalizeInventory([
      makeBeadWithManagedBodyLength(
        beadId,
        GITHUB_ISSUE_BODY_MAX_CODE_POINTS,
        'a',
      ),
    ]);
    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const createOperation = plan.operations.find(
      (operation) => operation.type === 'createIssue',
    );
    if (createOperation?.type !== 'createIssue') {
      throw new Error('Expected a create operation');
    }
    createOperation.body += 'a';

    const adapterCalls: string[] = [];
    await expect(applyReconciliation(
      plan,
      recordingAdapters((operationType) => adapterCalls.push(operationType)),
    )).rejects.toThrow(
      `GitHub issue body for Bead "${beadId}" is 65537 characters; maximum is 65536`,
    );
    expect(adapterCalls).toEqual([]);
  });

  it('rejects a dependency-linked rerender before calling the update adapter', async () => {
    const childId = 'pb-body-linked-child';
    const seedInventory = finalizeInventory([
      makeBead('pb-body-linked-parent', { type: 'feature' }),
      makeBead(childId, {
        parentId: 'pb-body-linked-parent',
        description: 'a',
      }),
    ]);
    const seedChild = seedInventory.find((bead) => bead.id === childId);
    if (!seedChild) {
      throw new Error('Expected the child Bead fixture');
    }
    const seedBody = `${canonicalIssueBody(seedChild, seedInventory)}${MANAGED_BODY_HASH_SUFFIX}`;
    const descriptionCodePoints =
      GITHUB_ISSUE_BODY_MAX_CODE_POINTS - (codePointLength(seedBody) - 1);
    const inventory = finalizeInventory([
      seedInventory[0]!,
      {
        ...seedChild,
        description: 'a'.repeat(descriptionCodePoints),
      },
    ]);
    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const initialChildCreate = plan.operations.find(
      (operation) => operation.type === 'createIssue' && operation.beadId === childId,
    );
    if (initialChildCreate?.type !== 'createIssue') {
      throw new Error('Expected a child create operation');
    }
    expect(codePointLength(initialChildCreate.body)).toBe(
      GITHUB_ISSUE_BODY_MAX_CODE_POINTS,
    );

    const adapterCalls: string[] = [];
    let failure: unknown;
    try {
      await applyReconciliation(
        plan,
        recordingAdapters((operationType) => adapterCalls.push(operationType)),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ReconciliationApplyError);
    expect((failure as ReconciliationApplyError).cause).toMatchObject({
      message: expect.stringMatching(
        new RegExp(`GitHub issue body for Bead "${childId}" is \\d+ characters; maximum is 65536`, 'u'),
      ),
    });
    expect(adapterCalls).not.toContain('updateIssue');
  });

  it('plans a validated bounded README for many long closed titles', () => {
    const inventory = finalizeInventory(
      Array.from({ length: 400 }, (_, index) => makeBead(
        `pb-readme-${String(index + 1).padStart(4, '0')}`,
        {
          title: `${String(index + 1).padStart(4, '0')} ${'😀'.repeat(2_000)}`,
          status: 'closed',
          updatedAt: '2026-08-23T12:00:00Z',
          closedAt: '2026-08-23T12:00:00Z',
        },
      )),
    );

    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const readmeOperation = plan.operations.find(
      (operation) => operation.type === 'updateReadme',
    );

    expect(plan.operations).toHaveLength(1);
    expect(readmeOperation?.type).toBe('updateReadme');
    if (readmeOperation?.type !== 'updateReadme') {
      throw new Error('Expected an updateReadme operation');
    }
    expect(codePointLength(readmeOperation.body)).toBeLessThanOrEqual(
      GITHUB_PROJECT_README_MAX_CODE_POINTS,
    );
    expect(readmeOperation.body).toMatch(/^- \d+ additional closed beads omitted\.$/mu);
  });

  it('rejects an oversized required README before returning a reconciliation plan', () => {
    const inventory = finalizeInventory([makeBead('pb-readme-required')]);

    expect(() => planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: {
        ...baseContext,
        projectName: 'x'.repeat(GITHUB_PROJECT_README_MAX_CODE_POINTS),
      },
    })).toThrow(/Project README required sections.*maximum is 10000/u);
  });

  it('preflights an oversized planned README before applying any adapter', async () => {
    const inventory = finalizeInventory([makeBead('pb-readme-apply')]);
    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const readmeOperation = plan.operations.find(
      (operation) => operation.type === 'updateReadme',
    );
    if (readmeOperation?.type !== 'updateReadme') {
      throw new Error('Expected an updateReadme operation');
    }
    readmeOperation.body = '😀'.repeat(GITHUB_PROJECT_README_MAX_CODE_POINTS + 1);

    const adapterCalls: string[] = [];
    await expect(applyReconciliation(
      plan,
      recordingAdapters((operationType) => adapterCalls.push(operationType)),
    )).rejects.toThrow(
      'GitHub Project README is 10001 characters; maximum is 10000',
    );
    expect(adapterCalls).toEqual([]);
  });

  it('plans deterministic first-run creates, keeps closed history in bodies, and ignores unmanaged issues', () => {
    const active = Array.from({ length: 25 }, (_, index) => {
      const sequence = String(index + 1).padStart(2, '0');
      const id = `pb-${sequence}`;
      if (id === 'pb-02') {
        return makeBead(id, { title: 'Unblocks the row', type: 'feature' });
      }
      if (id === 'pb-03') {
        return makeBead(id, {
          blockedByIds: ['pb-99-history', 'pb-02'],
          notes: 'Closed blockers stay as body metadata only.',
          parentId: 'pb-01',
        });
      }
      return makeBead(id);
    });
    const inventory = finalizeInventory([
      ...active,
      makeBead('pb-99-history', {
        status: 'closed',
        title: 'Historical blocker only',
        updatedAt: '2026-08-21T09:30:00Z',
        closedAt: '2026-08-21T09:30:00Z',
      }),
    ]).reverse();

    const plan = planReconciliation({
      inventory,
      existingIssues: [
        {
          number: 31,
          title: 'Manual public note',
          body: 'Keep this unmanaged issue untouched.',
          state: 'open',
        },
      ],
      readme: { body: null },
      renderContext: baseContext,
    });

    const createOps = plan.operations.filter((operation) => operation.type === 'createIssue');
    const closeOps = plan.operations.filter((operation) => operation.type === 'closeIssue');
    const syncParentOps = plan.operations.filter((operation) => operation.type === 'syncParent');
    const syncBlockerOps = plan.operations.filter((operation) => operation.type === 'syncBlocker');
    const readmeOps = plan.operations.filter((operation) => operation.type === 'updateReadme');
    const blockedCreate = createOps.find((operation) => operation.beadId === 'pb-03');
    const syncBlocker = syncBlockerOps.find((operation) => operation.beadId === 'pb-03');

    expect(plan.summary.sourceActive).toBe(25);
    expect(plan.summary.createIssueCount).toBe(25);
    expect(plan.summary.closeIssueCount).toBe(0);
    expect(createOps.map((operation) => operation.beadId)).toEqual(
      Array.from({ length: 25 }, (_, index) => `pb-${String(index + 1).padStart(2, '0')}`),
    );
    expect(createOps.some((operation) => operation.beadId === 'pb-99-history')).toBe(false);
    expect(closeOps).toHaveLength(0);
    expect(blockedCreate?.body).toContain('- Closed history: closed `pb-99-history` — Historical blocker only');
    expect(blockedCreate?.body).toContain('- Blocked by: `pb-02` — Unblocks the row');
    expect(blockedCreate?.body).toMatch(/render-hash=[a-f0-9]{64}/u);
    expect(syncParentOps.map((operation) => operation.beadId)).toEqual(['pb-03']);
    expect(syncBlocker?.blockerBeadIds).toEqual(['pb-02']);
    expect(readmeOps).toHaveLength(1);
    expect(readmeOps[0]?.body).toMatch(/render-hash=[a-f0-9]{64}/u);
    expect(plan.operations.some((operation) => 'issueNumber' in operation && operation.issueNumber === 31)).toBe(
      false,
    );
    const lastSetFieldsIndex = plan.operations.reduce(
      (lastIndex, operation, index) => (operation.type === 'setFields' ? index : lastIndex),
      -1,
    );
    expect(plan.operations.findIndex((operation) => operation.type === 'syncParent')).toBeGreaterThan(
      lastSetFieldsIndex,
    );
    expect(plan.operations.at(-1)?.type).toBe('updateReadme');
    expect(() => assertSafePlan(plan)).not.toThrow();
  });

  it('recognizes legacy markers and plans in-place migration to configured markers', () => {
    const inventory = finalizeInventory([makeBead('pb-legacy')]);
    const legacyPlan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: {
        ...baseContext,
        projectMarker: 'psyche-bead-sync:v1',
        issueMarker: 'psyche-bead-sync:v1',
      },
    });
    const legacyIssue = legacyPlan.operations.find(
      (operation) => operation.type === 'createIssue',
    );
    const legacyReadme = legacyPlan.operations.find(
      (operation) => operation.type === 'updateReadme',
    );
    expect(legacyIssue?.type).toBe('createIssue');
    expect(legacyReadme?.type).toBe('updateReadme');

    const migrated = planReconciliation({
      inventory,
      existingIssues: [{
        number: 42,
        title: legacyIssue?.type === 'createIssue' ? legacyIssue.title : null,
        body: legacyIssue?.type === 'createIssue' ? legacyIssue.body : null,
        state: 'open',
      }],
      readme: {
        body: legacyReadme?.type === 'updateReadme' ? legacyReadme.body : null,
      },
      renderContext: {
        ...baseContext,
        projectMarker: 'custom-project-sync:v2',
        issueMarker: 'custom-issue-sync:v2',
        legacyProjectMarkers: ['psyche-bead-sync:v1'],
        legacyIssueMarkers: ['psyche-bead-sync:v1'],
      },
    });

    expect(migrated.managedIssuesByBeadId.get('pb-legacy')?.number).toBe(42);
    expect(migrated.summary.createIssueCount).toBe(0);
    expect(migrated.summary.updateIssueCount).toBe(1);
    expect(migrated.summary.updateReadmeCount).toBe(1);
    expect(migrated.operations.find(
      (operation) => operation.type === 'updateIssue',
    )?.body).toContain('<!-- custom-issue-sync:v2 bead-id=pb-legacy -->');
    expect(migrated.operations.find(
      (operation) => operation.type === 'updateReadme',
    )?.body).toContain(
      '<!-- custom-project-sync:v2 project-readme repository=OpenCoven/psyche-build -->',
    );
  });

  it('plans no mutations on a matching second run by using current bodies or render hashes', () => {
    const inventory = finalizeInventory([
      makeBead('pb-03', {
        blockedByIds: ['pb-02'],
        parentId: 'pb-01',
      }),
      makeBead('pb-01', {
        title: 'Root bead',
        type: 'epic',
      }),
      makeBead('pb-02', {
        title: 'Active blocker',
        status: 'in_progress',
      }),
      makeBead('pb-99-history', {
        status: 'closed',
        title: 'Historical blocker only',
        updatedAt: '2026-08-21T09:30:00Z',
        closedAt: '2026-08-21T09:30:00Z',
      }),
    ]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 201);
    const currentBody = canonicalIssueBody(inventory[0]!, inventory, issueNumbers);

    const existingIssues = inventory
      .filter((bead) => bead.status !== 'closed')
      .map((bead) => {
        if (bead.id === 'pb-03') {
          return managedIssue(bead, inventory, issueNumbers, {
            body: null,
            renderHash: sha256(currentBody),
          });
        }
        return managedIssue(bead, inventory, issueNumbers);
      })
      .reverse();

    const plan = planReconciliation({
      inventory: [...inventory].reverse(),
      existingIssues,
      readme: {
        body: null,
        renderHash: sha256(canonicalReadmeBody(inventory)),
      },
      renderContext: baseContext,
    });

    expect(plan.operations).toEqual([]);
    expect(plan.summary.updateIssueCount).toBe(0);
    expect(plan.summary.updateReadmeCount).toBe(0);
  });

  it('repairs blank Parent Goal and Source Updated fields and is idempotent afterward', () => {
    const inventory = finalizeInventory([
      makeBead('pb-parent', {
        title: 'Stable parent goal',
        type: 'epic',
        updatedAt: '2026-08-21T10:00:00Z',
      }),
      makeBead('pb-child', {
        parentId: 'pb-parent',
        updatedAt: '2026-08-22T12:30:00Z',
      }),
    ]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 301);
    const blankMetadataIssues = inventory.map((bead) => managedIssue(
      bead,
      inventory,
      issueNumbers,
      {
        projectItem: {
          id: `item-${issueNumbers.get(bead.id)}`,
          archived: false,
          fields: {
            beadId: bead.id,
            status: bead.status,
            type: bead.type,
            priority: bead.priority,
            blocked: bead.blocked,
            done: false,
          },
        },
      },
    ));

    const repairPlan = planReconciliation({
      inventory,
      existingIssues: blankMetadataIssues,
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(repairPlan.operations).toEqual([
      expect.objectContaining({
        type: 'setFields',
        beadId: 'pb-child',
        fields: expect.objectContaining({
          parentGoal: 'pb-parent',
          sourceUpdated: '2026-08-22',
        }),
      }),
      expect.objectContaining({
        type: 'setFields',
        beadId: 'pb-parent',
        fields: expect.objectContaining({
          parentGoal: null,
          sourceUpdated: '2026-08-21',
        }),
      }),
    ]);

    const repairedIssues = inventory.map((bead) =>
      managedIssue(bead, inventory, issueNumbers, {
        projectItem: {
          id: `item-${issueNumbers.get(bead.id)}`,
          archived: false,
          fields: desiredFields(bead),
        },
      })
    );
    const secondPlan = planReconciliation({
      inventory,
      existingIssues: repairedIssues,
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(secondPlan.operations).toEqual([]);
  });

  it('updates managed issues when canonical content changes', () => {
    const currentInventory = finalizeInventory([
      makeBead('pb-01', {
        githubAssignee: 'BunsDev',
        notes: 'Refresh the canonical mirror output.',
        title: 'Refresh the public issue body',
      }),
    ]);
    const previousInventory = finalizeInventory([
      makeBead('pb-01', {
        githubAssignee: null,
        notes: 'Old note.',
        title: 'Old public title',
      }),
    ]);
    const currentBead = currentInventory[0]!;
    const issueNumbers = activeIssueNumbersByBeadId(currentInventory, 401);

    const plan = planReconciliation({
      inventory: currentInventory,
      existingIssues: [
        managedIssue(previousInventory[0]!, previousInventory, issueNumbers, {
          projectItem: {
            id: 'item-401',
            archived: false,
            fields: desiredFields(currentBead),
          },
        }),
      ],
      readme: { body: canonicalReadmeBody(currentInventory) },
      renderContext: baseContext,
    });

    const updateOps = plan.operations.filter((operation) => operation.type === 'updateIssue');

    expect(updateOps).toHaveLength(1);
    expect(updateOps[0]).toMatchObject({
      beadId: 'pb-01',
      issueNumber: 401,
      title: '[pb-01] Refresh the public issue body',
      assignees: ['BunsDev'],
    });
    expect(updateOps[0]?.body).toContain('Refresh the canonical mirror output.');
  });

  it('updates when the desired assignee set contains an extra login', () => {
    const inventory = finalizeInventory([
      makeBead('pb-assignee-extra', { githubAssignee: 'BunsDev' }),
    ]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 410);
    const plan = planReconciliation({
      inventory,
      existingIssues: [
        managedIssue(inventory[0]!, inventory, issueNumbers, {
          assignees: ['octocat', 'BunsDev'],
        }),
      ],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(plan.managedIssuesByBeadId.get('pb-assignee-extra')?.assignees).toEqual([
      'BunsDev',
      'octocat',
    ]);
    expect(plan.operations.filter((operation) => operation.type === 'updateIssue')).toEqual([
      expect.objectContaining({
        beadId: 'pb-assignee-extra',
        assignees: ['BunsDev'],
      }),
    ]);
  });

  it('treats a reordered normalized exact assignee set as a no-op', () => {
    const inventory = finalizeInventory([
      makeBead('pb-assignee-exact', { githubAssignee: 'BunsDev' }),
    ]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 420);

    for (const assignees of [
      ['BunsDev', ' BunsDev '],
      [' BunsDev ', 'BunsDev'],
    ]) {
      const plan = planReconciliation({
        inventory,
        existingIssues: [
          managedIssue(inventory[0]!, inventory, issueNumbers, { assignees }),
        ],
        readme: { body: canonicalReadmeBody(inventory) },
        renderContext: baseContext,
      });

      expect(plan.operations.filter((operation) => operation.type === 'updateIssue')).toEqual([]);
    }
  });

  it('clears every existing assignee when the source has no desired assignee', () => {
    const inventory = finalizeInventory([makeBead('pb-assignee-clear')]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 430);
    const plan = planReconciliation({
      inventory,
      existingIssues: [
        managedIssue(inventory[0]!, inventory, issueNumbers, {
          assignees: ['hubot', 'octocat'],
        }),
      ],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(plan.operations.filter((operation) => operation.type === 'updateIssue')).toEqual([
      expect.objectContaining({
        beadId: 'pb-assignee-clear',
        assignees: [],
      }),
    ]);
  });

  it('adds the desired assignee when it is missing from the existing set', () => {
    const inventory = finalizeInventory([
      makeBead('pb-assignee-missing', { githubAssignee: 'BunsDev' }),
    ]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 440);
    const plan = planReconciliation({
      inventory,
      existingIssues: [
        managedIssue(inventory[0]!, inventory, issueNumbers, { assignees: [] }),
      ],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(plan.operations.filter((operation) => operation.type === 'updateIssue')).toEqual([
      expect.objectContaining({
        beadId: 'pb-assignee-missing',
        assignees: ['BunsDev'],
      }),
    ]);
  });

  it('repairs required labels with a separate idempotent label operation', () => {
    const inventory = finalizeInventory([makeBead('pb-labels')]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 430);
    const bead = inventory[0]!;
    const plan = planReconciliation({
      inventory,
      existingIssues: [
        managedIssue(bead, inventory, issueNumbers, {
          labels: ['priority:P0'],
        }),
      ],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(plan.operations).toEqual([
      {
        type: 'labelIssue',
        phase: 'labelIssues',
        beadId: 'pb-labels',
        issueNumber: 430,
        labels: ['bead', 'bead:task', 'priority:P0'],
      },
    ]);
  });

  it('does not conflate foreign parent and blocker issue numbers with local managed issues', () => {
    const inventory = finalizeInventory([
      makeBead('pb-parent', { type: 'feature' }),
      makeBead('pb-blocker'),
      makeBead('pb-child', {
        parentId: 'pb-parent',
        blockedByIds: ['pb-blocker'],
      }),
    ]);
    const issueNumbers = new Map([
      ['pb-parent', 501],
      ['pb-blocker', 502],
      ['pb-child', 503],
    ]);
    const child = inventory.find((bead) => bead.id === 'pb-child')!;
    const plan = planReconciliation({
      inventory,
      existingIssues: inventory.map((bead) =>
        managedIssue(bead, inventory, issueNumbers, bead.id === 'pb-child'
          ? {
              parentIssueNumber: 501,
              blockerIssueNumbers: [502],
              parentIssue: {
                id: 91_501,
                nodeId: 'FOREIGN-PARENT',
                number: 501,
                repository: 'OtherOrg/other-repo',
              },
              blockerIssues: [{
                id: 91_502,
                nodeId: 'FOREIGN-BLOCKER',
                number: 502,
                repository: 'OtherOrg/other-repo',
              }],
            }
          : {})
      ),
      readme: { body: canonicalReadmeBody(inventory), public: true },
      renderContext: baseContext,
    });

    expect(plan.operations).toContainEqual(expect.objectContaining({
      type: 'syncParent',
      beadId: child.id,
      parentBeadId: 'pb-parent',
      currentParentIssue: expect.objectContaining({
        nodeId: 'FOREIGN-PARENT',
        repository: 'OtherOrg/other-repo',
      }),
    }));
    expect(plan.operations).toContainEqual(expect.objectContaining({
      type: 'syncBlocker',
      beadId: child.id,
      blockerBeadIds: ['pb-blocker'],
      currentBlockerIssues: [
        expect.objectContaining({
          nodeId: 'FOREIGN-BLOCKER',
          repository: 'OtherOrg/other-repo',
        }),
      ],
    }));
  });

  it('reports private Project visibility drift without scheduling a mutation', () => {
    const inventory = finalizeInventory([makeBead('pb-private-project')]);
    const issueNumbers = activeIssueNumbersByBeadId(inventory, 440);
    const plan = planReconciliation({
      inventory,
      existingIssues: inventory.map((bead) => managedIssue(bead, inventory, issueNumbers)),
      readme: {
        body: canonicalReadmeBody(inventory),
        public: false,
      },
      renderContext: baseContext,
    });

    expect(plan.operations).toEqual([]);
    expect(plan.summary.visibilityDrift).toBe(true);
  });

  it('reopens active beads by restoring archived project items before field updates', async () => {
    const currentInventory = finalizeInventory([makeBead('pb-01')]);
    const previousInventory = finalizeInventory([
      makeBead('pb-01', {
        status: 'closed',
        updatedAt: '2026-08-22T01:00:00Z',
        closedAt: '2026-08-22T01:00:00Z',
      }),
    ]);
    const currentBead = currentInventory[0]!;
    const previousBead = previousInventory[0]!;
    const issueNumbers = new Map([['pb-01', 451]]);

    const plan = planReconciliation({
      inventory: currentInventory,
      existingIssues: [
        managedIssue(previousBead, previousInventory, issueNumbers, {
          projectItem: {
            id: 'item-451',
            archived: true,
            fields: desiredFields(previousBead),
          },
          state: 'closed',
        }),
      ],
      readme: { body: canonicalReadmeBody(currentInventory) },
      renderContext: baseContext,
    });

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      'updateIssue',
      'restoreItem',
      'setFields',
    ]);
    expect(plan.summary.restoreItemCount).toBe(1);
    expect(plan.operations[1]).toMatchObject({
      beadId: 'pb-01',
      itemId: 'item-451',
      type: 'restoreItem',
    });
    expect(plan.operations[2]).toMatchObject({
      beadId: 'pb-01',
      fields: desiredFields(currentBead),
      type: 'setFields',
    });

    const calls: string[] = [];
    await applyReconciliation(plan, {
      createIssue() {
        throw new Error('createIssue should not be called');
      },
      updateIssue(operation) {
        calls.push(`${operation.type}:${operation.issueNumber}`);
      },
      closeIssue() {
        throw new Error('closeIssue should not be called');
      },
      labelIssue() {
        throw new Error('labelIssue should not be called');
      },
      ensureProjectItem() {
        throw new Error('ensureProjectItem should not be called');
      },
      restoreItem(operation) {
        calls.push(`${operation.type}:${operation.itemId}`);
      },
      setFields(operation) {
        calls.push(`${operation.type}:${operation.itemId}`);
      },
      syncParent() {
        throw new Error('syncParent should not be called');
      },
      syncBlocker() {
        throw new Error('syncBlocker should not be called');
      },
      archiveItem() {
        throw new Error('archiveItem should not be called');
      },
      updateReadme() {
        throw new Error('updateReadme should not be called');
      },
    });

    expect(calls).toEqual([
      'updateIssue:451',
      'restoreItem:item-451',
      'setFields:item-451',
    ]);
  });

  it('canonicalizes newly closed beads before closing and archiving project items', () => {
    const previousInventory = finalizeInventory([makeBead('pb-01')]);
    const currentInventory = finalizeInventory([
      makeBead('pb-01', {
        status: 'closed',
        updatedAt: '2026-08-22T02:00:00Z',
        closedAt: '2026-08-22T02:00:00Z',
      }),
    ]);
    const previousBead = previousInventory[0]!;
    const currentBead = currentInventory[0]!;
    const issueNumbers = new Map([['pb-01', 501]]);

    const plan = planReconciliation({
      inventory: currentInventory,
      existingIssues: [
        managedIssue(previousBead, previousInventory, issueNumbers, {
          projectItem: {
            id: 'item-501',
            archived: false,
            fields: desiredFields(previousBead),
          },
          state: 'open',
        }),
      ],
      readme: { body: canonicalReadmeBody(currentInventory) },
      renderContext: baseContext,
    });

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      'updateIssue',
      'setFields',
      'closeIssue',
      'archiveItem',
    ]);
    expect(plan.operations[0]).toMatchObject({
      beadId: 'pb-01',
      title: renderIssueTitle(currentBead),
      body: expect.stringContaining('- Status: `closed`'),
      assignees: [],
      labels: ['bead', 'bead:task', 'priority:P0'],
      state: 'open',
      type: 'updateIssue',
    });
    expect(plan.operations[1]).toMatchObject({
      beadId: 'pb-01',
      fields: desiredFields(currentBead),
      type: 'setFields',
    });
    expect(plan.operations[2]).toMatchObject({ beadId: 'pb-01', issueNumber: 501, type: 'closeIssue' });
    expect(plan.operations[3]).toMatchObject({ beadId: 'pb-01', itemId: 'item-501', type: 'archiveItem' });
  });

  it('repairs stale canonical content on an already closed source bead without reopening it', async () => {
    const inventory = finalizeInventory([
      makeBead('pb-stale-closed', {
        title: 'Canonical closed title',
        status: 'closed',
        githubAssignee: 'BunsDev',
        updatedAt: '2026-08-22T02:00:00Z',
        closedAt: '2026-08-22T02:00:00Z',
      }),
    ]);
    const bead = inventory[0]!;
    const issueNumbers = new Map([[bead.id, 541]]);
    const plan = planReconciliation({
      inventory,
      existingIssues: [
        managedIssue(bead, inventory, issueNumbers, {
          title: '[pb-stale-closed] Stale title',
          body: '<!-- psyche-bead-sync:v1 bead-id=pb-stale-closed -->\nStale body',
          renderHash: null,
          labels: ['bead', 'priority:P4'],
          assignees: [],
          state: 'closed',
          projectItem: {
            id: 'item-541',
            archived: false,
            fields: desiredFields(bead),
          },
        }),
      ],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      'updateIssue',
      'labelIssue',
      'archiveItem',
    ]);
    expect(plan.operations[0]).toMatchObject({
      issueNumber: 541,
      title: renderIssueTitle(bead),
      assignees: ['BunsDev'],
      state: 'closed',
    });

    const calls: string[] = [];
    await applyReconciliation(plan, {
      ...recordingAdapters((type) => calls.push(type)),
      updateIssue(operation) {
        calls.push(`updateIssue:${operation.state}`);
      },
      labelIssue() {
        calls.push('labelIssue');
      },
      archiveItem() {
        calls.push('archiveItem');
      },
    });

    expect(calls).toEqual(['updateIssue:closed', 'labelIssue', 'archiveItem']);
  });

  it('repairs a missing Project item after an interrupted close before archiving', async () => {
    const inventory = finalizeInventory([
      makeBead('pb-interrupted-close', {
        status: 'closed',
        updatedAt: '2026-08-22T03:00:00Z',
        closedAt: '2026-08-22T03:00:00Z',
      }),
    ]);
    const bead = inventory[0]!;
    const issueNumbers = new Map([[bead.id, 551]]);
    const plan = planReconciliation({
      inventory,
      existingIssues: [
        managedIssue(bead, inventory, issueNumbers, {
          projectItem: null,
          state: 'closed',
        }),
      ],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    expect(plan.operations.map((operation) => operation.type)).toEqual([
      'ensureProjectItem',
      'setFields',
      'archiveItem',
    ]);

    const calls: string[] = [];
    await applyReconciliation(plan, {
      createIssue() {
        throw new Error('createIssue should not be called');
      },
      updateIssue() {
        throw new Error('updateIssue should not be called');
      },
      labelIssue() {
        throw new Error('labelIssue should not be called');
      },
      closeIssue() {
        throw new Error('closeIssue should not be called');
      },
      ensureProjectItem(operation) {
        calls.push(`${operation.type}:${operation.issueNumber}`);
        return { id: 'item-recovered' };
      },
      restoreItem() {
        throw new Error('restoreItem should not be called');
      },
      setFields(operation) {
        calls.push(`${operation.type}:${operation.itemId}`);
      },
      syncParent() {
        throw new Error('syncParent should not be called');
      },
      syncBlocker() {
        throw new Error('syncBlocker should not be called');
      },
      archiveItem(operation) {
        calls.push(`${operation.type}:${operation.itemId}`);
      },
      updateReadme() {
        throw new Error('updateReadme should not be called');
      },
    });

    expect(calls).toEqual([
      'ensureProjectItem:551',
      'setFields:item-recovered',
      'archiveItem:item-recovered',
    ]);
  });

  it('rejects unsupported public bead types during plan preflight', () => {
    const inventory = finalizeInventory([
      makeBead('pb-custom-type', { type: 'merge-request' }),
    ]);

    expect(() => planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    })).toThrow(/unsupported.*merge-request/i);
  });

  it('links newly created active dependencies after issue identities become available and stays idempotent', async () => {
    const childSourceTitle = '😀'.repeat(300);
    const inventory = finalizeInventory([
      makeBead('pb-parent', { type: 'feature' }),
      makeBead('pb-blocker'),
      makeBead('pb-child', {
        parentId: 'pb-parent',
        blockedByIds: ['pb-blocker'],
        title: childSourceTitle,
      }),
    ]);
    const firstPlan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: null,
      renderContext: baseContext,
    });
    const initialChildCreate = firstPlan.operations.find(
      (operation) => operation.type === 'createIssue' && operation.beadId === 'pb-child',
    );
    const childLinkUpdate = firstPlan.operations.find(
      (operation) => operation.type === 'updateIssue' && operation.beadId === 'pb-child',
    );

    expect(initialChildCreate?.type).toBe('createIssue');
    if (initialChildCreate?.type !== 'createIssue') {
      throw new Error('Expected a child create operation');
    }
    expect(initialChildCreate.body).toContain('- Parent: `pb-parent`');
    expect(initialChildCreate.body).not.toContain('/issues/');
    expect([...initialChildCreate.title]).toHaveLength(256);
    expect(initialChildCreate.title.endsWith('...')).toBe(true);
    expect(initialChildCreate.body).toContain(`## Goal\n${childSourceTitle}`);
    expect(childLinkUpdate).toMatchObject({
      type: 'updateIssue',
      beadId: 'pb-child',
    });

    const issueNumbers = new Map<string, number>();
    const finalBodies = new Map<string, string>();
    const finalTitles = new Map<string, string>();
    let nextIssueNumber = 800;
    await applyReconciliation(firstPlan, {
      createIssue(operation) {
        nextIssueNumber += 1;
        issueNumbers.set(operation.beadId, nextIssueNumber);
        finalBodies.set(operation.beadId, operation.body);
        finalTitles.set(operation.beadId, operation.title);
        return { number: nextIssueNumber };
      },
      updateIssue(operation) {
        finalBodies.set(operation.beadId, operation.body);
        finalTitles.set(operation.beadId, operation.title);
      },
      labelIssue() {},
      closeIssue() {
        throw new Error('closeIssue should not be called');
      },
      ensureProjectItem(operation) {
        return { id: `item-${operation.issueNumber}` };
      },
      restoreItem() {
        throw new Error('restoreItem should not be called');
      },
      setFields() {},
      syncParent() {},
      syncBlocker() {},
      archiveItem() {
        throw new Error('archiveItem should not be called');
      },
      updateReadme() {},
    });

    const childBody = finalBodies.get('pb-child');
    expect(childBody).toContain(
      `[#${issueNumbers.get('pb-parent')}](https://github.com/OpenCoven/psyche-build/issues/${issueNumbers.get('pb-parent')}) \`pb-parent\``,
    );
    expect(childBody).toContain(
      `[#${issueNumbers.get('pb-blocker')}](https://github.com/OpenCoven/psyche-build/issues/${issueNumbers.get('pb-blocker')}) \`pb-blocker\``,
    );
    expect([...(finalTitles.get('pb-child') ?? '')]).toHaveLength(256);
    expect(finalTitles.get('pb-child')).toBe(initialChildCreate.title);

    const secondPlan = planReconciliation({
      inventory,
      existingIssues: inventory.map((bead) =>
        managedIssue(bead, inventory, issueNumbers, {
          body: finalBodies.get(bead.id) ?? null,
        })
      ),
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });
    expect(secondPlan.operations).toEqual([]);
  });

  it('fails for duplicate managed markers and empty source inventories', () => {
    const inventory = finalizeInventory([makeBead('pb-01')]);
    const issueNumbers = new Map([['pb-01', 601]]);
    const duplicateBody = canonicalIssueBody(inventory[0]!, inventory);

    expect(() =>
      planReconciliation({
        inventory,
        existingIssues: [
          managedIssue(inventory[0]!, inventory, issueNumbers, { body: duplicateBody }),
          {
            number: 602,
            title: renderIssueTitle(inventory[0]!),
            body: duplicateBody,
            state: 'open',
          },
        ],
        readme: { body: canonicalReadmeBody(inventory) },
        renderContext: baseContext,
      }),
    ).toThrow(/duplicate managed marker/i);

    expect(() =>
      planReconciliation({
        inventory: [],
        existingIssues: [],
        readme: { body: null },
        renderContext: baseContext,
      }),
    ).toThrow(/empty source/i);
  });

  it('rejects invalid managed Bead ids instead of planning duplicate creates', () => {
    const inventory = finalizeInventory([makeBead('pb-01')]);

    expect(() =>
      planReconciliation({
        inventory,
        existingIssues: [
          {
            number: 603,
            title: '[pb]01] Ship pb-01',
            body: null,
            state: 'open',
            renderHash: sha256(canonicalIssueBody(inventory[0]!, inventory)),
          },
        ],
        readme: { body: canonicalReadmeBody(inventory) },
        renderContext: baseContext,
      }),
    ).toThrow(/invalid managed Bead id prefix/i);
  });

  it('guards mass-closing beyond the computed threshold unless overridden', () => {
    const fullInventory = finalizeInventory(
      Array.from({ length: 25 }, (_, index) => makeBead(`pb-${String(index + 1).padStart(2, '0')}`)),
    );
    const currentInventory = fullInventory.slice(0, 17);
    const issueNumbers = activeIssueNumbersByBeadId(fullInventory, 701);

    const existingIssues = fullInventory.map((bead, index) => managedIssue(
      bead,
      fullInventory,
      issueNumbers,
      index === 24 ? { title: null } : {},
    ));
    const plan = planReconciliation({
      inventory: currentInventory,
      existingIssues,
      readme: { body: canonicalReadmeBody(currentInventory) },
      renderContext: baseContext,
    });

    expect(plan.summary.managedOpenCount).toBe(25);
    expect(plan.summary.closeIssueCount).toBe(8);
    expect(plan.summary.defaultMaxCloseCount).toBe(7);
    expect(plan.summary.operationCounts).toEqual({
      createIssue: 0,
      updateIssue: 0,
      labelIssue: 0,
      closeIssue: 8,
      ensureProjectItem: 0,
      restoreItem: 0,
      setFields: 8,
      syncParent: 0,
      syncBlocker: 0,
      archiveItem: 8,
      updateReadme: 0,
    });
    expect(plan.summary.closureCandidates).toEqual(
      Array.from({ length: 8 }, (_, index) => {
        const beadId = `pb-${String(index + 18).padStart(2, '0')}`;
        return {
          beadId,
          issueNumber: 718 + index,
          issueTitle: index === 7 ? null : `[${beadId}] Ship ${beadId}`,
        };
      }),
    );
    expect(plan.summary.closureCandidates.every(
      (candidate) => !Object.hasOwn(candidate, 'body'),
    )).toBe(true);
    expect(() => assertSafePlan(plan)).toThrow(/close 8 managed issues.*limit is 7/i);
    expect(() => assertSafePlan(plan, { maxCloseCount: 8 })).not.toThrow();
  });

  it('applies planned operations through adapters after issue identities become known', async () => {
    const inventory = finalizeInventory([
      makeBead('pb-02', {
        blockedByIds: ['pb-03', 'pb-99-history'],
        parentId: 'pb-01',
      }),
      makeBead('pb-01', { type: 'feature' }),
      makeBead('pb-03', { status: 'in_progress' }),
      makeBead('pb-99-history', {
        status: 'closed',
        title: 'Historical blocker only',
        updatedAt: '2026-08-21T09:30:00Z',
        closedAt: '2026-08-21T09:30:00Z',
      }),
    ]).reverse();

    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: { body: null },
      renderContext: baseContext,
    });

    const calls: Array<{
      blockerIssueNumbers?: number[],
      issueNumber?: number,
      itemId?: string,
      parentIssueNumber?: number | null,
      path?: string,
      type: string,
    }> = [];
    let nextIssueNumber = 100;

    const result = await applyReconciliation(plan, {
      createIssue(operation) {
        nextIssueNumber += 1;
        calls.push({ type: `${operation.type}:${operation.beadId}` });
        return { number: nextIssueNumber };
      },
      updateIssue(operation) {
        calls.push({ issueNumber: operation.issueNumber, type: `${operation.type}:${operation.beadId}` });
      },
      closeIssue() {
        throw new Error('closeIssue should not be called');
      },
      labelIssue() {
        throw new Error('labelIssue should not be called');
      },
      ensureProjectItem(operation) {
        calls.push({ issueNumber: operation.issueNumber, type: `${operation.type}:${operation.beadId}` });
        return { id: `item-${operation.issueNumber}` };
      },
      restoreItem() {
        throw new Error('restoreItem should not be called');
      },
      setFields(operation) {
        calls.push({ itemId: operation.itemId, type: `${operation.type}:${operation.beadId}` });
      },
      syncParent(operation) {
        calls.push({
          issueNumber: operation.issueNumber,
          parentIssueNumber: operation.parentIssueNumber,
          type: `${operation.type}:${operation.beadId}`,
        });
      },
      syncBlocker(operation) {
        calls.push({
          blockerIssueNumbers: [...operation.blockerIssueNumbers],
          issueNumber: operation.issueNumber,
          type: `${operation.type}:${operation.beadId}`,
        });
      },
      archiveItem() {
        throw new Error('archiveItem should not be called');
      },
      updateReadme(operation) {
        calls.push({ path: operation.path, type: operation.type });
      },
    });

    expect(calls.map((call) => call.type)).toEqual([
      'createIssue:pb-01',
      'createIssue:pb-02',
      'createIssue:pb-03',
      'updateIssue:pb-02',
      'ensureProjectItem:pb-01',
      'ensureProjectItem:pb-02',
      'ensureProjectItem:pb-03',
      'setFields:pb-01',
      'setFields:pb-02',
      'setFields:pb-03',
      'syncParent:pb-02',
      'syncBlocker:pb-02',
      'updateReadme',
    ]);
    expect(calls.find((call) => call.type === 'syncParent:pb-02')).toMatchObject({
      issueNumber: 102,
      parentIssueNumber: 101,
    });
    expect(calls.find((call) => call.type === 'syncBlocker:pb-02')).toMatchObject({
      issueNumber: 102,
      blockerIssueNumbers: [103],
    });
    expect(result.issueNumbersByBeadId.get('pb-03')).toBe(103);
    expect(result.projectItemIdsByBeadId.get('pb-02')).toBe('item-102');
  });

  it('throws a structured ReconciliationApplyError with partial progress when apply fails', async () => {
    const inventory = finalizeInventory([makeBead('pb-01')]);
    const plan = planReconciliation({
      inventory,
      existingIssues: [],
      readme: { body: canonicalReadmeBody(inventory) },
      renderContext: baseContext,
    });

    let thrownError: unknown;
    try {
      await applyReconciliation(plan, {
        createIssue() {
          return { number: 901 };
        },
        updateIssue() {
          throw new Error('updateIssue should not be called');
        },
        closeIssue() {
          throw new Error('closeIssue should not be called');
        },
        labelIssue() {
          throw new Error('labelIssue should not be called');
        },
        ensureProjectItem(operation) {
          return { id: `item-${operation.issueNumber}` };
        },
        restoreItem() {
          throw new Error('restoreItem should not be called');
        },
        setFields() {
          throw new Error('setFields exploded');
        },
        syncParent() {
          throw new Error('syncParent should not be called');
        },
        syncBlocker() {
          throw new Error('syncBlocker should not be called');
        },
        archiveItem() {
          throw new Error('archiveItem should not be called');
        },
        updateReadme() {
          throw new Error('updateReadme should not be called');
        },
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(ReconciliationApplyError);
    const applyError = thrownError as ReconciliationApplyError;
    expect(applyError.message).toMatch(/failed during setFields for bead "pb-01"/i);
    expect(applyError.failingOperation).toMatchObject({
      beadId: 'pb-01',
      itemId: 'item-901',
      type: 'setFields',
    });
    expect(applyError.applied.map((entry) => entry.operation.type)).toEqual([
      'createIssue',
      'ensureProjectItem',
    ]);
    expect(applyError.applied[1]?.operation).toMatchObject({
      beadId: 'pb-01',
      issueNumber: 901,
      type: 'ensureProjectItem',
    });
    expect(applyError.issueNumbersByBeadId.get('pb-01')).toBe(901);
    expect(applyError.projectItemIdsByBeadId.get('pb-01')).toBe('item-901');
    expect(applyError.cause).toBeInstanceOf(Error);
    expect((applyError.cause as Error).message).toMatch(/setFields exploded/i);
  });
});
