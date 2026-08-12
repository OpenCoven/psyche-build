#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const relativePaths = {
  packageJson: 'package.json',
  nativePackageJson: 'native/desktop/psyche-build-tauri/package.json',
  cargoToml: 'native/desktop/psyche-build-tauri/src-tauri/Cargo.toml',
  cargoLock: 'native/desktop/psyche-build-tauri/src-tauri/Cargo.lock',
  tauriConfig: 'native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json',
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

function assignmentFromMatch(match, lineOffset) {
  const token = match[2];
  const quoted = (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"));
  return {
    value: quoted ? token.slice(1, -1) : token,
    start: lineOffset + match[1].length,
    end: lineOffset + match[1].length + token.length,
  };
}

function findYamlMarketingVersionAssignments(contents) {
  const assignments = [];
  let blockScalarIndent = null;
  let lineOffset = 0;

  for (const lineWithEnding of contents.match(/.*(?:\r\n|\n|$)/g) ?? []) {
    if (lineWithEnding.length === 0) continue;
    const line = lineWithEnding.replace(/\r?\n$/, '');
    const indentation = line.match(/^[ \t]*/)[0].length;
    const blank = /^[ \t]*$/.test(line);

    if (blockScalarIndent !== null) {
      if (blank || indentation > blockScalarIndent) {
        lineOffset += lineWithEnding.length;
        continue;
      }
      blockScalarIndent = null;
    }

    const blockScalar = line.match(
      /^([ \t]*)(?:-[ \t]+)?[^#\r\n][^:\r\n]*:[ \t]*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/,
    );
    if (blockScalar) {
      blockScalarIndent = blockScalar[1].length;
      lineOffset += lineWithEnding.length;
      continue;
    }

    const assignment = line.match(
      /^([ \t]*MARKETING_VERSION[ \t]*:[ \t]*)("[^"\r\n]+"|'[^'\r\n]+'|[^\s#\r\n]+)([ \t]*(?:#.*)?)$/,
    );
    if (assignment) assignments.push(assignmentFromMatch(assignment, lineOffset));
    lineOffset += lineWithEnding.length;
  }

  return assignments;
}

function maskPbxComments(contents) {
  const masked = [...contents];
  let state = 'normal';
  let escaped = false;

  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    const next = contents[index + 1];

    if (state === 'block') {
      if (character === '*' && next === '/') {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        index += 1;
        state = 'normal';
      } else if (character !== '\n' && character !== '\r') {
        masked[index] = ' ';
      }
      continue;
    }
    if (state === 'line') {
      if (character === '\n' || character === '\r') state = 'normal';
      else masked[index] = ' ';
      continue;
    }
    if (state === 'string') {
      if (!escaped && character === '"') state = 'normal';
      escaped = !escaped && character === '\\';
      continue;
    }
    if (character === '"') {
      state = 'string';
      escaped = false;
    } else if (character === '/' && next === '*') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'block';
    } else if (character === '/' && next === '/') {
      masked[index] = ' ';
      masked[index + 1] = ' ';
      index += 1;
      state = 'line';
    }
  }

  return masked.join('');
}

function findXcodeMarketingVersionAssignments(contents) {
  const assignments = [];
  const masked = maskPbxComments(contents);
  let buildSettingsDepth = null;
  let braceDepth = 0;
  let lineOffset = 0;
  let inString = false;
  let escaped = false;

  for (const lineWithEnding of masked.match(/.*(?:\r\n|\n|$)/g) ?? []) {
    if (lineWithEnding.length === 0) continue;
    const line = lineWithEnding.replace(/\r?\n$/, '');

    if (buildSettingsDepth !== null && !inString) {
      const assignment = line.match(
        /^([ \t]*MARKETING_VERSION[ \t]*=[ \t]*)("[^"\r\n]+"|'[^'\r\n]+'|[^;\s\r\n]+)([ \t]*;[ \t]*)$/,
      );
      if (assignment) assignments.push(assignmentFromMatch(assignment, lineOffset));
    }

    const buildSettings = line.match(/^[ \t]*buildSettings[ \t]*=[ \t]*\{/);
    const openingIndex = buildSettings
      ? buildSettings.index + buildSettings[0].lastIndexOf('{')
      : -1;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (inString) {
        if (!escaped && character === '"') inString = false;
        escaped = !escaped && character === '\\';
        continue;
      }
      if (character === '"') {
        inString = true;
        escaped = false;
      } else if (character === '{') {
        braceDepth += 1;
        if (index === openingIndex) buildSettingsDepth = braceDepth;
      } else if (character === '}') {
        braceDepth -= 1;
        if (buildSettingsDepth !== null && braceDepth < buildSettingsDepth) {
          buildSettingsDepth = null;
        }
      }
    }
    lineOffset += lineWithEnding.length;
  }

  return assignments;
}

function readMarketingVersion(assignments, filePath) {
  const versions = assignments.map(({ value }) => value);
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
      findYamlMarketingVersionAssignments(readFileSync(paths.iosProjectYml, 'utf8')),
      paths.iosProjectYml,
    ),
    iosXcodeProject: readMarketingVersion(
      findXcodeMarketingVersionAssignments(readFileSync(paths.iosXcodeProject, 'utf8')),
      paths.iosXcodeProject,
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

function replaceMarketingVersions(contents, version, filePath, findAssignments) {
  const assignments = findAssignments(contents);
  readMarketingVersion(assignments, filePath);
  return assignments.reduceRight((updated, { start, end }) => {
    const token = contents.slice(start, end);
    const replacement = token.startsWith('"')
      ? `"${version}"`
      : token.startsWith("'")
        ? `'${version}'`
        : version;
    return `${updated.slice(0, start)}${replacement}${updated.slice(end)}`;
  }, contents);
}

export async function setReleaseVersion(root, value) {
  const version = normalizeReleaseTag(value);
  const paths = Object.fromEntries(
    Object.entries(relativePaths).map(([key, relativePath]) => [key, path.join(root, relativePath)]),
  );
  const contents = Object.fromEntries(
    Object.entries(paths).map(([key, filePath]) => [key, readFileSync(filePath, 'utf8')]),
  );
  const nextContents = {
    packageJson: replaceJsonVersion(contents.packageJson, version),
    nativePackageJson: replaceJsonVersion(contents.nativePackageJson, version),
    cargoToml: replaceCargoPackageVersion(contents.cargoToml, version, paths.cargoToml),
    cargoLock: replaceCargoLockVersion(contents.cargoLock, version, paths.cargoLock),
    tauriConfig: replaceJsonVersion(contents.tauriConfig, version),
    iosProjectYml: replaceMarketingVersions(
      contents.iosProjectYml,
      version,
      paths.iosProjectYml,
      findYamlMarketingVersionAssignments,
    ),
    iosXcodeProject: replaceMarketingVersions(
      contents.iosXcodeProject,
      version,
      paths.iosXcodeProject,
      findXcodeMarketingVersionAssignments,
    ),
  };

  await Promise.all(
    Object.entries(paths).map(([key, filePath]) => writeFile(filePath, nextContents[key])),
  );
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
