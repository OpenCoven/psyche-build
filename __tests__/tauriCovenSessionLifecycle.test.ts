import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
