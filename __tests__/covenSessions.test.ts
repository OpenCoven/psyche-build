import { afterAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  filterCovenSessionsForProjectRoots,
  listCovenSessionsFromCli,
  pickCovenSessionToOpen,
  listCovenSessionsFromDaemon,
  parseCovenSessionsJson,
} from '../src/utils/covenSessions.js';

const testArtifactRoot = path.resolve('.psyche-test-coven-sessions');

async function tempDir(prefix: string): Promise<string> {
  await mkdir(testArtifactRoot, { recursive: true });
  return mkdtemp(path.join(testArtifactRoot, prefix));
}

afterAll(async () => {
  await rm(testArtifactRoot, { recursive: true, force: true });
});

// These tests spawn a real shell script, so they inherit the production
// default timeout of 1.5s. Under full-suite parallelism that is close enough
// to real subprocess latency to flake, and the failure mode is a confusing
// 'unavailable' rather than a timeout error. Pin a generous timeout so the
// tests assert parsing behaviour rather than machine speed.
const EXEC_TIMEOUT_MS = 30_000;

async function fakeCoven(script: string): Promise<string> {
  const dir = await tempDir('psyche-fake-coven-');
  const command = path.join(dir, 'coven');
  await writeFile(command, script, 'utf8');
  await chmod(command, 0o755);
  return command;
}

describe('coven session adapter', () => {
  it('parses array and snake_case sessions from coven sessions --json', () => {
    const sessions = parseCovenSessionsJson(JSON.stringify([
      {
        id: 'session-1',
        project_root: '/repo',
        harness: 'codex',
        title: 'Fix tests',
        status: 'running',
        created_at: '2026-04-28T12:00:00.000Z',
        updated_at: '2026-04-28T12:01:00.000Z',
      },
    ]));

    expect(sessions).toEqual([
      {
        id: 'session-1',
        projectRoot: '/repo',
        cwd: undefined,
        harness: 'codex',
        title: 'Fix tests',
        status: 'running',
        createdAt: '2026-04-28T12:00:00.000Z',
        updatedAt: '2026-04-28T12:01:00.000Z',
      },
    ]);
  });

  it('marks archived records from archived_at while preserving final status text elsewhere', () => {
    const sessions = parseCovenSessionsJson(JSON.stringify([
      {
        id: 'session-archived',
        project_root: '/repo',
        harness: 'codex',
        title: 'Old work',
        status: 'completed',
        archived_at: '2026-04-28T12:03:00.000Z',
      },
      {
        id: 'session-completed',
        project_root: '/repo',
        harness: 'codex',
        title: 'Done work',
        status: 'completed',
      },
    ]));

    expect(sessions.map((session) => session.status)).toEqual(['archived', 'completed']);
    expect(sessions[0]?.archivedAt).toBe('2026-04-28T12:03:00.000Z');
  });

  it('parses object responses and skips records without a verified session id/root', () => {
    const sessions = parseCovenSessionsJson(JSON.stringify({
      sessions: [
        { id: 'session-2', projectRoot: '/repo', title: 'Ship Coven panel' },
        { id: 'missing-root' },
        { projectRoot: '/repo' },
      ],
    }));

    expect(sessions.map((session) => session.id)).toEqual(['session-2']);
  });

  it('loads sessions from the current Coven daemon API by default', async () => {
    const result = await listCovenSessionsFromDaemon({
      client: {
        listSessions: async () => [
          {
            id: 'session-3',
            projectRoot: '/repo',
            harness: 'claude',
            title: 'Review branch',
            status: 'running',
            createdAt: '2026-05-10T08:00:00Z',
            updatedAt: '2026-05-10T08:01:00Z',
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: 'ready',
      source: 'coven daemon API',
      sessions: [{ id: 'session-3', harness: 'claude' }],
    });
  });

  it('filters sessions to verified psyche project roots', async () => {
    const root = await tempDir('psyche-coven-root-');
    const child = await tempDir('psyche-coven-root-child-');
    const outside = await tempDir('psyche-coven-outside-');
    const realRoot = await realpath(root);

    // Put the child under the root without relying on symlinks.
    const nested = path.join(root, path.basename(child));
    await rename(child, nested);

    const visible = await filterCovenSessionsForProjectRoots([
      { id: 'inside', projectRoot: root, title: 'Inside' },
      { id: 'nested', projectRoot: nested, title: 'Nested' },
      { id: 'outside', projectRoot: outside, title: 'Outside' },
      { id: 'missing', projectRoot: path.join(root, 'nope'), title: 'Missing' },
    ], [root], {
      loadWorktrees: async () => [],
    });

    expect(realRoot).toBe(await realpath(root));
    expect(visible.map((session) => session.id)).toEqual(['inside', 'nested']);
  });

  it('includes sessions from external Git worktrees without exposing unrelated sessions', async () => {
    const root = await tempDir('psyche-coven-root-');
    const externalWorktree = await tempDir('psyche-coven-external-worktree-');
    const externalChild = path.join(externalWorktree, 'packages', 'app');
    const unrelated = await tempDir('psyche-coven-unrelated-');
    await mkdir(externalChild, { recursive: true });

    const visible = await filterCovenSessionsForProjectRoots([
      {
        id: 'external',
        projectRoot: externalWorktree,
        cwd: externalChild,
        title: 'External worktree',
      },
      {
        id: 'unrelated',
        projectRoot: unrelated,
        title: 'Unrelated',
      },
    ], [root], {
      loadWorktrees: async (projectRoot) => [
        {
          path: projectRoot,
          head: 'main',
          isMain: true,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
          dirty: false,
          missing: false,
        },
        {
          path: externalWorktree,
          head: 'external',
          isMain: false,
          detached: false,
          bare: false,
          locked: false,
          prunable: false,
          dirty: false,
          missing: false,
        },
      ],
    });

    expect(visible).toEqual([
      expect.objectContaining({
        id: 'external',
        projectRoot: await realpath(externalWorktree),
        cwd: await realpath(externalChild),
      }),
    ]);
  });

  it('keeps the main project visible when worktree discovery fails', async () => {
    const root = await tempDir('psyche-coven-root-');
    const unrelated = await tempDir('psyche-coven-unrelated-');

    const visible = await filterCovenSessionsForProjectRoots([
      { id: 'main', projectRoot: root, title: 'Main project' },
      { id: 'unrelated', projectRoot: unrelated, title: 'Unrelated' },
    ], [root], {
      loadWorktrees: async () => {
        throw new Error('git unavailable');
      },
    });

    expect(visible.map((session) => session.id)).toEqual(['main']);
  });

  it('bounds asynchronous worktree discovery across published projects', async () => {
    const roots = await Promise.all(
      Array.from({ length: 5 }, (_, index) => tempDir(`psyche-coven-root-${index}-`)),
    );
    let active = 0;
    let maxActive = 0;

    await filterCovenSessionsForProjectRoots([], roots, {
      maxConcurrentProjects: 2,
      loadWorktrees: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        active -= 1;
        return [];
      },
    });

    expect(maxActive).toBe(2);
  });

  it('chooses the latest scoped Coven session for the open action', () => {
    const session = pickCovenSessionToOpen('/repo', [
      {
        id: 'old-running',
        projectRoot: '/repo',
        title: 'Old running',
        status: 'running',
        updatedAt: '2026-04-28T12:00:00.000Z',
      },
      {
        id: 'latest-archived',
        projectRoot: '/repo',
        title: 'Latest archived',
        status: 'archived',
        archivedAt: '2026-04-28T12:05:00.000Z',
      },
      {
        id: 'outside',
        projectRoot: '/other',
        title: 'Outside',
        status: 'running',
        updatedAt: '2026-04-28T12:10:00.000Z',
      },
    ]);

    expect(session?.id).toBe('latest-archived');
  });

  it('returns a ready load state with sessions from coven sessions --json --all', async () => {
    const command = await fakeCoven(`#!/bin/sh
if [ "$1 $2 $3" = "sessions --json --all" ]; then
  printf '%s\\n' '{"sessions":[{"id":"session-ready","projectRoot":"/repo","status":"running"}]}'
  exit 0
fi
exit 2
`);

    const state = await listCovenSessionsFromCli({ command, timeoutMs: EXEC_TIMEOUT_MS });

    expect(state.status).toBe('ready');
    expect(state.sessions.map((session) => session.id)).toEqual(['session-ready']);
    if (state.status === 'ready') {
      expect(state.source).toBe('coven sessions --json --all');
    }
  });

  it('returns an empty load state when Coven returns no sessions', async () => {
    const command = await fakeCoven(`#!/bin/sh
if [ "$1 $2 $3" = "sessions --json --all" ]; then
  printf '%s\\n' '{"sessions":[]}'
  exit 0
fi
exit 2
`);

    const state = await listCovenSessionsFromCli({ command, timeoutMs: EXEC_TIMEOUT_MS });

    expect(state).toMatchObject({
      status: 'empty',
      sessions: [],
      source: 'coven sessions --json --all',
    });
  });

  it('falls back to coven sessions --json when --all fails', async () => {
    const command = await fakeCoven(`#!/bin/sh
if [ "$1 $2 $3" = "sessions --json --all" ]; then
  echo 'unsupported --all' >&2
  exit 2
fi
if [ "$1 $2" = "sessions --json" ]; then
  printf '%s\\n' '[{"id":"session-fallback","project_root":"/repo"}]'
  exit 0
fi
exit 2
`);

    const state = await listCovenSessionsFromCli({ command, timeoutMs: EXEC_TIMEOUT_MS });

    expect(state.status).toBe('ready');
    if (state.status === 'ready') {
      expect(state.source).toBe('coven sessions --json');
      expect(state.sessions.map((session) => session.id)).toEqual(['session-fallback']);
    }
  });

  it('returns an unavailable load state when the Coven CLI is missing', async () => {
    const state = await listCovenSessionsFromCli({
      timeoutMs: EXEC_TIMEOUT_MS,
      command: path.join(testArtifactRoot, 'missing-coven-command'),
    });

    expect(state).toMatchObject({
      status: 'unavailable',
      sessions: [],
      reason: 'coven CLI not found',
    });
  });
});
