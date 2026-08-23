import type { createGhClient, GhClient } from './github.mjs';
import type { InventorySummary } from './model.mjs';
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
  warnings: string[];
  projectUrl: string | null;
  failure?: {
    failingOperation: Record<string, string | number | readonly number[] | null>;
    cause: string;
    resolvedIssueNumbersByBeadId?: Record<string, number>;
    resolvedProjectItemIdsByBeadId?: Record<string, string>;
  };
}

export function parseCliOptions(argv: readonly string[]): CliOptions;

export function runBeadsProjectCli(
  argv: readonly string[],
  dependencies?: CliDependencies,
): Promise<number>;
