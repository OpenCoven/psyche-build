import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
const yamlMarketingVersionDecoy =
  '    RELEASE_NOTES: |-\n      Example only:\n      MARKETING_VERSION: 9.9.8\n';
const xcodeMarketingVersionDecoy =
  '\t\t\t\t/* Example only:\n\t\t\t\tMARKETING_VERSION = 9.9.7;\n\t\t\t\t*/\n';

async function writeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'psyche-release-version-'));
  temporaryRoots.push(root);

  const nativeRoot = path.join(root, 'native/desktop/psyche-build-tauri');
  const tauriRoot = path.join(nativeRoot, 'src-tauri');
  const iosRoot = path.join(root, 'native/ios');
  const xcodeProjectRoot = path.join(iosRoot, 'Psyche.xcodeproj');
  const mcpRoot = path.join(root, 'src/mcp');
  await mkdir(tauriRoot, { recursive: true });
  await mkdir(xcodeProjectRoot, { recursive: true });
  await mkdir(mcpRoot, { recursive: true });

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
    writeFile(
      path.join(iosRoot, 'project.yml'),
      `name: Psyche\nsettings:\n  base:\n    MARKETING_VERSION: 0.0.5\n    CURRENT_PROJECT_VERSION: 1\n    SWIFT_VERSION: "6.0"\n${yamlMarketingVersionDecoy}targets:\n  PsycheApp:\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: build.psyche.fixture\n`,
    ),
    writeFile(
      path.join(xcodeProjectRoot, 'project.pbxproj'),
      `// !$*UTF8*$!\n{\n\tobjects = {\n\t\tDEBUG /* Debug */ = {\n\t\t\tbuildSettings = {\n${xcodeMarketingVersionDecoy}\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 0.0.3;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = build.psyche.fixture;\n\t\t\t};\n\t\t};\n\t\tRELEASE /* Release */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 0.0.3;\n\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";\n\t\t\t};\n\t\t};\n\t};\n}\n`,
    ),
    writeFile(
      path.join(mcpRoot, 'server.ts'),
      "const SERVER_VERSION = '0.0.9';\n",
    ),
  ]);

  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release version contract', () => {
  it('ships the release runbook referenced by the packaged README', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      files?: string[];
    };

    expect(packageJson.files).toContain('docs/RELEASE.md');
  });

  it('ships the agent surface guide referenced by the packaged README', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
      files?: string[];
    };

    expect(packageJson.files).toContain('docs/AGENT-SURFACE-CONTROL.md');
  });

  it('normalizes stable release tags and rejects unsupported forms', () => {
    expect(normalizeReleaseTag('v0.1.0')).toBe('0.1.0');
    expect(normalizeReleaseTag('0.1.0')).toBe('0.1.0');
    expect(() => normalizeReleaseTag('v0.1')).toThrow(/MAJOR\.MINOR\.PATCH/);
    expect(() => normalizeReleaseTag('v0.1.0-beta.1')).toThrow(/stable/);
    expect(() => normalizeReleaseTag('release-0.1.0')).toThrow(/MAJOR\.MINOR\.PATCH/);
  });

  it('reports every manifest that disagrees with the requested release', async () => {
    const root = await writeFixture();

    expect(() => assertReleaseVersion(root, 'v0.0.1')).toThrow(
      /package\.json \(0\.0\.11\)[\s\S]*native\/desktop\/psyche-build-tauri\/package\.json \(0\.0\.7\)[\s\S]*Cargo\.toml \(0\.0\.7\)[\s\S]*Cargo\.lock \(0\.0\.7\)[\s\S]*tauri\.conf\.json \(0\.0\.7\)[\s\S]*native\/ios\/project\.yml \(0\.0\.5\)[\s\S]*native\/ios\/Psyche\.xcodeproj\/project\.pbxproj \(0\.0\.3\)[\s\S]*src\/mcp\/server\.ts \(0\.0\.9\)/,
    );
  });

  it('ignores marketing-version examples in YAML blocks and Xcode comments', async () => {
    const root = await writeFixture();

    expect(readReleaseVersions(root)).toMatchObject({
      iosProjectYml: '0.0.5',
      iosXcodeProject: '0.0.3',
    });
  });

  it('updates every release manifest without changing unrelated values', async () => {
    const root = await writeFixture();

    await setReleaseVersion(root, '0.0.1');
    await expect(setReleaseVersion(root, '0.0.1')).resolves.toBe('0.0.1');

    expect(readReleaseVersions(root)).toEqual({
      packageJson: '0.0.1',
      nativePackageJson: '0.0.1',
      cargoToml: '0.0.1',
      cargoLock: '0.0.1',
      tauriConfig: '0.0.1',
      iosProjectYml: '0.0.1',
      iosXcodeProject: '0.0.1',
      mcpServer: '0.0.1',
    });
    expect(() => assertReleaseVersion(root, 'v0.0.1')).not.toThrow();

    const [rootPackage, tauriConfig, cargoToml, cargoLock, iosProjectYml, iosXcodeProject] =
      await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(
        path.join(root, 'native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json'),
        'utf8',
      ),
      readFile(path.join(root, 'native/desktop/psyche-build-tauri/src-tauri/Cargo.toml'), 'utf8'),
      readFile(path.join(root, 'native/desktop/psyche-build-tauri/src-tauri/Cargo.lock'), 'utf8'),
      readFile(path.join(root, 'native/ios/project.yml'), 'utf8'),
      readFile(path.join(root, 'native/ios/Psyche.xcodeproj/project.pbxproj'), 'utf8'),
    ]);
    expect(JSON.parse(rootPackage)).toMatchObject({ name: 'psyche-build', private: false });
    expect(tauriConfig).toContain('"targets": ["dmg", "app"]');
    expect(cargoToml).toContain('edition = "2021"');
    expect(cargoLock).toContain('name = "other"\nversion = "9.9.9"');
    expect(iosProjectYml).toContain(
      '    MARKETING_VERSION: 0.0.1\n    CURRENT_PROJECT_VERSION: 1\n    SWIFT_VERSION: "6.0"',
    );
    expect(iosProjectYml).toContain('PRODUCT_BUNDLE_IDENTIFIER: build.psyche.fixture');
    expect(iosProjectYml).toContain(yamlMarketingVersionDecoy);
    expect(iosXcodeProject).toContain(
      '\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 0.0.1;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = build.psyche.fixture;',
    );
    expect(iosXcodeProject).toContain(
      '\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tMARKETING_VERSION = 0.0.1;\n\t\t\t\tSWIFT_OPTIMIZATION_LEVEL = "-O";',
    );
    expect(iosXcodeProject).toContain(xcodeMarketingVersionDecoy);
  });

  it('rejects generated Xcode projects without consistent marketing versions', async () => {
    const root = await writeFixture();
    const xcodeProjectPath = path.join(root, 'native/ios/Psyche.xcodeproj/project.pbxproj');
    const contents = await readFile(xcodeProjectPath, 'utf8');

    await writeFile(
      xcodeProjectPath,
      contents.replace('MARKETING_VERSION = 0.0.3;', 'MARKETING_VERSION = 0.0.4;'),
    );
    expect(() => readReleaseVersions(root)).toThrow(
      /native\/ios\/Psyche\.xcodeproj\/project\.pbxproj[\s\S]*inconsistent MARKETING_VERSION/,
    );

    await writeFile(
      xcodeProjectPath,
      contents.replaceAll(/^[ \t]*MARKETING_VERSION = [^;]+;\n/gm, ''),
    );
    expect(() => readReleaseVersions(root)).toThrow(
      /native\/ios\/Psyche\.xcodeproj\/project\.pbxproj[\s\S]*does not contain MARKETING_VERSION/,
    );
  });

  it('does not write any release file when a later manifest is invalid', async () => {
    const root = await writeFixture();
    const releaseFiles = [
      'package.json',
      'native/desktop/psyche-build-tauri/package.json',
      'native/desktop/psyche-build-tauri/src-tauri/Cargo.toml',
      'native/desktop/psyche-build-tauri/src-tauri/Cargo.lock',
      'native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json',
      'native/ios/project.yml',
      'native/ios/Psyche.xcodeproj/project.pbxproj',
      'src/mcp/server.ts',
    ].map((relativePath) => path.join(root, relativePath));
    const xcodeProjectPath = path.join(root, 'native/ios/Psyche.xcodeproj/project.pbxproj');
    const xcodeProject = await readFile(xcodeProjectPath, 'utf8');
    await writeFile(
      xcodeProjectPath,
      xcodeProject.replace('MARKETING_VERSION = 0.0.3;', 'MARKETING_VERSION = 0.0.4;'),
    );
    const before = await Promise.all(releaseFiles.map((filePath) => readFile(filePath, 'utf8')));

    await expect(setReleaseVersion(root, '0.0.1')).rejects.toThrow(
      /inconsistent MARKETING_VERSION/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await Promise.all(releaseFiles.map((filePath) => readFile(filePath, 'utf8')));
    expect(after).toEqual(before);
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
