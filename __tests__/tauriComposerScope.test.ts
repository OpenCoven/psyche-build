import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/desktop/psyche-build-tauri/web');
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

function routeCommand(line: string) {
  const calls: Array<[string, string?]> = [];
  const commandInput = { value: '' };
  const runCommand = compileRunCommand({
    runShellSigil: (value: string) => calls.push(['shell', value]),
    runPaneSigil: (value: string) => calls.push(['pane', value]),
    findThread: () => ({ kind: 'agent', status: 'running' }),
    state: { activeThreadId: 'focused-pane' },
    toast: () => {},
    sendToThread: (_thread: unknown, text: string) => calls.push(['plain', text]),
    commandHistory: { push: (value: string) => calls.push(['history', value]) },
    rememberCommand: (value: string) => calls.push(['remember', value]),
    commands: [{
      cmd: '/known',
      run: (value: string) => calls.push(['slash', value]),
    }],
    writeToActive: () => {},
    sendToActive: (text: string) => calls.push(['active', text]),
    commandInput,
    openPalette: (value: string) => calls.push(['search', value]),
    syncComposerChrome: () => calls.push(['sync']),
  });

  runCommand(line);
  return { calls, commandInput };
}

describe('Tauri composer target', () => {
  it('keeps the bottom composer ultra-slim', () => {
    expect(stylesCss).toMatch(/--composer-h:\s*36px;/);
    expect(stylesCss).toMatch(
      /\.composer\s*\{[^}]*gap:\s*6px;[^}]*padding:\s*0 8px;[^}]*height:\s*var\(--composer-h\);/s,
    );
    expect(stylesCss).toMatch(
      /#command-input\s*\{[^}]*height:\s*26px;[^}]*border-radius:\s*6px;[^}]*font-size:\s*11\.5px;/s,
    );
    expect(stylesCss).toMatch(
      /\.composer-btn\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;[^}]*border-radius:\s*6px;/s,
    );
    expect(stylesCss).toMatch(
      /\.composer-send\s*\{[^}]*height:\s*26px;[^}]*padding:\s*0 10px;[^}]*border-radius:\s*6px;/s,
    );
  });

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

  it('preserves shell, pane, slash-command, and plain-text routing', () => {
    expect(routeCommand('! echo hello').calls).toEqual([['shell', 'echo hello']]);
    expect(routeCommand('% agent').calls).toEqual([['pane', ' agent']]);
    expect(routeCommand('/known value').calls).toEqual([
      ['history', '/known value'],
      ['remember', '/known value'],
      ['slash', 'value'],
    ]);
    expect(routeCommand('hello').calls).toEqual([['plain', 'hello\n']]);
  });

  it('intercepts session search before plain-text routing', () => {
    const runCommand = functionSource(mainJs, 'runCommand');
    const guard = runCommand.indexOf('if (trimmed.charAt(0) === "?")');
    const plainText = runCommand.indexOf('if (trimmed[0] !== "/")');
    const result = routeCommand('  ? active  ');

    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(plainText);
    expect(result.commandInput.value).toBe('? active');
    expect(result.calls).toEqual([
      ['search', '? active'],
      ['sync'],
    ]);
  });
});
