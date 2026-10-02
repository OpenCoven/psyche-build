import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
});
