import type { createGhClient, GhClient } from './github.mjs';
import type { InventorySummary } from './model.mjs';
import type {
  ReconciliationClosureCandidate,
  ReconciliationOperationCounts,
} from './reconcile.mjs';
import type { ExecFileRun } from './source.mjs';

export type CliMode = 'dry-run' | 'apply' | 'provision';

export interface CliOptions {
  mode: CliMode;
  provision: boolean;
  allowMassClose: boolean;
  inventoryFile: string | null;
}

export interface WritableStream {
  write(chunk: string): unknown;
}

export interface CliDependencies {
  configPath?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  run?: ExecFileRun;
  createGhClient?: typeof createGhClient | ((options: {
    run: ExecFileRun;
    owner: string;
    repo: string;
    token: string;
    projectNodeId?: string;
    bootstrap?: boolean;
    projectMarker?: string;
    issueMarker?: string;
    legacyProjectMarkers?: readonly string[];
    legacyIssueMarkers?: readonly string[];
  }) => GhClient);
  stdout?: WritableStream;
  stderr?: WritableStream;
}

export interface CliSummary {
  mode: CliMode;
  inventory: InventorySummary;
  plannedOperationCount: number;
  appliedOperationCount: number;
  operationCounts: ReconciliationOperationCounts;
  visibilityDrift: boolean;
  closureCandidates: ReconciliationClosureCandidate[];
  warnings: string[];
  projectUrl: string | null;
  failure?: {
    kind: 'apply';
    failingOperation: Record<string, string | number | readonly number[] | null>;
    cause: string;
    resolvedIssueNumbersByBeadId?: Record<string, number>;
    resolvedProjectItemIdsByBeadId?: Record<string, string>;
  } | {
    kind: 'mass-close-safety';
    cause: string;
    closeIssueCount: number;
    maxCloseCount: number;
  };
}

export function parseCliOptions(argv: readonly string[]): CliOptions;

export function runBeadsProjectCli(
  argv: readonly string[],
  dependencies?: CliDependencies,
): Promise<number>;
