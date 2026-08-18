#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.js', '.mjs', '.html', '.css', '.svg', '.md', '.json']);
const requiredEntryFiles = sortUnique([
  'docs/src/hero.js',
  'docs/src/index.html',
  'docs/src/main.js',
  'docs/src/sidebar.js',
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
const globMetacharacters = /[*?\[\]{}]/;

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

function isTextAsset(relativePath) {
  return textExtensions.has(path.extname(relativePath).toLowerCase());
}

function hasGlobMetacharacters(value) {
  return globMetacharacters.test(value);
}

function collectPackageMarkdownFiles(packageFiles) {
  const boundaryFailures = [];
  const markdownFiles = [];

  for (const file of sortUnique(packageFiles)) {
    const isDocsEntry = file === 'docs' || file === 'docs/' || file.startsWith('docs/');
    const isMarkdown = path.extname(file).toLowerCase() === '.md';

    if (isDocsEntry) {
      if (hasGlobMetacharacters(file) || !/^docs\/[^/]+\.md$/.test(file)) {
        boundaryFailures.push({
          file,
          reason: 'package-published docs must use explicit top-level Markdown file paths',
        });
        continue;
      }

      markdownFiles.push(file);
      continue;
    }

    if (!isMarkdown) {
      continue;
    }

    if (hasGlobMetacharacters(file) || file.endsWith('/')) {
      boundaryFailures.push({ file, reason: 'package-published Markdown must use explicit file paths' });
      continue;
    }

    markdownFiles.push(file);
  }

  return {
    markdownFiles: sortUnique(markdownFiles),
    boundaryFailures: sortFailureRecords(boundaryFailures),
  };
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

async function collectRecursiveTextFiles(absoluteDirectory, relativeDirectory) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const sortedEntries = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  const files = [];

  for (const entry of sortedEntries) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'dist') {
        continue;
      }

      files.push(...await collectRecursiveTextFiles(absolutePath, relativePath));
      continue;
    }

    if (entry.isFile() && isTextAsset(relativePath)) {
      files.push(relativePath);
    }
  }

  return sortUnique(files);
}

async function collectPublicRecursiveFiles() {
  return collectRecursiveTextFiles(path.join(root, 'docs/src'), 'docs/src');
}

function buildPublicInventory({ recursiveFiles, packageMarkdownFiles }) {
  return sortUnique([
    'README.md',
    'docs/README.md',
    ...requiredEntryFiles,
    ...recursiveFiles,
    ...packageMarkdownFiles.filter((file) => !prohibitedFiles.has(file)),
  ]);
}

async function inspectTextSource(file) {
  const absolutePath = path.join(root, file);

  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return { state: 'non-file' };
    }

    return { state: 'ok', source: await readFile(absolutePath, 'utf8') };
  } catch (error) {
    if (isEnoent(error)) {
      return { state: 'missing' };
    }

    throw error;
  }
}

function countInventoryPasses(uniqueInventory, failedInventoryFiles) {
  for (const file of failedInventoryFiles) {
    assert(uniqueInventory.includes(file), `inventory failure escaped inventory: ${file}`);
  }

  const passCount = uniqueInventory.length - failedInventoryFiles.size;
  assert.equal(passCount + failedInventoryFiles.size, uniqueInventory.length);
  return passCount;
}

async function selfCheckPublicInventory() {
  const recursiveFiles = await collectPublicRecursiveFiles();
  assert.deepEqual(recursiveFiles, sortUnique(recursiveFiles));
  assert(recursiveFiles.every((file) => file.startsWith('docs/src/')));
  assert(recursiveFiles.every((file) => !file.includes('/dist/')));

  const requiredInventory = buildPublicInventory({ recursiveFiles: [], packageMarkdownFiles: [] });
  assert(requiredInventory.includes('README.md'));
  assert(requiredInventory.includes('docs/README.md'));
  for (const file of requiredEntryFiles) {
    assert(requiredInventory.includes(file), `required entrypoint missing from inventory: ${file}`);
  }

  const packageBoundaryA = collectPackageMarkdownFiles([
    'dist/**/*',
    'CHANGELOG*.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'README.md',
    'docs/',
    'docs/**/*',
    'docs/COVEN-DEMO-LOOP.md',
    'docs/AGENT-SURFACE-CONTROL.md',
    'docs/README.md',
    'docs/not-md.txt',
    'docs/superpowers',
    'docs/superpowers/x.md',
  ]);
  const packageBoundaryB = collectPackageMarkdownFiles([
    'dist/**/*',
    'README.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'CHANGELOG*.md',
    'docs/superpowers/x.md',
    'docs/not-md.txt',
    'docs/superpowers',
    'docs/README.md',
    'docs/AGENT-SURFACE-CONTROL.md',
    'docs/COVEN-DEMO-LOOP.md',
    'docs/**/*',
    'docs/',
  ]);

  assert.deepEqual(packageBoundaryA, packageBoundaryB);
  assert(packageBoundaryA.markdownFiles.includes('CHANGELOG.md'));
  assert(packageBoundaryA.markdownFiles.includes('CONTRIBUTING.md'));
  assert(packageBoundaryA.markdownFiles.includes('README.md'));
  assert(packageBoundaryA.markdownFiles.includes('docs/AGENT-SURFACE-CONTROL.md'));
  assert(packageBoundaryA.markdownFiles.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(packageBoundaryA.markdownFiles.includes('docs/README.md'));
  assert.deepEqual(
    packageBoundaryA.boundaryFailures,
    sortFailureRecords([
      { file: 'CHANGELOG*.md', reason: 'package-published Markdown must use explicit file paths' },
      { file: 'docs/', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/**/*', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/not-md.txt', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/superpowers', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/superpowers/x.md', reason: 'package-published docs must use explicit top-level Markdown file paths' },
    ]),
  );

  const packageInventory = buildPublicInventory({
    recursiveFiles: [],
    packageMarkdownFiles: packageBoundaryA.markdownFiles,
  });
  assert(packageInventory.includes('CHANGELOG.md'));
  assert(packageInventory.includes('CONTRIBUTING.md'));
  assert(packageInventory.includes('README.md'));

  const partialCleanupInventory = buildPublicInventory({
    recursiveFiles: ['docs/src/main.js'],
    packageMarkdownFiles: ['README.md', 'docs/README.md', 'docs/COVEN-DEMO-LOOP.md', 'docs/COVEN-SESSIONS.md'],
  });
  assert(!partialCleanupInventory.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(!partialCleanupInventory.includes('docs/COVEN-SESSIONS.md'));
  assert.equal(
    countInventoryPasses(partialCleanupInventory, new Set(['docs/src/main.js'])),
    partialCleanupInventory.length - 1,
  );
}

async function main() {
  await selfCheckPublicInventory();

  const packageJson = await loadPackageJson();
  if (!packageJson) {
    return 1;
  }

  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files.filter((file) => typeof file === 'string')
    : [];
  const packageMarkdownResult = collectPackageMarkdownFiles(packageFiles);
  const recursiveFiles = await collectPublicRecursiveFiles();
  const uniqueInventory = buildPublicInventory({
    recursiveFiles,
    packageMarkdownFiles: packageMarkdownResult.markdownFiles,
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

  for (const failure of packageMarkdownResult.boundaryFailures) {
    recordGlobalFailure(failure.file, failure.reason);
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
    const inspected = await inspectTextSource(file);

    if (inspected.state === 'missing') {
      recordInventoryFailure(file, 'public documentation source entry is missing');
      continue;
    }

    if (inspected.state === 'non-file') {
      recordInventoryFailure(file, 'public documentation source entry is not a file');
      continue;
    }

    for (const [needle, reason] of prohibitedText) {
      if (inspected.source.includes(needle)) {
        recordInventoryFailure(file, reason);
      }
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
