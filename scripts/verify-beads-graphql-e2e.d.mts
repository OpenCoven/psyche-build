import type {
  GhRun,
} from './beads-project-sync/github.mjs';

export interface GraphqlE2eOperation {
  kind: 'query';
  name: string;
}

export interface GraphqlE2eReport {
  graphqlRequestCount: number;
  operations: GraphqlE2eOperation[];
  summary: Record<string, unknown>;
  diagnostics: string;
}

export interface GraphqlE2eOptions {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  run?: GhRun;
  runCli?: (
    argv: readonly string[],
    dependencies: {
      cwd: string;
      env: Readonly<Record<string, string | undefined>>;
      run: GhRun;
      stdout: { write(chunk: string): unknown };
      stderr: { write(chunk: string): unknown };
    },
  ) => Promise<number>;
}

export function runBeadsGraphqlE2e(
  options?: GraphqlE2eOptions,
): Promise<GraphqlE2eReport>;
