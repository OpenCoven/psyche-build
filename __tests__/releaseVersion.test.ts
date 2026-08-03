import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertReleaseVersion,
  normalizeReleaseTag,
  readReleaseVersions,
  setReleaseVersion,
} from '../scripts/release-version.mjs';

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
const releaseScript = path.resolve('scripts/release-version.mjs');

async function writeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-release-version-'));
  temporaryRoots.push(root);

  const nativeRoot = path.join(root, 'native/macos/psyche-build-tauri');
  const tauriRoot = path.join(nativeRoot, 'src-tauri');
  await mkdir(tauriRoot, { recursive: true });

  await Promise.all([
    writeFile(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'psyche-build', version: '0.0.11', private: false }, null, 2)}\n`,
    ),
    writeFile(
      path.join(nativeRoot, 'package.json'),
      `${JSON.stringify({ name: 'psyche-build-tauri', version: '0.0.7', private: true }, null, 2)}\n`,
    ),
    writeFile(
      path.join(tauriRoot, 'tauri.conf.json'),
      '{\n  "productName": "Psyche Build",\n  "version": "0.0.7",\n  "bundle": {\n    "targets": ["dmg", "app"]\n  }\n}\n',
    ),
    writeFile(
      path.join(tauriRoot, 'Cargo.toml'),
      '[package]\nname = "psyche-build-tauri"\nversion = "0.0.7"\nedition = "2021"\n',
    ),
    writeFile(
      path.join(tauriRoot, 'Cargo.lock'),
      'version = 4\n\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "psyche-build-tauri"\nversion = "0.0.7"\ndependencies = []\n',
    ),
  ]);

  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release version contract', () => {
  it('normalizes stable release tags and rejects unsupported forms', () => {
    expect(normalizeReleaseTag('v0.1.0')).toBe('0.1.0');
    expect(normalizeReleaseTag('0.1.0')).toBe('0.1.0');
    expect(() => normalizeReleaseTag('v0.1')).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => normalizeReleaseTag('v0.1.0-beta.1')).toThrow(/stable/);
    expect(() => normalizeReleaseTag('release-0.1.0')).toThrow(/MAJOR\.MINOR\.PATCH/);
  });

  it('reports every manifest that disagrees with the requested release', async () => {
    const root = await writeFixture();

    expect(() => assertReleaseVersion(root, 'v0.1.0')).toThrow(
      /package\.json \(0\.0\.11\)[\s\S]*native\/macos\/psyche-build-tauri\/package\.json \(0\.0\.7\)[\s\S]*Cargo\.toml \(0\.0\.7\)[\s\S]*Cargo\.lock \(0\.0\.7\)[\s\S]*tauri\.conf\.json \(0\.0\.7\)/,
    );
  });

  it('updates every release manifest without changing unrelated values', async () => {
    const root = await writeFixture();

    await setReleaseVersion(root, '0.1.0');
    await expect(setReleaseVersion(root, '0.1.0')).resolves.toBe('0.1.0');

    expect(readReleaseVersions(root)).toEqual({
      packageJson: '0.1.0',
      nativePackageJson: '0.1.0',
      cargoToml: '0.1.0',
      cargoLock: '0.1.0',
      tauriConfig: '0.1.0',
    });
    expect(() => assertReleaseVersion(root, 'v0.1.0')).not.toThrow();

    const [rootPackage, tauriConfig, cargoToml, cargoLock] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(
        path.join(root, 'native/macos/psyche-build-tauri/src-tauri/tauri.conf.json'),
        'utf8',
      ),
      readFile(path.join(root, 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml'), 'utf8'),
      readFile(path.join(root, 'native/macos/psyche-build-tauri/src-tauri/Cargo.lock'), 'utf8'),
    ]);
    expect(JSON.parse(rootPackage)).toMatchObject({ name: 'psyche-build', private: false });
    expect(tauriConfig).toContain('"targets": ["dmg", "app"]');
    expect(cargoToml).toContain('edition = "2021"');
    expect(cargoLock).toContain('name = "other"\nversion = "9.9.9"');
  });

  it('accepts the argument separator forwarded by pnpm scripts', async () => {
    const root = await writeFixture();

    await execFileAsync(process.execPath, [releaseScript, '--set', '--', '0.1.0'], { cwd: root });
    const result = await execFileAsync(
      process.execPath,
      [releaseScript, '--check', '--', 'v0.1.0'],
      { cwd: root },
    );

    expect(result.stdout).toContain('Verified Psyche Build release version 0.1.0');
  });
});
