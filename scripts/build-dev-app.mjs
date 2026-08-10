#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  channelConfig,
  runDevBuildSnapshotUnlocked,
} from './build-macos-app.mjs';

const INPUT_KEYS = ['sourceRoot', 'tempRoot', 'devConfigPath', 'snapshotPath'];

export async function runBuildDevAppHelper(argv, deps = {}) {
  if (argv.length !== 1) {
    throw new Error(
      'build-dev-app requires exactly one private input-file path',
    );
  }

  const inputPath = path.resolve(argv[0]);
  let input;

  try {
    input = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Invalid dev build input file at "${inputPath}": ${describeError(error)}`,
      { cause: error },
    );
  }

  validateInput(inputPath, input);
  const runUnlocked =
    deps.runDevBuildSnapshotUnlocked ?? runDevBuildSnapshotUnlocked;
  return runUnlocked(input);
}

function validateInput(inputPath, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput(inputPath, 'input must be an object');
  }

  const unknownKey = Object.keys(input).find((key) => !INPUT_KEYS.includes(key));
  if (unknownKey) {
    throw invalidInput(inputPath, `input contains unknown field "${unknownKey}"`);
  }
  for (const key of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      throw invalidInput(inputPath, `input is missing field "${key}"`);
    }
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) {
      throw invalidInput(inputPath, `${key} must be absolute`);
    }
  }

  const tempRoot = path.resolve(input.tempRoot);
  if (!pathIsInside(tempRoot, inputPath)) {
    throw invalidInput(inputPath, 'private input file must be inside tempRoot');
  }
  if (!pathIsInside(tempRoot, path.resolve(input.devConfigPath))) {
    throw invalidInput(inputPath, 'devConfigPath must be inside tempRoot');
  }
  if (!pathIsInside(tempRoot, path.resolve(input.snapshotPath))) {
    throw invalidInput(inputPath, 'snapshotPath must be inside tempRoot');
  }
  if (path.basename(input.snapshotPath) !== channelConfig('dev').appName) {
    throw invalidInput(
      inputPath,
      `snapshotPath must end in "${channelConfig('dev').appName}"`,
    );
  }
}

function pathIsInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function invalidInput(inputPath, detail) {
  return new Error(`Invalid dev build input file at "${inputPath}": ${detail}`);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isEntrypoint()) {
  try {
    const result = await runBuildDevAppHelper(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
