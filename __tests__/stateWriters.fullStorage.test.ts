import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearStorageFaults, injectStorageFault, temporaryLeftovers } from './helpers/storageFaults.js';

let tmpHome: string;

vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFsPromises(await importOriginal()));
vi.mock('node:fs', async (importOriginal) =>
  (await import('./helpers/storageFaults.js')).faultyFs(await importOriginal()));
vi.mock('../src/services/bridge/paths.js', () => ({
  get bridgeDir() { return path.join(tmpHome, '.psyche', 'bridge'); },
  get tokensPath() { return path.join(tmpHome, '.psyche', 'bridge', 'devices.json'); },
  get certPath() { return path.join(tmpHome, '.psyche', 'bridge', 'cert.pem'); },
  get keyPath() { return path.join(tmpHome, '.psyche', 'bridge', 'key.pem'); },
}));

const { acquireOwnerLock } = await import('../src/control/ownerLock.js');
const { TokenStore } = await import('../src/services/bridge/TokenStore.js');
const { SettingsManager } = await import('../src/utils/settingsManager.js');
const { writeStartupPrimerState } = await import('../src/utils/startupPrimer.js');
const { saveProjectRitual, setProjectDefaultRitualId, getProjectRitualManifestPath, getProjectRitualsDir } =
  await import('../src/utils/rituals.js');

const tempOnly = (filePath: string) => filePath.endsWith('.tmp');

/**
 * Every Psyche-owned state file below is seeded with prior bytes, then written
 * through its production path while the volume "fills" after a few bytes. The
 * write must throw, the prior bytes must survive exactly, and no temporary
 * file may be left behind.
 */
describe('persisted state writers on full storage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'psyche-writers-full-'));
    tmpHome = root;
  });

  afterEach(async () => {
    clearStorageFaults();
    await rm(root, { recursive: true, force: true });
  });

  async function expectPreserved(filePath: string, prior: string): Promise<void> {
    expect(await readFile(filePath, 'utf8')).toBe(prior);
    expect(temporaryLeftovers(await readdir(path.dirname(filePath)))).toEqual([]);
  }

  it('owner epoch: a full disk fails acquisition and never regresses the epoch', async () => {
    const first = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    await first.release();
    const epochPath = path.join(root, '.psyche', 'runtime', 'owner-epoch.json');
    const prior = await readFile(epochPath, 'utf8');

    const fault = injectStorageFault({ code: 'ENOSPC', afterBytes: 3, match: tempOnly });
    await expect(acquireOwnerLock(root, { pid: 202, isProcessAlive: () => false }))
      .rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fault.landed).toBe(1);
    await expectPreserved(epochPath, prior);
  });

  it('owner epoch: a full disk reported at fsync never publishes the unsynced epoch', async () => {
    const first = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    await first.release();
    const epochPath = path.join(root, '.psyche', 'runtime', 'owner-epoch.json');
    const prior = await readFile(epochPath, 'utf8');

    const fault = injectStorageFault({ code: 'ENOSPC', at: 'sync', match: (p) => p.includes('owner-epoch') });
    await expect(acquireOwnerLock(root, { pid: 202, isProcessAlive: () => false }))
      .rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fault.landed).toBe(1);
    await expectPreserved(epochPath, prior);
  });

  it('bridge device tokens: a full disk keeps the paired devices and leaks no token temp file', async () => {
    const store = new TokenStore();
    await store.issue('ios-1', 'iPad');
    const tokensPath = path.join(root, '.psyche', 'bridge', 'devices.json');
    const prior = await readFile(tokensPath, 'utf8');

    const fault = injectStorageFault({ code: 'EDQUOT', afterBytes: 10, match: tempOnly });
    await expect(new TokenStore().issue('ios-2', 'iPhone')).rejects.toMatchObject({ code: 'EDQUOT' });
    expect(fault.landed).toBe(1);
    await expectPreserved(tokensPath, prior);
  });

  it('project settings: a full disk throws and keeps the prior settings file', async () => {
    const settingsPath = path.join(root, '.psyche', 'settings.json');
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const prior = `${JSON.stringify({ baseBranch: 'main' }, null, 2)}`;
    await writeFile(settingsPath, prior, 'utf8');

    const fault = injectStorageFault({ code: 'ENOSPC', afterBytes: 4, match: (p) => p.includes(root) });
    const manager = new SettingsManager(root);
    expect(() => manager.updateSetting('baseBranch', 'develop', 'project'))
      .toThrow(expect.objectContaining({ code: 'ENOSPC' }));
    expect(fault.landed).toBe(1);
    await expectPreserved(settingsPath, prior);
  });

  it('onboarding state: a full disk rejects and keeps the prior onboarding record', async () => {
    const statePath = path.join(root, '.psyche', 'onboarding.json');
    await mkdir(path.dirname(statePath), { recursive: true });
    const prior = JSON.stringify({ tmuxConfigOnboarding: { completed: true } }, null, 2);
    await writeFile(statePath, prior, 'utf8');

    const fault = injectStorageFault({ code: 'ENOSPC', afterBytes: 5, match: tempOnly });
    await expect(writeStartupPrimerState('dismissed', root)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(fault.landed).toBe(1);
    await expectPreserved(statePath, prior);
  });

  it('project rituals: a full disk throws and keeps the prior ritual and manifest', async () => {
    const ritual = {
      version: 1,
      id: 'daily',
      name: 'Daily',
      scope: 'project',
      projects: [{ projectRoot: '.', panes: [{ kind: 'terminal', name: 'Shell', command: 'git status' }] }],
    } as never;
    saveProjectRitual(root, ritual);
    setProjectDefaultRitualId(root, 'daily');
    const ritualPath = path.join(getProjectRitualsDir(root), 'daily.json');
    const manifestPath = getProjectRitualManifestPath(root);
    const priorRitual = await readFile(ritualPath, 'utf8');
    const priorManifest = await readFile(manifestPath, 'utf8');

    const fault = injectStorageFault({ code: 'ENOSPC', afterBytes: 6, match: tempOnly });
    expect(() => saveProjectRitual(root, { ...(ritual as object), name: 'Renamed' } as never))
      .toThrow(expect.objectContaining({ code: 'ENOSPC' }));
    expect(() => setProjectDefaultRitualId(root, undefined))
      .toThrow(expect.objectContaining({ code: 'ENOSPC' }));
    expect(fault.landed).toBe(2);
    await expectPreserved(ritualPath, priorRitual);
    await expectPreserved(manifestPath, priorManifest);
  });

  it('symlinked user config (settings, onboarding, rituals) stays linked and keeps its mode', async () => {
    const dotfiles = path.join(root, 'dotfiles');
    await mkdir(dotfiles, { recursive: true });
    await mkdir(path.join(root, '.psyche'), { recursive: true });

    const realSettings = path.join(dotfiles, 'settings.json');
    await writeFile(realSettings, '{}', 'utf8');
    await chmod(realSettings, 0o600);
    const settingsLink = path.join(root, '.psyche', 'settings.json');
    await symlink(realSettings, settingsLink);
    new SettingsManager(root).updateSetting('baseBranch', 'develop', 'project');
    expect((await lstat(settingsLink)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(realSettings, 'utf8'))).toMatchObject({ baseBranch: 'develop' });
    expect((await stat(realSettings)).mode & 0o777).toBe(0o600);

    const realOnboarding = path.join(dotfiles, 'onboarding.json');
    await writeFile(realOnboarding, '{}', 'utf8');
    const onboardingLink = path.join(root, '.psyche', 'onboarding.json');
    await symlink(realOnboarding, onboardingLink);
    await writeStartupPrimerState('dismissed', root);
    expect((await lstat(onboardingLink)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(realOnboarding, 'utf8'))).toHaveProperty('startupPrimer');

    const ritual = {
      version: 1,
      id: 'daily',
      name: 'Daily',
      scope: 'project',
      projects: [{ projectRoot: '.', panes: [{ kind: 'terminal', name: 'Shell', command: 'git status' }] }],
    } as never;
    const ritualsDir = getProjectRitualsDir(root);
    await mkdir(ritualsDir, { recursive: true });
    const realRitual = path.join(dotfiles, 'daily.json');
    await writeFile(realRitual, '{}', 'utf8');
    const ritualLink = path.join(ritualsDir, 'daily.json');
    await symlink(realRitual, ritualLink);
    saveProjectRitual(root, ritual);
    expect((await lstat(ritualLink)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(realRitual, 'utf8'))).toMatchObject({ id: 'daily' });

    expect(temporaryLeftovers(await readdir(dotfiles))).toEqual([]);
  });

  it('bridge tokens and the owner epoch never follow a planted symlink', async () => {
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, 'untouched', 'utf8');

    const bridgeDir = path.join(root, '.psyche', 'bridge');
    await mkdir(bridgeDir, { recursive: true });
    const tokensLink = path.join(bridgeDir, 'devices.json');
    await symlink(outside, tokensLink);
    await rm(tokensLink);
    await symlink(outside, tokensLink);
    // The store reads through the link it finds, but the write replaces the
    // link with a private regular file rather than writing through it.
    await writeFile(outside, JSON.stringify({ devices: [] }), 'utf8');
    await new TokenStore().issue('ios-1', 'iPad');
    expect((await lstat(tokensLink)).isSymbolicLink()).toBe(false);
    expect((await stat(tokensLink)).mode & 0o777).toBe(0o600);
    expect(await readFile(outside, 'utf8')).toBe(JSON.stringify({ devices: [] }));

    const runtimeDir = path.join(root, '.psyche', 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    const epochLink = path.join(runtimeDir, 'owner-epoch.json');
    await symlink(outside, epochLink);
    const lock = await acquireOwnerLock(root, { pid: 101, isProcessAlive: () => false });
    await lock.release();
    expect((await lstat(epochLink)).isSymbolicLink()).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe(JSON.stringify({ devices: [] }));
  });

  it('a cloned repo cannot aim project settings or rituals at a file outside it', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'psyche-outside-'));
    try {
      const victim = path.join(outsideDir, 'victim.txt');
      await writeFile(victim, 'user data\n', 'utf8');
      const project = path.join(root, 'cloned');
      await mkdir(path.join(project, '.psyche', 'rituals'), { recursive: true });
      await symlink(victim, path.join(project, '.psyche', 'settings.json'));
      await symlink(victim, path.join(project, '.psyche', 'rituals.json'));
      await symlink(victim, path.join(project, '.psyche', 'rituals', 'daily.json'));

      expect(() => new SettingsManager(project).updateSetting('baseBranch', 'develop', 'project'))
        .toThrow(expect.objectContaining({ code: 'ATOMIC_WRITE_OUTSIDE_ROOT' }));
      expect(() => setProjectDefaultRitualId(project, 'daily'))
        .toThrow(expect.objectContaining({ code: 'ATOMIC_WRITE_OUTSIDE_ROOT' }));
      const ritual = {
        version: 1,
        id: 'daily',
        name: 'Daily',
        scope: 'project',
        projects: [{ projectRoot: '.', panes: [{ kind: 'terminal', name: 'Shell', command: 'git status' }] }],
      } as never;
      expect(() => saveProjectRitual(project, ritual))
        .toThrow(expect.objectContaining({ code: 'ATOMIC_WRITE_OUTSIDE_ROOT' }));

      expect(await readFile(victim, 'utf8')).toBe('user data\n');
      expect(temporaryLeftovers(await readdir(outsideDir))).toEqual([]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
