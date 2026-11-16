import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReleaseNotes } from '../scripts/release-notes.mjs';
import { createSupportCollectors } from '../src/diagnostics/supportBundleCollectors.js';

// #553: the macOS public beta publishes its known limitations with the release
// notes, "including the inert update channel and CLI-only support bundle".
//
// A published limitation is only honest while the source still has it. Each
// case below reads the source fact and the published text together, and fails
// in both directions: when the limitation is real and unpublished, and when
// the source has moved on and the text still claims the limitation.

const read = (file: string): string => readFileSync(path.resolve(file), 'utf8');

function between(text: string, start: string, end: string, what: string): string {
  const after = text.split(start)[1];
  if (after === undefined) throw new Error(`${what} was not found`);
  return after.split(end)[0];
}

const VERSION = (JSON.parse(read('package.json')) as { version: string }).version;

/**
 * The Known Limitations section of the release notes for the version this
 * source embeds, cut by the same extractor the release workflow uses. A
 * limitation written anywhere else in the changelog does not reach a release.
 */
function releaseNoteLimitations(): string {
  const notes = readReleaseNotes(process.cwd(), VERSION).github;
  return between(
    `${notes}\n### `,
    '\n### Known Limitations\n',
    '\n### ',
    `the Known Limitations section of the ${VERSION} release notes`,
  );
}

/** Each place the limitations are published, as a list of bullets. */
function published(): Array<[string, string[]]> {
  const bullets = (section: string) =>
    section
      .split(/\n(?=- )/)
      .map((bullet) => bullet.replace(/\s+/g, ' ').trim())
      .filter((bullet) => bullet.startsWith('- '));
  const matrix = between(
    read('docs/SUPPORT-MATRIX.md'),
    '\n## Current known limitations\n',
    '\n## ',
    'the support matrix known-limitations section',
  );
  return [
    ['docs/SUPPORT-MATRIX.md', bullets(matrix)],
    [`release notes for ${VERSION}`, bullets(releaseNoteLimitations())],
  ];
}

describe('published beta limitations reach the release notes', () => {
  it('are in the notes cut for the embedded version, with the same count as the support matrix', () => {
    const [[, matrix], [, notes]] = published();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBe(matrix.length);
  });

  it('are not left in an Unreleased entry, which no release publishes', () => {
    const unreleased = read('CHANGELOG.md').split('\n## Unreleased\n')[1]?.split('\n## [')[0] ?? '';
    expect(unreleased).not.toContain('### Known Limitations');
  });

  it('do not leak into the TestFlight text', () => {
    expect(readReleaseNotes(process.cwd(), VERSION).testFlight).not.toMatch(/Known Limitations|support bundle/i);
  });
});

const DESKTOP = 'native/desktop/psyche-build-tauri';

/** Hand-written desktop sources: the Rust app and the web client, not bundles or vendored code. */
function desktopSources(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(path.resolve(directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(file);
      } else if (/\.(rs|mjs|js|html)$/.test(entry.name) && !/\.bundle\.js$/.test(entry.name)) {
        files.push(file);
      }
    }
  };
  walk(`${DESKTOP}/src-tauri/src`);
  walk(`${DESKTOP}/web`);
  return files;
}

describe('published beta limitation: the update channel is inert', () => {
  const UPDATE_CLAIM = /does not check for updates/;
  const keys = JSON.parse(read('release/update-manifest-keys.json')) as { current: unknown };
  const inert = keys.current === null;

  it('is published exactly while the embedded key set has no current key', () => {
    for (const [file, bullets] of published()) {
      expect(bullets.filter((bullet) => UPDATE_CLAIM.test(bullet)).length, file).toBe(inert ? 1 : 0);
    }
  });

  it.runIf(inert)('says there is no request and no notice, and how to update instead', () => {
    for (const [file, bullets] of published()) {
      const bullet = bullets.find((entry) => UPDATE_CLAIM.test(entry))!;
      expect(bullet, file).toMatch(/no update signing key/);
      expect(bullet, file).toMatch(/makes no update request/);
      expect(bullet, file).toMatch(/shows no update notice/);
      expect(bullet, file).toContain('`brew upgrade --cask psyche-build`');
      expect(bullet, file).toContain('`SHA256SUMS`');
      expect(bullet, file).toContain('#477');
    }
  });

  it.runIf(inert)('rests on behavior the app still has', () => {
    const check = read(`${DESKTOP}/src-tauri/src/update_check.rs`);
    // No current key means no HTTP client: the app's own test of that claim.
    expect(check).toContain('async fn inert_without_a_current_key_never_constructs_a_client()');
    // Only the `available` state shows a banner, and the setting is hidden
    // until the native status says checks are supported.
    expect(read(`${DESKTOP}/web/index.html`)).toMatch(
      /<label class="update-checks-row" id="update-checks-row"[^>]* hidden>\s*<input id="update-checks" type="checkbox" disabled \/>/,
    );
    expect(read(`${DESKTOP}/web/update/update-banner.mjs`)).toContain(
      'if (checksRow) checksRow.hidden = !supported;',
    );
  });
});

describe('published beta limitation: the support bundle is CLI-only', () => {
  const SUPPORT_CLAIM = /cannot create a support bundle/;
  const appSurface = desktopSources().filter((file) => /support[-_ ]?bundle/i.test(read(file)));

  it('reads a real set of desktop sources', () => {
    const files = desktopSources();
    expect(files.some((file) => file.endsWith('/update_check.rs'))).toBe(true);
    expect(files.some((file) => file.endsWith('/web/index.html'))).toBe(true);
    expect(files.some((file) => file.endsWith('.bundle.js'))).toBe(false);
  });

  it('is published exactly while the desktop app has no support-bundle surface', () => {
    for (const [file, bullets] of published()) {
      expect(
        bullets.filter((bullet) => SUPPORT_CLAIM.test(bullet)).length,
        `${file}; desktop sources naming a support bundle: ${appSurface.join(', ') || 'none'}`,
      ).toBe(appSurface.length === 0 ? 1 : 0);
    }
  });

  it.runIf(appSurface.length === 0)('names the command, where it runs, and what it leaves out', () => {
    for (const [file, bullets] of published()) {
      const bullet = bullets.find((entry) => SUPPORT_CLAIM.test(entry))!;
      expect(bullet, file).toContain('`psyche support-bundle`');
      expect(bullet, file).toMatch(/source checkout/);
      expect(bullet, file).toMatch(/does not collect graphics, terminal, or receipt state/);
      expect(bullet, file).toContain('#476');
    }
  });

  it.runIf(appSurface.length === 0)('rests on what the command and the app package really are', () => {
    // The command exists in the CLI entry point.
    expect(read('src/index.ts')).toContain("process.argv.slice(2)[0] === 'support-bundle'");

    // The app package carries no extra executable or resource, so installing
    // the DMG does not install the command.
    const bundle = JSON.parse(read(`${DESKTOP}/src-tauri/tauri.conf.json`)).bundle as Record<string, unknown>;
    expect(bundle).not.toHaveProperty('externalBin');
    expect(bundle).not.toHaveProperty('resources');

    // What the command collects today.
    const collectors = createSupportCollectors({
      projectRoot: path.resolve('.'),
      releaseVersion: '0.0.0',
      platform: 'darwin',
      architecture: 'arm64',
      providerDefinitions: [],
      providerSearchPath: [],
    }).map((collector) => collector.name);
    expect(collectors).toEqual(['provenance', 'persistence', 'providers', 'lifecycle', 'updater']);

    const matrix = published()[0][1].find((entry) => SUPPORT_CLAIM.test(entry))!;
    expect(matrix).toMatch(/provenance, persistence, provider, pane-lifecycle, and updater state/);
  });
});
