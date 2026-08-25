import type {
  ExecFileRun,
} from './beads-project-sync/source.mjs';
import type {
  CliSummary,
} from './beads-project-sync/cli.mjs';

export interface GraphqlE2eOperation {
  kind: 'query';
  name: string;
}

export interface GraphqlE2eReport {
  graphqlRequestCount: number;
  operations: GraphqlE2eOperation[];
  pageCounts: {
    DiscoverManagedProject: number;
    DiscoverLinkedProjectRepositories: number;
    DiscoverManagedProjectItems: number;
  };
  summary: CliSummary;
  diagnostics: string;
}

export interface GraphqlE2eOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  run?: ExecFileRun;
  runCli?: (
    argv: readonly string[],
    dependencies: {
      cwd: string;
      env: Readonly<Record<string, string | undefined>>;
      run: ExecFileRun;
      stdout: { write(chunk: string): unknown };
      stderr: { write(chunk: string): unknown };
    },
  ) => Promise<number>;
}

export function runBeadsGraphqlE2e(
  options?: GraphqlE2eOptions,
): Promise<GraphqlE2eReport>;
