import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const libRs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('Tauri Coven launch project scope', () => {
  it('registers the canonical project path command and requires validated PTY roots', () => {
    expect(libRs).toMatch(/fn canonical_project_path\s*\(\s*root\s*:\s*String\s*\)/);
    expect(libRs).toMatch(/tauri::generate_handler!\s*\[[\s\S]*canonical_project_path\s*,/);
    expect(libRs).toMatch(/pub cwd:\s*Option<String>/);
    expect(libRs).toMatch(/pub launch_kind:\s*Option<String>/);
    expect(libRs).toMatch(/pub coven_session_id:\s*Option<String>/);

    const ptyStart = libRs.slice(
      libRs.indexOf('fn pty_start'),
      libRs.indexOf('#[tauri::command]', libRs.indexOf('fn pty_start') + 1),
    );
    expect(ptyStart).toContain('prepare_pty_start(&options)');
    expect(ptyStart).toContain('resolved_cwd.configure_command_cwd(&mut cmd)');
    const prepareStart = libRs.slice(
      libRs.indexOf('fn prepare_pty_start'),
      libRs.indexOf('#[tauri::command]', libRs.indexOf('fn prepare_pty_start')),
    );
    expect(prepareStart.indexOf('PendingPtyStart::reserve')).toBeLessThan(
      prepareStart.indexOf('projectRoot is required'),
    );
  });

  it('canonicalizes before project deduplication and reports unavailable paths', () => {
    const canonical = functionSource('canonicalProjectPath');
    expect(canonical).toContain('invoke("canonical_project_path"');
    expect(canonical).toContain('Project path is unavailable: ');
    expect(canonical).toContain('return null');

    const addProject = functionSource('addProject');
    const canonicalize = addProject.indexOf('await canonicalProjectPath(rootPath)');
    const deduplicate = addProject.indexOf('state.projects.find');
    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(deduplicate).toBeGreaterThan(canonicalize);
  });

  it('canonicalizes saved roots concurrently before restoring projects', () => {
    const boot = functionSource('boot');
    expect(boot).toContain('restoreSavedProjects');

    const canonicalize = boot.indexOf('restoreSavedProjects');
    const discover = boot.indexOf('refreshProjectWorktrees');
    expect(canonicalize).toBeGreaterThanOrEqual(0);
    expect(discover).toBeGreaterThan(canonicalize);
  });

  it('deduplicates canonical aliases while preserving the active project identity', async () => {
    let nextId = 0;
    const migrateProjectRoot = compileFunction<(
      project: Record<string, any>, oldRoot: string, canonicalRoot: string,
    ) => Record<string, any>>(functionSource('migrateProjectRoot'), {});
    const mergeRestoredProject = compileFunction<(
      target: Record<string, any>, incoming: Record<string, any>, preferIncoming: boolean,
    ) => Record<string, any>>(functionSource('mergeRestoredProject'), {});
    const restoreSavedProjects = compileFunction<(
      projects: Array<Record<string, unknown>>,
      activeId: string,
      limit: number,
    ) => Promise<{ projects: Array<Record<string, unknown>>; activeProjectId: string | null }>>(
      functionSource('restoreSavedProjects'),
      {
        sanitizeSavedProject: (saved: Record<string, unknown>) => ({ ...saved }),
        canonicalProjectPath: async (root: string) => ({
          '/alias/repo': '/real/repo',
          '/real/repo': '/real/repo',
          '/other': '/other',
        }[root] || null),
        migrateProjectRoot,
        mergeRestoredProject,
        makeProjectId: () => `generated-${nextId += 1}`,
      },
    );

    const result = await restoreSavedProjects([
      {
        id: 'first', root: '/alias/repo', selectedWorktreePath: '/alias/repo', worktrees: [],
        browsersByWorktree: { '/alias/repo': { tabs: [{ id: 'first-tab' }], activeTabId: 'first-tab' } },
      },
      {
        id: 'active-alias', root: '/real/repo', selectedWorktreePath: '/real/repo', worktrees: [],
        browsersByWorktree: { '/real/repo': { tabs: [{ id: 'active-tab' }], activeTabId: 'active-tab' } },
      },
      { id: 'first', root: '/other' },
      { id: 'invalid', root: '/missing' },
    ], 'active-alias', 10);

    expect(result.projects).toHaveLength(2);
    expect(result.projects[0]).toMatchObject({ id: 'first', root: '/real/repo' });
    expect(result.projects[1]).toMatchObject({ id: 'generated-1', root: '/other' });
    expect((result.projects[0] as any).browsersByWorktree['/real/repo']).toEqual({
      tabs: [{ id: 'first-tab' }, { id: 'active-tab' }],
      activeTabId: 'active-tab',
    });
    expect(result.activeProjectId).toBe('first');
  });

  it('rekeys root-scoped state when an alias migrates to its canonical root', () => {
    const migrateProjectRoot = compileFunction<(
      project: Record<string, any>, oldRoot: string, canonicalRoot: string,
    ) => Record<string, any>>(functionSource('migrateProjectRoot'), {});
    const browser = {
      tabs: [{ id: 'tab-1', url: 'https://example.test', history: ['https://example.test'] }],
      activeTabId: 'tab-1',
    };
    const project = {
      root: '/alias/repo',
      selectedWorktreePath: '/alias/repo/packages/app',
      worktrees: [
        { path: '/alias/repo', collapsed: true },
        { path: '/alias/repo/packages/app', collapsed: false },
        { path: '/linked', collapsed: false },
      ],
      browsersByWorktree: {
        '/alias/repo': browser,
        '/alias/repo/packages/app': { tabs: [{ id: 'nested-tab' }], activeTabId: 'nested-tab' },
        '/linked': { tabs: [{ id: 'linked-tab' }], activeTabId: 'linked-tab' },
      },
    };

    migrateProjectRoot(project, '/alias/repo', '/real/repo');

    expect(project.root).toBe('/real/repo');
    expect(project.selectedWorktreePath).toBe('/real/repo/packages/app');
    expect(project.worktrees).toEqual([
      { path: '/real/repo', collapsed: true },
      { path: '/real/repo/packages/app', collapsed: false },
      { path: '/linked', collapsed: false },
    ]);
    expect(project.browsersByWorktree).toEqual({
      '/real/repo': browser,
      '/real/repo/packages/app': { tabs: [{ id: 'nested-tab' }], activeTabId: 'nested-tab' },
      '/linked': { tabs: [{ id: 'linked-tab' }], activeTabId: 'linked-tab' },
    });
  });

  it('merges every browser and worktree key with the active source winning collisions', () => {
    const mergeRestoredProject = compileFunction<(
      target: Record<string, any>, incoming: Record<string, any>, preferIncoming: boolean,
    ) => Record<string, any>>(functionSource('mergeRestoredProject'), {});
    const target = {
      root: '/real/repo', selectedWorktreePath: '/real/repo', layout: { mode: 'terminal' },
      worktrees: [
        { path: '/real/repo/nested', collapsed: false },
        { path: '/external', collapsed: false },
      ],
      browsersByWorktree: {
        '/real/repo/nested': { tabs: [{ id: 'same', title: 'old' }], activeTabId: 'same' },
        '/external': { tabs: [{ id: 'external-old' }], activeTabId: 'external-old' },
      },
    };
    const incoming = {
      root: '/real/repo', selectedWorktreePath: '/external', layout: { mode: 'browser' },
      worktrees: [
        { path: '/real/repo/nested', collapsed: true },
        { path: '/incoming-external', collapsed: true },
      ],
      browsersByWorktree: {
        '/real/repo/nested': {
          tabs: [{ id: 'same', title: 'active' }, { id: 'new' }], activeTabId: 'new',
        },
        '/incoming-external': { tabs: [{ id: 'incoming-tab' }], activeTabId: 'incoming-tab' },
      },
    };

    mergeRestoredProject(target, incoming, true);

    expect(target.selectedWorktreePath).toBe('/external');
    expect(target.layout).toEqual({ mode: 'browser' });
    expect(target.worktrees).toEqual([
      { path: '/real/repo/nested', collapsed: true },
      { path: '/external', collapsed: false },
      { path: '/incoming-external', collapsed: true },
    ]);
    expect(target.browsersByWorktree).toEqual({
      '/real/repo/nested': {
        tabs: [{ id: 'same', title: 'active' }, { id: 'new' }], activeTabId: 'new',
      },
      '/external': { tabs: [{ id: 'external-old' }], activeTabId: 'external-old' },
      '/incoming-external': { tabs: [{ id: 'incoming-tab' }], activeTabId: 'incoming-tab' },
    });
  });
});
