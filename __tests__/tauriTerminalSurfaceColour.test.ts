import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mainJs = readFileSync(
  join(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);

// The extracted functions contain no braces inside strings or regexes, so a
// plain brace count finds their ends.
function functionSource(name: string) {
  const start = mainJs.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing function ${name}`);
  let depth = 0;
  for (let index = mainJs.indexOf('{', start); index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}' && --depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

type FakeNode = { nodeType: 1; background: string; parentElement: FakeNode | null };

function chain(...backgrounds: string[]): FakeNode {
  let parent: FakeNode | null = null;
  for (const background of [...backgrounds].reverse()) {
    parent = { nodeType: 1, background, parentElement: parent };
  }
  return parent as FakeNode;
}

function themeFor(host: FakeNode) {
  const base = /var VIBRANCY_BASE_RGB = \[[^\]]*\];/.exec(mainJs)?.[0];
  if (!base) throw new Error('missing VIBRANCY_BASE_RGB');
  const factory = Function(
    'document',
    'window',
    `"use strict";
    ${base}
    ${functionSource('parseCssRgba')}
    ${functionSource('terminalSurfaceRgb')}
    ${functionSource('terminalTheme')}
    return { terminalTheme, VIBRANCY_BASE_RGB };`,
  );
  return factory(
    { getElementById: () => host },
    { getComputedStyle: (node: FakeNode) => ({ backgroundColor: node.background }) },
  ) as { terminalTheme: () => { background: string }; VIBRANCY_BASE_RGB: number[] };
}

describe('terminal surface colour reported to TUIs', () => {
  it('keeps the canvas transparent while carrying the composited pane colour', () => {
    const host = chain('rgba(0, 0, 0, 0)', 'rgba(10, 20, 30, 0.5)');
    const { terminalTheme, VIBRANCY_BASE_RGB } = themeFor(host);
    const expected = VIBRANCY_BASE_RGB.map((channel, k) =>
      Math.round(channel * 0.5 + [10, 20, 30][k] * 0.5),
    );
    expect(terminalTheme().background).toBe(`rgba(${expected.join(', ')}, 0)`);
  });

  it('stops at the first opaque layer, as solid mode paints', () => {
    const host = chain('rgba(8, 8, 10, 0.55)', 'rgb(40, 41, 42)', 'rgb(255, 255, 255)');
    const background = themeFor(host).terminalTheme().background;
    const expected = [40, 41, 42].map((c, k) => Math.round(c * 0.45 + [8, 8, 10][k] * 0.55));
    expect(background).toBe(`rgba(${expected.join(', ')}, 0)`);
  });

  it('refreshes every terminal when the theme, solid mode or opacity changes', () => {
    for (const name of ['applyTheme', 'applySolidBg', 'applyBgOpacity']) {
      expect(functionSource(name)).toContain('refreshTerminalThemes();');
    }
  });
});
