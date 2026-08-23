import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

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
  SignalProcess,
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
  failSetFields?: Error;
  project?: ProjectContext | null;
}

interface FakeClientOptions {
  run: ExecFileRun;
  owner: string;
  repo: string;
  token: string;
  projectMarker?: string;
  issueMarker?: string;
  legacyProjectMarkers?: readonly string[];
  legacyIssueMarkers?: readonly string[];
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
  const clientOptions: FakeClientOptions[] = [];
  const provisionReadmes: string[] = [];
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
    async provisionProject(input: { readme: string }) {
      writes.push('provisionProject');
      provisionReadmes.push(input.readme);
      return {
        project: {
          id: 'PVT_created',
          number: 13,
          title: 'Psyche Build: Goals & Implementation',
          readme: input.readme,
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
      if (options.failSetFields) {
        throw options.failSetFields;
      }
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

  return { calls, client, clientOptions, provisionReadmes, writes };
}

async function runCli(
  args: readonly string[],
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fakeGh?: ReturnType<typeof createFakeGh>;
    run?: ExecFileRun;
  } = {},
): Promise<CapturedCli> {
  const stdout = streamCapture();
  const stderr = streamCapture();
  const fakeGh = options.fakeGh ?? createFakeGh();

  const exitCode = await runBeadsProjectCli(args, {
    configPath,
    cwd: repositoryRoot,
    env: options.env ?? {},
    run: options.run,
    createGhClient(options: FakeClientOptions) {
      fakeGh.clientOptions.push(options);
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

  it('accepts safe configured markers and rejects comment-breaking markers', () => {
    expect(parseSyncConfig({
      owner: 'OpenCoven',
      repository: 'psyche-build',
      projectTitle: 'Psyche Build: Goals & Implementation',
      projectMarker: 'custom-project-sync:v2',
      issueMarker: 'custom-issue-sync:v2',
      legacyProjectMarkers: ['prior-project-sync:v1'],
      assigneeMap: {},
      massClose: { minimum: 5, fraction: 0.25 },
    })).toMatchObject({
      projectMarker: 'custom-project-sync:v2',
      issueMarker: 'custom-issue-sync:v2',
      legacyProjectMarkers: ['prior-project-sync:v1'],
    });

    expect(() => parseSyncConfig({
      owner: 'OpenCoven',
      repository: 'psyche-build',
      projectTitle: 'Psyche Build: Goals & Implementation',
      projectMarker: 'custom--project',
      issueMarker: 'custom-issue-sync:v2',
      assigneeMap: {},
      massClose: { minimum: 5, fraction: 0.25 },
    })).toThrow(/safe machine marker/i);
  });
});

describe('Beads source adapter', () => {
  it.each(['apply', 'provision'] as const)(
    'bootstraps for %s then performs only a readonly export outside the worktree',
    async (mode) => {
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
    const prefixes: string[] = [];
    const temporaryDirectory = join(tmpdir(), `psyche-beads-project-sync-${mode}-test`);

    await expect(loadBeadsSource({
      cwd: repositoryRoot,
      mode,
      run,
      makeTemporaryDirectory: async (prefix) => {
        prefixes.push(prefix);
        return temporaryDirectory;
      },
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
          join(temporaryDirectory, 'issues.jsonl'),
        ],
        options: { cwd: repositoryRoot },
      },
    ]);
    expect(prefixes).toEqual([
      join(await realpath(tmpdir()), 'psyche-beads-project-sync-'),
    ]);
    expect(relative(repositoryRoot, temporaryDirectory)).toMatch(/^\.\./u);
    expect(removed).toEqual([temporaryDirectory]);
    expect(calls.flatMap((call) => call.args)).not.toContain('update');
    expect(calls.flatMap((call) => call.args)).not.toContain('close');
    },
  );

  it('dry-runs with only readonly export and gives explicit bootstrap guidance on missing DBs', async () => {
    const calls: Array<{command: string; args: readonly string[]}> = [];
    const temporaryDirectory = join(tmpdir(), 'psyche-beads-project-sync-dry-test');
    const removed: string[] = [];

    await expect(loadBeadsSource({
      cwd: repositoryRoot,
      mode: 'dry-run',
      run: async (command, args) => {
        calls.push({ command, args: [...args] });
        return {
          stdout: '',
          stderr: 'no beads database found',
          exitCode: 1,
        };
      },
      makeTemporaryDirectory: async () => temporaryDirectory,
      remove: async (path) => {
        removed.push(path);
      },
    })).rejects.toThrow(/bd bootstrap --yes/i);

    expect(calls).toEqual([{
      command: 'bd',
      args: ['--readonly', 'export', '-o', join(temporaryDirectory, 'issues.jsonl')],
    }]);
    expect(removed).toEqual([temporaryDirectory]);
  });

  it('cleans the OS-temp raw export when reading the completed export fails', async () => {
    const temporaryDirectory = join(tmpdir(), 'psyche-beads-project-sync-read-failure');
    const removed: string[] = [];

    await expect(loadBeadsSource({
      cwd: repositoryRoot,
      mode: 'dry-run',
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      makeTemporaryDirectory: async () => temporaryDirectory,
      readFile: async () => {
        throw new Error('raw export read failed');
      },
      remove: async (path) => {
        removed.push(path);
      },
    })).rejects.toThrow(/raw export read failed/i);

    expect(removed).toEqual([temporaryDirectory]);
  });

  it('best-effort cleans an active raw export before re-raising termination signals', async () => {
    const fixture = await readFile(fixturePath, 'utf8');
    const temporaryDirectory = join(tmpdir(), 'psyche-beads-project-sync-signal');
    const handlers = new Map<NodeJS.Signals, () => void>();
    const kills: Array<{pid: number; signal: NodeJS.Signals}> = [];
    const removed: string[] = [];
    let resolveSignalRegistration!: () => void;
    const signalRegistered = new Promise<void>((resolve) => {
      resolveSignalRegistration = resolve;
    });
    let resolveExport!: (result: {
      stdout: string;
      stderr: string;
      exitCode: number;
    }) => void;
    const exportResult = new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      resolveExport = resolve;
    });
    const signalProcess: SignalProcess = {
      pid: 4242,
      on(signal, listener) {
        handlers.set(signal, listener);
        if (signal === 'SIGTERM') {
          resolveSignalRegistration();
        }
      },
      off(signal, listener) {
        if (handlers.get(signal) === listener) {
          handlers.delete(signal);
        }
      },
      kill(pid, signal) {
        kills.push({ pid, signal });
      },
    };

    const loading = loadBeadsSource({
      cwd: repositoryRoot,
      mode: 'dry-run',
      run: async () => exportResult,
      makeTemporaryDirectory: async () => temporaryDirectory,
      readFile: async () => fixture,
      remove: async (path) => {
        removed.push(path);
      },
      signalProcess,
    });

    await signalRegistered;
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => {
      expect(removed).toEqual([temporaryDirectory]);
      expect(kills).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    });
    resolveExport({ stdout: '', stderr: '', exitCode: 0 });
    await expect(loading).resolves.toBe(fixture);
    expect(removed).toEqual([temporaryDirectory]);
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
      operationCounts: {
        createIssue: 4,
        updateIssue: 0,
        closeIssue: 0,
      },
      closureCandidates: [],
      projectUrl: null,
    });
    expect(JSON.parse(result.stdout).plannedOperationCount).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout).warnings).toContain(
      'BEADS_PROJECT_TOKEN is not set; remote state was not read and this is a first-run plan.',
    );
  });

  it('dry-runs raw source with exactly one readonly bd export and cleans its OS temp directory', async () => {
    const fixture = await readFile(fixturePath, 'utf8');
    const calls: Array<{command: string; args: readonly string[]}> = [];
    let outputPath = '';
    const run: ExecFileRun = async (command, args) => {
      calls.push({ command, args: [...args] });
      const outputIndex = args.indexOf('-o');
      outputPath = args[outputIndex + 1] ?? '';
      await writeFile(outputPath, fixture, 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const result = await runCli(['--dry-run'], { run });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{
      command: 'bd',
      args: ['--readonly', 'export', '-o', outputPath],
    }]);
    expect(relative(repositoryRoot, outputPath)).toMatch(/^\.\./u);
    await expect(access(dirname(outputPath))).rejects.toThrow();
  });

  it('keeps raw exports outside the repository when TMPDIR points inside it', async () => {
    const fixture = await readFile(fixturePath, 'utf8');
    const hostileTemporaryRoot = await mkdtemp(join(repositoryRoot, '.hostile-tmp-'));
    let outputPath = '';
    vi.stubEnv('TMPDIR', hostileTemporaryRoot);

    try {
      const result = await runCli(['--dry-run'], {
        run: async (_command, args) => {
          const outputIndex = args.indexOf('-o');
          outputPath = args[outputIndex + 1] ?? '';
          await writeFile(outputPath, fixture, 'utf8');
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });

      expect(result.exitCode).toBe(0);
      expect(relative(repositoryRoot, outputPath)).toMatch(/^\.\./u);
      expect(relative(hostileTemporaryRoot, outputPath)).toMatch(/^\.\./u);
      await expect(access(dirname(outputPath))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(hostileTemporaryRoot, { recursive: true, force: true });
    }
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
    expect(fakeGh.clientOptions).toEqual([
      expect.objectContaining({
        projectMarker: 'psyche-beads-project-sync:v1',
        issueMarker: 'psyche-bead-sync:v1',
        legacyProjectMarkers: ['psyche-bead-sync:v1'],
        legacyIssueMarkers: ['psyche-bead-sync:v1'],
      }),
    ]);
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
    expect(absentProject.provisionReadmes[0]).toContain(
      '<!-- psyche-beads-project-sync:v1 project-readme -->',
    );
    expect(absentProject.provisionReadmes[0]).not.toContain(
      '<!-- psyche-bead-sync:v1 project-readme -->',
    );
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
    expect(fakeGh.writes).not.toContain('updateReadme');
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

  it('reports structured sanitized partial progress when reconciliation apply fails', async () => {
    const leakedRecord = {
      token,
      body: 'private full issue record',
      title: 'do not print this record',
    };
    const fakeGh = createFakeGh({
      failSetFields: new Error(`setFields exploded ${token} ${JSON.stringify(leakedRecord)}`),
    });
    const result = await runCli(
      ['--apply', '--inventory-file', fixturePath],
      {
        env: { BEADS_PROJECT_TOKEN: token },
        fakeGh,
      },
    );

    const summary = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(summary).toMatchObject({
      mode: 'apply',
      plannedOperationCount: expect.any(Number),
      appliedOperationCount: expect.any(Number),
      projectUrl: 'https://github.com/orgs/OpenCoven/projects/12',
      failure: {
        failingOperation: {
          type: 'setFields',
          phase: 'setFields',
          beadId: expect.any(String),
          itemId: expect.any(String),
        },
        cause: expect.stringContaining('<redacted>'),
        resolvedIssueNumbersByBeadId: expect.any(Object),
        resolvedProjectItemIdsByBeadId: expect.any(Object),
      },
    });
    expect(summary.appliedOperationCount).toBeGreaterThan(0);
    expect(summary.appliedOperationCount).toBeLessThan(summary.plannedOperationCount);
    expect(result.stderr).toMatch(/failed after \d+ of \d+ operations/i);
    expect(result.stderr).toMatch(/failing operation.*setFields/i);
    expect(result.stderr).toMatch(/resolved issue numbers/i);
    expect(result.stderr).toMatch(/resolved project item IDs/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);
    expect(`${result.stdout}${result.stderr}`).not.toContain(leakedRecord.body);
    expect(`${result.stdout}${result.stderr}`).not.toContain(leakedRecord.title);
    expect(summary.failure.failingOperation).not.toHaveProperty('fields');
  });

  it('lets --allow-mass-close override only the configured close threshold', async () => {
    const existingIssues = Array.from({ length: 6 }, (_, index) =>
      ({
        ...managedIssue(`historical-${index + 1}`, index + 1),
        title: `[historical-${index + 1}] Review closure ${index + 1}`
          + (index === 0 ? ` ${token}` : ''),
        body: `<!-- psyche-bead-sync:v1 bead-id=historical-${index + 1} -->\n`
          + `Private body content ${index + 1}`,
      })
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
    expect(JSON.parse(guarded.stdout)).toMatchObject({
      mode: 'dry-run',
      plannedOperationCount: expect.any(Number),
      appliedOperationCount: 0,
      operationCounts: {
        closeIssue: 6,
        setFields: 10,
        archiveItem: 6,
      },
      closureCandidates: Array.from({ length: 6 }, (_, index) => {
        const title = `[historical-${index + 1}] Review closure ${index + 1}`;
        return {
          beadId: `historical-${index + 1}`,
          issueNumber: index + 1,
          issueTitle: index === 0 ? `${title} <redacted>` : title,
        };
      }),
      failure: {
        kind: 'mass-close-safety',
        closeIssueCount: 6,
        maxCloseCount: 5,
        cause: expect.stringMatching(/Refusing to close 6 managed issues; limit is 5/),
      },
    });
    expect(guarded.stdout).not.toContain('Private body content');
    expect(guarded.stdout).not.toContain(token);

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
    expect(JSON.parse(overridden.stdout)).toMatchObject({
      operationCounts: {
        closeIssue: 6,
      },
      closureCandidates: Array.from({ length: 6 }, (_, index) => {
        const title = `[historical-${index + 1}] Review closure ${index + 1}`;
        return {
          beadId: `historical-${index + 1}`,
          issueNumber: index + 1,
          issueTitle: index === 0 ? `${title} <redacted>` : title,
        };
      }),
    });
    expect(overridden.stdout).not.toContain('Private body content');
    expect(overridden.stdout).not.toContain(token);
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
