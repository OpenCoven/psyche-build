import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github/workflows/release.yml');
const rustToolchainPath = path.resolve('rust-toolchain.toml');

function workflowSource(): string {
  return readFileSync(workflowPath, 'utf8');
}

function workflowStepScript(workflow: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(
    new RegExp(
      `- name: ${escapedName}[\\s\\S]*?\\n        run: \\|\\n([\\s\\S]*?)(?=\\n\\n      - name:|\\n\\n  [a-z])`,
    ),
  );
  if (!match) throw new Error(`Unable to find workflow script for ${name}`);
  return match[1].replace(/^ {10}/gm, '');
}

function workflowJobSource(workflow: string, jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Unable to find workflow job ${jobName}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob < 0 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextJob);
}

function workflowNamedStepSource(job: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  if (start < 0) throw new Error(`Unable to find workflow step ${stepName}`);
  const remaining = job.slice(start + marker.length);
  const nextStep = remaining.search(/^      - (?:name:|uses:)/m);
  return nextStep < 0 ? job.slice(start) : job.slice(start, start + marker.length + nextStep);
}

function workflowStepCondition(step: string): string | undefined {
  return step.match(/^        if:\s*(.+)$/m)?.[1].trim();
}

function shouldRunNonDesktopStep(condition: string | undefined, desktopOnly: boolean): boolean {
  if (!condition) return true;
  expect(condition).toBe("steps.release.outputs.desktop_only != 'true'");
  return !desktopOnly;
}

function workflowJobCondition(job: string): string {
  const match = job.match(/^    if: >-\n((?:      .+\n)+)/m);
  if (!match) throw new Error('Unable to find folded workflow job condition');
  return match[1].replace(/^ {6}/gm, '').replace(/\s+/g, ' ').trim();
}

function shouldPublishRelease(condition: string, input: {
  verify: 'success' | 'failure' | 'cancelled';
  macos: 'success' | 'failure' | 'cancelled';
  ios: 'success' | 'failure' | 'cancelled' | 'skipped';
  desktopOnly: boolean;
}): boolean {
  const hasExplicitAlwaysStatusCheck = /\balways\(\)/.test(condition);
  if (
    !hasExplicitAlwaysStatusCheck &&
    [input.verify, input.macos, input.ios].some((result) => result !== 'success')
  ) {
    return false;
  }
  const resolved = condition
    .replace(/always\(\)/g, 'true')
    .replace(/needs\.verify\.result/g, JSON.stringify(input.verify))
    .replace(/needs\.build-macos\.result/g, JSON.stringify(input.macos))
    .replace(/needs\.upload-ios\.result/g, JSON.stringify(input.ios))
    .replace(
      /needs\.verify\.outputs\.desktop_only/g,
      JSON.stringify(input.desktopOnly ? 'true' : 'false'),
    );
  if (!/^[\s()&|=!"'a-z-]+$/.test(resolved)) {
    throw new Error(`Unsupported publish condition: ${condition}`);
  }
  return Function(`"use strict"; return Boolean(${resolved});`)() as boolean;
}

describe('macOS release workflow contract', () => {
  it('does not persist checkout credentials or restore mutable dependency caches', () => {
    const workflow = workflowSource();
    const checkoutCount = workflow.match(/uses: actions\/checkout@/g)?.length ?? 0;
    const setupNodeCount = workflow.match(/uses: actions\/setup-node@/g)?.length ?? 0;

    expect(checkoutCount).toBeGreaterThan(0);
    expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkoutCount);
    expect(setupNodeCount).toBeGreaterThan(0);
    expect(workflow.match(/package-manager-cache: false/g) ?? []).toHaveLength(setupNodeCount);
    expect(workflow).not.toMatch(/^\s+cache:\s*pnpm\s*$/gm);
  });

  it('documents the exact download-artifact release behind its immutable pin', () => {
    const workflow = workflowSource();

    expect(workflow).toContain(
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
    );
  });

  it('builds the exact stable tag on native Apple Silicon and Intel runners', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('ref: ${{ github.event.inputs.tag || github.ref }}');
    expect(workflow).toContain('runner: macos-15');
    expect(workflow).toContain('runner: macos-15-intel');
    expect(workflow).toContain('target: aarch64-apple-darwin');
    expect(workflow).toContain('target: x86_64-apple-darwin');
    expect(workflow).toContain('pnpm release:check -- "$RELEASE_TAG"');
    expect(workflow).toContain('verification.verified');
    expect(workflow).toContain('Release tag must be an annotated tag with a verified signature');
    expect(workflow).toContain('git merge-base --is-ancestor "$TAG_COMMIT" origin/main');
    expect(workflow).toContain('ref: ${{ needs.verify.outputs.release_sha }}');
    expect(workflow).toContain('github.event.repository.private');
    expect(workflow).toContain('A public Homebrew release cannot be published from a private repository');
    const concurrency = workflow.match(/^\s*group: (release-.+)$/m)?.[1];
    expect(concurrency).toBe('release-${{ github.event.inputs.tag || github.ref_name }}');
    const normalizeReleaseKey = (inputTag: string, refName: string) => inputTag || refName;
    expect(normalizeReleaseKey('', 'v0.0.1')).toBe(normalizeReleaseKey('v0.0.1', 'main'));
    expect(workflow).toContain('LOCAL_TAG_OBJECT_SHA="$(git rev-parse "$RELEASE_TAG^{tag}")"');
    expect(workflow).toContain('[ "$TAG_OBJECT_SHA" != "$LOCAL_TAG_OBJECT_SHA" ]');
    expect(workflow).toContain(
      'TAG_TARGET_TYPE="$(jq -r \'.object.type\' "$TAG_OBJECT_JSON_PATH")"',
    );
    expect(workflow).toContain('[ "$TAG_TARGET_TYPE" != "commit" ]');
    expect(workflow).toContain('[ "$TAG_TARGET_SHA" != "$TAG_COMMIT" ]');
    expect(workflow).toContain('[ "$TAG_TARGET_SHA" != "$HEAD_COMMIT" ]');
  });

  it('allows only manual dispatches to select desktop-only publication', () => {
    const workflow = workflowSource();
    const verifyJob = workflowJobSource(workflow, 'verify');

    expect(workflow).toContain('desktop_only:');
    expect(workflow).toContain('type: boolean');
    expect(workflow).toContain('default: false');
    expect(verifyJob).toContain('desktop_only: ${{ steps.release.outputs.desktop_only }}');
    expect(verifyJob).toContain(
      'DESKTOP_ONLY="${{ github.event_name == \'workflow_dispatch\' && github.event.inputs.desktop_only == \'true\' }}"',
    );
    expect(verifyJob).toContain('echo "desktop_only=$DESKTOP_ONLY" >> "$GITHUB_OUTPUT"');
  });

  it('runs every iOS-only verification step in full mode and skips it in desktop-only mode', () => {
    const verifyJob = workflowJobSource(workflowSource(), 'verify');
    const iosOnlySteps = [
      'Set up XcodeGen for iOS verification',
      'Require iOS 26.2 iPhone 16 Pro simulator',
      'Verify generated iOS project, Core, app, and UI tests',
    ].map((name) => workflowNamedStepSource(verifyJob, name));

    for (const step of iosOnlySteps) {
      const condition = workflowStepCondition(step);
      expect(shouldRunNonDesktopStep(condition, false)).toBe(true);
      expect(shouldRunNonDesktopStep(condition, true)).toBe(false);
    }
  });

  it('keeps shared protocol, schema, TypeScript, and package validation mandatory in both modes', () => {
    const verifyJob = workflowJobSource(workflowSource(), 'verify');
    const sharedStep = workflowNamedStepSource(
      verifyJob,
      'Verify shared TypeScript, protocol, and package surfaces',
    );

    expect(workflowStepCondition(sharedStep)).toBeUndefined();
    expect(sharedStep).toContain('pnpm test');
    expect(sharedStep).toContain('pnpm typecheck');
    expect(sharedStep).toContain('pnpm build');
  });

  it('builds the production docs site exactly once before the root release build', () => {
    const verifyJob = workflowJobSource(workflowSource(), 'verify');

    expect(verifyJob).toContain('pnpm docs:focus:check');
    expect(verifyJob.match(/pnpm --dir docs build/g)).toHaveLength(1);
    expect(verifyJob.indexOf('pnpm docs:focus:check')).toBeLessThan(
      verifyJob.indexOf('pnpm --dir docs build'),
    );
    expect(verifyJob.indexOf('pnpm --dir docs build')).toBeLessThan(
      verifyJob.indexOf('pnpm build'),
    );
  });

  it('skips TestFlight only for verified desktop-only dispatches', () => {
    const workflow = workflowSource();
    const iosJob = workflowJobSource(workflow, 'upload-ios');
    const publishJob = workflowJobSource(workflow, 'publish');

    expect(iosJob).toContain("if: needs.verify.outputs.desktop_only != 'true'");
    expect(publishJob).toContain('if: >-');
    expect(publishJob).toContain("needs.verify.result == 'success'");
    expect(publishJob).toContain("needs.build-macos.result == 'success'");
    expect(publishJob).toContain("needs.upload-ios.result == 'success'");
    expect(publishJob).toContain("needs.verify.outputs.desktop_only == 'true'");
    expect(publishJob).toContain("needs.upload-ios.result == 'skipped'");
  });

  it.each([
    ['tag push', false, true],
    ['manual full release', false, true],
    ['manual desktop-only release', true, false],
  ] as const)('%s retains the expected iOS validation and upload gates', (_name, desktopOnly, iosRuns) => {
    const workflow = workflowSource();
    const verifyJob = workflowJobSource(workflow, 'verify');
    const simulatorStep = workflowNamedStepSource(
      verifyJob,
      'Require iOS 26.2 iPhone 16 Pro simulator',
    );
    const uploadCondition = workflowJobSource(workflow, 'upload-ios').match(
      /^    if:\s*(.+)$/m,
    )?.[1];

    expect(shouldRunNonDesktopStep(workflowStepCondition(simulatorStep), desktopOnly)).toBe(iosRuns);
    expect(uploadCondition).toBe("needs.verify.outputs.desktop_only != 'true'");
    expect(!desktopOnly).toBe(iosRuns);
  });

  it.each([
    ['full success', 'success', 'success', 'success', false, true],
    ['desktop-only skips iOS', 'success', 'success', 'skipped', true, true],
    ['full release cannot skip iOS', 'success', 'success', 'skipped', false, false],
    ['failed iOS upload', 'success', 'success', 'failure', false, false],
    ['cancelled iOS upload', 'success', 'success', 'cancelled', false, false],
    ['failed shared validation', 'failure', 'success', 'skipped', true, false],
    ['failed macOS build', 'success', 'failure', 'skipped', true, false],
    ['cancelled macOS build', 'success', 'cancelled', 'skipped', true, false],
  ] as const)(
    'models publish gating for %s',
    (_name, verify, macos, ios, desktopOnly, expected) => {
      const condition = workflowJobCondition(workflowJobSource(workflowSource(), 'publish'));
      expect(shouldPublishRelease(condition, { verify, macos, ios, desktopOnly })).toBe(expected);
    },
  );

  it('requires always() to schedule desktop-only publish after upload-ios is skipped', () => {
    const condition = workflowJobCondition(workflowJobSource(workflowSource(), 'publish'));
    const skippedUpload = {
      verify: 'success',
      macos: 'success',
      ios: 'skipped',
      desktopOnly: true,
    } as const;

    expect(condition).toMatch(/^always\(\)\s*&&/);
    expect(shouldPublishRelease(condition, skippedUpload)).toBe(true);
    expect(
      shouldPublishRelease(condition.replace(/^always\(\)\s*&&\s*/, ''), skippedUpload),
    ).toBe(false);
    expect(
      shouldPublishRelease(condition.replace(/^always\(\)/, 'true'), skippedUpload),
    ).toBe(false);
  });

  it('isolates iOS distribution credentials to the upload job skipped by desktop-only mode', () => {
    const workflow = workflowSource();
    const uploadJob = workflowJobSource(workflow, 'upload-ios');
    const nonUploadJobs = ['verify', 'build-macos', 'publish', 'notify-homebrew']
      .map((jobName) => workflowJobSource(workflow, jobName))
      .join('\n');
    const iosSecrets = [
      'APPLE_DISTRIBUTION_CERTIFICATE',
      'APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
    ];

    expect(uploadJob).toContain("if: needs.verify.outputs.desktop_only != 'true'");
    for (const secret of iosSecrets) {
      expect(uploadJob).toContain(`secrets.${secret}`);
      expect(nonUploadJobs).not.toContain(`secrets.${secret}`);
    }
  });

  it('requires Apple signing and notarization before an artifact is accepted', () => {
    const workflow = workflowSource();

    for (const secret of [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow.match(/^\s*environment: release\s*$/gm)).toHaveLength(4);
    expect(workflow).toContain('Missing required release environment secret $secret_name');
    expect(workflow).not.toContain('Missing required repository secret');
    expect(workflow).toContain('security import "$CERTIFICATE_PATH"');
    expect(workflow).toContain('codesign --verify --deep --strict');
    expect(workflow).toContain('spctl --assess --type execute');
    expect(workflow).toContain('xcrun notarytool submit "$DMG_PATH"');
    expect(workflow).toContain('xcrun stapler staple "$DMG_PATH"');
    expect(workflow).toContain('xcrun stapler validate');
    expect(workflow.indexOf('xcrun notarytool submit "$DMG_PATH"')).toBeLessThan(
      workflow.indexOf('xcrun stapler staple "$DMG_PATH"'),
    );
    expect(workflow.indexOf('xcrun stapler staple "$DMG_PATH"')).toBeLessThan(
      workflow.indexOf('xcrun stapler validate "$DMG_PATH"'),
    );
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
    expect(workflowJobSource(workflow, 'build-macos')).toContain('if: always()');
    expect(workflowJobSource(workflow, 'build-macos')).toContain(
      'Remove ephemeral macOS signing material',
    );
  });

  it('creates both certificate files with mode 600 on first creation', () => {
    const workflow = workflowSource();
    const cases = [
      {
        step: 'Import Developer ID certificate',
        certificate: 'APPLE_CERTIFICATE',
        password: 'APPLE_CERTIFICATE_PASSWORD',
        path: 'apple-developer-id.p12',
      },
      {
        step: 'Import Apple Distribution certificate into an ephemeral keychain',
        certificate: 'APPLE_DISTRIBUTION_CERTIFICATE',
        password: 'APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
        path: 'apple-distribution.p12',
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(path.join(tmpdir(), 'psyche-certificate-mode-'));
      try {
        const fakeBin = path.join(root, 'bin');
        const fakeChmod = path.join(fakeBin, 'chmod');
        const fakeSecurity = path.join(fakeBin, 'security');
        mkdirSync(fakeBin);
        writeFileSync(
          fakeChmod,
          // GNU coreutils ahead of /usr/bin on PATH gives GNU stat, where -f means
          // --file-system, so the BSD form silently reported the wrong thing. GNU is
          // tried first because BSD stat rejects -c outright, which makes the
          // fallback unambiguous; the reverse order does not, since GNU -f succeeds
          // for the file argument while failing on the format.
          `#!/bin/bash\nmode="$(stat -c '%a' "$2" 2>/dev/null || stat -f '%Lp' "$2")"\n[ "$mode" = "600" ] || exit 91\nexec /bin/chmod "$@"\n`,
        );
        writeFileSync(fakeSecurity, '#!/bin/bash\nexit 0\n');
        chmodSync(fakeChmod, 0o755);
        chmodSync(fakeSecurity, 0o755);

        const result = spawnSync(
          'bash',
          ['-c', workflowStepScript(workflow, testCase.step)],
          {
            env: {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
              RUNNER_TEMP: root,
              GITHUB_ENV: path.join(root, 'github-env'),
              [testCase.certificate]: Buffer.from('certificate').toString('base64'),
              [testCase.password]: 'password',
            },
            encoding: 'utf8',
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect((statSync(path.join(root, testCase.path)).mode & 0o777).toString(8)).toBe('600');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('publishes only the complete architecture set plus checksums', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-${ARCH}.dmg');
    expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-aarch64.dmg');
    expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-x86_64.dmg');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('gh release create "$RELEASE_TAG"');
    expect(workflow).toContain('gh release download "$RELEASE_TAG"');
    expect(workflow).toContain('Published release assets and notes match the verified build output');
    expect(workflow).toContain('notify-homebrew:');
    expect(workflow).toContain('needs: publish');
    expect(workflowJobSource(workflow, 'notify-homebrew')).toMatch(
      /if:\s*always\(\)\s*&&\s*needs\.publish\.result\s*==\s*['"]success['"]/,
    );
    expect(workflow).toContain('event_type: "psyche-build-release"');
    expect(workflow).toContain('secrets.HOMEBREW_TAP_TOKEN');
    expect(workflow).toContain('Missing required release environment secret HOMEBREW_TAP_TOKEN');
  });

  it('verifies every product against the pinned Apple toolchain', () => {
    const workflow = workflowSource();
    const destination = 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro';

    expect(workflow).toContain('DEVELOPER_DIR: /Applications/Xcode_26.2.app/Contents/Developer');
    expect(workflow).toContain("grep -Fx 'Xcode 26.2'");
    expect(workflow).toContain("grep -Fx 'Build version 17C52'");
    expect(workflow.match(/uses: \.\/\.github\/actions\/setup-xcodegen/g)).toHaveLength(2);
    expect(workflow).not.toContain('XCODEGEN_VERSION=');
    expect(workflow).not.toContain('XCODEGEN_SHA256=');
    expect(workflow).toContain('pnpm ios:project:check');
    expect(workflow).toContain(`-destination '${destination}'`);
    expect(workflow).toContain('-scheme PsycheCore');
    expect(workflow).toContain('-scheme PsycheApp');
  });

  it('archives, verifies, exports, and uploads the exact iOS release source', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('upload-ios:');
    expect(workflow).toMatch(/upload-ios:\s*\n(?:.|\n)*?needs: verify\s*\n(?:.|\n)*?runs-on: macos-15\s*\n(?:.|\n)*?environment: release/);
    expect(workflow).toContain('ref: ${{ needs.verify.outputs.release_sha }}');
    for (const secret of [
      'APPLE_DISTRIBUTION_CERTIFICATE',
      'APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
      'APP_STORE_CONNECT_KEY_ID',
      'APP_STORE_CONNECT_ISSUER_ID',
      'APP_STORE_CONNECT_PRIVATE_KEY',
      'APPLE_TEAM_ID',
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).toContain('APP_STORE_CONNECT_PRIVATE_KEY_PATH="$RUNNER_TEMP/app-store-connect-key.p8"');
    expect(workflow).not.toContain('AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8');
    expect(workflow).toContain('chmod 0600 "$APP_STORE_CONNECT_PRIVATE_KEY_PATH"');
    expect(workflow).toContain('security import "$CERTIFICATE_PATH"');
    expect(workflow).toContain('-destination \'generic/platform=iOS\'');
    expect(workflow).toContain('CURRENT_PROJECT_VERSION=1');
    expect(workflow).toContain('MARKETING_VERSION="$RELEASE_VERSION"');
    expect(workflow).toContain('PSYCHE_RELEASE_SHA="$EXPECTED_RELEASE_SHA"');
    expect(workflow).toContain('-authenticationKeyPath "$APP_STORE_CONNECT_PRIVATE_KEY_PATH"');
    expect(workflow).toContain('Products/Applications/Psyche Build.app/Info.plist');
    for (const expected of [
      'ai.opencoven.psyche-ios',
      'Psyche Build',
      'CFBundleShortVersionString',
      'CFBundleVersion',
      'PsycheReleaseCommit',
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).toContain('-exportOptionsPlist native/ios/ExportOptions.plist');
    expect(workflow).toContain('xcrun altool --validate-app');
    expect(workflow).toContain('xcrun altool --upload-app');
    expect(workflow).toContain('--output-format json');
    expect(workflow).toContain('API_PRIVATE_KEYS_DIR');
    expect(workflow).toContain('--p8-file-path "$APP_STORE_CONNECT_PRIVATE_KEY_PATH"');
  });

  it('creates the App Store Connect key with mode 600 before the defensive chmod', () => {
    const workflow = workflowSource();
    const script = workflowStepScript(workflow, 'Require iOS distribution credentials');
    const root = mkdtempSync(path.join(tmpdir(), 'psyche-key-mode-'));

    try {
      expect(script).toContain('umask 077');
      const fakeBin = path.join(root, 'bin');
      const fakeChmod = path.join(fakeBin, 'chmod');
      const githubEnv = path.join(root, 'github-env');
      mkdirSync(fakeBin);
      writeFileSync(
        fakeChmod,
        // GNU coreutils ahead of /usr/bin on PATH gives GNU stat, where -f means
          // --file-system, so the BSD form silently reported the wrong thing. GNU is
          // tried first because BSD stat rejects -c outright, which makes the
          // fallback unambiguous; the reverse order does not, since GNU -f succeeds
          // for the file argument while failing on the format.
          `#!/bin/bash\nmode="$(stat -c '%a' "$2" 2>/dev/null || stat -f '%Lp' "$2")"\n[ "$mode" = "600" ] || exit 91\nexec /bin/chmod "$@"\n`,
      );
      chmodSync(fakeChmod, 0o755);
      writeFileSync(githubEnv, '');

      execFileSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: root,
          GITHUB_ENV: githubEnv,
          APPLE_DISTRIBUTION_CERTIFICATE: 'certificate',
          APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD: 'password',
          APP_STORE_CONNECT_KEY_ID: 'KEY123',
          APP_STORE_CONNECT_ISSUER_ID: 'issuer',
          APP_STORE_CONNECT_PRIVATE_KEY: 'private-key-content',
          APPLE_TEAM_ID: 'team',
        },
        stdio: 'pipe',
      });

      const keyPath = path.join(root, 'app-store-connect-key.p8');
      expect((statSync(keyPath).mode & 0o777).toString(8)).toBe('600');
      expect(readFileSync(keyPath, 'utf8')).toBe('private-key-content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses only an exact existing TestFlight build and uploads only on a distinct absence result', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('node scripts/release-notes.mjs --testflight');
    expect(workflow.match(/pnpm release:testflight --/g)).toHaveLength(2);
    for (const requiredArgument of [
      '--bundle-id ai.opencoven.psyche-ios',
      '--version "$RELEASE_VERSION"',
      '--build-number 1',
      '--locale en-US',
      '--notes-file "$TESTFLIGHT_NOTES_PATH"',
      '--release-sha "$EXPECTED_RELEASE_SHA"',
      '--timeout-seconds 2700',
    ]) {
      expect(workflow.split(requiredArgument)).toHaveLength(3);
    }
    expect(workflow.match(/--reuse-existing/g)).toHaveLength(1);
    expect(workflow).toContain('set +e');
    expect(workflow).toContain('[ "$REUSE_STATUS" = "2" ]');
    expect(workflow).toContain("steps.preflight.outputs.upload == 'true'");
    expect(workflow).toContain("steps.preflight.outputs.upload != 'true'");
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
  });

  it('executes preflight routing as 0 reuse, 2 upload, and every other status fatal', () => {
    const workflow = workflowSource();
    const script = workflowStepScript(workflow, 'Reuse an exact existing TestFlight build when possible');

    for (const [status, expectedExit, expectedOutput] of [
      [0, 0, 'upload=false\n'],
      [2, 0, 'upload=true\n'],
      [7, 7, ''],
    ] as const) {
      const root = mkdtempSync(path.join(tmpdir(), 'psyche-preflight-routing-'));
      try {
        const fakeBin = path.join(root, 'bin');
        const fakePnpm = path.join(fakeBin, 'pnpm');
        const githubOutput = path.join(root, 'github-output');
        mkdirSync(fakeBin);
        writeFileSync(fakePnpm, `#!/bin/bash\nexit ${status}\n`);
        chmodSync(fakePnpm, 0o755);
        writeFileSync(githubOutput, '');
        const result = spawnSync('bash', ['-c', script], {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            GITHUB_OUTPUT: githubOutput,
            RELEASE_VERSION: '0.0.1',
            TESTFLIGHT_NOTES_PATH: path.join(root, 'notes.txt'),
            EXPECTED_RELEASE_SHA: '0'.repeat(40),
          },
          encoding: 'utf8',
        });
        expect(result.status).toBe(expectedExit);
        expect(readFileSync(githubOutput, 'utf8')).toBe(expectedOutput);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('cleans signing material unconditionally and independently in both release jobs', () => {
    const workflow = workflowSource();
    const macosJob = workflowJobSource(workflow, 'build-macos');
    const iosJob = workflowJobSource(workflow, 'upload-ios');

    for (const job of [macosJob, iosJob]) {
      expect(job).toContain('if: always()');
      expect(job).toContain('CLEANUP_FAILED=0');
      expect(job).toContain('security delete-keychain');
    }
    expect(macosJob).toContain('$RUNNER_TEMP/apple-developer-id.p12');
    expect(macosJob).toContain('$RUNNER_TEMP/psyche-macos-signing.keychain-db');
    expect(iosJob).toContain('$RUNNER_TEMP/apple-distribution.p12');
    expect(iosJob).toContain('$RUNNER_TEMP/psyche-ios-signing.keychain-db');
    expect(iosJob).toContain('$RUNNER_TEMP/app-store-connect-key.p8');

    const script = workflowStepScript(workflow, 'Remove ephemeral iOS signing material');
    const root = mkdtempSync(path.join(tmpdir(), 'psyche-cleanup-routing-'));
    try {
      const fakeBin = path.join(root, 'bin');
      const calls = path.join(root, 'calls');
      mkdirSync(fakeBin);
      writeFileSync(
        path.join(fakeBin, 'security'),
        '#!/bin/bash\nprintf "security %s\\n" "$*" >> "$CLEANUP_CALLS"\nexit 1\n',
      );
      writeFileSync(
        path.join(fakeBin, 'rm'),
        '#!/bin/bash\nprintf "rm %s\\n" "$*" >> "$CLEANUP_CALLS"\nexit 0\n',
      );
      chmodSync(path.join(fakeBin, 'security'), 0o755);
      chmodSync(path.join(fakeBin, 'rm'), 0o755);
      writeFileSync(path.join(root, 'psyche-ios-signing.keychain-db'), 'keychain');

      const result = spawnSync('bash', ['-c', script], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: root,
          CLEANUP_CALLS: calls,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(readFileSync(calls, 'utf8')).toContain('security delete-keychain');
      expect(readFileSync(calls, 'utf8')).toContain('apple-distribution.p12');
      expect(readFileSync(calls, 'utf8')).toContain('app-store-connect-key.p8');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes curated notes only after macOS and TestFlight succeed and verifies retries byte-for-byte', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('needs: [verify, build-macos, upload-ios]');
    expect(workflow).toContain('node scripts/release-notes.mjs --github');
    expect(workflow).toContain('--notes-file "$RELEASE_NOTES_PATH"');
    expect(workflow).not.toContain('--generate-notes');
    expect(workflow).toContain('process.stdout.write(release.body)');
    expect(workflow).toContain('cmp "$RELEASE_NOTES_PATH" "$PUBLISHED_NOTES_PATH"');
    expect(workflow).toContain('Published release assets and notes match the verified build output');
    expect(workflow).toContain('gh release view "$RELEASE_TAG" --json assets --jq \'.assets[].name\'');
    expect(workflow).toContain('cmp "$EXPECTED_DRAFT_ASSETS" "$ACTUAL_DRAFT_ASSETS"');
    expect(workflow).toContain('gh release download "$RELEASE_TAG" --dir "$DRAFT_ASSET_DIR"');
    expect(workflow).toContain('Draft release assets match the verified build output');
    expect(workflow.indexOf('Draft release assets match the verified build output')).toBeLessThan(
      workflow.indexOf('gh release edit "$RELEASE_TAG" --draft=false --latest'),
    );
  });

  it('does not expose release secrets or fall back to repository secrets', () => {
    const workflow = workflowSource();

    expect(workflow).not.toContain('Missing required repository secret');
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
    expect(workflow).not.toMatch(/echo[^\n]*"\$(APP_STORE_CONNECT_PRIVATE_KEY|APPLE_DISTRIBUTION_CERTIFICATE)"/);
    expect(workflow).not.toMatch(/\bcat\s+[^\n]*(APP_STORE_CONNECT_PRIVATE_KEY|AuthKey_)/);
  });

  it('pins every third-party action to an immutable commit', () => {
    const workflow = workflowSource();
    const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
      ([, action]) => action,
    );

    expect(actionUses.length).toBeGreaterThan(0);
    for (const action of actionUses) {
      if (action.startsWith('./')) {
        expect(action).toBe('./.github/actions/setup-xcodegen');
      } else {
        expect(action, `${action} must be commit-pinned`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('bounds every release job and gives the PAT-only notification no token permissions', () => {
    const workflow = workflowSource();
    const expectedTimeouts = new Map([
      ['verify', 60],
      ['build-macos', 60],
      ['upload-ios', 60],
      ['publish', 20],
      ['notify-homebrew', 5],
    ]);
    for (const [jobName, timeout] of expectedTimeouts) {
      expect(workflowJobSource(workflow, jobName)).toContain(`timeout-minutes: ${timeout}`);
    }
    expect(workflowJobSource(workflow, 'notify-homebrew')).toContain('permissions: {}');
  });

  it('pins the Rust compiler consistently for local and release builds', () => {
    const workflow = workflowSource();
    const rustToolchain = readFileSync(rustToolchainPath, 'utf8');

    expect(rustToolchain).toContain('channel = "1.95.0"');
    expect(rustToolchain).toContain('components = ["rustfmt"]');
    expect(workflow.match(/toolchain: 1\.95\.0/g)).toHaveLength(2);
    expect(workflow).not.toMatch(/^\s*toolchain:\s*stable\s*$/m);
  });
});

describe('update manifest release contract', () => {
  const manifestSteps = [
    'Resolve update manifest signing',
    'Build update manifest',
    'Sign update manifest',
    'Verify signed update manifest',
  ];

  function publishJob(): string {
    return workflowJobSource(workflowSource(), 'publish');
  }

  it('builds, signs, and self-verifies after checksums and before any release mutation', () => {
    const job = publishJob();
    const order = [
      'Require complete artifacts and generate checksums',
      ...manifestSteps,
      'Generate curated GitHub release notes',
      'Publish complete stable release',
    ].map((name) => job.indexOf(`      - name: ${name}\n`));
    for (const index of order) expect(index).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(job).toContain('environment: release');
  });

  it('gates every manifest step on a resolved current key and never on a missing secret', () => {
    const job = publishJob();
    const resolve = workflowNamedStepSource(job, 'Resolve update manifest signing');
    expect(workflowStepCondition(resolve)).toBeUndefined();
    expect(resolve).toContain('id: update-manifest');
    for (const name of manifestSteps.slice(1)) {
      expect(workflowStepCondition(workflowNamedStepSource(job, name))).toBe(
        "steps.update-manifest.outputs.active == 'true'",
      );
    }
    const build = workflowNamedStepSource(job, 'Build update manifest');
    expect(build).toContain('--expires-in-days 30');
    expect(build).toContain("%(taggerdate:iso-strict)");
    expect(build).toContain('--sha256sums artifacts/SHA256SUMS');
    const verify = workflowNamedStepSource(job, 'Verify signed update manifest');
    expect(verify).toContain('--expect-tag "$RELEASE_TAG"');
    expect(verify).toContain('--expect-source-sha "$RELEASE_SHA"');
    expect(verify).toContain('--keys release/update-manifest-keys.json');
  });

  it('reads the tagger date only from the exact signed tag object the verify job checked', () => {
    const workflow = workflowSource();
    const verifyJob = workflowJobSource(workflow, 'verify');
    expect(verifyJob).toContain('release_tag_object_sha: ${{ steps.signed-tag.outputs.tag_object_sha }}');
    const signedTag = workflowNamedStepSource(verifyJob, 'Require a verified signed tag');
    expect(signedTag).toContain('id: signed-tag');
    const signedTagScript = workflowStepScript(workflow, 'Require a verified signed tag');
    expect(signedTagScript.indexOf('echo "tag_object_sha=$TAG_OBJECT_SHA" >> "$GITHUB_OUTPUT"')).toBeGreaterThan(
      signedTagScript.indexOf('if [ "$SIGNATURE_VERIFIED" != "true" ]; then'),
    );

    const build = workflowNamedStepSource(publishJob(), 'Build update manifest');
    expect(build).toContain('VERIFIED_TAG_OBJECT_SHA: ${{ needs.verify.outputs.release_tag_object_sha }}');
    const script = workflowStepScript(workflow, 'Build update manifest');
    expect(script.indexOf('git rev-parse --verify "$RELEASE_TAG^{tag}"')).toBeLessThan(
      script.indexOf('%(taggerdate:iso-strict)'),
    );

    const root = mkdtempSync(path.join(tmpdir(), 'psyche-tag-object-'));
    try {
      const gitEnv = {
        PATH: process.env.PATH ?? '',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
      };
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'release');
      git('tag', '-a', '--no-sign', '-m', 'release', 'v1.2.3');
      const tagObject = git('rev-parse', 'v1.2.3^{tag}');
      const run = (verified: string) =>
        spawnSync('/bin/bash', ['-c', script], {
          cwd: root,
          env: { ...gitEnv, RELEASE_TAG: 'v1.2.3', RELEASE_VERSION: '1.2.3', RELEASE_SHA: git('rev-parse', 'HEAD'), VERIFIED_TAG_OBJECT_SHA: verified },
          encoding: 'utf8',
        });
      for (const verified of ['', 'f'.repeat(40), git('rev-parse', 'HEAD')]) {
        const result = run(verified);
        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/::error::(The verify job did not report|Release tag object does not match)/);
      }
      // With the matching object the check passes and the step proceeds to the
      // builder, which is absent from this scratch repository.
      const matching = run(tagObject);
      expect(matching.stdout).not.toContain('::error::');
      expect(matching.stderr).toContain('update-manifest.mjs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scopes the signing secret to the single sign step and fails closed when it is empty', () => {
    const workflow = workflowSource();
    expect(workflow.match(/secrets\.UPDATE_MANIFEST_SIGNING_KEY/g)).toHaveLength(1);
    expect(workflow.match(/UPDATE_MANIFEST_SIGNING_KEY/g)).toHaveLength(5);
    const signStep = workflowNamedStepSource(publishJob(), 'Sign update manifest');
    expect(signStep).toContain('UPDATE_MANIFEST_SIGNING_KEY: ${{ secrets.UPDATE_MANIFEST_SIGNING_KEY }}');
    expect(signStep).toContain('--key-env UPDATE_MANIFEST_SIGNING_KEY');
    for (const name of manifestSteps.filter((step) => step !== 'Sign update manifest')) {
      expect(workflowNamedStepSource(publishJob(), name)).not.toContain('UPDATE_MANIFEST_SIGNING_KEY');
    }
    expect(signStep).not.toMatch(/echo[^\n]*"\$UPDATE_MANIFEST_SIGNING_KEY"/);

    const script = workflowStepScript(workflow, 'Sign update manifest');
    const result = spawnSync('/bin/bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '', UPDATE_MANIFEST_SIGNING_KEY: '' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::Missing required release environment secret UPDATE_MANIFEST_SIGNING_KEY');
  });

  it('skips with a notice when no current key exists, activates with one, and fails on a malformed keys file', () => {
    const script = workflowStepScript(workflowSource(), 'Resolve update manifest signing');
    const repositoryKeys = readFileSync('release/update-manifest-keys.json', 'utf8');
    const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const entry = { keyId: createHash('sha256').update(raw).digest('hex').slice(0, 16), publicKey: raw.toString('base64') };

    const run = (keys: string) => {
      const root = mkdtempSync(path.join(tmpdir(), 'psyche-update-manifest-status-'));
      try {
        mkdirSync(path.join(root, 'scripts'));
        mkdirSync(path.join(root, 'release'));
        writeFileSync(path.join(root, 'scripts/update-manifest.mjs'), readFileSync('scripts/update-manifest.mjs'));
        writeFileSync(path.join(root, 'release/update-manifest-keys.json'), keys);
        const output = path.join(root, 'github-output');
        writeFileSync(output, '');
        const result = spawnSync('/bin/bash', ['-c', script], {
          cwd: root,
          env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output },
          encoding: 'utf8',
        });
        return { ...result, output: readFileSync(output, 'utf8') };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    const inactive = run(repositoryKeys);
    expect(inactive.status, inactive.stderr).toBe(0);
    expect(inactive.output).toBe('active=false\n');
    expect(inactive.stdout).toContain('::notice title=Update manifest not published::');

    const active = run(JSON.stringify({ schema: 1, current: entry, next: null }));
    expect(active.status, active.stderr).toBe(0);
    expect(active.output).toBe('active=true\n');
    expect(active.stdout).toContain(`Update manifest signing is active for key ${entry.keyId}`);

    const malformed = run(JSON.stringify({ schema: 1, current: { ...entry, keyId: '0'.repeat(16) }, next: null }));
    expect(malformed.status).not.toBe(0);
    expect(malformed.output).toBe('');
  });

  describe('exact published asset set', () => {
    const version = '1.2.3';
    const baseAssets = [
      `Psyche-Build-v${version}-aarch64.dmg`,
      `Psyche-Build-v${version}-x86_64.dmg`,
      'SHA256SUMS',
    ];
    const manifestAssets = ['update-manifest.json', 'update-manifest.json.sig'];

    // A stateful fake `gh` modelling a draft GitHub Release.
    const fakeGh = `#!/bin/bash
set -euo pipefail
state="$FAKE_GH_STATE"
echo "$*" >> "$state/calls"
[ "$1" = release ] || exit 2
sub="$2"; shift 2
case "$sub" in
  view)
    if [ "$#" = 1 ]; then [ -f "$state/created" ]; exit; fi
    case "$*" in
      *"--json isDraft"*) if [ -f "$state/published" ]; then echo false; else echo true; fi ;;
      *"--json assets"*) ls -1 "$state/assets" ;;
      *) exit 3 ;;
    esac ;;
  create) touch "$state/created" ;;
  edit) case "$*" in *"--draft=false"*) touch "$state/published" ;; esac ;;
  upload)
    shift
    [ "$1" = --clobber ] && shift
    for file in "$@"; do cp "$file" "$state/assets/"; done ;;
  download)
    dir="$3"; mkdir -p "$dir"; cp "$state/assets/"* "$dir/" ;;
  *) exit 4 ;;
esac
`;

    function runPublish(input: {
      active: string;
      artifacts: string[];
      preexistingDraftAssets?: string[];
    }) {
      const root = mkdtempSync(path.join(tmpdir(), 'psyche-publish-assets-'));
      try {
        const bin = path.join(root, 'bin');
        const state = path.join(root, 'state');
        const artifacts = path.join(root, 'artifacts');
        for (const directory of [bin, state, path.join(state, 'assets'), artifacts]) mkdirSync(directory);
        writeFileSync(path.join(bin, 'gh'), fakeGh);
        chmodSync(path.join(bin, 'gh'), 0o755);
        for (const asset of input.artifacts) writeFileSync(path.join(artifacts, asset), `content of ${asset}\n`);
        const dmgs = baseAssets.slice(0, 2).filter((asset) => input.artifacts.includes(asset));
        if (input.artifacts.includes('SHA256SUMS')) {
          writeFileSync(
            path.join(artifacts, 'SHA256SUMS'),
            execFileSync('shasum', ['-a', '256', ...dmgs], { cwd: artifacts }),
          );
        }
        if (input.preexistingDraftAssets) {
          writeFileSync(path.join(state, 'created'), '');
          for (const asset of input.preexistingDraftAssets) {
            writeFileSync(path.join(state, 'assets', asset), 'stale\n');
          }
        }
        const notes = path.join(root, 'notes.md');
        writeFileSync(notes, 'notes\n');
        const result = spawnSync('/bin/bash', ['-c', workflowStepScript(workflowSource(), 'Publish complete stable release')], {
          cwd: root,
          env: {
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            FAKE_GH_STATE: state,
            GH_TOKEN: 'test',
            RELEASE_TAG: `v${version}`,
            RELEASE_VERSION: version,
            RELEASE_NOTES_PATH: notes,
            RUNNER_TEMP: root,
            UPDATE_MANIFEST_ACTIVE: input.active,
          },
          encoding: 'utf8',
        });
        const calls = path.join(state, 'calls');
        const published = existsSync(calls) && readFileSync(calls, 'utf8').includes('--draft=false --latest');
        const uploaded = execFileSync('ls', ['-1', path.join(state, 'assets')], { encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
          .sort();
        return { ...result, published, uploaded };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it('publishes exactly the DMGs and SHA256SUMS while signing is inactive', () => {
      const result = runPublish({ active: 'false', artifacts: baseAssets });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.uploaded).toEqual([...baseAssets].sort());
      expect(result.published).toBe(true);
    });

    it('publishes exactly five assets, including the manifest and signature, while signing is active', () => {
      const result = runPublish({ active: 'true', artifacts: [...baseAssets, ...manifestAssets] });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.uploaded).toEqual([...baseAssets, ...manifestAssets].sort());
      expect(result.published).toBe(true);
    });

    it('refuses to publish when the active manifest assets are missing', () => {
      const result = runPublish({ active: 'true', artifacts: baseAssets });
      expect(result.status).not.toBe(0);
      expect(result.published).toBe(false);
    });

    it('refuses a draft carrying any asset outside the exact set, in either mode', () => {
      const inactive = runPublish({ active: 'false', artifacts: baseAssets, preexistingDraftAssets: manifestAssets });
      expect(inactive.status).not.toBe(0);
      expect(inactive.stdout).toContain('Draft release must contain exactly the expected release assets');
      expect(inactive.published).toBe(false);

      const active = runPublish({
        active: 'true',
        artifacts: [...baseAssets, ...manifestAssets],
        preexistingDraftAssets: ['update-manifest.json.minisig'],
      });
      expect(active.status).not.toBe(0);
      expect(active.published).toBe(false);
    });

    it('fails closed when activation was never resolved', () => {
      for (const active of ['', 'yes', 'TRUE']) {
        const result = runPublish({ active, artifacts: [...baseAssets, ...manifestAssets] });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('::error::Update manifest activation is unresolved');
        expect(result.published).toBe(false);
      }
    });

    it('names both manifest assets literally, never by wildcard', () => {
      const script = workflowStepScript(workflowSource(), 'Publish complete stable release');
      expect(script).toContain('RELEASE_ASSETS+=(update-manifest.json update-manifest.json.sig)');
      expect(script).not.toMatch(/update-manifest[^\s)]*\*/);
      expect(script).not.toMatch(/"3"|three assets/);
    });
  });
});
