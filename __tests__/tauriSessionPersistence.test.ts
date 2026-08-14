import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();
const tauriRoot = join(repoRoot, 'native/desktop/psyche-build-tauri');
const webRoot = join(tauriRoot, 'web');
const workspaceRoot = join(webRoot, 'workspace');
const packageJson = JSON.parse(
  readFileSync(join(tauriRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const mainSource = readFileSync(join(webRoot, 'main.js'), 'utf8');

const workspaceModel = await import(
  pathToFileURL(join(workspaceRoot, 'workspace-model.mjs')).href
);
const workspaceEntry = await import(
  pathToFileURL(join(workspaceRoot, 'workspace-entry.js')).href
);

function countOccurrences(source: string, needle: string) {
  return source.split(needle).length - 1;
}

function functionSource(name: string) {
  const asyncStart = mainSource.indexOf(`async function ${name}(`);
  const syncStart = mainSource.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainSource.length; index += 1) {
    if (mainSource[index] === '{') depth += 1;
    if (mainSource[index] === '}') depth -= 1;
    if (depth === 0) return mainSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
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

  test('accepts only safe Coven attachment identifiers', () => {
    expect(workspaceModel.isSafeCovenAttachmentId('a'.repeat(128))).toBe(true);
    expect(workspaceModel.isSafeCovenAttachmentId('a'.repeat(129))).toBe(false);
    expect(workspaceModel.isSafeCovenAttachmentId('space id')).toBe(false);
    expect(workspaceModel.isSafeCovenAttachmentId('slash/id')).toBe(false);
    expect(workspaceModel.isSafeCovenAttachmentId('café')).toBe(false);

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-safe',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-attach',
        launchKind: 'coven-attach',
        covenSessionId: 'a'.repeat(128),
      }),
    ).toEqual({
      id: 'attach-safe',
      projectId: 'project-a',
      worktreePath: '/repo',
      kind: 'coven-attach',
      launchKind: 'coven-attach',
      hidden: false,
      covenSessionId: 'a'.repeat(128),
    });

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-long',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-attach',
        launchKind: 'coven-attach',
        covenSessionId: 'a'.repeat(129),
      }),
    ).toBeNull();

    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'attach-unsafe',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-attach',
        launchKind: 'coven-attach',
        covenSessionId: 'space id',
      }),
    ).toBeNull();
  });

  test('preserves safe Coven chat identifiers needed for explicit retry', () => {
    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'chat-1',
        projectId: 'project-a',
        worktreePath: '/repo',
        kind: 'coven-chat',
        launchKind: 'coven-chat',
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
      }),
    ).toMatchObject({
      launchKind: 'coven-chat',
      covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
    });
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
          root: { type: 'leaf', id: 'leaf-a', threadId: 'live-1' },
          focusedLeafId: 'leaf-a',
        },
      ],
    });
  });

  test('drops duplicate leaf ids across distinct sessions', () => {
    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          id: 'split-a',
          orientation: 'row',
          first: { type: 'leaf', id: 'leaf-shared', threadId: 'thread-a' },
          second: { type: 'leaf', id: 'leaf-shared', threadId: 'thread-b' },
        },
        new Set(['thread-a', 'thread-b']),
      ),
    ).toEqual({
      type: 'leaf',
      id: 'leaf-shared',
      threadId: 'thread-a',
    });
  });

  test('collapses duplicate split ids across sibling branches', () => {
    expect(
      workspaceModel.sanitizePaneTree(
        {
          type: 'split',
          id: 'split-root',
          orientation: 'row',
          first: {
            type: 'split',
            id: 'split-shared',
            orientation: 'column',
            first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
            second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-b' },
          },
          second: {
            type: 'split',
            id: 'split-shared',
            orientation: 'column',
            first: { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
            second: { type: 'leaf', id: 'leaf-d', threadId: 'thread-d' },
          },
        },
        new Set(['thread-a', 'thread-b', 'thread-c', 'thread-d']),
      ),
    ).toEqual({
      type: 'split',
      id: 'split-root',
      orientation: 'row',
      ratio: 0.5,
      first: {
        type: 'split',
        id: 'split-shared',
        orientation: 'column',
        ratio: 0.5,
        first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
        second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-b' },
      },
      second: { type: 'leaf', id: 'leaf-c', threadId: 'thread-c' },
    });
  });

  test('does not let a duplicate layout consume a later matching thread', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'thread-a',
        projects: [
          { id: 'project-a', root: '/repo' },
          { id: 'project-b', root: '/repo-b' },
        ],
        sessions: [
          {
            id: 'thread-a',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
          {
            id: 'thread-b',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
        ],
        paneLayouts: [
          {
            projectId: 'project-a',
            worktreePath: '/repo',
            root: {
              type: 'leaf',
              id: 'leaf-a',
              threadId: 'thread-b',
            },
            focusedLeafId: 'leaf-a',
          },
          {
            projectId: 'project-a',
            worktreePath: '/repo',
            root: {
              type: 'leaf',
              id: 'leaf-b',
              threadId: 'thread-a',
            },
            focusedLeafId: 'leaf-b',
          },
          {
            projectId: 'project-b',
            worktreePath: '/repo-b',
            root: {
              type: 'leaf',
              id: 'leaf-c',
              threadId: 'thread-a',
            },
            focusedLeafId: 'leaf-c',
          },
        ],
      }),
    ).toEqual({
      version: 3,
      activeProjectId: 'project-a',
      activeThreadId: 'thread-a',
      projects: [
        { id: 'project-a', root: '/repo' },
        { id: 'project-b', root: '/repo-b' },
      ],
      sessions: [
        {
          id: 'thread-a',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
        {
          id: 'thread-b',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
      ],
      paneLayouts: [
        {
          projectId: 'project-a',
          worktreePath: '/repo',
          root: {
            type: 'leaf',
            id: 'leaf-a',
            threadId: 'thread-b',
          },
          focusedLeafId: 'leaf-a',
        },
      ],
    });
  });

  test('does not let a discarded malformed branch consume a later matching thread', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'thread-a',
        projects: [
          { id: 'project-a', root: '/repo' },
          { id: 'project-b', root: '/repo-b' },
        ],
        sessions: [
          {
            id: 'thread-a',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
          {
            id: 'thread-b',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
        ],
        paneLayouts: [
          {
            projectId: 'project-a',
            worktreePath: '/repo',
            root: {
              type: 'split',
              id: 'split invalid',
              first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-b' },
              second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-a' },
            },
            focusedLeafId: 'leaf-a',
          },
          {
            projectId: 'project-b',
            worktreePath: '/repo-b',
            root: {
              type: 'leaf',
              id: 'leaf-c',
              threadId: 'thread-a',
            },
            focusedLeafId: 'leaf-c',
          },
        ],
      }),
    ).toEqual({
      version: 3,
      activeProjectId: 'project-a',
      activeThreadId: 'thread-a',
      projects: [
        { id: 'project-a', root: '/repo' },
        { id: 'project-b', root: '/repo-b' },
      ],
      sessions: [
        {
          id: 'thread-a',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
        {
          id: 'thread-b',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
      ],
      paneLayouts: [
        {
          projectId: 'project-a',
          worktreePath: '/repo',
          root: {
            type: 'leaf',
            id: 'leaf-a',
            threadId: 'thread-b',
          },
          focusedLeafId: 'leaf-a',
        },
      ],
    });
  });

  test('rejects pane layouts whose owners are not saved projects', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'thread-a',
        projects: [{ id: 'project-a', root: '/repo' }],
        sessions: [
          {
            id: 'thread-a',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
        ],
        paneLayouts: [
          {
            projectId: 'project-missing',
            worktreePath: '/repo',
            root: {
              type: 'leaf',
              id: 'leaf-a',
              threadId: 'thread-a',
            },
            focusedLeafId: 'leaf-a',
          },
        ],
      }),
    ).toEqual({
      version: 3,
      activeProjectId: 'project-a',
      activeThreadId: 'thread-a',
      projects: [{ id: 'project-a', root: '/repo' }],
      sessions: [
        {
          id: 'thread-a',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
      ],
      paneLayouts: [],
    });
  });

  test('drops sessions whose owners are not saved projects', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'orphan-thread',
        projects: [{ id: 'project-a', root: '/repo' }],
        sessions: [
          {
            id: 'orphan-thread',
            projectId: 'project-missing',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
          },
        ],
        paneLayouts: [],
      }),
    ).toMatchObject({
      activeThreadId: null,
      sessions: [],
    });
  });

  test('filters pane layouts to the matching project and worktree session scope', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'thread-a',
        projects: [
          { id: 'project-a', root: '/repo' },
          { id: 'project-b', root: '/repo-b' },
        ],
        sessions: [
          {
            id: 'thread-a',
            projectId: 'project-a',
            worktreePath: '/repo',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
          {
            id: 'thread-b',
            projectId: 'project-a',
            worktreePath: '/repo-b',
            kind: 'shell',
            launchKind: 'shell',
            hidden: false,
          },
          {
            id: 'thread-c',
            projectId: 'project-b',
            worktreePath: '/repo-b',
            kind: 'shell',
            launchKind: 'shell',
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
              first: { type: 'leaf', id: 'leaf-a', threadId: 'thread-a' },
              second: { type: 'leaf', id: 'leaf-b', threadId: 'thread-b' },
            },
            focusedLeafId: 'leaf-a',
          },
          {
            projectId: 'project-b',
            worktreePath: '/repo-b',
            root: {
              type: 'leaf',
              id: 'leaf-c',
              threadId: 'thread-c',
            },
            focusedLeafId: 'leaf-c',
          },
        ],
      }),
    ).toEqual({
      version: 3,
      activeProjectId: 'project-a',
      activeThreadId: 'thread-a',
      projects: [
        { id: 'project-a', root: '/repo' },
        { id: 'project-b', root: '/repo-b' },
      ],
      sessions: [
        {
          id: 'thread-a',
          projectId: 'project-a',
          worktreePath: '/repo',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
        {
          id: 'thread-b',
          projectId: 'project-a',
          worktreePath: '/repo-b',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
        {
          id: 'thread-c',
          projectId: 'project-b',
          worktreePath: '/repo-b',
          kind: 'shell',
          launchKind: 'shell',
          hidden: false,
        },
      ],
      paneLayouts: [
        {
          projectId: 'project-a',
          worktreePath: '/repo',
          root: {
            type: 'leaf',
            id: 'leaf-a',
            threadId: 'thread-a',
          },
          focusedLeafId: 'leaf-a',
        },
        {
          projectId: 'project-b',
          worktreePath: '/repo-b',
          root: {
            type: 'leaf',
            id: 'leaf-c',
            threadId: 'thread-c',
          },
          focusedLeafId: 'leaf-c',
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
      'isSafeCovenAttachmentId',
      'reconcileSessions',
      'sanitizePaneTree',
      'sanitizeSessionDescriptor',
      'sanitizeWorkspaceV3',
    ]);
  });

  test('serializes native workspace saves in mutation order', () => {
    expect(mainSource).toContain('var workspaceSaveQueue = Promise.resolve();');
    expect(mainSource).toContain(
      'workspaceSaveQueue = workspaceSaveQueue.then(function () {',
    );
    expect(mainSource).toContain('return workspaceSaveQueue;');
    expect(mainSource).toContain('await saveWorkspaceNow();');
  });

  test('serializes sessions and pane layouts into workspace v3', () => {
    expect(functionSource('persistableSession')).not.toMatch(/term|host|pane|fit/);
    expect(functionSource('persistablePaneLayouts')).toContain('paneLayouts.forEach');
    expect(functionSource('buildPersistedWorkspace')).toContain('version: 3');
    expect(functionSource('buildPersistedWorkspace')).toContain('sessions:');
    expect(functionSource('buildPersistedWorkspace')).toContain('paneLayouts:');
  });

  test('loads and saves the complete native workspace document', () => {
    expect(functionSource('saveWorkspaceNow')).toContain('invoke("workspace_save"');
    expect(functionSource('readSavedWorkspace')).toContain('invoke("workspace_load"');
    expect(functionSource('readSavedWorkspace')).toContain('sanitizeWorkspaceV3');
    expect(functionSource('handleWindowCloseRequested')).toContain('await saveWorkspaceNow()');
  });

  test.each([
    'commitPanePlacement',
    'updateActiveSplit',
    'movePaneTo',
    'focusThread',
    'detachThreadPane',
    'hideThread',
    'reopenThread',
    'renameThread',
  ])('saves after durable pane mutation in %s', (name) => {
    expect(functionSource(name)).toContain('saveWorkspaceSoon()');
  });

  test('creates the durable session before mutating webview thread state', () => {
    const create = functionSource('createThread');
    expect(create).toContain('invoke("native_session_create"');
    expect(create.indexOf('invoke("native_session_create"')).toBeLessThan(
      create.indexOf('state.threads.push(thread)'),
    );
    expect(create).toContain('attachThreadClient(thread)');
  });

  test('attaches disposable PTYs with the Rust sessionId contract', () => {
    const attach = functionSource('attachThreadClient');
    expect(attach).toContain('invoke("pty_attach"');
    expect(attach).toContain('sessionId: thread.id');
    expect(attach).not.toContain('nativeSessionId');
  });

  test('explicit close stops the durable session before removing its descriptor', () => {
    const close = functionSource('closeThread');
    expect(close).toContain('invoke("native_session_stop"');
    expect(close.indexOf('invoke("native_session_stop"')).toBeLessThan(
      close.indexOf('state.threads = state.threads.filter'),
    );
    expect(close).toContain('await saveWorkspaceNow()');
  });

  test('explicit retry recreates and attaches an exited durable session', () => {
    const retry = functionSource('retryThread');
    expect(retry).toContain('invoke("native_session_create"');
    expect(retry).toContain('attachThreadClient(thread)');
  });

  test('distinguishes a dropped client from a stopped durable session', () => {
    const exit = functionSource('handlePtyExit');
    expect(exit).toContain('invoke("native_session_list")');
    expect(exit).toContain('thread.status = persistentLive ? "failed" : "exited"');
  });

  test('loads workspace before discovery and restores live sessions without recreating them', () => {
    const boot = functionSource('boot');
    expect(boot).toContain('await readSavedWorkspace()');
    expect(boot).toContain('invoke("native_session_list")');
    expect(boot).toContain('restorePersistedSessions');
    const restore = functionSource('restorePersistedSessions');
    expect(restore).toContain('PsycheWorkspace.reconcileSessions');
    expect(restore).toContain('invoke("native_session_capture"');
    expect(restore).toContain('attachThreadClient(thread)');
    expect(restore).not.toContain('native_session_create');
  });

  test('reserves Control-T for shells and Control-A for Coven agents', () => {
    const shortcuts = functionSource('routeGlobalShortcut');
    expect(shortcuts).toMatch(
      /e\.ctrlKey && !e\.metaKey[\s\S]*e\.code === "KeyT"[\s\S]*runNewShellCommand/,
    );
    expect(shortcuts).toMatch(
      /e\.ctrlKey && !e\.metaKey[\s\S]*e\.code === "KeyA"[\s\S]*runNewThreadCommand/,
    );
    expect(shortcuts).toMatch(/var meta = e\.metaKey \|\| e\.ctrlKey/);
  });

  test('shows the Control shortcuts in the menu and help overlay', () => {
    expect(indexHtml).toContain(
      'Shell — login shell<span class="new-pane-key">⌃T</span>',
    );
    expect(indexHtml).toContain(
      'Agent — coven chat<span class="new-pane-key">⌃A</span>',
    );
    expect(mainSource).toContain('["New shell pane", "⌃T"]');
    expect(mainSource).toContain('["New agent pane (coven chat)", "⌃A"]');
  });
});
