#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recursiveRoots = ['docs/src', 'docs/shared', 'docs/public'];
const textExtensions = new Set(['.js', '.mjs', '.html', '.css', '.svg', '.md', '.json']);
const skippedDirectoryNames = new Set(['client', 'dist', 'generated', 'node_modules']);
const requiredEntrypoints = sortUnique([
  'docs/src/content/index.js',
  'docs/src/index.html',
  'docs/src/main.js',
  'docs/src/style.css',
  'docs/vite.config.js',
]);
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

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortUnique(values) {
  return [...new Set(values)].sort(compareStrings);
}

function sortFailureRecords(records) {
  return [...records].sort(
    (left, right) => compareStrings(left.file, right.file) || compareStrings(left.reason, right.reason),
  );
}

function isRecursiveTextPath(relativePath) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) {
    return false;
  }

  return !relativePath.split('/').some((segment) => skippedDirectoryNames.has(segment));
}

function parseRelativeImports(source) {
  const imports = [];
  const importPattern = /from\s+['"](\.\/[^'"]+\.js)['"]/g;

  for (const match of source.matchAll(importPattern)) {
    imports.push(path.posix.normalize(path.posix.join('docs/src/content', match[1])));
  }

  return sortUnique(imports);
}

async function loadPackageJson() {
  try {
    return JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  } catch (error) {
    if (isEnoent(error)) {
      console.error('package.json: missing');
      return null;
    }

    throw error;
  }
}

async function readContentIndexImports() {
  try {
    const source = await readFile(path.join(root, 'docs/src/content/index.js'), 'utf8');
    return parseRelativeImports(source);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }

    throw error;
  }
}

async function collectRecursiveTextFiles(absoluteDirectory, relativeDirectory) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  const files = [];

  for (const entry of sortedEntries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) {
        continue;
      }

      files.push(...await collectRecursiveTextFiles(absolutePath, relativePath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (isRecursiveTextPath(relativePath)) {
      files.push(relativePath);
    }
  }

  return files;
}

async function collectPublicRecursiveFiles() {
  const files = [];

  for (const relativeRoot of recursiveRoots) {
    files.push(
      ...await collectRecursiveTextFiles(path.join(root, relativeRoot), relativeRoot),
    );
  }

  return sortUnique(files);
}

function composeInventory({ recursiveFiles, importedContentFiles, packageMarkdownFiles }) {
  return sortUnique([
    'README.md',
    'docs/README.md',
    ...requiredEntrypoints,
    ...recursiveFiles,
    ...importedContentFiles,
    ...packageMarkdownFiles.filter((file) => !prohibitedFiles.has(file)),
  ]);
}

function countInventoryPasses(uniqueInventory, failedInventoryFiles) {
  for (const file of failedInventoryFiles) {
    assert(uniqueInventory.includes(file), `inventory failure escaped inventory: ${file}`);
  }

  const passCount = uniqueInventory.length - failedInventoryFiles.size;
  assert.equal(passCount + failedInventoryFiles.size, uniqueInventory.length);
  return passCount;
}

function selfCheckInventoryComposition() {
  assert.equal(isRecursiveTextPath('docs/src/index.html'), true);
  assert.equal(isRecursiveTextPath('docs/src/style.css'), true);
  assert.equal(isRecursiveTextPath('docs/public/agents/amp.svg'), true);
  assert.equal(isRecursiveTextPath('docs/public/agents/png/amp.png'), false);
  assert.equal(isRecursiveTextPath('docs/src/dist/generated.js'), false);
  assert.equal(isRecursiveTextPath('docs/shared/node_modules/runtime.json'), false);
  assert.equal(isRecursiveTextPath('docs/shared/client/runtime.js'), false);

  assert.deepEqual(
    parseRelativeImports(
      "import * as covenDemo from './coven-demo.js';\nimport * as gettingStarted from './getting-started.js';",
    ),
    ['docs/src/content/coven-demo.js', 'docs/src/content/getting-started.js'],
  );

  const shuffledInventory = composeInventory({
    recursiveFiles: ['docs/public/og.svg', 'docs/src/style.css', 'docs/src/index.html'],
    importedContentFiles: ['docs/src/content/getting-started.js', 'docs/src/content/coven-demo.js'],
    packageMarkdownFiles: ['docs/PRODUCT-SPEC.md', 'CHANGELOG.md'],
  });
  const orderedInventory = composeInventory({
    recursiveFiles: ['docs/src/index.html', 'docs/src/style.css', 'docs/public/og.svg'],
    importedContentFiles: ['docs/src/content/coven-demo.js', 'docs/src/content/getting-started.js'],
    packageMarkdownFiles: ['CHANGELOG.md', 'docs/PRODUCT-SPEC.md'],
  });
  assert.deepEqual(shuffledInventory, orderedInventory);

  const requiredOnlyInventory = composeInventory({
    recursiveFiles: [],
    importedContentFiles: [],
    packageMarkdownFiles: [],
  });
  for (const file of requiredEntrypoints) {
    assert(requiredOnlyInventory.includes(file), `required entrypoint missing from inventory: ${file}`);
  }
  assert.equal(
    countInventoryPasses(requiredOnlyInventory, new Set(['docs/src/main.js'])),
    requiredOnlyInventory.length - 1,
  );

  const packageBoundaryInventory = composeInventory({
    recursiveFiles: [],
    importedContentFiles: [],
    packageMarkdownFiles: ['README.md', 'docs/README.md', 'docs/COVEN-DEMO-LOOP.md', 'docs/COVEN-SESSIONS.md'],
  });
  assert(!packageBoundaryInventory.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(!packageBoundaryInventory.includes('docs/COVEN-SESSIONS.md'));
}

async function main() {
  selfCheckInventoryComposition();

  const packageJson = await loadPackageJson();
  if (!packageJson) {
    return 1;
  }

  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files.filter((file) => typeof file === 'string')
    : [];
  const packageMarkdownFiles = sortUnique(
    packageFiles.filter(
      (file) => path.extname(file).toLowerCase() === '.md' && !prohibitedFiles.has(file),
    ),
  );

  const recursiveFiles = await collectPublicRecursiveFiles();
  const importedContentFiles = await readContentIndexImports();
  const uniqueInventory = composeInventory({
    recursiveFiles,
    importedContentFiles,
    packageMarkdownFiles,
  });
  const inventorySet = new Set(uniqueInventory);

  const inventoryFailures = [];
  const globalFailures = [];
  const failedInventoryFiles = new Set();

  const recordInventoryFailure = (file, reason) => {
    assert(inventorySet.has(file), `inventory failure escaped inventory: ${file}`);
    failedInventoryFiles.add(file);
    inventoryFailures.push({ file, reason });
  };

  const recordGlobalFailure = (file, reason) => {
    assert(!inventorySet.has(file), `global prohibited-path failure must stay outside inventory: ${file}`);
    globalFailures.push({ file, reason });
  };

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
    const absolutePath = path.join(root, file);

    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        recordInventoryFailure(file, 'public documentation source entry is not a file');
        continue;
      }

      const source = await readFile(absolutePath, 'utf8');
      for (const [needle, reason] of prohibitedText) {
        if (source.includes(needle)) {
          recordInventoryFailure(file, reason);
        }
      }
    } catch (error) {
      if (isEnoent(error)) {
        recordInventoryFailure(file, 'public documentation source entry is missing');
        continue;
      }

      throw error;
    }
  }

  const passCount = countInventoryPasses(uniqueInventory, failedInventoryFiles);
  const sortedInventoryFailures = sortFailureRecords(inventoryFailures);
  const sortedGlobalFailures = sortFailureRecords(globalFailures);

  if (sortedInventoryFailures.length > 0 || sortedGlobalFailures.length > 0) {
    console.error(`Passed ${passCount}/${uniqueInventory.length} public documentation source files.`);

    if (sortedInventoryFailures.length > 0) {
      console.error('Inventory file failures:');
      for (const failure of sortedInventoryFailures) {
        console.error(`${failure.file}: ${failure.reason}`);
      }
    }

    if (sortedGlobalFailures.length > 0) {
      console.error('Global prohibited-path failures:');
      for (const failure of sortedGlobalFailures) {
        console.error(`${failure.file}: ${failure.reason}`);
      }
    }

    return 1;
  }

  console.log(`Passed ${passCount}/${uniqueInventory.length} public documentation source files.`);
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
