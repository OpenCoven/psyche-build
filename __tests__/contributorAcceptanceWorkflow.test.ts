import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(
  resolve(root, '.github/workflows/contributor-acceptance.yml'),
  'utf8',
);

describe('clean contributor acceptance workflow', () => {
  it('runs without repository write authority or persisted checkout credentials', () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/u);
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).not.toMatch(/secrets\./u);
    expect(workflow).not.toMatch(/contents:\s*write/u);
  });

  it('uses the repository-owned bootstrap and complete handoff gate', () => {
    expect(workflow).toContain('runs-on: macos-15');
    expect(workflow).toContain('brew install tmux');
    expect(workflow).toContain('toolchain: 1.91.0');
    expect(workflow).toContain('bash scripts/agent-bootstrap');
    expect(workflow).toContain('bash scripts/agent-check full');
    expect(workflow).toContain('PSYCHE_AGENT_CHECK_IOS: "0"');
    expect(workflow).toContain('__tests__/agentRepositoryContract.test.ts');
    expect(workflow).toContain('__tests__/repositoryMapContract.test.ts');
    expect(workflow).toContain('__tests__/communityHealthContract.test.ts');
    expect(workflow).toContain('__tests__/contributorAcceptanceWorkflow.test.ts');
  });

  it('inherits generated-output, smoke, packaging, and Rust proof from the full gate', () => {
    const agentCheck = readFileSync(resolve(root, 'scripts/agent-check'), 'utf8');
    for (const command of [
      'pnpm test',
      'pnpm docs:focus:check',
      'pnpm --dir docs build',
      'pnpm smoke',
      'pnpm smoke:pack',
      'pnpm --dir native/desktop/psyche-build-tauri build:web',
      'cargo test',
      'cargo check',
    ]) {
      expect(agentCheck).toContain(command);
    }
  });

  it('keeps iOS acceptance explicitly opt-in instead of treating an unrun check as success', () => {
    expect(workflow).toContain("grep -F 'pnpm ios:project:check' docs/REPOSITORY-MAP.md");
    expect(workflow).toContain("grep -F 'compatible macOS host' AGENTS.md");
    expect(workflow).not.toMatch(/xcodebuild/u);
  });

  it('fails if acceptance leaves generated or untracked drift', () => {
    expect(workflow).toContain('git diff --check');
    expect(workflow).toContain('git status --porcelain=v1 --untracked-files=all');
  });
});
