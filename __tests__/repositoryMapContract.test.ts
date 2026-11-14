import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
      'TRACKER.md',
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
      'docs/',
      '__tests__/',
      'agent/',
      'script/',
      'release/',
      'packages/vim-core/',
      'frontend/',
      'docs/superpowers/',
    ]) {
      expect(map, `repository map should classify ${path}`).toContain(path);
    }
  });

  it('keeps product and tracker references out of durable protocol identity', () => {
    expect(map).toMatch(/references, not durable OpenCoven protocol identity/i);
    expect(map).toMatch(/GitHub Issues and the Psyche Build Project own planning\/public outcome state only/i);
    expect(map).not.toMatch(/source change in Beads/i);
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
    ]) {
      expect(map).toContain(phrase);
    }
  });

  it('keeps every relative link in the top-level documents pointing at a file that exists', () => {
    // The dated records under docs/superpowers/ are history and are not
    // edited to follow later moves, so they are not checked.
    const documents = [
      ...readdirSync(root).filter((name) => name.endsWith('.md')),
      ...readdirSync(resolve(root, 'docs'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/${name}`),
    ];
    const broken = documents.flatMap((document) =>
      [...read(document).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
        .map(([, target]) => target.split('#')[0])
        .filter((target) => target !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(target))
        .filter((target) => !existsSync(resolve(root, dirname(document), decodeURIComponent(target))))
        .map((target) => `${document} -> ${target}`),
    );

    expect(documents.length).toBeGreaterThan(20);
    expect(broken).toEqual([]);
  });
});
