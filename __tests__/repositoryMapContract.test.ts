import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const map = read('docs/REPOSITORY-MAP.md');

interface MarkdownNode {
  children?: MarkdownNode[];
  url?: string;
  position?: { start: { line: number } };
}

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

  it('keeps relative file links in tracked root and top-level docs resolvable', () => {
    const brokenLinks: string[] = [];

    const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
      cwd: root,
      encoding: 'utf8',
    }).split('\0').filter((file) => /^(?:docs\/)?[^/]+\.md$/.test(file));

    expect(files.length).toBeGreaterThan(20);

    for (const file of files) {
      const markdown = fromMarkdown(readFileSync(join(root, file), 'utf8'));
      const nodes: MarkdownNode[] = [markdown];
      while (nodes.length > 0) {
        const node = nodes.pop()!;
        if (node.children) nodes.push(...node.children);
        if (!node.url) continue;

        const url = node.url;
        if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url)) continue;
        const target = url.split(/[?#]/, 1)[0];
        if (target && !existsSync(resolve(root, dirname(file), decodeURIComponent(target)))) {
          brokenLinks.push(`${file}:${node.position?.start.line}: ${url}`);
        }
      }
    }

    expect(brokenLinks).toEqual([]);
  });
});
