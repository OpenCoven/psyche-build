import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
    expect(workflow).toContain('xcrun stapler validate');
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
          `#!/bin/bash\nmode="$(/usr/bin/stat -f '%Lp' "$2")"\n[ "$mode" = "600" ] || exit 91\nexec /bin/chmod "$@"\n`,
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
        `#!/bin/bash\nmode="$(/usr/bin/stat -f '%Lp' "$2")"\n[ "$mode" = "600" ] || exit 91\nexec /bin/chmod "$@"\n`,
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
