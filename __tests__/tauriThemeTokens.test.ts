import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = join(process.cwd(), 'native/macos/psyche-build-tauri/web');
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

  it('keeps the default theme saturated rather than grey', () => {
    const block = themeBlock(defaultTheme) ?? '';
    const term = block.match(/--rgb-term:\s*([0-9,\s]+);/);
    expect(term).not.toBeNull();
    expect(chroma(term![1])).toBeGreaterThanOrEqual(MIN_DEFAULT_CHROMA);
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
