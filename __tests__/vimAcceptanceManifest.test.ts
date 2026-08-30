import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateVimFixtures, type VimFixtureDocument } from '@opencoven/psyche-vim-core';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_VIM_ACCEPTANCE_ITEMS,
  VIM_ACCEPTANCE_FIXTURE_VERSION,
  VIM_ACCEPTANCE_MANIFEST_VERSION,
  VIM_ACCEPTANCE_PLATFORMS,
  createUnstartedAcceptanceManifest,
  validateAcceptanceManifest,
  type VimAcceptanceItem,
  type VimAcceptanceManifest,
  type VimAcceptancePlatform,
} from '../src/vim/acceptanceManifest.js';

const chromeFixturePath = join(process.cwd(), 'protocol-fixtures/vim/v1/chrome.json');
const matrixDocPath = join(process.cwd(), 'docs/vim/ACCEPTANCE-MATRIX.md');

function unstartedManifest(): VimAcceptanceManifest {
  return JSON.parse(JSON.stringify(createUnstartedAcceptanceManifest())) as VimAcceptanceManifest;
}

function mapItems(
  manifest: VimAcceptanceManifest,
  platform: VimAcceptancePlatform,
  map: (item: VimAcceptanceItem, index: number) => VimAcceptanceItem,
): VimAcceptanceManifest {
  const entry = manifest.platforms[platform];
  return {
    ...manifest,
    platforms: {
      ...manifest.platforms,
      [platform]: { ...entry, items: entry.items.map(map) },
    },
  };
}

function firstItem(manifest: VimAcceptanceManifest, platform: VimAcceptancePlatform): VimAcceptanceItem {
  return manifest.platforms[platform].items[0]!;
}

describe('Vim acceptance manifest v1', () => {
  it('accepts the unstarted manifest with every required item per platform', () => {
    const manifest = createUnstartedAcceptanceManifest();

    expect(() => validateAcceptanceManifest(manifest)).not.toThrow();
    expect(VIM_ACCEPTANCE_MANIFEST_VERSION).toBe(1);
    expect(VIM_ACCEPTANCE_PLATFORMS).toEqual(['desktop', 'web', 'ink', 'ios']);
    for (const platform of VIM_ACCEPTANCE_PLATFORMS) {
      const entry = manifest.platforms[platform];
      expect(entry.fixtureVersion).toBe('vim/v1');
      expect(entry.items.map((item) => item.id)).toEqual(REQUIRED_VIM_ACCEPTANCE_ITEMS[platform]);
      for (const item of entry.items) {
        expect(item.status).toBe('not-run');
        expect(item.gap).toBeTruthy();
      }
    }
    // Validation narrows the type to the manifest contract.
    const narrowed: VimAcceptanceManifest = manifest;
    expect(narrowed.platforms.ios.items.length).toBeGreaterThan(0);
  });

  it('can be filled with passing items only when each cites evidence', () => {
    const manifest = unstartedManifest();
    const completed = VIM_ACCEPTANCE_PLATFORMS.reduce<VimAcceptanceManifest>(
      (accumulator, platform) =>
        mapItems(accumulator, platform, (item) => ({
          id: item.id,
          status: 'pass',
          evidence: `vitest --run <owning suite>; observed 0 failures at commit sha`,
        })),
      manifest,
    );

    expect(() => validateAcceptanceManifest(completed)).not.toThrow();
  });

  it('rejects an unknown platform', () => {
    const manifest = unstartedManifest();
    const drifted = {
      ...manifest,
      platforms: { ...manifest.platforms, watch: manifest.platforms.desktop },
    };

    expect(() => validateAcceptanceManifest(drifted)).toThrow(/unknown platform\(s\) watch/);
  });

  it('rejects a missing platform', () => {
    const manifest = unstartedManifest();
    const { ios: _omitted, ...rest } = manifest.platforms;

    expect(() => validateAcceptanceManifest({ ...manifest, platforms: rest })).toThrow(
      /missing required platform\(s\) ios/,
    );
  });

  it('rejects a bogus status value', () => {
    const manifest = unstartedManifest();
    const id = firstItem(manifest, 'desktop').id;
    const drifted = mapItems(manifest, 'desktop', (item) => ({ ...item, status: 'skipped' as never }));

    expect(() => validateAcceptanceManifest(drifted)).toThrow(
      new RegExp(`desktop item ${id} has status "skipped"; allowed: pass, fail, not-run, unavailable`),
    );
  });

  it('rejects unknown fields at every level', () => {
    const manifest = unstartedManifest();

    expect(() => validateAcceptanceManifest({ ...manifest, generatedBy: 'agent' })).toThrow(
      /manifest has unknown field "generatedBy"/,
    );

    const platformField = {
      ...manifest,
      platforms: { ...manifest.platforms, desktop: { ...manifest.platforms.desktop, reviewed: true } },
    };
    expect(() => validateAcceptanceManifest(platformField)).toThrow(
      /desktop manifest has unknown field "reviewed"/,
    );

    const itemField = mapItems(manifest, 'web', (item) => ({ ...item, reviewed: true }));
    expect(() => validateAcceptanceManifest(itemField)).toThrow(
      /web item has unknown field "reviewed"/,
    );
  });

  it('rejects missing and unknown item ids and duplicates', () => {
    const manifest = unstartedManifest();
    const inkItems = manifest.platforms.ink.items.filter((item) => item.id !== 'focus-restoration');
    expect(() =>
      validateAcceptanceManifest({
        ...manifest,
        platforms: { ...manifest.platforms, ink: { ...manifest.platforms.ink, items: inkItems } },
      }),
    ).toThrow(/ink is missing required acceptance item\(s\) focus-restoration/);

    const unknown = mapItems(manifest, 'ink', (item, index) =>
      index === 0 ? { ...item, id: 'ink-parallel-commands' } : item,
    );
    expect(() => validateAcceptanceManifest(unknown)).toThrow(
      /ink has unknown acceptance item ink-parallel-commands/,
    );

    const desktopItems = manifest.platforms.desktop.items;
    const duplicated = {
      ...manifest,
      platforms: {
        ...manifest.platforms,
        desktop: {
          ...manifest.platforms.desktop,
          items: [...desktopItems, desktopItems[0]!],
        },
      },
    };
    expect(() => validateAcceptanceManifest(duplicated)).toThrow(
      new RegExp(`desktop has duplicate item ${desktopItems[0]!.id}`),
    );
  });

  it('rejects fixture-version drift on any platform', () => {
    const manifest = unstartedManifest();
    const drifted = {
      ...manifest,
      platforms: {
        ...manifest.platforms,
        web: { ...manifest.platforms.web, fixtureVersion: 'vim/v2' as never },
      },
    };

    expect(() => validateAcceptanceManifest(drifted)).toThrow(
      /web must declare fixture version vim\/v1, got "vim\/v2"/,
    );
  });

  it('rejects a wrong manifest schema version', () => {
    const manifest = unstartedManifest();

    expect(() => validateAcceptanceManifest({ ...manifest, version: 2 })).toThrow(
      /manifest must declare version 1/,
    );
  });

  it('enforces evidence and gap discipline per status', () => {
    const manifest = unstartedManifest();
    const passingWithoutEvidence = mapItems(manifest, 'desktop', (item, index) =>
      index === 0 ? { id: item.id, status: 'pass' } : item,
    );
    expect(() => validateAcceptanceManifest(passingWithoutEvidence)).toThrow(
      /desktop item .+ with status pass requires evidence/,
    );

    const passingWithGap = mapItems(manifest, 'web', (item, index) =>
      index === 0 ? { id: item.id, status: 'pass', evidence: 'cmd; result', gap: 'none' } : item,
    );
    expect(() => validateAcceptanceManifest(passingWithGap)).toThrow(
      /web item .+ claims pass but declares a gap/,
    );

    const notRunWithoutGap = mapItems(manifest, 'ios', (item) => {
      const { gap: _omitted, ...rest } = item;
      return rest;
    });
    expect(() => validateAcceptanceManifest(notRunWithoutGap)).toThrow(
      /ios item .+ with status not-run requires gap/,
    );

    const unavailableWithoutGap = mapItems(manifest, 'ink', (item, index) =>
      index === 0 ? { id: item.id, status: 'unavailable' as const } : item,
    );
    expect(() => validateAcceptanceManifest(unavailableWithoutGap)).toThrow(
      /ink item .+ with status unavailable requires gap/,
    );
  });

  it('rejects unbounded strings and item counts', () => {
    const manifest = unstartedManifest();
    const longEvidence = mapItems(manifest, 'desktop', (item, index) =>
      index === 0 ? { id: item.id, status: 'pass' as const, evidence: 'x'.repeat(513) } : item,
    );
    expect(() => validateAcceptanceManifest(longEvidence)).toThrow(
      /desktop item .+ evidence has an invalid string/,
    );

    const tooManyItems = {
      ...manifest,
      platforms: {
        ...manifest.platforms,
        ink: {
          ...manifest.platforms.ink,
          items: Array.from({ length: 65 }, (_, index) => ({
            id: `extra-${index}`,
            status: 'not-run' as const,
            gap: 'x',
          })),
        },
      },
    };
    expect(() => validateAcceptanceManifest(tooManyItems)).toThrow(/ink item count exceeds 64/);
  });

  it('stays in agreement with the canonical v1 protocol fixture', () => {
    const fixtures = JSON.parse(readFileSync(chromeFixturePath, 'utf8')) as VimFixtureDocument;

    expect(() => validateVimFixtures(fixtures)).not.toThrow();
    expect(fixtures.version).toBe(VIM_ACCEPTANCE_FIXTURE_VERSION);
    expect(fixtures.version).toBe('vim/v1');
  });

  it('names every required acceptance item in the acceptance matrix document', () => {
    const matrix = readFileSync(matrixDocPath, 'utf8');

    for (const platform of VIM_ACCEPTANCE_PLATFORMS) {
      for (const id of REQUIRED_VIM_ACCEPTANCE_ITEMS[platform]) {
        expect(matrix, `${platform}:${id} missing from ACCEPTANCE-MATRIX.md`).toContain(`\`${id}\``);
      }
    }
  });
});
