import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const releaseDocs = [
  'README.md',
  'docs/README.md',
  'docs/RELEASE.md',
  'native/ios/README.md',
] as const;

const historicalDocDirectories = new Set([
  path.join('docs', 'superpowers', 'plans'),
  path.join('docs', 'superpowers', 'specs'),
]);

const generatedAgentsDoc = path.join('src', 'utils', 'generated-agents-doc.ts');

async function readReleaseDocs(): Promise<Record<(typeof releaseDocs)[number], string>> {
  return Object.fromEntries(
    await Promise.all(
      releaseDocs.map(async (filePath) => [filePath, await readFile(filePath, 'utf8')] as const),
    ),
  ) as Record<(typeof releaseDocs)[number], string>;
}

function isActiveDocumentationFile(filePath: string): boolean {
  if (path.extname(filePath) === '.md') return true;
  if (filePath === generatedAgentsDoc) return true;
  return filePath.startsWith(`docs${path.sep}`) && ['.html', '.js', '.svg'].includes(path.extname(filePath));
}

// Active documentation means every Markdown file in the repository plus the
// JS/HTML/SVG sources that render the docs site and the tracked generated
// AGENTS.md source published by the CLI. Historical plans/specs, build output
// and dependencies are skipped by directory; non-document test/fixture sources
// (including this contract test) are excluded by the file-type policy.
// Enumerated from the index rather than by walking the working tree. The walk
// swept up every untracked file too, which put anything transient -- a scratch
// note, a half-written build artefact, another tool's leftovers -- inside a
// contract that is supposed to describe the repository's documentation. That
// made the test fail for reasons having nothing to do with the docs, and pass
// again once the file went away. `git ls-files` is what "in the repository"
// actually means, and it yields the identical set in a clean tree, so this
// narrows the exposure without narrowing the coverage. It also removes the
// walk's read-after-list race, since the index cannot change mid-enumeration.
async function listActiveDocFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => path.normalize(entry))
    .filter(
      (filePath) =>
        isActiveDocumentationFile(filePath) &&
        ![...historicalDocDirectories].some(
          (directory) => filePath.startsWith(`${directory}${path.sep}`),
        ),
    )
    .sort();
}

function releaseEnvironmentSecretNames(runbook: string): string[] {
  const lines = runbook.split(/\r?\n/);
  const headers = lines.reduce<number[]>(
    (indexes, line, index) =>
      (/^\s*\|\s*Secret\s*\|\s*Purpose\s*\|\s*$/.test(line) ? [...indexes, index] : indexes),
    [],
  );
  expect(headers).toHaveLength(1);
  expect(lines[headers[0] + 1]).toMatch(
    /^\s*\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|\s*$/,
  );

  const rows: string[] = [];
  for (const line of lines.slice(headers[0] + 2)) {
    if (!/^\s*\|/.test(line)) break;
    const match = line.match(/^\s*\|\s*`([A-Z0-9_]+)`\s*\|/);
    expect(match, `Malformed release-environment secret row: ${line}`).not.toBeNull();
    rows.push(match![1]);
  }
  return rows.sort();
}

describe('v0.0.1 release documentation contract', () => {
  it('parses an aligned Markdown secret table without weakening exact-name checks', () => {
    expect(
      releaseEnvironmentSecretNames(`  | Secret | Purpose |\n | :--- | ---: |\n  |   \`ONE_SECRET\`   | first |\n | \`TWO_SECRET\` | second |`),
    ).toEqual(['ONE_SECRET', 'TWO_SECRET']);
  });

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

  it('pins the tracked generated agent documentation to the release version', async () => {
    const generated = await readFile(generatedAgentsDoc, 'utf8');

    expect(generated).toContain('*Version: 0.0.1*');
    expect(generated).not.toContain('*Version: 0.1.0*');
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

  it('creates the release environment only after publication and permits immutable-tag recovery', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');
    const publicIndex = runbook.indexOf('-f visibility=public');
    const environmentIndex = runbook.indexOf('environments/release --input');
    const secretIndex = runbook.indexOf(
      'gh secret set --env release --repo OpenCoven/psyche-build',
    );

    expect(publicIndex).toBeGreaterThan(-1);
    expect(environmentIndex).toBeGreaterThan(publicIndex);
    expect(secretIndex).toBeGreaterThan(environmentIndex);
    expect(runbook).toContain('custom_branch_policies: true');
    expect(runbook).toContain('-f name=main -f type=branch');
    expect(runbook).toContain("-f name='v*' -f type=tag");
    expect(runbook).not.toContain('protected-branch deployment policy');
  });

  it('protects main with the exact CI checks and no administrative rewrite path', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toContain(
      'gh api --method PUT repos/OpenCoven/psyche-build/branches/main/protection --input -',
    );
    expect(runbook).toContain('{context: "TypeScript and Rust"}');
    expect(runbook).toContain('{context: "iOS"}');
    expect(runbook).toContain('enforce_admins: true');
    expect(runbook).toContain('required_approving_review_count: 1');
    expect(runbook).toContain('require_last_push_approval: true');
    expect(runbook).toContain('required_linear_history: true');
    expect(runbook).toContain('allow_force_pushes: false');
    expect(runbook).toContain('allow_deletions: false');
    expect(runbook).toContain('required_conversation_resolution: true');
  });

  it('uses separate tag rulesets so release-manager bypass cannot rewrite tags', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toMatch(/two separate active tag rulesets/i);
    expect(runbook).toContain('name: "Release tag creation"');
    expect(runbook).toContain('name: "Immutable release tags"');
    expect(runbook).toContain(
      'bypass_actors: [{actor_id: $team_id, actor_type: "Team", bypass_mode: "always"}]',
    );
    expect(runbook).toContain('rules: [{type: "creation"}]');
    expect(runbook).toContain('bypass_actors: []');
    expect(runbook).toContain('rules: [{type: "update"}, {type: "deletion"}]');
    expect(
      runbook.match(
        /gh api --method POST repos\/OpenCoven\/psyche-build\/rulesets --input -/g,
      ),
    ).toHaveLength(2);
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

  it('documents desktop-only recovery without weakening coordinated releases', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toContain(
      'gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=true',
    );
    expect(runbook).toContain('Desktop-only publication still requires');
    for (const secret of [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'HOMEBREW_TAP_TOKEN',
    ]) {
      expect(runbook).toContain(secret);
    }
    expect(runbook).toContain(
      'Tag pushes always run the coordinated macOS and internal TestFlight release',
    );
  });

  it('validates and tags the exact clean fetched origin/main commit', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');
    const orderedCommands = [
      'test -z "$(git status --porcelain)"',
      'git fetch origin main --tags',
      'release_sha="$(git rev-parse origin/main)"',
      'git checkout --detach "$release_sha"',
      'test "$(git rev-parse HEAD)" = "$release_sha"',
      'pnpm install --frozen-lockfile',
      'pnpm release:check -- v0.0.1',
      'git tag -s v0.0.1 "$release_sha"',
    ];
    let cursor = -1;
    for (const command of orderedCommands) {
      const index = runbook.indexOf(command, cursor + 1);
      expect(index, `${command} must follow the previous immutable-tag step`).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(runbook.match(/test -z "\$\(git status --porcelain\)"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(runbook).not.toContain('git switch --detach');
  });

  it('marks the TestFlight client command as workflow-internal and dispatches recovery', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toMatch(/release:testflight[\s\S]{0,500}workflow-internal/i);
    expect(runbook).toMatch(/credentials from the protected GitHub `release` environment/i);
    expect(runbook).toMatch(/mutates[\s\S]{0,120}TestFlight[\s\S]{0,120}localization/i);
    expect(runbook).toMatch(/recover[\s\S]{0,400}gh workflow run Release/i);
    expect(runbook.match(/^pnpm release:testflight --/gm)).toHaveLength(1);
  });

  it('separates the released GUI Cask from the source-only Node CLI', async () => {
    const publicGuides = [
      'README.md',
      'docs/BREAKING-CHANGES.md',
      'docs/COVEN-DEMO-LOOP.md',
      'docs/README.md',
      'docs/src/content/getting-started.js',
      'docs/src/content/coven-demo.js',
      'docs/src/content/troubleshooting.js',
    ];
    for (const filePath of publicGuides) {
      const contents = await readFile(filePath, 'utf8');
      expect(contents, filePath).toContain('brew install --cask opencoven/tap/psyche-build');
      expect(contents, filePath).toContain('open -a "Psyche Build"');
      expect(contents, filePath).toContain('node /path/to/psyche-build/psyche');
      expect(contents, filePath).toMatch(/(?:after|when)[^\n]{0,100}v0\.0\.1[^\n]{0,100}(?:release|Cask)|v0\.0\.1[^\n]{0,100}(?:release|Cask)[^\n]{0,100}(?:available|published)/i);
    }
  });

  it('keeps the docs hero Cask command honest and removes the npm package link', async () => {
    const hero = await readFile('docs/src/hero.js', 'utf8');
    const main = await readFile('docs/src/main.js', 'utf8');
    const index = await readFile('docs/src/index.html', 'utf8');
    const caskCommand = 'brew install --cask opencoven/tap/psyche-build';

    expect(hero).toContain(caskCommand);
    expect(main).toContain(caskCommand);
    expect(hero).toMatch(/available after[^\n]{0,80}v0\.0\.1 release/i);
    expect(hero).toContain('source CLI:');
    expect(hero).toContain('node /path/to/psyche-build/psyche');
    expect(hero).not.toMatch(/<span>\$<\/span>\s*<code>psyche<\/code>/);
    expect(index).not.toMatch(/npmjs\.com\/package\/psyche-build/i);
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

  it('ignores untracked files, so a stray doc cannot fail the contract', async () => {
    // This test used to enumerate by walking the working tree, which meant any
    // untracked file in the repo joined the contract: the suite failed for
    // reasons unrelated to the docs and passed again once the file vanished.
    const stray = 'RELEASE-DOCS-FLAKE-PROBE.md';
    try {
      await writeFile(stray, '# probe\n\nInstall with npm i psyche-build\n', 'utf8');
      const activeFiles = await listActiveDocFiles();
      expect(activeFiles).not.toContain(stray);
      // The tracked set is what the contract is about, and it is still there.
      expect(activeFiles).toContain('README.md');
    } finally {
      await rm(stray, { force: true });
    }
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
        generatedAgentsDoc,
        path.join('docs', 'src', 'hero.js'),
        path.join('docs', 'src', 'index.html'),
        path.join('docs', 'public', 'og.svg'),
      ]),
    );
    expect(
      activeFiles.some((filePath) => filePath.startsWith(path.join('docs', 'superpowers'))),
    ).toBe(false);

    for (const filePath of activeFiles) {
      const contents = await readFile(filePath, 'utf8');
      if (
        /v0\.1\.0|build\.psyche|--generate-notes|npm (?:i|install).*psyche-build|npmjs\.com\/package\/psyche-build|public\s+(?:`psyche-build`\s+)?npm package|public package that can stand alone|published (?:on|to) npm|available (?:on|from) npm/i.test(
          contents,
        )
      ) {
        staleClaims.push(filePath);
      }
    }

    expect(staleClaims).toEqual([]);
  });
});
