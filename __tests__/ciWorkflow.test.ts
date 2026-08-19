import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github/workflows/ci.yml');
const releaseWorkflowPath = path.resolve('.github/workflows/release.yml');
const packageJsonPath = path.resolve('package.json');

function workflowSource(): string {
  try {
    return readFileSync(workflowPath, 'utf8');
  } catch {
    return '';
  }
}

function workflowJobSource(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  expect(start, `${name} job`).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

describe('pull request CI workflow contract', () => {
  it('runs read-only checks for pull requests and configured pushes with stable required checks', () => {
    const workflow = workflowSource();
    const changesJob = workflowJobSource(workflow, 'changes');
    const qualityJob = workflowJobSource(workflow, 'quality');
    const requiredTypeScriptJob = workflowJobSource(workflow, 'typescript-rust');
    const requiredIosJob = workflowJobSource(workflow, 'ios');

    expect(workflow).toContain('name: CI');
    expect(workflow).toMatch(/pull_request:\s*\n/);
    expect(workflow).toMatch(
      /push:\s*\n\s+branches: \[main, feat\/gpu-accelerated-ade\]/,
    );
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(changesJob).toContain('name: Classify changes');
    expect(qualityJob).toContain('name: Quality');
    expect(requiredTypeScriptJob).toContain('name: TypeScript and Rust');
    expect(requiredIosJob).toContain('name: iOS');
  });

  it('pins Node, pnpm, Rust, and every third-party action', () => {
    const workflow = workflowSource();
    const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      packageManager?: string;
    };
    const checkoutCount = workflow.match(/uses: actions\/checkout@/g)?.length ?? 0;

    expect(workflow).toContain('node-version: 24');
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    for (const source of [workflow, releaseWorkflow]) {
      expect(source).not.toMatch(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version:/);
    }
    expect(workflow).toContain('toolchain: 1.95.0');
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1');
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow).toContain('dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8');
    expect(checkoutCount).toBeGreaterThan(0);
    expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkoutCount);

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

  it('defines the tiered workflow topology and deduplicates validation surfaces', () => {
    const workflow = workflowSource();
    const changesJob = workflowJobSource(workflow, 'changes');
    const qualityJob = workflowJobSource(workflow, 'quality');
    const desktopWebJob = workflowJobSource(workflow, 'desktop-web');
    const rustTestJob = workflowJobSource(workflow, 'rust-test');
    const desktopCheckJob = workflowJobSource(workflow, 'desktop-check');
    const requiredTypeScriptJob = workflowJobSource(workflow, 'typescript-rust');
    const iosCoreJob = workflowJobSource(workflow, 'ios-core');
    const requiredIosJob = workflowJobSource(workflow, 'ios');

    expect(changesJob).toContain('name: Classify changes');
    expect(changesJob).toContain('runs-on: ubuntu-24.04');
    expect(changesJob).toContain('timeout-minutes: 10');
    expect(changesJob).toContain('fetch-depth: 0');
    expect(changesJob).toContain('persist-credentials: false');
    expect(changesJob).toContain(
      'BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}',
    );
    expect(changesJob).toContain(
      'HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
    );
    expect(changesJob).toContain('GITHUB_EVENT_NAME: ${{ github.event_name }}');
    expect(changesJob).toContain('scripts/classify-ci-changes.sh');

    expect(qualityJob).toContain('name: Quality');
    expect(qualityJob).not.toContain('needs:');
    expect(qualityJob).toContain('runs-on: macos-15');
    expect(qualityJob).toContain('timeout-minutes: 35');
    expect(qualityJob).toContain('- name: Install tmux');
    expect(qualityJob).toContain('brew install tmux');
    expect(qualityJob).toContain('pnpm install --frozen-lockfile');
    for (const command of [
      'pnpm docs:focus:check',
      'pnpm --dir docs build',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(qualityJob).toContain(command);
    }
    expect(qualityJob).toContain("if: github.event_name == 'push'");
    expect(qualityJob).toContain('pnpm smoke:pack');
    expect(qualityJob).not.toContain('cargo fmt');
    expect(qualityJob).not.toContain('cargo test');
    expect(qualityJob).not.toContain('cargo check');
    expect(qualityJob).not.toContain('build:web');
    expect(qualityJob.indexOf('brew install tmux')).toBeLessThan(qualityJob.indexOf('pnpm test'));
    expect(qualityJob.match(/pnpm --dir docs build/g)).toHaveLength(1);
    expect(qualityJob.indexOf('pnpm docs:focus:check')).toBeLessThan(
      qualityJob.indexOf('pnpm --dir docs build'),
    );
    expect(qualityJob.indexOf('pnpm --dir docs build')).toBeLessThan(
      qualityJob.indexOf('pnpm build'),
    );

    expect(desktopWebJob).toContain('name: Desktop web');
    expect(desktopWebJob).toContain('needs: changes');
    expect(desktopWebJob).toContain("if: needs.changes.outputs.desktop == 'true'");
    expect(desktopWebJob).toContain('runs-on: macos-15');
    expect(desktopWebJob).toContain('timeout-minutes: 25');
    expect(desktopWebJob).toContain('pnpm install --frozen-lockfile');
    for (const testFile of [
      '__tests__/tauriDesktopPlatform.test.ts',
      '__tests__/tauriWebBundles.test.ts',
      '__tests__/tauriPackageScripts.test.ts',
      '__tests__/tauriDesktopTabs.test.ts',
    ]) {
      expect(desktopWebJob).toContain(testFile);
    }
    expect(desktopWebJob).toContain('pnpm --dir native/desktop/psyche-build-tauri build:web');
    expect(workflow.match(/pnpm --dir native\/desktop\/psyche-build-tauri build:web/g))
      .toHaveLength(1);

    expect(rustTestJob).toContain('name: Rust tests');
    expect(rustTestJob).toContain('needs: changes');
    expect(rustTestJob).toContain("if: needs.changes.outputs.desktop == 'true'");
    expect(rustTestJob).toContain('runs-on: macos-15');
    expect(rustTestJob).toContain('timeout-minutes: 45');
    expect(rustTestJob).toContain('cargo fmt --manifest-path "$MANIFEST" --check');
    expect(rustTestJob).toContain('cargo test --manifest-path "$MANIFEST" --locked');
    expect(workflow.match(/cargo fmt --manifest-path/g)).toHaveLength(1);

    expect(desktopCheckJob).toContain('name: Desktop check (${{ matrix.os }})');
    expect(desktopCheckJob).toContain('needs: changes');
    expect(desktopCheckJob).toContain("if: needs.changes.outputs.desktop == 'true'");
    expect(desktopCheckJob).toContain('timeout-minutes: 45');
    expect(desktopCheckJob).toContain('fail-fast: false');
    for (const os of ['macos-15', 'windows-2025', 'ubuntu-24.04']) {
      expect(desktopCheckJob).toContain(os);
    }
    expect(desktopCheckJob).toContain('timeout-minutes: 10');
    expect(desktopCheckJob).toContain('DEBIAN_FRONTEND: noninteractive');
    expect(desktopCheckJob).toContain('Acquire::Retries=3');
    expect(desktopCheckJob).toContain('Acquire::http::Timeout=30');
    expect(desktopCheckJob).toContain(
      'cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked',
    );
    expect(desktopCheckJob).toContain("if: github.event_name == 'push'");
    expect(desktopCheckJob).toContain(
      'cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked',
    );
    expect(desktopCheckJob).not.toContain('pnpm install');
    expect(desktopCheckJob).not.toContain('pnpm vitest');
    expect(desktopCheckJob).not.toContain('build:web');

    expect(requiredTypeScriptJob).toContain('name: TypeScript and Rust');
    expect(requiredTypeScriptJob).toContain('if: always()');
    expect(requiredTypeScriptJob).toContain(
      'needs: [changes, quality, desktop-web, rust-test, desktop-check]',
    );
    expect(requiredTypeScriptJob).toContain('runs-on: ubuntu-24.04');
    expect(requiredTypeScriptJob).toContain('timeout-minutes: 5');
    for (const variable of [
      'CHANGES_RESULT',
      'DESKTOP_REQUIRED',
      'QUALITY_RESULT',
      'DESKTOP_WEB_RESULT',
      'RUST_TEST_RESULT',
      'DESKTOP_CHECK_RESULT',
    ]) {
      expect(requiredTypeScriptJob).toContain(variable);
    }
    expect(requiredTypeScriptJob).toContain('test "$CHANGES_RESULT" = success');
    expect(requiredTypeScriptJob).toContain('test "$QUALITY_RESULT" = success');
    expect(requiredTypeScriptJob).toContain('test "$DESKTOP_WEB_RESULT" = success');
    expect(requiredTypeScriptJob).toContain('test "$RUST_TEST_RESULT" = success');
    expect(requiredTypeScriptJob).toContain('test "$DESKTOP_CHECK_RESULT" = success');
    expect(requiredTypeScriptJob).toContain('test "$DESKTOP_WEB_RESULT" = skipped');
    expect(requiredTypeScriptJob).toContain('test "$RUST_TEST_RESULT" = skipped');
    expect(requiredTypeScriptJob).toContain('test "$DESKTOP_CHECK_RESULT" = skipped');

    expect(iosCoreJob).toContain('name: iOS Core');
    expect(iosCoreJob).toContain('needs: changes');
    expect(iosCoreJob).toContain("if: needs.changes.outputs.ios == 'true'");
    expect(iosCoreJob).toContain('runs-on: macos-15');
    expect(iosCoreJob).toContain('timeout-minutes: 50');
    expect(iosCoreJob).toContain('pnpm install --frozen-lockfile');
    expect(iosCoreJob).toContain('pnpm ios:project:check');
    expect(iosCoreJob).toContain('-scheme PsycheCore');
    expect(iosCoreJob).toContain("if: github.event_name == 'push'");
    expect(iosCoreJob).toContain('-scheme PsycheApp');

    expect(requiredIosJob).toContain('name: iOS');
    expect(requiredIosJob).toContain('if: always()');
    expect(requiredIosJob).toContain('needs: [changes, ios-core]');
    expect(requiredIosJob).toContain('runs-on: ubuntu-24.04');
    expect(requiredIosJob).toContain('timeout-minutes: 5');
    for (const variable of ['CHANGES_RESULT', 'IOS_REQUIRED', 'IOS_RESULT']) {
      expect(requiredIosJob).toContain(variable);
    }
    expect(requiredIosJob).toContain('test "$CHANGES_RESULT" = success');
    expect(requiredIosJob).toContain('test "$IOS_RESULT" = success');
    expect(requiredIosJob).toContain('test "$IOS_RESULT" = skipped');
    expect(workflow).not.toContain('secrets.');
  });

  it('pins the Apple toolchain and keeps push-only app and UI coverage separate from PsycheCore', () => {
    const workflow = workflowSource();
    const iosCoreJob = workflowJobSource(workflow, 'ios-core');
    const destination = 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro';

    expect(iosCoreJob).toContain('DEVELOPER_DIR: /Applications/Xcode_26.2.app/Contents/Developer');
    expect(iosCoreJob).toContain("grep -Fx 'Xcode 26.2'");
    expect(iosCoreJob).toContain("grep -Fx 'Build version 17C52'");
    expect(iosCoreJob).toContain('uses: ./.github/actions/setup-xcodegen');
    expect(iosCoreJob).not.toContain('XCODEGEN_VERSION=');
    expect(iosCoreJob).not.toContain('XCODEGEN_SHA256=');
    expect(iosCoreJob).toContain('xcrun simctl list devices available');
    expect(iosCoreJob).toContain('iPhone 16 Pro');
    expect(iosCoreJob).toContain('com.apple.CoreSimulator.SimRuntime.iOS-26-2');
    expect(iosCoreJob).toContain('Test iOS Core');
    expect(iosCoreJob).toContain('Build and test the iOS app');
    expect(workflow.match(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(3);
  });
});
