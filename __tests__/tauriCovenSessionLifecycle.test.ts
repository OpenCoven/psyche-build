import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as PsycheSessions from '../native/macos/psyche-build-tauri/web/sessions/session-model.mjs';

const webRoot = join(process.cwd(), 'native/macos/psyche-build-tauri');
const mainJs = readFileSync(join(webRoot, 'web/main.js'), 'utf8');
const nativeLib = readFileSync(join(webRoot, 'src-tauri/src/lib.rs'), 'utf8');
const sessionModel = readFileSync(join(webRoot, 'web/sessions/session-model.mjs'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`
  ).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);

  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for ${name}`);

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function discoveryHarness(
  projects: Array<Record<string, unknown>>,
  visibilityState = 'visible',
) {
  const requests: Array<{
    command: string;
    args: unknown;
    resolve: (value: unknown) => void;
  }> = [];
  const invoke = (command: string, args: unknown) => new Promise((resolve) => {
    requests.push({ command, args, resolve });
  });
  const create = new Function(
    'PsycheSessions',
    'invoke',
    'initialProjects',
    'initialVisibilityState',
    `
      var state = { projects: initialProjects };
      var document = { visibilityState: initialVisibilityState };
      var covenDiscovery = PsycheSessions.createCovenDiscoveryState();
      var covenDiscoveryFlight = null;
      function renderSessionList() {}
      ${functionSource(mainJs, 'covenDiscoveryScopes')}
      ${functionSource(mainJs, 'covenDiscoveryRoots')}
      ${functionSource(mainJs, 'refreshCovenSessions')}
      return {
        refresh: refreshCovenSessions,
        setProjects: function (projects) { state.projects = projects; },
        setVisibility: function (value) { document.visibilityState = value; },
        discovery: function () { return covenDiscovery; },
      };
    `,
  );
  const harness = create(PsycheSessions, invoke, projects, visibilityState);
  return { ...harness, requests } as {
    refresh: () => Promise<unknown>;
    setProjects: (projects: Array<Record<string, unknown>>) => void;
    setVisibility: (value: string) => void;
    discovery: () => ReturnType<typeof PsycheSessions.createCovenDiscoveryState>;
    requests: typeof requests;
  };
}

describe('macOS Coven session lifecycle boundary', () => {
  it('discovers every project and available worktree root in one bounded request', () => {
    const refresh = functionSource(mainJs, 'refreshCovenSessions');
    expect(refresh).toContain('covenDiscoveryRoots()');
    expect(refresh).toContain('invoke("coven_sessions"');
    expect(refresh).toContain('projectRoots: roots');
    expect(refresh).toContain('PsycheSessions.beginCovenRequest');
    expect(refresh).toContain('PsycheSessions.applyCovenResponse');
  });

  it('polls only with visible open projects and invalidates on project removal', () => {
    expect(mainJs).toContain('var COVEN_POLL_MS = 5000;');
    expect(functionSource(mainJs, 'startCovenPolling')).toContain(
      'document.visibilityState === "hidden" || state.projects.length === 0'
    );
    expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
      /hidden[\s\S]*saveWorkspaceNow\(\)[\s\S]*stopCovenPolling\(\)/
    );
    expect(functionSource(mainJs, 'handleVisibilityChange')).toMatch(
      /else[\s\S]*startCovenPolling\(\)/
    );
    expect(functionSource(mainJs, 'removeProject')).toContain(
      'PsycheSessions.invalidateCovenRequests'
    );
  });

  it('keeps remote records outside local thread state', () => {
    expect(functionSource(mainJs, 'refreshCovenSessions')).not.toContain('state.threads');
  });

  it('skips a queued refresh after the window hides or the last project closes', async () => {
    const hidden = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    hidden.setVisibility('hidden');
    const hiddenRefresh = hidden.refresh();
    hidden.requests.forEach((request) => request.resolve({ status: 'ready', sessions: [] }));
    await hiddenRefresh;
    expect(hidden.requests).toHaveLength(0);

    const empty = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    empty.setProjects([]);
    const emptyRefresh = empty.refresh();
    empty.requests.forEach((request) => request.resolve({ status: 'ready', sessions: [] }));
    await emptyRefresh;
    expect(empty.requests).toHaveLength(0);
  });

  it('coalesces concurrent refreshes for the same owned root set', async () => {
    const harness = discoveryHarness([{
      root: '/alpha',
      worktrees: [{ path: '/alpha-linked', missing: false, prunable: false, bare: false }],
    }]);

    const first = harness.refresh();
    const second = harness.refresh();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].args).toEqual({
      projectRoots: ['/alpha', '/alpha-linked'],
      projectScopes: [{
        projectRoot: '/alpha',
        worktreeRoots: ['/alpha-linked'],
      }],
    });
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.all([first, second]);
  });

  it('coalesces an in-flight ownership set after project and worktree reordering', async () => {
    const harness = discoveryHarness([
      { root: '/alpha', worktrees: [{ path: '/alpha-b' }, { path: '/alpha-a' }] },
      { root: '/beta', worktrees: [] },
    ]);
    const first = harness.refresh();
    harness.setProjects([
      { root: '/beta', worktrees: [] },
      { root: '/alpha', worktrees: [{ path: '/alpha-a' }, { path: '/alpha-b' }] },
    ]);
    const second = harness.refresh();

    expect(harness.requests).toHaveLength(1);
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.all([first, second]);
  });

  it('starts a new request when ownership roots change', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    const first = harness.refresh();
    harness.setProjects([{ root: '/beta', worktrees: [] }]);
    const second = harness.refresh();

    expect(harness.requests).toHaveLength(2);
    harness.requests[1].resolve({ status: 'ready', sessions: [] });
    harness.requests[0].resolve({ status: 'ready', sessions: [] });
    await Promise.all([first, second]);
  });

  it('ignores a late response from an older ownership-root request', async () => {
    const harness = discoveryHarness([{ root: '/alpha', worktrees: [] }]);
    const first = harness.refresh();
    harness.setProjects([{ root: '/beta', worktrees: [] }]);
    const second = harness.refresh();

    harness.requests[1].resolve({
      status: 'ready',
      sessions: [{ id: 'new', projectRoot: '/beta', status: 'running' }],
    });
    await second;
    harness.requests[0].resolve({
      status: 'ready',
      sessions: [{ id: 'old', projectRoot: '/alpha', status: 'running' }],
    });
    await first;

    expect(harness.discovery().sessionsByProject.has('/alpha')).toBe(false);
    expect(harness.discovery().sessionsByProject.get('/beta')?.[0].id).toBe('new');
  });

  it('retains stored local Coven identity when creating threads', () => {
    expect(functionSource(mainJs, 'createThread')).toContain(
      'covenSessionId: opts.covenSessionId || null'
    );
  });

  it('retains native discovery and the session model adapter', () => {
    expect(nativeLib).toContain('coven_sessions,');
    expect(sessionModel).toContain('export function createCovenDiscoveryState');
    expect(mainJs).toContain(
      'document.addEventListener("visibilitychange", handleVisibilityChange);'
    );
  });
});
