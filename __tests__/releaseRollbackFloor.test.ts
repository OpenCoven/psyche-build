import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PINNED_FORMATS,
  ROLLBACK_FLOOR_FILE,
  ROLLBACK_FLOOR_PROCEDURE,
  assertRollbackFloor,
  readPinnedFormatVersion,
  readRollbackFloor,
  type PinnedFormatName,
} from '../scripts/release-rollback-floor.mjs';
import { PANE_LAYOUT_VERSION } from '../src/layout/PaneLayoutTree.js';
import { PANE_SLUG_RECORD_VERSION } from '../src/services/PaneSlugRegistry.js';
import { PROJECT_CONFIG_SCHEMA_VERSION } from '../src/services/ProjectPaneConfig.js';
import { RECOVERY_MARKER_VERSION } from '../src/services/WorktreeRecoveryMarker.js';
import { RITUAL_VERSION } from '../src/utils/rituals.js';
import { PSYCHE_TMUX_CONFIG_VERSION } from '../src/utils/tmuxManagedConfig.js';

const execFileAsync = promisify(execFile);
const script = path.resolve('scripts/release-rollback-floor.mjs');
const roots: string[] = [];

// The values v0.0.2 reads (`git show v0.0.2:<source>`). PROJECT_CONFIG_SCHEMA_VERSION
// and PANE_LAYOUT_VERSION had no named constant in v0.0.2; it wrote unversioned
// project configs and a literal paneLayout.version of 1.
const v002Versions: Record<PinnedFormatName, number> = {
  PROJECT_CONFIG_SCHEMA_VERSION: 1,
  RECOVERY_MARKER_VERSION: 5,
  PANE_SLUG_RECORD_VERSION: 1,
  PSYCHE_TMUX_CONFIG_VERSION: 1,
  RITUAL_VERSION: 1,
  PANE_LAYOUT_VERSION: 1,
};

const liveVersions: Record<PinnedFormatName, number> = {
  PROJECT_CONFIG_SCHEMA_VERSION,
  RECOVERY_MARKER_VERSION,
  PANE_SLUG_RECORD_VERSION,
  PSYCHE_TMUX_CONFIG_VERSION,
  RITUAL_VERSION,
  PANE_LAYOUT_VERSION,
};

const names = Object.keys(PINNED_FORMATS) as PinnedFormatName[];

function floorWith(overrides: Record<string, unknown> = {}) {
  return {
    release: 'v0.0.2',
    reason: 'v0.0.2 predates the versioned project-config gate (#464).',
    persistedFormatVersions: { ...v002Versions },
    ...overrides,
  };
}

async function fixture(options: {
  versions?: Partial<Record<PinnedFormatName, number | string>>;
  floor?: unknown;
  rawFloor?: string;
  sources?: Partial<Record<PinnedFormatName, string>>;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-rollback-floor-'));
  roots.push(root);
  for (const name of names) {
    const file = path.join(root, PINNED_FORMATS[name]);
    await mkdir(path.dirname(file), { recursive: true });
    const value = options.versions?.[name] ?? v002Versions[name];
    await writeFile(
      file,
      options.sources?.[name] ?? `// header\nexport const ${name} = ${value};\nconst OTHER = 9;\n`,
    );
  }
  if (options.rawFloor !== undefined || options.floor !== undefined) {
    await mkdir(path.join(root, path.dirname(ROLLBACK_FLOOR_FILE)), { recursive: true });
    await writeFile(
      path.join(root, ROLLBACK_FLOOR_FILE),
      options.rawFloor ?? `${JSON.stringify(options.floor, null, 2)}\n`,
    );
  }
  return root;
}

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persisted-format rollback floor', () => {
  it('pins exactly the persisted-format constants v0.0.2 must still read', () => {
    expect(names.sort()).toEqual(Object.keys(v002Versions).sort());
  });

  it('passes when every persisted-format version equals the pinned floor', async () => {
    const root = await fixture({ floor: floorWith() });
    expect(assertRollbackFloor(root)).toEqual({ release: 'v0.0.2', versions: v002Versions });
  });

  it.each(names)('fails a bumped %s, naming the constant, the floor file and the procedure', async (name) => {
    const bumped = v002Versions[name] + 1;
    const root = await fixture({ versions: { [name]: bumped }, floor: floorWith() });
    const message = errorOf(() => assertRollbackFloor(root));
    expect(message).toContain(`${name} (${bumped}) in ${PINNED_FORMATS[name]}`);
    expect(message).toContain(`rollback floor value ${v002Versions[name]}`);
    expect(message).toContain('v0.0.2');
    expect(message).toContain(ROLLBACK_FLOOR_FILE);
    expect(message).toContain(ROLLBACK_FLOOR_PROCEDURE);
    for (const other of names.filter((candidate) => candidate !== name)) {
      expect(message).not.toContain(`- ${other} (`);
    }
  });

  it('also fails a version below the floor', async () => {
    const root = await fixture({ versions: { RECOVERY_MARKER_VERSION: 4 }, floor: floorWith() });
    expect(() => assertRollbackFloor(root)).toThrow(/RECOVERY_MARKER_VERSION \(4\)/);
  });

  it('fails closed when the floor file is missing', async () => {
    const root = await fixture({});
    expect(() => assertRollbackFloor(root)).toThrow(`${ROLLBACK_FLOOR_FILE} could not be read`);
  });

  const { RITUAL_VERSION: _omitted, ...withoutRitual } = v002Versions;
  it.each([
    ['invalid JSON', '{ not json'],
    ['a non-object', '[1]'],
    ['a missing release', JSON.stringify({ ...floorWith(), release: undefined })],
    ['a non-tag release', JSON.stringify(floorWith({ release: 'latest' }))],
    ['an empty reason', JSON.stringify(floorWith({ reason: '  ' }))],
    ['an unknown field', JSON.stringify(floorWith({ extra: true }))],
    ['the old single-constant shape', JSON.stringify({ release: 'v0.0.2', projectConfigSchemaVersion: 1, reason: 'r' })],
    ['a missing versions map', JSON.stringify(floorWith({ persistedFormatVersions: undefined }))],
    ['a missing constant', JSON.stringify(floorWith({ persistedFormatVersions: withoutRitual }))],
    [
      'an unknown constant',
      JSON.stringify(floorWith({ persistedFormatVersions: { ...v002Versions, OTHER_VERSION: 1 } })),
    ],
    [
      'a string version',
      JSON.stringify(floorWith({ persistedFormatVersions: { ...v002Versions, RECOVERY_MARKER_VERSION: '5' } })),
    ],
    [
      'a fractional version',
      JSON.stringify(floorWith({ persistedFormatVersions: { ...v002Versions, RITUAL_VERSION: 1.5 } })),
    ],
    [
      'a zero version',
      JSON.stringify(floorWith({ persistedFormatVersions: { ...v002Versions, PANE_LAYOUT_VERSION: 0 } })),
    ],
  ])('fails closed on a floor file with %s', async (_label, rawFloor) => {
    const root = await fixture({ rawFloor });
    expect(() => readRollbackFloor(root)).toThrow(ROLLBACK_FLOOR_FILE);
    expect(() => assertRollbackFloor(root)).toThrow(ROLLBACK_FLOOR_FILE);
  });

  it.each([
    ['no declaration', 'export const OTHER = 1;\n'],
    [
      'two declarations',
      'export const RECOVERY_MARKER_VERSION = 5;\nconst RECOVERY_MARKER_VERSION = 5;\n',
    ],
    ['a computed value', 'export const RECOVERY_MARKER_VERSION = BASE + 1;\n'],
  ])('fails closed when a pinned source has %s', async (_label, source) => {
    const root = await fixture({ sources: { RECOVERY_MARKER_VERSION: source }, floor: floorWith() });
    expect(() => readPinnedFormatVersion(root, 'RECOVERY_MARKER_VERSION')).toThrow(
      PINNED_FORMATS.RECOVERY_MARKER_VERSION,
    );
    expect(() => assertRollbackFloor(root)).toThrow(PINNED_FORMATS.RECOVERY_MARKER_VERSION);
  });

  it.each(names)('pins the checked-in floor for %s to the v0.0.2 value and the live constant', (name) => {
    const floor = JSON.parse(readFileSync(ROLLBACK_FLOOR_FILE, 'utf8'));
    expect(floor.release).toBe('v0.0.2');
    expect(floor.persistedFormatVersions[name]).toBe(v002Versions[name]);
    expect(liveVersions[name]).toBe(v002Versions[name]);
    expect(readPinnedFormatVersion(process.cwd(), name)).toBe(liveVersions[name]);
  });

  it('passes against the repository', () => {
    expect(assertRollbackFloor(process.cwd()).versions).toEqual(liveVersions);
  });

  it('documents the per-constant floor procedure in the release runbook', () => {
    const runbook = readFileSync('docs/RELEASE.md', 'utf8');
    expect(ROLLBACK_FLOOR_PROCEDURE).toContain('docs/RELEASE.md');
    expect(runbook).toContain('## Project-config rollback floor');
    expect(runbook).toContain(ROLLBACK_FLOOR_FILE);
    expect(runbook).toContain('pnpm release:rollback-floor');
    for (const name of names) {
      expect(runbook).toContain(`\`${name}\``);
      expect(runbook).toContain(PINNED_FORMATS[name]);
    }
  });

  it('exits non-zero from the CLI when the floor is violated', async () => {
    const root = await fixture({ versions: { PANE_SLUG_RECORD_VERSION: 2 }, floor: floorWith() });
    await expect(execFileAsync(process.execPath, [script], { cwd: root })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('PANE_SLUG_RECORD_VERSION (2)'),
    });
    const ok = await fixture({ floor: floorWith() });
    const { stdout } = await execFileAsync(process.execPath, [script], { cwd: ok });
    expect(stdout).toContain('rollback floor v0.0.2');
  });

  it('is exposed as the release:rollback-floor package script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['release:rollback-floor']).toBe('node scripts/release-rollback-floor.mjs');
  });
});
