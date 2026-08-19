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
  it('runs read-only checks for pull requests and pushes to main with stable job names', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('name: CI');
    expect(workflow).toMatch(/pull_request:\s*\n/);
    expect(workflow).toMatch(
      /push:\s*\n\s+branches: \[main, feat\/gpu-accelerated-ade\]/,
    );
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('name: TypeScript and Rust');
    expect(workflow).toContain('name: iOS');
    expect(workflow.match(/^\s{4}timeout-minutes: 60$/gm)).toHaveLength(3);
  });

  it('gives the desktop runtime matrix the same 60 minute timeout contract as adjacent jobs', () => {
    const workflow = workflowSource();
    const job = workflowJobSource(workflow, 'desktop-runtime');

    expect(job).toContain('timeout-minutes: 60');
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

  it('defines the tiered workflow topology and job contracts', () => {
    const workflow = workflowSource();

    for (const job of [
      'changes',
      'quality',
      'desktop-web',
      'rust-test',
      'desktop-check',
      'typescript-rust',
      'ios-core',
      'ios',
    ]) {
      expect(workflow).toContain(`  ${job}:`);
    }

    const changes = workflowJobSource(workflow, 'changes');
    const quality = workflowJobSource(workflow, 'quality');
    const desktopWeb = workflowJobSource(workflow, 'desktop-web');
    const rustTest = workflowJobSource(workflow, 'rust-test');
    const desktopCheck = workflowJobSource(workflow, 'desktop-check');
    const typescriptRust = workflowJobSource(workflow, 'typescript-rust');
    const iosCore = workflowJobSource(workflow, 'ios-core');
    const ios = workflowJobSource(workflow, 'ios');

    expect(changes).toContain('classifier');
    expect(quality).not.toContain('needs: changes');
    for (const job of [desktopWeb, rustTest, desktopCheck, typescriptRust, iosCore, ios]) {
      expect(job).toContain('needs: changes');
    }
    expect(desktopWeb.match(/build:web/g) ?? []).toHaveLength(1);
    expect(rustTest.match(/cargo fmt/g) ?? []).toHaveLength(1);
    expect(rustTest).toContain('cargo test');
    expect(desktopCheck).toContain('cargo check');
    expect(desktopCheck).not.toContain('pnpm vitest');
    expect(desktopCheck).not.toContain('build:web');
    expect(workflow).toContain('smoke:pack');
    expect(workflow).toContain('PsycheApp');
    expect(workflow).toContain('cargo test');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('CHANGES_RESULT');
    expect(workflow).toContain('Acquire::Retries=3');
    expect(workflow).toContain('DEBIAN_FRONTEND=noninteractive');
    expect(workflow).toContain('timeout-minutes: 10');
  });

  it('runs the complete non-secret TypeScript, package, Rust, and frontend gates', () => {
    const workflow = workflowSource();
    const typescriptJob = workflowJobSource(workflow, 'typescript-rust');

    expect(workflow).toContain('runs-on: macos-15');
    expect(workflow).toContain('- name: Install tmux');
    expect(workflow).toContain('brew install tmux');
    expect(workflow.indexOf('brew install tmux')).toBeLessThan(workflow.indexOf('pnpm test'));
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    for (const command of [
      'pnpm docs:focus:check',
      'pnpm --dir docs build',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
      'pnpm smoke:pack',
      'cargo fmt --manifest-path "$MANIFEST" --check',
      'cargo test --manifest-path "$MANIFEST" --locked',
      'cargo check --manifest-path "$MANIFEST" --locked',
      'pnpm --dir native/desktop/psyche-build-tauri build:web',
    ]) {
      expect(workflow).toContain(command);
    }
    expect(typescriptJob.match(/pnpm --dir docs build/g)).toHaveLength(1);
    expect(typescriptJob.indexOf('pnpm docs:focus:check')).toBeLessThan(
      typescriptJob.indexOf('pnpm --dir docs build'),
    );
    expect(typescriptJob.indexOf('pnpm --dir docs build')).toBeLessThan(
      typescriptJob.indexOf('pnpm build'),
    );
    expect(workflow).not.toContain('secrets.');
  });

  it('pins the Apple toolchain and runs deterministic iOS build and test gates', () => {
    const workflow = workflowSource();
    const destination = 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro';

    expect(workflow).toContain('DEVELOPER_DIR: /Applications/Xcode_26.2.app/Contents/Developer');
    expect(workflow).toContain("grep -Fx 'Xcode 26.2'");
    expect(workflow).toContain("grep -Fx 'Build version 17C52'");
    expect(workflow).toContain('uses: ./.github/actions/setup-xcodegen');
    expect(workflow).not.toContain('XCODEGEN_VERSION=');
    expect(workflow).not.toContain('XCODEGEN_SHA256=');
    expect(workflow).toContain('xcrun simctl list devices available');
    expect(workflow).toContain('iPhone 16 Pro');
    expect(workflow).toContain('com.apple.CoreSimulator.SimRuntime.iOS-26-2');
    expect(workflow).toContain('pnpm ios:project:check');
    expect(workflow).toContain('-scheme PsycheCore');
    expect(workflow).toContain('-scheme PsycheApp');
    expect(workflow.match(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(3);
    expect(workflow).toContain('test');
    expect(workflow).toContain('build');
  });
});
