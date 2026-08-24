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

describe('Beads project renderers', () => {
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
    expect(sanitizePublicText('Keep https://example.com/.worktrees/releases public.')).toBe(
      'Keep https://example.com/.worktrees/releases public.',
    );
    expect(
      sanitizePublicText('Keep http://example.com/.psyche/worktrees/releases public.'),
    ).toBe('Keep http://example.com/.psyche/worktrees/releases public.');
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
      'Open ssh://host/srv/public?workspace=<redacted-local-path>#~/private.',
    );
  });

  it('sanitizes operational paths in HTTP query and fragment components only', () => {
    expect(
      sanitizePublicText(
        'Keep https://example.com/.worktrees/releases?cwd=.psyche/worktrees/run-1'
          + '#/.copilot/session-state/run-2/plan.md public.',
      ),
    ).toBe(
      'Keep https://example.com/.worktrees/releases?cwd=<redacted-local-path>'
        + '#<redacted-local-path> public.',
    );
    expect(
      sanitizePublicText(
        'Keep https://example.com/docs?workspace=%2Eworktrees%2Frun-1'
          + '#route?plan=%2Epsyche%2Fworktrees%2Frun-2 public.',
      ),
    ).toBe(
      'Keep https://example.com/docs?workspace=<redacted-local-path>'
        + '#route?plan=<redacted-local-path> public.',
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
      'ssh://host/<redacted-local-path>',
      'https://example.com/releases?cwd=~/private%26admin%3Dtrue'
        + '&workspace=<redacted-local-path>#~/secret%29preview',
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
    expect(redacted).toContain('<redacted-local-path>');
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
    ).toBe('Open <redacted-local-path> next.');
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
      'mailto:<redacted-email>?subject=Public%20roadmap',
      'data:text/plain,hello%20world',
      'urn:ietf:rfc:3986',
      'file:/srv/public/releases',
    ].join('\n'));

    expect(
      sanitizePublicText([
        'file:/Users/buns/private/notes.md',
        'urn:psyche:%252Epsyche%252Fworktrees%252Frun',
        'data:text/plain,%252Fhome%252Falice%252Fprivate',
        'mailto:team@example.com?workspace=%252Eworktrees%252Frun'
          + '#preview=%252FUsers%252Fbuns%252Fprivate',
      ].join('\n')),
    ).toBe([
      'file:/~/private/notes.md',
      'urn:<redacted-local-path>',
      'data:text/plain,~/private',
      'mailto:<redacted-email>?workspace=<redacted-local-path>#preview=~/private',
    ].join('\n'));

    for (const unsafeUri of [
      `mailto:team@example.com?subject=${encodedToken}`,
      `data:text/plain,${doubleEncodedToken}`,
      `urn:psyche:${encodedToken}`,
      `file://${encodedToken}.example/srv/public`,
    ]) {
      expect(() => sanitizePublicText(`Publish ${unsafeUri}`)).toThrow(
        /Publishable GitHub token/i,
      );
    }
    expect(() => sanitizePublicText('Publish data:text/plain,%2')).toThrow(
      /malformed percent encoding/i,
    );
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
    expect(rendered).toContain('<redacted-local-path>');
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
});
