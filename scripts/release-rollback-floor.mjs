#!/usr/bin/env node

// Rollback-safety guard for the project-config schema (#477, update-channel
// design step 5). The oldest release an operator may roll back to (the
// "rollback floor") must be able to read every project config the current
// build writes. v0.0.2 predates the versioned config gate (#464), so it cannot
// refuse a newer schema; it would read the file and could overwrite fields it
// does not understand. This check fails whenever PROJECT_CONFIG_SCHEMA_VERSION
// differs from the value pinned for the current floor.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROLLBACK_FLOOR_FILE = 'release/rollback-floor.json';
export const SCHEMA_SOURCE_FILE = 'src/services/ProjectPaneConfig.ts';
export const ROLLBACK_FLOOR_PROCEDURE =
  'Raise the floor only by following "Project-config rollback floor" in docs/RELEASE.md: ' +
  'a release that understands the config gate must ship first and become the rollback floor.';

const FLOOR_KEYS = ['release', 'projectConfigSchemaVersion', 'reason'];
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const SCHEMA_DECLARATION = /^export const PROJECT_CONFIG_SCHEMA_VERSION = (.*);$/gm;

function readText(root, relativePath) {
  try {
    return readFileSync(path.join(root, relativePath), 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${relativePath} could not be read: ${reason}`, { cause: error });
  }
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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('expected a JSON object');
  }
  const unknown = Object.keys(parsed).filter((key) => !FLOOR_KEYS.includes(key));
  if (unknown.length > 0) {
    throw invalid(`unexpected field(s) ${unknown.join(', ')}`);
  }
  if (typeof parsed.release !== 'string' || !RELEASE_TAG.test(parsed.release)) {
    throw invalid('"release" must be a vMAJOR.MINOR.PATCH tag');
  }
  if (
    typeof parsed.projectConfigSchemaVersion !== 'number' ||
    !Number.isInteger(parsed.projectConfigSchemaVersion) ||
    parsed.projectConfigSchemaVersion < 1
  ) {
    throw invalid('"projectConfigSchemaVersion" must be a positive integer');
  }
  if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0) {
    throw invalid('"reason" must be a non-empty string');
  }
  return {
    release: parsed.release,
    projectConfigSchemaVersion: parsed.projectConfigSchemaVersion,
    reason: parsed.reason,
  };
}

export function readProjectConfigSchemaVersion(root = process.cwd()) {
  const source = readText(root, SCHEMA_SOURCE_FILE);
  const matches = [...source.matchAll(SCHEMA_DECLARATION)];
  if (matches.length !== 1) {
    throw new Error(
      `${SCHEMA_SOURCE_FILE} must declare exactly one "export const PROJECT_CONFIG_SCHEMA_VERSION = <integer>;" (found ${matches.length})`,
    );
  }
  const literal = matches[0][1].trim();
  if (!/^\d+$/.test(literal)) {
    throw new Error(
      `${SCHEMA_SOURCE_FILE} must assign PROJECT_CONFIG_SCHEMA_VERSION an integer literal; found "${literal}"`,
    );
  }
  return Number(literal);
}

export function assertRollbackFloor(root = process.cwd()) {
  const floor = readRollbackFloor(root);
  const schemaVersion = readProjectConfigSchemaVersion(root);
  if (schemaVersion !== floor.projectConfigSchemaVersion) {
    throw new Error(
      [
        `PROJECT_CONFIG_SCHEMA_VERSION (${schemaVersion}) in ${SCHEMA_SOURCE_FILE} differs from the rollback floor ` +
          `${floor.release} (projectConfigSchemaVersion ${floor.projectConfigSchemaVersion}) pinned in ${ROLLBACK_FLOOR_FILE}.`,
        `A rollback to ${floor.release} could read or overwrite a project config it does not understand.`,
        ROLLBACK_FLOOR_PROCEDURE,
      ].join('\n'),
    );
  }
  return { release: floor.release, schemaVersion };
}

function main() {
  if (process.argv.length > 2) {
    throw new Error('Usage: node scripts/release-rollback-floor.mjs');
  }
  const { release, schemaVersion } = assertRollbackFloor(process.cwd());
  console.log(
    `Verified PROJECT_CONFIG_SCHEMA_VERSION ${schemaVersion} matches rollback floor ${release}`,
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
