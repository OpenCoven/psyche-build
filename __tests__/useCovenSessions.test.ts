import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { selectCovenSessionsLoadState } from '../src/hooks/useCovenSessions.js';
import type { CovenSessionsLoadState } from '../src/utils/covenSessions.js';

describe('useCovenSessions selection', () => {
  it('keeps scoped filtering as the default behavior', async () => {
    const root = await realpath(process.cwd());
    const outside = path.parse(root).root;
    const result = await selectCovenSessionsLoadState({
      status: 'ready',
      sessions: [
        { id: 'owned', projectRoot: root },
        { id: 'coven-only', projectRoot: outside },
      ],
      source: 'coven daemon API',
      loadedAt: '2026-08-09T12:00:00.000Z',
    }, [root]);

    expect(result).toMatchObject({
      status: 'ready',
      sessions: [expect.objectContaining({ id: 'owned', projectRoot: root })],
    });
  });

  it('retains every normalized daemon session in deterministic order when unscoped sessions are included', async () => {
    const sessions = [
      { id: 'owned', projectRoot: '/repo/owned', title: 'Owned' },
      { id: 'coven-only', projectRoot: '/repo/coven-only', title: 'Coven only' },
    ];
    const result = await selectCovenSessionsLoadState({
      status: 'ready',
      sessions,
      source: 'coven daemon API',
      loadedAt: '2026-08-09T12:00:00.000Z',
    }, ['/repo/owned'], { includeUnscoped: true });

    expect(result).toEqual({
      status: 'ready',
      sessions,
      source: 'coven daemon API',
      loadedAt: '2026-08-09T12:00:00.000Z',
    });
  });

  it('preserves unavailable and empty load states when unscoped sessions are included', async () => {
    const unavailable = {
      status: 'unavailable',
      sessions: [],
      reason: 'daemon offline',
      loadedAt: '2026-08-09T12:00:00.000Z',
    } satisfies CovenSessionsLoadState;
    const empty = {
      status: 'empty',
      sessions: [],
      source: 'coven daemon API',
      loadedAt: '2026-08-09T12:01:00.000Z',
    } satisfies CovenSessionsLoadState;

    await expect(selectCovenSessionsLoadState(
      unavailable,
      [],
      { includeUnscoped: true },
    )).resolves.toBe(unavailable);
    await expect(selectCovenSessionsLoadState(
      empty,
      [],
      { includeUnscoped: true },
    )).resolves.toBe(empty);
  });

  it('enables unscoped Coven sessions for Psyche workspace publication', async () => {
    const source = await readFile(
      new URL('../src/PsycheApp.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /useCovenSessions\(\s*sessionProjectRoot,\s*sidebarProjects,\s*\{\s*includeUnscoped:\s*true\s*\}\s*\)/,
    );
  });
});
