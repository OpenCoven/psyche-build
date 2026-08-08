import { describe, expect, test } from 'vitest';

import * as model from '../native/macos/psyche-build-tauri/web/sessions/session-model.mjs';

describe('Tauri Coven session model', () => {
  test('accepts only safe Coven session identifiers', () => {
    expect(model.isSafeCovenSessionId('session-1.alpha:beta')).toBe(true);
    expect(model.isSafeCovenSessionId('a'.repeat(128))).toBe(true);
    expect(model.isSafeCovenSessionId('')).toBe(false);
    expect(model.isSafeCovenSessionId('a'.repeat(129))).toBe(false);
    expect(model.isSafeCovenSessionId('space id')).toBe(false);
    expect(model.isSafeCovenSessionId('slash/id')).toBe(false);
    expect(model.isSafeCovenSessionId('café')).toBe(false);
    expect(model.isSafeCovenSessionId(42)).toBe(false);
  });

  test('presents every Coven status consistently', () => {
    expect(model.statusPresentation(' starting ')).toEqual({
      tone: 'warn', label: 'starting', live: true,
    });
    expect(model.statusPresentation('RUNNING')).toEqual({
      tone: 'ok', label: 'running', live: true,
    });
    expect(model.statusPresentation('waiting')).toEqual({
      tone: 'warn', label: 'waiting', live: true,
    });
    expect(model.statusPresentation('completed')).toEqual({
      tone: 'muted', label: 'completed', live: false,
    });
    expect(model.statusPresentation('archived')).toEqual({
      tone: 'muted', label: 'archived', live: false,
    });
    for (const status of ['failed', 'killed', 'orphaned']) {
      expect(model.statusPresentation(status)).toEqual({
        tone: 'danger', label: status, live: false,
      });
    }
    expect(model.statusPresentation('  custom state  ')).toEqual({
      tone: 'neutral', label: 'custom state', live: false,
    });
    expect(model.statusPresentation()).toEqual({
      tone: 'neutral', label: 'unknown', live: false,
    });
  });

  test('sorts cloned sessions by liveness, recency, then ID', () => {
    const sessions = [
      { id: 'z', status: 'completed', updatedAt: '2026-01-05T00:00:00Z' },
      { id: 'b', status: 'running', updatedAt: '2026-01-02T00:00:00Z' },
      { id: 'a', status: 'waiting', updatedAt: '2026-01-02T00:00:00Z' },
      { id: 'old', status: 'running', updatedAt: 'invalid' },
      { id: 'new', status: 'starting', updatedAt: '2026-01-03T00:00:00Z' },
      { id: 'a-nonlive', status: 'failed' },
    ];
    const original = [...sessions];

    expect(model.sortCovenSessions(sessions).map((session) => session.id)).toEqual([
      'new', 'a', 'b', 'old', 'z', 'a-nonlive',
    ]);
    expect(sessions).toEqual(original);
  });

  test('treats only RFC3339 timestamps as recent and compares IDs by code unit', () => {
    const sessions = [
      { id: 'a-old', status: 'running', updatedAt: '08/04/2026' },
      { id: '.old', status: 'running', updatedAt: '2026-08-04' },
      { id: ':old', status: 'running', updatedAt: 1_786_272_000_000 },
      { id: 'Aold', status: 'running', updatedAt: new Date('2026-08-04T00:00:00Z') },
      { id: 'z', status: 'running', updatedAt: '2026-08-04T10:00:00Z' },
      { id: 'Z', status: 'running', updatedAt: '2026-08-04T10:00:00+00:00' },
    ];
    const original = [...sessions];

    expect(model.sortCovenSessions(sessions).map((session) => session.id)).toEqual([
      'Z', 'z', '.old', ':old', 'Aold', 'a-old',
    ]);
    expect(sessions).toEqual(original);
  });

  test('rejects RFC3339 timestamps with invalid calendar, clock, or offset components', () => {
    const sessions = [
      { id: '.feb30', status: 'running', updatedAt: '2026-02-30T00:00:00Z' },
      { id: ':nonleap', status: 'running', updatedAt: '2026-02-29T00:00:00Z' },
      { id: 'A-hour', status: 'running', updatedAt: '2026-01-01T24:00:00Z' },
      { id: 'a-minute', status: 'running', updatedAt: '2026-01-01T00:60:00Z' },
      { id: 'invalid-offset-minute', status: 'running', updatedAt: '2026-01-01T00:00:00+01:60' },
      { id: 'invalid-offset-limit', status: 'running', updatedAt: '2026-01-01T00:00:00+14:01' },
      { id: 'invalid-negative-offset-limit', status: 'running', updatedAt: '2026-01-01T00:00:00-14:01' },
      { id: 'z-second', status: 'running', updatedAt: '2026-01-01T00:00:60Z' },
      { id: '-offset-hour', status: 'running', updatedAt: '2026-01-01T00:00:00+24:00' },
      { id: 'valid-leap', status: 'running', updatedAt: '2024-02-29T00:00:00Z' },
      { id: 'valid-offset', status: 'running', updatedAt: '2026-08-04T10:00:00+05:30' },
      { id: 'valid-offset-limit', status: 'running', updatedAt: '2026-08-04T10:00:00+14:00' },
      { id: 'valid-fraction', status: 'running', updatedAt: '2026-08-04T05:00:00.123Z' },
    ];
    const original = [...sessions];

    expect(model.sortCovenSessions(sessions).map((session) => session.id)).toEqual([
      'valid-fraction', 'valid-offset', 'valid-offset-limit', 'valid-leap',
      '-offset-hour', '.feb30', ':nonleap', 'A-hour', 'a-minute', 'invalid-negative-offset-limit',
      'invalid-offset-limit', 'invalid-offset-minute', 'z-second',
    ]);
    expect(sessions).toEqual(original);
  });

  test('groups only safe, project-scoped sessions into sorted copies', () => {
    const sessions = [
      { id: 'later', projectRoot: '/alpha', status: 'completed', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'live', projectRoot: '/alpha', status: 'running', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'beta', projectRoot: '/beta', status: 'waiting' },
      { id: 'unsafe id', projectRoot: '/alpha', status: 'running' },
      { id: 'missing-root', status: 'running' },
      { projectRoot: '/alpha', status: 'running' },
      { id: 'empty-root', projectRoot: '', status: 'running' },
    ];

    const grouped = model.groupCovenSessions(sessions);

    expect([...grouped.keys()]).toEqual(['/alpha', '/beta']);
    expect(grouped.get('/alpha')?.map((session) => session.id)).toEqual(['live', 'later']);
    expect(grouped.get('/beta')?.map((session) => session.id)).toEqual(['beta']);
    expect(sessions).toHaveLength(7);
  });

  test('filters both local and remote sessions without mutating their inputs', () => {
    const project = { name: 'Alpha Project' };
    const psycheSessions = [
      { name: 'Plan launch', title: 'Local title' },
      { name: 'Other', title: 'Review changes' },
    ];
    const covenSessions = [
      { id: 'z', title: 'Ship release', harness: 'coven-code', status: 'completed' },
      { id: 'remote-id', title: 'Build feature', harness: 'other', status: 'running' },
    ];
    const localOriginal = [...psycheSessions];
    const remoteOriginal = [...covenSessions];

    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, 'alpha')).toEqual({
      projectMatches: true,
      psycheSessions,
      covenSessions: [covenSessions[1], covenSessions[0]],
    });
    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, 'review').psycheSessions)
      .toEqual([psycheSessions[1]]);
    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, 'coven-code').covenSessions)
      .toEqual([covenSessions[0]]);
    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, 'running').covenSessions)
      .toEqual([covenSessions[1]]);
    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, 'remote-id').covenSessions)
      .toEqual([covenSessions[1]]);
    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, '').psycheSessions)
      .toEqual(psycheSessions);
    expect(model.filterProjectSessions(project, psycheSessions, covenSessions, 'missing')).toEqual({
      projectMatches: false, psycheSessions: [], covenSessions: [],
    });
    expect(psycheSessions).toEqual(localOriginal);
    expect(covenSessions).toEqual(remoteOriginal);
  });

  test('normalizes local and Coven sessions into their most-specific worktree rows', () => {
    const project = {
      name: 'Alpha',
      root: '/repo',
      worktrees: [
        { path: '/repo', branch: 'main' },
        { path: '/external/feature', branch: 'feature' },
        { path: '/external/feature/nested', branch: 'nested' },
      ],
    };
    const modelResult = model.buildProjectRailModel(
      project,
      [{ id: 'local', name: 'Local', worktreePath: '/external/feature' }],
      [{
        id: 'remote', projectRoot: '/external/feature',
        cwd: '/external/feature/nested/app', title: 'Remote', status: 'waiting',
      }],
      '',
    );

    expect(modelResult.worktrees[1].rows).toEqual([
      expect.objectContaining({ source: 'psyche', id: 'local', worktreePath: '/external/feature' }),
    ]);
    expect(modelResult.worktrees[2].rows).toEqual([
      expect.objectContaining({
        source: 'coven', id: 'remote', worktreePath: '/external/feature/nested',
        needsAttention: true,
      }),
    ]);
  });

  test('keeps sessions whose cwd has no known worktree in an explicit project group', () => {
    const result = model.buildProjectRailModel(
      { name: 'Alpha', root: '/repo', worktrees: [{ path: '/repo', branch: 'main' }] },
      [{ id: 'orphan', name: 'Orphan', worktreePath: '/removed/worktree' }],
      [],
      '',
    );

    expect(result.projectRows).toEqual([
      expect.objectContaining({ id: 'orphan', worktreePath: null }),
    ]);
    expect(result.worktrees[0].rows).toEqual([]);
  });

  test('creates an idle discovery state and only shows first-request loading', () => {
    const initial = model.createCovenDiscoveryState();

    expect(initial).toEqual({
      phase: 'idle', sessionsByProject: new Map(), message: null, requestId: 0, refreshedAt: null,
      stale: false,
    });
    const first = model.beginCovenRequest(initial);
    expect(first).toEqual({
      requestId: 1,
      state: { ...initial, phase: 'loading', requestId: 1, sessionsByProject: new Map(), message: null },
    });
    expect(initial.phase).toBe('idle');

    const refreshed = model.beginCovenRequest({
      phase: 'ready', sessionsByProject: new Map([['/alpha', [{ id: 'live' }]]]),
      message: 'still here', requestId: 3, refreshedAt: 10,
    });
    expect(refreshed.requestId).toBe(4);
    expect(refreshed.state).toEqual({
      phase: 'ready', sessionsByProject: new Map([['/alpha', [{ id: 'live' }]]]),
      message: 'still here', requestId: 4, refreshedAt: 10,
    });
  });

  test('preserves confirmed rows as stale through failures and replaces them on recovery', () => {
    const requested = model.beginCovenRequest(model.createCovenDiscoveryState());
    const ready = model.applyCovenResponse(requested.state, requested.requestId, {
      status: 'ready',
      sessions: [{ id: 'live', projectRoot: '/alpha', status: 'running' }],
    }, 100);

    for (const status of ['unavailable', 'incompatible', 'error']) {
      const next = model.beginCovenRequest(ready);
      const failed = model.applyCovenResponse(
        next.state,
        next.requestId,
        { status, message: ' nope ' },
        101,
      );
      expect(failed).toEqual({
        phase: status,
        sessionsByProject: ready.sessionsByProject,
        message: 'nope',
        requestId: next.requestId,
        refreshedAt: 101,
        stale: true,
      });

      const recovery = model.beginCovenRequest(failed);
      const recovered = model.applyCovenResponse(recovery.state, recovery.requestId, {
        status: 'ready', sessions: [{ id: 'recovered', projectRoot: '/beta', status: 'running' }],
      }, 102);
      expect(recovered).toMatchObject({ phase: 'ready', stale: false });
      expect(recovered.sessionsByProject.has('/alpha')).toBe(false);
      expect(recovered.sessionsByProject.get('/beta')?.[0].id).toBe('recovered');
    }
  });

  test('treats a healthy empty response as ready with no sessions', () => {
    const requested = model.beginCovenRequest(model.createCovenDiscoveryState());
    const empty = model.applyCovenResponse(
      requested.state,
      requested.requestId,
      { status: 'empty', sessions: [] },
      103,
    );

    expect(empty).toEqual({
      phase: 'ready',
      sessionsByProject: new Map(),
      message: null,
      requestId: requested.requestId,
      refreshedAt: 103,
      stale: false,
    });
  });
  test('turns malformed responses into errors and suppresses stale results by identity', () => {
    const first = model.beginCovenRequest(model.createCovenDiscoveryState());
    const second = model.beginCovenRequest(first.state);

    expect(model.applyCovenResponse(second.state, first.requestId, { status: 'ready', sessions: [] }))
      .toBe(second.state);
    const invalid = model.applyCovenResponse(second.state, second.requestId, { status: 'wat' }, 11);
    expect(invalid).toEqual({
      phase: 'error', sessionsByProject: new Map(), message: null, requestId: second.requestId, refreshedAt: 11,
      stale: false,
    });

    const invalidated = model.invalidateCovenRequests(invalid);
    expect(invalidated).toEqual({
      phase: 'idle', sessionsByProject: new Map(), message: null, requestId: second.requestId + 1, refreshedAt: null,
      stale: false,
    });
    expect(model.applyCovenResponse(invalidated, second.requestId, { status: 'ready', sessions: [] }))
      .toBe(invalidated);
  });
});
