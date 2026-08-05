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
    if (character === '"' || character === '\'' || character === '`') {
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
  it('keeps the native discovery adapter while removing web discovery and attachment', () => {
    expect(mainJs).not.toContain('invoke("coven_sessions"');
    expect(mainJs).not.toContain('refreshCovenSessions');
    expect(mainJs).not.toContain('startCovenPolling');
    expect(mainJs).not.toContain('openCovenSession');
    expect(mainJs).not.toContain('args: ["attach"');
    expect(mainJs).not.toContain('"Attach"');
    expect(nativeLib).toContain('coven_sessions,');
    expect(sessionModel).toContain('export function createCovenDiscoveryState');
  });

  it('retains stored local Coven identity when creating threads', () => {
    expect(functionSource(mainJs, 'createThread')).toContain(
      'covenSessionId: opts.covenSessionId || null'
    );
  });

  it('only saves the workspace when visibility becomes hidden', () => {
    const visibilityChange = functionSource(mainJs, 'handleVisibilityChange');
    expect(visibilityChange).toContain(
      'if (document.visibilityState === "hidden") saveWorkspaceNow();'
    );
    expect(visibilityChange).not.toMatch(/Coven|Polling/);

    expect(mainJs).toContain(
      'document.addEventListener("visibilitychange", handleVisibilityChange);'
    );
  });
});
