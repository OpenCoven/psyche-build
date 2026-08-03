import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { readReleaseNotes } from '../scripts/release-notes.mjs';

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const releaseNotesScript = path.resolve('scripts/release-notes.mjs');

async function writeFixture(changelog: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-release-notes-'));
  temporaryRoots.push(root);
  await writeFile(path.join(root, 'CHANGELOG.md'), changelog);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release notes contract', () => {
  it('reads exactly one complete version entry and its TestFlight summary', async () => {
    const root = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### Highlights

- Syntax-highlighted editor.

### TestFlight: What to Test

#### Launch

- Launch the app and inspect compact navigation.

## [0.0.2] - 2026-08-04

### TestFlight: What to Test

- Later release.
`);

    const notes = readReleaseNotes(root, '0.0.1');

    expect(notes.github).toContain('## [0.0.1] - 2026-08-03');
    expect(notes.github).toContain('Syntax-highlighted editor');
    expect(notes.github).not.toContain('## [0.0.2]');
    expect(notes.testFlight).toContain('Launch');
    expect(notes.testFlight).toContain('Launch the app and inspect compact navigation.');
    expect(notes.testFlight).not.toMatch(/^#+\s/m);
    expect(notes.testFlight.length).toBeLessThanOrEqual(4_000);
  });

  it('rejects duplicate version entries', async () => {
    const duplicateRoot = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### TestFlight: What to Test

- First entry.

## [0.0.1] - 2026-08-04

### TestFlight: What to Test

- Duplicate entry.
`);

    expect(() => readReleaseNotes(duplicateRoot, '0.0.1')).toThrow(/exactly one/);
  });

  it('rejects missing and unreleased versions', async () => {
    const root = await writeFixture(`
# Changelog

## [0.0.1] - Unreleased

### TestFlight: What to Test

- Preview only.
`);

    expect(() => readReleaseNotes(root, '0.0.2')).toThrow(/exactly one/);
    expect(() => readReleaseNotes(root, '0.0.1')).toThrow(/Unreleased/);
  });

  it('rejects an empty TestFlight section', async () => {
    const emptyRoot = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### TestFlight: What to Test

### Known Limitations

- Internal only.
`);

    expect(() => readReleaseNotes(emptyRoot, '0.0.1')).toThrow(/empty/i);
  });

  it('rejects duplicate TestFlight sections', async () => {
    const duplicateRoot = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### TestFlight: What to Test

- First section.

### TestFlight: What to Test

- Second section.
`);

    expect(() => readReleaseNotes(duplicateRoot, '0.0.1')).toThrow(/exactly one/i);
  });

  it.each(['TBD', '2026-02-30', '2026-8-03'])(
    'rejects non-canonical release date %s',
    async (date) => {
      const root = await writeFixture(`
# Changelog

## [0.0.1] - ${date}

### TestFlight: What to Test

- Launch the app.
`);

      expect(() => readReleaseNotes(root, '0.0.1')).toThrow(/date/i);
    },
  );

  it('accepts exactly 4,000 TestFlight characters and rejects 4,001', async () => {
    const acceptedRoot = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### TestFlight: What to Test

${'x'.repeat(4_000)}
`);
    const rejectedRoot = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### TestFlight: What to Test

${'x'.repeat(4_001)}
`);

    expect(readReleaseNotes(acceptedRoot, '0.0.1').testFlight).toHaveLength(4_000);
    expect(() => readReleaseNotes(rejectedRoot, '0.0.1')).toThrow(/exceed/i);
  });

  it('emits exactly 4,000 bytes from the TestFlight CLI', async () => {
    const root = await writeFixture(`
# Changelog

## [0.0.1] - 2026-08-03

### TestFlight: What to Test

${'x'.repeat(4_000)}
`);

    const result = await execFileAsync(
      process.execPath,
      [releaseNotesScript, '--testflight', '0.0.1'],
      { cwd: root },
    );

    expect(Buffer.byteLength(result.stdout)).toBe(4_000);
  });

  it('ships the changelog in the package', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      files?: string[];
    };

    expect(packageJson.files).toContain('CHANGELOG.md');
  });
});
