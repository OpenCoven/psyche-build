import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ROLLBACK_FLOOR_FILE,
  ROLLBACK_FLOOR_PROCEDURE,
  SCHEMA_SOURCE_FILE,
  assertRollbackFloor,
  readProjectConfigSchemaVersion,
  readRollbackFloor,
} from '../scripts/release-rollback-floor.mjs';
import { PROJECT_CONFIG_SCHEMA_VERSION } from '../src/services/ProjectPaneConfig.js';

const execFileAsync = promisify(execFile);
const script = path.resolve('scripts/release-rollback-floor.mjs');
const roots: string[] = [];

const validFloor = {
  release: 'v0.0.2',
  projectConfigSchemaVersion: 1,
  reason: 'v0.0.2 predates the versioned project-config gate (#464).',
};

async function fixture(options: {
  schemaVersion?: number | string;
  floor?: unknown;
  rawFloor?: string;
  schemaSource?: string;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-rollback-floor-'));
  roots.push(root);
  await mkdir(path.join(root, 'src/services'), { recursive: true });
  await writeFile(
    path.join(root, SCHEMA_SOURCE_FILE),
    options.schemaSource ??
      `// header\nexport const PROJECT_CONFIG_SCHEMA_VERSION = ${options.schemaVersion ?? 1};\n`,
  );
  if (options.rawFloor !== undefined || options.floor !== undefined) {
    await mkdir(path.join(root, path.dirname(ROLLBACK_FLOOR_FILE)), { recursive: true });
    await writeFile(
      path.join(root, ROLLBACK_FLOOR_FILE),
      options.rawFloor ?? `${JSON.stringify(options.floor, null, 2)}\n`,
    );
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project-config rollback floor', () => {
  it('passes when the schema version equals the pinned floor', async () => {
    const root = await fixture({ schemaVersion: 1, floor: validFloor });
    expect(assertRollbackFloor(root)).toEqual({ release: 'v0.0.2', schemaVersion: 1 });
  });

  it('fails a bumped schema version, naming the floor file and the procedure', async () => {
    const root = await fixture({ schemaVersion: 2, floor: validFloor });
    let message = '';
    try {
      assertRollbackFloor(root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PROJECT_CONFIG_SCHEMA_VERSION (2)');
    expect(message).toContain('v0.0.2');
    expect(message).toContain(ROLLBACK_FLOOR_FILE);
    expect(message).toContain(ROLLBACK_FLOOR_PROCEDURE);
  });

  it('also fails a schema version below the floor', async () => {
    const root = await fixture({ schemaVersion: 0, floor: validFloor });
    expect(() => assertRollbackFloor(root)).toThrow(/differs from the rollback floor/);
  });

  it('fails closed when the floor file is missing', async () => {
    const root = await fixture({ schemaVersion: 1 });
    expect(() => assertRollbackFloor(root)).toThrow(
      new RegExp(`${ROLLBACK_FLOOR_FILE.replace('.', '\\.')} could not be read`),
    );
  });

  it.each([
    ['invalid JSON', '{ not json'],
    ['a non-object', '[1]'],
    ['a missing release', JSON.stringify({ projectConfigSchemaVersion: 1, reason: 'r' })],
    ['a non-tag release', JSON.stringify({ ...validFloor, release: 'latest' })],
    ['a string schema version', JSON.stringify({ ...validFloor, projectConfigSchemaVersion: '1' })],
    ['a fractional schema version', JSON.stringify({ ...validFloor, projectConfigSchemaVersion: 1.5 })],
    ['a zero schema version', JSON.stringify({ ...validFloor, projectConfigSchemaVersion: 0 })],
    ['an empty reason', JSON.stringify({ ...validFloor, reason: '  ' })],
    ['an unknown field', JSON.stringify({ ...validFloor, extra: true })],
  ])('fails closed on a floor file with %s', async (_label, rawFloor) => {
    const root = await fixture({ schemaVersion: 1, rawFloor });
    expect(() => readRollbackFloor(root)).toThrow(ROLLBACK_FLOOR_FILE);
    expect(() => assertRollbackFloor(root)).toThrow(ROLLBACK_FLOOR_FILE);
  });

  it.each([
    ['no declaration', 'export const OTHER = 1;\n'],
    [
      'two declarations',
      'export const PROJECT_CONFIG_SCHEMA_VERSION = 1;\nexport const PROJECT_CONFIG_SCHEMA_VERSION = 1;\n',
    ],
    ['a computed value', 'export const PROJECT_CONFIG_SCHEMA_VERSION = BASE + 1;\n'],
  ])('fails closed when the schema source has %s', async (_label, schemaSource) => {
    const root = await fixture({ schemaSource, floor: validFloor });
    expect(() => readProjectConfigSchemaVersion(root)).toThrow(SCHEMA_SOURCE_FILE);
  });

  it('pins the checked-in floor to the running schema version', () => {
    const floor = JSON.parse(readFileSync(ROLLBACK_FLOOR_FILE, 'utf8'));
    expect(floor.release).toBe('v0.0.2');
    expect(floor.projectConfigSchemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
    expect(readProjectConfigSchemaVersion(process.cwd())).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
    expect(assertRollbackFloor(process.cwd()).schemaVersion).toBe(PROJECT_CONFIG_SCHEMA_VERSION);
  });

  it('documents the floor-raising procedure in the release runbook', () => {
    const runbook = readFileSync('docs/RELEASE.md', 'utf8');
    expect(ROLLBACK_FLOOR_PROCEDURE).toContain('docs/RELEASE.md');
    expect(runbook).toContain('## Project-config rollback floor');
    expect(runbook).toContain(ROLLBACK_FLOOR_FILE);
    expect(runbook).toContain('pnpm release:rollback-floor');
  });

  it('exits non-zero from the CLI when the floor is violated', async () => {
    const root = await fixture({ schemaVersion: 2, floor: validFloor });
    await expect(execFileAsync(process.execPath, [script], { cwd: root })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(ROLLBACK_FLOOR_FILE),
    });
    const ok = await fixture({ schemaVersion: 1, floor: validFloor });
    const { stdout } = await execFileAsync(process.execPath, [script], { cwd: ok });
    expect(stdout).toContain('rollback floor v0.0.2');
  });

  it('is exposed as the release:rollback-floor package script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['release:rollback-floor']).toBe('node scripts/release-rollback-floor.mjs');
  });
});
