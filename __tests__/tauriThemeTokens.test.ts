import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri/web');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

/** The theme list and default as main.js actually declares them. Parsed rather
 *  than duplicated so adding a theme to main.js fails here until it also has a
 *  block, instead of silently rendering as the neutral :root fallback. */
function declaredThemes() {
  const list = mainJs.match(/var THEMES = \[([^\]]*)\]/);
  if (!list) throw new Error('THEMES not found in main.js');
  const names = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const fallback = mainJs.match(/var DEFAULT_THEME = "([^"]+)"/);
  if (!fallback) throw new Error('DEFAULT_THEME not found in main.js');
  return { names, defaultTheme: fallback[1] };
}

function themeBlock(name: string) {
  const pattern = new RegExp(
    `:root\\[data-theme="${name}"\\]\\s*\\{([^}]*)\\}`,
    's',
  );
  const found = stylesCss.match(pattern);
  return found ? found[1] : null;
}

function customProperties(block: string) {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort();
}

function customProperty(block: string, name: string) {
  const activeCss = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = activeCss.match(new RegExp(`${name}:\\s*([^;]+);`));
  return found ? found[1].replace(/\s+/g, ' ').trim() : null;
}

/** Channel spread: 0 is pure grey, larger is more saturated. */
function chroma(triplet: string) {
  const channels = triplet.split(',').map((n) => Number(n.trim()));
  return Math.max(...channels) - Math.min(...channels);
}

/** Comfortably above the subtle ramp this theme first shipped with (spread 8)
 *  and well under what it carries now (34), so the assertion fails if the
 *  default drifts back toward grey without pinning an exact palette. */
const MIN_DEFAULT_CHROMA = 12;

describe('theme tokens', () => {
  const { names, defaultTheme } = declaredThemes();

  // The regression this file exists for: coven-purple was the default and was
  // documented as "lives in :root, so it needs no block". A later redesign
  // restated :root as a deliberately neutral ramp without adding the block, so
  // the theme most windows run silently lost every surface tint while the five
  // themes that did have blocks kept theirs.
  it.each(names)('%s has its own data-theme block', (name) => {
    expect(themeBlock(name)).not.toBeNull();
  });

  it('never leaves the default theme relying on the :root fallback', () => {
    expect(names).toContain(defaultTheme);
    expect(themeBlock(defaultTheme)).not.toBeNull();
  });

  it('declares the same token set in every theme', () => {
    const blocks = names.map((name) => themeBlock(name));
    const shapes = blocks.map((block) => customProperties(block ?? ''));
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
  });

  it('pins the historical Coven Purple palette', () => {
    const block = themeBlock('coven-purple') ?? '';

    expect({
      rgbAccent: customProperty(block, '--rgb-accent'),
      accent: customProperty(block, '--accent'),
      accentStrong: customProperty(block, '--accent-strong'),
      deep: customProperty(block, '--rgb-deep'),
      surface1: customProperty(block, '--rgb-s1'),
      surface2: customProperty(block, '--rgb-s2'),
      surface3: customProperty(block, '--rgb-s3'),
      terminal: customProperty(block, '--rgb-term'),
      text: customProperty(block, '--text'),
      textSoft: customProperty(block, '--text-soft'),
      muted: customProperty(block, '--muted'),
    }).toEqual({
      rgbAccent: '184, 157, 255',
      accent: '#b89dff',
      accentStrong: '#9d80f0',
      deep: '15, 6, 39',
      surface1: '22, 9, 58',
      surface2: '30, 12, 79',
      surface3: '40, 16, 103',
      terminal: '16, 6, 40',
      text: '#f5f2fb',
      textSoft: '#c8c2d8',
      muted: '#8a8499',
    });
  });

  it('pins the approved Codex Blackish palette', () => {
    const block = themeBlock('codex-blackish') ?? '';

    expect({
      rgbAccent: customProperty(block, '--rgb-accent'),
      accent: customProperty(block, '--accent'),
      accentStrong: customProperty(block, '--accent-strong'),
      deep: customProperty(block, '--rgb-deep'),
      surface1: customProperty(block, '--rgb-s1'),
      surface2: customProperty(block, '--rgb-s2'),
      surface3: customProperty(block, '--rgb-s3'),
      terminal: customProperty(block, '--rgb-term'),
      text: customProperty(block, '--text'),
      textSoft: customProperty(block, '--text-soft'),
      muted: customProperty(block, '--muted'),
    }).toEqual({
      rgbAccent: '196, 202, 214',
      accent: '#c4cad6',
      accentStrong: '#9da6b8',
      deep: '15, 15, 17',
      surface1: '22, 23, 26',
      surface2: '30, 30, 31',
      surface3: '43, 44, 48',
      terminal: '15, 15, 17',
      text: '#f0f1f4',
      textSoft: '#c2c6ce',
      muted: '#858b96',
    });
  });

  it('keeps the default theme saturated rather than grey', () => {
    const block = themeBlock(defaultTheme) ?? '';
    const term = block.match(/--rgb-term:\s*([0-9,\s]+);/);
    expect(term).not.toBeNull();
    expect(chroma(term![1])).toBeGreaterThanOrEqual(MIN_DEFAULT_CHROMA);
  });

  it('ignores commented declarations when matching custom properties', () => {
    expect(customProperty('/* --accent: #111111; */', '--accent')).toBeNull();
    expect(
      customProperty('/* --accent: #111111; */ --accent: #222222;', '--accent'),
    ).toBe('#222222');
  });
});
