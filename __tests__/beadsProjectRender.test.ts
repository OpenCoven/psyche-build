import os from 'node:os';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildBeadIndex, parseBeadExport } from '../scripts/beads-project-sync/model.mjs';
import {
  assertNoPublishableSecrets,
  sanitizePublicText,
  toPublicBead,
} from '../scripts/beads-project-sync/sanitize.mjs';
import {
  renderIssueBody,
  renderIssueTitle,
  renderProjectReadme,
} from '../scripts/beads-project-sync/render.mjs';
import type { RenderContext } from '../scripts/beads-project-sync/render.mjs';
import type { PublicBead } from '../scripts/beads-project-sync/sanitize.mjs';

const fixturePath = new URL('./fixtures/beads-project-sync/issues.jsonl', import.meta.url);
const issuesJsonl = readFileSync(fixturePath, 'utf8');
const designDocPath = 'docs/superpowers/specs/2026-08-21-public-beads-project-design.md';
const planDocPath = 'docs/superpowers/plans/2026-08-21-public-beads-project.md';
const runtimeHomeDirectory = os.homedir().replace(/[\\/]+$/gu, '').replace(/\\/gu, '/');

function buildPublicInventory(): PublicBead[] {
  return parseBeadExport(issuesJsonl, {
    assigneeMap: {
      'feature-owner@example.com': 'BunsDev',
    },
  }).map((bead) => toPublicBead(bead));
}

function buildContext(
  inventory: PublicBead[],
  overrides: Partial<RenderContext> = {},
): RenderContext {
  const index = buildBeadIndex(inventory);
  return {
    inventoryById: index.byId,
    mirroredIssueUrlsByBeadId: {
      'pb-epic': 'https://github.com/OpenCoven/psyche-build-public/issues/1',
      'pb-feature': 'https://github.com/OpenCoven/psyche-build-public/issues/2',
      'pb-in-progress': 'https://github.com/OpenCoven/psyche-build-public/issues/3',
      'pb-closed': 'https://github.com/OpenCoven/psyche-build-public/issues/4',
    },
    sourceRepositoryUrl: 'https://github.com/OpenCoven/psyche-build',
    sourceRef: 'f2f1da60',
    inventoryTimestamp: '2026-08-22T20:00:00Z',
    ...overrides,
  };
}

function countMatches(value: string, search: string): number {
  if (!search) {
    return 0;
  }
  return value.split(search).length - 1;
}

describe('Beads project renderers', () => {
  it('redacts emails and local home paths but rejects publishable secrets', () => {
    expect(
      sanitizePublicText(
        'Contact owner@example.com from /Users/buns/Documents/GitHub/OpenCoven/psyche-build.',
      ),
    ).toBe('Contact <redacted-email> from ~/Documents/GitHub/OpenCoven/psyche-build.');
    expect(sanitizePublicText('Linux path: /home/alice/private/notes.txt')).toBe(
      'Linux path: ~/private/notes.txt',
    );
    expect(sanitizePublicText('cwd=/Users/buns/Documents/GitHub/OpenCoven/psyche-build')).toBe(
      'cwd=~/Documents/GitHub/OpenCoven/psyche-build',
    );
    expect(sanitizePublicText('file:///Users/buns/Documents/GitHub/OpenCoven/psyche-build')).toBe(
      'file:///~/Documents/GitHub/OpenCoven/psyche-build',
    );
    expect(sanitizePublicText('cwd=/home/alice/private/notes.txt')).toBe(
      'cwd=~/private/notes.txt',
    );
    expect(sanitizePublicText('cwd=C:\\Users\\alice\\AppData\\Local')).toBe(
      'cwd=~\\AppData\\Local',
    );
    expect(sanitizePublicText('file:///C:/Users/alice/AppData/Local')).toBe(
      'file:///~/AppData/Local',
    );
    expect(
      sanitizePublicText('See [file:///Users/buns/Documents/GitHub/OpenCoven/psyche-build];'),
    ).toBe('See [file:///~/Documents/GitHub/OpenCoven/psyche-build];');
    expect(sanitizePublicText('{/Users/buns/Documents/GitHub/OpenCoven/psyche-build}')).toBe(
      '{~/Documents/GitHub/OpenCoven/psyche-build}',
    );
    expect(sanitizePublicText(';/Users/buns/Documents/GitHub/OpenCoven/psyche-build;')).toBe(
      ';~/Documents/GitHub/OpenCoven/psyche-build;',
    );
    expect(
      sanitizePublicText('Keep https://example.com/Users/buns/docs and https://example.com/home/alice/docs public.'),
    ).toBe('Keep https://example.com/Users/buns/docs and https://example.com/home/alice/docs public.');
    expect(sanitizePublicText('Keep https://example.com/?path=/Users/buns/docs public.')).toBe(
      'Keep https://example.com/?path=~/docs public.',
    );
    expect(sanitizePublicText('Keep https://example.com/?route=/home/alice/docs public.')).toBe(
      'Keep https://example.com/?route=/home/alice/docs public.',
    );
    expect(sanitizePublicText(`Keep https://example.com/#${runtimeHomeDirectory}/docs public.`)).toBe(
      'Keep https://example.com/#~/docs public.',
    );
    expect(sanitizePublicText('Keep https://example.com/#/home/alice/docs public.')).toBe(
      'Keep https://example.com/#/home/alice/docs public.',
    );
    expect(
      sanitizePublicText(
        'Keep https://example.com/?path=%2FUsers%2Fbuns%2Fdocs#%2Fhome%2Falice%2Fdocs public.',
      ),
    ).toBe(
      'Keep https://example.com/?path=~/docs#%2Fhome%2Falice%2Fdocs public.',
    );
    expect(sanitizePublicText('Plan: ~/.copilot/session-state/run-1/plan.md')).toBe(
      'Plan: <redacted-local-path>',
    );
    expect(sanitizePublicText('Plan: .copilot/session-state/run-1/plan.md')).toBe(
      'Plan: <redacted-local-path>',
    );
    expect(
      sanitizePublicText('Checkout .worktrees/mobile-multiproject-cockpit before continuing.'),
    ).toBe('Checkout <redacted-local-path> before continuing.');
    expect(
      sanitizePublicText('/Users/buns/.copilot/session-state/run-1/plan.md'),
    ).toBe('<redacted-local-path>');
    for (const localPath of [
      '.psyche/worktrees/public-beads-project/plan.md',
      './.psyche/worktrees/public-beads-project/plan.md',
      'psyche-build/.psyche/worktrees/public-beads-project/plan.md',
      '~/.psyche/worktrees/public-beads-project/plan.md',
      '/opt/repos/psyche-build/.psyche/worktrees/public-beads-project/plan.md',
      'C:\\repos\\psyche-build\\.psyche\\worktrees\\public-beads-project\\plan.md',
    ]) {
      expect(sanitizePublicText(`Plan: ${localPath}`)).toBe('Plan: <redacted-local-path>');
    }
    expect(
      sanitizePublicText(
        'Keep .psyche/worktrees-inspired prose and docs/.psyche/worktrees-notes.md public.',
      ),
    ).toBe(
      'Keep .psyche/worktrees-inspired prose and docs/.psyche/worktrees-notes.md public.',
    );

    expect(() => assertNoPublishableSecrets('token = ghp_abcdefghijklmnopqrstuvwxyz123456')).toThrow(
      /GitHub token/i,
    );
    expect(() =>
      assertNoPublishableSecrets('github_pat_abcdefghijklmnopqrstuvwxyz1234567890'),
    ).toThrow(/GitHub token/i);
    expect(() => assertNoPublishableSecrets('apiKey = "live-secret-value"')).toThrow(/API key/i);
    expect(() => assertNoPublishableSecrets('{"api_key":"live-secret-value"}')).toThrow(/API key/i);
    expect(() => assertNoPublishableSecrets('{"token":"live-secret-value"}')).toThrow(
      /credential assignment/i,
    );
    expect(() =>
      assertNoPublishableSecrets(
        '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      ),
    ).toThrow(/private key/i);
  });

  it('redacts complete delimiter-aware operational paths', () => {
    expect(
      sanitizePublicText(
        'Open `~/.worktrees/public-beads-project/秘密 roadmap.md` next.',
      ),
    ).toBe('Open `<redacted-local-path>` next.');
    expect(
      sanitizePublicText(
        'Plan: ".psyche/worktrees/public-beads-project/秘密 roadmap.md"; keep this note.',
      ),
    ).toBe('Plan: "<redacted-local-path>"; keep this note.');
    expect(
      sanitizePublicText(
        'Plan: [~/.copilot/session-state/run-1/秘密 roadmap.md] follows.',
      ),
    ).toBe('Plan: [<redacted-local-path>] follows.');
    expect(
      sanitizePublicText(
        "Plan: '.psyche/worktrees/public-beads-project/秘密 roadmap.md'; keep this note.",
      ),
    ).toBe("Plan: '<redacted-local-path>'; keep this note.");
    expect(
      sanitizePublicText(
        "Plan: '.psyche/worktrees/x/O'Reilly secret.md'; keep this note.",
      ),
    ).toBe("Plan: '<redacted-local-path>'; keep this note.");
    expect(
      sanitizePublicText(
        'Plan: /opt/repos/.psyche/worktrees/public-beads-project/秘密/roadmap.md. Keep this sentence.',
      ),
    ).toBe('Plan: <redacted-local-path>. Keep this sentence.');
    expect(
      sanitizePublicText(
        'Checkout .worktrees/public-beads-project/secret roadmap.md before continuing.',
      ),
    ).toBe('Checkout <redacted-local-path> before continuing.');
    expect(
      sanitizePublicText(
        "Open .worktrees/public-beads-project/O'Reilly secret.md next.",
      ),
    ).toBe('Open <redacted-local-path> next.');
    expect(
      sanitizePublicText(
        "Open .worktrees/public-beads-project/secret O'Reilly.md next.",
      ),
    ).toBe('Open <redacted-local-path> next.');
  });

  it('preserves prose and path-like names outside operational path boundaries', () => {
    expect(
      sanitizePublicText(
        "Don't expose .worktrees/project/plan.md; it isn't public.",
      ),
    ).toBe("Don't expose <redacted-local-path>; it isn't public.");
    expect(
      sanitizePublicText(
        'Keep the release note before .worktrees/project/plan.md and the explanation after it.',
      ),
    ).toBe(
      'Keep the release note before <redacted-local-path> and the explanation after it.',
    );
    expect(
      sanitizePublicText(
        'Keep /public/example and .worktrees/project/plan.md as separate references.',
      ),
    ).toBe(
      'Keep /public/example and <redacted-local-path> as separate references.',
    );
    expect(
      sanitizePublicText(
        'Keep .worktrees-inspired prose, .copilot/session-stateful notes, and docs/.psyche/worktrees-notes.md public.',
      ),
    ).toBe(
      'Keep .worktrees-inspired prose, .copilot/session-stateful notes, and docs/.psyche/worktrees-notes.md public.',
    );
  });

  it('allowlists public bead fields and sanitizes bead text', () => {
    const parsedFeature = parseBeadExport(issuesJsonl, {
      assigneeMap: {
        'feature-owner@example.com': 'BunsDev',
      },
    }).find((bead) => bead.id === 'pb-feature');

    expect(parsedFeature).toBeTruthy();

    const rawFeature = {
      ...parsedFeature!,
      description: 'Email feature-owner@example.com when the sync lands.',
      notes: 'Local scratch output lived in /Users/buns/private/log.txt.',
      internalOwnerEmail: 'owner@example.com',
    };

    const publicFeature = toPublicBead(rawFeature);

    expect(publicFeature).toEqual({
      id: 'pb-feature',
      title: 'Model Beads project inventory',
      description: 'Email <redacted-email> when the sync lands.',
      design: designDocPath,
      specId: planDocPath,
      acceptanceCriteria: '- Expose hierarchy and blockers.\n- Keep assignee mapping safe.',
      notes: 'Local scratch output lived in ~/private/log.txt.',
      status: 'open',
      priority: 1,
      type: 'feature',
      blocked: false,
      labels: ['automation', 'beads'],
      parentId: 'pb-epic',
      blockedByIds: [],
      githubAssignee: 'BunsDev',
      createdAt: '2026-08-20T09:00:00Z',
      updatedAt: '2026-08-20T09:15:00Z',
      closedAt: null,
    });
    expect(publicFeature).not.toHaveProperty('internalOwnerEmail');
  });

  it('renders issue content with a single sync marker, linked active dependencies, and plain closed history', () => {
    const inventory = buildPublicInventory();
    const blocked = inventory.find((bead) => bead.id === 'pb-blocked');

    expect(blocked).toBeTruthy();

    const rendered = renderIssueBody(blocked!, buildContext(inventory));

    expect(renderIssueTitle(blocked!)).toBe('[pb-blocked] Render the blocked task row');
    expect(countMatches(rendered, '<!-- psyche-bead-sync:v1 bead-id=pb-blocked -->')).toBe(1);
    expect(rendered).toContain('## Bead');
    expect(rendered).toContain('## Goal');
    expect(rendered).toContain('## Description');
    expect(rendered).toContain('## Design');
    expect(rendered).toContain('## Acceptance criteria');
    expect(rendered).toContain('## Implementation notes');
    expect(rendered).toContain('## Dependencies');
    expect(rendered).toContain('## Labels');
    expect(rendered).toContain('## Source metadata');
    expect(rendered).toContain('## Authority notice');
    expect(rendered).toContain('generated public mirror of a Beads record');
    expect(rendered).not.toContain('private Beads');
    expect(rendered).toContain(
      '[#2](https://github.com/OpenCoven/psyche-build-public/issues/2) `pb-feature` — Model Beads project inventory',
    );
    expect(rendered).toContain(
      '[#3](https://github.com/OpenCoven/psyche-build-public/issues/3) `pb-in-progress` — Track in-progress beads',
    );
    expect(rendered).toContain(
      'closed `pb-closed` — Preserve closed blocker history',
    );
    expect(rendered).not.toContain(
      'https://github.com/OpenCoven/psyche-build-public/issues/4',
    );
    expect(rendered).toContain(
      `[${designDocPath}](https://github.com/OpenCoven/psyche-build/blob/f2f1da60/${designDocPath})`,
    );
    expect(rendered).toContain(
      `[${planDocPath}](https://github.com/OpenCoven/psyche-build/blob/f2f1da60/${planDocPath})`,
    );
  });

  it('renders configured issue and Project markers instead of hardcoded defaults', () => {
    const inventory = buildPublicInventory();
    const feature = inventory.find((bead) => bead.id === 'pb-feature');
    expect(feature).toBeTruthy();
    const markerContext = buildContext(inventory, {
      issueMarker: 'custom-issue-sync:v2',
      projectMarker: 'custom-project-sync:v2',
    });

    const issue = renderIssueBody(feature!, markerContext);
    const readme = renderProjectReadme(inventory, markerContext);

    expect(issue).toContain('<!-- custom-issue-sync:v2 bead-id=pb-feature -->');
    expect(issue).not.toContain('<!-- psyche-bead-sync:v1 bead-id=pb-feature -->');
    expect(readme).toContain('<!-- custom-project-sync:v2 project-readme -->');
    expect(readme).not.toContain('<!-- psyche-bead-sync:v1 project-readme -->');
  });

  it('sanitizes mirrored dependency issue URLs before rendering dependency links', () => {
    const inventory = buildPublicInventory();
    const blocked = inventory.find((bead) => bead.id === 'pb-blocked');

    expect(blocked).toBeTruthy();

    const rendered = renderIssueBody(
      blocked!,
      buildContext(inventory, {
        mirroredIssueUrlsByBeadId: {
          'pb-feature': 'https://mirror-user:mirror-pass@ghe.example.com/OpenCoven/psyche-build-public/issues/2?path=/Users/buns/private#mirror',
          'pb-in-progress': 'https://github.com/OpenCoven/psyche-build-public/issues/3#/home/alice/file',
          'pb-closed': 'https://github.com/OpenCoven/psyche-build-public/issues/4',
        },
      }),
    );

    expect(rendered).toContain(
      '- Parent: [#2](https://ghe.example.com/OpenCoven/psyche-build-public/issues/2?path=~/private#mirror) `pb-feature` — Model Beads project inventory',
    );
    expect(rendered).toContain(
      '- Blocked by: [#3](https://github.com/OpenCoven/psyche-build-public/issues/3#/home/alice/file) `pb-in-progress` — Track in-progress beads',
    );
    expect(rendered).not.toContain('mirror-user');
    expect(rendered).not.toContain('mirror-pass');
    expect(rendered).not.toContain('/Users/buns/private');
    expect(rendered).toContain('/issues/3#/home/alice/file');
    expect(rendered).not.toMatch(/https:\/\/[^)\s]*@/u);
  });

  it('omits invalid or secret-bearing mirrored dependency issue URLs from dependency links', () => {
    const inventory = buildPublicInventory();
    const blocked = inventory.find((bead) => bead.id === 'pb-blocked');
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

    expect(blocked).toBeTruthy();

    const rendered = renderIssueBody(
      blocked!,
      buildContext(inventory, {
        mirroredIssueUrlsByBeadId: {
          'pb-feature': 'ssh://ghe.example.com/OpenCoven/psyche-build-public/issues/2',
          'pb-in-progress': `https://ghe.example.com/OpenCoven/psyche-build-public/issues/3?access_token=${token}`,
          'pb-closed': 'https://github.com/OpenCoven/psyche-build-public/issues/4',
        },
      }),
    );

    expect(rendered).toContain(
      '- Parent: `pb-feature` — Model Beads project inventory',
    );
    expect(rendered).toContain(
      '- Blocked by: `pb-in-progress` — Track in-progress beads',
    );
    expect(rendered).not.toContain('ssh://ghe.example.com/OpenCoven/psyche-build-public/issues/2');
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain('access_token=');
  });

  it('links only normalized repository-relative design and plan paths', () => {
    const inventory = buildPublicInventory();
    const [feature] = inventory.filter((bead) => bead.id === 'pb-feature');

    expect(feature).toBeTruthy();

    const renderedRepositoryLink = renderIssueBody(
      feature!,
      buildContext(inventory, {
        sourceRepositoryUrl: 'https://mirror-user:mirror-pass@ghe.example.com/OpenCoven/psyche-build.git/',
      }),
    );

    expect(renderedRepositoryLink).toContain(
      `[${designDocPath}](https://ghe.example.com/OpenCoven/psyche-build/blob/f2f1da60/${designDocPath})`,
    );
    expect(renderedRepositoryLink).not.toContain('mirror-user');
    expect(renderedRepositoryLink).not.toContain('mirror-pass');
    expect(renderedRepositoryLink).not.toMatch(/https:\/\/[^)\s]*@/u);

    for (const unsafePath of [
      '~/.copilot/session-state/run-1/plan.md',
      '.copilot/session-state/run-1/plan.md',
      '.worktrees/mobile-multiproject-cockpit/docs/spec.md',
      '.psyche/worktrees/public-beads-project/docs/spec.md',
      './.psyche/worktrees/public-beads-project/docs/spec.md',
      'psyche-build/.psyche/worktrees/public-beads-project/docs/spec.md',
      '~/.psyche/worktrees/public-beads-project/docs/spec.md',
      '/opt/repos/psyche-build/.psyche/worktrees/public-beads-project/docs/spec.md',
      '../outside/plan.md',
      './docs/plan.md',
      'docs/~scratch/plan.md',
      '/Users/buns/private/plan.md',
      'C:\\Users\\buns\\private\\plan.md',
      'file:/Users/buns/private/plan.md',
      `https://ghe.example.com/OpenCoven/psyche-build/blob/main/${designDocPath}`,
    ]) {
      const renderedUnsafeSource = renderIssueBody(
        {
          ...feature!,
          design: unsafePath,
          specId: unsafePath,
        },
        buildContext(inventory),
      );

      expect(renderedUnsafeSource).not.toContain(unsafePath);
      expect(renderedUnsafeSource).not.toContain('## Design');
      expect(renderedUnsafeSource).not.toContain('/blob/f2f1da60/~');
      expect(renderedUnsafeSource).not.toContain('/blob/f2f1da60/.copilot');
      expect(renderedUnsafeSource).not.toContain('/blob/f2f1da60/.worktrees');
    }

    const sanitizedUnsafeSource = toPublicBead({
      ...feature!,
      design: '~/.copilot/session-state/run-1/plan.md',
      specId: '.worktrees/mobile-multiproject-cockpit/docs/spec.md',
    });
    const renderedSanitizedSource = renderIssueBody(
      sanitizedUnsafeSource,
      buildContext(inventory),
    );

    expect(renderedSanitizedSource).not.toContain('## Design');
    expect(renderedSanitizedSource).not.toContain('<redacted-local-path>');
    expect(renderedSanitizedSource).not.toContain('/blob/f2f1da60/');

    for (const safePath of [
      'docs/.psyche/worktrees-inspired.md',
      'docs/.psyche-worktrees/guide.md',
      'docs/not.psyche/worktrees/guide.md',
    ]) {
      const renderedSafeSource = renderIssueBody(
        {
          ...feature!,
          design: safePath,
          specId: null,
        },
        buildContext(inventory),
      );

      expect(renderedSafeSource).toContain(
        `[${safePath}](https://github.com/OpenCoven/psyche-build/blob/f2f1da60/${safePath})`,
      );
    }
  });

  it('rejects secret-bearing repository and source URLs from public output', () => {
    const inventory = buildPublicInventory();
    const [feature] = inventory.filter((bead) => bead.id === 'pb-feature');
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

    expect(feature).toBeTruthy();

    const rendered = renderIssueBody(
      {
        ...feature!,
        design: `https://ghe.example.com/OpenCoven/psyche-build/blob/main/${designDocPath}?access_token=${token}`,
      },
      buildContext(inventory, {
        sourceRepositoryUrl: `git+https://x-access-token:${token}@github.com/OpenCoven/psyche-build.git`,
      }),
    );

    expect(rendered).toContain('## Design');
    expect(rendered).toContain(`- Plan: ${planDocPath}`);
    expect(rendered).not.toContain('- Design doc: https://');
    expect(rendered).not.toContain(token);
    expect(rendered).not.toContain('x-access-token');
    expect(rendered).not.toContain('access_token=');
    expect(rendered).not.toContain('https://github.com/OpenCoven/psyche-build/blob/');
  });

  it('renders dependencies in stable order regardless of blockedByIds order', () => {
    const inventory = buildPublicInventory();
    const blocked = inventory.find((bead) => bead.id === 'pb-blocked');

    expect(blocked).toBeTruthy();

    const reversedBlocked: PublicBead = {
      ...blocked!,
      blockedByIds: [...blocked!.blockedByIds].reverse(),
    };
    const deterministicDependencies = [
      '## Dependencies',
      '- Parent: [#2](https://github.com/OpenCoven/psyche-build-public/issues/2) `pb-feature` — Model Beads project inventory',
      '- Closed history: closed `pb-closed` — Preserve closed blocker history',
      '- Blocked by: [#3](https://github.com/OpenCoven/psyche-build-public/issues/3) `pb-in-progress` — Track in-progress beads',
    ].join('\n');

    const rendered = renderIssueBody(blocked!, buildContext(inventory));
    const renderedReversed = renderIssueBody(
      reversedBlocked,
      buildContext(
        inventory.map((bead) => bead.id === reversedBlocked.id ? reversedBlocked : bead),
      ),
    );

    expect(rendered).toContain(deterministicDependencies);
    expect(renderedReversed).toContain(deterministicDependencies);
  });

  it('omits empty sections and escapes extra sync markers from source content', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const minimal: PublicBead = {
      ...feature,
      description: null,
      design: null,
      specId: null,
      acceptanceCriteria: null,
      notes: 'User text <!-- psyche-bead-sync:v1 bead-id=shadow --> stays inert.',
      labels: [],
      parentId: null,
      blockedByIds: [],
    };

    const rendered = renderIssueBody(minimal, {
      inventoryById: new Map([[minimal.id, minimal]]),
    });

    expect(countMatches(rendered, '<!-- psyche-bead-sync:v1 bead-id=pb-feature -->')).toBe(1);
    expect(rendered).not.toContain('## Description');
    expect(rendered).not.toContain('## Design');
    expect(rendered).not.toContain('## Acceptance criteria');
    expect(rendered).not.toContain('## Dependencies');
    expect(rendered).not.toContain('## Labels');
    expect(rendered).toContain('&lt;!-- psyche-bead-sync:v1 bead-id=shadow -->');
  });

  it('normalizes headings outside fenced code blocks only', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const rendered = renderIssueBody(
      {
        ...feature,
        description: [
          '# Outside heading',
          '```ts',
          '# Inside backtick fence',
          '```',
          '~~~md',
          '## Inside tilde fence',
          '~~~',
          '## After fences',
        ].join('\n'),
      },
      {
        inventoryById: new Map([[feature.id, feature]]),
      },
    );

    expect(rendered).toContain('## Description\n## Outside heading');
    expect(rendered).toContain('```ts\n# Inside backtick fence\n```');
    expect(rendered).toContain('~~~md\n## Inside tilde fence\n~~~');
    expect(rendered).toContain('\n### After fences');
    expect(rendered).not.toContain('```ts\n## Inside backtick fence\n```');
    expect(rendered).not.toContain('~~~md\n### Inside tilde fence\n~~~');
  });

  it('renders labels with locale-independent deterministic ordering', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const rendered = renderIssueBody(
      {
        ...feature,
        labels: ['éclair', 'zeta', 'Ångström', 'apple'],
      },
      {
        inventoryById: new Map([[feature.id, feature]]),
      },
    );

    expect(rendered).toContain('## Labels\n- `apple`\n- `zeta`\n- `Ångström`\n- `éclair`');
  });

  it('renders README type counts and closed history with locale-independent deterministic ordering', () => {
    const inventory = buildPublicInventory();
    const [feature] = inventory.filter((bead) => bead.id === 'pb-feature');
    const extendedInventory: PublicBead[] = [
      ...inventory,
      {
        ...feature,
        id: 'pb-angstrom',
        title: 'Archive Å first',
        status: 'closed',
        priority: 2,
        type: 'Ångström',
        blocked: false,
        parentId: null,
        blockedByIds: [],
        githubAssignee: null,
        createdAt: '2026-08-21T09:00:00Z',
        updatedAt: '2026-08-21T12:00:00Z',
        closedAt: '2026-08-21T12:00:00Z',
      },
      {
        ...feature,
        id: 'pb-eclair',
        title: 'Archive é second',
        status: 'closed',
        priority: 2,
        type: 'éclair',
        blocked: false,
        parentId: null,
        blockedByIds: [],
        githubAssignee: null,
        createdAt: '2026-08-21T09:30:00Z',
        updatedAt: '2026-08-21T12:00:00Z',
        closedAt: '2026-08-21T12:00:00Z',
      },
    ];

    const rendered = renderProjectReadme(extendedInventory, buildContext(extendedInventory));

    expect(rendered).toContain(
      '## Type counts\n- epic: 1\n- feature: 1\n- task: 3\n- Ångström: 1\n- éclair: 1',
    );
    expect(rendered).toContain(
      '## Closed history summary\n'
        + '- `pb-angstrom` — Archive Å first (closed 2026-08-21T12:00:00Z)\n'
        + '- `pb-eclair` — Archive é second (closed 2026-08-21T12:00:00Z)\n'
        + '- `pb-closed` — Preserve closed blocker history (closed 2026-08-20T12:30:00Z)',
    );
  });

  it('renders deterministic project README content with counts, history, guide, and sync rules', () => {
    const inventory = buildPublicInventory();
    const context = buildContext(inventory);

    const rendered = renderProjectReadme(inventory, context);

    expect(rendered).toBe(renderProjectReadme(inventory, context));
    expect(countMatches(rendered, '<!-- psyche-beads-project-sync:v1 project-readme -->')).toBe(1);
    expect(rendered).toContain('# Public Beads inventory');
    expect(rendered).toContain('generated public tracking snapshot');
    expect(rendered).toContain('The Beads project remains authoritative');
    expect(rendered).not.toContain('private Beads');
    expect(rendered).toContain('- Inventory timestamp: 2026-08-22T20:00:00Z');
    expect(rendered).toContain('- Active beads: 4');
    expect(rendered).toContain('- Closed beads: 1');
    expect(rendered).toContain('- Blocked active beads: 1');
    expect(rendered).toContain('- epic: 1');
    expect(rendered).toContain('- feature: 1');
    expect(rendered).toContain('- task: 3');
    expect(rendered).toContain('- P0: 3');
    expect(rendered).toContain('- P1: 2');
    expect(rendered).toContain('## Closed history summary');
    expect(rendered).toContain('`pb-closed` — Preserve closed blocker history (closed 2026-08-20T12:30:00Z)');
    expect(rendered).toContain('## Field guide');
    expect(rendered).toContain('## Sync behavior');
    expect(rendered).toContain('## Authority');
  });
});
