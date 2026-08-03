import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');

function read(relativePath: string): string {
  const absolutePath = resolve(projectRoot, relativePath);
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
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
    expect(projectYml).toContain('MARKETING_VERSION: 0.0.1');
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
    expect(exportOptions).toContain('<key>method</key>');
    expect(exportOptions).toContain('<string>app-store-connect</string>');
    expect(exportOptions).toContain('<key>destination</key>');
    expect(exportOptions).toContain('<string>export</string>');
    expect(exportOptions).toContain('<key>signingStyle</key>');
    expect(exportOptions).toContain('<string>automatic</string>');
    expect(exportOptions).toContain('<key>manageAppVersionAndBuildNumber</key>');
    expect(exportOptions).toContain('<false/>');
    expect(exportOptions).toContain('<key>testFlightInternalTestingOnly</key>');
    expect(exportOptions).toContain('<true/>');
    expect(exportOptions).toContain('<key>uploadSymbols</key>');
  });

  test('provides pinned deterministic XcodeGen scripts and documentation', () => {
    expect(packageJson.scripts?.['ios:project:generate']).toBe(
      'xcodegen generate --spec native/ios/project.yml --project native/ios'
    );
    expect(packageJson.scripts?.['ios:project:check']).toBe(
      'pnpm ios:project:generate && git diff --exit-code -- native/ios/Psyche.xcodeproj'
    );
    expect(iosReadme).toContain('XcodeGen 2.45.4');
    expect(iosReadme).toContain(
      '090ec29491aad50aec10631bf6e62253fed733c50f3aab0f5ffc86bc170bdbef'
    );
  });

  test('does not check in an Apple development team', () => {
    const developmentTeamSetting = ['DEVELOPMENT', 'TEAM'].join('_');
    expect(projectYml).not.toContain(developmentTeamSetting);
    expect(generatedProject).not.toContain(developmentTeamSetting);
    expect(sourceInfoPlist).not.toContain(developmentTeamSetting);
    expect(exportOptions).not.toMatch(/<key>teamID<\/key>/);
  });
});
