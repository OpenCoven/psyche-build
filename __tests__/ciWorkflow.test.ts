import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github/workflows/ci.yml');
const releaseWorkflowPath = path.resolve('.github/workflows/release.yml');
const beadsProjectSyncWorkflowPath = path.resolve(
  '.github/workflows/beads-project-sync.yml',
);
const beadsReadmePath = path.resolve('.beads/README.md');
const contributingPath = path.resolve('CONTRIBUTING.md');
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
    expect(workflow.match(/^\s{4}timeout-minutes: 60$/gm)).toHaveLength(2);
  });

  it('bounds the split desktop check matrix independently', () => {
    const workflow = workflowSource();
    const job = workflowJobSource(workflow, 'desktop-check');

    expect(job).toContain('timeout-minutes: 45');
  });

  it('pins Node, pnpm, Rust, and every third-party action', () => {
    const workflow = workflowSource();
    const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8');
    const beadsProjectSyncWorkflow = readFileSync(
      beadsProjectSyncWorkflowPath,
      'utf8',
    );
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      packageManager?: string;
    };
    const checkoutCount = workflow.match(/uses: actions\/checkout@/g)?.length ?? 0;

    expect(workflow).toContain('node-version: 24');
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    for (const source of [workflow, releaseWorkflow, beadsProjectSyncWorkflow]) {
      expect(source).not.toMatch(/pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version:/);
    }
    expect(workflow).toContain('toolchain: 1.95.0');
    expect(workflow).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflow).toContain('pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1');
    expect(workflow).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
    expect(workflow).toContain('dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8');
    expect(checkoutCount).toBeGreaterThan(0);
    expect(workflow.match(/persist-credentials: false/g) ?? []).toHaveLength(checkoutCount);

    const actionUses = [workflow, releaseWorkflow, beadsProjectSyncWorkflow].flatMap(
      (source) =>
        [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
          ([, action]) => action,
        ),
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
      'ios-app',
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
    const iosApp = workflowJobSource(workflow, 'ios-app');
    const ios = workflowJobSource(workflow, 'ios');

    expect(changes).toContain('classifier');
    expect(quality).not.toContain('needs: changes');
    for (const job of [desktopWeb, rustTest, desktopCheck, iosCore, iosApp]) {
      expect(job).toContain('needs: changes');
    }
    for (const job of [desktopWeb, rustTest, desktopCheck]) {
      expect(job).toContain(
        "if: needs.changes.result == 'success' && needs.changes.outputs.desktop == 'true'",
      );
    }
    for (const job of [iosCore, iosApp]) {
      expect(job).toContain(
        "if: needs.changes.result == 'success' && needs.changes.outputs.ios == 'true'",
      );
    }
    expect(typescriptRust).toContain(
      'needs: [changes, quality, desktop-web, rust-test, desktop-check]',
    );
    expect(typescriptRust).toContain('QUALITY_RESULT');
    expect(typescriptRust).toContain('DESKTOP_WEB_RESULT');
    expect(typescriptRust).toContain('RUST_TEST_RESULT');
    expect(typescriptRust).toContain('DESKTOP_CHECK_RESULT');
    expect(typescriptRust).toContain('success|skipped');
    expect(ios).toContain('needs: [changes, ios-core, ios-app]');
    expect(ios).toContain('IOS_CORE_RESULT');
    expect(ios).toContain('IOS_APP_RESULT');
    expect(ios).toContain('success|skipped');
    expect(ios).toContain('runs-on: ubuntu-24.04');
    expect(workflow).not.toContain('  desktop-runtime:');
    expect(desktopWeb.match(/build:web/g) ?? []).toHaveLength(1);
    expect(rustTest.match(/cargo fmt/g) ?? []).toHaveLength(1);
    expect(rustTest).toContain('cargo test');
    expect(desktopCheck).toContain('cargo check');
    expect(desktopCheck).not.toContain('pnpm vitest');
    expect(desktopCheck).not.toContain('build:web');
    expect(desktopCheck).toContain('shell: bash');
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

describe('Beads Project sync workflow contract', () => {
  function beadsWorkflowSource(): string {
    return readFileSync(beadsProjectSyncWorkflowPath, 'utf8');
  }

  it('schedules serialized applies and exposes guarded manual controls', () => {
    const workflow = beadsWorkflowSource();

    expect(workflow).toContain('name: Beads Project Sync');
    expect(workflow).toContain('- cron: "17 3 * * *"');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(
      /dry_run:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/,
    );
    expect(workflow).toMatch(
      /allow_mass_close:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/,
    );
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('group: beads-project-sync');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('args=(--apply)');
    expect(workflow).toContain('args=(--dry-run)');
    expect(workflow).toContain('args+=(--allow-mass-close)');
    expect(workflow).toContain('"${args[@]}"');
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.dry_run",
    );
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.allow_mass_close",
    );
  });

  it('uses pinned setup and a checksum-verified Beads 1.2.2 binary', () => {
    const workflow = beadsWorkflowSource();

    expect(workflow).toContain(
      'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
    );
    expect(workflow).toContain(
      'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
    );
    expect(workflow).toContain(
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    );
    expect(workflow).toContain('node-version: 24');
    expect(workflow).toContain('version="1.2.2"');
    expect(workflow).toContain(
      'checksum="8140098a51d3b81d5548d1c5e6db1a2d9930e5d141efe2a4bff7d079c4d321e8"',
    );
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/u);
    expect(workflow).toContain('pnpm install --frozen-lockfile');
  });

  it('initializes failure artifacts before checkout and finalizes the failed phase', () => {
    const workflow = beadsWorkflowSource();
    const initializeArtifacts = workflow.indexOf('- name: Initialize sync artifacts');
    const checkout = workflow.indexOf('- name: Checkout repository');

    expect(initializeArtifacts).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeGreaterThan(initializeArtifacts);
    expect(workflow).toContain('"phase":"checkout"');
    expect(workflow).toContain('"outcome":"pending"');
    expect(workflow).toContain('- name: Finalize sync artifacts');
    expect(workflow).toContain('CHECKOUT_OUTCOME: ${{ steps.checkout.outcome }}');
    expect(workflow).toContain('DEPENDENCIES_OUTCOME: ${{ steps.dependencies.outcome }}');
    expect(workflow).toContain('SYNC_OUTCOME: ${{ steps.sync_beads.outcome }}');
    expect(workflow).toContain("summary['phase'] = phase");
    expect(workflow).toContain("summary['outcome'] = outcome");
    expect(workflow).toContain("summary['stepOutcomes'] = step_outcomes");
  });

  it('normalizes cancellation during sync to cancelled status and outcome', () => {
    const workflow = beadsWorkflowSource();

    expect(workflow).toMatch(
      /if outcome == 'cancelled':\n\s+summary\['status'\] = 'cancelled'\n\s+summary\['outcome'\] = 'cancelled'/,
    );
  });

  it('requires the documented one-time provisioning bootstrap before merge or enablement', () => {
    const workflow = beadsWorkflowSource();
    const beadsReadme = readFileSync(beadsReadmePath, 'utf8');
    const contributing = readFileSync(contributingPath, 'utf8');

    expect(workflow).not.toContain('--provision');
    expect(beadsReadme).toContain(
      'node scripts/sync-beads-project.mjs --apply --provision',
    );
    expect(beadsReadme).toMatch(/must not be merged or enabled until.*bootstrap.*succeeds/is);
    expect(contributing).toMatch(
      /merge and schedule\s+enablement are blocked until.*bootstrap.*succeeds/is,
    );
  });

  it('scopes the token to sync and always uploads sanitized JSON diagnostics', () => {
    const workflow = beadsWorkflowSource();

    expect(workflow.match(/^\s+BEADS_PROJECT_TOKEN:/gm) ?? []).toHaveLength(1);
    expect(workflow.match(/secrets\.BEADS_PROJECT_TOKEN/g) ?? []).toHaveLength(1);
    expect(workflow).toContain('Sync command did not emit a valid JSON summary');
    expect(workflow).toContain("JSON.parse(rawSummary)");
    expect(workflow).toContain("split(token).join('<redacted>')");
    expect(workflow).toContain('summary.json');
    expect(workflow).toContain('diagnostics.log');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(workflow).toContain('if-no-files-found: warn');
    expect(workflow).not.toContain('if-no-files-found: error');
  });
});
