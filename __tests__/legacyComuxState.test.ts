import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  detectLegacyComuxState,
  formatLegacyComuxWarning,
} from '../src/utils/legacyComuxState.js';

const ROOT = '/repo';
const HOME = '/home/dev';

function detectWith(present: string[]) {
  const set = new Set(present);
  return detectLegacyComuxState({
    projectRoot: ROOT,
    homeDir: HOME,
    exists: (candidate) => set.has(candidate),
  });
}

describe('detectLegacyComuxState', () => {
  it('reports nothing when there is no legacy state', () => {
    expect(detectWith([])).toEqual([]);
  });

  it('flags project hooks that will silently stop firing', () => {
    const findings = detectWith([path.join(ROOT, '.comux-hooks')]);

    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe(path.join(ROOT, '.comux-hooks'));
    expect(findings[0].consequence).toMatch(/no longer run/);
  });

  it('flags a legacy project config directory', () => {
    const findings = detectWith([path.join(ROOT, '.comux')]);
    expect(findings.map((f) => f.path)).toEqual([path.join(ROOT, '.comux')]);
  });

  it('flags global state under the home directory', () => {
    const findings = detectWith([
      path.join(HOME, '.comux'),
      path.join(HOME, '.comux.global.json'),
    ]);
    expect(findings.map((f) => f.path)).toEqual([
      path.join(HOME, '.comux'),
      path.join(HOME, '.comux.global.json'),
    ]);
  });

  it('stays quiet once the psyche equivalent exists', () => {
    const findings = detectWith([
      path.join(ROOT, '.comux-hooks'),
      path.join(ROOT, '.psyche-hooks'),
    ]);
    expect(findings).toEqual([]);
  });

  it('still flags the config dir when only hooks have been migrated', () => {
    const findings = detectWith([
      path.join(ROOT, '.comux-hooks'),
      path.join(ROOT, '.psyche-hooks'),
      path.join(ROOT, '.comux'),
    ]);
    expect(findings.map((f) => f.path)).toEqual([path.join(ROOT, '.comux')]);
  });

  it('still flags legacy config when a new psyche directory has no config yet', () => {
    const findings = detectWith([
      path.join(ROOT, '.comux'),
      path.join(ROOT, '.psyche'),
    ]);

    expect(findings.map((f) => f.path)).toEqual([path.join(ROOT, '.comux')]);
  });

  it('stays quiet after the new project config has been initialized', () => {
    const findings = detectWith([
      path.join(ROOT, '.comux'),
      path.join(ROOT, '.psyche', 'psyche.config.json'),
    ]);

    expect(findings).toEqual([]);
  });

  it('omits home candidates when no home directory is supplied', () => {
    const findings = detectLegacyComuxState({
      projectRoot: ROOT,
      exists: () => true,
    });
    expect(findings.every((f) => f.path.startsWith(ROOT))).toBe(true);
  });
});

describe('formatLegacyComuxWarning', () => {
  it('returns empty string when there is nothing to report', () => {
    expect(formatLegacyComuxWarning([])).toBe('');
  });

  it('names each path, its consequence, and the migration command', () => {
    const text = formatLegacyComuxWarning(detectWith([path.join(ROOT, '.comux-hooks')]));

    expect(text).toContain(path.join(ROOT, '.comux-hooks'));
    expect(text).toContain('no longer run');
    expect(text).toContain('mv .comux-hooks .psyche-hooks');
    expect(text).toContain('s/COMUX_/PSYCHE_/g');
  });
});
