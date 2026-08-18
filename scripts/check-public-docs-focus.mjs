#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'docs/src/content');
const contentIndexPath = path.join(contentDir, 'index.js');
const shellSourceFiles = [
  'docs/src/hero.js',
  'docs/src/index.html',
  'docs/src/main.js',
  'docs/src/sidebar.js',
];
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

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortUnique(values) {
  return [...new Set(values)].sort(compareStrings);
}

function compareFailureRecords(left, right) {
  return compareStrings(left.file, right.file) || compareStrings(left.reason, right.reason);
}

function sortFailureRecords(records) {
  return [...records].sort(compareFailureRecords);
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
    const source = await readFile(contentIndexPath, 'utf8');
    return parseRelativeImports(source);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
}

async function readContentModuleFiles() {
  try {
    const entries = await readdir(contentDir, { withFileTypes: true });
    return sortUnique(
      entries
        .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.js')
        .map((entry) => path.posix.join('docs/src/content', entry.name)),
    );
  } catch (error) {
    if (isEnoent(error)) {
      return [];
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

    return { state: 'ok', source: await readFile(absolutePath, 'utf8') };
  } catch (error) {
    if (isEnoent(error)) {
      return { state: 'missing' };
    }
    throw error;
  }
}

function buildPublicInventory({ packageFiles, indexImports, contentModuleFiles, shellFiles }) {
  const packageMarkdownFiles = sortUnique(
    packageFiles.filter(
      (file) => path.extname(file).toLowerCase() === '.md' && !prohibitedFiles.has(file),
    ),
  );

  return sortUnique([
    'README.md',
    'docs/README.md',
    'docs/src/content/index.js',
    ...indexImports,
    ...contentModuleFiles,
    ...shellFiles,
    ...packageMarkdownFiles,
  ]);
}

function countInventoryPasses(uniqueInventory, failedInventoryFiles) {
  for (const file of failedInventoryFiles) {
    assert(
      uniqueInventory.includes(file),
      `inventory failure escaped inventory: ${file}`,
    );
  }

  const passCount = uniqueInventory.length - failedInventoryFiles.size;
  assert.equal(passCount + failedInventoryFiles.size, uniqueInventory.length);
  return passCount;
}

function selfCheckDeterminism() {
  const packageFiles = [
    'README.md',
    'docs/README.md',
    'docs/BRIDGE-SECURITY.md',
    'docs/COVEN-DEMO-LOOP.md',
    'docs/COVEN-SESSIONS.md',
    'CONTRIBUTING.md',
  ];
  const indexImports = [
    'docs/src/content/getting-started.js',
    'docs/src/content/coven-demo.js',
    'docs/src/content/agents.js',
  ];
  const contentModuleFiles = [
    'docs/src/content/troubleshooting.js',
    'docs/src/content/index.js',
    'docs/src/content/coven-demo.js',
    'docs/src/content/agents.js',
  ];
  const shellFiles = [
    'docs/src/sidebar.js',
    'docs/src/main.js',
    'docs/src/index.html',
    'docs/src/hero.js',
  ];

  const shuffledInventory = buildPublicInventory({
    packageFiles: [...packageFiles].reverse(),
    indexImports: [...indexImports].reverse(),
    contentModuleFiles: [...contentModuleFiles].reverse(),
    shellFiles: [...shellFiles].reverse(),
  });
  const orderedInventory = buildPublicInventory({
    packageFiles,
    indexImports,
    contentModuleFiles,
    shellFiles,
  });

  assert.deepEqual(shuffledInventory, orderedInventory);
  assert(orderedInventory.includes('docs/src/content/coven-demo.js'));

  const missingImportedInventory = buildPublicInventory({
    packageFiles: [],
    indexImports: ['docs/src/content/missing-page.js'],
    contentModuleFiles: ['docs/src/content/index.js'],
    shellFiles: [],
  });
  assert(missingImportedInventory.includes('docs/src/content/missing-page.js'));

  const partialCleanupInventory = buildPublicInventory({
    packageFiles: [
      'README.md',
      'docs/README.md',
      'docs/COVEN-DEMO-LOOP.md',
      'docs/COVEN-SESSIONS.md',
    ],
    indexImports: ['docs/src/content/index.js'],
    contentModuleFiles: ['docs/src/content/index.js'],
    shellFiles: ['docs/src/index.html'],
  });
  const partialCleanupInventorySet = new Set(partialCleanupInventory);
  const partialCleanupGlobalFailures = sortFailureRecords([
    { file: 'docs/COVEN-DEMO-LOOP.md', reason: 'must not be package-published' },
    { file: 'docs/COVEN-SESSIONS.md', reason: 'standalone public document must be removed' },
  ]);
  for (const failure of partialCleanupGlobalFailures) {
    assert(!partialCleanupInventorySet.has(failure.file));
  }
  assert.equal(countInventoryPasses(partialCleanupInventory, new Set(['docs/src/content/index.js'])), 3);
}

async function main() {
  selfCheckDeterminism();

  const packageJson = await loadPackageJson();
  if (!packageJson) {
    return 1;
  }

  const packageFiles = Array.isArray(packageJson.files)
    ? packageJson.files.filter((file) => typeof file === 'string')
    : [];

  const indexImports = await readContentIndexImports();
  const contentModuleFiles = await readContentModuleFiles();
  const uniqueInventory = buildPublicInventory({
    packageFiles,
    indexImports,
    contentModuleFiles,
    shellFiles: shellSourceFiles,
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

  const passCount = countInventoryPasses(uniqueInventory, failedInventoryFiles);
  const sortedInventoryFailures = sortFailureRecords(inventoryFailures);
  const sortedGlobalFailures = sortFailureRecords(globalFailures);

  if (sortedInventoryFailures.length > 0 || sortedGlobalFailures.length > 0) {
    console.error(`Passed ${passCount}/${uniqueInventory.length} public docs files.`);

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

  console.log(`Passed ${passCount}/${uniqueInventory.length} public docs files.`);
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
