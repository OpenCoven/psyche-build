#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
const packageName = packageJson.name;
const publicSpecifier = `${packageName}/control-task-tokens`;
const subpath = './control-task-tokens';
const requiredRuntimeKeys = [
  'issueControlTaskCredential',
  'issueControlTaskCredentialForCanonicalRoot',
  'issueControlTaskToken',
  'issueControlTaskTokenForCanonicalRoot',
  'revokeControlTaskCredential',
  'revokeControlTaskCredentialForCanonicalRoot',
];
const requiredPackFiles = [
  'dist/control-task-tokens.js',
  'dist/control-task-tokens.d.ts',
];
const tscBin = path.join(path.dirname(require.resolve('typescript')), 'tsc.js');
const exportedSubpath = packageJson.exports?.[subpath];

if (!exportedSubpath || typeof exportedSubpath !== 'object' || Array.isArray(exportedSubpath)) {
  throw new Error(`package.json is missing an object export for ${subpath}`);
}

const gitDir = path.resolve(projectRoot, run('git', ['rev-parse', '--git-dir'], projectRoot).trim());
const artifactRoot = path.join(
  gitDir,
  'pack-smoke',
  `control-task-tokens-${process.pid}-${Date.now().toString(36)}`,
);
const packOutputDir = path.join(artifactRoot, 'pack');
const consumerRoot = path.join(artifactRoot, 'consumer');
const typecheckSourcePath = path.join(consumerRoot, 'check-types.mts');
const typecheckConfigPath = path.join(consumerRoot, 'tsconfig.json');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, cwd, stdio = 'pipe') {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio,
  });
}

function parsePackJson(output) {
  const trimmed = output.trim();
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const candidateStart = trimmed[index];
    if (candidateStart !== '[' && candidateStart !== '{') {
      continue;
    }
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Keep scanning backward until the trailing JSON block parses cleanly.
    }
  }

  throw new Error(`Unable to parse npm pack JSON output:\n${output}`);
}

function readPackEntry(args) {
  const parsed = parsePackJson(run('npm', args, projectRoot));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;

  assert(entry && typeof entry === 'object', `npm ${args.join(' ')} returned no pack metadata`);
  return entry;
}

function readPackPaths(entry) {
  return new Set(
    (Array.isArray(entry.files) ? entry.files : [])
      .map((file) => (file && typeof file === 'object' ? file.path : undefined))
      .filter((filePath) => typeof filePath === 'string'),
  );
}

function verifyPackIncludes(entry, label) {
  const packedPaths = readPackPaths(entry);
  const missing = requiredPackFiles.filter((filePath) => !packedPaths.has(filePath));

  assert(
    missing.length === 0,
    `${label} is missing ${missing.join(', ')}`,
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function assertStringArrayEqual(actual, expected, label) {
  assert(Array.isArray(actual), `${label} is not an array`);
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${label} expected ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`,
  );
}

try {
  fs.mkdirSync(packOutputDir, { recursive: true });

  run('pnpm', ['run', 'clean'], projectRoot);

  const dryRunEntry = readPackEntry(['pack', '--dry-run', '--json']);
  verifyPackIncludes(dryRunEntry, 'npm pack --dry-run --json');
  for (const relativePath of requiredPackFiles) {
    assert(
      fs.existsSync(path.join(projectRoot, relativePath)),
      `prepack did not emit ${relativePath}`,
    );
  }

  // The dry-run already exercised the clean-tree prepack build. Reuse that
  // exact output to create the installable tarball without rebuilding twice.
  const packEntry = readPackEntry([
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packOutputDir,
  ]);
  verifyPackIncludes(packEntry, 'npm pack');
  assert(
    typeof packEntry.filename === 'string' && packEntry.filename.length > 0,
    'npm pack did not return a tarball filename',
  );

  const tarballPath = path.join(packOutputDir, packEntry.filename);
  assert(fs.existsSync(tarballPath), `npm pack did not create ${tarballPath}`);

  fs.mkdirSync(consumerRoot, { recursive: true });
  run('npm', ['init', '-y'], consumerRoot, 'ignore');
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
    consumerRoot,
  );

  const installedPackageRoot = path.join(consumerRoot, 'node_modules', ...packageName.split('/'));
  const installedPackageJson = JSON.parse(
    fs.readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf-8'),
  );
  const installedSubpathExport = installedPackageJson.exports?.[subpath];
  assert(
    installedSubpathExport
      && typeof installedSubpathExport === 'object'
      && !Array.isArray(installedSubpathExport),
    `installed package is missing an object export for ${subpath}`,
  );
  assert(
    typeof installedSubpathExport.import === 'string'
      && installedSubpathExport.import.length > 0,
    `installed package export is missing an import path for ${subpath}`,
  );
  assert(
    typeof installedSubpathExport.types === 'string'
      && installedSubpathExport.types.length > 0,
    `installed package export is missing a types path for ${subpath}`,
  );

  const installedDtsPath = path.join(
    installedPackageRoot,
    installedSubpathExport.types.replace(/^\.\//, ''),
  );
  assert(
    fs.existsSync(installedDtsPath),
    `installed package is missing ${installedSubpathExport.types}`,
  );

  const declarations = fs.readFileSync(installedDtsPath, 'utf-8');
  for (const expectedSnippet of [
    'export interface IssueControlTaskCredentialOptions',
    'export interface IssueControlTaskCredentialForCanonicalRootOptions',
    'export interface IssueControlTaskTokenOptions',
    'export interface IssueControlTaskTokenForCanonicalRootOptions',
    'export interface RevokeControlTaskCredentialOptions',
    'export interface RevokeControlTaskCredentialForCanonicalRootOptions',
    'export declare function issueControlTaskCredential',
    'export declare function issueControlTaskCredentialForCanonicalRoot',
    'export declare function issueControlTaskToken',
    'export declare function issueControlTaskTokenForCanonicalRoot',
    'export declare function revokeControlTaskCredential',
    'export declare function revokeControlTaskCredentialForCanonicalRoot',
  ]) {
    assert(
      declarations.includes(expectedSnippet),
      `installed declarations are missing ${expectedSnippet}`,
    );
  }
  for (const leakedSnippet of [
    'createControlCredentialStore',
    'ControlCredentialStore',
    'CredentialCreationOps',
  ]) {
    assert(
      !declarations.includes(leakedSnippet),
      `installed declarations leaked ${leakedSnippet}`,
    );
  }

  const runtimeOutput = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const entry = await import(${JSON.stringify(publicSpecifier)});`,
        'console.log(JSON.stringify({',
        '  keys: Object.keys(entry).sort(),',
        '  kinds: {',
        '    issueControlTaskCredential: typeof entry.issueControlTaskCredential,',
        '    issueControlTaskCredentialForCanonicalRoot: typeof entry.issueControlTaskCredentialForCanonicalRoot,',
        '    issueControlTaskToken: typeof entry.issueControlTaskToken,',
        '    issueControlTaskTokenForCanonicalRoot: typeof entry.issueControlTaskTokenForCanonicalRoot,',
        '    revokeControlTaskCredential: typeof entry.revokeControlTaskCredential,',
        '    revokeControlTaskCredentialForCanonicalRoot: typeof entry.revokeControlTaskCredentialForCanonicalRoot,',
        '  },',
        '}));',
      ].join('\n'),
    ],
    consumerRoot,
  ).trim();
  const runtimeCheck = JSON.parse(runtimeOutput);
  assertStringArrayEqual(runtimeCheck.keys, requiredRuntimeKeys, 'runtime export keys');
  assert(
    runtimeCheck.kinds.issueControlTaskCredential === 'function'
    && runtimeCheck.kinds.issueControlTaskCredentialForCanonicalRoot === 'function'
    && runtimeCheck.kinds.issueControlTaskToken === 'function'
    && runtimeCheck.kinds.issueControlTaskTokenForCanonicalRoot === 'function'
    && runtimeCheck.kinds.revokeControlTaskCredential === 'function'
    && runtimeCheck.kinds.revokeControlTaskCredentialForCanonicalRoot === 'function',
    `runtime exports were not functions: ${JSON.stringify(runtimeCheck.kinds)}`,
  );

  writeFile(typecheckSourcePath, [
    'import {',
    '  issueControlTaskCredential,',
    '  issueControlTaskCredentialForCanonicalRoot,',
    '  issueControlTaskToken,',
    '  issueControlTaskTokenForCanonicalRoot,',
    '  revokeControlTaskCredential,',
    '  revokeControlTaskCredentialForCanonicalRoot,',
    '  type IssueControlTaskCredentialOptions,',
    '  type IssueControlTaskCredentialForCanonicalRootOptions,',
    '  type IssueControlTaskTokenOptions,',
    '  type IssueControlTaskTokenForCanonicalRootOptions,',
    '  type RevokeControlTaskCredentialOptions,',
    '  type RevokeControlTaskCredentialForCanonicalRootOptions,',
    `} from ${JSON.stringify(publicSpecifier)};`,
    '',
    'const issueRootOptions: IssueControlTaskCredentialOptions = {',
    "  projectRoot: '/repo',",
    "  taskId: 'task-123',",
    "  previousSubjectId: 'subject-123',",
    '};',
    '',
    'const rootOptions: IssueControlTaskTokenOptions = {',
    "  projectRoot: '/repo',",
    "  taskId: 'task-123',",
    '};',
    '',
    'const issueCanonicalOptions: IssueControlTaskCredentialForCanonicalRootOptions = {',
    "  canonicalProjectRoot: '/repo',",
    "  taskId: 'task-123',",
    "  previousSubjectId: 'subject-123',",
    '};',
    '',
    'const canonicalOptions: IssueControlTaskTokenForCanonicalRootOptions = {',
    "  canonicalProjectRoot: '/repo',",
    "  taskId: 'task-123',",
    '};',
    '',
    'const revokeRootOptions: RevokeControlTaskCredentialOptions = {',
    "  projectRoot: '/repo',",
    "  taskId: 'task-123',",
    "  subjectId: 'subject-123',",
    '};',
    '',
    'const revokeCanonicalOptions: RevokeControlTaskCredentialForCanonicalRootOptions = {',
    "  canonicalProjectRoot: '/repo',",
    "  taskId: 'task-123',",
    "  subjectId: 'subject-123',",
    '};',
    '',
    'void issueControlTaskCredential(issueRootOptions);',
    'void issueControlTaskToken(rootOptions);',
    'void issueControlTaskCredentialForCanonicalRoot(issueCanonicalOptions);',
    'void issueControlTaskTokenForCanonicalRoot(canonicalOptions);',
    'void revokeControlTaskCredential(revokeRootOptions);',
    'void revokeControlTaskCredentialForCanonicalRoot(revokeCanonicalOptions);',
    '',
  ].join('\n'));
  writeFile(typecheckConfigPath, JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    },
    include: ['check-types.mts'],
  }, null, 2));
  run(process.execPath, [tscBin, '-p', typecheckConfigPath], consumerRoot);

  console.log(`pack dry-run includes ${requiredPackFiles.join(' and ')}`);
  console.log(`installed ${packageName} tarball exports ${requiredRuntimeKeys.join(', ')}`);
  console.log(`verified declaration path ${path.relative(consumerRoot, installedDtsPath)}`);
} finally {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(artifactRoot));
  } catch {
    // Another run may still be using the shared parent, or it may already be gone.
  }
}
