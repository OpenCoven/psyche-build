import { describe, expect, it } from 'vitest';

import {
  runBeadsGraphqlE2e,
} from '../scripts/verify-beads-graphql-e2e.mjs';
import type {
  ExecFileRun,
} from '../scripts/beads-project-sync/source.mjs';

const token = 'github_pat_DO_NOT_LEAK';

function graphqlPayload(kind: 'query' | 'mutation', name: string, variables = {}) {
  return `${JSON.stringify({
    query: `${kind} ${name} { viewer { login } }`,
    variables,
  })}\n`;
}

function fakeRunCli(requests: readonly {
  kind: 'query' | 'mutation';
  name: string;
  variables?: Record<string, unknown>;
}[], diagnostics = 'dry run complete') {
  return async (
    _argv: readonly string[],
    dependencies: {
      run: ExecFileRun;
      stdout: { write(chunk: string): unknown };
      stderr: { write(chunk: string): unknown };
    },
  ) => {
    for (const request of requests) {
      await dependencies.run(
        'gh',
        ['api', 'graphql', '--include', '--input', '-'],
        {
          env: { GH_TOKEN: token },
          stdin: graphqlPayload(
            request.kind,
            request.name,
            request.variables,
          ),
        },
      );
    }
    dependencies.stderr.write(`${diagnostics}\n`);
    dependencies.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      plannedOperationCount: 0,
      appliedOperationCount: 0,
    })}\n`);
    return 0;
  };
}

const delegateRun: ExecFileRun = async () => ({
  stdout: JSON.stringify({ data: {} }),
  stderr: '',
  exitCode: 0,
});

describe('Beads GraphQL live E2E verifier', () => {
  it('reports the minimal live dry-run query set without exposing the token', async () => {
    const report = await runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
        { kind: 'query', name: 'DiscoverManagedProjectItems', variables: { cursor: null } },
      ]),
    });

    expect(report).toMatchObject({
      graphqlRequestCount: 2,
      operations: [
        { kind: 'query', name: 'DiscoverManagedProject' },
        { kind: 'query', name: 'DiscoverManagedProjectItems' },
      ],
      summary: {
        mode: 'dry-run',
        appliedOperationCount: 0,
      },
      pageCounts: {
        DiscoverManagedProject: 1,
        DiscoverManagedProjectItems: 1,
      },
    });
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it('allows three or more distinct pagination requests for each required operation', async () => {
    const report = await runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: 'project-1' } },
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: 'project-2' } },
        { kind: 'query', name: 'DiscoverManagedProjectItems', variables: { cursor: null } },
        { kind: 'query', name: 'DiscoverManagedProjectItems', variables: { cursor: 'item-1' } },
        { kind: 'query', name: 'DiscoverManagedProjectItems', variables: { cursor: 'item-2' } },
        { kind: 'query', name: 'DiscoverManagedProjectItems', variables: { cursor: 'item-3' } },
      ]),
    });

    expect(report.graphqlRequestCount).toBe(7);
    expect(report.pageCounts).toEqual({
      DiscoverManagedProject: 3,
      DiscoverLinkedProjectRepositories: 0,
      DiscoverManagedProjectItems: 4,
    });
  });

  it('rejects duplicate GraphQL request payloads in one dry run', async () => {
    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
      ]),
    })).rejects.toThrow(/duplicate GraphQL request/i);
  });

  it.each([
    ['HTTP 503', {
      stdout: '',
      stderr: 'HTTP 503 transient',
      exitCode: 1,
      status: 503,
    }],
    ['transport failure', new Error('socket hang up')],
  ])('counts a retried identical request after %s as one successful logical query', async (
    _name,
    transient,
  ) => {
    let failed = false;
    const retryingDelegate: ExecFileRun = async (_command, _args, options) => {
      const request = JSON.parse(options.stdin ?? '{}') as { query?: string };
      if (!failed && request.query?.includes('DiscoverManagedProject')) {
        failed = true;
        if (transient instanceof Error) {
          throw transient;
        }
        return transient;
      }
      return delegateRun(_command, _args, options);
    };
    const retryingRunCli = async (
      _argv: readonly string[],
      dependencies: {
        run: ExecFileRun;
        stdout: { write(chunk: string): unknown };
        stderr: { write(chunk: string): unknown };
      },
    ) => {
      const projectRequest = {
        env: { GH_TOKEN: token },
        stdin: graphqlPayload('query', 'DiscoverManagedProject', { cursor: null }),
      };
      try {
        const result = await dependencies.run('gh', ['api', 'graphql'], projectRequest);
        if ((result.exitCode ?? 0) !== 0) {
          await dependencies.run('gh', ['api', 'graphql'], projectRequest);
        }
      } catch {
        await dependencies.run('gh', ['api', 'graphql'], projectRequest);
      }
      await dependencies.run('gh', ['api', 'graphql'], {
        env: { GH_TOKEN: token },
        stdin: graphqlPayload('query', 'DiscoverManagedProjectItems', { cursor: null }),
      });
      dependencies.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        appliedOperationCount: 0,
      })}\n`);
      return 0;
    };

    const report = await runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: retryingDelegate,
      runCli: retryingRunCli,
    });

    expect(report.graphqlRequestCount).toBe(2);
    expect(report.pageCounts).toMatchObject({
      DiscoverManagedProject: 1,
      DiscoverManagedProjectItems: 1,
    });
  });

  it('rejects a duplicate cursor for the same paginated operation', async () => {
    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: 'same-cursor' } },
        {
          kind: 'query',
          name: 'DiscoverManagedProject',
          variables: { cursor: 'same-cursor', harmless: true },
        },
      ]),
    })).rejects.toThrow(/duplicate.*cursor/i);
  });

  it('rejects unexpected GraphQL operation names', async () => {
    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
        { kind: 'query', name: 'UnexpectedRepositoryProbe', variables: { cursor: null } },
      ]),
    })).rejects.toThrow(/unexpected GraphQL operation/i);
  });

  it('allows bounded linked-repository fallback pagination and reports its pages', async () => {
    const report = await runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject', variables: { cursor: null } },
        {
          kind: 'query',
          name: 'DiscoverLinkedProjectRepositories',
          variables: { cursor: null, projectId: 'PVT_project' },
        },
        {
          kind: 'query',
          name: 'DiscoverLinkedProjectRepositories',
          variables: { cursor: 'repo-1', projectId: 'PVT_project' },
        },
        {
          kind: 'query',
          name: 'DiscoverLinkedProjectRepositories',
          variables: { cursor: 'repo-2', projectId: 'PVT_project' },
        },
        { kind: 'query', name: 'DiscoverManagedProjectItems', variables: { cursor: null } },
      ]),
    });

    expect(report.graphqlRequestCount).toBe(5);
    expect(report.pageCounts).toEqual({
      DiscoverManagedProject: 1,
      DiscoverLinkedProjectRepositories: 3,
      DiscoverManagedProjectItems: 1,
    });
  });

  it('fails closed when pagination exceeds the bounded per-operation ceiling', async () => {
    const runawayPages = Array.from({ length: 101 }, (_, index) => ({
      kind: 'query' as const,
      name: 'DiscoverManagedProject',
      variables: { cursor: index === 0 ? null : `project-${index}` },
    }));

    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli(runawayPages),
    })).rejects.toThrow(/page.*ceiling|pagination.*limit|runaway/i);
  });

  it('applies the global request ceiling to failed retry attempts', async () => {
    let attempts = 0;
    const repeatedlyFailingDelegate: ExecFileRun = async () => {
      attempts += 1;
      if (attempts <= 201) {
        return {
          stdout: '',
          stderr: 'HTTP 503 transient',
          exitCode: 1,
        };
      }
      return delegateRun('', [], {});
    };
    const runawayRetryRunCli = async (
      _argv: readonly string[],
      dependencies: {
        run: ExecFileRun;
        stdout: { write(chunk: string): unknown };
      },
    ) => {
      const projectRequest = {
        env: { GH_TOKEN: token },
        stdin: graphqlPayload('query', 'DiscoverManagedProject', { cursor: null }),
      };
      for (let index = 0; index < 201; index += 1) {
        await dependencies.run('gh', ['api', 'graphql'], projectRequest);
      }
      await dependencies.run('gh', ['api', 'graphql'], projectRequest);
      await dependencies.run('gh', ['api', 'graphql'], {
        env: { GH_TOKEN: token },
        stdin: graphqlPayload('query', 'DiscoverManagedProjectItems', { cursor: null }),
      });
      dependencies.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        appliedOperationCount: 0,
      })}\n`);
      return 0;
    };

    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: repeatedlyFailingDelegate,
      runCli: runawayRetryRunCli,
    })).rejects.toThrow(/request.*ceiling|runaway/i);
  });

  it('rejects GraphQL mutations during the read-only E2E', async () => {
    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'mutation', name: 'UpdateManagedProjectItemFields' },
      ]),
    })).rejects.toThrow(/mutation.*read-only/i);
  });

  it('requires a token without including its value in errors', async () => {
    await expect(runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: {},
      run: delegateRun,
      runCli: fakeRunCli([]),
    })).rejects.toThrow(/BEADS_PROJECT_TOKEN is required/i);
  });

  it('redacts the token from captured diagnostics', async () => {
    const report = await runBeadsGraphqlE2e({
      cwd: process.cwd(),
      env: { BEADS_PROJECT_TOKEN: token },
      run: delegateRun,
      runCli: fakeRunCli([
        { kind: 'query', name: 'DiscoverManagedProject' },
        { kind: 'query', name: 'DiscoverManagedProjectItems' },
      ], `unexpected credential ${token}`),
    });

    expect(report.diagnostics).toContain('[REDACTED]');
    expect(JSON.stringify(report)).not.toContain(token);
  });
});
