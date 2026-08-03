import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowPath = path.resolve('.github/workflows/release.yml');
const rustToolchainPath = path.resolve('rust-toolchain.toml');

function workflowSource(): string {
  return readFileSync(workflowPath, 'utf8');
}

describe('macOS release workflow contract', () => {
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
    expect(workflow.match(/^\s*environment: release\s*$/gm)).toHaveLength(3);
    expect(workflow).toContain('security import "$CERTIFICATE_PATH"');
    expect(workflow).toContain('codesign --verify --deep --strict');
    expect(workflow).toContain('spctl --assess --type execute');
    expect(workflow).toContain('xcrun stapler validate');
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
  });

  it('publishes only the complete architecture set plus checksums', () => {
    const workflow = workflowSource();

    expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-${ARCH}.dmg');
    expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-aarch64.dmg');
    expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-x86_64.dmg');
    expect(workflow).toContain('SHA256SUMS');
    expect(workflow).toContain('gh release create "$RELEASE_TAG"');
    expect(workflow).toContain('gh release download "$RELEASE_TAG"');
    expect(workflow).toContain('Published release assets match the verified build output');
    expect(workflow).toContain('notify-homebrew:');
    expect(workflow).toContain('needs: publish');
    expect(workflow).toContain('event_type: "psyche-build-release"');
    expect(workflow).toContain('secrets.HOMEBREW_TAP_TOKEN');
  });

  it('pins every third-party action to an immutable commit', () => {
    const workflow = workflowSource();
    const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
      ([, action]) => action,
    );

    expect(actionUses.length).toBeGreaterThan(0);
    for (const action of actionUses) {
      expect(action, `${action} must be commit-pinned`).toMatch(/@[0-9a-f]{40}$/);
    }
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
