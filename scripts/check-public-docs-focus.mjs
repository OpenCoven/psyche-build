#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(root, 'package.json');
const prohibitedFiles = new Set(['docs/COVEN-DEMO-LOOP.md', 'docs/COVEN-SESSIONS.md']);
const prohibitedText = [
  ['Coven Demo Loop', 'standalone Coven demo positioning'],
  ['Fix OpenClaw cockpit', 'standalone OpenClaw promotion'],
  ['OpenCoven public roadmap', 'external ecosystem roadmap promotion'],
  ['led by <strong>Coven Code</strong>', 'agent catalog product favoritism'],
];

function isEnoent(error) {
  return Boolean(error && typeof error === 'object' && error.code === 'ENOENT');
}

async function loadPackageJson() {
  try {
    return JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch (error) {
    if (isEnoent(error)) {
      console.error('package.json: missing');
      return null;
    }
    throw error;
  }
}

async function inspectFile(file) {
  const absolutePath = path.join(root, file);

  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return { state: 'non-file' };
    }

    const source = await readFile(absolutePath, 'utf8');
    return { state: 'ok', source };
  } catch (error) {
    if (isEnoent(error)) {
      return { state: 'missing' };
    }
    throw error;
  }
}

async function main() {
  const packageJson = await loadPackageJson();
  if (!packageJson) {
    return 1;
  }

  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files.filter((file) => typeof file === 'string')
    : [];

  const inventory = [
    'README.md',
    'docs/README.md',
    ...packageFiles.filter((file) => path.extname(file).toLowerCase() === '.md'),
    'docs/src/content/index.js',
    'docs/src/content/agents.js',
    'docs/src/content/getting-started.js',
    'docs/src/content/troubleshooting.js',
  ];
  const uniqueInventory = [...new Set(inventory)];

  const failures = [];
  const failedFiles = new Set();
  const recordFailure = (file, reason) => {
    failedFiles.add(file);
    failures.push(`${file}: ${reason}`);
  };

  for (const file of prohibitedFiles) {
    if (packageFiles.includes(file)) {
      recordFailure(file, 'must not be package-published');
    }

    try {
      const info = await stat(path.join(root, file));
      if (info) {
        recordFailure(file, 'standalone public document must be removed');
      }
    } catch (error) {
      if (!isEnoent(error)) {
        throw error;
      }
    }
  }

  for (const file of uniqueInventory) {
    const entry = await inspectFile(file);

    if (entry.state === 'missing') {
      recordFailure(file, 'public documentation entry is missing');
      continue;
    }

    if (entry.state === 'non-file') {
      recordFailure(file, 'public documentation entry is not a file');
      continue;
    }

    for (const [needle, reason] of prohibitedText) {
      if (entry.source.includes(needle)) {
        recordFailure(file, reason);
      }
    }
  }

  const passCount = uniqueInventory.filter((file) => !failedFiles.has(file)).length;
  assert.equal(passCount + failedFiles.size, uniqueInventory.length);

  if (failures.length > 0) {
    console.error(`Passed ${passCount}/${uniqueInventory.length} public docs files.`);
    for (const failure of failures) {
      console.error(failure);
    }
    return 1;
  }

  console.log(`Passed ${passCount}/${uniqueInventory.length} public docs files.`);
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
