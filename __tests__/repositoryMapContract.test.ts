import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const map = read('docs/REPOSITORY-MAP.md');

describe('contributor repository map', () => {
  it('routes contributors to the current authority contracts', () => {
    for (const document of [
      'AGENTS.md',
      'CONTRIBUTING.md',
      'CONTROL-PLANE.md',
      'AGENT-SURFACE-CONTROL.md',
      'BRIDGE-SECURITY.md',
      'PSYCHE-COMPATIBILITY-MAP.md',
      'TRACKER-INTEGRITY.md',
      'SUPPORT-MATRIX.md',
      'RELEASE-ACCEPTANCE.md',
    ]) {
      expect(map, `repository map should route to ${document}`).toContain(document);
    }
  });

  it('names the major implementation and governance surfaces', () => {
    for (const path of [
      'src/control/',
      'src/daemon/',
      'src/services/bridge/',
      'native/desktop/',
      'native/ios/',
      'native/macos/',
      'protocol-fixtures/',
      'scripts/',
      '.github/',
      '.beads/',
      'docs/',
      '__tests__/',
      'agent/',
    ]) {
      expect(map, `repository map should classify ${path}`).toContain(path);
    }
  });

  it('keeps product and tracker references out of durable protocol identity', () => {
    expect(map).toMatch(/references, not durable OpenCoven protocol identity/i);
    expect(map).toMatch(/Beads and GitHub own planning\/public outcome state only/i);
    expect(map).toMatch(/never runtime task, lane, action, receipt, or familiar identity/i);
    expect(map).toMatch(/no guessed wire contract/i);
  });

  it('provides focused-to-live verification routing and generated-source ownership', () => {
    for (const phrase of [
      'Focused proof',
      'Type/contract proof',
      'Repository proof',
      'Build/smoke proof',
      'Platform/live acceptance',
      'pnpm generate:hooks-docs',
      'pnpm ios:project:check',
      'pnpm build',
      'source change in Beads followed by the supported synchronizer',
    ]) {
      expect(map).toContain(phrase);
    }
  });
});
