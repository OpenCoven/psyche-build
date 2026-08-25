import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { describe, expect, it } from 'vitest';

import { buildBeadIndex, parseBeadExport } from '../scripts/beads-project-sync/model.mjs';
import {
  assertNoPublishableSecrets,
  sanitizePublicText,
  toPublicBead,
} from '../scripts/beads-project-sync/sanitize.mjs';
import {
  assertIssueBodyWithinLimit,
  assertProjectReadmeWithinLimit,
  GITHUB_ISSUE_BODY_MAX_CODE_POINTS,
  GITHUB_PROJECT_README_MAX_CODE_POINTS,
  renderIssueBody,
  renderIssueTitle,
  renderProjectReadme,
} from '../scripts/beads-project-sync/render.mjs';
import {
  DEFAULT_PROJECT_MARKER,
  renderHashMarker,
} from '../scripts/beads-project-sync/markers.mjs';
import type { RenderContext } from '../scripts/beads-project-sync/render.mjs';
import type { PublicBead } from '../scripts/beads-project-sync/sanitize.mjs';

const fixturePath = new URL('./fixtures/beads-project-sync/issues.jsonl', import.meta.url);
const issuesJsonl = readFileSync(fixturePath, 'utf8');
const designDocPath = 'docs/superpowers/specs/2026-08-21-public-beads-project-design.md';
const planDocPath = 'docs/superpowers/plans/2026-08-21-public-beads-project.md';
const runtimeHomeDirectory = os.homedir().replace(/[\\/]+$/gu, '').replace(/\\/gu, '/');
const runtimeHomeUrlPath = runtimeHomeDirectory.startsWith('/')
  ? runtimeHomeDirectory
  : `/${runtimeHomeDirectory}`;

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
    repositoryIdentity: 'OpenCoven/psyche-build',
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

function codePointLength(value: string): number {
  return [...value].length;
}

function makeClosedHistoryInventory(
  count: number,
  titleForIndex: (index: number) => string,
): PublicBead[] {
  const template = buildPublicInventory()[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: `pb-closed-${String(index + 1).padStart(4, '0')}`,
    title: titleForIndex(index),
    status: 'closed',
    priority: (index % 5) as PublicBead['priority'],
    type: 'task',
    blocked: false,
    parentId: null,
    blockedByIds: [],
    githubAssignee: null,
    updatedAt: '2026-08-23T12:00:00Z',
    closedAt: '2026-08-23T12:00:00Z',
  }));
}

function managedProjectReadmeBody(rendered: string): string {
  return `${rendered}\n\n${renderHashMarker(DEFAULT_PROJECT_MARKER, '0'.repeat(64))}`;
}

function closedHistoryLines(rendered: string): string[] {
  const section = rendered
    .split('## Closed history summary\n')[1]
    ?.split('\n\n## Field guide')[0];
  expect(section).toBeTruthy();
  return section!.split('\n').filter((line) => line.startsWith('- `'));
}

function omittedClosedCount(rendered: string): number {
  const match = rendered.match(/^- (\d+) additional closed beads omitted\.$/mu);
  return match == null ? 0 : Number.parseInt(match[1]!, 10);
}

function renderSourceDescription(description: string): string {
  const source = parseBeadExport(issuesJsonl, {
    assigneeMap: {
      'feature-owner@example.com': 'BunsDev',
    },
  }).find((bead) => bead.id === 'pb-feature');

  expect(source).toBeTruthy();
  const publicBead = toPublicBead({
    ...source!,
    description,
  });
  return renderIssueBody(publicBead, buildContext([publicBead]));
}

function assertGeneratedIssueHeadingsAreTopLevel(rendered: string): void {
  const tree = fromMarkdown(rendered, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const headings = tree.children
    .filter((node) => node.type === 'heading')
    .map((node) => node.children
      .map((child) => 'value' in child ? child.value : '')
      .join(''));

  expect(headings).toContain('Source metadata');
  expect(headings).toContain('Authority notice');
}

describe('Beads project renderers', () => {
  it.each([true, '1', 1.5, -1, 5])(
    'rejects invalid public priority value %s',
    (priority) => {
      const source = parseBeadExport(issuesJsonl, {
        assigneeMap: {},
      })[0]!;

      expect(() => toPublicBead({
        ...source,
        priority: priority as unknown as PublicBead['priority'],
      })).toThrow(/priority.*integer.*0.*4|priority.*0.*4/i);
    },
  );

  it('keeps an ASCII issue title unchanged when it fits', () => {
    const bead = {
      ...buildPublicInventory()[0]!,
      id: 'pb-ascii',
      title: 'Ship the public project sync',
    };

    expect(renderIssueTitle(bead)).toBe('[pb-ascii] Ship the public project sync');
  });

  it('counts emoji as Unicode code points when truncating issue titles', () => {
    const beadId = 'pb-emoji';
    const prefix = `[${beadId}] `;
    const availableTitleCodePoints = 256 - codePointLength(prefix);
    const bead = {
      ...buildPublicInventory()[0]!,
      id: beadId,
      title: '😀'.repeat(availableTitleCodePoints + 5),
    };

    const rendered = renderIssueTitle(bead);

    expect(codePointLength(rendered)).toBe(256);
    expect(rendered).toBe(
      `${prefix}${'😀'.repeat(availableTitleCodePoints - 3)}...`,
    );
  });

  it('preserves an issue title that is exactly 256 Unicode code points', () => {
    const beadId = 'pb-exact';
    const prefix = `[${beadId}] `;
    const availableTitleCodePoints = 256 - codePointLength(prefix);
    const bead = {
      ...buildPublicInventory()[0]!,
      id: beadId,
      title: 'a'.repeat(availableTitleCodePoints),
    };

    const rendered = renderIssueTitle(bead);

    expect(codePointLength(rendered)).toBe(256);
    expect(rendered).toBe(`${prefix}${bead.title}`);
  });

  it('truncates an over-limit ASCII issue title and preserves the full Goal', () => {
    const beadId = 'pb-over';
    const prefix = `[${beadId}] `;
    const availableTitleCodePoints = 256 - codePointLength(prefix);
    const bead = {
      ...buildPublicInventory()[0]!,
      id: beadId,
      title: 'a'.repeat(availableTitleCodePoints + 1),
    };

    const rendered = renderIssueTitle(bead);

    expect(codePointLength(rendered)).toBe(256);
    expect(rendered).toBe(
      `${prefix}${'a'.repeat(availableTitleCodePoints - 3)}...`,
    );
    expect(renderIssueBody(bead)).toContain(`## Goal\n${bead.title}`);
  });

  it('rejects a Bead id that leaves no meaningful issue title room', () => {
    const bead = {
      ...buildPublicInventory()[0]!,
      id: 'a'.repeat(250),
      title: 'Ship the public project sync',
    };

    expect(() => renderIssueTitle(bead)).toThrow(/meaningful.*title room/i);
  });

  it('redacts emails and local home paths but rejects publishable secrets', () => {
    expect(
      sanitizePublicText(
        'Contact owner@example.com from /Users/buns/Documents/GitHub/OpenCoven/psyche-build.',
      ),
    ).toBe('Contact [redacted-email] from ~/Documents/GitHub/OpenCoven/psyche-build.');
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
      sanitizePublicText(
        `Keep https://example.com${runtimeHomeUrlPath}/docs `
          + 'and https://example.com/home/alice/docs public.',
      ),
    ).toBe(
      'Keep https://example.com/[redacted-local-path] '
        + 'and https://example.com/home/alice/docs public.',
    );
    expect(sanitizePublicText('Keep https://example.com/.worktrees/releases public.')).toBe(
      'Keep https://example.com/[redacted-local-path] public.',
    );
    expect(
      sanitizePublicText('Keep http://example.com/.psyche/worktrees/releases public.'),
    ).toBe('Keep http://example.com/[redacted-local-path] public.');
    expect(sanitizePublicText('Keep https://example.com/?path=/Users/buns/docs public.')).toBe(
      'Keep https://example.com/?path=~/docs public.',
    );
    expect(sanitizePublicText('Keep https://example.com/?route=/home/alice/docs public.')).toBe(
      'Keep https://example.com/?route=~/docs public.',
    );
    expect(sanitizePublicText(`Keep https://example.com/#${runtimeHomeDirectory}/docs public.`)).toBe(
      'Keep https://example.com/#~/docs public.',
    );
    expect(sanitizePublicText('Keep https://example.com/#/home/alice/docs public.')).toBe(
      'Keep https://example.com/#~/docs public.',
    );
    expect(
      sanitizePublicText(
        'Keep https://example.com/?path=%2FUsers%2Fbuns%2Fdocs#%2Fhome%2Falice%2Fdocs public.',
      ),
    ).toBe(
      'Keep https://example.com/?path=~/docs#~/docs public.',
    );
    expect(sanitizePublicText('Plan: ~/.copilot/session-state/run-1/plan.md')).toBe(
      'Plan: [redacted-local-path]',
    );
    expect(sanitizePublicText('Plan: .copilot/session-state/run-1/plan.md')).toBe(
      'Plan: [redacted-local-path]',
    );
    expect(
      sanitizePublicText('Checkout .worktrees/mobile-multiproject-cockpit before continuing.'),
    ).toBe('Checkout [redacted-local-path] before continuing.');
    expect(
      sanitizePublicText('/Users/buns/.copilot/session-state/run-1/plan.md'),
    ).toBe('[redacted-local-path]');
    for (const localPath of [
      '.psyche/worktrees/public-beads-project/plan.md',
      './.psyche/worktrees/public-beads-project/plan.md',
      'psyche-build/.psyche/worktrees/public-beads-project/plan.md',
      '~/.psyche/worktrees/public-beads-project/plan.md',
      '/opt/repos/psyche-build/.psyche/worktrees/public-beads-project/plan.md',
      'C:\\repos\\psyche-build\\.psyche\\worktrees\\public-beads-project\\plan.md',
    ]) {
      expect(sanitizePublicText(`Plan: ${localPath}`)).toBe('Plan: [redacted-local-path]');
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

  it('redacts URL userinfo across schemes before public rendering', () => {
    const rendered = sanitizePublicText(
      [
        'https://alice:secret@example.com/repo',
        'ssh://deploy:secret@example.com/home/deploy/repo',
        'git://token@example.com/OpenCoven/psyche-build.git',
        'custom+tool://name:password@example.com/route',
      ].join('\n'),
    );

    expect(rendered).toBe([
      'https://example.com/repo',
      'ssh://example.com/~/repo',
      'git://example.com/OpenCoven/psyche-build.git',
      'custom+tool://example.com/route',
    ].join('\n'));
    expect(rendered).not.toContain('alice');
    expect(rendered).not.toContain('secret');
    expect(rendered).not.toContain('token@');
    expect(() =>
      assertNoPublishableSecrets('ssh://deploy:secret@example.com/repo')
    ).toThrow(/URL credentials/i);
  });

  it('sanitizes local paths in non-HTTP URLs while preserving safe external routes', () => {
    expect(
      sanitizePublicText(
        'Open vscode://file/Users/buns/project/src/main.ts and ssh://host/home/alice/private/repo.',
      ),
    ).toBe(
      'Open vscode://file/~/project/src/main.ts and ssh://host/~/private/repo.',
    );
    expect(
      sanitizePublicText(
        'Keep vscode://extension/publisher.safe and ssh://host/srv/public/releases intact.',
      ),
    ).toBe(
      'Keep vscode://extension/publisher.safe and ssh://host/srv/public/releases intact.',
    );
    expect(
      sanitizePublicText(
        'Open ssh://host/srv/public?workspace=.psyche/worktrees/run#/home/alice/private.',
      ),
    ).toBe(
      'Open ssh://host/srv/public?workspace=[redacted-local-path]#~/private.',
    );
  });

  it('sanitizes operational paths in every sensitive HTTP URL component', () => {
    expect(
      sanitizePublicText(
        'Keep https://example.com/.worktrees/releases?cwd=.psyche/worktrees/run-1'
          + '#/.copilot/session-state/run-2/plan.md public.',
      ),
    ).toBe(
      'Keep https://example.com/[redacted-local-path]?cwd=[redacted-local-path]'
        + '#[redacted-local-path] public.',
    );
    expect(
      sanitizePublicText(
        'Keep https://example.com/docs?workspace=%2Eworktrees%2Frun-1'
          + '#route?plan=%2Epsyche%2Fworktrees%2Frun-2 public.',
      ),
    ).toBe(
      'Keep https://example.com/docs?workspace=[redacted-local-path]'
        + '#route?plan=[redacted-local-path] public.',
    );
    expect(
      sanitizePublicText(
        'Keep https://example.com/home/alice/docs'
          + '?source=/Users/alice/private#preview=/home/bob/private public.',
      ),
    ).toBe(
      'Keep https://example.com/home/alice/docs?source=~/private#preview=~/private public.',
    );
  });

  it('redacts recursively decoded sensitive HTTP pathnames without rebuilding leaked paths', () => {
    const config = {
      homeDirectories: [
        '/Users/build-user',
        '/home/build-user',
        'C:\\Users\\build-user',
      ],
    };
    const unsafeUrls = [
      'https://example.com/Users/build-user/private/client-plan.md',
      'https://example.com/home/build-user/private/client-plan.md',
      'https://example.com/C:/Users/build-user/private/client-plan.md',
      'https://example.com/%252Eworktrees%252Fpublic-beads-project%252Fplan.md',
      'https://example.com/%26percnt%3B2Ecopilot%26sol%3Bsession-state'
        + '%26sol%3Brun-1%26sol%3Bplan.md',
      'https://example.com/&percnt;2Epsyche&sol;worktrees&sol;run-2&sol;plan.md',
      'https://example.com/%26sol%3BUsers%26sol%3Bbuild-user'
        + '%26sol%3Bprivate%26sol%3Bplan.md',
      'https://example.com&sol;&percnt;2Eworktrees&sol;run-3&sol;plan.md',
    ];

    for (const unsafeUrl of unsafeUrls) {
      const sanitized = sanitizePublicText(`Open ${unsafeUrl}?view=public#summary`, config);
      expect(sanitized).toBe(
        'Open https://example.com/[redacted-local-path]?view=public#summary',
      );
      expect(sanitized).not.toContain('client-plan');
      expect(sanitized).not.toContain('public-beads-project');
      expect(sanitized).not.toContain('session-state');
      expect(sanitized).not.toContain('run-2');
      expect(sanitized).not.toContain('run-3');
    }

    expect(
      sanitizePublicText(
        'Keep https://example.com/home/alice/docs, '
          + 'https://example.com/.well-known/openid-configuration, '
          + 'https://example.com/.worktrees-inspired/releases, and '
          + 'https://example.com/docs/.psyche/worktrees-notes.md public.',
        config,
      ),
    ).toBe(
      'Keep https://example.com/home/alice/docs, '
        + 'https://example.com/.well-known/openid-configuration, '
        + 'https://example.com/.worktrees-inspired/releases, and '
        + 'https://example.com/docs/.psyche/worktrees-notes.md public.',
    );
  });

  it('recursively inspects encoded URL components without rewriting safe public encoding', () => {
    expect(
      sanitizePublicText(
        [
          'file:///%252FUsers%252Fbuns%252Fprivate%2520notes.md',
          'ssh://host/%252Epsyche%252Fworktrees%252Frun',
          'https://example.com/releases?cwd=%252FUsers%252Fbuns%252Fprivate'
            + '%2526admin%253Dtrue&workspace=%252Epsyche%252Fworktrees%252Frun'
            + '#%252Fhome%252Falice%252Fsecret%2529preview',
          'https://example.com/releases/My%20Project'
            + '?redirect=%252Fpublic%252Fdocs#section%202',
        ].join('\n'),
      ),
    ).toBe([
      'file:///~/private%20notes.md',
      'ssh://host/[redacted-local-path]',
      'https://example.com/releases?cwd=~/private%26admin%3Dtrue'
        + '&workspace=[redacted-local-path]#~/secret%29preview',
      'https://example.com/releases/My%20Project'
        + '?redirect=%252Fpublic%252Fdocs#section%202',
    ].join('\n'));
  });

  it('rejects recursively encoded URL secrets and malformed percent encodings', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const encodedToken = token.replace('_', '%5F');
    const doubleEncodedToken = token.replace('_', '%255F');
    const overEncodedToken = token.replace('_', '%2525255F');

    for (const unsafeUrl of [
      `https://example.com/releases/${encodedToken}`,
      `https://example.com/releases?access_token=${doubleEncodedToken}`,
      `https://example.com/releases#token=${encodedToken}`,
      `https://x-access-token:${doubleEncodedToken}@example.com/releases`,
    ]) {
      expect(() => sanitizePublicText(`Publish ${unsafeUrl}`)).toThrow(
        /Publishable (?:GitHub token|API key|credential)/i,
      );
    }
    expect(() =>
      sanitizePublicText(`Publish https://example.com/releases/${overEncodedToken}`)
    ).toThrow(/decoding limit/i);
    expect(() =>
      sanitizePublicText(`Publish https://example.com/releases/%25x${overEncodedToken}`)
    ).toThrow(/malformed percent encoding/i);
    expect(() =>
      sanitizePublicText(`Publish https://example.com/${'%41'.repeat(6_000)}`)
    ).toThrow(/inspection limit/i);
    expect(() =>
      sanitizePublicText(`Publish https://example.com/${'a'.repeat(17_000)}`)
    ).toThrow(/URL candidate exceeds the inspection limit/i);

    for (const malformedUrl of [
      'https://example.com/%',
      'https://example.com/?path=%2',
      'https://example.com/#route=%GG',
      'ssh://host/%FF',
    ]) {
      expect(() => sanitizePublicText(`Publish ${malformedUrl}`)).toThrow(
        /malformed percent encoding/i,
      );
    }
  });

  it('scans complete delimiter-bearing URLs while preserving balanced public URLs', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

    expect(() =>
      sanitizePublicText(
        `Publish https://example.com/(${token.replace('_', '%5F')})`,
      )
    ).toThrow(/Publishable GitHub token/i);

    const redacted = sanitizePublicText(
      'Open ssh://host/(%252Epsyche%252Fworktrees%252Frun) next.',
    );
    expect(redacted).toContain('[redacted-local-path]');
    expect(redacted).not.toContain('%252Epsyche');
    expect(redacted).not.toContain('.psyche/worktrees');

    expect(
      sanitizePublicText(
        'See [https://example.com/[docs]/(v2)?redirect=%252Fpublic%252Fdocs].',
      ),
    ).toBe(
      'See [https://example.com/[docs]/(v2)?redirect=%252Fpublic%252Fdocs].',
    );
  });

  it('inspects decoded URL parses and encoded authority variants', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

    for (const encodedAt of ['%40', '%2540']) {
      expect(() =>
        sanitizePublicText(`Publish https://alice${encodedAt}example.com/releases`)
      ).toThrow(/URL credentials/i);
    }
    expect(() =>
      sanitizePublicText(
        `Publish https://${token.replace('_', '%5F')}.example.com/releases`,
      )
    ).toThrow(/Publishable GitHub token/i);
    expect(() =>
      assertNoPublishableSecrets('https://alice:p(ass)@example.com/releases')
    ).toThrow(/URL credentials/i);
    expect(
      sanitizePublicText(
        'Open file://host%252F.psyche%252Fworktrees%252Frun next.',
      ),
    ).toBe('Open [redacted-local-path] next.');
  });

  it('inspects opaque and slashless absolute URI components recursively while preserving safe URIs', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const encodedToken = token.replace('_', '%5F');
    const doubleEncodedToken = token.replace('_', '%255F');

    expect(
      sanitizePublicText([
        'mailto:team@example.com?subject=Public%20roadmap',
        'data:text/plain,hello%20world',
        'urn:ietf:rfc:3986',
        'file:/srv/public/releases',
      ].join('\n')),
    ).toBe([
      'mailto:[redacted-email]?subject=Public%20roadmap',
      'data:text/plain,hello%20world',
      'urn:ietf:rfc:3986',
      'file:/srv/public/releases',
    ].join('\n'));

    expect(
      sanitizePublicText([
        'file:/Users/buns/private/notes.md',
        'urn:psyche:%252Epsyche%252Fworktrees%252Frun',
        'mailto:team@example.com?workspace=%252Eworktrees%252Frun'
          + '#preview=%252FUsers%252Fbuns%252Fprivate',
      ].join('\n')),
    ).toBe([
      'file:/~/private/notes.md',
      'urn:[redacted-local-path]',
      'mailto:[redacted-email]?workspace=[redacted-local-path]#preview=~/private',
    ].join('\n'));

    for (const unsafeUri of [
      `mailto:team@example.com?subject=${encodedToken}`,
      'data:text/plain,%252Fhome%252Falice%252Fprivate',
      `data:text/plain,${doubleEncodedToken}`,
      `urn:psyche:${encodedToken}`,
      `file://${encodedToken}.example/srv/public`,
    ]) {
      expect(() => sanitizePublicText(`Publish ${unsafeUri}`)).toThrow(
        /Publishable GitHub token|data URI.*sensitive/i,
      );
    }
    expect(() => sanitizePublicText('Publish data:text/plain,%2')).toThrow(
      /malformed percent encoding/i,
    );
  });

  it('strictly validates bounded base64 data URIs and recursively inspects decoded text', () => {
    const safe = 'data:text/plain;base64,aGVsbG8gd29ybGQ=';
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
    const sensitiveValues = [
      token,
      'team@example.com',
      '/Users/alice/private/notes.md',
      '.worktrees/run/private.log',
      `data:text/plain,${
        encodeURIComponent('api_key = "live-secret-value"')
      }`,
    ];

    expect(sanitizePublicText(`Embedded ${safe}`)).toBe(`Embedded ${safe}`);
    for (const sensitive of sensitiveValues) {
      const encoded = Buffer.from(sensitive, 'utf8').toString('base64');
      expect(() =>
        sanitizePublicText(`Embedded data:text/plain;base64,${encoded}`)
      ).toThrow(/data URI.*sensitive|Publishable|email|local path/i);
    }
    for (const invalid of [
      'data:text/plain;base64,!!!!',
      'data:text/plain;base64,aGVsbG8',
      'data:text/plain;base64,aGVs%20bG8=',
    ]) {
      expect(() => sanitizePublicText(invalid)).toThrow(/invalid.*base64|base64.*invalid/i);
    }

    const decodedOversize = Buffer.alloc(8_193, 0x61).toString('base64');
    expect(() =>
      sanitizePublicText(`data:application/octet-stream;base64,${decodedOversize}`)
    ).toThrow(/decoded.*limit|data URI.*large/i);
    expect(() =>
      sanitizePublicText(`data:text/plain;base64,${'A'.repeat(12_292)}`)
    ).toThrow(/encoded.*limit|data URI.*large/i);
  });

  it('rejects sensitive ASCII windows in invalid UTF-8 binary data payloads', () => {
    const sensitiveBinaryValues = [
      Buffer.from([0xff, ...Buffer.from('github_pat_abcdefghijklmnopqrstuvwxyz1234567890')]),
      Buffer.from([0x00, ...Buffer.from('api_key = "live-secret-value"'), 0xfe]),
      Buffer.from([0x80, ...Buffer.from('team@example.com')]),
      Buffer.from([0xf5, ...Buffer.from('/Users/alice/private/notes.md')]),
      Buffer.from([0xc0, ...Buffer.from('.worktrees/run/private.log')]),
    ];

    for (const sensitive of sensitiveBinaryValues) {
      expect(() =>
        sanitizePublicText(
          `data:application/octet-stream;base64,${sensitive.toString('base64')}`,
        )
      ).toThrow(/data URI.*sensitive|Publishable|email|local path/i);
    }

    const safeBinary = Buffer.from([0xff, 0x00, 0x41, 0x80, 0x42]);
    const safe = `data:application/octet-stream;base64,${safeBinary.toString('base64')}`;
    expect(sanitizePublicText(safe)).toBe(safe);
  });

  it('fails closed for sensitive non-base64 data payloads while preserving small safe data', () => {
    expect(sanitizePublicText('data:text/plain,hello%20public')).toBe(
      'data:text/plain,hello%20public',
    );
    for (const unsafe of [
      'data:text/plain,team%40example.com',
      'data:text/plain,%252Eworktrees%252Frun%252Fnotes.md',
      'data:text/plain,%26%23x2F%3BUsers%26%23x2F%3Balice%26%23x2F%3Bprivate',
      'data:text/plain,github%255Fpat%255Fabcdefghijklmnopqrstuvwxyz1234567890',
    ]) {
      expect(() => sanitizePublicText(unsafe)).toThrow(
        /data URI.*sensitive|Publishable|email|local path/i,
      );
    }
  });

  it('discovers recursively entity/percent-encoded data schemes without rewriting safe values', () => {
    const safeValues = [
      'd&#x61;ta:text/plain,hello%20public',
      'd%26%23x61%3Bta%3Atext/plain,hello%20public',
      '[safe](d&#x61;ta:text/plain,hello%20public)',
      '[recursive](d%26%23x61%3Bta%3Atext/plain,hello%20public)',
      '<img srcset="d&#x61;ta:text/plain,hello%20public 1x, public.png 2x">',
    ];
    expect(sanitizePublicText(safeValues.join('\n'))).toBe(safeValues.join('\n'));

    for (const unsafe of [
      'd&#x61;ta:text/plain,team%40example.com',
      'd%26%23x61%3Bta%3Atext/plain,%252FUsers%252Falice%252Fprivate',
      '[secret](d&#x61;ta:text/plain,api%255Fkey%20%3D%20live-secret)',
      '[token](d%26%23x61%3Bta%3Atext/plain,github%255Fpat%255Fabcdefghijklmnopqrstuvwxyz1234567890)',
    ]) {
      expect(() => sanitizePublicText(unsafe)).toThrow(
        /data URI.*sensitive|Publishable|email|local path/i,
      );
    }
  });

  it('structurally sanitizes raw HTML URL attributes and srcset candidates', () => {
    const unsafe = [
      '<a HREF="%2Eworktrees%2Frun%2Fnotes.md">worktree</a>',
      '<img src="&#47;Users&#47;alice&#47;private.png">',
      "<form action='mailto:team%40example.com'></form>",
      '<video poster=/home/alice/private.jpg></video>',
      '<blockquote cite="https://example.com/%2Epsyche%2Fworktrees%2Frun"></blockquote>',
      '<object data="https://example.com/%2FUsers%2Falice%2Fprivate"></object>',
      '<img srcset="/Users/alice/one.png 1x, %2Eworktrees%2Frun/two.png 2x,'
        + ' https://example.com/public.png 3x">',
    ].join('\n');

    const sanitized = sanitizePublicText(unsafe);

    expect(sanitized).toContain('HREF="[redacted-local-path]"');
    expect(sanitized).toContain('src="~/private.png"');
    expect(sanitized).toContain("action='mailto:[redacted-email]'");
    expect(sanitized).toContain('poster=~/private.jpg');
    expect(sanitized).toContain('cite="https://example.com/[redacted-local-path]"');
    expect(sanitized).toContain('data="https://example.com/~/private"');
    expect(sanitized).toContain(
      'srcset="~/one.png 1x, [redacted-local-path] 2x,'
        + ' https://example.com/public.png 3x"',
    );
    expect(sanitized).not.toMatch(/Users|home\/alice|\.worktrees|\.psyche\/worktrees/iu);
  });

  it('sanitizes the documented single, list, and srcset raw HTML URL attributes', () => {
    const unsafe = [
      '<button formaction="%2Eworktrees%2Frun%2Fsubmit">Submit</button>',
      '<a ping="%2FUsers%2Falice%2Fping https://example.com/public">Ping</a>',
      '<body background="%2Fhome%2Falice%2Fbackground.png">',
      '<img longdesc="%2Epsyche%2Fworktrees%2Frun%2Fdetails.html">',
      '<html manifest="%2FUsers%2Falice%2Fsite.appcache">',
      '<head profile="%2Fhome%2Falice%2Fprofile">',
      '<img usemap="%2Ecopilot%2Fsession-state%2Frun%2Fmap">',
      '<object codebase="%2FUsers%2Falice%2Fclasses/"></object>',
      '<object archive="%2Fhome%2Falice%2Fa.jar public.jar"></object>',
      '<object classid="%2Eworktrees%2Frun%2Fclassid"></object>',
      '<svg><use xlink:href="%2FUsers%2Falice%2Ficons.svg%23private"></use></svg>',
      '<div itemid="%2Fhome%2Falice%2Fitem"></div>',
      '<div itemtype="%2Eworktrees%2Frun%2Ftype https://example.com/Public"></div>',
      '<img srcset="%2FUsers%2Falice%2Fone.png 1x, public.png 2x">',
    ].join('\n');

    const sanitized = sanitizePublicText(unsafe);

    expect(sanitized).not.toMatch(/%2FUsers|%2Fhome|%2E(?:worktrees|psyche|copilot)/iu);
    expect(sanitized).toContain('formaction="[redacted-local-path]"');
    expect(sanitized).toContain('ping="~/ping https://example.com/public"');
    expect(sanitized).toContain('archive="~/a.jar public.jar"');
    expect(sanitized).toContain('srcset="~/one.png 1x, public.png 2x"');
  });

  it('rejects credential-bearing, malformed, and overlong raw HTML URL attributes', () => {
    expect(() =>
      sanitizePublicText(
        '<a href="https&colon;&sol;&sol;alice&commat;example.com/private">private</a>',
      )
    ).toThrow(/URL credentials/i);
    expect(sanitizePublicText('<a href="https://example.com"')).toBe(
      '<a href="https://example.com"',
    );
    expect(() =>
      sanitizePublicText(`<img src="${'a'.repeat(17_000)}">`)
    ).toThrow(/raw HTML.*inspection limit|tag.*inspection limit/i);
  });

  it('preserves safe raw HTML URL attributes and surrounding prose exactly', () => {
    const safe = [
      'Before <a href="https://example.com/docs?q=public">Docs</a> after.',
      '<img SRC=images/public.png alt="Public image">',
      '<form action="/public/search"><button>Search</button></form>',
      '<img srcset="small.png 1x, large.png 2x">',
      '<button formaction="/public/submit">Submit</button>',
      '<a ping="/public/a https://example.com/public/b">Ping</a>',
      '<body background="/public/background.png">',
      '<img longdesc="/public/details.html">',
      '<html manifest="/public/site.webmanifest">',
      '<head profile="/public/profile">',
      '<img usemap="#public-map">',
      '<object codebase="/public/classes/" archive="a.jar b.jar" classid="public-class"></object>',
      '<svg><use xlink:href="/public/icons.svg#public"></use></svg>',
      '<div itemid="https://example.com/public-item"'
        + ' itemtype="https://schema.org/Thing https://example.com/Public"></div>',
      '<div aria-label="Public label" data-safe="unchanged"></div>',
    ].join('\n');

    expect(sanitizePublicText(safe)).toBe(safe);
  });

  it('sanitizes browser-decoded semicolonless numeric references in raw HTML text', () => {
    expect(() =>
      sanitizePublicText('<p>token&#58supersecretvalue</p>')
    ).toThrow(/Publishable credential assignment/i);
    expect(sanitizePublicText('<p>alice&#64example.com</p>')).toBe(
      '<p>[redacted-email]</p>',
    );
    expect(
      sanitizePublicText('<p>&#47Users&#47alice&#47private&#47plan.md</p>'),
    ).toBe('<p>~&#47private&#47plan.md</p>');
    expect(
      sanitizePublicText('<p>.worktrees&#47private&#47plan.md</p>'),
    ).toBe('<p>[redacted-local-path]</p>');
    expect(
      sanitizePublicText('<p>&#x2fUsers&#x2fzed&#x2fprivate&#x2fplan.md</p>'),
    ).toBe('<p>~&#x2fprivate&#x2fplan.md</p>');
    expect(sanitizePublicText('<p>alice&#x40test.com</p>')).toBe(
      '<p>[redacted-email]</p>',
    );
  });

  it('inspects visible raw HTML text across nested inline tags', () => {
    expect(() =>
      sanitizePublicText(
        '<p>to<strong>ken</strong>&#58supersecretvalue</p>',
      )
    ).toThrow(/Publishable credential assignment/i);
    expect(() =>
      sanitizePublicText('<p>alice&#64;<em>example</em>.com</p>'),
    ).toThrow(/Public HTML sanitization.*email/i);
    expect(() =>
      sanitizePublicText('<span>alice</span><span>&#64example.com</span>'),
    ).toThrow(/Public HTML sanitization.*email/i);
    expect(() =>
      sanitizePublicText(
        '<p>&#47Users<em>&#47alice</em>&#47private&#47plan.md</p>',
      ),
    ).toThrow(/Public HTML sanitization.*local path/i);
  });

  it('validates browser-rendered raw HTML across inline and comment boundaries', () => {
    expect(() =>
      sanitizePublicText('<span>token</span>&#58;supersecretvalue')
    ).toThrow(/Publishable credential assignment/i);
    expect(() =>
      sanitizePublicText('<span>alice</span>&#64;example.com')
    ).toThrow(/Public HTML sanitization.*email/i);
    expect(() =>
      sanitizePublicText(
        '<span>alice</span><!-- browser comment -->&#64;example.com',
      )
    ).toThrow(/Public HTML sanitization.*email/i);
    expect(() =>
      sanitizePublicText(
        '<!-- harmless --!><span>token</span>&#58;supersecretvalue',
      )
    ).toThrow(/Publishable credential assignment/i);

    const crossInlinePath =
      '<span>/Users</span><em>/alice/private/plan.md</em>';
    expect(() => sanitizePublicText(crossInlinePath)).toThrow(
      /Public HTML sanitization.*local path/i,
    );
  });

  it('uses parse5 fragment normalization for declarations and malformed markup', () => {
    expect(() =>
      sanitizePublicText(
        '<!DOCTYPE html PUBLIC "quoted > value">'
          + '<span>token</span>&#58;supersecretvalue',
      )
    ).toThrow(/Publishable credential assignment/i);
    expect(() =>
      sanitizePublicText(
        '<!not "quoted > value">'
          + '<span>token</span>&#58;supersecretvalue',
      )
    ).toThrow(/Publishable credential assignment/i);
    expect(() =>
      sanitizePublicText('<span><em>alice</span>&#64;example.com')
    ).toThrow(/Public HTML sanitization.*email/i);
    expect(() =>
      sanitizePublicText(
        '<a href="https://alice@example.com/private"</div>',
      )
    ).toThrow(/Public HTML sanitization.*URL credentials/i);

    const safeAlternateComment =
      '<p>Public<!-- alternate close --!> information.</p>';
    expect(sanitizePublicText(safeAlternateComment)).toBe(safeAlternateComment);
  });

  it('separates block text and follows raw-text and RCDATA parsing semantics', () => {
    const safe = [
      '<p>token</p><p>:supersecretvalue</p>',
      '<p>alice</p><p>@example.com</p>',
      '<div>/Users</div><div>/alice/private/plan.md</div>',
      '<textarea><span>alice</span>&#64;example.com</textarea>',
      '<script><span>token</span>&#58;supersecretvalue</script>',
    ].join('\n');

    expect(sanitizePublicText(safe)).toBe(safe);
    expect(
      sanitizePublicText('<textarea>alice&#64;example.com</textarea>'),
    ).toBe('<textarea>[redacted-email]</textarea>');
  });

  it('treats Markdown code examples as literal while validating adjacent raw HTML', () => {
    const safe = [
      '`<span>token</span>&#58;supersecretvalue`',
      '```html',
      '<span>alice</span>&#64;example.com',
      '```',
      '<https://example.com> and alice&#64example.com are Markdown.',
      '\\<span>alice\\</span>&#64;example.com is escaped Markdown.',
    ].join('\n');
    expect(sanitizePublicText(safe)).toBe(
      safe.replace(
        'alice&#64example.com are Markdown.',
        '[redacted-email] are Markdown.',
      ),
    );

    expect(() =>
      sanitizePublicText(
        '`<span>safe</span>` then '
          + '<span>token</span>&#58;supersecretvalue',
      )
    ).toThrow(/Publishable credential assignment/i);
  });

  it('uses CommonMark source ranges for indented and nested fenced code', () => {
    const safe = [
      'Before.',
      '',
      '    <span>token</span>&#58;supersecretvalue',
      '',
      '- ````html',
      '  <span>alice</span>&#64;example.com',
      '  ````',
      '',
      '> ~~~~~html',
      '> <span>token</span>&#58;supersecretvalue',
      '> ~~~~~',
      '',
      'Inline ``<x-y href="`&#x67;hp_ABC123`">`` stays literal.',
    ].join('\n');

    expect(sanitizePublicText(safe)).toBe(safe);
  });

  it('only protects code ranges parsed from the original Markdown source', () => {
    const source = [
      '\\`alice&#64;example.com\\` stays visible.',
      '\\`\\`\\`md',
      'bob&#64;example.com',
      '\\`\\`\\`',
      '\\~\\~\\~md',
      'carol&#64;example.com',
      '\\~\\~\\~',
      '&#96;dave&#64;example.com&#96; is not source code.',
      '😀 Real code stays exact: `eve&#64;example.com`.',
      'After Unicode: frank&#64;example.com.',
    ].join('\n');

    expect(sanitizePublicText(source)).toBe([
      '\\`[redacted-email]\\` stays visible.',
      '\\`\\`\\`md',
      '[redacted-email]',
      '\\`\\`\\`',
      '\\~\\~\\~md',
      '[redacted-email]',
      '\\~\\~\\~',
      '&#96;[redacted-email]&#96; is not source code.',
      '😀 Real code stays exact: `eve&#64;example.com`.',
      'After Unicode: [redacted-email].',
    ].join('\n'));
  });

  it('rejects secrets inside escaped code delimiters that are visible text', () => {
    expect(() =>
      sanitizePublicText('\\`ghp\\_abcdefghijklmnopqrstuvwxyz123456\\`')
    ).toThrow(/Publishable GitHub token/i);
  });

  it('restores original inline and block code exactly after all public processing', () => {
    const source = [
      '😀 `alice@example.com /Users/alice/private`',
      '',
      '> ```text',
      '> api_key = "live-secret-value"',
      '> https://alice:secret@example.com/private',
      '> ```',
    ].join('\n');

    expect(sanitizePublicText(source)).toBe(source);
  });

  it('keeps backticks inside custom and namespaced raw HTML attributes active', () => {
    for (const unsafe of [
      '<x-y href="`&#x67;hp_ABC123`">unsafe</x-y>',
      '<svg:use xlink:href="`&#x67;hp_ABC123`"></svg:use>',
    ]) {
      expect(() => sanitizePublicText(unsafe)).toThrow(/GitHub token/i);
    }
  });

  it('uses inert readable placeholders even for hundreds of redactions', () => {
    const source = `<p>${Array.from(
      { length: 500 },
      (_, index) => `person${index}@example.com`,
    ).join(' ')}</p>`;
    const sanitized = sanitizePublicText(source);

    expect(sanitized).toBe(
      `<p>${Array.from({ length: 500 }, () => '[redacted-email]').join(' ')}</p>`,
    );
    expect(sanitized).not.toMatch(/<redacted-(?:email|local-path)>/u);
    expect(sanitizePublicText('.worktrees/private/plan.md')).toBe(
      '[redacted-local-path]',
    );
  });

  it('bounds parse5 raw HTML traversal by node count and depth', () => {
    expect(() =>
      sanitizePublicText('<i></i>'.repeat(5_000))
    ).toThrow(/Public HTML sanitization.*node.*limit/i);
    expect(() =>
      sanitizePublicText(`${'<i>'.repeat(256)}safe${'</i>'.repeat(256)}`)
    ).toThrow(/Public HTML sanitization.*depth.*limit/i);
  });

  it('follows raw-text parsing without rewriting safe raw HTML syntax', () => {
    expect(
      sanitizePublicText('<script>token&#58;supersecretvalue</script>'),
    ).toBe('<script>token&#58;supersecretvalue</script>');
    expect(
      sanitizePublicText('<style>/* alice&#64;example.com */</style>'),
    ).toBe('<style>/* alice&#64;example.com */</style>');

    const safe = [
      '<div title="alice&#64example.com"><span>AT&T &copy</span></div>',
      '<p>Safe<!-- alice&#64example.com -->text.</p>',
      '`<p>alice&#64example.com</p>`',
      '\\<p>alice&#64example.com\\</p>',
      '<https://example.com> then alice&#64example.com stays Markdown text.',
      '```html',
      '<p>alice&#64example.com</p>',
      '<script>token&#58supersecretvalue</script>',
      '```',
      'Ordinary Markdown keeps alice&#64example.com unchanged.',
    ].join('\n');
    expect(sanitizePublicText(safe)).toBe([
      '<div title="alice&#64example.com"><span>AT&T &copy</span></div>',
      '<p>Safe<!-- alice&#64example.com -->text.</p>',
      '`<p>[redacted-email]</p>`',
      '\\<p>[redacted-email]\\</p>',
      '<https://example.com> then [redacted-email] stays Markdown text.',
      '```html',
      '<p>[redacted-email]</p>',
      '<script>token&#58supersecretvalue</script>',
      '```',
      'Ordinary Markdown keeps [redacted-email] unchanged.',
    ].join('\n'));
  });

  it('scans raw HTML text references with near-linear scaling', () => {
    const sizes = [16_384, 32_768, 65_536, 131_000];
    const durations = sizes.map((size) => {
      const unit = 'AT&T &copy &#169 ';
      const body = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const source = `<p>${body}</p>`;
      expect(sanitizePublicText(source)).toBe(source);

      const samples = Array.from({ length: 2 }, () => {
        const startedAt = performance.now();
        expect(sanitizePublicText(source)).toBe(source);
        return performance.now() - startedAt;
      });
      return Math.min(...samples);
    });

    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]! / Math.max(durations[index - 1]!, 0.1)).toBeLessThan(4);
    }
    const perCharacter = durations.map((duration, index) => duration / sizes[index]!);
    expect(Math.max(...perCharacter) / Math.min(...perCharacter)).toBeLessThan(3.5);
  });

  it.each([
    ['closing bracket in userinfo', 'https://alice]@example.com/releases', /URL credentials/i],
    ['double quote', 'https://example.com/docs"ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['single quote', "https://example.com/docs'ghp%5Fabcdefghijklmnopqrstuvwxyz123456", /GitHub token/i],
    ['backtick', 'https://example.com/docs`ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['opening angle', 'https://example.com/docs<ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['closing angle', 'https://example.com/docs>ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['opening brace', 'https://example.com/docs{ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['closing brace', 'https://example.com/docs}ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['backslash', 'https://example.com/docs\\ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['balanced parentheses', 'https://example.com/(docs)/ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
    ['balanced brackets', 'https://example.com/[docs]/ghp%5Fabcdefghijklmnopqrstuvwxyz123456', /GitHub token/i],
  ])('parses the complete URL candidate across %s', (_name, unsafeUrl, expected) => {
    expect(() => sanitizePublicText(`Publish ${unsafeUrl} next.`)).toThrow(expected);
  });

  it.each([
    ['parentheses', '(', ')', 'https://example.com/(docs)/v2'],
    ['brackets', '[', ']', 'https://example.com/[docs]/v2'],
    ['braces', '{', '}', 'https://example.com/{docs}/v2'],
    ['angle brackets', '<', '>', 'https://example.com/docs'],
    ['double quotes', '"', '"', 'https://example.com/docs"v2'],
    ['single quotes', "'", "'", "https://example.com/docs'v2"],
    ['backticks', '`', '`', 'https://example.com/docs`v2'],
  ])('preserves safe URLs with %s and surrounding prose punctuation', (_name, open, close, url) => {
    const text = `See ${open}${url}${close}, then continue.`;
    expect(sanitizePublicText(text)).toBe(text);
  });

  it('sanitizes URL edge cases end to end without treating ordinary prose as a URL', () => {
    const rendered = renderSourceDescription(
      [
        'The parser notation function(foo[bar]) remains ordinary prose.',
        'See [https://example.com/[docs]/(v2)?redirect=%252Fpublic%252Fdocs].',
        'Open ssh://host/(%252Epsyche%252Fworktrees%252Frun) next.',
      ].join('\n'),
    );

    expect(rendered).toContain(
      'The parser notation function(foo[bar]) remains ordinary prose.',
    );
    expect(rendered).toContain(
      'See [https://example.com/[docs]/(v2)?redirect=%252Fpublic%252Fdocs].',
    );
    expect(rendered).toContain('[redacted-local-path]');
    expect(rendered).not.toContain('%252Epsyche');

    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    for (const unsafeDescription of [
      `Publish https://example.com/(${token.replace('_', '%5F')})`,
      'Publish https://alice%40example.com/releases',
      `Publish https://${token.replace('_', '%5F')}.example.com/releases`,
      'Publish https://example.com/releases/%2',
    ]) {
      expect(() => renderSourceDescription(unsafeDescription)).toThrow(
        /Publishable|malformed percent encoding/i,
      );
    }
  });

  it('redacts HTML5 entity-reconstructed emails and local paths end to end', () => {
    const rendered = renderSourceDescription([
      'Decimal email: alice&#64;example.com.',
      'Hex email: bob&#x40;example.com.',
      'Named email: carol&commat;example.com.',
      'Recursive email: dave&amp;#64;example.com.',
      'macOS path: /&#85;sers/alice/private/notes.md.',
      'Linux path: /&#x68;ome/bob/private/notes.md.',
      'Copilot path: .copilot&sol;session-state&sol;run-1&sol;plan.md.',
      'Worktree path: &period;worktrees&sol;run-2&sol;plan.md.',
      'Psyche path: &period;psyche&sol;worktrees&sol;run-3&sol;plan.md.',
    ].join('\n'));

    expect(countMatches(rendered, '[redacted-email]')).toBe(4);
    expect(rendered).toContain('macOS path: ~/private/notes.md.');
    expect(rendered).toContain('Linux path: ~/private/notes.md.');
    expect(countMatches(rendered, '[redacted-local-path]')).toBe(3);
    expect(rendered).not.toMatch(
      /alice&#64;|bob&#x40;|carol&commat;|dave&amp;#64;|&#85;sers|&#x68;ome|session-state|&period;worktrees|&period;psyche/u,
    );
  });

  it('sanitizes entity-reconstructed URL components while preserving safe public routes', () => {
    const safeRoute = 'https://example.com/&sol;Users&sol;alice&sol;docs';
    const rendered = renderSourceDescription([
      'Query https://example.com/docs?cwd=&sol;Users&sol;alice&sol;private.',
      'Fragment https://example.com/docs#preview=&sol;home&sol;bob&sol;private.',
      'Email https://example.com/docs?owner=alice%26%2364%3Bexample.com.',
      'Opaque urn:psyche:&period;psyche&sol;worktrees&sol;run.',
      `Safe route ${safeRoute}.`,
    ].join('\n'));

    expect(rendered).toContain('https://example.com/docs?cwd=~&sol;private.');
    expect(rendered).toContain('https://example.com/docs#preview=~&sol;private.');
    expect(rendered).toContain('https://example.com/docs?owner=[redacted-email].');
    expect(rendered).toContain('Opaque urn:[redacted-local-path].');
    expect(rendered).toContain(`Safe route ${safeRoute}.`);
    expect(rendered).not.toContain('&sol;Users&sol;alice&sol;private');
    expect(rendered).not.toContain('&sol;home&sol;bob&sol;private');
    expect(rendered).not.toContain('&period;psyche&sol;worktrees');
  });

  it('sanitizes entity and percent reconstructed HTTP pathnames like raw URLs', () => {
    const config = { homeDirectories: ['/srv/build-user'] };

    expect(
      sanitizePublicText(
        [
          'https://example.com/srv/build-user/private/client-plan.md?view=public#summary',
          'https&colon;&sol;&sol;example.com&sol;srv&sol;build-user'
            + '&sol;private&sol;client-plan.md&quest;view&equals;public&num;summary',
          'https&#58;&#47;&#47;example.com&#47;srv&#47;build-user'
            + '&#47;private&#47;client-plan.md',
          'https&#x3a;&#x2f;&#x2f;example.com&#x2f;srv&#x2f;build-user'
            + '&#x2f;private&#x2f;client-plan.md',
          'https&colon;%2F%2Fexample.com&sol;srv%2Fbuild-user'
            + '&sol;private%2Fclient-plan.md',
        ].join('\n'),
        config,
      ),
    ).toBe([
      'https://example.com/[redacted-local-path]?view=public#summary',
      'https&colon;&sol;&sol;example.com/[redacted-local-path]'
        + '&quest;view&equals;public&num;summary',
      'https&#58;&#47;&#47;example.com/[redacted-local-path]',
      'https&#x3a;&#x2f;&#x2f;example.com/[redacted-local-path]',
      'https&colon;%2F%2Fexample.com/[redacted-local-path]',
    ].join('\n'));
  });

  it('sanitizes reconstructed HTTP Markdown destinations and preserves titles', () => {
    const config = { homeDirectories: ['/srv/build-user'] };

    expect(
      sanitizePublicText(
        [
          '[artifact](https&colon;&sol;&sol;example.com&sol;srv&sol;build-user'
            + '&sol;private&sol;client-plan.md)',
          '![preview](https&#58;&#47;&#47;example.com&#47;srv&#47;build-user'
            + '&#47;private&#47;preview.png "Private preview")',
          '<https&#x3a;&#x2f;&#x2f;example.com&#x2f;srv&#x2f;build-user'
            + '&#x2f;private&#x2f;client-plan.md>',
          '[percent](https%3A%2F%2Fexample.com%2Fsrv%2Fbuild-user'
            + '%2Fprivate%2Fclient-plan.md "Download")',
          '[mixed](https&colon;%2F%2Fexample.com&sol;srv%2Fbuild-user'
            + '&sol;private%2Fclient-plan.md?view=public#summary)',
        ].join('\n'),
        config,
      ),
    ).toBe([
      '[artifact](https&colon;&sol;&sol;example.com/[redacted-local-path])',
      '![preview](https&#58;&#47;&#47;example.com/[redacted-local-path] "Private preview")',
      '<https&#x3a;&#x2f;&#x2f;example.com/[redacted-local-path]>',
      '[percent](https%3A%2F%2Fexample.com/[redacted-local-path] "Download")',
      '[mixed](https&colon;%2F%2Fexample.com/[redacted-local-path]?view=public#summary)',
    ].join('\n'));
  });

  it('normalizes raw, entity, percent, and mixed HTTP backslashes before path redaction', () => {
    const config = { homeDirectories: ['/srv/build-user'] };

    expect(
      sanitizePublicText(
        [
          String.raw`https://example.com\srv\build-user\private\client-plan.md?view=public#summary`,
          String.raw`https://example.com/srv\build-user\private\client-plan.md`,
          'https&colon;&sol;&sol;example.com&bsol;srv&bsol;build-user'
            + '&bsol;private&bsol;client-plan.md',
          'https&#58;&#47;&#47;example.com&#92;srv&#92;build-user'
            + '&#92;private&#92;client-plan.md',
          'https&#x3a;&#x2f;&#x2f;example.com&#x5c;srv&#x5c;build-user'
            + '&#x5c;private&#x5c;client-plan.md',
          'https://example.com%5Csrv%5Cbuild-user%5Cprivate%5Cclient-plan.md',
          'https&amp;colon;&percnt;2F&percnt;2Fexample.com&amp;bsol;srv'
            + '&percnt;255Cbuild-user&#x5c;private&bsol;client-plan.md',
          'https://example.com%5Cpublic%5C.psyche%5Cworktrees%5Crun-1%5Cplan.md',
        ].join('\n'),
        config,
      ),
    ).toBe([
      'https://example.com/[redacted-local-path]?view=public#summary',
      'https://example.com/[redacted-local-path]',
      'https&colon;&sol;&sol;example.com/[redacted-local-path]',
      'https&#58;&#47;&#47;example.com/[redacted-local-path]',
      'https&#x3a;&#x2f;&#x2f;example.com/[redacted-local-path]',
      'https://example.com/[redacted-local-path]',
      'https&amp;colon;&percnt;2F&percnt;2Fexample.com/[redacted-local-path]',
      'https://example.com/[redacted-local-path]',
    ].join('\n'));
  });

  it('normalizes encoded HTTP backslashes in Markdown destinations before path redaction', () => {
    const config = { homeDirectories: ['/srv/build-user'] };

    expect(
      sanitizePublicText(
        [
          String.raw`[raw](https://example.com\srv\build-user\private\plan.md)`,
          '[entity](https&colon;&sol;&sol;example.com&bsol;srv&bsol;build-user'
            + '&bsol;private&bsol;plan.md "Private")',
          '[percent](https%3A%2F%2Fexample.com%5Csrv%5Cbuild-user'
            + '%5Cprivate%5Cplan.md)',
          '[mixed](https&amp;colon;&percnt;2F&percnt;2Fexample.com'
            + '&amp;bsol;srv%255Cbuild-user&#x5c;private&bsol;plan.md)',
        ].join('\n'),
        config,
      ),
    ).toBe([
      '[raw](https://example.com/[redacted-local-path])',
      '[entity](https&colon;&sol;&sol;example.com/[redacted-local-path] "Private")',
      '[percent](https%3A%2F%2Fexample.com/[redacted-local-path])',
      '[mixed](https&amp;colon;&percnt;2F&percnt;2Fexample.com/[redacted-local-path])',
    ].join('\n'));
  });

  it('uses normalized HTTP authority boundaries without changing safe URLs or prose', () => {
    const safeDescription = [
      String.raw`Keep https://example.com\public\release.md public.`,
      'Keep https&colon;&sol;&sol;example.com&bsol;public&bsol;release.md public.',
      'Keep https://example.com%5Cpublic%5Crelease.md public.',
      '[safe](https%3A%2F%2Fexample.com%5Cpublic%5Crelease.md)',
      'Keep https&colon;&sol;&sol;example.com&bsol;alice&commat;public'
        + '&bsol;release.md public.',
      'Keep https://example.com%5Calice%40public%5Crelease.md public.',
      String.raw`Safe escaped prose: \*literal emphasis\* and \[not a link\].`,
      String.raw`Keep ssh://host\srv\public and vscode://file\srv\public unchanged.`,
    ].join('\n');

    expect(sanitizePublicText(safeDescription)).toBe(safeDescription);

    for (const unsafeDescription of [
      'https&colon;&sol;&sol;alice&commat;example.com&bsol;releases',
      '[credentials](https%3A%5C%5Calice%40example.com%5Creleases)',
      '[recursive](https&amp;colon;&percnt;255C&percnt;255Calice'
        + '&percnt;2540example.com&amp;bsol;releases)',
    ]) {
      expect(() => sanitizePublicText(unsafeDescription)).toThrow(/URL credentials/i);
    }
  });

  it.each([
    ['plain text', '//user:password@[2001:db8::1]:8443/releases'],
    ['Markdown link', '[credentials](//user:password@host.example:8443/releases)'],
    ['Markdown image', '![credentials](//user%3Apassword%40host.example/releases)'],
    ['Markdown autolink', '<//user:password@host.example/releases>'],
    ['raw HTML attribute', '<a href="//user:password@host.example/releases">private</a>'],
  ])('rejects protocol-relative URL credentials in %s', (_context, unsafeDescription) => {
    expect(() => sanitizePublicText(unsafeDescription)).toThrow(/URL credentials/i);
  });

  it.each([
    ['slashless HTTPS', 'https:user:password@host.example/releases'],
    ['backslash HTTPS', String.raw`https:\\user:password@[2001:db8::1]:8443\releases`],
    ['entity separators', 'https&colon;user&colon;password&commat;host.example/releases'],
    ['percent separators', 'https%3Auser%3Apassword%40host.example/releases'],
    [
      'recursive mixed separators',
      'https&amp;colon;&percnt;255C&percnt;255Cuser&percnt;253Apassword'
        + '&amp;commat;host.example&amp;bsol;releases',
    ],
    [
      'encoded protocol-relative IPv6 and port',
      '%252F%252Fuser%253Apassword%2540%255B2001%253Adb8%253A%253A1%255D'
        + '%253A8443%252Freleases',
    ],
  ])('rejects WHATWG and encoded URL credentials with %s', (_variant, unsafeDescription) => {
    expect(() => sanitizePublicText(unsafeDescription)).toThrow(/URL credentials/i);
  });

  it('rejects 1,250 browser-decoded semicolonless numeric credential variants', () => {
    const schemes = ['ftp', 'http', 'https', 'ws', 'wss'];
    const authoritySeparators = [
      '//',
      '&#47&#47',
      '&#x2f&#x2f',
      '&#92&#92',
      '&#x5c&#x5c',
    ];
    const credentialLayouts = [
      (scheme: string, separators: string) =>
        `${scheme}&#58${separators}user:secret@host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#x3a${separators}user:secret@host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#58${separators}user&#58secret@host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#x3a${separators}user&#x3asecret@host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#58${separators}user:secret&#64host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#x3a${separators}user:secret&#x40host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#58${separators}user&#58secret&#64host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#x3a${separators}user&#x3asecret&#x40host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&amp;#58${separators}user:secret@host.example/releases?view=public#summary`,
      (scheme: string, separators: string) =>
        `${scheme}&#58${separators}user%3Asecret%40host.example/releases?view=public#summary`,
    ];
    const contexts = [
      (url: string) => `Publish ${url} next.`,
      (url: string) => `[credentials](${url})`,
      (url: string) => `![credentials](${url})`,
      (url: string) => `<a href="${url}">private</a>`,
      (url: string) => `<a href=${url}>private</a>`,
    ];
    const accepted: string[] = [];
    let count = 0;

    for (const scheme of schemes) {
      for (const separators of authoritySeparators) {
        for (const buildCredentialUrl of credentialLayouts) {
          for (const wrap of contexts) {
            const source = wrap(buildCredentialUrl(scheme, separators));
            count += 1;
            try {
              sanitizePublicText(source);
              accepted.push(source);
            } catch (error) {
              expect(error).toMatchObject({
                message: expect.stringMatching(/URL credentials/i),
              });
            }
          }
        }
      }
    }

    expect(count).toBe(1_250);
    expect(
      accepted,
      `${accepted.length} credential variants were accepted; first: ${accepted[0] ?? 'none'}`,
    ).toHaveLength(0);
  });

  it('applies browser reference rules to URL structures in every rendered context', () => {
    const referenceStyles = [
      ['decimal with semicolon', (codePoint: number) => `&#${codePoint};`],
      ['decimal without semicolon', (codePoint: number) => `&#${codePoint}`],
      ['hex with semicolon', (codePoint: number) => `&#x${codePoint.toString(16)};`],
      ['hex without semicolon', (codePoint: number) => `&#x${codePoint.toString(16)}`],
    ] as const;
    const contexts = [
      ['plain text', (url: string) => `Publish ${url} next.`],
      ['Markdown link', (url: string) => `[credentials](${url})`],
      ['Markdown image', (url: string) => `![credentials](${url})`],
      ['Markdown autolink', (url: string) => `<${url}>`],
      ['double-quoted raw HTML', (url: string) => `<a href="${url}">private</a>`],
      ['single-quoted raw HTML', (url: string) => `<a href='${url}'>private</a>`],
      ['unquoted raw HTML', (url: string) => `<a href=${url}>private</a>`],
    ] as const;

    for (const [referenceName, encode] of referenceStyles) {
      const colon = encode(58);
      const slash = encode(47);
      const at = encode(64);
      const backslash = encode(92);
      const query = encode(63);
      const fragment = encode(35);
      const credentialUrls = [
        `https${colon}//user:secret${at}host.example/releases`,
        `https:${slash}${slash}user:secret${at}host.example/releases`,
        `https${colon}${slash}${slash}user${colon}secret${at}host.example/releases`,
        `https${colon}${slash}${slash}user:secret${at}host.example/releases`,
        `https:${backslash}${backslash}user:secret${at}host.example/releases`,
        `https${colon}${slash}${slash}user:secret${at}host.example/releases${query}view=public`,
        `https${colon}${slash}${slash}user:secret${at}host.example/releases${fragment}public`,
      ];

      for (const [contextName, wrap] of contexts) {
        for (const credentialUrl of credentialUrls) {
          expect(
            () => sanitizePublicText(wrap(credentialUrl)),
            `${referenceName}, ${contextName}: ${credentialUrl}`,
          ).toThrow(/URL credentials/i);
        }
      }
    }
  });

  it('follows HTML attribute ambiguity rules without changing safe prose or code', () => {
    const safe = [
      'AT&T remains ordinary prose.',
      '<a href="https://example.com/docs?label=AT&T">Public</a>',
      '<a href="https://example.com/a&ampx">Ambiguous named reference</a>',
      '<a href="https://example.com/a&amp!b">Legacy named reference</a>',
      '```html',
      '<a href="https&#58//example.com/public">literal code</a>',
      '```',
    ].join('\n');

    expect(sanitizePublicText(safe)).toBe(safe);
    expect(() =>
      sanitizePublicText(
        '<a href="https&amp;#58//alice&amp;#58secret&amp;#64host.example/releases">'
          + 'private</a>',
      )
    ).toThrow(/URL credentials/i);
  });

  it('sanitizes semicolonless references in HTML attributes and Markdown destinations', () => {
    const source = [
      '<a href="https&#58&#47&#47host.example&#47srv&#47user&#47private.md">'
        + 'decimal</a>',
      '<a href=https&#x3a&#x2f&#x2fhost.example&#x2fsrv&#x2fuser&#x2fprivate.md>'
        + 'hex</a>',
      '[path](https&#x3a&#x2f&#x2fhost.example&#x2fsrv&#x2fuser&#x2fprivate.md)',
      '[query](https&#58&#47&#47host.example&#63contact=user&#64example.net&#35public)',
      '[fragment](https&#58&#47&#47host.example&#35cwd=&#47srv&#47user&#47private)',
    ].join('\n');

    expect(sanitizePublicText(source, {
      homeDirectories: ['/srv/user'],
    })).toBe([
      '<a href="https://host.example/[redacted-local-path]">decimal</a>',
      '<a href=https://host.example/[redacted-local-path]>hex</a>',
      '[path](https&#x3a&#x2f&#x2fhost.example/[redacted-local-path])',
      '[query](https&#58&#47&#47host.example&#63contact=[redacted-email]&#35public)',
      '[fragment](https&#58&#47&#47host.example&#35cwd=~&#47private)',
    ].join('\n'));
  });

  it.each([
    ['leading host punctuation', 'http://user:password@!host.example/releases'],
    ['IDN host', 'https://user:password@☃.example/releases'],
    ['IPv6 host and port', 'ws://user:password@[2001:db8::1]:8443/releases'],
    ['punycode host and port', 'ftp://user:password@xn--n3h.example:2121/releases'],
  ])('rejects URL credentials with a %s', (_name, unsafeUrl) => {
    for (const unsafeDescription of [
      `Publish ${unsafeUrl} next.`,
      `[credentials](${unsafeUrl})`,
      `<a href="${unsafeUrl}">private</a>`,
    ]) {
      expect(() => assertNoPublishableSecrets(unsafeDescription)).toThrow(
        /URL credentials/i,
      );
    }
  });

  it.each([
    ['HTTP query', 'http://example.com?contact=user@example.net'],
    ['HTTP fragment', 'http://example.com#contact=user@example.net'],
    ['protocol-relative query', '//example.com?contact=user@example.net'],
    ['protocol-relative fragment', '//example.com#contact=user@example.net'],
    ['slashless query', 'https:example.com?contact=user@example.net'],
    ['slashless fragment', 'https:example.com#contact=user@example.net'],
  ])('does not treat an email in a %s as URL userinfo', (_name, safeUrl) => {
    const expectedUrl = safeUrl.replace('user@example.net', '[redacted-email]');
    expect(() => assertNoPublishableSecrets(safeUrl)).not.toThrow();
    expect(sanitizePublicText(`Publish ${safeUrl} next.`)).toBe(
      `Publish ${expectedUrl} next.`,
    );
    expect(sanitizePublicText(`[contact](${safeUrl})`)).toBe(
      `[contact](${expectedUrl})`,
    );
    expect(sanitizePublicText(`<a href="${safeUrl}">contact</a>`)).toBe(
      `<a href="${expectedUrl.replace('<', '&lt;').replace('>', '&gt;')}">contact</a>`,
    );
  });

  it.each([
    ['encoded question mark', 'https://user%3Fname:password@host.example/releases'],
    ['encoded hash', 'https://user%23name:password@host.example/releases'],
    ['recursively encoded question mark', 'https%3A%2F%2Fuser%253Fname%3Apassword%40host.example/releases'],
    ['entity-encoded hash', 'https&colon;&sol;&sol;user&percnt;23name&colon;password&commat;host.example/releases'],
  ])('rejects URL credentials containing an %s', (_name, unsafeUrl) => {
    for (const unsafeDescription of [
      `Publish ${unsafeUrl} next.`,
      `[credentials](${unsafeUrl})`,
      `<a href="${unsafeUrl}">private</a>`,
    ]) {
      expect(() => sanitizePublicText(unsafeDescription)).toThrow(
        /URL credentials/i,
      );
    }
  });

  it.each([
    ['comma', ',', '//user%20name:password@[2001:db8::1]:8443/releases(foo)'],
    ['semicolon', ';', 'https:user%2Fname:password@host.example:8443/releases(foo)'],
    ['colon', '::', '//user%20name:password@host.example/releases(foo)'],
    ['opening parenthesis', '(', '//user%2Fname:password@host.example/releases(foo)'],
    ['opening bracket', '[', 'https:user%20name:password@[2001:db8::1]:8443/releases(foo)'],
    ['opening brace', '{', '//user%2Fname:password@host.example/releases(foo)'],
    ['double quote', '"', 'https:user%20name:password@host.example/releases(foo)'],
    ['single quote', "'", '//user%2Fname:password@[2001:db8::1]:8443/releases(foo)'],
  ])(
    'rejects a raw credential URL candidate after an ordinary %s prefix',
    (_name, prefix, candidate) => {
      expect(() =>
        sanitizePublicText(`Publish${prefix}${candidate} next.`)
      ).toThrow(/URL credentials/i);
    },
  );

  it.each([
    ['exclamation mark', '!'],
    ['question mark', '?'],
    ['hash', '#'],
    ['em dash', '—'],
    ['ideographic comma', '、'],
    ['Arabic comma', '،'],
  ])(
    'rejects a credential URL candidate after a %s boundary',
    (_name, prefix) => {
      expect(() =>
        sanitizePublicText(
          `Publish${prefix}//user:password@host.example/releases next.`,
        )
      ).toThrow(/URL credentials/i);
    },
  );

  it.each([
    ['closing parenthesis', ')'],
    ['closing bracket', ']'],
    ['closing brace', '}'],
    ['single quote', "'"],
    ['backtick', '`'],
    ['exclamation mark', '!'],
  ])('inspects a %s anywhere in URL userinfo', (_name, punctuation) => {
    const unsafeUrl =
      `//alice${punctuation}:password@host.example/releases`;
    const markdownUrl = punctuation === ')'
      ? `[credentials](<${unsafeUrl}>)`
      : `[credentials](${unsafeUrl})`;

    for (const unsafeDescription of [
      `Publish ${unsafeUrl} next.`,
      markdownUrl,
      `<a href="${unsafeUrl}">private</a>`,
    ]) {
      expect(() => sanitizePublicText(unsafeDescription)).toThrow(
        /URL credentials/i,
      );
    }
  });

  it.each([
    ['closing parenthesis', '29'],
    ['closing bracket', '5D'],
    ['closing brace', '7D'],
    ['single quote', '27'],
    ['backtick', '60'],
    ['exclamation mark', '21'],
  ])('inspects encoded %s in URL userinfo', (_name, encodedPunctuation) => {
    const unsafeUrl =
      `https%3A%2F%2Falice%${encodedPunctuation}%3Apassword`
      + '%40host.example%2Freleases';

    for (const unsafeDescription of [
      `Publish ${unsafeUrl} next.`,
      `[credentials](<${unsafeUrl}>)`,
      `<a href="${unsafeUrl}">private</a>`,
    ]) {
      expect(() => sanitizePublicText(unsafeDescription)).toThrow(
        /URL credentials/i,
      );
    }
  });

  it.each([
    ['percent whitespace in username', '//user%20name:password@host.example/releases'],
    ['percent slash in username', '//user%2Fname:password@host.example/releases'],
    ['percent whitespace before encoded at', '//user%20name%40host.example/releases'],
    [
      'percent slash and encoded password separators',
      '//user%2Fname%3Apass%2Fword%40host.example/releases',
    ],
    [
      'entity whitespace and separators',
      '//user&Tab;name&colon;pass&sol;word&commat;host.example/releases',
    ],
    [
      'conventional percent whitespace in username',
      'https://user%20name:password@host.example/releases',
    ],
    [
      'conventional percent slash before encoded at',
      'https://user%2Fname%40host.example/releases',
    ],
    ['slashless percent whitespace', 'https:user%20name:password@host.example/releases'],
    [
      'backslash percent slash with IPv6 and port',
      String.raw`https:\\user%2Fname:password@[2001:db8::1]:8443\releases(foo)`,
    ],
  ])('inspects the complete raw candidate with %s', (_name, unsafeDescription) => {
    expect(() => sanitizePublicText(unsafeDescription)).toThrow(/URL credentials/i);
  });

  it.each([
    [
      'plain text',
      'Publish {//user%20name%40host.example:8443/releases(foo)} next.',
    ],
    [
      'Markdown destination',
      '[credentials](//user%2Fname%3Apass%40host.example:8443/releases(foo))',
    ],
    [
      'Markdown image destination',
      '![credentials](https:user%20name:password@[2001:db8::1]:8443/releases(foo))',
    ],
    [
      'raw HTML attribute',
      '<a href="//user&sol;name&colon;pass&commat;host.example/releases(foo)">private</a>',
    ],
  ])('rejects same-span decoded URL credentials in %s', (_context, unsafeDescription) => {
    expect(() => sanitizePublicText(unsafeDescription)).toThrow(/URL credentials/i);
  });

  it.each([
    ['safe protocol-relative URL', '//cdn.example.com/a', '//cdn.example.com/a'],
    ['arithmetic token', 'a//b', 'a//b'],
    ['line comment', '// comment about the public release', '// comment about the public release'],
    ['block comment', '/* // comment */', '/* // comment */'],
    ['ordinary email', 'Contact user@example.com.', 'Contact [redacted-email].'],
  ])('keeps %s safe during structural URL discovery', (_name, source, expected) => {
    expect(sanitizePublicText(source)).toBe(expected);
  });

  it('preserves safe URL punctuation without promoting path or query text to userinfo', () => {
    const source = [
      "Keep https://example.com/a)b]c}d'e`f!g?topic=public#section.",
      'Keep https://example.com/?contact=user@example.net for support.',
      'Keep [docs](https://example.com/(guide)/[v2]?view=public#summary).',
      'Keep <a href="https://example.com/docs?topic=public#section">docs</a>.',
    ].join('\n');

    expect(sanitizePublicText(source)).toBe(
      source.replace('user@example.net', '[redacted-email]'),
    );
  });

  it('does not promote division or JavaScript comments to protocol-relative URLs', () => {
    const source = [
      'const quotient = a//b;',
      'const spaced = left / / right;',
      '// comment about the public release',
      '/* // comment about the public release */',
      'const text = "// still a comment";',
    ].join('\n');

    expect(sanitizePublicText(source)).toBe(source);
  });

  it.each([
    ['safe ASCII text', 'public release notes;'],
    ['dense candidate-like text', '//cdn.example.com?topic=public#release;'],
    ['dense incomplete entity-like text', 'AT&T &ampx &#xZZ; '],
  ])('scans %s with near-linear scaling', (_name, unit) => {
    const sizes = [16_384, 32_768, 65_536, 131_072];
    const durations = sizes.map((size) => {
      const source = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      expect(sanitizePublicText(source)).toBe(source);

      const samples = Array.from({ length: 2 }, () => {
        const startedAt = performance.now();
        expect(sanitizePublicText(source)).toBe(source);
        return performance.now() - startedAt;
      });
      return Math.min(...samples);
    });

    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]! / Math.max(durations[index - 1]!, 0.1)).toBeLessThan(4);
    }
    const perCharacter = durations.map((duration, index) => duration / sizes[index]!);
    expect(Math.max(...perCharacter) / Math.min(...perCharacter)).toBeLessThan(3.5);
  });

  it('enforces the public text cap before scanning malformed candidates', () => {
    const overLimit = `<a href="${'a'.repeat(131_072)}"`;

    expect(() => sanitizePublicText(overLimit)).toThrow(
      /HTML character reference inspection limit/i,
    );
    expect(() => assertNoPublishableSecrets(overLimit)).toThrow(
      /HTML character reference inspection limit/i,
    );
  });

  it('preserves safe protocol-relative URLs and redacts ordinary email prose', () => {
    const safeDescription = [
      'Plain //cdn.example.com/assets/release.png.',
      '[docs](//docs.example.com:8443/public/releases)',
      '<img src="//cdn.example.com/public/release.png">',
      'Contact user@example.com for public release details.',
    ].join('\n');

    expect(sanitizePublicText(safeDescription)).toBe([
      'Plain //cdn.example.com/assets/release.png.',
      '[docs](//docs.example.com:8443/public/releases)',
      '<img src="//cdn.example.com/public/release.png">',
      'Contact [redacted-email] for public release details.',
    ].join('\n'));
  });

  it('never promotes an HTTP backslash-path segment into a replacement host', () => {
    const safeSources = [
      String.raw`https://trusted.example\alice@evil.example\path`,
      String.raw`[raw](https://trusted.example\alice@evil.example\path)`,
      '[percent](https%3A%2F%2Ftrusted.example%5Calice%40evil.example%5Cpath)',
      '[entity](https&colon;&sol;&sol;trusted.example&bsol;alice&commat;evil.example'
        + '&bsol;path)',
      String.raw`https://trusted.example\public\release.md`,
    ];

    for (const [index, source] of safeSources.entries()) {
      const sanitized = sanitizePublicText(source);
      expect(sanitized).toContain('trusted.example');
      expect(sanitized).not.toMatch(/https:\/\/evil\.example/iu);
      if (index === safeSources.length - 1) {
        expect(sanitized).toBe(source);
      }
    }

    expect(sanitizePublicText('https://alice@trusted.example/path')).toBe(
      'https://trusted.example/path',
    );
    for (const actualUserinfo of [
      String.raw`https:\\alice@trusted.example\path`,
      '[credentials](https%3A%5C%5Calice%40trusted.example%5Cpath)',
    ]) {
      expect(() => sanitizePublicText(actualUserinfo)).toThrow(/URL credentials/i);
    }
  });

  it('preserves safe entity URLs without decoding embedded unsafe HTML', () => {
    const safeDescription = [
      '[public](https&colon;&sol;&sol;example.com&sol;srv&sol;public&sol;release.md "Public")',
      'Keep &lt;img src=&quot;https&colon;&sol;&sol;example.com&sol;srv&sol;public.png&quot;'
        + ' onerror=&quot;alert(1)&quot;&gt; encoded.',
    ].join('\n');

    const rendered = sanitizePublicText(safeDescription, {
      homeDirectories: ['/srv/build-user'],
    });

    expect(rendered).toBe(safeDescription);
    expect(rendered).not.toContain('<img');
  });

  it('rejects secrets reconstructed through recursive entity and percent decoding', () => {
    const legacyToken = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const fineGrainedToken = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';

    for (const unsafeDescription of [
      `Publish ${legacyToken.replace('_', '&#95;')}`,
      `Publish ${fineGrainedToken.replaceAll('_', '&lowbar;')}`,
      'api&lowbar;key = "live-secret-value"',
      'https&colon;&sol;&sol;alice&commat;example.com/releases',
      `https://example.com/releases?value=${
        fineGrainedToken.replaceAll('_', '%26%2395%3B')
      }`,
      `data:text/plain,${
        fineGrainedToken.replaceAll('_', '&percnt;5F')
      }`,
    ]) {
      expect(() => renderSourceDescription(unsafeDescription)).toThrow(
        /Publishable (?:GitHub token|API key|URL credentials)/i,
      );
    }
  });

  it('rejects secrets reconstructed by CommonMark backslash escapes', () => {
    for (const unsafeDescription of [
      'Publish ghp\\_abcdefghijklmnopqrstuvwxyz123456',
      'api\\_key = "live-secret-value"',
      'token \\= github_pat\\_abcdefghijklmnopqrstuvwxyz1234567890',
      'https\\://alice\\@example.com/releases',
    ]) {
      expect(() => renderSourceDescription(unsafeDescription)).toThrow(
        /Publishable (?:GitHub token|API key|credential|URL credentials)/i,
      );
    }
  });

  it('inspects encoded Markdown destinations and preserves safe escaped Markdown', () => {
    const rendered = renderSourceDescription([
      '[worktree](%2Epsyche%2Fworktrees%2Frun%2Fplan.md)',
      '![session](&period;copilot&sol;session-state&sol;run&sol;shot.png)',
      '[checkout](%252Eworktrees%252Frun%252Fnotes.md)',
      '[macOS home](%2FUsers%2Falice%2Fprivate%2Fnotes.md)',
      '[Linux home](&sol;home&sol;alice&sol;private&sol;notes.md)',
      'Safe escaped prose: \\*literal emphasis\\* and \\[not a link\\].',
      '[safe route](docs/My%20Project.md)',
      '```md',
      '[literal](%2Epsyche%2Fworktrees%2Finside-code.md)',
      '[entity literal](&period;copilot&sol;session-state&sol;inside-code.md)',
      '\\*literal fenced prose\\*',
      '```',
    ].join('\n'));

    expect(countMatches(rendered, '[redacted-local-path]')).toBe(5);
    expect(rendered).toContain('Safe escaped prose: \\*literal emphasis\\* and \\[not a link\\].');
    expect(rendered).toContain('[safe route](docs/My%20Project.md)');
    expect(rendered).toContain([
      '```md',
      '[literal](%2Epsyche%2Fworktrees%2Finside-code.md)',
      '[entity literal](&period;copilot&sol;session-state&sol;inside-code.md)',
      '\\*literal fenced prose\\*',
      '```',
    ].join('\n'));
    expect(countMatches(rendered, '%2Epsyche')).toBe(1);
    expect(countMatches(rendered, '&period;copilot')).toBe(1);
    expect(rendered).not.toMatch(
      /%252Eworktrees|%2FUsers|&sol;home/iu,
    );
  });

  it('does not treat an invalid backtick fence opener as protected Markdown code', () => {
    expect(() => renderSourceDescription([
      '```invalid`info',
      'Publish ghp\\_abcdefghijklmnopqrstuvwxyz123456',
    ].join('\n'))).toThrow(/Publishable GitHub token/i);
  });

  it('rejects credentials and tokens reconstructed inside Markdown destinations', () => {
    const token = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
    for (const unsafeDescription of [
      '[credentials](https%3A%2F%2Falice%40example.com%2Freleases)',
      `![token](assets/${token.replaceAll('_', '%5F')}.png)`,
      `<https://example.com/${token.replaceAll('_', '&lowbar;')}>`,
    ]) {
      expect(() => renderSourceDescription(unsafeDescription)).toThrow(
        /Publishable (?:GitHub token|URL credentials)/i,
      );
    }
  });

  it('preserves safe entities, prose, code fences, and percent encoding', () => {
    const safeDescription = [
      'Safe &amp; sound with &lt;example&gt; in normal prose.',
      'Keep https://example.com/My%20Project?redirect=%252Fpublic%252Fdocs.',
      'Keep https://example.com/%25done as a literal encoded percent.',
      'Malformed references stay literal: &bogus; &#xZZ; &#; &amp.',
      '```html',
      '&lt;script&gt;safe example&lt;/script&gt;',
      '```',
    ].join('\n');
    const rendered = renderSourceDescription(safeDescription);

    expect(rendered).toContain(safeDescription);
    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('https://example.com/My Project');
  });

  it('rejects overlong HTML character references within a bounded inspection pass', () => {
    const overlongReference = `&#${'1'.repeat(20_000)};`;

    expect(() => renderSourceDescription(`Keep ${overlongReference} bounded.`)).toThrow(
      /HTML character reference exceeds the inspection limit/i,
    );
  });

  it('preserves code and redacts complete delimiter-aware operational paths', () => {
    expect(
      sanitizePublicText(
        'Open `~/.worktrees/public-beads-project/秘密 roadmap.md` next.',
      ),
    ).toBe('Open `~/.worktrees/public-beads-project/秘密 roadmap.md` next.');
    expect(
      sanitizePublicText(
        'Plan: ".psyche/worktrees/public-beads-project/秘密 roadmap.md"; keep this note.',
      ),
    ).toBe('Plan: "[redacted-local-path]"; keep this note.');
    expect(
      sanitizePublicText(
        'Plan: [~/.copilot/session-state/run-1/秘密 roadmap.md] follows.',
      ),
    ).toBe('Plan: [[redacted-local-path]] follows.');
    expect(
      sanitizePublicText(
        "Plan: '.psyche/worktrees/public-beads-project/秘密 roadmap.md'; keep this note.",
      ),
    ).toBe("Plan: '[redacted-local-path]'; keep this note.");
    expect(
      sanitizePublicText(
        "Plan: '.psyche/worktrees/x/O'Reilly secret.md'; keep this note.",
      ),
    ).toBe("Plan: '[redacted-local-path]'; keep this note.");
    expect(
      sanitizePublicText(
        'Plan: /opt/repos/.psyche/worktrees/public-beads-project/秘密/roadmap.md. Keep this sentence.',
      ),
    ).toBe('Plan: [redacted-local-path]. Keep this sentence.');
    expect(
      sanitizePublicText(
        'Checkout .worktrees/public-beads-project/secret roadmap.md before continuing.',
      ),
    ).toBe('Checkout [redacted-local-path] before continuing.');
    expect(
      sanitizePublicText(
        "Open .worktrees/public-beads-project/O'Reilly secret.md next.",
      ),
    ).toBe('Open [redacted-local-path] next.');
    expect(
      sanitizePublicText(
        "Open .worktrees/public-beads-project/secret O'Reilly.md next.",
      ),
    ).toBe('Open [redacted-local-path] next.');
  });

  it('preserves prose and path-like names outside operational path boundaries', () => {
    expect(
      sanitizePublicText(
        "Don't expose .worktrees/project/plan.md; it isn't public.",
      ),
    ).toBe("Don't expose [redacted-local-path]; it isn't public.");
    expect(
      sanitizePublicText(
        'Keep the release note before .worktrees/project/plan.md and the explanation after it.',
      ),
    ).toBe(
      'Keep the release note before [redacted-local-path] and the explanation after it.',
    );
    expect(
      sanitizePublicText(
        'Keep /public/example and .worktrees/project/plan.md as separate references.',
      ),
    ).toBe(
      'Keep /public/example and [redacted-local-path] as separate references.',
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
      description: 'Email [redacted-email] when the sync lands.',
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
    expect(readme).toContain(
      '<!-- custom-project-sync:v2 project-readme repository=OpenCoven/psyche-build -->',
    );
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
      '- Parent: `pb-feature` — Model Beads project inventory',
    );
    expect(rendered).toContain(
      '- Blocked by: [#3](https://github.com/OpenCoven/psyche-build-public/issues/3#~/file) `pb-in-progress` — Track in-progress beads',
    );
    expect(rendered).not.toContain('mirror-user');
    expect(rendered).not.toContain('mirror-pass');
    expect(rendered).not.toContain('/Users/buns/private');
    expect(rendered).toContain('/issues/3#~/file');
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

  it('omits recursively encoded secrets and malformed mirrored issue URLs', () => {
    const inventory = buildPublicInventory();
    const blocked = inventory.find((bead) => bead.id === 'pb-blocked');
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz123456';

    expect(blocked).toBeTruthy();

    const rendered = renderIssueBody(
      blocked!,
      buildContext(inventory, {
        mirroredIssueUrlsByBeadId: {
          'pb-feature': `https://example.com/issues/2?access_token=${
            token.replace('_', '%255F')
          }`,
          'pb-in-progress': 'https://example.com/issues/3#route=%GG',
          'pb-closed': 'https://github.com/OpenCoven/psyche-build-public/issues/4',
        },
      }),
    );

    expect(rendered).toContain('- Parent: `pb-feature` — Model Beads project inventory');
    expect(rendered).toContain(
      '- Blocked by: `pb-in-progress` — Track in-progress beads',
    );
    expect(rendered).not.toContain('access_token=');
    expect(rendered).not.toContain('%GG');
    expect(rendered).not.toContain(token);
  });

  it('rejects credential-bearing HTTP URLs instead of rendering stripped links', () => {
    const inventory = buildPublicInventory();
    const blocked = inventory.find((bead) => bead.id === 'pb-blocked');

    expect(blocked).toBeTruthy();

    const rendered = renderIssueBody(
      blocked!,
      buildContext(inventory, {
        mirroredIssueUrlsByBeadId: {
          'pb-feature': 'https://alice:secret@example.com/issues/2',
          'pb-in-progress': 'https://github.com/OpenCoven/psyche-build-public/issues/3',
        },
      }),
    );

    expect(rendered).toContain('- Parent: `pb-feature` — Model Beads project inventory');
    expect(rendered).not.toContain('example.com/issues/2');
    expect(rendered).not.toContain('alice');
    expect(rendered).not.toContain('secret');
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

    expect(renderedRepositoryLink).toContain(`- Design doc: ${designDocPath}`);
    expect(renderedRepositoryLink).toContain(`- Plan: ${planDocPath}`);
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
    expect(renderedSanitizedSource).not.toContain('[redacted-local-path]');
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

  it('closes unclosed source fences with the matching marker before generated sections', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const rendered = renderIssueBody(
      {
        ...feature,
        description: '````ts\n# Description code',
        design: '~~~md\n## Design code',
        specId: null,
        notes: '```\n### Notes code',
      },
      {
        inventoryById: new Map([[feature.id, feature]]),
      },
    );

    expect(rendered).toContain(
      '## Description\n````ts\n# Description code\n````\n\n## Design',
    );
    expect(rendered).toContain(
      '## Design\n~~~md\n## Design code\n~~~\n\n## Acceptance criteria',
    );
    expect(rendered).toContain(
      '## Implementation notes\n```\n### Notes code\n```\n\n## Dependencies',
    );
  });

  it('preserves already closed source fences and their original lengths', () => {
    const rendered = renderSourceDescription([
      '`````ts',
      '# literal',
      '`````',
      '~~~~md',
      '## literal',
      '~~~~',
    ].join('\n'));

    expect(countMatches(rendered, '`````')).toBe(2);
    expect(countMatches(rendered, '~~~~')).toBe(2);
  });

  it('does not append a fence to an already closed nested source fence', () => {
    const rendered = renderSourceDescription([
      '- ```md',
      '  literal',
      '  ```',
      '- after',
    ].join('\n'));

    expect(rendered).toContain([
      '## Description',
      '- ```md',
      '  literal',
      '  ```',
      '- after',
      '',
      '## Design',
    ].join('\n'));
    expect(countMatches(rendered, '```')).toBe(2);
    assertGeneratedIssueHeadingsAreTopLevel(rendered);
  });

  it('closes trailing fenced code with its container continuation prefix', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const rendered = renderIssueBody(
      {
        ...feature,
        description: '> `````md\n> blockquote code',
        design: '- > ~~~~md\n  > nested code',
        specId: null,
        notes: '- ```text\n  list code',
      },
      {
        inventoryById: new Map([[feature.id, feature]]),
      },
    );

    expect(rendered).toContain(
      '## Description\n> `````md\n> blockquote code\n> `````\n\n## Design',
    );
    expect(rendered).toContain(
      '## Design\n- > ~~~~md\n  > nested code\n  > ~~~~\n\n## Acceptance criteria',
    );
    expect(rendered).toContain(
      '## Implementation notes\n- ```text\n  list code\n  ```\n\n## Dependencies',
    );
    assertGeneratedIssueHeadingsAreTopLevel(rendered);
  });

  it('leaves indented code alone and closes raw HTML before generated sections', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const rendered = renderIssueBody(
      {
        ...feature,
        description: '    indented code',
        design: '<script>\nconst safe = true;',
        specId: null,
      },
      {
        inventoryById: new Map([[feature.id, feature]]),
      },
    );

    expect(rendered).toContain(
      '## Description\n    indented code\n\n## Design',
    );
    expect(rendered).toContain(
      '## Design\n<script>\nconst safe = true;\n</script>\n\n## Acceptance criteria',
    );
    assertGeneratedIssueHeadingsAreTopLevel(rendered);
  });

  it('keeps generated metadata headings top-level for every source section combination', () => {
    const [feature] = buildPublicInventory().filter((bead) => bead.id === 'pb-feature');
    const sourceValues = {
      description: '> ```md\n> description',
      design: '- ~~~~md\n  design',
      acceptanceCriteria: '    acceptance code',
      notes: '<script>\nnotes',
    };

    for (let mask = 0; mask < 16; mask += 1) {
      const bead: PublicBead = {
        ...feature,
        description: mask & 1 ? sourceValues.description : null,
        design: mask & 2 ? sourceValues.design : null,
        specId: null,
        acceptanceCriteria: mask & 4 ? sourceValues.acceptanceCriteria : null,
        notes: mask & 8 ? sourceValues.notes : null,
      };
      const rendered = renderIssueBody(bead, {
        inventoryById: new Map([[bead.id, bead]]),
      });

      assertGeneratedIssueHeadingsAreTopLevel(rendered);
    }
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
    expect(
      countMatches(
        rendered,
        '<!-- psyche-beads-project-sync:v1 project-readme repository=OpenCoven/psyche-build -->',
      ),
    ).toBe(1);
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

  it('fits the current 85-closed-Bead scale while retaining required README sections', () => {
    const inventory = makeClosedHistoryInventory(
      85,
      (index) => `Current closed Bead ${String(index + 1).padStart(3, '0')} ${'x'.repeat(20)}`,
    );

    const rendered = renderProjectReadme(inventory, buildContext(inventory));
    const historyLines = closedHistoryLines(rendered);
    const omittedCount = omittedClosedCount(rendered);

    expect(codePointLength(managedProjectReadmeBody(rendered))).toBeLessThanOrEqual(
      GITHUB_PROJECT_README_MAX_CODE_POINTS,
    );
    expect(historyLines).toHaveLength(85);
    expect(omittedCount).toBe(0);
    expect(rendered).toContain('generated public tracking snapshot');
    expect(rendered).toContain('- Closed beads: 85');
    expect(rendered).toContain('## Field guide');
    expect(rendered).toContain('## Sync behavior');
    expect(rendered).toContain('## Authority');
  });

  it('bounds long Unicode closed titles, samples sorted history, and reports omissions deterministically', () => {
    const inventory = makeClosedHistoryInventory(
      400,
      (index) => `${String(index + 1).padStart(4, '0')} ${'😀'.repeat(2_000)}`,
    );

    const rendered = renderProjectReadme(inventory, buildContext(inventory));
    const reversed = renderProjectReadme([...inventory].reverse(), buildContext(inventory));
    const historyLines = closedHistoryLines(rendered);
    const omittedCount = omittedClosedCount(rendered);
    const managedBody = managedProjectReadmeBody(rendered);

    expect(rendered).toBe(reversed);
    expect(codePointLength(managedBody)).toBeLessThanOrEqual(
      GITHUB_PROJECT_README_MAX_CODE_POINTS,
    );
    expect(managedBody.length).toBeGreaterThan(codePointLength(managedBody));
    expect(historyLines.length).toBeGreaterThan(0);
    expect(historyLines.map((line) => line.match(/`(pb-closed-\d+)`/u)?.[1])).toEqual(
      [...historyLines]
        .map((line) => line.match(/`(pb-closed-\d+)`/u)?.[1])
        .sort(),
    );
    expect(Math.max(...historyLines.map(codePointLength))).toBeLessThan(512);
    expect(historyLines.every((line) => line.includes('... (closed '))).toBe(true);
    expect(omittedCount).toBe(400 - historyLines.length);
    expect(rendered).toContain('generated public tracking snapshot');
    expect(rendered).toContain('- Closed beads: 400');
    expect(rendered).toContain('## Field guide');
    expect(rendered).toContain('## Sync behavior');
    expect(rendered).toContain('## Authority');
  });

  it('accepts the exact Project README boundary and counts Unicode code points', () => {
    const seed = renderProjectReadme([], buildContext([], { projectName: '😀' }));
    const remainingCodePoints =
      GITHUB_PROJECT_README_MAX_CODE_POINTS - codePointLength(managedProjectReadmeBody(seed));
    const exact = renderProjectReadme(
      [],
      buildContext([], { projectName: '😀'.repeat(remainingCodePoints + 1) }),
    );
    const exactManagedBody = managedProjectReadmeBody(exact);

    expect(codePointLength(exactManagedBody)).toBe(GITHUB_PROJECT_README_MAX_CODE_POINTS);
    expect(exactManagedBody.length).toBeGreaterThan(codePointLength(exactManagedBody));
    expect(() => {
      assertProjectReadmeWithinLimit('a'.repeat(GITHUB_PROJECT_README_MAX_CODE_POINTS));
    }).not.toThrow();
    expect(() => {
      assertProjectReadmeWithinLimit('😀'.repeat(GITHUB_PROJECT_README_MAX_CODE_POINTS));
    }).not.toThrow();
    expect(() => {
      assertProjectReadmeWithinLimit('😀'.repeat(GITHUB_PROJECT_README_MAX_CODE_POINTS + 1));
    }).toThrow(/10001 characters; maximum is 10000/u);
  });

  it('counts preserved character references in final issue and README limits', () => {
    const issueSeed = renderSourceDescription('x');
    const issueDescriptionBudget =
      GITHUB_ISSUE_BODY_MAX_CODE_POINTS - (codePointLength(issueSeed) - 1);
    const issueEntityCount = Math.floor(issueDescriptionBudget / 5);
    const issueRemainder = issueDescriptionBudget - (issueEntityCount * 5);
    const exactIssue = renderSourceDescription(
      `${'&amp;'.repeat(issueEntityCount)}${'x'.repeat(issueRemainder)}`,
    );

    expect(codePointLength(exactIssue)).toBe(GITHUB_ISSUE_BODY_MAX_CODE_POINTS);
    expect(() => assertIssueBodyWithinLimit('pb-feature', exactIssue)).not.toThrow();
    expect(() =>
      assertIssueBodyWithinLimit('pb-feature', `${exactIssue}&amp;`)
    ).toThrow(/65541 characters; maximum is 65536/u);

    const readmeSeed = renderProjectReadme([], buildContext([], { projectName: 'x' }));
    const readmeTitleBudget =
      GITHUB_PROJECT_README_MAX_CODE_POINTS
      - codePointLength(managedProjectReadmeBody(readmeSeed))
      + 1;
    const readmeEntityCount = Math.floor(readmeTitleBudget / 5);
    const readmeRemainder = readmeTitleBudget - (readmeEntityCount * 5);
    const exactReadme = renderProjectReadme(
      [],
      buildContext([], {
        projectName: `${'&amp;'.repeat(readmeEntityCount)}${'x'.repeat(readmeRemainder)}`,
      }),
    );

    expect(codePointLength(managedProjectReadmeBody(exactReadme))).toBe(
      GITHUB_PROJECT_README_MAX_CODE_POINTS,
    );
    expect(exactReadme).toContain('&amp;');
  });
});
