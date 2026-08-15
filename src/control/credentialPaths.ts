import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeCanonicalProjectIdentity } from './projectIdentity.js';

const CONTROL_CREDENTIAL_FILE = 'control-credentials.json' as const;
const CONTROL_STATE_DIRECTORY = 'control' as const;
const CONTROL_STATE_PROJECTS_DIRECTORY = 'projects' as const;
const TASK_CREDENTIALS_DIRECTORY = 'task-credentials' as const;
const TASK_CREDENTIAL_LOCKS_DIRECTORY = 'task-credential-locks' as const;

export interface ResolvedControlCredentialPaths {
  controlStateRoot: string;
  projectDigest: string;
  projectDirectory: string;
  credentialFilePath: string;
  credentialFileTrustRoot: 'project-root' | 'state-root';
  taskCredentialsDirectory: string;
  taskCredentialLocksDirectory: string;
}

export function psycheUserConfigDirectory(): string {
  return path.join(homedir(), '.config', 'psyche');
}

export function defaultControlStateRoot(): string {
  return path.join(psycheUserConfigDirectory(), CONTROL_STATE_DIRECTORY);
}

export function controlProjectDigest(
  canonicalProjectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHash('sha256')
    .update(normalizeCanonicalProjectIdentity(path.resolve(canonicalProjectRoot), platform), 'utf8')
    .digest('hex');
}

export function taskCredentialDigest(taskId: string): string {
  return createHash('sha256').update(taskId, 'utf8').digest('hex');
}

export function resolveControlStateRoot(stateRoot?: string): string {
  return path.resolve(stateRoot ?? defaultControlStateRoot());
}

export function resolveControlCredentialPaths(options: {
  canonicalProjectRoot: string;
  filePath?: string;
  stateRoot?: string;
}): ResolvedControlCredentialPaths {
  const controlStateRoot = resolveControlStateRoot(options.stateRoot);
  const projectDigest = controlProjectDigest(options.canonicalProjectRoot);
  const projectDirectory = path.join(
    controlStateRoot,
    CONTROL_STATE_PROJECTS_DIRECTORY,
    projectDigest,
  );
  return {
    controlStateRoot,
    projectDigest,
    projectDirectory,
    credentialFilePath: path.resolve(
      options.filePath ?? path.join(projectDirectory, CONTROL_CREDENTIAL_FILE),
    ),
    credentialFileTrustRoot: options.filePath === undefined ? 'state-root' : 'project-root',
    taskCredentialsDirectory: path.join(projectDirectory, TASK_CREDENTIALS_DIRECTORY),
    taskCredentialLocksDirectory: path.join(projectDirectory, TASK_CREDENTIAL_LOCKS_DIRECTORY),
  };
}

export function taskCredentialRecordPath(
  taskCredentialsDirectory: string,
  taskId: string,
): string {
  return path.join(taskCredentialsDirectory, `${taskCredentialDigest(taskId)}.json`);
}

export function taskCredentialLockDirectoryPath(
  taskCredentialLocksDirectory: string,
  taskId: string,
): string {
  return path.join(taskCredentialLocksDirectory, `${taskCredentialDigest(taskId)}.lock`);
}
