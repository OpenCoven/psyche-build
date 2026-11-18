import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `tauri build` refuses to run when an official Tauri JavaScript package and
// its Rust crate differ in major or minor version ("Found version mismatched
// Tauri packages"). Nothing else in CI runs `tauri build`, so a dependency
// bump that moves only one side passes every check and then fails the signed
// release build. That happened to the second 0.0.3 candidate (run
// 44028687527): the npm clipboard plugin was at 2.5.0 and its crate at 2.3.2.

const repoRoot = process.cwd();
const desktopImporter = 'native/desktop/psyche-build-tauri';
const desktopRoot = join(repoRoot, desktopImporter);

interface VersionPair {
  npmName: string;
  npmVersion: string;
  crateName: string;
  crateVersion: string;
}

// `@tauri-apps/api` pairs with the `tauri` crate; `@tauri-apps/plugin-<x>`
// pairs with `tauri-plugin-<x>`. The CLI and other packages have no pair.
export function pairedCrateName(npmName: string): string | null {
  if (npmName === '@tauri-apps/api') return 'tauri';
  const plugin = /^@tauri-apps\/plugin-([a-z0-9-]+)$/.exec(npmName);
  return plugin ? `tauri-plugin-${plugin[1]}` : null;
}

export function lockedNpmVersion(pnpmLock: string, importer: string, npmName: string): string {
  const marker = `\n  ${importer}:\n`;
  const start = pnpmLock.indexOf(marker);
  if (start < 0) throw new Error(`pnpm-lock.yaml has no importer ${importer}`);
  const rest = pnpmLock.slice(start + marker.length);
  const end = rest.search(/^ {0,2}\S/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  const escaped = npmName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const entry = new RegExp(
    `^      '?${escaped}'?:\\n        specifier: .*\\n        version: (\\d+\\.\\d+\\.\\d+)`,
    'm',
  ).exec(block);
  if (!entry) throw new Error(`${importer} has no locked version of ${npmName}`);
  return entry[1];
}

export function lockedCrateVersion(cargoLock: string, crateName: string): string {
  const versions = [
    ...cargoLock.matchAll(
      new RegExp(`^name = "${crateName}"\\nversion = "(\\d+\\.\\d+\\.\\d+)"`, 'gm'),
    ),
  ].map(([, version]) => version);
  if (versions.length !== 1) {
    throw new Error(`Cargo.lock holds ${versions.length} versions of ${crateName}; expected one`);
  }
  return versions[0];
}

function majorMinor(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

export function mismatched(pairs: VersionPair[]): string[] {
  return pairs
    .filter((pair) => majorMinor(pair.npmVersion) !== majorMinor(pair.crateVersion))
    .map(
      (pair) =>
        `${pair.crateName} (v${pair.crateVersion}) : ${pair.npmName} (v${pair.npmVersion})`,
    );
}

function desktopPairs(): VersionPair[] {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pnpmLock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const cargoLock = readFileSync(join(desktopRoot, 'src-tauri/Cargo.lock'), 'utf8');
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  return declared.flatMap((npmName) => {
    const crateName = pairedCrateName(npmName);
    if (!crateName) return [];
    return [
      {
        npmName,
        npmVersion: lockedNpmVersion(pnpmLock, desktopImporter, npmName),
        crateName,
        crateVersion: lockedCrateVersion(cargoLock, crateName),
      },
    ];
  });
}

describe('Tauri JavaScript packages and Rust crates', () => {
  it('pairs the API package and plugin packages with their crates, and nothing else', () => {
    expect(pairedCrateName('@tauri-apps/api')).toBe('tauri');
    expect(pairedCrateName('@tauri-apps/plugin-clipboard-manager')).toBe(
      'tauri-plugin-clipboard-manager',
    );
    expect(pairedCrateName('@tauri-apps/cli')).toBeNull();
    expect(pairedCrateName('codemirror')).toBeNull();
  });

  it('reads the locked versions from both lockfiles', () => {
    const pnpmLock = [
      'importers:',
      '',
      '  other/package:',
      '    dependencies:',
      "      '@tauri-apps/plugin-dialog':",
      '        specifier: 2.0.0',
      '        version: 2.0.0',
      '',
      '  desktop:',
      '    dependencies:',
      "      '@tauri-apps/plugin-dialog':",
      '        specifier: ^2.7.0',
      '        version: 2.7.1',
      '',
      'packages:',
      '',
    ].join('\n');
    const cargoLock = [
      '[[package]]',
      'name = "tauri-plugin-dialog"',
      'version = "2.7.0"',
      '',
      '[[package]]',
      'name = "tauri-plugin-dialog-extra"',
      'version = "9.9.9"',
      '',
    ].join('\n');

    expect(lockedNpmVersion(pnpmLock, 'desktop', '@tauri-apps/plugin-dialog')).toBe('2.7.1');
    expect(lockedCrateVersion(cargoLock, 'tauri-plugin-dialog')).toBe('2.7.0');
    expect(() => lockedNpmVersion(pnpmLock, 'desktop', '@tauri-apps/api')).toThrow(
      'no locked version',
    );
    expect(() => lockedNpmVersion(pnpmLock, 'missing', '@tauri-apps/api')).toThrow('no importer');
    expect(() => lockedCrateVersion(cargoLock, 'tauri')).toThrow('0 versions');
  });

  it('reports a pair whose major or minor version differs, and allows a patch difference', () => {
    const pair = (npmVersion: string, crateVersion: string): VersionPair => ({
      npmName: '@tauri-apps/plugin-clipboard-manager',
      npmVersion,
      crateName: 'tauri-plugin-clipboard-manager',
      crateVersion,
    });

    expect(mismatched([pair('2.5.0', '2.3.2')])).toEqual([
      'tauri-plugin-clipboard-manager (v2.3.2) : @tauri-apps/plugin-clipboard-manager (v2.5.0)',
    ]);
    expect(mismatched([pair('3.3.2', '2.3.2')])).toHaveLength(1);
    expect(mismatched([pair('2.3.3', '2.3.2')])).toEqual([]);
  });

  it('keeps every paired package of the desktop shell on its crate major and minor version', () => {
    const pairs = desktopPairs();

    expect(pairs.map((pair) => pair.npmName)).toContain('@tauri-apps/plugin-clipboard-manager');
    expect(mismatched(pairs)).toEqual([]);
  });
});
