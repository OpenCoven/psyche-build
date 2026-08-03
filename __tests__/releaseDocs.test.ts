import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseDocs = [
  'README.md',
  'docs/README.md',
  'docs/RELEASE.md',
  'native/ios/README.md',
] as const;

const generatedOrDependencyDirectories = new Set([
  '.build',
  '.git',
  '.psyche',
  '.worktrees',
  '__fixtures__',
  'client',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'target',
]);

const historicalDocDirectories = new Set([
  path.join('docs', 'superpowers', 'plans'),
  path.join('docs', 'superpowers', 'specs'),
]);

async function readReleaseDocs(): Promise<Record<(typeof releaseDocs)[number], string>> {
  return Object.fromEntries(
    await Promise.all(
      releaseDocs.map(async (filePath) => [filePath, await readFile(filePath, 'utf8')] as const),
    ),
  ) as Record<(typeof releaseDocs)[number], string>;
}

function isActiveDocumentationFile(filePath: string): boolean {
  if (path.extname(filePath) === '.md') return true;
  return filePath.startsWith(`docs${path.sep}`) && ['.js', '.svg'].includes(path.extname(filePath));
}

// Active documentation means every Markdown file in the repository plus the
// JS/SVG sources that render the docs site. Historical plans/specs, generated
// output and dependencies are skipped by directory; non-document test/fixture
// sources (including this contract test) are excluded by the file-type policy.
async function listActiveDocFiles(directory = '.'): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = directory === '.' ? entry.name : path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        historicalDocDirectories.has(filePath) ||
        generatedOrDependencyDirectories.has(entry.name)
      ) {
        continue;
      }
      files.push(...(await listActiveDocFiles(filePath)));
    } else if (entry.isFile() && isActiveDocumentationFile(filePath)) {
      files.push(filePath);
    }
  }
  return files.sort();
}

function releaseEnvironmentSecretNames(runbook: string): string[] {
  const lines = runbook.split(/\r?\n/);
  const headers = lines.reduce<number[]>(
    (indexes, line, index) => (line === '| Secret | Purpose |' ? [...indexes, index] : indexes),
    [],
  );
  expect(headers).toHaveLength(1);

  const rows: string[] = [];
  for (const line of lines.slice(headers[0] + 2)) {
    if (!line.startsWith('|')) break;
    const match = line.match(/^\| `([A-Z0-9_]+)` \|/);
    expect(match, `Malformed release-environment secret row: ${line}`).not.toBeNull();
    rows.push(match![1]);
  }
  return rows.sort();
}

describe('v0.0.1 release documentation contract', () => {
  it('documents the exact release identity and supported distribution surfaces', async () => {
    const docs = await readReleaseDocs();
    const combined = Object.values(docs).join('\n');

    expect(combined).toContain('Psyche Build');
    expect(combined).toContain('ai.opencoven.psyche-ios');
    expect(combined).toContain('0.0.1 (1)');
    expect(combined).toContain('brew install --cask opencoven/tap/psyche-build');
    expect(combined).toMatch(/internal TestFlight/i);
    expect(combined).toMatch(/authorized OpenCoven testers/i);
    expect(combined).toMatch(/Node CLI[\s\S]{0,120}not[\s\S]{0,50}npm release/i);
    for (const unsupported of [
      'Windows',
      'Linux',
      'Android',
      'external TestFlight',
      'public App Store',
    ]) {
      expect(combined).toMatch(
        new RegExp(`${unsupported}[\\s\\S]{0,160}(?:unavailable|not (?:supported|included|part))`, 'i'),
      );
    }
  });

  it('documents every protected release-environment secret without a repository fallback', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');
    const requiredSecrets = [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_DISTRIBUTION_CERTIFICATE',
      'APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
      'APPLE_TEAM_ID',
      'HOMEBREW_TAP_TOKEN',
    ];

    expect(releaseEnvironmentSecretNames(runbook)).toEqual(requiredSecrets.sort());
    expect(runbook).toMatch(/protected GitHub `release` environment/i);
    expect(runbook).toMatch(/no\s+repository-secret fallback/i);
    expect(runbook).toMatch(/secret audit[\s\S]*public[\s\S]*tag/i);
  });

  it('documents the executable release and recovery contracts', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toContain('git tag -s v0.0.1');
    expect(runbook).toContain('pnpm release:check -- v0.0.1');
    expect(runbook).toContain('Psyche-Build-v0.0.1-aarch64.dmg');
    expect(runbook).toContain('Psyche-Build-v0.0.1-x86_64.dmg');
    expect(runbook).toContain('shasum -a 256 -c SHA256SUMS');
    expect(runbook).toContain('node scripts/release-notes.mjs --github 0.0.1');
    expect(runbook).toContain('--timeout-seconds 2700');
    expect(runbook).toMatch(/archive[\s\S]*upload[\s\S]*(?:retry|recovery)/i);
    expect(runbook).toMatch(/Homebrew[\s\S]*(?:retry|recovery|manual)/i);
    expect(runbook).toContain('gh workflow run Release');
  });

  it('allows upload only for an absent exact version or build and fails every unsafe reuse state', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toMatch(
      /Only exit status `2`[\s\S]{0,240}absent exact iOS prerelease version[\s\S]{0,120}absent exact build/i,
    );
    expect(runbook).toMatch(
      /existing `0\.0\.1 \(1\)`[\s\S]{0,300}`VALID`[\s\S]{0,300}exactly one `en-US`/i,
    );
    expect(runbook).toMatch(/exactly one line\s+`Source commit: <40-hex release SHA>`/i);
    for (const fatalState of [
      /non-VALID/,
      /FAILED/,
      /INVALID/,
      /duplicate or malformed identity/,
      /zero or\s+multiple localizations/,
      /provenance mismatch/,
    ]) {
      expect(runbook).toMatch(fatalState);
    }
    expect(runbook).toMatch(/must never fall through to upload or build 2/i);
  });

  it('documents normalization and the final TestFlight localization limit', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toContain('normalizeTestFlightNotes');
    expect(runbook).toMatch(
      /appends exactly one\s+`Source commit: <40-hex release SHA>` line/i,
    );
    expect(runbook).toMatch(/4,000 Unicode code\s+points/i);
    expect(runbook).toMatch(/final localization/i);
    expect(runbook).not.toContain('wc -c');
  });

  it('documents source-generated iOS provenance and conditional TestFlight availability', async () => {
    const iosReadme = await readFile('native/ios/README.md', 'utf8');

    expect(iosReadme).toMatch(/`project\.yml` is the authoritative/i);
    expect(iosReadme).toMatch(/XcodeGen[\s\S]*Info\.plist/);
    expect(iosReadme).toContain('0.0.1 (1)');
    expect(iosReadme).toMatch(/if[^\n]*available|when[^\n]*available/i);
    expect(iosReadme).not.toMatch(/(?:is|now|already) live|currently available/i);
  });

  it('contains no stale release identity or unsupported install claim in active docs', async () => {
    const activeFiles = await listActiveDocFiles();
    const staleClaims: string[] = [];

    expect(activeFiles).toEqual(
      expect.arrayContaining([
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'README.md',
        path.join('__tests__', 'README.md'),
        path.join('native', 'ios', 'README.md'),
        path.join('protocol-fixtures', 'README.md'),
        path.join('docs', 'src', 'hero.js'),
        path.join('docs', 'public', 'og.svg'),
      ]),
    );
    expect(
      activeFiles.some((filePath) => filePath.startsWith(path.join('docs', 'superpowers'))),
    ).toBe(false);

    for (const filePath of activeFiles) {
      const contents = await readFile(filePath, 'utf8');
      if (/v0\.1\.0|build\.psyche|--generate-notes|npm (?:i|install).*psyche-build/i.test(contents)) {
        staleClaims.push(filePath);
      }
    }

    expect(staleClaims).toEqual([]);
  });
});
