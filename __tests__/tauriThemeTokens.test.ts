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

function ruleBlock(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...stylesCss.matchAll(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'gs'))];
  const match = matches[matches.length - 1];
  return match ? match[2] : null;
}

/** Channel spread: 0 is pure grey, larger is more saturated. */
function chroma(triplet: string) {
  const channels = triplet.split(',').map((n) => Number(n.trim()));
  return Math.max(...channels) - Math.min(...channels);
}

const MIN_DEFAULT_ACCENT_CHROMA = 20;
const MAX_DEFAULT_SURFACE_CHROMA = 4;

describe('theme tokens', () => {
  const { names, defaultTheme } = declaredThemes();

  // coven-purple is the persisted default, so it must keep an explicit block
  // that pins the canonical OpenCoven UI palette rather than inheriting the
  // unknown-theme fallback from :root.
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

  it('pins the canonical OpenCoven UI graphite palette', () => {
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
      rgbAccent: '147, 134, 208',
      accent: '#9386d0',
      accentStrong: '#6b5bbf',
      deep: '11, 11, 13',
      surface1: '19, 19, 21',
      surface2: '26, 26, 30',
      surface3: '32, 32, 36',
      terminal: '11, 11, 13',
      text: '#f1eff4',
      textSoft: '#b8b4c0',
      muted: '#7d7883',
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

  it('keeps the default theme graphite with a visible violet accent', () => {
    const block = themeBlock(defaultTheme) ?? '';
    const accent = block.match(/--rgb-accent:\s*([0-9,\s]+);/);
    const term = block.match(/--rgb-term:\s*([0-9,\s]+);/);
    expect(accent).not.toBeNull();
    expect(term).not.toBeNull();
    expect(chroma(accent![1])).toBeGreaterThanOrEqual(MIN_DEFAULT_ACCENT_CHROMA);
    expect(chroma(term![1])).toBeLessThanOrEqual(MAX_DEFAULT_SURFACE_CHROMA);
  });

  it('ignores commented declarations when matching custom properties', () => {
    expect(customProperty('/* --accent: #111111; */', '--accent')).toBeNull();
    expect(
      customProperty('/* --accent: #111111; */ --accent: #222222;', '--accent'),
    ).toBe('#222222');
  });

  it('declares the Dia shell surface tokens in :root', () => {
    expect(stylesCss).toContain(
      '--sidebar-surface: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.55));',
    );
    expect(stylesCss).toContain(
      '--workspace-surface: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.72));',
    );
    expect(stylesCss).toContain('--workspace-radius: 18px;');
  });

  it('maps titlebar and workspace surfaces onto the correct shell regions', () => {
    expect(ruleBlock('.titlebar-sidebar')).toMatch(/background:\s*var\(--sidebar-surface\);/);
    expect(ruleBlock('.sidebar')).toMatch(/background:\s*var\(--sidebar-surface\);/);
    expect(ruleBlock('.titlebar-workspace')).toMatch(/background:\s*var\(--workspace-surface\);/);
    expect(ruleBlock('.detail')).toMatch(/background:\s*var\(--workspace-surface\);/);
    expect(ruleBlock('.workbench')).toMatch(/background:\s*var\(--sidebar-surface\);/);
  });

  it('keeps the shared titlebar/workspace seam borderless', () => {
    expect(stylesCss).not.toMatch(/\.titlebar\s*\{[^}]*border-bottom\s*:/s);
  });

  it('keeps the detail surface square on the bottom edge with only the inward top-left curve', () => {
    const detail = ruleBlock('.detail') ?? '';
    expect(detail).toMatch(/border-radius:\s*var\(--workspace-radius\)\s+0\s+0\s+0;/);
    expect(detail).not.toMatch(/border-bottom-left-radius\s*:/);
    expect(detail).not.toMatch(/border-bottom-right-radius\s*:/);
    expect(detail).not.toMatch(/border-top-right-radius\s*:/);
  });

  it('keeps the titlebar workspace square and the detail as the only curved shell surface', () => {
    for (const selector of [
      '.titlebar',
      '.titlebar-sidebar',
      '.titlebar-workspace',
      '.workbench',
      '.sidebar',
    ]) {
      expect(ruleBlock(selector)).not.toMatch(/border-(?:top-left-)?radius\s*:/);
    }
    expect(ruleBlock('.detail')).toMatch(
      /border-radius:\s*var\(--workspace-radius\)\s+0\s+0\s+0;/,
    );
  });
});
