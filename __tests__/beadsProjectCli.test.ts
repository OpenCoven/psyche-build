import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseSyncConfig,
  readSyncConfig,
} from '../scripts/beads-project-sync/config.mjs';
import {
  parseCliOptions,
  runBeadsProjectCli,
} from '../scripts/beads-project-sync/cli.mjs';
import {
  loadBeadsSource,
} from '../scripts/beads-project-sync/source.mjs';
import type {
  GhClient,
  ProjectContext,
} from '../scripts/beads-project-sync/github.mjs';
import type {
  ExecFileRun,
  ExecFileRunOptions,
} from '../scripts/beads-project-sync/source.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(repositoryRoot, '__tests__/fixtures/beads-project-sync/issues.jsonl');
const configPath = join(repositoryRoot, '.github/beads-project-sync.json');
const token = 'github_pat_DO_NOT_LEAK';

interface CapturedCli {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FakeGhOptions {
  existingIssues?: readonly Record<string, unknown>[];
  project?: ProjectContext | null;
}

function streamCapture() {
  let value = '';
  return {
    stream: {
      write(chunk: string) {
        value += chunk;
        return true;
      },
    },
    read() {
      return value;
    },
  };
}

function managedIssue(beadId: string, number: number) {
  return {
    beadId,
    number,
    title: `[${beadId}] Historical managed issue`,
    body: `<!-- psyche-bead-sync:v1 bead-id=${beadId} -->`,
    state: 'open',
    assignee: null,
    renderHash: null,
    projectItem: null,
    parentIssueNumber: null,
    blockerIssueNumbers: [],
  };
}

function createFakeGh(options: FakeGhOptions = {}) {
  const calls: string[] = [];
  const writes: string[] = [];
  let nextIssueNumber = 100;
  const project = options.project === undefined
    ? {
      id: 'PVT_project',
      number: 12,
      title: 'Psyche Build: Goals & Implementation',
      readme: '<!-- psyche-bead-sync:v1 project-readme -->',
      public: true,
      url: 'https://github.com/orgs/OpenCoven/projects/12',
    }
    : options.project;

  const client = {
    async verifyAccess() {
      calls.push('verifyAccess');
      return { organization: { id: 'ORG' }, repository: { id: 'REPO' } };
    },
    async discoverProject() {
      calls.push('discoverProject');
      return project;
    },
    async listManagedIssues() {
      calls.push('listManagedIssues');
      return [...(options.existingIssues ?? [])];
    },
    async ensureLabels() {
      writes.push('ensureLabels');
      return [];
    },
    async ensureFields() {
      writes.push('ensureFields');
      return new Map();
    },
    async ensureViews() {
      writes.push('ensureViews');
      return [];
    },
    async provisionProject() {
      writes.push('provisionProject');
      return {
        project: {
          id: 'PVT_created',
          number: 13,
          title: 'Psyche Build: Goals & Implementation',
          readme: '<!-- psyche-bead-sync:v1 project-readme -->',
          public: true,
          url: 'https://github.com/orgs/OpenCoven/projects/13',
        },
        fields: new Map(),
        views: [],
      };
    },
    async createIssue() {
      writes.push('createIssue');
      nextIssueNumber += 1;
      return { number: nextIssueNumber };
    },
    async updateIssue() {
      writes.push('updateIssue');
      return {};
    },
    async closeIssue() {
      writes.push('closeIssue');
      return {};
    },
    async ensureProjectItem(operation: { issueNumber: number }) {
      writes.push('ensureProjectItem');
      return { id: `ITEM_${operation.issueNumber}` };
    },
    async restoreItem() {
      writes.push('restoreItem');
    },
    async setFields() {
      writes.push('setFields');
    },
    async syncParent() {
      writes.push('syncParent');
    },
    async syncBlocker() {
      writes.push('syncBlocker');
    },
    async archiveItem() {
      writes.push('archiveItem');
    },
    async updateReadme() {
      writes.push('updateReadme');
    },
  } as unknown as GhClient;

  return { calls, client, writes };
}

async function runCli(
  args: readonly string[],
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fakeGh?: ReturnType<typeof createFakeGh>;
  } = {},
): Promise<CapturedCli> {
  const stdout = streamCapture();
  const stderr = streamCapture();
  const fakeGh = options.fakeGh ?? createFakeGh();

  const exitCode = await runBeadsProjectCli(args, {
    configPath,
    cwd: repositoryRoot,
    env: options.env ?? {},
    createGhClient() {
      return fakeGh.client;
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  return {
    exitCode,
    stdout: stdout.read(),
    stderr: stderr.read(),
  };
}

describe('Beads project sync configuration', () => {
  it('loads the exact checked-in public Project configuration', async () => {
    await expect(readSyncConfig(configPath)).resolves.toEqual({
      owner: 'OpenCoven',
      repository: 'psyche-build',
      projectTitle: 'Psyche Build: Goals & Implementation',
      projectMarker: 'psyche-beads-project-sync:v1',
      issueMarker: 'psyche-bead-sync:v1',
      assigneeMap: {},
      massClose: {
        minimum: 5,
        fraction: 0.25,
      },
    });
  });

  it('rejects malformed or unsupported safety configuration', () => {
    expect(() => parseSyncConfig({
      owner: 'OpenCoven',
      repository: 'psyche-build',
      projectTitle: 'Psyche Build: Goals & Implementation',
      projectMarker: 'psyche-beads-project-sync:v1',
      issueMarker: 'psyche-bead-sync:v1',
      assigneeMap: {},
      massClose: { minimum: 5, fraction: 2 },
    })).toThrow(/fraction/i);
  });
});

describe('Beads source adapter', () => {
  it('bootstraps then performs only a readonly export through the injected runner', async () => {
    const fixture = await readFile(fixturePath, 'utf8');
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: ExecFileRunOptions;
    }> = [];
    const run: ExecFileRun = async (command, args, options) => {
      calls.push({ command, args: [...args], options: { ...options } });
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const removed: string[] = [];

    await expect(loadBeadsSource({
      cwd: repositoryRoot,
      run,
      makeTemporaryDirectory: async () => join(repositoryRoot, '.beads-project-sync-test'),
      readFile: async () => fixture,
      remove: async (path) => {
        removed.push(path);
      },
    })).resolves.toBe(fixture);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['bootstrap', '--yes'],
        options: { cwd: repositoryRoot },
      },
      {
        command: 'bd',
        args: [
          '--readonly',
          'export',
          '-o',
          join(repositoryRoot, '.beads-project-sync-test', 'issues.jsonl'),
        ],
        options: { cwd: repositoryRoot },
      },
    ]);
    expect(removed).toEqual([join(repositoryRoot, '.beads-project-sync-test')]);
    expect(calls.flatMap((call) => call.args)).not.toContain('update');
    expect(calls.flatMap((call) => call.args)).not.toContain('close');
  });
});

describe('Beads project sync CLI', () => {
  it('allows provisioning and the close-threshold override only as apply modifiers', () => {
    expect(parseCliOptions(['--apply', '--provision', '--allow-mass-close'])).toEqual({
      mode: 'apply',
      provision: true,
      allowMassClose: true,
      inventoryFile: null,
    });
    expect(() => parseCliOptions(['--provision', '--allow-mass-close'])).toThrow(
      /only applies to reconciliation modes/i,
    );
  });

  it('dry-runs a fixture without a token, GitHub access, or writes', async () => {
    const fakeGh = createFakeGh();
    const result = await runCli(
      ['--dry-run', '--inventory-file', fixturePath],
      { fakeGh },
    );

    expect(result.exitCode).toBe(0);
    expect(fakeGh.calls).toEqual([]);
    expect(fakeGh.writes).toEqual([]);
    expect(result.stderr).toMatch(/dry run/i);
    expect(result.stderr).toMatch(/first-run plan/i);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      inventory: {
        total: 5,
        active: 4,
        closed: 1,
        blocked: 1,
        inProgress: 1,
      },
      appliedOperationCount: 0,
      projectUrl: null,
    });
    expect(JSON.parse(result.stdout).plannedOperationCount).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout).warnings).toContain(
      'BEADS_PROJECT_TOKEN is not set; remote state was not read and this is a first-run plan.',
    );
  });

  it('uses credentials for read-only remote discovery during dry-run', async () => {
    const fakeGh = createFakeGh();
    const result = await runCli(
      ['--dry-run', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(fakeGh.calls).toEqual(['verifyAccess', 'discoverProject', 'listManagedIssues']);
    expect(fakeGh.writes).toEqual([]);
    expect(JSON.parse(result.stdout).projectUrl).toBe(
      'https://github.com/orgs/OpenCoven/projects/12',
    );
  });

  it('requires BEADS_PROJECT_TOKEN for apply even with the mass-close override', async () => {
    const result = await runCli([
      '--apply',
      '--allow-mass-close',
      '--inventory-file',
      fixturePath,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/BEADS_PROJECT_TOKEN/);
  });

  it('provisions only when no marked Project exists', async () => {
    const absentProject = createFakeGh({ project: null });
    const created = await runCli(
      ['--provision', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh: absentProject,
      },
    );

    expect(created.exitCode).toBe(0);
    expect(absentProject.calls).toEqual(['verifyAccess', 'discoverProject']);
    expect(absentProject.writes).toEqual(['provisionProject']);
    expect(JSON.parse(created.stdout)).toMatchObject({
      mode: 'provision',
      appliedOperationCount: 0,
      projectUrl: 'https://github.com/orgs/OpenCoven/projects/13',
    });

    const existingProject = createFakeGh();
    const unchanged = await runCli(
      ['--provision', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh: existingProject,
      },
    );

    expect(unchanged.exitCode).toBe(0);
    expect(existingProject.writes).toEqual([]);
    expect(unchanged.stderr).toMatch(/already exists/i);
  });

  it('can provision an absent Project and apply the full plan in one run', async () => {
    const fakeGh = createFakeGh({ project: null });
    const result = await runCli(
      ['--apply', '--provision', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh,
      },
    );

    const summary = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(fakeGh.writes[0]).toBe('provisionProject');
    expect(fakeGh.writes).toContain('createIssue');
    expect(fakeGh.writes.at(-1)).toBe('updateReadme');
    expect(summary.mode).toBe('apply');
    expect(summary.appliedOperationCount).toBe(summary.plannedOperationCount);
    expect(summary.projectUrl).toBe('https://github.com/orgs/OpenCoven/projects/13');
  });

  it('fully applies the reconciliation plan through the GitHub adapter', async () => {
    const fakeGh = createFakeGh();
    const result = await runCli(
      ['--apply', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh,
      },
    );

    const summary = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(fakeGh.calls).toEqual(['verifyAccess', 'discoverProject', 'listManagedIssues']);
    expect(fakeGh.writes.slice(0, 3)).toEqual(['ensureLabels', 'ensureFields', 'ensureViews']);
    expect(fakeGh.writes).toContain('createIssue');
    expect(fakeGh.writes).toContain('setFields');
    expect(fakeGh.writes.at(-1)).toBe('updateReadme');
    expect(summary.appliedOperationCount).toBe(summary.plannedOperationCount);
    expect(summary.projectUrl).toBe('https://github.com/orgs/OpenCoven/projects/12');
  });

  it('lets --allow-mass-close override only the configured close threshold', async () => {
    const existingIssues = Array.from({ length: 6 }, (_, index) =>
      managedIssue(`historical-${index + 1}`, index + 1)
    );
    const guardedGh = createFakeGh({ existingIssues });
    const guarded = await runCli(
      ['--dry-run', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh: guardedGh,
      },
    );

    expect(guarded.exitCode).toBe(1);
    expect(guardedGh.writes).toEqual([]);
    expect(guarded.stderr).toMatch(/Refusing to close 6 managed issues; limit is 5/);

    const overrideGh = createFakeGh({ existingIssues });
    const overridden = await runCli(
      ['--dry-run', '--allow-mass-close', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh: overrideGh,
      },
    );

    expect(overridden.exitCode).toBe(0);
    expect(overrideGh.writes).toEqual([]);
    expect(JSON.parse(overridden.stdout).warnings).toContain(
      'Mass-close safety threshold overridden for this run.',
    );
  });

  it('returns nonzero with human diagnostics and no JSON on source failure', async () => {
    const missingPath = join(repositoryRoot, '__tests__/fixtures/beads-project-sync/missing.jsonl');
    const result = await runCli(['--dry-run', '--inventory-file', missingPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/missing\.jsonl/);
  });
});
