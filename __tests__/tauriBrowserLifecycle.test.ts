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

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

describe('Tauri native browser lifecycle', () => {
  it('registers idempotent single and batch webview destruction commands', () => {
    expect(nativeLib).toMatch(
      /fn destroy_browser_webview\([\s\S]*app\.get_webview\(&label\)[\s\S]*webview\.close\(\)/,
    );
    expect(nativeLib).toMatch(
      /fn browser_destroy\([\s\S]*destroy_browser_webview\(&app,\s*label\)/,
    );
    expect(nativeLib).toMatch(
      /fn browser_destroy_many\([\s\S]*for label in labels[\s\S]*destroy_browser_webview\(&app,\s*Some\(label\)\)/,
    );
    expect(nativeLib).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*browser_destroy\s*,\s*browser_destroy_many\s*,/,
    );
  });
});
