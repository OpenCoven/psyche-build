import { mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveControlCredentialPaths,
  taskCredentialLockDirectoryPath,
  taskCredentialRecordPath,
} from '../../src/control/credentialPaths.js';

export interface TestControlStatePaths {
  tempParent: string;
  projectRoot: string;
  stateRoot: string;
}

export function testControlStateRoot(projectRoot: string): string {
  return path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}.control-state`);
}

function ensureInsideTestTempParent(tempParent: string, targetPath: string): string {
  const resolvedTempParent = path.resolve(tempParent);
  const resolvedTargetPath = path.resolve(targetPath);
  const relative = path.relative(resolvedTempParent, resolvedTargetPath);
  if (
    relative.length === 0
    || relative === '.'
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(
      `Refusing to clean up ${resolvedTargetPath} outside test temp parent ${resolvedTempParent}`,
    );
  }
  return resolvedTargetPath;
}

async function createTestControlStatePathsUnder(
  tempRoot: string,
  prefix: string,
): Promise<TestControlStatePaths> {
  await mkdir(tempRoot, { recursive: true });
  const tempParent = await realpath(await mkdtemp(path.join(tempRoot, `${prefix}-`)));
  const requestedProjectRoot = path.join(tempParent, 'p');
  await mkdir(requestedProjectRoot, { recursive: true });
  const projectRoot = await realpath(requestedProjectRoot);
  const stateRoot = testControlStateRoot(projectRoot);

  ensureInsideTestTempParent(tempParent, projectRoot);
  ensureInsideTestTempParent(tempParent, stateRoot);

  return {
    tempParent,
    projectRoot,
    stateRoot,
  };
}

export async function createIsolatedTestControlStatePaths(
  prefix: string,
): Promise<TestControlStatePaths> {
  return createTestControlStatePathsUnder(tmpdir(), prefix);
}

export async function createWorktreeTestControlStatePaths(
  prefix: string,
): Promise<TestControlStatePaths> {
  return createTestControlStatePathsUnder(path.resolve(process.cwd(), '.c'), prefix);
}

export async function cleanupTestControlStatePaths(
  fixtures: readonly TestControlStatePaths[],
): Promise<void> {
  await Promise.all(fixtures.map(async ({ tempParent, projectRoot, stateRoot }) => {
    const resolvedProjectRoot = ensureInsideTestTempParent(tempParent, projectRoot);
    const resolvedStateRoot = ensureInsideTestTempParent(tempParent, stateRoot);
    await Promise.allSettled([
      rm(resolvedProjectRoot, { recursive: true, force: true }),
      rm(resolvedStateRoot, { recursive: true, force: true }),
    ]);
    await rmdir(path.resolve(tempParent)).catch(() => undefined);
  }));
}

export function testResolvedControlCredentialPaths(
  projectRoot: string,
  filePath?: string,
) {
  return resolveControlCredentialPaths({
    canonicalProjectRoot: projectRoot,
    ...(filePath === undefined ? {} : { filePath }),
    stateRoot: testControlStateRoot(projectRoot),
  });
}

export function testTaskCredentialDirectory(
  projectRoot: string,
  filePath?: string,
): string {
  return testResolvedControlCredentialPaths(projectRoot, filePath).taskCredentialsDirectory;
}

export function testTaskCredentialRecordPath(
  projectRoot: string,
  taskId: string,
  filePath?: string,
): string {
  return taskCredentialRecordPath(
    testTaskCredentialDirectory(projectRoot, filePath),
    taskId,
  );
}

export function testTaskCredentialLockDirectory(
  projectRoot: string,
  taskId: string,
  filePath?: string,
): string {
  return taskCredentialLockDirectoryPath(
    testResolvedControlCredentialPaths(projectRoot, filePath).taskCredentialLocksDirectory,
    taskId,
  );
}
