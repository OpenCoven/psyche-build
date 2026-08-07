import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openProjectCovenSession,
  type BridgeSpawnDeps,
  type CovenClient,
} from '../../src/daemon/bridge.js';
import type { CovenSessionSummary } from '../../src/daemon/protocol.js';
import { updatePaneMeta } from '../../src/daemon/index.js';

/**
 * `.psyche/psyche.config.json` *is* the pane registry: it is the only record
 * of which worktree and branch belong to which pane. Losing it loses the map
 * back to the user's in-progress work, so every path that touches it has to be
 * serialized, atomic, and unwilling to guess when the file is unreadable.
 */

let tempRoots: string[] = [];

const CONFIG_REL = path.join('.psyche', 'psyche.config.json');

async function tempProject(config?: unknown): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'psyche-config-')));
  tempRoots.push(root);
  await mkdir(path.join(root, '.psyche'), { recursive: true });
  if (config !== undefined) {
    await writeFile(
      path.join(root, CONFIG_REL),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2),
    );
  }
  return root;
}

async function readConfigText(root: string): Promise<string> {
  return readFile(path.join(root, CONFIG_REL), 'utf8');
}

async function readConfig(root: string): Promise<any> {
  return JSON.parse(await readConfigText(root));
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots = [];
});

function covenSession(root: string, id: string): CovenSessionSummary {
  return {
    id,
    projectRoot: root,
    harness: 'claude',
    title: `session ${id}`,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fakeClient(sessions: CovenSessionSummary[]): CovenClient {
  return {
    listSessions: async () => sessions,
    getSession: async (id) => sessions.find((s) => s.id === id)!,
  };
}

/** Spawn deps that create nothing — the config write is what is under test. */
function fakeDeps(): BridgeSpawnDeps & { commands: string[]; killed: string[] } {
  let next = 0;
  const commands: string[] = [];
  const killed: string[] = [];
  return {
    commands,
    killed,
    tmuxSessionExists: () => true,
    createTmuxPane: () => `%${++next}`,
    sendTmuxCommand: (_paneId, command) => { commands.push(command); },
    killTmuxPane: (paneId) => { killed.push(paneId); },
  };
}

describe('project config read integrity', () => {
  it('refuses to act on a corrupt config instead of replacing it with an empty one', async () => {
    // Regression: the read helper swallowed every failure and returned
    // `{ panes: [] }`. The mutate path then wrote that back, so one unparseable
    // config silently erased every pane, worktree path and branch name.
    const root = await tempProject('{ this is not json');
    const before = await readConfigText(root);

    await expect(
      openProjectCovenSession(root, 'psyche-test', 's1', fakeClient([covenSession(root, 's1')]), fakeDeps()),
    ).rejects.toThrow(/not valid JSON/);

    expect(await readConfigText(root)).toBe(before);
  });

  it('refuses a config that parses but is not an object', async () => {
    const root = await tempProject('[]');
    const before = await readConfigText(root);

    await expect(
      openProjectCovenSession(root, 'psyche-test', 's1', fakeClient([covenSession(root, 's1')]), fakeDeps()),
    ).rejects.toThrow(/not a JSON object/);

    expect(await readConfigText(root)).toBe(before);
  });

  it('leaves a corrupt config alone when patching pane metadata', async () => {
    const root = await tempProject('{ broken');
    const before = await readConfigText(root);

    await expect(updatePaneMeta(root, '%3', { title: 'nope' })).rejects.toThrow(/not valid JSON/);

    expect(await readConfigText(root)).toBe(before);
  });

  it('still treats a genuinely absent config as an empty project', async () => {
    // ENOENT is the one failure that really does mean "no panes yet".
    const root = await tempProject();

    const result = await openProjectCovenSession(
      root, 'psyche-test', 's1', fakeClient([covenSession(root, 's1')]), fakeDeps(),
    );

    expect(result.pane.id).toBe('%1');
    const config = await readConfig(root);
    expect(config.panes).toHaveLength(1);
  });
});

describe('project config write integrity', () => {
  it('writes atomically and leaves no temp files behind', async () => {
    const root = await tempProject({ panes: [] });

    await openProjectCovenSession(
      root, 'psyche-test', 's1', fakeClient([covenSession(root, 's1')]), fakeDeps(),
    );

    const entries = await readdir(path.join(root, '.psyche'));
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
    await expect(readConfig(root)).resolves.toMatchObject({ panes: [expect.any(Object)] });
  });

  it('does not write at all when the mutation itself fails', async () => {
    const root = await tempProject({ panes: [{ id: 'psyche-1', paneId: '%3', title: 'keep' }] });
    const before = await readConfigText(root);

    await expect(updatePaneMeta(root, '%404', { title: 'x' })).rejects.toThrow(/not found/);

    expect(await readConfigText(root)).toBe(before);
  });
});

describe('Coven pane persistence boundaries', () => {
  it('persists the exact pane record before sending its attach command', async () => {
    const root = await tempProject({ panes: [] });
    const deps = fakeDeps();
    deps.sendTmuxCommand = (paneId, command) => {
      const config = JSON.parse(readFileSync(path.join(root, CONFIG_REL), 'utf8'));
      expect(config.panes).toEqual([
        expect.objectContaining({
          paneId,
          covenSession: expect.objectContaining({ id: 's1' }),
        }),
      ]);
      deps.commands.push(command);
    };

    await openProjectCovenSession(
      root,
      'psyche-test',
      's1',
      fakeClient([covenSession(root, 's1')]),
      deps,
    );

    expect(deps.commands).toEqual(['coven attach s1']);
    expect(deps.killed).toEqual([]);
  });

  it('kills the created pane when durable config persistence fails', async () => {
    const root = await tempProject({ panes: [] });
    const deps = fakeDeps();
    const psycheDir = path.join(root, '.psyche');
    deps.createTmuxPane = () => {
      // The transaction has already acquired its lease at this point. Make
      // the atomic registry write fail, then restore permissions from the
      // in-lease kill callback so lock release can complete.
      chmodSync(psycheDir, 0o500);
      return '%persist-failure';
    };
    deps.killTmuxPane = (paneId) => {
      deps.killed.push(paneId);
      chmodSync(psycheDir, 0o700);
    };

    await expect(openProjectCovenSession(
      root,
      'psyche-test',
      's1',
      fakeClient([covenSession(root, 's1')]),
      deps,
    )).rejects.toThrow();

    expect(deps.killed).toEqual(['%persist-failure']);
    expect(deps.commands).toEqual([]);
    expect(await readConfig(root)).toEqual({ panes: [] });
  });

  it('removes the exact persisted record and kills the pane when attach fails', async () => {
    const root = await tempProject({
      panes: [{ id: 'keep', paneId: '%keep', slug: 'keep' }],
    });
    const deps = fakeDeps();
    deps.sendTmuxCommand = () => {
      throw new Error('coven attach unavailable');
    };

    await expect(openProjectCovenSession(
      root,
      'psyche-test',
      's1',
      fakeClient([covenSession(root, 's1')]),
      deps,
    )).rejects.toThrow(/coven attach unavailable/);

    expect(deps.killed).toEqual(['%1']);
    expect((await readConfig(root)).panes).toEqual([
      expect.objectContaining({ id: 'keep', paneId: '%keep' }),
    ]);
  });
});

describe('project config concurrent mutation', () => {
  it('keeps every pane when coven sessions open concurrently', async () => {
    // Regression: this path did its own read-modify-write outside the mutation
    // lock, so two concurrent opens read the same snapshot and the second write
    // dropped the first pane.
    const root = await tempProject({ panes: [] });
    const sessions = ['s1', 's2', 's3', 's4'].map((id) => covenSession(root, id));
    const client = fakeClient(sessions);
    const deps = fakeDeps();

    await Promise.all(sessions.map((s) =>
      openProjectCovenSession(root, 'psyche-test', s.id, client, deps),
    ));

    const config = await readConfig(root);
    expect(config.panes).toHaveLength(4);
    expect(config.panes.map((p: any) => p.covenSession.id).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('gives concurrently created panes distinct ids and slugs', async () => {
    const root = await tempProject({ panes: [] });
    const sessions = ['aaaa1111', 'aaaa2222'].map((id) => covenSession(root, id));
    const client = fakeClient(sessions);
    const deps = fakeDeps();

    await Promise.all(sessions.map((s) =>
      openProjectCovenSession(root, 'psyche-test', s.id, client, deps),
    ));

    const config = await readConfig(root);
    expect(new Set(config.panes.map((p: any) => p.id)).size).toBe(2);
    expect(new Set(config.panes.map((p: any) => p.slug)).size).toBe(2);
  });

  it('does not lose a metadata patch racing a pane open', async () => {
    const root = await tempProject({ panes: [{ id: 'psyche-0', paneId: '%99', title: 'original' }] });
    const client = fakeClient([covenSession(root, 's1')]);

    await Promise.all([
      openProjectCovenSession(root, 'psyche-test', 's1', client, fakeDeps()),
      updatePaneMeta(root, '%99', { title: 'renamed' }),
    ]);

    const config = await readConfig(root);
    expect(config.panes).toHaveLength(2);
    expect(config.panes.find((p: any) => p.paneId === '%99').title).toBe('renamed');
  });
});
