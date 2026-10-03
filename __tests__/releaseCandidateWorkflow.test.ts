import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const candidatePath = path.resolve('.github/workflows/release-candidate.yml');
const releasePath = path.resolve('.github/workflows/release.yml');

function candidateSource(): string {
  return readFileSync(candidatePath, 'utf8');
}

function releaseSource(): string {
  return readFileSync(releasePath, 'utf8');
}

function jobSource(workflow: string, jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Unable to find workflow job ${jobName}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob < 0 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextJob);
}

function jobNames(workflow: string): string[] {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  return [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)].map(([, name]) => name);
}

// A named step runs from its `- name:` line to the next step or the end of the
// job, so two step sources compare byte-for-byte including env and `if:`.
function stepSource(job: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  if (start < 0) throw new Error(`Unable to find workflow step ${stepName}`);
  if (job.indexOf(marker, start + 1) >= 0) throw new Error(`Duplicate workflow step ${stepName}`);
  const remaining = job.slice(start + marker.length);
  const nextStep = remaining.search(/^      - (?:name:|uses:)/m);
  const source =
    nextStep < 0 ? job.slice(start) : job.slice(start, start + marker.length + nextStep);
  return source.replace(/\n+$/, '\n');
}

function stepScript(job: string, stepName: string): string {
  const step = stepSource(job, stepName);
  const marker = '        run: |\n';
  const start = step.indexOf(marker);
  if (start < 0) throw new Error(`Step ${stepName} has no multi-line script`);
  return step.slice(start + marker.length).replace(/^ {10}/gm, '');
}

// Ordered step labels, including unnamed `uses:` steps, so a new step of
// either kind changes the list.
function stepLabels(job: string): string[] {
  return [...job.matchAll(/^      - (?:name: (.+)|uses: ([^@\s]+)@.*)$/gm)].map(
    ([, name, action]) => name ?? `uses: ${action}`,
  );
}

function stepNames(job: string): string[] {
  return [...job.matchAll(/^      - name: (.+)$/gm)].map(([, name]) => name);
}

function actionPins(source: string): string[] {
  return [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+@[0-9a-f]{40})(\s+#.*)?$/gm)].map(
    ([, action, comment]) => `${action}${comment ?? ''}`,
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Candidate Test',
      '-c', 'user.email=candidate@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      '-c', 'init.defaultBranch=main',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

const SHARED_VERIFY_STEPS = [
  'Install locked dependencies',
  'Require pinned Xcode',
  'Verify shared TypeScript, protocol, and package surfaces',
  'Verify Rust and Tauri surfaces',
] as const;

const SHARED_BUILD_STEPS = [
  'Install locked dependencies and Rust target',
  'Require signing and notarization credentials',
  'Import Developer ID certificate',
  'Build signed and notarized DMG',
  'Verify Gatekeeper and notarization',
  'Remove ephemeral macOS signing material',
] as const;

// Unnamed setup steps. Their pins must match release.yml (checked separately);
// checkout differs only in the ref it resolves.
const SETUP_STEPS = [
  'uses: actions/checkout',
  'uses: pnpm/action-setup',
  'uses: actions/setup-node',
  'uses: dtolnay/rust-toolchain',
] as const;

// Every release.yml step in the jobs the candidate mirrors is either shared
// (byte-identical in the candidate) or excluded here with its reason. A step
// added to release.yml in neither list fails the ordered-list test, so it
// forces an explicit share-or-exclude decision.
const RELEASE_ONLY_STEPS: Record<string, string> = {
  'Require a public release source':
    'Guards public Homebrew publication; a candidate publishes nothing.',
  'Resolve and verify release tag':
    'Resolves an existing tag; the candidate verifies an exact SHA on origin/main instead.',
  'Require a verified signed tag':
    'The tag is created only after acceptance, so it cannot exist for a candidate.',
  'Set up XcodeGen for iOS verification':
    'iOS verification is outside the macOS candidate; the tag run still performs it.',
  'Require matching release versions':
    'Replaced by release:coherence plus release:check against the requested final version.',
  'Require iOS 26.2 iPhone 16 Pro simulator':
    'iOS verification is outside the macOS candidate; the tag run still performs it.',
  'Verify generated iOS project, Core, app, and UI tests':
    'iOS verification is outside the macOS candidate; the tag run still performs it.',
  'Set release metadata':
    'Validates tag metadata; the candidate validates SHA, identity and version instead.',
  'Upload verified DMG':
    'Release artifact naming; the candidate uploads under its rc identity with a build record.',
};

const RELEASE_VERIFY_ORDER = [
  'uses: actions/checkout',
  'Require a public release source',
  'Resolve and verify release tag',
  'Require a verified signed tag',
  'uses: pnpm/action-setup',
  'uses: actions/setup-node',
  'uses: dtolnay/rust-toolchain',
  'Install locked dependencies',
  'Require pinned Xcode',
  'Set up XcodeGen for iOS verification',
  'Require matching release versions',
  'Verify shared TypeScript, protocol, and package surfaces',
  'Verify Rust and Tauri surfaces',
  'Require iOS 26.2 iPhone 16 Pro simulator',
  'Verify generated iOS project, Core, app, and UI tests',
];

const CANDIDATE_VERIFY_ORDER = [
  'Validate candidate inputs',
  'uses: actions/checkout',
  'Require the candidate commit on origin/main',
  'uses: pnpm/action-setup',
  'uses: actions/setup-node',
  'uses: dtolnay/rust-toolchain',
  'Install locked dependencies',
  'Require pinned Xcode',
  'Require coherent release versions',
  'Require the final release version',
  'Verify shared TypeScript, protocol, and package surfaces',
  'Verify Rust and Tauri surfaces',
];

const RELEASE_BUILD_ORDER = [
  'uses: actions/checkout',
  'Set release metadata',
  'uses: pnpm/action-setup',
  'uses: actions/setup-node',
  'uses: dtolnay/rust-toolchain',
  'Install locked dependencies and Rust target',
  'Require signing and notarization credentials',
  'Import Developer ID certificate',
  'Build signed and notarized DMG',
  'Verify Gatekeeper and notarization',
  'Upload verified DMG',
  'Remove ephemeral macOS signing material',
];

const CANDIDATE_BUILD_ORDER = [
  'uses: actions/checkout',
  'Set candidate metadata',
  'uses: pnpm/action-setup',
  'uses: actions/setup-node',
  'uses: dtolnay/rust-toolchain',
  'Install locked dependencies and Rust target',
  'Require the release tag to remain absent',
  'Require signing and notarization credentials',
  'Import Developer ID certificate',
  'Build signed and notarized DMG',
  'Verify Gatekeeper and notarization',
  'Record candidate DMG identity',
  'Upload candidate DMG',
  'Remove ephemeral macOS signing material',
];

const CANDIDATE_ONLY_STEPS = new Set([
  'Validate candidate inputs',
  'Require the candidate commit on origin/main',
  'Require coherent release versions',
  'Require the final release version',
  'Set candidate metadata',
  'Require the release tag to remain absent',
  'Record candidate DMG identity',
  'Upload candidate DMG',
]);

const MACOS_SIGNING_SECRETS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_TEAM_ID',
];

describe('release candidate workflow contract', () => {
  it('is dispatched manually with an exact sha and final version, and nothing else triggers it', () => {
    const workflow = candidateSource();
    const trigger = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\nconcurrency:\n'));

    expect(trigger).toMatch(/^\non:\n  workflow_dispatch:\n    inputs:\n/);
    expect(trigger).toMatch(/      sha:\n[^\n]+\n        required: true\n        type: string/);
    expect(trigger).toMatch(/      version:\n[^\n]+\n        required: true\n        type: string/);
    for (const forbidden of ['push:', 'tags:', 'pull_request', 'schedule:', 'workflow_call', 'workflow_run']) {
      expect(workflow).not.toContain(forbidden);
    }
    expect(workflow).toContain('group: release-candidate-${{ github.event.inputs.sha }}');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(jobNames(workflow)).toEqual(['verify', 'build-macos', 'provenance']);
  });

  it('validates the dispatch ref and input shapes before checking out any source', () => {
    const verify = jobSource(candidateSource(), 'verify');
    const validation = stepSource(verify, 'Validate candidate inputs');

    expect(verify.indexOf('      - name: Validate candidate inputs')).toBeLessThan(
      verify.indexOf('uses: actions/checkout@'),
    );
    expect(validation).toContain('DISPATCH_REF: ${{ github.ref }}');
    expect(validation).toContain('RAW_CANDIDATE_SHA: ${{ github.event.inputs.sha }}');
    expect(validation).not.toMatch(/run: \|[\s\S]*\$\{\{/);

    const script = stepScript(verify, 'Validate candidate inputs');
    const validSha = 'a'.repeat(40);
    const run = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', script], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
      });
    const valid = { DISPATCH_REF: 'refs/heads/main', RAW_CANDIDATE_SHA: validSha, RAW_CANDIDATE_VERSION: '0.1.0' };

    expect(run(valid).status).toBe(0);
    for (const [override, message] of [
      [{ DISPATCH_REF: 'refs/heads/feature' }, 'must be dispatched from main'],
      [{ DISPATCH_REF: 'refs/tags/v0.1.0' }, 'must be dispatched from main'],
      [{ RAW_CANDIDATE_SHA: 'a'.repeat(39) }, '40-character'],
      [{ RAW_CANDIDATE_SHA: 'a'.repeat(41) }, '40-character'],
      [{ RAW_CANDIDATE_SHA: 'A'.repeat(40) }, '40-character'],
      [{ RAW_CANDIDATE_SHA: 'main' }, '40-character'],
      [{ RAW_CANDIDATE_SHA: `${'a'.repeat(40)}\n` }, '40-character'],
      [{ RAW_CANDIDATE_VERSION: 'v0.1.0' }, 'stable MAJOR.MINOR.PATCH'],
      [{ RAW_CANDIDATE_VERSION: '0.1.0-rc.1' }, 'stable MAJOR.MINOR.PATCH'],
      [{ RAW_CANDIDATE_VERSION: '0.1' }, 'stable MAJOR.MINOR.PATCH'],
    ] as const) {
      const result = run({ ...valid, ...override });
      expect(result.status, JSON.stringify(override)).toBe(1);
      expect(result.stdout).toContain(message);
    }
  });

  it('accepts only a commit that is equal to or an ancestor of origin/main and precedes its tag', () => {
    const verify = jobSource(candidateSource(), 'verify');
    const script = stepScript(verify, 'Require the candidate commit on origin/main');
    const root = mkdtempSync(path.join(tmpdir(), 'psyche-candidate-ancestry-'));

    try {
      const origin = path.join(root, 'origin.git');
      const work = path.join(root, 'work');
      git(root, 'init', '--bare', origin);
      git(root, 'init', work);
      writeFileSync(path.join(work, 'file.txt'), 'one\n');
      git(work, 'add', 'file.txt');
      git(work, 'commit', '-m', 'one');
      const olderMain = git(work, 'rev-parse', 'HEAD');
      writeFileSync(path.join(work, 'file.txt'), 'two\n');
      git(work, 'commit', '-am', 'two');
      const mainHead = git(work, 'rev-parse', 'HEAD');
      git(work, 'checkout', '-b', 'side', olderMain);
      writeFileSync(path.join(work, 'file.txt'), 'side\n');
      git(work, 'commit', '-am', 'side');
      const sideCommit = git(work, 'rev-parse', 'HEAD');
      git(work, 'tag', 'v9.9.9', olderMain);
      git(work, 'remote', 'add', 'origin', origin);
      git(work, 'push', '-q', 'origin', 'main', 'side', 'v9.9.9');

      const runAt = (sha: string, version: string, checkoutSha = sha) => {
        const checkout = path.join(root, `checkout-${sha.slice(0, 8)}-${version}-${checkoutSha.slice(0, 8)}`);
        git(root, 'clone', '-q', '--no-checkout', origin, checkout);
        git(checkout, 'fetch', '-q', 'origin', '+refs/heads/side:refs/remotes/origin/side');
        git(checkout, 'checkout', '-q', '--detach', checkoutSha);
        const githubOutput = path.join(checkout, '.github-output');
        writeFileSync(githubOutput, '');
        const result = spawnSync('bash', ['-c', script], {
          cwd: checkout,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? root,
            GIT_CONFIG_NOSYSTEM: '1',
            RAW_CANDIDATE_SHA: sha,
            RAW_CANDIDATE_VERSION: version,
            GITHUB_OUTPUT: githubOutput,
          },
          encoding: 'utf8',
        });
        return { ...result, output: readFileSync(githubOutput, 'utf8') };
      };

      const head = runAt(mainHead, '0.1.0');
      expect(head.status, `${head.stdout}\n${head.stderr}`).toBe(0);
      expect(head.output).toBe(
        `sha=${mainHead}\nid=rc-${mainHead.slice(0, 12)}\nversion=0.1.0\nmain_head=${mainHead}\n`,
      );

      const ancestor = runAt(olderMain, '0.1.0');
      expect(ancestor.status, `${ancestor.stdout}\n${ancestor.stderr}`).toBe(0);
      expect(ancestor.output).toContain(`main_head=${mainHead}\n`);

      const side = runAt(sideCommit, '0.1.0');
      expect(side.status).toBe(1);
      expect(side.stdout).toContain('Candidate sha must be a commit on origin/main');
      expect(side.output).toBe('');

      const mismatch = runAt(mainHead, '0.1.0', olderMain);
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toContain('Checked out source does not match the candidate sha');

      const missing = runAt('0'.repeat(40), '0.1.0', mainHead);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain('Candidate sha does not name a commit');

      const tagged = runAt(mainHead, '9.9.9');
      expect(tagged.status).toBe(1);
      expect(tagged.stdout).toContain('v9.9.9 already exists');
      expect(tagged.output).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-checks tag absence after environment approval and before any credential is read', () => {
    const build = jobSource(candidateSource(), 'build-macos');
    const step = stepSource(build, 'Require the release tag to remain absent');
    const names = stepNames(build);
    const firstCredentialStep = names.findIndex((name) =>
      stepSource(build, name).includes('secrets.'),
    );

    expect(step).not.toContain('secrets.');
    expect(step).not.toMatch(/run: \|[\s\S]*\$\{\{/);
    expect(firstCredentialStep).toBeGreaterThan(0);
    expect(names.indexOf('Require the release tag to remain absent')).toBe(firstCredentialStep - 1);
    expect(build.indexOf('Require the release tag to remain absent')).toBeLessThan(
      build.indexOf('secrets.'),
    );

    const script = stepScript(build, 'Require the release tag to remain absent');
    const root = mkdtempSync(path.join(tmpdir(), 'psyche-candidate-delayed-tag-'));
    try {
      const origin = path.join(root, 'origin.git');
      const work = path.join(root, 'work');
      git(root, 'init', '--bare', origin);
      git(root, 'init', work);
      writeFileSync(path.join(work, 'file.txt'), 'one\n');
      git(work, 'add', 'file.txt');
      git(work, 'commit', '-m', 'one');
      git(work, 'remote', 'add', 'origin', origin);
      git(work, 'push', '-q', 'origin', 'main');
      const checkout = path.join(root, 'checkout');
      git(root, 'clone', '-q', origin, checkout);

      const run = (env: Record<string, string>, cwd = checkout) =>
        spawnSync('bash', ['-c', script], {
          cwd,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? root,
            GIT_CONFIG_NOSYSTEM: '1',
            ...env,
          },
          encoding: 'utf8',
        });

      // verify ran while the tag was absent; the same build step passes then.
      expect(run({ RELEASE_VERSION: '0.1.0' }).status).toBe(0);

      // The tag appears while build-macos waits for environment approval.
      git(work, 'tag', 'v0.1.0');
      git(work, 'push', '-q', 'origin', 'v0.1.0');
      const delayed = run({ RELEASE_VERSION: '0.1.0' });
      expect(delayed.status).toBe(1);
      expect(delayed.stdout).toContain('v0.1.0 already exists');

      // Lookup errors fail closed instead of reading as absence.
      git(checkout, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
      const unreachable = run({ RELEASE_VERSION: '0.2.0' });
      expect(unreachable.status).toBe(1);
      expect(unreachable.stdout).toContain('Unable to confirm that v0.2.0 does not exist yet');

      const malformed = run({ RELEASE_VERSION: '0.1.0-rc.1' });
      expect(malformed.status).toBe(1);
      expect(malformed.stdout).toContain('stable MAJOR.MINOR.PATCH');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires coherent versions and the final release version before the shared gates', () => {
    const verify = jobSource(candidateSource(), 'verify');
    const coherence = stepSource(verify, 'Require coherent release versions');
    const finalVersion = stepSource(verify, 'Require the final release version');

    expect(coherence).toContain('run: pnpm release:coherence');
    expect(finalVersion).toContain('CANDIDATE_VERSION: ${{ steps.candidate.outputs.version }}');
    expect(finalVersion).toContain('run: pnpm release:check -- "v$CANDIDATE_VERSION"');
    const names = stepNames(verify);
    expect(names.indexOf('Require the candidate commit on origin/main')).toBeLessThan(
      names.indexOf('Require coherent release versions'),
    );
    expect(names.indexOf('Require coherent release versions')).toBeLessThan(
      names.indexOf('Require the final release version'),
    );
    expect(names.indexOf('Require the final release version')).toBeLessThan(
      names.indexOf('Verify shared TypeScript, protocol, and package surfaces'),
    );
    expect(candidateSource()).not.toMatch(/continue-on-error/);
  });

  it('forces an explicit share-or-exclude decision for every mirrored release.yml step', () => {
    const candidate = candidateSource();
    const release = releaseSource();
    const shared = new Set<string>([...SHARED_VERIFY_STEPS, ...SHARED_BUILD_STEPS, ...SETUP_STEPS]);

    expect(stepLabels(jobSource(release, 'verify'))).toEqual(RELEASE_VERIFY_ORDER);
    expect(stepLabels(jobSource(release, 'build-macos'))).toEqual(RELEASE_BUILD_ORDER);
    expect(stepLabels(jobSource(candidate, 'verify'))).toEqual(CANDIDATE_VERIFY_ORDER);
    expect(stepLabels(jobSource(candidate, 'build-macos'))).toEqual(CANDIDATE_BUILD_ORDER);

    for (const step of [...RELEASE_VERIFY_ORDER, ...RELEASE_BUILD_ORDER]) {
      const isShared = shared.has(step);
      const reason = RELEASE_ONLY_STEPS[step];
      expect(isShared !== Boolean(reason), `${step} must be shared xor excluded with a reason`).toBe(true);
    }
    for (const step of Object.keys(RELEASE_ONLY_STEPS)) {
      expect([...RELEASE_VERIFY_ORDER, ...RELEASE_BUILD_ORDER], step).toContain(step);
    }
    for (const step of [...CANDIDATE_VERIFY_ORDER, ...CANDIDATE_BUILD_ORDER]) {
      expect(shared.has(step) !== CANDIDATE_ONLY_STEPS.has(step), step).toBe(true);
    }
    // Shared steps keep their relative order on both sides.
    const sharedOrder = (order: string[]) => order.filter((step) => shared.has(step));
    expect(sharedOrder(CANDIDATE_VERIFY_ORDER)).toEqual(sharedOrder(RELEASE_VERIFY_ORDER));
    expect(sharedOrder(CANDIDATE_BUILD_ORDER)).toEqual(sharedOrder(RELEASE_BUILD_ORDER));
  });

  it('keeps the verification and signing steps byte-identical to release.yml', () => {
    const candidate = candidateSource();
    const release = releaseSource();

    for (const name of SHARED_VERIFY_STEPS) {
      expect(stepSource(jobSource(candidate, 'verify'), name), name).toBe(
        stepSource(jobSource(release, 'verify'), name),
      );
    }
    for (const name of SHARED_BUILD_STEPS) {
      expect(stepSource(jobSource(candidate, 'build-macos'), name), name).toBe(
        stepSource(jobSource(release, 'build-macos'), name),
      );
    }
    const strategy = (job: string) => job.slice(job.indexOf('    strategy:\n'), job.indexOf('    steps:\n'));
    expect(strategy(jobSource(candidate, 'build-macos'))).toBe(
      strategy(jobSource(release, 'build-macos')),
    );
    expect(strategy(jobSource(candidate, 'build-macos'))).toContain('timeout-minutes: 60');

    const releasePins = new Set(actionPins(release));
    const candidatePins = actionPins(candidate);
    expect(candidatePins.length).toBeGreaterThan(0);
    for (const pin of candidatePins) {
      expect(releasePins.has(pin), `${pin} must match the release.yml pin`).toBe(true);
    }
  });

  it('signs only in the protected release environment with the six macOS secrets', () => {
    const workflow = candidateSource();
    const build = jobSource(workflow, 'build-macos');

    expect(workflow.match(/^\s*environment:.*$/gm)).toEqual(['    environment: release']);
    expect(build).toContain('    environment: release\n');
    const referenced = [...new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(([, name]) => name))].sort();
    expect(referenced).toEqual(MACOS_SIGNING_SECRETS);
    for (const jobName of ['verify', 'provenance']) {
      expect(jobSource(workflow, jobName)).not.toContain('secrets.');
    }
    expect(workflow).not.toContain('secrets: inherit');
    expect(workflow).not.toContain('Missing required repository secret');
    expect(workflow).not.toMatch(/github\.token|GITHUB_TOKEN|GH_TOKEN/);
  });

  it('never creates a tag, release, TestFlight upload, or tap notification', () => {
    const workflow = candidateSource();
    const executable = workflow
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    for (const forbidden of [
      /gh release/,
      /gh api/,
      /\bgit tag\b/,
      /\bgit push\b/,
      /homebrew-tap/,
      /HOMEBREW_TAP_TOKEN/,
      /dispatches/,
      /\bcurl\b/,
      /altool/,
      /release:testflight/,
      /APP_STORE_CONNECT/,
      /APPLE_DISTRIBUTION/,
      /xcodebuild archive/,
      /: write\b/,
      /write-all/,
    ]) {
      expect(executable, String(forbidden)).not.toMatch(forbidden);
    }
    expect(workflow).toMatch(/^permissions:\n  contents: read\n\n/m);
    expect(workflow.match(/^ +permissions:/gm)).toBeNull();
    expect(workflow).not.toContain('upload-ios');
    expect(workflow).not.toContain('publish:');
    expect(workflow).not.toContain('notify-homebrew');
  });

  it('names artifacts by candidate identity and bounds their retention', () => {
    const workflow = candidateSource();
    const build = jobSource(workflow, 'build-macos');
    const provenance = jobSource(workflow, 'provenance');
    const uploads = [...workflow.matchAll(/uses: actions\/upload-artifact@[^\n]+\n        with:\n((?:          .+\n)+)/g)].map(
      ([, body]) => body,
    );

    expect(uploads).toHaveLength(2);
    for (const body of uploads) {
      expect(body).toMatch(/name: psyche-build-\$\{\{ env\.CANDIDATE_ID \}\}/);
      expect(body).toContain('if-no-files-found: error');
      const retention = Number(body.match(/retention-days: (\d+)/)?.[1]);
      expect(retention).toBeGreaterThan(0);
      expect(retention).toBeLessThanOrEqual(30);
    }
    expect(build).toContain('name: psyche-build-${{ env.CANDIDATE_ID }}-${{ matrix.arch }}');
    expect(provenance).toContain('pattern: psyche-build-${{ env.CANDIDATE_ID }}-*');
    expect(provenance).toMatch(/name: psyche-build-\$\{\{ env\.CANDIDATE_ID \}\}\n/);
    expect(build).toContain(
      'CANDIDATE_DMG="Psyche-Build-v${RELEASE_VERSION}-${CANDIDATE_ID}-${ARCH}.dmg"',
    );
    expect(stepScript(build, 'Set candidate metadata')).toContain(
      '[[ "$RAW_CANDIDATE_ID" != "rc-${EXPECTED_CANDIDATE_SHA:0:12}" ]]',
    );
    // The candidate identity never reaches the embedded version.
    expect(workflow).not.toMatch(/release:version|--set\b|MARKETING_VERSION=|-rc\./);
  });

  it('records per-architecture identity and assembles checksums and secret-free provenance', () => {
    const workflow = candidateSource();
    const record = stepScript(jobSource(workflow, 'build-macos'), 'Record candidate DMG identity');
    const assemble = stepScript(
      jobSource(workflow, 'provenance'),
      'Require complete artifacts and write checksums and provenance',
    );
    const root = mkdtempSync(path.join(tmpdir(), 'psyche-candidate-provenance-'));
    const candidateSha = 'b'.repeat(40);
    const candidateId = `rc-${'b'.repeat(12)}`;

    try {
      const fakeBin = path.join(root, 'bin');
      mkdirSync(fakeBin);
      const stubs: Record<string, string> = {
        xcodebuild: 'printf "Xcode 26.2\\nBuild version 17C52\\n"',
        sw_vers: 'echo 15.6',
        rustc: 'echo "rustc 1.95.0"',
        cargo: 'echo "cargo 1.95.0"',
        node: 'echo v24.0.0',
        pnpm: 'if [ "$1" = "--version" ]; then echo 10.34.5; else echo "tauri-cli 2.0.0"; fi',
      };
      for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(path.join(fakeBin, name), `#!/bin/bash\n${body}\n`);
        chmodSync(path.join(fakeBin, name), 0o755);
      }
      const candidateDir = path.join(root, 'candidate');
      mkdirSync(candidateDir);
      for (const arch of ['aarch64', 'x86_64']) {
        const runnerTemp = path.join(root, `runner-${arch}`);
        mkdirSync(path.join(runnerTemp, 'release-artifact'), { recursive: true });
        const artifactPath = path.join(runnerTemp, 'release-artifact', `Psyche-Build-v0.1.0-${arch}.dmg`);
        writeFileSync(artifactPath, `dmg-${arch}`);
        const githubEnv = path.join(runnerTemp, 'github-env');
        writeFileSync(githubEnv, '');
        const result = spawnSync('bash', ['-c', record], {
          env: {
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            RUNNER_TEMP: runnerTemp,
            RUNNER_OS: 'macOS',
            RUNNER_ARCH: arch === 'aarch64' ? 'ARM64' : 'X64',
            GITHUB_ENV: githubEnv,
            ARTIFACT_PATH: artifactPath,
            RELEASE_VERSION: '0.1.0',
            CANDIDATE_ID: candidateId,
            CANDIDATE_SHA: candidateSha,
            ARCH: arch,
            RUST_TARGET: `${arch}-apple-darwin`,
          },
          encoding: 'utf8',
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        const outDir = path.join(runnerTemp, 'candidate-artifact');
        expect(readFileSync(githubEnv, 'utf8')).toBe(`CANDIDATE_ARTIFACT_DIR=${outDir}\n`);
        for (const file of [`Psyche-Build-v0.1.0-${candidateId}-${arch}.dmg`, `build-${arch}.json`]) {
          writeFileSync(path.join(candidateDir, file), readFileSync(path.join(outDir, file)));
        }
        expect(existsSync(artifactPath)).toBe(false);
      }

      const runAssemble = () =>
        spawnSync('bash', ['-c', assemble], {
          cwd: root,
          env: {
            PATH: process.env.PATH ?? '',
            CANDIDATE_SHA: candidateSha,
            CANDIDATE_ID: candidateId,
            RELEASE_VERSION: '0.1.0',
            MAIN_HEAD: 'c'.repeat(40),
            GITHUB_REPOSITORY: 'OpenCoven/psyche-build',
            GITHUB_WORKFLOW_REF: 'OpenCoven/psyche-build/.github/workflows/release-candidate.yml@refs/heads/main',
            GITHUB_SHA: 'c'.repeat(40),
            GITHUB_REF: 'refs/heads/main',
            GITHUB_RUN_ID: '123',
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_SERVER_URL: 'https://github.com',
            GITHUB_STEP_SUMMARY: path.join(root, 'summary.md'),
          },
          encoding: 'utf8',
        });

      // A DMG that changed after its build record was written must be refused.
      const armDmg = path.join(candidateDir, `Psyche-Build-v0.1.0-${candidateId}-aarch64.dmg`);
      writeFileSync(armDmg, 'tampered');
      const tampered = runAssemble();
      expect(tampered.status).toBe(1);
      expect(tampered.stdout).toContain('Build record for aarch64 does not match');
      writeFileSync(armDmg, 'dmg-aarch64');
      rmSync(path.join(candidateDir, 'SHA256SUMS'), { force: true });

      const result = runAssemble();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(readFileSync(path.join(candidateDir, 'SHA256SUMS'), 'utf8')).toMatch(
        new RegExp(
          `^[0-9a-f]{64}  Psyche-Build-v0\\.1\\.0-${candidateId}-aarch64\\.dmg\\n[0-9a-f]{64}  Psyche-Build-v0\\.1\\.0-${candidateId}-x86_64\\.dmg\\n$`,
        ),
      );
      expect(existsSync(path.join(candidateDir, 'build-aarch64.json'))).toBe(false);
      const provenanceText = readFileSync(
        path.join(candidateDir, 'release-candidate-provenance.json'),
        'utf8',
      );
      const provenance = JSON.parse(provenanceText);
      expect(provenance.schema).toBe('psyche-build.release-candidate-provenance.v1');
      expect(provenance.candidate).toEqual({
        id: candidateId,
        sha: candidateSha,
        embeddedVersion: '0.1.0',
        intendedReleaseTag: 'v0.1.0',
      });
      expect(provenance.workflow).toMatchObject({ runId: '123', runAttempt: '2', dispatchRef: 'refs/heads/main' });
      expect(provenance.publication).toEqual({
        tagCreated: false,
        releaseCreated: false,
        testflightUploaded: false,
        homebrewNotified: false,
      });
      expect(provenance.builds.map((build: { arch: string }) => build.arch)).toEqual(['aarch64', 'x86_64']);
      expect(provenance.builds[0].toolchain).toMatchObject({ rustc: 'rustc 1.95.0', tauriCli: 'tauri-cli 2.0.0' });
      expect(provenance.builds[0].artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(provenanceText).not.toMatch(/APPLE_|PASSWORD|CERTIFICATE|TOKEN|\/Users\//);
      expect(readFileSync(path.join(root, 'summary.md'), 'utf8')).toContain(
        'No tag, release, TestFlight upload, or Homebrew notification was created.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds every job and never persists checkout credentials or dependency caches', () => {
    const workflow = candidateSource();
    for (const [jobName, timeout] of [
      ['verify', 60],
      ['build-macos', 60],
      ['provenance', 10],
    ] as const) {
      expect(jobSource(workflow, jobName)).toContain(`timeout-minutes: ${timeout}`);
    }
    const checkoutCount = workflow.match(/uses: actions\/checkout@/g)?.length ?? 0;
    const setupNodeCount = workflow.match(/uses: actions\/setup-node@/g)?.length ?? 0;
    expect(checkoutCount).toBe(2);
    expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkoutCount);
    expect(workflow.match(/package-manager-cache: false/g) ?? []).toHaveLength(setupNodeCount);
    expect(jobSource(workflow, 'provenance')).not.toContain('actions/checkout@');
  });

  it('leaves the tag-driven release workflow free of candidate behavior', () => {
    const release = releaseSource();

    expect(release).not.toMatch(/CANDIDATE|release-candidate|\brc-(?:\$|[0-9a-f])/);
    expect(jobNames(release)).toEqual(['verify', 'build-macos', 'upload-ios', 'publish', 'notify-homebrew']);
    expect(release).not.toContain('workflow_call');
  });
});
