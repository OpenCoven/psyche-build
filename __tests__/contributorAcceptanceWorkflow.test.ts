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

  it('uses the repository-owned bootstrap and handoff gates', () => {
    expect(workflow).toContain('bash scripts/agent-bootstrap');
    expect(workflow).toContain('bash scripts/agent-check fast');
    expect(workflow).toContain('__tests__/agentRepositoryContract.test.ts');
    expect(workflow).toContain('__tests__/repositoryMapContract.test.ts');
    expect(workflow).toContain('__tests__/communityHealthContract.test.ts');
  });

  it('proves desktop generated output and Rust from a clean checkout', () => {
    expect(workflow).toContain('pnpm --dir native/desktop/psyche-build-tauri build:web');
    expect(workflow).toContain('git diff --exit-code -- native/desktop/psyche-build-tauri/web');
    expect(workflow).toContain('cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml');
  });

  it('keeps iOS acceptance explicitly platform-gated instead of pretending Linux proves it', () => {
    expect(workflow).toContain("grep -F 'pnpm ios:project:check' docs/REPOSITORY-MAP.md");
    expect(workflow).toContain("grep -F 'compatible macOS host' AGENTS.md");
    expect(workflow).not.toMatch(/xcodebuild/u);
  });

  it('fails if acceptance leaves generated or untracked drift', () => {
    expect(workflow).toContain('git diff --check');
    expect(workflow).toContain('git status --porcelain=v1 --untracked-files=all');
  });
});
