import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');

function read(relativePath: string): string {
  const absolutePath = resolve(projectRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function plistHasValue(plist: string, key: string, serializedValue: string): boolean {
  return new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*${escapeRegExp(serializedValue)}`
  ).test(plist);
}

describe('iOS production release configuration', () => {
  const projectYml = read('native/ios/project.yml');
  const generatedProject = read('native/ios/Psyche.xcodeproj/project.pbxproj');
  const sourceInfoPlist = read('native/ios/PsycheApp/Resources/Info.plist');
  const exportOptions = read('native/ios/ExportOptions.plist');
  const iosReadme = read('native/ios/README.md');
  const packageJson = JSON.parse(read('package.json')) as {
    scripts?: Record<string, string>;
  };

  test('declares the production app identity and release metadata in XcodeGen', () => {
    expect(projectYml).toContain('PRODUCT_BUNDLE_IDENTIFIER: ai.opencoven.psyche-ios');
    expect(projectYml).toContain('CFBundleDisplayName: Psyche Build');
    expect(projectYml).toContain('PRODUCT_NAME: Psyche Build');
    expect(projectYml).toContain('MARKETING_VERSION: 0.0.2');
    expect(projectYml).toContain('CURRENT_PROJECT_VERSION: 1');
    expect(projectYml).toContain('CODE_SIGN_STYLE: Automatic');
    expect(projectYml).toContain('path: PsycheApp/Resources/Info.plist');
    expect(projectYml).toContain('PsycheReleaseCommit: $(PSYCHE_RELEASE_SHA)');
    expect(projectYml).toContain('CFBundleShortVersionString: $(MARKETING_VERSION)');
    expect(projectYml).toContain('CFBundleVersion: $(CURRENT_PROJECT_VERSION)');
    expect(projectYml).not.toContain('INFOPLIST_KEY_PsycheReleaseCommit');
    expect(projectYml).not.toContain('INFOPLIST_KEY_CFBundleDisplayName');
    expect(sourceInfoPlist).toContain('<key>PsycheReleaseCommit</key>');
    expect(sourceInfoPlist).toContain('<string>$(PSYCHE_RELEASE_SHA)</string>');
    expect(sourceInfoPlist).toContain('<key>CFBundleDisplayName</key>');
    expect(sourceInfoPlist).toContain('<string>Psyche Build</string>');
    expect(sourceInfoPlist).toContain('<string>$(MARKETING_VERSION)</string>');
    expect(sourceInfoPlist).toContain('<string>$(CURRENT_PROJECT_VERSION)</string>');
    expect(sourceInfoPlist).toContain('<key>NSBonjourServices</key>');
    expect(sourceInfoPlist).toContain('<string>_psyche._tcp</string>');
    expect(sourceInfoPlist).toContain('<key>NSLocalNetworkUsageDescription</key>');
    expect(generatedProject).toContain(
      'INFOPLIST_FILE = PsycheApp/Resources/Info.plist;'
    );
    expect(generatedProject).not.toContain('INFOPLIST_KEY_PsycheReleaseCommit');
    expect(iosReadme).toContain('PsycheApp/Resources/Info.plist');
  });

  test('declares a system launch screen and complete phone and tablet orientations', () => {
    for (const key of [
      'UILaunchScreen',
      'UISupportedInterfaceOrientations',
      'UISupportedInterfaceOrientations~ipad',
    ]) {
      expect(projectYml).toContain(`${key}:`);
      expect(sourceInfoPlist).toContain(`<key>${key}</key>`);
    }

    expect(sourceInfoPlist).toMatch(/<key>UILaunchScreen<\/key>\s*<dict\/>/);
    expect(sourceInfoPlist).toMatch(
      /<key>UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?<string>UIInterfaceOrientationPortrait<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeLeft<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeRight<\/string>[\s\S]*?<\/array>/,
    );
    expect(sourceInfoPlist).toMatch(
      /<key>UISupportedInterfaceOrientations~ipad<\/key>\s*<array>[\s\S]*?<string>UIInterfaceOrientationPortrait<\/string>[\s\S]*?<string>UIInterfaceOrientationPortraitUpsideDown<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeLeft<\/string>[\s\S]*?<string>UIInterfaceOrientationLandscapeRight<\/string>[\s\S]*?<\/array>/,
    );
  });

  test('uses production identifiers for every generated target', () => {
    expect(projectYml).toContain('PRODUCT_BUNDLE_IDENTIFIER: ai.opencoven.psyche-ios.core');
    expect(projectYml).toContain('PRODUCT_BUNDLE_IDENTIFIER: ai.opencoven.psyche-ios.coretests');
    expect(projectYml).toContain('PRODUCT_BUNDLE_IDENTIFIER: ai.opencoven.psyche-ios.uitests');
    expect(generatedProject).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = "ai.opencoven.psyche-ios";'
    );
    expect(generatedProject).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = "ai.opencoven.psyche-ios.core";'
    );
    expect(generatedProject).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = "ai.opencoven.psyche-ios.coretests";'
    );
    expect(generatedProject).toContain(
      'PRODUCT_BUNDLE_IDENTIFIER = "ai.opencoven.psyche-ios.uitests";'
    );
  });

  test('defines internal-only automatic App Store Connect export options', () => {
    expect(
      plistHasValue(exportOptions, 'method', '<string>app-store-connect</string>')
    ).toBe(true);
    expect(plistHasValue(exportOptions, 'destination', '<string>export</string>')).toBe(true);
    expect(plistHasValue(exportOptions, 'signingStyle', '<string>automatic</string>')).toBe(true);
    expect(plistHasValue(exportOptions, 'manageAppVersionAndBuildNumber', '<false/>')).toBe(
      true
    );
    expect(plistHasValue(exportOptions, 'testFlightInternalTestingOnly', '<true/>')).toBe(true);
    expect(plistHasValue(exportOptions, 'uploadSymbols', '<true/>')).toBe(true);

    const wrongBuildNumberPolicy = exportOptions.replace(
      /(<key>manageAppVersionAndBuildNumber<\/key>\s*)<false\/>/,
      '$1<true/>'
    );
    expect(plistHasValue(wrongBuildNumberPolicy, 'manageAppVersionAndBuildNumber', '<false/>')).toBe(
      false
    );
  });

  test('provides pinned deterministic XcodeGen scripts and documentation', () => {
    expect(packageJson.scripts?.['ios:project:generate']).toBe(
      'xcodegen generate --spec native/ios/project.yml --project native/ios'
    );
    expect(packageJson.scripts?.['ios:project:check']).toBe(
      'pnpm ios:project:generate && git diff --exit-code -- native/ios/Psyche.xcodeproj native/ios/PsycheApp/Resources/Info.plist'
    );
    expect(iosReadme).toContain('XcodeGen 2.45.4');
    expect(iosReadme).toContain(
      '090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef'
    );
    expect(iosReadme).toContain('`$(PSYCHE_RELEASE_SHA)` placeholder');
    expect(iosReadme).toContain('Xcode substitutes the build setting');
    expect(iosReadme).toMatch(/Ordinary\s+builds may record empty provenance/);
    expect(iosReadme).toMatch(/production archive must pass and validate\s+the exact commit SHA/);
  });

  test('detects plist-only XcodeGen drift without touching the real worktree', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'psyche-ios-project-check-'));

    try {
      cpSync(resolve(projectRoot, 'native/ios'), resolve(fixtureRoot, 'native/ios'), {
        recursive: true,
        filter: (source) => !['.build', '.derivedData'].includes(basename(source)),
      });
      writeFileSync(
        resolve(fixtureRoot, 'package.json'),
        JSON.stringify({ scripts: packageJson.scripts }, null, 2)
      );
      execFileSync('git', ['init', '--quiet'], { cwd: fixtureRoot });
      execFileSync('git', ['add', '-f', 'package.json', 'native/ios'], { cwd: fixtureRoot });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Psyche Test',
          '-c',
          'user.email=psyche-test@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--quiet',
          '-m',
          'fixture baseline',
        ],
        { cwd: fixtureRoot }
      );

      const fixtureBin = resolve(fixtureRoot, 'bin');
      const fixtureXcodeGen = resolve(fixtureBin, 'xcodegen');
      mkdirSync(fixtureBin);
      writeFileSync(fixtureXcodeGen, "#!/bin/sh\nprintf '%s\\n' 'fixture xcodegen no-op'\n");
      chmodSync(fixtureXcodeGen, 0o755);

      const fixtureInfoPlist = resolve(
        fixtureRoot,
        'native/ios/PsycheApp/Resources/Info.plist'
      );
      writeFileSync(
        fixtureInfoPlist,
        readFileSync(fixtureInfoPlist, 'utf8').replace(
          '<string>$(PSYCHE_RELEASE_SHA)</string>',
          '<string>drifted</string>'
        )
      );

      const result = spawnSync('pnpm', ['ios:project:check'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
        },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('fixture xcodegen no-op');
      expect(`${result.stdout}\n${result.stderr}`).toContain('PsycheReleaseCommit');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('does not check in an Apple development team', () => {
    const developmentTeamSetting = ['DEVELOPMENT', 'TEAM'].join('_');
    expect(projectYml).not.toContain(developmentTeamSetting);
    expect(generatedProject).not.toContain(developmentTeamSetting);
    expect(sourceInfoPlist).not.toContain(developmentTeamSetting);
    expect(exportOptions).not.toMatch(/<key>teamID<\/key>/);
  });
});
