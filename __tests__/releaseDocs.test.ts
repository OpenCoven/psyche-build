import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    .filter((filePath) => existsSync(filePath))
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

describe('release documentation contract', () => {
  it('tracks the v0.0.2 patch without claiming TestFlight availability', async () => {
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    const unreleased = changelog.match(/## Unreleased\s*([\s\S]*?)(?=\n## \[0\.0\.2\])/);
    const release = changelog.match(
      /## \[0\.0\.2\] - 2026-08-28\s*([\s\S]*?)(?=\n## \[0\.0\.1\])/,
    );

    expect(unreleased).not.toBeNull();
    expect(release).not.toBeNull();
    expect(release?.[1]).toContain('bare Coven CLI (`coven`)');
    expect(release?.[1]).toContain('graphite surfaces');
    expect(release?.[1]).toContain('Files-pane toolbar controls');
    expect(release?.[1]).toContain('Native Git history inspection');
    expect(release?.[1]).toContain('### TestFlight: What to Test');
    const initialRelease = changelog.match(/## \[0\.0\.1\] - 2026-08-23\s*([\s\S]*)$/);
    expect(initialRelease).not.toBeNull();
    expect(initialRelease?.[1]).toContain('### Performance');
    expect(initialRelease?.[1]).toContain('### Security');
    expect(initialRelease?.[1]).toContain('### Reliability');
    expect(initialRelease?.[1]).toContain('### Documentation');
    expect(initialRelease?.[1]).toMatch(/internal distribution remains pending #200\./i);
    expect(changelog).not.toMatch(/release-candidate record/i);
    expect(changelog).not.toMatch(/Public macOS\/Homebrew availability remains pending/i);
  });

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

    expect(generated).toContain('*Version: 0.0.2*');
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

  it('layers classic checks with a bypass-free main ruleset', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toContain('expected_bunsdev_id=68980965');
    expect(runbook).toContain('gh api users/BunsDev --jq .id');
    expect(runbook).toContain('name: "Main pull request governance"');
    expect(runbook).toContain('target: "branch"');
    expect(runbook).toContain('enforcement: "active"');
    expect(runbook).toContain('include: ["refs/heads/main"]');
    expect(runbook).toContain('bypass_actors: []');
    expect(runbook).toContain('type: "pull_request"');
    expect(runbook).toContain('allowed_merge_methods: ["merge", "squash", "rebase"]');
    expect(runbook).toContain('dismiss_stale_reviews_on_push: false');
    expect(runbook).toContain('require_code_owner_review: false');
    expect(runbook).toContain('require_last_push_approval: false');
    expect(runbook).toContain('required_approving_review_count: 0');
    expect(runbook).toContain('required_review_thread_resolution: true');
    expect(runbook).toContain(
      'dismissal_restriction: {enabled: false, allowed_actors: []}',
    );

    const mainRulesetPayload = runbook.match(
      /main_ruleset_payload="\$\(jq -cn[\s\S]*?'(\{[\s\S]*?\})'\s*\)"/,
    )?.[1];
    expect(mainRulesetPayload, 'missing main governance ruleset payload').toBeDefined();
    expect(mainRulesetPayload!.match(/bypass_actors:/g)).toHaveLength(1);
    expect(mainRulesetPayload).toMatch(/bypass_actors:\s*\[\]/);
    expect(mainRulesetPayload).not.toMatch(/actor_type:/);
    expect(mainRulesetPayload).not.toMatch(/bypass_mode:/);

    expect(runbook).toMatch(
      /select\(\.name == "Main pull request governance" and \.target == "branch"\)/,
    );
    expect(runbook).toMatch(/main_ruleset_match_count[\s\S]{0,160}-le 1/);
    expect(runbook).toContain(
      'gh api --method PATCH "repos/OpenCoven/psyche-build/rulesets/$main_ruleset_id"',
    );
    expect(runbook).toContain(
      'gh api --method POST repos/OpenCoven/psyche-build/rulesets',
    );

    expect(runbook).toContain(
      'gh api --method PUT repos/OpenCoven/psyche-build/branches/main/protection --input -',
    );
    expect(runbook).toContain('enforce_admins: true');
    expect(runbook).toContain('required_pull_request_reviews: null');
    expect(runbook).toContain('required_linear_history: true');
    expect(runbook).toContain('allow_force_pushes: false');
    expect(runbook).toContain('allow_deletions: false');
    expect(runbook).toContain('required_conversation_resolution: true');

    const protectionPayload = runbook.match(
      /jq -n '(\{[\s\S]*?\})' \| gh api --method PUT repos\/OpenCoven\/psyche-build\/branches\/main\/protection --input -/,
    )?.[1];
    expect(protectionPayload, 'missing the full main protection payload').toBeDefined();
    expect(protectionPayload).toMatch(
      /checks:\s*\[\s*\{context: "TypeScript and Rust", app_id: 15368\},\s*\{context: "iOS", app_id: 15368\}\s*\]/,
    );
    expect(protectionPayload).toMatch(/required_pull_request_reviews:\s*null/);
    expect(protectionPayload).not.toMatch(/bypass_pull_request_allowances/);
    expect(runbook).toMatch(
      /\(\[\.required_status_checks\.checks\[\] \| \{context, app_id\}\] == \[\s*\{context: "TypeScript and Rust", app_id: 15368\},\s*\{context: "iOS", app_id: 15368\}\s*\]\)/,
    );
    expect(runbook).toMatch(/GitHub Actions integration pin is preserved/i);

    const rulesetVerificationIndex = runbook.indexOf(
      'verified_main_ruleset="$(gh api "repos/OpenCoven/psyche-build/rulesets/$main_ruleset_id")"',
    );
    const classicProtectionIndex = runbook.indexOf(
      'gh api --method PUT repos/OpenCoven/psyche-build/branches/main/protection --input -',
    );
    expect(rulesetVerificationIndex).toBeGreaterThan(-1);
    expect(classicProtectionIndex).toBeGreaterThan(rulesetVerificationIndex);

    expect(runbook).toContain('repos/OpenCoven/psyche-build/rules/branches/main');
    expect(runbook).toMatch(/direct-push rejection probe/i);
    expect(runbook).toContain('git commit-tree');
    expect(runbook).toMatch(/git push origin "\$probe_sha:refs\/heads\/main"/);
    expect(runbook).toMatch(
      /classic\s+`bypass_pull_request_allowances`[\s\S]{0,100}(?:must not|is not|never)/i,
    );
  });

  it('fails closed before constructing governance payloads when the owner ID differs', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');
    const actorFailureIndex = runbook.search(
      /if test "\$bunsdev_id" != "\$expected_bunsdev_id"; then[\s\S]{0,240}ERROR:[\s\S]{0,160}exit 1[\s\S]{0,40}fi/,
    );
    const payloadIndex = runbook.indexOf('main_ruleset_payload=');

    expect(actorFailureIndex).toBeGreaterThan(-1);
    expect(payloadIndex).toBeGreaterThan(actorFailureIndex);
    expect(runbook).not.toMatch(
      /^test "\$bunsdev_id" = "\$expected_bunsdev_id"$/m,
    );
  });

  it('treats only an attributable GitHub policy rejection as direct-push proof', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');
    const actorPreflightIndex = runbook.indexOf('gh auth status --active');
    const pushIndex = runbook.indexOf(
      'git push origin "$probe_sha:refs/heads/main"',
    );

    expect(actorPreflightIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(actorPreflightIndex);
    expect(runbook).toContain('gh api user --jq .login');
    expect(runbook).toMatch(
      /if test "\$active_gh_login" != "BunsDev"; then[\s\S]{0,240}exit 1/,
    );
    expect(runbook).toContain('StrictHostKeyChecking=yes');
    expect(runbook).toContain('GIT_TERMINAL_PROMPT=0');
    expect(runbook).toContain('Hi BunsDev!');
    expect(runbook).toMatch(/Git HTTP actor[\s\S]{0,300}do not|do not[\s\S]{0,300}Git HTTP actor/i);
    expect(runbook).toMatch(/tail -c 16384/);
    expect(runbook).toContain('probe_status="${PIPESTATUS[0]}"');
    expect(runbook).toMatch(/test "\$probe_status" -eq 0[\s\S]{0,240}exit 1/);
    expect(runbook).toMatch(/GH\(006\|013\)/);
    expect(runbook).toMatch(
      /Changes must be made through a pull request|required pull request/i,
    );
    expect(runbook).toMatch(
      /INCONCLUSIVE:[\s\S]{0,240}(?:network|authentication|credential|transport|other)[\s\S]{0,240}exit 1/i,
    );
  });

  it('documents the bypass-free solo-organization policy without weakening the gates', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');

    expect(runbook).toMatch(/GitHub[\s\S]{0,100}(?:cannot|does not)[\s\S]{0,100}self-approval/i);
    expect(runbook).toMatch(
      /single member[\s\S]{0,200}approving review can never be obtained/i,
    );
    expect(runbook).toMatch(
      /requirement is set to 0[\s\S]{0,120}bypass actor removed/i,
    );
    expect(runbook).toMatch(
      /Restore an approval requirement[\s\S]{0,120}second member/i,
    );
    expect(runbook).toMatch(/direct pushes[\s\S]{0,140}platform-blocked/i);
    expect(runbook).toMatch(
      /(?:review|automated review) remains preferred[\s\S]{0,200}on its merits/i,
    );
    expect(runbook).toMatch(
      /exact[- ]head required checks[\s\S]{0,160}terminal and successful/i,
    );
    expect(runbook).toMatch(/conversations are resolved/i);
    expect(runbook).toMatch(/retain that evidence[\s\S]{0,80}exact SHA/i);
    expect(runbook).toMatch(
      /Classic\s+`bypass_pull_request_allowances`\s+must\s+not\s+be\s+configured/i,
    );
  });

  it('keeps emergency changes inside the protected path with no standing bypass', async () => {
    const runbook = await readFile('docs/RELEASE.md', 'utf8');
    const emergencyHeading = /^## Emergency change procedure for #31\s*$/im.exec(runbook);
    expect(emergencyHeading, 'missing the #31 emergency-change procedure').not.toBeNull();
    const following = runbook.slice(emergencyHeading!.index + emergencyHeading![0].length);
    const nextHeading = following.search(/^## /m);
    const procedure = nextHeading === -1 ? following : following.slice(0, nextHeading);

    expect(procedure).toMatch(/incident issue/i);
    expect(procedure).toMatch(/incident\/change reason/i);
    expect(procedure).toMatch(/exact SHA/i);
    expect(procedure).toMatch(/exact-head checks/i);
    expect(procedure).toMatch(/bounded change/i);
    expect(procedure).toMatch(/merge override/i);
    expect(procedure).toMatch(/sanitized before\/after settings/i);
    expect(procedure).toMatch(/post-event review/i);
    expect(procedure).toMatch(/must not add[\s\S]{0,100}standing\s+bypass\s+actor/i);
    expect(procedure).toMatch(/no standing bypass actor or mode/i);
    expect(procedure).toMatch(/ruleset carries no bypass actor/i);

    expect(procedure).not.toMatch(/bypass_mode:\s*"(?:always|exempt)"/);
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
    expect(runbook.match(/name: "Release tag creation"/g)).toHaveLength(1);
    expect(runbook.match(/name: "Immutable release tags"/g)).toHaveLength(1);
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
    expect(runbook).toContain(
      'gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=false',
    );
    expect(runbook).toMatch(/shared protocol\/schema validation[\s\S]{0,180}(?:mandatory|required)/i);
    expect(runbook).toMatch(/retain[\s\S]{0,240}workflow run URL[\s\S]{0,160}release SHA/i);
  });

  it('records the implemented desktop-only workflow contract and dry-run evidence', async () => {
    const acceptance = await readFile('docs/RELEASE-ACCEPTANCE.md', 'utf8');

    expect(acceptance).not.toContain('The current release workflow does not yet enforce that contract');
    expect(acceptance).toContain(
      'gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=true',
    );
    expect(acceptance).toContain(
      'gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=false',
    );
    expect(acceptance).toMatch(/iOS\/TestFlight[\s\S]{0,160}(?:separate|non-blocking)/i);
    for (const [label, evidence] of [
      ['workflow run URL', /workflow\s+run URL/i],
      ['release SHA', /release SHA/i],
      ['desktop_only', /desktop_only/],
      ['build-macos', /build-macos/],
      ['upload-ios', /upload-ios/],
      ['publish', /publish/],
    ] as const) {
      expect(acceptance, label).toMatch(evidence);
    }
  });

  it('keeps canonical support and roadmap docs aligned with the implemented offline contract', async () => {
    const canonicalDocs = await Promise.all(
      ['docs/SUPPORT-MATRIX.md', 'docs/ROADMAP.md'].map(async (filePath) => ({
        filePath,
        source: await readFile(filePath, 'utf8'),
      })),
    );

    for (const { filePath, source } of canonicalDocs) {
      expect(source, filePath).not.toMatch(/verify job runs iOS checks unconditionally/i);
      expect(source, filePath).not.toMatch(/workflow coupling is a known implementation (?:fact|defect)/i);
      expect(source, filePath).toContain(
        '57c6c71bd5264fde960b062e95de278c8438c94f',
      );
      expect(source, filePath).toContain(
        'https://github.com/OpenCoven/psyche-build/actions/runs/32629730508',
      );
      expect(source, filePath).toContain(
        'https://github.com/OpenCoven/psyche-build/releases/tag/v0.0.1',
      );
      expect(source, filePath).toMatch(/Homebrew Cask/i);
      expect(source, filePath).toMatch(
        /(?:#194[\s\S]{0,220}#203|#203[\s\S]{0,220}#194)[\s\S]{0,80}(?:are\s+)?closed/i,
      );
      expect(source, filePath).toMatch(/iOS[\s\S]{0,180}skip/i);
      expect(source, filePath).toMatch(
        /(?:preserv(?:ing|ed)|mandatory)[\s\S]{0,80}shared\s+validation|shared\s+validation[\s\S]{0,80}(?:preserv(?:ing|ed)|mandatory)/i,
      );
    }
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
      'docs/README.md',
      'docs/src/content/getting-started.js',
      'docs/src/content/troubleshooting.js',
    ];
    for (const filePath of publicGuides) {
      const contents = await readFile(filePath, 'utf8');
      expect(contents, filePath).toContain('brew install --cask opencoven/tap/psyche-build');
      expect(contents, filePath).toContain('open -a "Psyche Build"');
      expect(contents, filePath).toContain('node /path/to/psyche-build/psyche');
      expect(contents, filePath).toMatch(
        /(?:supported public|published)[\s\S]{0,120}(?:macOS|v0\.0\.1|Cask)|(?:macOS|v0\.0\.1|Cask)[\s\S]{0,120}(?:supported public|published)/i,
      );
      expect(contents, filePath).not.toMatch(
        /(?:after|when)[^\n]{0,100}v0\.0\.1[^\n]{0,100}(?:release|Cask)[^\n]{0,100}(?:available|published)/i,
      );
    }
  });

  it('keeps the docs hero Cask command honest and removes the npm package link', async () => {
    const hero = await readFile('docs/src/hero.js', 'utf8');
    const main = await readFile('docs/src/main.js', 'utf8');
    const index = await readFile('docs/src/index.html', 'utf8');
    const caskCommand = 'brew install --cask opencoven/tap/psyche-build';

    expect(hero).toContain(caskCommand);
    expect(main).toContain(caskCommand);
    expect(hero).toMatch(/Public macOS v0\.0\.1 via the OpenCoven Homebrew tap/i);
    expect(hero).not.toMatch(/available after[^\n]{0,80}v0\.0\.1 release/i);
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
        path.join('docs', 'superpowers', 'README.md'),
        path.join('docs', 'src', 'hero.js'),
        path.join('docs', 'src', 'index.html'),
        path.join('docs', 'public', 'og.svg'),
      ]),
    );
    expect(
      activeFiles.some((filePath) =>
        [...historicalDocDirectories].some((directory) =>
          filePath.startsWith(`${directory}${path.sep}`),
        ),
      ),
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
