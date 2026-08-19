#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  modules as contentModules,
  sections as contentSections,
  validateNavigationGraph,
} from '../docs/src/content/index.js';
import { renderHero } from '../docs/src/hero.js';
import { executeNpmPackDryRun } from './npm-pack-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const textExtensions = new Set(['.js', '.mjs', '.html', '.css', '.svg', '.md', '.json']);
const requiredSourceFiles = sortUnique([
  'docs/src/hero.js',
  'docs/src/index.html',
  'docs/src/content/index.js',
  'docs/src/content/agents.js',
  'docs/src/content/configuration.js',
  'docs/src/content/core-concepts.js',
  'docs/src/content/features.js',
  'docs/src/content/getting-started.js',
  'docs/src/content/hooks.js',
  'docs/src/content/introduction.js',
  'docs/src/content/keyboard-shortcuts.js',
  'docs/src/content/merging.js',
  'docs/src/content/multi-agent.js',
  'docs/src/content/multi-project.js',
  'docs/src/content/remote-access.js',
  'docs/src/content/troubleshooting.js',
  'docs/src/content/workflows.js',
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
const prohibitedReferencePatterns = [
  [/COVEN-DEMO-LOOP\.md/i, 'reference to prohibited standalone documentation'],
  [/COVEN-SESSIONS\.md/i, 'reference to prohibited standalone documentation'],
];
const prohibitedPositionPatterns = [
  [/coven demo loop/i, 'standalone Coven demo positioning'],
  [/fix openclaw cockpit/i, 'standalone OpenClaw promotion'],
  [/\b(?:OpenMeow|OpenClaw)\b/i, 'external ecosystem product positioning'],
  [/opencoven public roadmap/i, 'external ecosystem roadmap promotion'],
  [/led by\s*<strong>\s*coven code\s*<\/strong>/i, 'agent catalog product favoritism'],
  [/^## Coven integration smoke/im, 'standalone Coven integration runbook'],
  [/^## Coven bridge smoke/im, 'standalone Coven bridge runbook'],
  [/^## Relationship to OpenMeow, OpenClaw, and Coven/im, 'external ecosystem positioning'],
];
const prohibitedFiles = new Map(
  ['docs/COVEN-DEMO-LOOP.md', 'docs/COVEN-SESSIONS.md'].map((file) => [normalizePublicPath(file), file]),
);
const requiredPackageDocumentationFiles = ['docs/INTEGRATIONS.md'];
const historicalDocumentationPrefixes = [
  'docs/superpowers/plans/',
  'docs/superpowers/specs/',
];
const generatedAgentsDocumentationFiles = new Set([
  'scripts/generate-hooks-docs.js',
  'src/utils/generated-agents-doc.ts',
]);
const generatedDocumentationPrefixes = [
  'docs/client/',
  'docs/src/dist/',
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

function normalizePublicPath(file) {
  return file.toLowerCase();
}

function sortUniquePublicPaths(values) {
  const filesByIdentity = new Map();
  for (const file of values) {
    const identity = normalizePublicPath(file);
    if (!filesByIdentity.has(identity)) {
      filesByIdentity.set(identity, file);
    }
  }

  return [...filesByIdentity.values()].sort(compareStrings);
}

function sortFailureRecords(records) {
  return [...records].sort(
    (left, right) => compareStrings(left.file, right.file) || compareStrings(left.reason, right.reason),
  );
}

function isTextAsset(relativePath) {
  return textExtensions.has(path.extname(relativePath).toLowerCase());
}

function collectPackageMarkdownFiles(packageFilesValue, packedFilesValue) {
  const markdownFiles = [];
  const boundaryFailures = [];
  const archiveFailures = [];
  const packageFiles = [];

  if (!Array.isArray(packageFilesValue)) {
    boundaryFailures.push({ file: 'package.json#files', reason: 'package.json.files must be an array of strings' });
    return {
      packageFiles,
      markdownFiles,
      boundaryFailures: sortFailureRecords(boundaryFailures),
      archiveFailures,
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

  if (packedFilesValue !== undefined) {
    if (!Array.isArray(packedFilesValue) || packedFilesValue.some((file) => typeof file !== 'string')) {
      archiveFailures.push({
        file: 'npm pack --dry-run',
        reason: 'npm package archive file list must be an array of strings',
      });
    } else {
      const packedFiles = new Set(packedFilesValue.map(normalizePublicPath));
      for (const file of sortUnique([
        ...markdownFiles,
        ...requiredPackageDocumentationFiles,
      ])) {
        if (!packedFiles.has(normalizePublicPath(file))) {
          archiveFailures.push({
            file,
            reason: 'required documentation is missing from the npm package archive',
          });
        }
      }
      for (const [identity, file] of prohibitedFiles) {
        if (packedFiles.has(identity)) {
          archiveFailures.push({
            file,
            reason: 'prohibited documentation is present in the npm package archive',
          });
        }
      }
    }
  }

  return {
    packageFiles: sortUnique(packageFiles),
    markdownFiles: sortUnique(markdownFiles),
    boundaryFailures: sortFailureRecords(boundaryFailures),
    archiveFailures: sortFailureRecords(archiveFailures),
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

async function collectPackedFilePaths() {
  const stdout = await executeNpmPackDryRun(execFileAsync, { cwd: root });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || !result[0] || !Array.isArray(result[0].files)) {
    throw new Error('npm pack --dry-run --json returned an invalid file list');
  }
  return result[0].files.map((entry) => entry.path);
}

async function collectTrackedFiles() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean).sort(compareStrings);
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

async function collectTopLevelMarkdownFiles(relativeDirectory, readDirectory) {
  let entries;
  try {
    entries = await readDirectory(relativeDirectory);
  } catch (error) {
    if (isEnoent(error)) {
      return {
        files: [],
        missingRootFailure: {
          file: relativeDirectory,
          reason: 'public documentation top-level docs directory is missing',
        },
      };
    }

    throw error;
  }

  const sortedEntries = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  const files = [];

  for (const entry of sortedEntries) {
    if (!entry.isFile()) {
      continue;
    }

    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (path.extname(entry.name).toLowerCase() === '.md') {
      files.push(relativePath);
    }
  }

  return { files: sortUnique(files), missingRootFailure: null };
}

async function collectRootMarkdownFiles(readDirectory) {
  let entries;
  try {
    entries = await readDirectory('');
  } catch (error) {
    if (isEnoent(error)) {
      return {
        files: [],
        missingRootFailure: {
          file: '.',
          reason: 'public documentation root is missing',
        },
      };
    }

    throw error;
  }

  const sortedEntries = [...entries].sort((left, right) => compareStrings(left.name, right.name));
  const files = [];

  for (const entry of sortedEntries) {
    if (!entry.isFile()) {
      continue;
    }

    if (path.extname(entry.name).toLowerCase() === '.md') {
      files.push(entry.name);
    }
  }

  return { files: sortUnique(files), missingRootFailure: null };
}

async function readDirectoryFromFilesystem(relativeDirectory) {
  return readdir(path.join(root, relativeDirectory), { withFileTypes: true });
}

async function collectPublicRootMarkdownFiles() {
  return collectRootMarkdownFiles(readDirectoryFromFilesystem);
}

async function collectPublicRecursiveFiles() {
  return collectRecursiveTextFiles('docs/src', readDirectoryFromFilesystem);
}

async function collectPublicSharedFiles() {
  return collectRecursiveTextFiles('docs/shared', readDirectoryFromFilesystem);
}

async function collectPublicStaticFiles() {
  return collectRecursiveTextFiles('docs/public', readDirectoryFromFilesystem);
}

async function collectPublicTopLevelDocsFiles() {
  return collectTopLevelMarkdownFiles('docs', readDirectoryFromFilesystem);
}

function buildPublicInventory({
  trackedFiles,
  rootMarkdownFiles,
  recursiveFiles,
  sharedFiles = [],
  staticFiles = [],
  topLevelDocsFiles,
  packageMarkdownFiles,
}) {
  if (Array.isArray(trackedFiles)) {
    return sortUniquePublicPaths(trackedFiles.filter(isTrackedPublicDocumentationFile));
  }

  return sortUniquePublicPaths([
    ...rootMarkdownFiles,
    ...requiredSourceFiles,
    ...recursiveFiles,
    ...sharedFiles,
    ...staticFiles,
    ...topLevelDocsFiles,
    ...packageMarkdownFiles,
  ]);
}

function isTrackedPublicDocumentationFile(file) {
  if (historicalDocumentationPrefixes.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  if (generatedDocumentationPrefixes.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  if (generatedAgentsDocumentationFiles.has(file)) {
    return true;
  }
  if (path.posix.extname(file).toLowerCase() === '.md') {
    return true;
  }
  if (requiredSourceFiles.includes(file)) {
    return true;
  }
  return file.startsWith('docs/') && isTextAsset(file);
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

function findProhibitedReasons(source) {
  const reasons = [];

  for (const [pattern, reason] of prohibitedReferencePatterns) {
    if (pattern.test(source)) {
      reasons.push(reason);
    }
  }

  for (const [pattern, reason] of prohibitedPositionPatterns) {
    if (pattern.test(source)) {
      reasons.push(reason);
    }
  }

  return sortUnique(reasons);
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
  const rootTree = new Map([
    [
      '',
      [
        createSyntheticDirEntry('CHANGELOG.md', 'file'),
        createSyntheticDirEntry('README.md', 'file'),
        createSyntheticDirEntry('CONTRIBUTING.md', 'file'),
        createSyntheticDirEntry('docs', 'dir'),
        createSyntheticDirEntry('notes.txt', 'file'),
      ],
    ],
    [
      'docs',
      [createSyntheticDirEntry('ignored.md', 'file')],
    ],
  ]);
  const rootResult = await collectRootMarkdownFiles(createSyntheticDirectoryReader(rootTree));
  assert.deepEqual(rootResult.files, ['CHANGELOG.md', 'CONTRIBUTING.md', 'README.md']);
  assert.deepEqual(rootResult.files, sortUnique(rootResult.files));
  assert(rootResult.files.every((file) => !file.includes('/')));
  assert.deepEqual(rootResult.missingRootFailure, null);
  assert(rootResult.files.includes('CHANGELOG.md'));
  assert(rootResult.files.includes('CONTRIBUTING.md'));
  assert(rootResult.files.includes('README.md'));

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

  const sharedTree = new Map([
    [
      'docs/shared',
      [
        createSyntheticDirEntry('githubStars.js', 'file'),
        createSyntheticDirEntry('navigation.js', 'file'),
      ],
    ],
  ]);
  const sharedResult = await collectRecursiveTextFiles(
    'docs/shared',
    createSyntheticDirectoryReader(sharedTree),
  );
  assert.deepEqual(sharedResult.files, ['docs/shared/githubStars.js', 'docs/shared/navigation.js']);
  assert.deepEqual(sharedResult.missingRootFailure, null);

  const staticTree = new Map([
    [
      'docs/public',
      [
        createSyntheticDirEntry('favicon.svg', 'file'),
        createSyntheticDirEntry('og.svg', 'file'),
      ],
    ],
  ]);
  const staticResult = await collectRecursiveTextFiles(
    'docs/public',
    createSyntheticDirectoryReader(staticTree),
  );
  assert.deepEqual(staticResult.files, ['docs/public/favicon.svg', 'docs/public/og.svg']);
  assert.deepEqual(staticResult.missingRootFailure, null);

  const trackedInventory = buildPublicInventory({
    trackedFiles: [
      ...requiredSourceFiles,
      'README.md',
      'docs/brand/source/psyche-hero.svg',
      'docs/client/generated.js',
      'docs/src/dist/generated.js',
      'docs/superpowers/plans/history.md',
      'native/ios/README.md',
      'protocol-fixtures/README.md',
      'scripts/generate-hooks-docs.js',
      'src/utils/generated-agents-doc.ts',
    ],
    rootMarkdownFiles: ['UNTRACKED-NOTE.md'],
    recursiveFiles: ['docs/src/untracked.js'],
    topLevelDocsFiles: ['docs/UNTRACKED.md'],
    packageMarkdownFiles: [],
  });
  assert(trackedInventory.includes('native/ios/README.md'));
  assert(trackedInventory.includes('protocol-fixtures/README.md'));
  assert(trackedInventory.includes('docs/brand/source/psyche-hero.svg'));
  assert(trackedInventory.includes('scripts/generate-hooks-docs.js'));
  assert(trackedInventory.includes('src/utils/generated-agents-doc.ts'));
  assert(!trackedInventory.includes('UNTRACKED-NOTE.md'));
  assert(!trackedInventory.includes('docs/UNTRACKED.md'));
  assert(!trackedInventory.includes('docs/client/generated.js'));
  assert(!trackedInventory.includes('docs/src/dist/generated.js'));
  assert(!trackedInventory.includes('docs/superpowers/plans/history.md'));

  const topLevelDocsTree = new Map([
    [
      'docs',
      [
        createSyntheticDirEntry('CONTROL-PLANE.md', 'file'),
        createSyntheticDirEntry('HIGH_REFRESH.md', 'file'),
        createSyntheticDirEntry('COVEN-DEMO-LOOP.md', 'file'),
        createSyntheticDirEntry('COVEN-SESSIONS.md', 'file'),
        createSyntheticDirEntry('README.md', 'file'),
        createSyntheticDirEntry('superpowers', 'dir'),
        createSyntheticDirEntry('notes.txt', 'file'),
      ],
    ],
    [
      'docs/superpowers',
      [createSyntheticDirEntry('ignored.md', 'file')],
    ],
  ]);
  const topLevelDocsResult = await collectTopLevelMarkdownFiles(
    'docs',
    createSyntheticDirectoryReader(topLevelDocsTree),
  );
  assert.deepEqual(topLevelDocsResult.files, [
    'docs/CONTROL-PLANE.md',
    'docs/COVEN-DEMO-LOOP.md',
    'docs/COVEN-SESSIONS.md',
    'docs/HIGH_REFRESH.md',
    'docs/README.md',
  ]);
  assert.deepEqual(topLevelDocsResult.files, sortUnique(topLevelDocsResult.files));
  assert(topLevelDocsResult.files.every((file) => file.startsWith('docs/')));
  assert(!topLevelDocsResult.files.some((file) => file.includes('/superpowers/')));
  assert.deepEqual(topLevelDocsResult.missingRootFailure, null);

  const missingTopLevelDocsResult = await collectTopLevelMarkdownFiles(
    'docs',
    createSyntheticDirectoryReader(new Map(), new Set(['docs'])),
  );
  assert.deepEqual(missingTopLevelDocsResult, {
    files: [],
    missingRootFailure: {
      file: 'docs',
      reason: 'public documentation top-level docs directory is missing',
    },
  });

  assert.deepEqual(findProhibitedReasons('Coven demo loop'), ['standalone Coven demo positioning']);
  assert.deepEqual(findProhibitedReasons('coven-demo-loop.md'), ['reference to prohibited standalone documentation']);
  assert.deepEqual(
    findProhibitedReasons('See [Different anchor text](../coven-sessions.md#section)'),
    ['reference to prohibited standalone documentation'],
  );
  assert.deepEqual(findProhibitedReasons('OPENCOVEN PUBLIC ROADMAP'), ['external ecosystem roadmap promotion']);

  const requiredInventory = buildPublicInventory({
    rootMarkdownFiles: rootResult.files,
    recursiveFiles: [],
    sharedFiles: sharedResult.files,
    staticFiles: staticResult.files,
    topLevelDocsFiles: topLevelDocsResult.files,
    packageMarkdownFiles: [],
  });
  assert(requiredInventory.includes('README.md'));
  assert(requiredInventory.includes('docs/README.md'));
  assertRequiredInventoryFiles(requiredInventory);

  assert.throws(
    () => {
      assertRequiredInventoryFiles(requiredInventory.filter((file) => file !== 'docs/shared/githubStars.js'));
    },
    /required docs source file missing: docs\/shared\/githubStars\.js/,
  );
  assert(requiredInventory.includes('docs/src/content/agents.js'));
  assert(requiredInventory.includes('docs/src/content/troubleshooting.js'));

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

  const missingRequiredArchiveFile = collectPackageMarkdownFiles(
    ['README.md'],
    ['README.md', 'docs/COVEN-DEMO-LOOP.md'],
  );
  assert.deepEqual(
    missingRequiredArchiveFile.archiveFailures,
    sortFailureRecords([
      {
        file: 'docs/COVEN-DEMO-LOOP.md',
        reason: 'prohibited documentation is present in the npm package archive',
      },
      {
        file: 'docs/INTEGRATIONS.md',
        reason: 'required documentation is missing from the npm package archive',
      },
    ]),
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
  assert(prohibitedFiles.has(normalizePublicPath('docs/coven-demo-loop.md')));
  assert(prohibitedFiles.has(normalizePublicPath('DOCS/COVEN-SESSIONS.MD')));
  assert.deepEqual(
    sortUniquePublicPaths(['docs/COVEN-DEMO-LOOP.md', 'docs/coven-demo-loop.md']),
    ['docs/COVEN-DEMO-LOOP.md'],
  );

  const packageInventory = buildPublicInventory({
    rootMarkdownFiles: rootResult.files,
    recursiveFiles: [],
    topLevelDocsFiles: topLevelDocsResult.files,
    packageMarkdownFiles: packageBoundaryA.markdownFiles,
  });
  assert(packageInventory.includes('CHANGELOG.md'));
  assert(packageInventory.includes('CONTRIBUTING.md'));
  assert(packageInventory.includes('README.md'));
  assert(packageInventory.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(packageInventory.includes('docs/COVEN-SESSIONS.md'));
  assert(packageInventory.includes('docs/CONTROL-PLANE.md'));
  assert(packageInventory.includes('docs/HIGH_REFRESH.md'));

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
    rootMarkdownFiles: rootResult.files,
    recursiveFiles: ['docs/src/main.js'],
    topLevelDocsFiles: ['docs/CONTROL-PLANE.md', 'docs/COVEN-DEMO-LOOP.md'],
    packageMarkdownFiles: ['README.md', 'docs/README.md', 'docs/COVEN-DEMO-LOOP.md', 'docs/COVEN-SESSIONS.md'],
  });
  assert(partialCleanupInventory.includes('docs/COVEN-DEMO-LOOP.md'));
  assert(partialCleanupInventory.includes('docs/COVEN-SESSIONS.md'));
  assert(partialCleanupInventory.includes('docs/CONTROL-PLANE.md'));
  assert(partialCleanupInventory.includes('README.md'));
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

  const [trackedFiles, packedFiles] = await Promise.all([
    collectTrackedFiles(),
    collectPackedFilePaths(),
  ]);
  const packageMarkdownResult = collectPackageMarkdownFiles(packageJson.files, packedFiles);
  const packageFiles = packageMarkdownResult.packageFiles;
  const uniqueInventory = buildPublicInventory({
    trackedFiles,
    rootMarkdownFiles: [],
    recursiveFiles: [],
    sharedFiles: [],
    staticFiles: [],
    topLevelDocsFiles: [],
    packageMarkdownFiles: packageMarkdownResult.markdownFiles,
  });
  const inventorySet = new Set(uniqueInventory);

  const inventoryFailures = [];
  const packageBoundaryFailures = [...packageMarkdownResult.boundaryFailures];
  const packageArchiveFailures = [...packageMarkdownResult.archiveFailures];
  const sourceRootFailures = [];
  for (const file of requiredSourceFiles) {
    if (!inventorySet.has(file)) {
      sourceRootFailures.push({
        file,
        reason: 'required public documentation source is not tracked',
      });
    }
  }
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

  for (const file of packageFiles) {
    if (prohibitedFiles.has(normalizePublicPath(file))) {
      recordGlobalFailure(file, 'must not be package-published');
    }
  }

  for (const file of uniqueInventory) {
    if (prohibitedFiles.has(normalizePublicPath(file))) {
      recordGlobalFailure(file, 'standalone public document must be removed');
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

    for (const reason of findProhibitedReasons(inspected.source)) {
      recordInventoryFailure(file, reason);
    }
  }

  for (const reason of validateNavigationGraph({
    modules: contentModules,
    sections: contentSections,
    renderedEntries: [
      {
        source: 'docs/src/hero.js',
        rendered: renderHero(null),
      },
    ],
  })) {
    globalFailures.push({
      file: 'docs/src/content/index.js',
      reason,
    });
  }

  const passCount = countInventoryPasses(uniqueInventory, failedInventoryFiles);
  const sortedInventoryFailures = sortFailureRecords(inventoryFailures);
  const sortedPackageBoundaryFailures = sortFailureRecords(packageBoundaryFailures);
  const sortedPackageArchiveFailures = sortFailureRecords(packageArchiveFailures);
  const sortedSourceRootFailures = sortFailureRecords(sourceRootFailures);
  const sortedGlobalFailures = sortFailureRecords(globalFailures);

  if (
    sortedInventoryFailures.length > 0
    || sortedPackageBoundaryFailures.length > 0
    || sortedPackageArchiveFailures.length > 0
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

    if (sortedPackageArchiveFailures.length > 0) {
      console.error('Package archive failures:');
      for (const failure of sortedPackageArchiveFailures) {
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
