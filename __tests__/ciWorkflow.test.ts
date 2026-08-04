import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github/workflows/ci.yml');

function workflowSource(): string {
  try {
    return readFileSync(workflowPath, 'utf8');
  } catch {
    return '';
  }
}

function actionStepBlocks(workflow: string, action: string): string[] {
  const lines = workflow.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = `- uses: ${action}@`;
    if (!line.trimStart().startsWith(marker)) continue;
    const indentation = line.length - line.trimStart().length;
    const block = [line];
    for (index += 1; index < lines.length; index += 1) {
      const nextLine = lines[index];
      if (nextLine.trim() && nextLine.length - nextLine.trimStart().length <= indentation) break;
      block.push(nextLine);
    }
    index -= 1;
    blocks.push(block.join('\n'));
  }
  return blocks;
}

function workflowJobSource(workflow: string, jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Unable to find workflow job ${jobName}`);
  const remaining = workflow.slice(start + marker.length);
  const nextJob = remaining.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return nextJob < 0 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextJob);
}

describe('pull request CI workflow contract', () => {
  it('runs read-only checks for pull requests and pushes to main with stable job names', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('name: CI');
    expect(workflow).toMatch(/pull_request:\s*\n/);
    expect(workflow).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');
    expect(workflow).toContain('name: TypeScript and Rust');
    expect(workflow).toContain('name: iOS');
    expect(workflow.match(/^\s{4}timeout-minutes: 60$/gm)).toHaveLength(2);
  });

  it('pins Node, pnpm, Rust, and every third-party action', () => {
    const workflow = workflowSource();
    const checkoutSteps = actionStepBlocks(workflow, 'actions/checkout');

    expect(workflow).toContain('node-version: 24');
    expect(workflow).toContain('version: 10.14.0');
    expect(workflow).toContain('toolchain: 1.95.0');
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1');
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow).toContain('dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8');
    expect(checkoutSteps).toHaveLength(2);
    for (const jobName of ['typescript-rust', 'ios']) {
      const job = workflowJobSource(workflow, jobName);
      const jobCheckoutSteps = actionStepBlocks(job, 'actions/checkout');
      const jobPnpmSetupSteps = actionStepBlocks(job, 'pnpm/action-setup');
      const jobSetupNodeSteps = actionStepBlocks(job, 'actions/setup-node');

      expect(jobCheckoutSteps).toHaveLength(1);
      expect(jobCheckoutSteps[0]).toMatch(/^\s+persist-credentials: false$/m);
      expect(jobPnpmSetupSteps).toHaveLength(1);
      expect(jobPnpmSetupSteps[0]).toContain(
        'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0',
      );
      expect(jobSetupNodeSteps).toHaveLength(1);
      expect(jobSetupNodeSteps[0]).toMatch(/^\s+cache: pnpm$/m);
    }

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

  it('runs the complete non-secret TypeScript, package, Rust, and frontend gates', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('runs-on: macos-15');
    expect(workflow).toContain('- name: Install tmux');
    expect(workflow).toContain('brew install tmux');
    expect(workflow.indexOf('brew install tmux')).toBeLessThan(workflow.indexOf('pnpm test'));
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    for (const command of [
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
      'pnpm smoke:pack',
      'cargo fmt --manifest-path "$MANIFEST" --check',
      'cargo test --manifest-path "$MANIFEST" --locked',
      'cargo check --manifest-path "$MANIFEST" --locked',
      'pnpm --dir native/macos/psyche-build-tauri build:web',
    ]) {
      expect(workflow).toContain(command);
    }
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
