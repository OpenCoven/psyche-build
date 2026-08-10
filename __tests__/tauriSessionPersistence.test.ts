import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native/macos/psyche-build-tauri');
const webRoot = join(tauriRoot, 'web');
const workspaceRoot = join(webRoot, 'workspace');
const packageJson = JSON.parse(
  readFileSync(join(tauriRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

const workspaceModel = await import(
  pathToFileURL(join(workspaceRoot, 'workspace-model.mjs')).href
);
const workspaceEntry = await import(
  pathToFileURL(join(workspaceRoot, 'workspace-entry.js')).href
);

function countOccurrences(source: string, needle: string) {
  return source.split(needle).length - 1;
}

describe('Tauri workspace persistence model', () => {
  test('imports v2 state without inventing sessions or layouts', () => {
    expect(
      workspaceModel.importWorkspaceV2({
        version: 2,
        activeProjectId: 'project-a',
        projects: [{ id: 'project-a', root: '/repo' }],
        sessions: [{ id: 'unexpected' }],
        paneLayouts: [{ projectId: 'project-a' }],
      }),
    ).toEqual({
      version: 3,
      activeProjectId: 'project-a',
      activeThreadId: null,
      projects: [{ id: 'project-a', root: '/repo' }],
      sessions: [],
      paneLayouts: [],
    });
  });

  test('sanitizes session descriptors and strips command env payloads', () => {
    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'session-1.alpha:beta',
        projectId: 'project-a',
        worktreePath: '/repo',
        name: 'Shell',
        kind: 'not-a-real-kind',
        launchKind: 'shell',
        hidden: true,
        command: 'rm -rf /',
        env: { SECRET: 'nope' },
      }),
    ).toEqual({
      id: 'session-1.alpha:beta',
      projectId: 'project-a',
      worktreePath: '/repo',
      name: 'Shell',
      kind: 'shell',
      launchKind: 'shell',
      hidden: true,
    });

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-1',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-attach',
      }),
    ).toBeNull();

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-1',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-attach',
        launchKind: 'spawn',
      }),
    ).toBeNull();

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-1',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-attach',
        launchKind: 'shell',
        covenSessionId: 'coven-session-1',
      }),
    ).toEqual({
      id: 'attach-1',
      projectId: 'project-a',
      worktreePath: '/repo',
      kind: 'coven-attach',
      launchKind: 'shell',
      hidden: false,
    });

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-2',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'shell',
        launchKind: 'coven-attach',
      }),
    ).toBeNull();
  });

  test('collapses malformed, unknown, and duplicate pane leaves', () => {
    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          id: 'split-1',
          orientation: 'sideways',
          ratio: 2,
          first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
          second: {
            type: 'split',
            id: 'split-2',
            orientation: 'row',
            ratio: -1,
            first: { type: 'leaf', id: 'leaf-b', threadId: 'thread-a' },
            second: { type: 'leaf', id: 'leaf-c', threadId: 'missing' },
          },
        },
        new Set(['thread-a']),
      ),
    ).toEqual({
      type: 'leaf',
      id: 'leaf-a',
      threadId: 'thread-a',
    });

    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          id: 'split-3',
          orientation: 'row',
          ratio: 2,
          first: { type: 'leaf', id: 'leaf-d', threadId: 'thread-d' },
          second: { type: 'leaf', id: 'leaf-e', threadId: 'thread-e' },
        },
        new Set(['thread-d', 'thread-e']),
      ),
    ).toEqual({
      type: 'split',
      id: 'split-3',
      orientation: 'row',
      ratio: 1,
      first: { type: 'leaf', id: 'leaf-d', threadId: 'thread-d' },
      second: { type: 'leaf', id: 'leaf-e', threadId: 'thread-e' },
    });
  });

  test('drops invalid leaf ids and collapses malformed split ids', () => {
    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          orientation: 'row',
          first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
          second: { type: 'leaf', threadId: 'thread-b' },
        },
        new Set(['thread-a', 'thread-b']),
      ),
    ).toEqual({
      type: 'leaf',
      id: 'leaf-a',
      threadId: 'thread-a',
    });

    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          id: 'split invalid',
          orientation: 'row',
          first: { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
          second: { type: 'leaf', id: 'leaf-d', threadId: 'thread-d' },
        },
        new Set(['thread-c', 'thread-d']),
      ),
    ).toEqual({
      type: 'leaf',
      id: 'leaf-c',
      threadId: 'thread-c',
    });

    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          orientation: 'row',
          first: { type: 'leaf', id: 'leaf-e', threadId: 'thread-e' },
          second: { type: 'leaf', id: 'leaf-f', threadId: 'thread-f' },
        },
        new Set(['thread-e', 'thread-f']),
      ),
    ).toEqual({
      type: 'leaf',
      id: 'leaf-e',
      threadId: 'thread-e',
    });
  });

  test('reconciles live, missing, and unknown sessions', () => {
    expect(
      workspaceModel.reconcileSessions(
        [
          {
            id: 'live-1',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'psyche',
            name: 'Live',
            launchKind: 'psyche',
          },
          {
            id: 'missing-1',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
          },
        ],
        ['orphan-b', 'live-1', 'orphan-a', 'live-1'],
      ),
    ).toEqual({
      sessions: [
        {
          id: 'live-1',
          projectId: 'project-a',
          worktreePath: '/repo',
          name: 'Live',
          kind: 'psyche',
          launchKind: 'psyche',
          hidden: false,
          status: 'running',
          persistentLive: true,
        },
        {
          id: 'missing-1',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
          status: 'exited',
          persistentLive: false,
        },
      ],
      unknownLiveIds: ['orphan-a', 'orphan-b'],
    });
  });

  test('dedupes workspace sessions and pane layouts', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'live-1',
        projects: [
          { id: 'project-a', root: '/repo' },
          { id: 'project-b', root: '/repo-b' },
        ],
        sessions: [
          {
            id: 'live-1',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            command: 'ignore-me',
            env: { SECRET: 'nope' },
          },
          {
            id: 'live-1',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
          {
            id: 'live-2',
            projectId: 'project-b',
            worktreePath: '/repo-b',
            kind: 'psyche',
            launchKind: 'psyche',
            hidden: false,
          },
        ],
        paneLayouts: [
          {
            projectId: 'project-a',
            worktreePath: '/repo',
            root: {
              type: 'split',
              id: 'split-a',
              first: { type: 'leaf', id: 'leaf-a', threadId: 'live-1' },
              second: { type: 'leaf', id: 'leaf-b', threadId: 'live-2' },
            },
            focusedLeafId: 'leaf-a',
          },
          {
            projectId: 'project-b',
            worktreePath: '/repo-b',
            root: {
              type: 'leaf',
              id: 'leaf-c',
              threadId: 'live-1',
            },
            focusedLeafId: 'leaf-c',
          },
        ],
      }),
    ).toEqual({
      version: 3,
      activeProjectId: 'project-a',
      activeThreadId: 'live-1',
      projects: [
        { id: 'project-a', root: '/repo' },
        { id: 'project-b', root: '/repo-b' },
      ],
      sessions: [
        {
          id: 'live-1',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
        {
          id: 'live-2',
          projectId: 'project-b',
          worktreePath: '/repo-b',
          kind: 'psyche',
          launchKind: 'psyche',
          hidden: false,
        },
      ],
      paneLayouts: [
        {
          projectId: 'project-a',
          worktreePath: '/repo',
          root: {
            type: 'split',
            id: 'split-a',
            orientation: 'column',
            ratio: 0.5,
            first: { type: 'leaf', id: 'leaf-a', threadId: 'live-1' },
            second: { type: 'leaf', id: 'leaf-b', threadId: 'live-2' },
          },
          focusedLeafId: 'leaf-a',
        },
      ],
    });
  });

  test('keeps bundle wiring ahead of main.js', () => {
    expect(packageJson.scripts['build:web']).toContain(
      'web/workspace/workspace-entry.js --bundle --minify --format=iife --global-name=PsycheWorkspace --outfile=web/workspace.bundle.js',
    );
    expect(countOccurrences(indexHtml, 'src="./editor.bundle.js"')).toBe(1);
    expect(countOccurrences(indexHtml, 'src="./sessions.bundle.js"')).toBe(1);
    expect(countOccurrences(indexHtml, 'src="./panes.bundle.js"')).toBe(1);
    expect(countOccurrences(indexHtml, 'src="./workspace.bundle.js"')).toBe(1);
    expect(countOccurrences(indexHtml, 'src="./main.js"')).toBe(1);
    expect(indexHtml.indexOf('src="./workspace.bundle.js"')).toBeLessThan(
      indexHtml.indexOf('src="./main.js"'),
    );
    expect(Object.keys(workspaceEntry).sort()).toEqual([
      'importWorkspaceV2',
      'reconcileSessions',
      'sanitizePaneTree',
      'sanitizeSessionDescriptor',
      'sanitizeWorkspaceV3',
    ]);
  });
});
