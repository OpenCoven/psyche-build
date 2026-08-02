import { chmod, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterCovenSessionsForProjectRoots,
  listCovenSessionsFromCli,
  pickCovenSessionToOpen,
  listCovenSessionsFromDaemon,
  parseCovenSessionsJson,
} from '../src/utils/covenSessions.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

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
    ], [root]);

    expect(realRoot).toBe(await realpath(root));
    expect(visible.map((session) => session.id)).toEqual(['inside', 'nested']);
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

    const state = await listCovenSessionsFromCli({ command });

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

    const state = await listCovenSessionsFromCli({ command });

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

    const state = await listCovenSessionsFromCli({ command });

    expect(state.status).toBe('ready');
    if (state.status === 'ready') {
      expect(state.source).toBe('coven sessions --json');
      expect(state.sessions.map((session) => session.id)).toEqual(['session-fallback']);
    }
  });

  it('returns an unavailable load state when the Coven CLI is missing', async () => {
    const state = await listCovenSessionsFromCli({
      command: path.join(os.tmpdir(), 'missing-coven-command'),
    });

    expect(state).toMatchObject({
      status: 'unavailable',
      sessions: [],
      reason: 'coven CLI not found',
    });
  });
});
