export interface BeadsProjectSyncConfig {
  owner: string;
  repository: string;
  projectTitle: string;
  projectMarker: string;
  issueMarker: string;
  assigneeMap: Readonly<Record<string, string>>;
  massClose: {
    readonly minimum: number;
    readonly fraction: number;
  };
}

export const SUPPORTED_PROJECT_MARKER: 'psyche-beads-project-sync:v1';
export const SUPPORTED_ISSUE_MARKER: 'psyche-bead-sync:v1';

export function parseSyncConfig(value: unknown): BeadsProjectSyncConfig;

export function readSyncConfig(
  path: string,
  options?: {
    readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  },
): Promise<BeadsProjectSyncConfig>;
