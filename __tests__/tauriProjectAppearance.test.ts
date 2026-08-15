import { describe, expect, it } from 'vitest';

import * as projectAppearance from '../native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs';

describe('desktop project appearance model', () => {
  it('ships fixed frozen accent and glyph presets', () => {
    expect(projectAppearance.PROJECT_ACCENTS.map(({ id, rgb }) => ({ id, rgb }))).toEqual([
      { id: 'ruby', rgb: '239 86 100' },
      { id: 'amber', rgb: '232 166 67' },
      { id: 'lime', rgb: '137 201 92' },
      { id: 'teal', rgb: '64 190 159' },
      { id: 'cyan', rgb: '65 185 218' },
      { id: 'blue', rgb: '86 139 235' },
      { id: 'violet', rgb: '145 111 235' },
      { id: 'magenta', rgb: '215 91 180' },
    ]);
    expect(projectAppearance.PROJECT_GLYPHS.map(({ id, value }) => ({ id, value }))).toEqual([
      { id: 'spark', value: '✦' },
      { id: 'diamond', value: '◆' },
      { id: 'command', value: '⌘' },
      { id: 'branch', value: '⑂' },
      { id: 'terminal', value: '>_' },
      { id: 'moon', value: '☾' },
      { id: 'bolt', value: 'ϟ' },
      { id: 'circle', value: '◉' },
    ]);
    expect(Object.isFrozen(projectAppearance.PROJECT_ACCENTS)).toBe(true);
    expect(Object.isFrozen(projectAppearance.PROJECT_GLYPHS)).toBe(true);
    expect(projectAppearance.PROJECT_ACCENTS.every(Object.isFrozen)).toBe(true);
    expect(projectAppearance.PROJECT_GLYPHS.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ['/repo/project/', '/repo/project'],
    ['C:\\Users\\Buns\\project\\', 'c:/Users/Buns/project'],
    ['/', '/'],
    ['C:\\', 'c:/'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(projectAppearance.normalizeProjectAppearanceKey(input)).toBe(expected);
  });

  it('preserves trailing spaces in nonblank roots', () => {
    expect(projectAppearance.normalizeProjectAppearanceKey('/repo/project ')).toBe('/repo/project ');
    expect(projectAppearance.normalizeProjectAppearanceKey('/repo/project ')).not.toBe(
      projectAppearance.normalizeProjectAppearanceKey('/repo/project'),
    );
  });

  it('prefers the normalized root over a renamed project when deriving the automatic accent', () => {
    const first = projectAppearance.resolveProjectAppearance(
      { root: '/repo/project', name: 'Project' },
      {},
    );
    const second = projectAppearance.resolveProjectAppearance(
      { root: '/repo/project/', name: 'Renamed' },
      {},
    );

    expect(first.accent).toEqual(second.accent);
    expect(first.glyph).toBeNull();
    expect(first.customized).toBe(false);
    expect(first.override).toEqual({});
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.override)).toBe(true);
  });

  it('accepts accent-only, glyph-only, and complete overrides', () => {
    const key = '/repo/project';

    expect(projectAppearance.resolveProjectAppearance(
      { root: key, name: 'Project' },
      { [key]: { accent: 'violet' } },
    )).toMatchObject({ accent: { id: 'violet' }, glyph: null, customized: true });

    expect(projectAppearance.resolveProjectAppearance(
      { root: key, name: 'Project' },
      { [key]: { glyph: 'spark' } },
    )).toMatchObject({ glyph: { id: 'spark' }, customized: true });

    expect(projectAppearance.resolveProjectAppearance(
      { root: key, name: 'Project' },
      { [key]: { accent: 'teal', glyph: 'terminal' } },
    )).toMatchObject({
      accent: { id: 'teal' },
      glyph: { id: 'terminal' },
      customized: true,
    });
  });

  it('ignores malformed JSON and unsupported preset ids', () => {
    expect(projectAppearance.parseProjectAppearances('{')).toEqual({});
    expect(projectAppearance.parseProjectAppearances(JSON.stringify({
      '/repo/project/': { accent: 'url(javascript:bad)', glyph: '<script>' },
      '/repo/other/': { accent: 'ruby', glyph: 'moon' },
    }))).toEqual({
      '/repo/other': { accent: 'ruby', glyph: 'moon' },
    });
  });

  it('sanitizes only supported appearance override ids', () => {
    expect(projectAppearance.sanitizeProjectAppearance(null)).toEqual({});
    expect(projectAppearance.sanitizeProjectAppearance(['ruby'])).toEqual({});
    expect(projectAppearance.sanitizeProjectAppearance({
      accent: 'ruby',
      glyph: 'command',
      ignored: true,
    })).toEqual({
      accent: 'ruby',
      glyph: 'command',
    });
    expect(projectAppearance.sanitizeProjectAppearance({
      accent: 'url(javascript:bad)',
      glyph: '<script>',
    })).toEqual({});
  });

  it('updates immutably, clears individual fields, and resets the entry', () => {
    const original = { '/repo/project': { accent: 'ruby', glyph: 'spark' } };
    const withoutGlyph = projectAppearance.updateProjectAppearance(
      original,
      '/repo/project',
      { glyph: null },
    );
    const reset = projectAppearance.updateProjectAppearance(withoutGlyph, '/repo/project', null);

    expect(original['/repo/project']).toEqual({ accent: 'ruby', glyph: 'spark' });
    expect(withoutGlyph).not.toBe(original);
    expect(withoutGlyph).toEqual({ '/repo/project': { accent: 'ruby' } });
    expect(reset).toEqual({});
    expect(projectAppearance.updateProjectAppearance(
      {},
      '/repo/project',
      { accent: 'url(javascript:bad)', glyph: '<script>' },
    )).toEqual({});
  });

  it.each([
    ['undefined', undefined],
    ['string', 'ruby'],
    ['array', ['ruby']],
  ] as const)('treats %s patches as immutable no-ops', (_label, patch) => {
    const original = { '/repo/project': { accent: 'ruby', glyph: 'spark' } };

    expect(() => projectAppearance.updateProjectAppearance(
      original,
      '/repo/project',
      patch as Parameters<typeof projectAppearance.updateProjectAppearance>[2],
    )).not.toThrow();

    const next = projectAppearance.updateProjectAppearance(
      original,
      '/repo/project',
      patch as Parameters<typeof projectAppearance.updateProjectAppearance>[2],
    );

    expect(next).not.toBe(original);
    expect(next).toEqual(original);
  });
});
