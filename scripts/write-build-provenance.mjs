#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeBuildProvenanceUnlocked } from './build-macos-app.mjs';

export async function runWriteBuildProvenanceHelper(argv) {
  if (argv.length !== 2) {
    throw new Error(
      'write-build-provenance requires exactly a state path and private input-file path',
    );
  }

  const [statePath, inputPath] = argv.map((value) => path.resolve(value));
  let record;

  try {
    record = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Invalid build provenance input file at "${inputPath}": ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }

  await writeBuildProvenanceUnlocked(statePath, record);
}

function isEntrypoint() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isEntrypoint()) {
  try {
    await runWriteBuildProvenanceHelper(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
