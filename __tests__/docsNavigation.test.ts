import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type ContentModule = {
  render?: () => unknown;
};

type NavigationSection = {
  title: string;
  pages: Array<{
    path: string;
    title: string;
  }>;
};

type ValidateNavigationGraph = (input: {
  modules: Record<string, ContentModule>;
  sections: NavigationSection[];
  renderedEntries?: Array<{
    source: string;
    rendered: string;
  }>;
}) => string[];

type RenderContentModule = (contentModule: ContentModule) => string;

async function loadContentRegistry(): Promise<{
  modules: Record<string, ContentModule>;
  sections: NavigationSection[];
  renderContentModule?: RenderContentModule;
  validateNavigationGraph?: ValidateNavigationGraph;
}> {
  // @ts-expect-error The Vite documentation app is plain JavaScript.
  return import('../docs/src/content/index.js');
}

describe('public docs navigation graph', () => {
  it('exports a deterministic validator and accepts the production registry', async () => {
    const registry = await loadContentRegistry();

    expect(registry.validateNavigationGraph).toBeTypeOf('function');
    expect(
      registry.validateNavigationGraph?.({
        modules: registry.modules,
        sections: registry.sections,
      }),
    ).toEqual([]);
  });

  it('rejects missing modules, unusable render entries, and unresolved internal targets', async () => {
    const registry = await loadContentRegistry();
    const validateNavigationGraph = registry.validateNavigationGraph;

    expect(validateNavigationGraph).toBeTypeOf('function');
    expect(
      validateNavigationGraph?.({
        modules: {
          empty: { render: () => '   ' },
          linked: { render: () => '<a href="#/missing-target">Missing</a>' },
          orphan: { render: () => '<p>Orphan</p>' },
        },
        sections: [
          {
            title: 'Broken',
            pages: [
              { path: 'not-absolute', title: 'Invalid path' },
              { path: '/missing-module', title: 'Missing module' },
              { path: '/empty', title: 'Empty render' },
              { path: '/linked', title: 'Broken internal link' },
            ],
          },
        ],
      }),
    ).toEqual([
      'module "orphan": no navigation page resolves to this key',
      'navigation path "not-absolute": must use canonical /key form',
      'navigation target "/empty": render() must return non-empty HTML',
      'navigation target "/linked": internal target "/missing-target" does not resolve',
      'navigation target "/missing-module": content module "missing-module" is missing',
    ]);
  });

  it('rejects unresolved targets from additional rendered navigation sources', async () => {
    const registry = await loadContentRegistry();
    const validateNavigationGraph = registry.validateNavigationGraph;

    expect(validateNavigationGraph).toBeTypeOf('function');
    expect(
      validateNavigationGraph?.({
        modules: {
          introduction: { render: () => '<p>Introduction</p>' },
        },
        sections: [
          {
            title: 'Overview',
            pages: [{ path: '/introduction', title: 'Introduction' }],
          },
        ],
        renderedEntries: [
          {
            source: 'docs/src/hero.js',
            rendered: '<a href="#/missing-target">Missing</a>',
          },
        ],
      }),
    ).toEqual([
      'navigation source "docs/src/hero.js": internal target "/missing-target" does not resolve',
    ]);
  });

  it('renders double-quoted, single-quoted, and unquoted internal routes as usable anchors', async () => {
    const registry = await loadContentRegistry();
    const renderContentModule = registry.renderContentModule;
    const mainSource = await readFile(new URL('../docs/src/main.js', import.meta.url), 'utf8');

    expect(renderContentModule).toBeTypeOf('function');
    expect(mainSource).toContain('renderContentModule(mod)');

    const rendered = renderContentModule?.({
      render: () => [
        '<a href="#/configuration">Double</a>',
        "<a href='#/configuration'>Single</a>",
        '<a href=#/configuration>Unquoted</a>',
        '<span data-href="#/configuration">Metadata</span>',
      ].join(''),
    });

    expect(rendered).toBe([
      '<a href="#configuration">Double</a>',
      "<a href='#configuration'>Single</a>",
      '<a href=#configuration>Unquoted</a>',
      '<span data-href="#/configuration">Metadata</span>',
    ].join(''));
    expect(
      registry.validateNavigationGraph?.({
        modules: {
          introduction: { render: () => rendered },
          configuration: { render: () => '<p>Configuration</p>' },
        },
        sections: [
          {
            title: 'Overview',
            pages: [
              { path: '/introduction', title: 'Introduction' },
              { path: '/configuration', title: 'Configuration' },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});
