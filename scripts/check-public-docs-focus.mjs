#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'docs/src/content');
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

async function readContentModuleFiles() {
  try {
    const entries = await readdir(contentDir, { withFileTypes: true });
    return {
      files: entries
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.js')
        .map((entry) => path.posix.join('docs/src/content', entry.name)),
      missing: null,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return {
        files: [],
        missing: 'docs/src/content: public site content directory is missing',
      };
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

function buildPublicInventory(packageFiles, contentModuleFiles) {
  const markdownFiles = packageFiles.filter(
    (file) => path.extname(file).toLowerCase() === '.md' && !prohibitedFiles.has(file),
  );

  return [
    'README.md',
    'docs/README.md',
    ...markdownFiles,
    ...contentModuleFiles,
  ];
}

function assertAccounting(uniqueInventory, failedInventoryFiles, globalFailures) {
  const inventorySet = new Set(uniqueInventory);

  for (const file of failedInventoryFiles) {
    assert(inventorySet.has(file), `inventory failure escaped inventory: ${file}`);
  }

  for (const { file } of globalFailures) {
    assert(!inventorySet.has(file), `global prohibited-path failure must stay outside inventory: ${file}`);
  }

  const passCount = uniqueInventory.filter((file) => !failedInventoryFiles.has(file)).length;
  assert.equal(passCount + failedInventoryFiles.size, uniqueInventory.length);
  return passCount;
}

async function main() {
  const packageJson = await loadPackageJson();
  if (!packageJson) {
    return 1;
  }

  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files.filter((file) => typeof file === 'string')
    : [];

  const { files: contentModuleFiles, missing: contentDirectoryMissing } = await readContentModuleFiles();
  const inventory = buildPublicInventory(packageFiles, contentModuleFiles);
  const uniqueInventory = [...new Set(inventory)];
  const inventorySet = new Set(uniqueInventory);

  const inventoryFailures = [];
  const globalFailures = [];
  const failedInventoryFiles = new Set();
  const recordInventoryFailure = (file, reason) => {
    assert(inventorySet.has(file), `inventory failure escaped inventory: ${file}`);
    failedInventoryFiles.add(file);
    inventoryFailures.push(`${file}: ${reason}`);
  };
  const recordGlobalFailure = (file, reason) => {
    assert(!inventorySet.has(file), `global prohibited-path failure must stay outside inventory: ${file}`);
    globalFailures.push(`${file}: ${reason}`);
  };

  if (contentDirectoryMissing) {
    recordGlobalFailure('docs/src/content', contentDirectoryMissing);
  }

  for (const file of prohibitedFiles) {
    if (packageFiles.includes(file)) {
      recordGlobalFailure(file, 'must not be package-published');
    }

    try {
      const info = await stat(path.join(root, file));
      if (info) {
        recordGlobalFailure(file, 'standalone public document must be removed');
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
      recordInventoryFailure(file, 'public documentation entry is missing');
      continue;
    }

    if (entry.state === 'non-file') {
      recordInventoryFailure(file, 'public documentation entry is not a file');
      continue;
    }

    for (const [needle, reason] of prohibitedText) {
      if (entry.source.includes(needle)) {
        recordInventoryFailure(file, reason);
      }
    }
  }

  const passCount = assertAccounting(uniqueInventory, failedInventoryFiles, globalFailures);

  if (inventoryFailures.length > 0 || globalFailures.length > 0) {
    console.error(`Passed ${passCount}/${uniqueInventory.length} public docs files.`);
    if (inventoryFailures.length > 0) {
      console.error('Inventory file failures:');
      for (const failure of inventoryFailures) {
        console.error(failure);
      }
    }
    if (globalFailures.length > 0) {
      console.error('Global prohibited-path failures:');
      for (const failure of globalFailures) {
        console.error(failure);
      }
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
