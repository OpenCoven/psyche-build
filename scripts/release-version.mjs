#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const relativePaths = {
  packageJson: 'package.json',
  nativePackageJson: 'native/macos/psyche-build-tauri/package.json',
  cargoToml: 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml',
  cargoLock: 'native/macos/psyche-build-tauri/src-tauri/Cargo.lock',
  tauriConfig: 'native/macos/psyche-build-tauri/src-tauri/tauri.conf.json',
  iosProjectYml: 'native/ios/project.yml',
  iosXcodeProject: 'native/ios/Psyche.xcodeproj/project.pbxproj',
};

const labels = {
  packageJson: relativePaths.packageJson,
  nativePackageJson: relativePaths.nativePackageJson,
  cargoToml: relativePaths.cargoToml,
  cargoLock: relativePaths.cargoLock,
  tauriConfig: relativePaths.tauriConfig,
  iosProjectYml: relativePaths.iosProjectYml,
  iosXcodeProject: relativePaths.iosXcodeProject,
};

const yamlMarketingVersion =
  /^[ \t]*MARKETING_VERSION[ \t]*:[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#\r\n]+))[ \t]*(?:#.*)?$/gm;
const xcodeMarketingVersion =
  /^[ \t]*MARKETING_VERSION[ \t]*=[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^;\s\r\n]+))[ \t]*;[ \t]*(?:\/\*.*\*\/[ \t]*)?$/gm;

export function normalizeReleaseTag(value) {
  const candidate = value.startsWith('v') ? value.slice(1) : value;
  if (/^\d+\.\d+\.\d+-/.test(candidate)) {
    throw new Error(`Release version must be stable; received "${value}"`);
  }
  if (!STABLE_VERSION.test(candidate)) {
    throw new Error(`Release version must use MAJOR.MINOR.PATCH; received "${value}"`);
  }
  return candidate;
}

function readJsonVersion(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  if (typeof parsed.version !== 'string') {
    throw new Error(`${filePath} does not contain a string version`);
  }
  return parsed.version;
}

function readCargoPackageVersion(contents, filePath) {
  const packageHeader = '[package]\n';
  const packageStart = contents.indexOf(packageHeader);
  if (packageStart < 0) {
    throw new Error(`${filePath} does not contain [package].version`);
  }
  const blockStart = packageStart + packageHeader.length;
  const nextSection = contents.indexOf('\n[', blockStart);
  const packageBlock = contents.slice(blockStart, nextSection < 0 ? undefined : nextSection);
  const version = packageBlock?.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
  if (!version) {
    throw new Error(`${filePath} does not contain [package].version`);
  }
  return version;
}

function readCargoLockVersion(contents, filePath) {
  const match = contents.match(
    /\[\[package\]\]\nname = "psyche-build-tauri"\nversion = "([^"]+)"/,
  );
  if (!match) {
    throw new Error(`${filePath} does not contain the psyche-build-tauri package`);
  }
  return match[1];
}

function readMarketingVersion(contents, filePath, pattern) {
  const versions = [...contents.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]);
  if (versions.length === 0) {
    throw new Error(`${filePath} does not contain MARKETING_VERSION`);
  }
  const uniqueVersions = [...new Set(versions)];
  if (uniqueVersions.length > 1) {
    throw new Error(
      `${filePath} contains inconsistent MARKETING_VERSION values: ${uniqueVersions.join(', ')}`,
    );
  }
  return uniqueVersions[0];
}

export function readReleaseVersions(root = process.cwd()) {
  const paths = Object.fromEntries(
    Object.entries(relativePaths).map(([key, relativePath]) => [key, path.join(root, relativePath)]),
  );
  return {
    packageJson: readJsonVersion(paths.packageJson),
    nativePackageJson: readJsonVersion(paths.nativePackageJson),
    cargoToml: readCargoPackageVersion(readFileSync(paths.cargoToml, 'utf8'), paths.cargoToml),
    cargoLock: readCargoLockVersion(readFileSync(paths.cargoLock, 'utf8'), paths.cargoLock),
    tauriConfig: readJsonVersion(paths.tauriConfig),
    iosProjectYml: readMarketingVersion(
      readFileSync(paths.iosProjectYml, 'utf8'),
      paths.iosProjectYml,
      yamlMarketingVersion,
    ),
    iosXcodeProject: readMarketingVersion(
      readFileSync(paths.iosXcodeProject, 'utf8'),
      paths.iosXcodeProject,
      xcodeMarketingVersion,
    ),
  };
}

export function assertReleaseVersion(root, tag) {
  const expected = normalizeReleaseTag(tag);
  const versions = readReleaseVersions(root);
  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== expected)
    .map(([key, version]) => `- ${labels[key]} (${version})`);
  if (mismatches.length > 0) {
    throw new Error(
      `Release version ${expected} does not match:\n${mismatches.join('\n')}`,
    );
  }
  return expected;
}

function replaceJsonVersion(contents, version) {
  const parsed = JSON.parse(contents);
  if (typeof parsed.version !== 'string') {
    throw new Error('JSON manifest does not contain a string version');
  }
  const versionProperty = /(^[ \t]*"version"[ \t]*:[ \t]*")[^"]+("[ \t]*,?)/m;
  if (!versionProperty.test(contents)) {
    throw new Error('JSON manifest does not contain a writable version');
  }
  return contents.replace(versionProperty, `$1${version}$2`);
}

function replaceCargoPackageVersion(contents, version, filePath) {
  const packageVersion = /(^\[package\]\n[\s\S]*?^version\s*=\s*")[^"]+("$)/m;
  if (!packageVersion.test(contents)) {
    throw new Error(`${filePath} does not contain [package].version`);
  }
  return contents.replace(packageVersion, `$1${version}$2`);
}

function replaceCargoLockVersion(contents, version, filePath) {
  const packageVersion =
    /(\[\[package\]\]\nname = "psyche-build-tauri"\nversion = ")[^"]+("\n)/;
  if (!packageVersion.test(contents)) {
    throw new Error(`${filePath} does not contain the psyche-build-tauri package`);
  }
  return contents.replace(packageVersion, `$1${version}$2`);
}

function replaceMarketingVersions(contents, version, filePath, pattern, replacementPattern) {
  readMarketingVersion(contents, filePath, pattern);
  return contents.replace(
    replacementPattern,
    (_match, prefix, doubleQuoted, singleQuoted, bare, suffix) => {
      const replacement =
        doubleQuoted !== undefined
          ? `"${version}"`
          : singleQuoted !== undefined
            ? `'${version}'`
            : version;
      return `${prefix}${replacement}${suffix}`;
    },
  );
}

export async function setReleaseVersion(root, value) {
  const version = normalizeReleaseTag(value);
  const paths = Object.fromEntries(
    Object.entries(relativePaths).map(([key, relativePath]) => [key, path.join(root, relativePath)]),
  );
  const contents = Object.fromEntries(
    Object.entries(paths).map(([key, filePath]) => [key, readFileSync(filePath, 'utf8')]),
  );

  await Promise.all([
    writeFile(paths.packageJson, replaceJsonVersion(contents.packageJson, version)),
    writeFile(paths.nativePackageJson, replaceJsonVersion(contents.nativePackageJson, version)),
    writeFile(paths.tauriConfig, replaceJsonVersion(contents.tauriConfig, version)),
    writeFile(
      paths.cargoToml,
      replaceCargoPackageVersion(contents.cargoToml, version, paths.cargoToml),
    ),
    writeFile(
      paths.cargoLock,
      replaceCargoLockVersion(contents.cargoLock, version, paths.cargoLock),
    ),
    writeFile(
      paths.iosProjectYml,
      replaceMarketingVersions(
        contents.iosProjectYml,
        version,
        paths.iosProjectYml,
        yamlMarketingVersion,
        /(^[ \t]*MARKETING_VERSION[ \t]*:[ \t]*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#\r\n]+))([ \t]*(?:#.*)?$)/gm,
      ),
    ),
    writeFile(
      paths.iosXcodeProject,
      replaceMarketingVersions(
        contents.iosXcodeProject,
        version,
        paths.iosXcodeProject,
        xcodeMarketingVersion,
        /(^[ \t]*MARKETING_VERSION[ \t]*=[ \t]*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^;\s\r\n]+))([ \t]*;[ \t]*(?:\/\*.*\*\/[ \t]*)?$)/gm,
      ),
    ),
  ]);
  return version;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[1] === '--') {
    args.splice(1, 1);
  }
  const [mode, value, ...rest] = args;
  if (rest.length > 0 || !['--set', '--check'].includes(mode) || !value) {
    throw new Error(
      'Usage: node scripts/release-version.mjs --set MAJOR.MINOR.PATCH | --check vMAJOR.MINOR.PATCH',
    );
  }

  if (mode === '--set') {
    const version = await setReleaseVersion(process.cwd(), value);
    console.log(`Set Psyche Build release version to ${version}`);
    return;
  }

  const version = assertReleaseVersion(process.cwd(), value);
  console.log(`Verified Psyche Build release version ${version}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
