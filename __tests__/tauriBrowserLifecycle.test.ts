import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri');
const mainJs = readFileSync(join(webRoot, 'web/main.js'), 'utf8');
const nativeLib = readFileSync(join(webRoot, 'src-tauri/src/lib.rs'), 'utf8');

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

function rustFunctionSource(source: string, name: string) {
  const match = new RegExp(
    `(?:#\\[tauri::command\\]\\s*)*(?:pub\\s+)?fn\\s+${escapeRegExp(name)}\\s*\\(`
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

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

function tauriHandlerNames(source: string) {
  const match = /\.invoke_handler\(tauri::generate_handler!\[(?<body>[\s\S]*?)\]\)/.exec(source);
  if (!match?.groups?.body) throw new Error('missing tauri handler list');

  return match.groups.body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => line.replace(/,$/, ''));
}

describe('Tauri native browser lifecycle', () => {
  it('documents the browser lifecycle source contract', () => {
    const destroyBrowserWebview = rustFunctionSource(nativeLib, 'destroy_browser_webview');
    expect(destroyBrowserWebview).toMatch(
      /^fn destroy_browser_webview\(app: &AppHandle, label: Option<String>\) -> Result<\(\), String> \{\n\s*let label = safe_browser_label\(label\);\n\s*if let Some\(webview\) = app\.get_webview\(&label\) \{\n\s*webview\.close\(\)\.map_err\(\|error\| error\.to_string\(\)\)\?;\n\s*\}\n\s*Ok\(\(\)\)\n\}$/s,
    );

    const browserDestroy = rustFunctionSource(nativeLib, 'browser_destroy');
    expect(browserDestroy).toMatch(
      /^#\[tauri::command\]\nfn browser_destroy\(app: AppHandle, label: Option<String>\) -> Result<\(\), String> \{\n\s*destroy_browser_webview\(&app, label\)\n\}$/s,
    );

    const browserDestroyMany = rustFunctionSource(nativeLib, 'browser_destroy_many');
    expect(browserDestroyMany).toContain('#[tauri::command]\nfn browser_destroy_many(');
    expect(browserDestroyMany).toContain('for label in labels {');
    expect(browserDestroyMany).toContain('destroy_browser_webview(&app, Some(label))?;');

    const handlers = tauriHandlerNames(nativeLib);
    const first = handlers.indexOf('browser_hide_all_except');
    const last = handlers.indexOf('browser_reload');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    expect(
      handlers.slice(first, last + 1),
    ).toEqual([
      'browser_hide_all_except',
      'browser_destroy',
      'browser_destroy_many',
      'browser_reload',
    ]);
  });
});
