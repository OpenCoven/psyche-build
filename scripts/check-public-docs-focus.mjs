#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recursiveRoots = ['docs/src', 'docs/shared', 'docs/public'];
const textExtensions = new Set(['.js', '.mjs', '.html', '.css', '.svg', '.md', '.json']);
const skippedDirectoryNames = new Set(['client', 'dist', 'generated', 'node_modules']);
const requiredEntryFiles = sortUnique([
  'docs/src/hero.js',
  'docs/src/index.html',
  'docs/src/main.js',
  'docs/src/sidebar.js',
  'docs/src/style.css',
  'docs/vite.config.js',
]);
const allowedGraphRoots = ['docs/src/', 'docs/shared/', 'docs/public/'];
const allowedGraphFiles = new Set(['docs/vite.config.js']);
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
  return [...records].sort((left, right) => compareStrings(left.file, right.file) || compareStrings(left.reason, right.reason));
}

function isTextAsset(relativePath) {
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) {
    return false;
  }

  return !relativePath.split('/').some((segment) => skippedDirectoryNames.has(segment));
}

function isJsModule(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return ext === '.js' || ext === '.mjs';
}

function parseStaticRelativeSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+['"]((?:\.\.\/|\.\/)[^'"]+\.(?:js|mjs))['"]/g,
    /\b(?:import|export)\s+(?:[\s\S]*?\bfrom\s+)?['"]((?:\.\.\/|\.\/)[^'"]+\.(?:js|mjs))['"]/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }

  return sortUnique(specifiers);
}

function resolveRelativeImport(importerFile, specifier) {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importerFile), specifier));

  if (allowedGraphFiles.has(resolved) || allowedGraphRoots.some((prefix) => resolved.startsWith(prefix))) {
    return { file: resolved };
  }

  return {
    error: `relative import resolves outside repository/docs public source roots: ${specifier}`,
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
      if (skippedDirectoryNames.has(entry.name)) {
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
  const files = [];

  for (const relativeRoot of recursiveRoots) {
    files.push(...await collectRecursiveTextFiles(path.join(root, relativeRoot), relativeRoot));
  }

  return sortUnique(files);
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

async function readTextSource(file) {
  const inspected = await inspectTextSource(file);
  return inspected.state === 'ok' ? inspected.source : null;
}

async function walkStaticImportGraph(seedFiles, readSource) {
  const discovered = new Set(sortUnique(seedFiles));
  const queue = [...sortUnique(seedFiles)];
  const visited = new Set();
  const missingFiles = new Set();
  const graphFailures = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) {
      continue;
    }

    visited.add(file);
    const source = await readSource(file);
    if (source == null) {
      missingFiles.add(file);
      continue;
    }

    for (const specifier of parseStaticRelativeSpecifiers(source)) {
      const resolved = resolveRelativeImport(file, specifier);
      if (resolved.error) {
        graphFailures.push({ file, reason: resolved.error });
        continue;
      }

      if (!discovered.has(resolved.file)) {
        discovered.add(resolved.file);
        queue.push(resolved.file);
      }
    }
  }

  return {
    discoveredFiles: sortUnique(discovered),
    graphFailures: sortFailureRecords(graphFailures),
    missingFiles: sortUnique(missingFiles),
  };
}

async function selfCheckStaticImportGraph() {
  assert.deepEqual(
    parseStaticRelativeSpecifiers(
      "import './b.js';\nimport value from './a.mjs';\nexport { x } from './d.js';\nexport * from './c.mjs';",
    ),
    ['./a.mjs', './b.js', './c.mjs', './d.js'],
  );

  const actualGraphForward = await walkStaticImportGraph(
    ['docs/src/main.js', 'docs/src/hero.js'],
    readTextSource,
  );
  const actualGraphReverse = await walkStaticImportGraph(
    ['docs/src/hero.js', 'docs/src/main.js'],
    readTextSource,
  );

  assert.deepEqual(actualGraphForward.discoveredFiles, actualGraphReverse.discoveredFiles);
  assert.deepEqual(actualGraphForward.discoveredFiles, sortUnique(actualGraphForward.discoveredFiles));
  assert(actualGraphForward.discoveredFiles.includes('docs/src/sidebar.js'));
  assert(actualGraphForward.discoveredFiles.includes('docs/src/hero.js'));
  assert(actualGraphForward.discoveredFiles.includes('docs/src/code-highlight.js'));
  assert(actualGraphForward.discoveredFiles.includes('docs/src/content/index.js'));
  assert(actualGraphForward.discoveredFiles.includes('docs/shared/githubStars.js'));

  const missingGraph = await walkStaticImportGraph(
    ['docs/src/self-check-missing-entry.js'],
    async (file) => (file === 'docs/src/self-check-missing-entry.js'
      ? "import './missing-dependency.js';"
      : null),
  );
  assert(missingGraph.discoveredFiles.includes('docs/src/missing-dependency.js'));
  assert(missingGraph.missingFiles.includes('docs/src/missing-dependency.js'));
  assert.deepEqual(missingGraph.missingFiles, sortUnique(missingGraph.missingFiles));

  const cycleGraph = await walkStaticImportGraph(
    ['docs/src/self-check-cycle-a.js'],
    async (file) => {
      const sources = new Map([
        ['docs/src/self-check-cycle-a.js', "import './self-check-cycle-b.js';"],
        ['docs/src/self-check-cycle-b.js', "export * from './self-check-cycle-a.js';"],
      ]);
      return sources.get(file) ?? null;
    },
  );
  assert.deepEqual(cycleGraph.discoveredFiles, [
    'docs/src/self-check-cycle-a.js',
    'docs/src/self-check-cycle-b.js',
  ]);

  const outsideGraph = await walkStaticImportGraph(
    ['docs/src/self-check-outside.js'],
    async (file) => (file === 'docs/src/self-check-outside.js'
      ? "import './nested/../outside.js';\nimport './nested/../../README.js';"
      : null),
  );
  assert(outsideGraph.graphFailures.some((failure) => failure.file === 'docs/src/self-check-outside.js'));
  assert(
    outsideGraph.graphFailures.some((failure) => failure.reason.includes('outside repository/docs public source roots')),
  );
  assert.deepEqual(
    sortFailureRecords([
      { file: 'docs/src/z.js', reason: 'late' },
      { file: 'docs/src/a.js', reason: 'early' },
    ]),
    [
      { file: 'docs/src/a.js', reason: 'early' },
      { file: 'docs/src/z.js', reason: 'late' },
    ],
  );
}

async function main() {
  await selfCheckStaticImportGraph();

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
  const baseInventory = buildPublicInventory({ recursiveFiles, packageMarkdownFiles });
  const seedFiles = sortUnique(baseInventory.filter(isJsModule));
  const importGraph = await walkStaticImportGraph(seedFiles, readTextSource);
  const uniqueInventory = sortUnique([...baseInventory, ...importGraph.discoveredFiles]);
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

  for (const failure of importGraph.graphFailures) {
    recordInventoryFailure(failure.file, failure.reason);
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

  const passCount = uniqueInventory.length - failedInventoryFiles.size;
  assert.equal(passCount + failedInventoryFiles.size, uniqueInventory.length);

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
