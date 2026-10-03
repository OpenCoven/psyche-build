#!/usr/bin/env node

// Rollback-safety guard for persisted on-disk formats (#477, update-channel
// design step 5). The oldest release an operator may roll back to (the
// "rollback floor") must be able to read every file the current build writes.
// v0.0.2 predates the versioned project-config gate (#464), so it cannot
// refuse a newer project-config schema, and it rejects worktree-recovery
// markers with an unknown version, which would strand recovery. This check
// fails whenever a pinned persisted-format version differs from the value
// recorded for the current floor.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROLLBACK_FLOOR_FILE = 'release/rollback-floor.json';
export const ROLLBACK_FLOOR_PROCEDURE =
  'Raise the floor only by following "Project-config rollback floor" in docs/RELEASE.md: ' +
  'a release that understands the newer format must ship first and become the rollback floor.';

// Every persisted-format version constant the floor release must still read,
// and the source file that declares it. Adding a persisted format means adding
// it here and to the floor file in the same change.
export const PINNED_FORMATS = Object.freeze({
  PROJECT_CONFIG_SCHEMA_VERSION: 'src/services/ProjectPaneConfig.ts',
  RECOVERY_MARKER_VERSION: 'src/services/WorktreeRecoveryMarker.ts',
  PANE_SLUG_RECORD_VERSION: 'src/services/PaneSlugRegistry.ts',
  PSYCHE_TMUX_CONFIG_VERSION: 'src/utils/tmuxManagedConfig.ts',
  RITUAL_VERSION: 'src/utils/rituals.ts',
  PANE_LAYOUT_VERSION: 'src/layout/PaneLayoutTree.ts',
});

const FLOOR_KEYS = ['release', 'reason', 'persistedFormatVersions'];
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

function readText(root, relativePath) {
  try {
    return readFileSync(path.join(root, relativePath), 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${relativePath} could not be read: ${reason}`, { cause: error });
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readRollbackFloor(root = process.cwd()) {
  const contents = readText(root, ROLLBACK_FLOOR_FILE);
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${ROLLBACK_FLOOR_FILE} is not valid JSON: ${reason}`, { cause: error });
  }
  const invalid = (detail) => new Error(`${ROLLBACK_FLOOR_FILE} is malformed: ${detail}`);
  if (!isPlainObject(parsed)) {
    throw invalid('expected a JSON object');
  }
  const unknown = Object.keys(parsed).filter((key) => !FLOOR_KEYS.includes(key));
  if (unknown.length > 0) {
    throw invalid(`unexpected field(s) ${unknown.join(', ')}`);
  }
  if (typeof parsed.release !== 'string' || !RELEASE_TAG.test(parsed.release)) {
    throw invalid('"release" must be a vMAJOR.MINOR.PATCH tag');
  }
  if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0) {
    throw invalid('"reason" must be a non-empty string');
  }
  const versions = parsed.persistedFormatVersions;
  if (!isPlainObject(versions)) {
    throw invalid('"persistedFormatVersions" must be an object');
  }
  const expected = Object.keys(PINNED_FORMATS);
  const missing = expected.filter((name) => !Object.hasOwn(versions, name));
  const extra = Object.keys(versions).filter((name) => !expected.includes(name));
  if (missing.length > 0) {
    throw invalid(`"persistedFormatVersions" is missing ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    throw invalid(`"persistedFormatVersions" has unknown constant(s) ${extra.join(', ')}`);
  }
  for (const name of expected) {
    const value = versions[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw invalid(`"persistedFormatVersions.${name}" must be a positive integer`);
    }
  }
  return {
    release: parsed.release,
    reason: parsed.reason,
    persistedFormatVersions: Object.fromEntries(expected.map((name) => [name, versions[name]])),
  };
}

export function readPinnedFormatVersion(root, name) {
  const sourceFile = PINNED_FORMATS[name];
  if (!sourceFile) {
    throw new Error(`${name} is not a pinned persisted-format version`);
  }
  const source = readText(root, sourceFile);
  const declaration = new RegExp(`^(?:export )?const ${name} = (.*);$`, 'gm');
  const matches = [...source.matchAll(declaration)];
  if (matches.length !== 1) {
    throw new Error(
      `${sourceFile} must declare exactly one "const ${name} = <integer>;" (found ${matches.length})`,
    );
  }
  const literal = matches[0][1].trim();
  if (!/^\d+$/.test(literal)) {
    throw new Error(`${sourceFile} must assign ${name} an integer literal; found "${literal}"`);
  }
  return Number(literal);
}

export function assertRollbackFloor(root = process.cwd()) {
  const floor = readRollbackFloor(root);
  const versions = {};
  const mismatches = [];
  for (const [name, pinned] of Object.entries(floor.persistedFormatVersions)) {
    const actual = readPinnedFormatVersion(root, name);
    versions[name] = actual;
    if (actual !== pinned) {
      mismatches.push(
        `- ${name} (${actual}) in ${PINNED_FORMATS[name]} differs from the rollback floor value ${pinned}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      [
        `Persisted-format versions differ from the rollback floor ${floor.release} pinned in ${ROLLBACK_FLOOR_FILE}:`,
        ...mismatches,
        `A rollback to ${floor.release} could fail to read, or could overwrite, files it does not understand.`,
        ROLLBACK_FLOOR_PROCEDURE,
      ].join('\n'),
    );
  }
  return { release: floor.release, versions };
}

function main() {
  if (process.argv.length > 2) {
    throw new Error('Usage: node scripts/release-rollback-floor.mjs');
  }
  const { release, versions } = assertRollbackFloor(process.cwd());
  console.log(
    `Verified ${Object.keys(versions).length} persisted-format versions match rollback floor ${release}`,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
