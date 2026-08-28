import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string): Promise<string> => readFile(path, 'utf8');

describe('agent repository contract', () => {
  it('keeps the root guide concise and routes canonical ownership correctly', async () => {
    const guide = await read('AGENTS.md');
    const lines = guide.trimEnd().split('\n');

    expect(lines.length).toBeGreaterThanOrEqual(80);
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(guide).toContain('Psyche Build owns the local coding cockpit');
    expect(guide).toContain('`psyche` owns canonical task, lane, lease, approval, receipt, and recovery');
    expect(guide).toContain('`coven` owns daemon authority');
    expect(guide).toContain('`familiar-contract` owns portable familiar identity');
    expect(guide).toContain('`coven-threads` owns protected-surface authorization');
    expect(guide).toContain('issues/253');
    expect(guide).toMatch(/not Psyche protocol conformance/i);
    expect(guide).toContain('GitHub issues and milestones own public outcomes');
    expect(guide).toContain('Beads owns managed implementation tasks');
    expect(guide).toContain('Neither tracker grants runtime identity or authority');
    expect(guide).toContain('./scripts/agent-check fast');
    expect(guide).toContain('./scripts/agent-check full');
    expect(guide).toContain('PSYCHE_AGENT_CHECK_IOS=1');
  });

  it('publishes the machine-readable role, risk, and verification contract', async () => {
    const manifest = await read('agent/manifest.yaml');

    expect(manifest).toContain('schema_version: opencoven.agent-repo/v1');
    expect(manifest).toContain('role: product-coding-cockpit');
    expect(manifest).toContain('lifecycle: active');
    expect(manifest).toContain('class: R4');
    expect(manifest).toContain('bootstrap: ./scripts/agent-bootstrap');
    expect(manifest).toContain('fast: ./scripts/agent-check fast');
    expect(manifest).toContain('full: ./scripts/agent-check full');
    expect(manifest).toContain('node: package.json#engines.node');
    expect(manifest).toContain('pnpm: package.json#packageManager');
    expect(manifest).not.toContain('10.34.5');
    expect(manifest).not.toContain('20.10.0');
    expect(manifest).toContain('authority: github-issues-and-milestones');
    expect(manifest).toContain('authority: beads');
    expect(manifest).toContain('direction: one-way-sanitized');
    expect(manifest).toContain('runtime_identity: neither-tracker');
    expect(manifest).toContain('status: not-yet-conformant');
    expect(manifest).toContain('issues/253');
    expect(manifest).toContain('psyche: prohibited-until-planned-canary-passes');

    for (const boundary of [
      'familiar-identity',
      'protected-surface-authorization',
      'psyche-orchestration-protocol',
      'coven-daemon-authority',
      'runtime-persistence',
    ]) {
      expect(manifest).toContain(`- ${boundary}`);
    }
  });

  it('pins bootstrap to package metadata and leaves the checkout unchanged', async () => {
    const [bootstrap, packageText] = await Promise.all([
      read('scripts/agent-bootstrap'),
      read('package.json'),
    ]);
    const packageJson = JSON.parse(packageText) as {
      packageManager: string;
      engines: { node: string };
    };

    expect(packageJson.packageManager).toBe('pnpm@10.34.5');
    expect(packageJson.engines.node).toBe('>=20.10.0');
    expect(bootstrap).toContain("require('./package.json').packageManager");
    expect(bootstrap).toContain("require('./package.json').engines.node");
    expect(bootstrap).toContain('pnpm install --frozen-lockfile');
    expect(bootstrap).toContain('git status --porcelain=v1 --untracked-files=all');
    expect(bootstrap).toContain('cmp -s "$before" "$after"');
    expect(bootstrap).not.toContain('--no-frozen-lockfile');
  });

  it('defines bounded fast/full checks and makes iOS an explicit opt-in gate', async () => {
    const check = await read('scripts/agent-check');

    for (const command of [
      'pnpm typecheck',
      'pnpm test',
      'pnpm docs:focus:check',
      'pnpm --dir docs build',
      'pnpm build',
      'pnpm smoke',
      'pnpm smoke:pack',
      'cargo fmt',
      'cargo test',
      'cargo check',
    ]) {
      expect(check).toContain(command);
    }

    expect(check).toContain('PSYCHE_AGENT_CHECK_IOS');
    expect(check).toContain('requires macOS; iOS was not validated');
    expect(check).toContain('This explicit platform skip is not iOS validation evidence.');
    expect(check).toContain('git status --porcelain=v1 --untracked-files=all');
  });

  it('keeps the repository entrypoint scripts executable and syntactically valid', async () => {
    for (const path of ['scripts/agent-bootstrap', 'scripts/agent-check']) {
      const metadata = await stat(path);
      expect(metadata.mode & 0o111, `${path} must be executable`).not.toBe(0);
      expect(() => execFileSync('bash', ['-n', path])).not.toThrow();
    }
  });

  it('routes protected and generated paths without hand-edit permission', async () => {
    const [guide, manifest] = await Promise.all([
      read('AGENTS.md'),
      read('agent/manifest.yaml'),
    ]);

    for (const path of [
      'src/control/**',
      'src/services/bridge/**',
      'native/desktop/psyche-build-tauri/src-tauri/**',
      'native/ios/**',
      '.github/workflows/release.yml',
      '.beads/**',
    ]) {
      expect(guide).toContain(path);
      expect(manifest).toContain(path);
    }

    for (const generatedPath of [
      'src/utils/generated-agents-doc.ts',
      'protocol-fixtures/**',
      'native/ios/Psyche.xcodeproj/**',
      'native/desktop/psyche-build-tauri/web/*.bundle.js',
    ]) {
      expect(guide).toContain(generatedPath);
      expect(manifest).toContain(generatedPath);
    }
  });
});
