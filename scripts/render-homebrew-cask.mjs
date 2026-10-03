#!/usr/bin/env node

// Renders the OpenCoven Homebrew tap's `psyche-build` Cask for a published
// release. Pure: it takes the tap's current Cask text and the release's
// SHA256SUMS text and returns new Cask text. Only the `version` line and the
// two-line `sha256 arm:/intel:` stanza change; every other byte is preserved.
// Anything unexpected — a malformed checksum file, a missing architecture, a
// Cask whose shape no longer matches the published asset names, a downgrade,
// or the same version with different checksums — throws instead of guessing.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const VERSION_LINE = /^( {2}version ")([^"\n]*)(")$/gm;
const SHA256_STANZA = /^( {2}sha256 arm: +")([^"\n]*)(",\n +intel: ")([^"\n]*)(")$/gm;
const ARCH_LINE = '  arch arm: "aarch64", intel: "x86_64"';
const URL_LINE =
  '  url "https://github.com/OpenCoven/psyche-build/releases/download/v#{version}/Psyche-Build-v#{version}-#{arch}.dmg"';

export const CASK_PATH = 'Casks/psyche-build.rb';

/** The two DMG asset names a published release must carry. */
export function releaseAssetNames(version) {
  assertStableVersion(version);
  return {
    arm: `Psyche-Build-v${version}-aarch64.dmg`,
    intel: `Psyche-Build-v${version}-x86_64.dmg`,
  };
}

/** Accepts `vX.Y.Z` or `X.Y.Z` and returns `X.Y.Z`. */
export function normalizeVersion(value) {
  if (typeof value !== 'string') throw new Error('Release version must be a string');
  const candidate = value.startsWith('v') ? value.slice(1) : value;
  assertStableVersion(candidate);
  return candidate;
}

function assertStableVersion(version) {
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
    throw new Error(`Release version must use stable MAJOR.MINOR.PATCH form; received "${version}"`);
  }
}

/**
 * Parses `shasum -a 256` output for exactly the two DMGs of `version`.
 * Rejects blank/garbled lines, duplicate or unexpected entries, uppercase or
 * short digests, and a missing architecture.
 */
export function parseSha256Sums(text, version) {
  if (typeof text !== 'string') throw new Error('SHA256SUMS must be text');
  const names = releaseAssetNames(version);
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.length === 0) throw new Error('SHA256SUMS is empty');

  const digests = new Map();
  for (const [index, line] of body.split('\n').entries()) {
    const match = /^([0-9a-f]{64}) [ *]([^\s/]+)$/.exec(line);
    if (!match) {
      throw new Error(`SHA256SUMS line ${index + 1} is not "<sha256>  <file>"`);
    }
    const [, digest, file] = match;
    if (file !== names.arm && file !== names.intel) {
      throw new Error(`SHA256SUMS lists unexpected file ${file}`);
    }
    if (digests.has(file)) throw new Error(`SHA256SUMS lists ${file} more than once`);
    digests.set(file, digest);
  }

  const arm = digests.get(names.arm);
  const intel = digests.get(names.intel);
  if (!arm) throw new Error(`SHA256SUMS is missing ${names.arm}`);
  if (!intel) throw new Error(`SHA256SUMS is missing ${names.intel}`);
  return { version, arm, intel };
}

function singleMatch(pattern, cask, label) {
  const matches = [...cask.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Cask must contain exactly one ${label}; found ${matches.length}`);
  }
  return matches[0];
}

/** Reads the version and both checksums out of a Cask, validating its shape. */
export function readCaskRelease(cask) {
  if (typeof cask !== 'string') throw new Error('Cask must be text');
  if (!cask.includes('cask "psyche-build" do\n')) {
    throw new Error('Cask is not the psyche-build Cask');
  }
  if (!cask.split('\n').includes(ARCH_LINE)) {
    throw new Error('Cask arch stanza no longer maps arm/intel to aarch64/x86_64');
  }
  if (!cask.split('\n').includes(URL_LINE)) {
    throw new Error('Cask url no longer matches the published release asset names');
  }
  const [, , version] = singleMatch(VERSION_LINE, cask, 'version line');
  const [, , arm, , intel] = singleMatch(SHA256_STANZA, cask, 'sha256 arm:/intel: stanza');
  assertStableVersion(version);
  if (!SHA256.test(arm)) throw new Error('Cask arm sha256 is not a lowercase SHA-256 digest');
  if (!SHA256.test(intel)) throw new Error('Cask intel sha256 is not a lowercase SHA-256 digest');
  return { version, arm, intel };
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Returns `{ cask, changed, previous }`. `changed` is false only when the
 * current Cask already carries exactly this release.
 */
export function renderHomebrewCask(currentCask, release) {
  const { version, arm, intel } = release ?? {};
  assertStableVersion(version);
  if (!SHA256.test(arm ?? '')) throw new Error('arm sha256 must be a lowercase SHA-256 digest');
  if (!SHA256.test(intel ?? '')) throw new Error('intel sha256 must be a lowercase SHA-256 digest');

  const previous = readCaskRelease(currentCask);
  const order = compareVersions(version, previous.version);
  if (order < 0) {
    throw new Error(`Refusing to downgrade the Cask from ${previous.version} to ${version}`);
  }
  if (order === 0) {
    if (previous.arm === arm && previous.intel === intel) {
      return { cask: currentCask, changed: false, previous };
    }
    throw new Error(
      `Cask already declares ${version} with different checksums; refusing to rewrite a published version`,
    );
  }

  const cask = currentCask
    .replace(VERSION_LINE, (_line, open, _old, close) => `${open}${version}${close}`)
    .replace(
      SHA256_STANZA,
      (_stanza, armOpen, _oldArm, intelOpen, _oldIntel, close) =>
        `${armOpen}${arm}${intelOpen}${intel}${close}`,
    );

  const rendered = readCaskRelease(cask);
  if (rendered.version !== version || rendered.arm !== arm || rendered.intel !== intel) {
    throw new Error('Rendered Cask does not carry the requested release');
  }
  return { cask, changed: true, previous };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--cask', '--sums', '--version'].includes(key) || value === undefined) {
      throw new Error(
        'Usage: node scripts/render-homebrew-cask.mjs --cask CASK.rb --sums SHA256SUMS --version vX.Y.Z',
      );
    }
    options[key.slice(2)] = value;
  }
  if (!options.cask || !options.sums || !options.version) {
    throw new Error(
      'Usage: node scripts/render-homebrew-cask.mjs --cask CASK.rb --sums SHA256SUMS --version vX.Y.Z',
    );
  }
  const version = normalizeVersion(options.version);
  const release = parseSha256Sums(readFileSync(options.sums, 'utf8'), version);
  const { cask } = renderHomebrewCask(readFileSync(options.cask, 'utf8'), release);
  process.stdout.write(cask);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
