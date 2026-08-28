import type { CanonicalTargets } from './outcomes.mjs';

export interface BeadsProjectSyncConfig {
  owner: string;
  repository: string;
  projectNodeId: string;
  projectTitle: string;
  projectMarker: string;
  issueMarker: string;
  applyLockRef: typeof APPLY_LOCK_REF;
  trustedIssueAuthors: readonly string[];
  legacyProjectMarkers?: readonly string[];
  assigneeMap: Readonly<Record<string, string>>;
  canonicalTargets: CanonicalTargets;
  massClose: {
    readonly minimum: number;
    readonly fraction: number;
  };
}

export const SUPPORTED_PROJECT_MARKER: typeof import('./markers.mjs').DEFAULT_PROJECT_MARKER;
export const SUPPORTED_ISSUE_MARKER: typeof import('./markers.mjs').DEFAULT_ISSUE_MARKER;
export const APPLY_LOCK_BRANCH: 'psyche-beads-project-sync-lock';
export const APPLY_LOCK_REF: `refs/heads/${typeof APPLY_LOCK_BRANCH}`;
export const APPLY_LOCK_REF_ENDPOINT: `heads/${typeof APPLY_LOCK_BRANCH}`;

export function parseSyncConfig(value: unknown): BeadsProjectSyncConfig;

export function readSyncConfig(
  path: string,
  options?: {
    readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  },
): Promise<BeadsProjectSyncConfig>;
