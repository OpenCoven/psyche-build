import type { createGhClient, GhClient, DuplicateManagedIssueGroup } from './github.mjs';
import type { ExecFileRun } from './source.mjs';

export interface WritableStream {
  write(chunk: string): unknown;
}

export interface ReconcileDuplicatesCliDependencies {
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
    projectMarker?: string;
    issueMarker?: string;
    applyLockRef?: string;
    trustedIssueAuthors?: readonly string[];
  }) => GhClient);
  stdout?: WritableStream;
  stderr?: WritableStream;
}

export interface ReconcileDuplicatesCliOptions {
  apply: boolean;
  confirmIssueNumbers: number[] | null;
}

export function parseReconcileDuplicatesCliOptions(
  argv: readonly string[],
): ReconcileDuplicatesCliOptions;

export function runReconcileDuplicatesCli(
  argv: readonly string[],
  dependencies?: ReconcileDuplicatesCliDependencies,
): Promise<number>;

export type { DuplicateManagedIssueGroup };
