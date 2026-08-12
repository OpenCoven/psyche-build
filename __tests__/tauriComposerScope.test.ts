import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionSource(source: string, name: string) {
  const match = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\(`).exec(source);
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
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
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

function compileRunCommand(dependencies: Record<string, unknown>) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${functionSource(mainJs, 'runCommand')});`,
  )(...Object.values(dependencies)) as (line: string) => void;
}

function runPlainText(
  focused: { kind?: string; status?: string } | null,
) {
  const sent: string[] = [];
  const toasts: string[] = [];
  const runCommand = compileRunCommand({
    runShellSigil: () => {},
    runPaneSigil: () => {},
    findThread: () => focused,
    state: { activeThreadId: focused ? 'focused-pane' : null },
    toast: (message: string) => toasts.push(message),
    sendToThread: (_thread: unknown, text: string) => sent.push(text),
    commandHistory: { push: () => {} },
    rememberCommand: () => {},
    commands: [],
    writeToActive: () => {},
  });

  runCommand('  hello  ');
  return { sent, toasts };
}

describe('Tauri composer target', () => {
  it('removes the composer scope picker and all of its implementation hooks', () => {
    expect(indexHtml).not.toContain('id="scope-btn"');
    expect(indexHtml).not.toContain('id="scope-menu"');
    expect(mainJs).not.toMatch(/\b(?:composerScope|scopeTargets|sendToScope|closeScopeMenu)\b/);
    expect(stylesCss).not.toMatch(/\.scope-(?:btn|menu|item|dot|label|kicker|caret)/);
  });

  it('sends plain text only to a focused, writable pane', () => {
    expect(runPlainText({ kind: 'agent', status: 'running' })).toEqual({
      sent: ['hello\n'],
      toasts: [],
    });
  });

  it.each([
    [null, 'No focused pane to send to'],
    [{ kind: 'web', status: 'running' }, 'Focused pane cannot receive text'],
    [{ kind: 'agent', status: 'exited' }, 'Focused pane cannot receive text'],
    [{ kind: 'agent', status: 'failed' }, 'Focused pane cannot receive text'],
  ])('does not silently discard text when the focused pane is unavailable', (focused, toast) => {
    expect(runPlainText(focused)).toEqual({ sent: [], toasts: [toast] });
  });
});
