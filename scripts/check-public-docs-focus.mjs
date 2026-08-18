#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.js', '.mjs', '.html', '.css', '.svg', '.md', '.json']);
const requiredSourceFiles = sortUnique([
  'docs/src/hero.js',
  'docs/src/index.html',
  'docs/src/content/index.js',
  'docs/src/code-highlight.js',
  'docs/src/main.js',
  'docs/src/sidebar.js',
  'docs/src/style.css',
  'docs/shared/githubStars.js',
  'docs/vite.config.js',
]);
const allowedNonDocumentPublicationEntries = new Set(['dist/**/*', 'psyche', 'LICENSE']);
const ROOT_MARKDOWN_RE = /^[A-Za-z0-9._-]+\.md$/;
const DOCS_MARKDOWN_RE = /^docs\/[A-Za-z0-9._-]+\.md$/;
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

function isTextAsset(relativePath) {
  return textExtensions.has(path.extname(relativePath).toLowerCase());
}

function collectPackageMarkdownFiles(packageFilesValue) {
  const markdownFiles = [];
  const boundaryFailures = [];
  const packageFiles = [];

  if (!Array.isArray(packageFilesValue)) {
    boundaryFailures.push({ file: 'package.json#files', reason: 'package.json.files must be an array of strings' });
    return {
      packageFiles,
      markdownFiles,
      boundaryFailures: sortFailureRecords(boundaryFailures),
    };
  }

  let sawMalformedEntry = false;
  for (const entry of packageFilesValue) {
    if (typeof entry !== 'string') {
      sawMalformedEntry = true;
      continue;
    }

    packageFiles.push(entry);
  }

  if (sawMalformedEntry) {
    boundaryFailures.push({ file: 'package.json#files', reason: 'package.json.files must be an array of strings' });
  }
  for (const file of sortUnique(packageFiles)) {
    if (allowedNonDocumentPublicationEntries.has(file)) {
      continue;
    }

    if (DOCS_MARKDOWN_RE.test(file)) {
      markdownFiles.push(file);
      continue;
    }

    if (file === 'docs' || file === 'docs/' || file.startsWith('docs/')) {
      boundaryFailures.push({
        file,
        reason: 'package-published docs must use explicit top-level Markdown file paths',
      });
      continue;
    }

    if (ROOT_MARKDOWN_RE.test(file)) {
      markdownFiles.push(file);
      continue;
    }

    boundaryFailures.push({ file, reason: 'package-published Markdown must use explicit file paths' });
  }

  return {
    packageFiles: sortUnique(packageFiles),
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

async function collectRecursiveTextFiles(relativeDirectory, readDirectory) {
  let entries;
  try {
    entries = await readDirectory(relativeDirectory);
  } catch (error) {
    if (isEnoent(error)) {
      return {
        files: [],
        missingRootFailure: {
          file: relativeDirectory,
          reason: 'public documentation source root is missing',
        },
      };
    }

    throw error;
  }

  const sortedEntries = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  const files = [];

  for (const entry of sortedEntries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'dist') {
        continue;
      }

      const nested = await collectRecursiveTextFiles(relativePath, readDirectory);
      if (nested.missingRootFailure) {
        return nested;
      }

      files.push(...nested.files);
      continue;
    }

    if (entry.isFile() && isTextAsset(relativePath)) {
      files.push(relativePath);
    }
  }

  return { files: sortUnique(files), missingRootFailure: null };
}

async function readDirectoryFromFilesystem(relativeDirectory) {
  return readdir(path.join(root, relativeDirectory), { withFileTypes: true });
}

async function collectPublicRecursiveFiles() {
  return collectRecursiveTextFiles('docs/src', readDirectoryFromFilesystem);
}

function buildPublicInventory({ recursiveFiles, packageMarkdownFiles }) {
  return sortUnique([
    'README.md',
    'docs/README.md',
    ...requiredSourceFiles,
    ...recursiveFiles,
    ...packageMarkdownFiles,
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

function assertRequiredInventoryFiles(inventory) {
  for (const file of requiredSourceFiles) {
    assert(inventory.includes(file), `required docs source file missing: ${file}`);
  }
}

function createSyntheticDirEntry(name, type) {
  return {
    name,
    isDirectory: () => type === 'dir',
    isFile: () => type === 'file',
  };
}

function createSyntheticDirectoryReader(tree, missingPaths = new Set()) {
  return async (relativeDirectory) => {
    if (missingPaths.has(relativeDirectory)) {
      const error = new Error(`ENOENT: ${relativeDirectory}`);
      error.code = 'ENOENT';
      throw error;
    }

    if (!tree.has(relativeDirectory)) {
      const error = new Error(`ENOENT: ${relativeDirectory}`);
      error.code = 'ENOENT';
      throw error;
    }

    return tree.get(relativeDirectory);
  };
}

async function selfCheckPublicInventory() {
  const syntheticTree = new Map([
    [
      'docs/src',
      [
        createSyntheticDirEntry('b.js', 'file'),
        createSyntheticDirEntry('a.md', 'file'),
        createSyntheticDirEntry('dist', 'dir'),
        createSyntheticDirEntry('nested', 'dir'),
      ],
    ],
    [
      'docs/src/nested',
      [
        createSyntheticDirEntry('c.css', 'file'),
        createSyntheticDirEntry('ignored.png', 'file'),
      ],
    ],
    [
      'docs/src/dist',
      [createSyntheticDirEntry('ignored.js', 'file')],
    ],
  ]);
  const recursiveResult = await collectRecursiveTextFiles(
    'docs/src',
    createSyntheticDirectoryReader(syntheticTree),
  );
  assert.deepEqual(recursiveResult.files, ['docs/src/a.md', 'docs/src/b.js', 'docs/src/nested/c.css']);
  assert.deepEqual(recursiveResult.files, sortUnique(recursiveResult.files));
  assert(recursiveResult.files.every((file) => file.startsWith('docs/src/')));
  assert(recursiveResult.files.every((file) => !file.includes('/dist/')));
  assert.deepEqual(recursiveResult.missingRootFailure, null);

  const requiredInventory = buildPublicInventory({ recursiveFiles: [], packageMarkdownFiles: [] });
  assert(requiredInventory.includes('README.md'));
  assert(requiredInventory.includes('docs/README.md'));
  assertRequiredInventoryFiles(requiredInventory);

  assert.throws(
    () => {
      assertRequiredInventoryFiles(requiredInventory.filter((file) => file !== 'docs/shared/githubStars.js'));
    },
    /required docs source file missing: docs\/shared\/githubStars\.js/,
  );

  const allowlistedPublicationEntries = collectPackageMarkdownFiles(['dist/**/*', 'psyche', 'LICENSE']);
  assert.deepEqual(allowlistedPublicationEntries.packageFiles, sortUnique(['dist/**/*', 'psyche', 'LICENSE']));
  assert.deepEqual(allowlistedPublicationEntries.markdownFiles, []);
  assert.deepEqual(allowlistedPublicationEntries.boundaryFailures, []);

  const malformedPackageFiles = collectPackageMarkdownFiles([null, 'README.md']);
  assert(malformedPackageFiles.markdownFiles.includes('README.md'));
  assert.deepEqual(
    malformedPackageFiles.boundaryFailures,
    [{ file: 'package.json#files', reason: 'package.json.files must be an array of strings' }],
  );

  const missingPackageFiles = collectPackageMarkdownFiles(undefined);
  assert.deepEqual(
    missingPackageFiles.boundaryFailures,
    [{ file: 'package.json#files', reason: 'package.json.files must be an array of strings' }],
  );

  const missingRecursiveResult = await collectRecursiveTextFiles(
    'docs/src',
    createSyntheticDirectoryReader(new Map(), new Set(['docs/src'])),
  );
  assert.deepEqual(missingRecursiveResult, {
    files: [],
    missingRootFailure: {
      file: 'docs/src',
      reason: 'public documentation source root is missing',
    },
  });

  const packageBoundaryA = collectPackageMarkdownFiles([
    'dist/**/*',
    'psyche',
    'LICENSE',
    'CHANGELOG*.md',
    'CHANGELOG.md',
    'README.md',
    'CONTRIBUTING.md',
    'docs',
    'docs/',
    'docs/**/*',
    'docs/AGENT-SURFACE-CONTROL.md',
    'docs/BREAKING-CHANGES.md',
    'docs/BRIDGE-SECURITY.md',
    'docs/COVEN-DEMO-LOOP.md',
    'docs/COVEN-SESSIONS.md',
    'docs/PRODUCT-SPEC.md',
    'docs/README.md',
    'docs/RELEASE.md',
    'docs/SMOKE.md',
    'docs/not-md.txt',
    'docs/superpowers',
    'docs/superpowers/x.md',
    'guides',
    'guides/**/*',
    'nested/README.md',
    'src/',
  ]);
  const packageBoundaryB = collectPackageMarkdownFiles([
    'src/',
    'nested/README.md',
    'guides/**/*',
    'guides',
    'docs/superpowers/x.md',
    'docs/superpowers',
    'docs/not-md.txt',
    'docs/SMOKE.md',
    'docs/RELEASE.md',
    'docs/README.md',
    'docs/PRODUCT-SPEC.md',
    'docs/COVEN-SESSIONS.md',
    'docs/COVEN-DEMO-LOOP.md',
    'docs/BRIDGE-SECURITY.md',
    'docs/BREAKING-CHANGES.md',
    'docs/AGENT-SURFACE-CONTROL.md',
    'docs/**/*',
    'docs/',
    'docs',
    'CONTRIBUTING.md',
    'README.md',
    'CHANGELOG*.md',
    'CHANGELOG.md',
    'LICENSE',
    'psyche',
    'dist/**/*',
  ]);

  assert.deepEqual(packageBoundaryA, packageBoundaryB);
  assert.deepEqual(
    packageBoundaryA.markdownFiles,
    sortUnique([
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'README.md',
      'docs/AGENT-SURFACE-CONTROL.md',
      'docs/BREAKING-CHANGES.md',
      'docs/BRIDGE-SECURITY.md',
      'docs/COVEN-DEMO-LOOP.md',
      'docs/COVEN-SESSIONS.md',
      'docs/PRODUCT-SPEC.md',
      'docs/README.md',
      'docs/RELEASE.md',
      'docs/SMOKE.md',
    ]),
  );
  assert.deepEqual(
    packageBoundaryA.boundaryFailures,
    sortFailureRecords([
      { file: 'CHANGELOG*.md', reason: 'package-published Markdown must use explicit file paths' },
      { file: 'docs', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/**/*', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/not-md.txt', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/superpowers', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'docs/superpowers/x.md', reason: 'package-published docs must use explicit top-level Markdown file paths' },
      { file: 'guides', reason: 'package-published Markdown must use explicit file paths' },
      { file: 'guides/**/*', reason: 'package-published Markdown must use explicit file paths' },
      { file: 'nested/README.md', reason: 'package-published Markdown must use explicit file paths' },
      { file: 'src/', reason: 'package-published Markdown must use explicit file paths' },
    ]),
  );

  const packageInventory = buildPublicInventory({
    recursiveFiles: [],
    packageMarkdownFiles: packageBoundaryA.markdownFiles,
  });
  assert(packageInventory.includes('CHANGELOG.md'));
  assert(packageInventory.includes('CONTRIBUTING.md'));
  assert(packageInventory.includes('README.md'));
  assert(packageInventory.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(packageInventory.includes('docs/COVEN-SESSIONS.md'));

  const syntheticInventory = ['README.md', 'docs/COVEN-DEMO-LOOP.md', 'docs/README.md'];
  const syntheticFailedInventoryFiles = new Set();
  const syntheticGlobalFailures = [];
  const syntheticRecordGlobalFailure = (file, reason) => {
    if (syntheticInventory.includes(file)) {
      syntheticFailedInventoryFiles.add(file);
    }
    syntheticGlobalFailures.push({ file, reason });
  };

  syntheticRecordGlobalFailure('docs/COVEN-DEMO-LOOP.md', 'must not be package-published');
  syntheticRecordGlobalFailure('docs/external-note.md', 'standalone public document must be removed');
  assert(syntheticFailedInventoryFiles.has('docs/COVEN-DEMO-LOOP.md'));
  assert.equal(countInventoryPasses(syntheticInventory, syntheticFailedInventoryFiles), 2);
  assert.deepEqual(syntheticGlobalFailures, [
    { file: 'docs/COVEN-DEMO-LOOP.md', reason: 'must not be package-published' },
    { file: 'docs/external-note.md', reason: 'standalone public document must be removed' },
  ]);

  const partialCleanupInventory = buildPublicInventory({
    recursiveFiles: ['docs/src/main.js'],
    packageMarkdownFiles: ['README.md', 'docs/README.md', 'docs/COVEN-DEMO-LOOP.md', 'docs/COVEN-SESSIONS.md'],
  });
  assert(partialCleanupInventory.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(partialCleanupInventory.includes('docs/COVEN-SESSIONS.md'));
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

  const packageMarkdownResult = collectPackageMarkdownFiles(packageJson.files);
  const packageFiles = packageMarkdownResult.packageFiles;
  const recursiveResult = await collectPublicRecursiveFiles();
  const recursiveFiles = recursiveResult.files;
  const uniqueInventory = buildPublicInventory({
    recursiveFiles,
    packageMarkdownFiles: packageMarkdownResult.markdownFiles,
  });
  const inventorySet = new Set(uniqueInventory);

  const inventoryFailures = [];
  const packageBoundaryFailures = [...packageMarkdownResult.boundaryFailures];
  const sourceRootFailures = recursiveResult.missingRootFailure ? [recursiveResult.missingRootFailure] : [];
  const globalFailures = [];
  const failedInventoryFiles = new Set();

  const recordInventoryFailure = (file, reason) => {
    assert(inventorySet.has(file), `inventory failure escaped inventory: ${file}`);
    failedInventoryFiles.add(file);
    inventoryFailures.push({ file, reason });
  };

  const recordGlobalFailure = (file, reason) => {
    if (inventorySet.has(file)) {
      failedInventoryFiles.add(file);
    }
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
  const sortedPackageBoundaryFailures = sortFailureRecords(packageBoundaryFailures);
  const sortedSourceRootFailures = sortFailureRecords(sourceRootFailures);
  const sortedGlobalFailures = sortFailureRecords(globalFailures);

  if (
    sortedInventoryFailures.length > 0
    || sortedPackageBoundaryFailures.length > 0
    || sortedSourceRootFailures.length > 0
    || sortedGlobalFailures.length > 0
  ) {
    console.error(`Passed ${passCount}/${uniqueInventory.length} public documentation source files.`);

    if (sortedInventoryFailures.length > 0) {
      console.error('Inventory file failures:');
      for (const failure of sortedInventoryFailures) {
        console.error(`${failure.file}: ${failure.reason}`);
      }
    }

    if (sortedPackageBoundaryFailures.length > 0) {
      console.error('Package boundary failures:');
      for (const failure of sortedPackageBoundaryFailures) {
        console.error(`${failure.file}: ${failure.reason}`);
      }
    }

    if (sortedSourceRootFailures.length > 0) {
      console.error('Source root failures:');
      for (const failure of sortedSourceRootFailures) {
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
