import {
  issueControlTaskCredential as issueControlTaskCredentialInternal,
  issueControlTaskCredentialForCanonicalRoot as issueControlTaskCredentialForCanonicalRootInternal,
  issueControlTaskToken as issueControlTaskTokenInternal,
  issueControlTaskTokenForCanonicalRoot as issueControlTaskTokenForCanonicalRootInternal,
  revokeControlTaskCredential as revokeControlTaskCredentialInternal,
  revokeControlTaskCredentialForCanonicalRoot as revokeControlTaskCredentialForCanonicalRootInternal,
  type ControlTaskCredentialReference,
  type IssuedControlTaskCredential,
  type RevokedControlTaskCredential,
} from './control/credentials.js';

/**
 * Trusted launcher-only options for rotating the single active task-bound
 * control token for a task.
 */
export interface IssueControlTaskTokenOptions {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}

/**
 * Trusted launcher-only options for rotating the single active task-bound
 * control credential for a task and returning its binding metadata.
 */
export interface IssueControlTaskCredentialOptions extends IssueControlTaskTokenOptions {
  previousSubjectId?: string;
}

/**
 * Trusted launcher-only options for rotating the single active task-bound
 * control token after the caller already canonicalized the project root.
 */
export interface IssueControlTaskTokenForCanonicalRootOptions {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}

/**
 * Trusted launcher-only options for rotating the single active task-bound
 * control credential after the caller already canonicalized the project root.
 */
export interface IssueControlTaskCredentialForCanonicalRootOptions extends IssueControlTaskTokenForCanonicalRootOptions {
  previousSubjectId?: string;
}

/** Trusted launcher-only options for revoking a task-bound control credential. */
export interface RevokeControlTaskCredentialOptions {
  projectRoot: string;
  taskId: string;
  filePath?: string;
  subjectId?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}

/**
 * Trusted launcher-only options for revoking a task-bound control credential
 * after the caller already canonicalized the project root.
 */
export interface RevokeControlTaskCredentialForCanonicalRootOptions {
  canonicalProjectRoot: string;
  taskId: string;
  filePath?: string;
  subjectId?: string;
  /** Test-only override for the trusted per-user control state root. */
  stateRoot?: string;
}

export type {
  ControlTaskCredentialReference,
  IssuedControlTaskCredential,
  RevokedControlTaskCredential,
};

/** Trusted launcher-only wrapper that rotates the active token for a task. */
export async function issueControlTaskToken(
  options: IssueControlTaskTokenOptions,
): Promise<string> {
  return issueControlTaskTokenInternal(options);
}

/**
 * Trusted launcher-only wrapper that rotates the active credential for a task
 * and returns its task/subject binding metadata.
 */
export async function issueControlTaskCredential(
  options: IssueControlTaskCredentialOptions,
): Promise<IssuedControlTaskCredential> {
  return issueControlTaskCredentialInternal(options);
}

/**
 * Trusted launcher-only wrapper for callers that already canonicalized the
 * project root before rotating one task-bound control token.
 */
export async function issueControlTaskTokenForCanonicalRoot(
  options: IssueControlTaskTokenForCanonicalRootOptions,
): Promise<string> {
  return issueControlTaskTokenForCanonicalRootInternal(options);
}

/**
 * Trusted launcher-only wrapper for callers that already canonicalized the
 * project root before rotating one task-bound control credential.
 */
export async function issueControlTaskCredentialForCanonicalRoot(
  options: IssueControlTaskCredentialForCanonicalRootOptions,
): Promise<IssuedControlTaskCredential> {
  return issueControlTaskCredentialForCanonicalRootInternal(options);
}

/** Trusted launcher-only wrapper that revokes the active credential for a task. */
export async function revokeControlTaskCredential(
  options: RevokeControlTaskCredentialOptions,
): Promise<RevokedControlTaskCredential | null> {
  return revokeControlTaskCredentialInternal(options);
}

/**
 * Trusted launcher-only wrapper for callers that already canonicalized the
 * project root before revoking one task-bound control credential.
 */
export async function revokeControlTaskCredentialForCanonicalRoot(
  options: RevokeControlTaskCredentialForCanonicalRootOptions,
): Promise<RevokedControlTaskCredential | null> {
  return revokeControlTaskCredentialForCanonicalRootInternal(options);
}
