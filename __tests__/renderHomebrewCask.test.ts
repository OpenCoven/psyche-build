import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeVersion,
  parseSha256Sums,
  readCaskRelease,
  renderHomebrewCask,
} from '../scripts/render-homebrew-cask.mjs';

// Byte-for-byte copy of OpenCoven/homebrew-tap Casks/psyche-build.rb at
// 2247c1d5 (blob 140bbb01), the 0.0.2 bump landed by homebrew-tap#4.
const fixturePath = path.resolve('__tests__/fixtures/homebrew-tap/psyche-build.rb');
const currentCask = readFileSync(fixturePath, 'utf8');

const ARM = 'a'.repeat(64);
const INTEL = 'b'.repeat(64);
const sums = (version: string, arm = ARM, intel = INTEL) =>
  `${arm}  Psyche-Build-v${version}-aarch64.dmg\n${intel}  Psyche-Build-v${version}-x86_64.dmg\n`;

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SHA256SUMS parsing', () => {
  it('reads both architecture digests from shasum output in either order', () => {
    expect(parseSha256Sums(sums('0.0.3'), '0.0.3')).toEqual({ version: '0.0.3', arm: ARM, intel: INTEL });
    const reversed = `${INTEL} *Psyche-Build-v0.0.3-x86_64.dmg\n${ARM}  Psyche-Build-v0.0.3-aarch64.dmg`;
    expect(parseSha256Sums(reversed, '0.0.3')).toEqual({ version: '0.0.3', arm: ARM, intel: INTEL });
  });

  it.each([
    ['empty file', ''],
    ['missing intel', `${ARM}  Psyche-Build-v0.0.3-aarch64.dmg\n`],
    ['missing arm', `${INTEL}  Psyche-Build-v0.0.3-x86_64.dmg\n`],
    ['wrong version', sums('0.0.2')],
    ['uppercase digest', sums('0.0.3', 'A'.repeat(64))],
    ['short digest', sums('0.0.3', 'a'.repeat(63))],
    ['single space separator', `${ARM} Psyche-Build-v0.0.3-aarch64.dmg\n${INTEL}  Psyche-Build-v0.0.3-x86_64.dmg\n`],
    ['duplicate entry', `${sums('0.0.3')}${ARM}  Psyche-Build-v0.0.3-aarch64.dmg\n`],
    ['unexpected extra file', `${sums('0.0.3')}${ARM}  Psyche-Build-v0.0.3-universal.dmg\n`],
    ['blank line', `${ARM}  Psyche-Build-v0.0.3-aarch64.dmg\n\n${INTEL}  Psyche-Build-v0.0.3-x86_64.dmg\n`],
    ['path component', `${ARM}  dist/Psyche-Build-v0.0.3-aarch64.dmg\n${INTEL}  Psyche-Build-v0.0.3-x86_64.dmg\n`],
    ['CRLF line endings', sums('0.0.3').replace(/\n/g, '\r\n')],
  ])('rejects a malformed SHA256SUMS: %s', (_label, text) => {
    expect(() => parseSha256Sums(text, '0.0.3')).toThrow();
  });

  it('accepts only stable versions', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
    for (const bad of ['v1.2', '1.2.3-rc.1', 'v01.2.3', 'latest', '']) {
      expect(() => normalizeVersion(bad)).toThrow();
    }
  });
});

describe('Homebrew Cask rendering', () => {
  it('reads the live tap Cask fixture', () => {
    expect(readCaskRelease(currentCask)).toEqual({
      version: '0.0.2',
      arm: 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103',
      intel: 'f9e19a77d0d7bc746226fa510bf3e34e5d96185e6563e53bb1898f0d9423033e',
    });
  });

  it('changes only the version and checksum lines and preserves every other byte', () => {
    const { cask, changed } = renderHomebrewCask(currentCask, { version: '0.0.3', arm: ARM, intel: INTEL });
    expect(changed).toBe(true);

    const before = currentCask.split('\n');
    const after = cask.split('\n');
    expect(after).toHaveLength(before.length);
    const differing = before.flatMap((line, index) => (line === after[index] ? [] : [index]));
    expect(differing.map((index) => after[index])).toEqual([
      '  version "0.0.3"',
      `  sha256 arm:   "${ARM}",`,
      `         intel: "${INTEL}"`,
    ]);

    // Reversing the three substitutions reproduces the original exactly.
    const restored = cask
      .replace('version "0.0.3"', 'version "0.0.2"')
      .replace(ARM, 'dac0f653e00172e08c7d26f9fb19d7ccbc30af304ac3ed42f6dda91937cc8103')
      .replace(INTEL, 'f9e19a77d0d7bc746226fa510bf3e34e5d96185e6563e53bb1898f0d9423033e');
    expect(Buffer.from(restored).equals(Buffer.from(currentCask))).toBe(true);
    expect(cask.endsWith('end\n')).toBe(true);
  });

  it('is a no-op when the Cask already carries the exact release', () => {
    const release = readCaskRelease(currentCask);
    const result = renderHomebrewCask(currentCask, release);
    expect(result.changed).toBe(false);
    expect(result.cask).toBe(currentCask);
  });

  it('refuses to rewrite a published version with different checksums', () => {
    expect(() => renderHomebrewCask(currentCask, { version: '0.0.2', arm: ARM, intel: INTEL })).toThrow(
      /different checksums/,
    );
  });

  it('refuses to downgrade', () => {
    expect(() => renderHomebrewCask(currentCask, { version: '0.0.1', arm: ARM, intel: INTEL })).toThrow(
      /downgrade/,
    );
  });

  it('rejects invalid digests before reading the Cask', () => {
    expect(() => renderHomebrewCask(currentCask, { version: '0.0.3', arm: 'nope', intel: INTEL })).toThrow();
    expect(() => renderHomebrewCask(currentCask, { version: '0.0.3', arm: ARM, intel: '' })).toThrow();
  });

  it.each([
    ['a duplicated version line', currentCask.replace('  name "Psyche Build"', '  version "9.9.9"\n  name "Psyche Build"')],
    ['a missing sha256 stanza', currentCask.replace(/ {2}sha256 arm:[^\n]*\n[^\n]*\n/, '')],
    ['a single-arch sha256', currentCask.replace(/ {2}sha256 arm:[^\n]*\n[^\n]*\n/, `  sha256 "${ARM}"\n`)],
    ['a changed arch mapping', currentCask.replace('intel: "x86_64"', 'intel: "x64"')],
    ['a url that no longer matches the asset names', currentCask.replace('-#{arch}.dmg', '_#{arch}.dmg')],
    ['a different cask', currentCask.replace('cask "psyche-build"', 'cask "other"')],
  ])('fails closed on a Cask with %s', (_label, cask) => {
    expect(() => renderHomebrewCask(cask, { version: '0.0.3', arm: ARM, intel: INTEL })).toThrow();
  });

  it('renders from the command line without touching the input files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-cask-render-'));
    temporaryRoots.push(root);
    const sumsPath = path.join(root, 'SHA256SUMS');
    await writeFile(sumsPath, sums('0.0.3'));
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve('scripts/render-homebrew-cask.mjs'),
      '--cask',
      fixturePath,
      '--sums',
      sumsPath,
      '--version',
      'v0.0.3',
    ]);
    expect(readCaskRelease(stdout)).toEqual({ version: '0.0.3', arm: ARM, intel: INTEL });
    expect(readFileSync(fixturePath, 'utf8')).toBe(currentCask);

    await writeFile(sumsPath, `${ARM}  Psyche-Build-v0.0.3-aarch64.dmg\n`);
    await expect(
      execFileAsync(process.execPath, [
        path.resolve('scripts/render-homebrew-cask.mjs'),
        '--cask',
        fixturePath,
        '--sums',
        sumsPath,
        '--version',
        'v0.0.3',
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('missing Psyche-Build-v0.0.3-x86_64.dmg') });
  });
});
