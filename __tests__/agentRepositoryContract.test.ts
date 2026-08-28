import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const agents = read('AGENTS.md');
const manifest = read('agent/manifest.yaml');
const bootstrap = read('scripts/agent-bootstrap');
const check = read('scripts/agent-check');
const packageJson = JSON.parse(read('package.json')) as {
  packageManager: string;
  engines: { node: string };
  scripts: { smoke: string };
};

describe('agent repository contract', () => {
  it('routes agents to every current canonical document', () => {
    const requiredDocuments = [
      'docs/POST-RELEASE-EXECUTION.md',
      'docs/ROADMAP.md',
      'docs/SUPPORT-MATRIX.md',
      'docs/CONTROL-PLANE.md',
      'docs/AGENT-SURFACE-CONTROL.md',
      'docs/BRIDGE-SECURITY.md',
      'docs/RELEASE-ACCEPTANCE.md',
      'CONTRIBUTING.md',
      '.beads/README.md',
    ];

    for (const path of requiredDocuments) {
      expect(agents, `AGENTS.md should route to ${path}`).toContain(path);
      expect(manifest, `agent/manifest.yaml should declare ${path}`).toContain(path);
    }
  });

  it('keeps Psyche Build a product client instead of a second protocol authority', () => {
    expect(agents).toMatch(/Psyche Build is OpenCoven's coding cockpit and product client/i);
    expect(agents).toMatch(/does \*\*not\*\* own the durable OpenCoven identity or orchestration protocol/i);
    expect(agents).toMatch(/must not direct-read Psyche's database/i);
    expect(agents).toMatch(/do not claim Psyche protocol conformance/i);
    expect(agents).toContain('/issues/253');

    expect(manifest).toContain('class: product-client');
    expect(manifest).toContain('target: OpenCoven/psyche');
    expect(manifest).toContain('conformance_claim: false');
    expect(manifest).toContain('runtime_identity: false');
  });

  it('derives the Node and pnpm contract from package.json', () => {
    const pnpmPin = packageJson.packageManager.replace(/^pnpm@/, '');
    expect(pnpmPin).not.toBe(packageJson.packageManager);
    expect(packageJson.engines.node).toMatch(/^>=\d+\.\d+/);

    expect(manifest).toContain(`node: "${packageJson.engines.node}"`);
    expect(manifest).toContain(`pnpm: "${pnpmPin}"`);
    expect(bootstrap).toContain('p.packageManager');
    expect(bootstrap).toContain('p.engines?.node');
    expect(check).toContain('p.packageManager');
    expect(bootstrap).toContain('pnpm install --frozen-lockfile');
  });

  it('keeps the shell entrypoints syntactically valid and deterministic', () => {
    for (const path of ['scripts/agent-bootstrap', 'scripts/agent-check']) {
      const result = spawnSync('bash', ['-n', resolve(root, path)], {
        encoding: 'utf8',
      });
      expect(result.status, `${path}: ${result.stderr}`).toBe(0);
    }

    expect(bootstrap).toContain('git diff --check');
    expect(bootstrap).toContain('git status --porcelain=v1 --untracked-files=all');
    expect(check).toContain('git diff --check');
    expect(check).toContain('git status --porcelain=v1 --untracked-files=all');
  });

  it('defines differentiated fast, full, and explicit iOS gates', () => {
    expect(check).toContain('fast|full');
    expect(check).toContain('pnpm typecheck');
    expect(check).toContain('__tests__/agentRepositoryContract.test.ts');

    for (const command of [
      'pnpm test',
      'pnpm docs:focus:check',
      'pnpm --dir docs build',
      'pnpm smoke',
      'pnpm smoke:pack',
      'cargo fmt',
      'cargo test',
      'cargo check',
    ]) {
      expect(check, `full gate should include ${command}`).toContain(command);
    }

    expect(packageJson.scripts.smoke).toContain('pnpm run build');
    expect(check).toContain('PSYCHE_AGENT_CHECK_IOS');
    expect(check).toContain('Skipping iOS simulator checks: not asserted');
    expect(check).toContain('Physical-device, signing, TestFlight, and distribution claims remain unasserted');
    expect(manifest).toContain('Xcode 26.2 build 17C52');
  });

  it('names generated outputs and their canonical generators', () => {
    const generatedContracts = [
      ['src/utils/generated-agents-doc.ts', 'pnpm generate:hooks-docs'],
      ['native/desktop/psyche-build-tauri/web/*.bundle.js', 'pnpm --dir native/desktop/psyche-build-tauri build:web'],
      ['native/ios/Psyche.xcodeproj/**', 'pnpm ios:project:generate'],
      ['dist/**', 'pnpm build'],
    ];

    for (const [path, generator] of generatedContracts) {
      expect(agents).toContain(path);
      expect(agents).toContain(generator);
      expect(manifest).toContain(path);
      expect(manifest).toContain(generator);
    }
  });
});
