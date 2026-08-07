import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { PsychePane } from '../src/types.js';

const createPaneMock = vi.fn();
vi.mock('../src/utils/paneCreation.js', () => ({
  createPane: (...args: unknown[]) => createPaneMock(...args),
}));
vi.mock('../src/utils/slug.js', () => ({
  generateSlug: vi.fn(async () => 'fix-auth'),
}));

const writeFileMock = vi.fn();
const readFileMock = vi.fn();
const unlinkMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
    unlink: (...args: unknown[]) => unlinkMock(...args),
  },
}));

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const enqueuePrune = vi.fn();
vi.mock('../src/services/WorktreeCleanupService.js', () => ({
  WorktreeCleanupService: {
    getInstance: () => ({ enqueuePruneManagedWorktrees: enqueuePrune }),
  },
}));

const usePaneCreation = (await import('../src/hooks/usePaneCreation.js')).default;

const ROOT = process.cwd();

function pane(id: string): PsychePane {
  return { id, slug: id, prompt: '', paneId: `%${id}`, projectRoot: ROOT } as PsychePane;
}

function harness(existing: PsychePane[] = []) {
  const savePanes = vi.fn(async (_panes: PsychePane[]) => {});
  const loadPanes = vi.fn(async () => {});
  const statuses: string[] = [];
  const api = usePaneCreation({
    panes: existing,
    savePanes,
    projectName: 'repo',
    sessionProjectRoot: ROOT,
    panesFile: `${ROOT}/.psyche/psyche.config.json`,
    setIsCreatingPane: vi.fn(),
    setStatusMessage: (msg: string) => { statuses.push(msg); },
    loadPanes,
    availableAgents: ['coven-code', 'claude', 'codex'],
  });
  return { api, savePanes, loadPanes, statuses };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  writeFileMock.mockResolvedValue(undefined);
  unlinkMock.mockResolvedValue(undefined);
  delete process.env.EDITOR;
  delete process.env.VISUAL;
});

describe('openInEditor', () => {
  it('launches one executable without a shell, then reads and cleans up the prompt file', async () => {
    const child = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    readFileMock.mockResolvedValue('# Enter your Claude prompt here\n\nUpdated prompt');
    const h = harness();
    let prompt = '';

    await h.api.openInEditor('Original prompt', (value) => {
      prompt = value;
    });

    const tmpFile = writeFileMock.mock.calls[0][0];
    expect(spawnMock).toHaveBeenCalledWith('nano', [tmpFile], {
      stdio: 'inherit',
      shell: false,
    });
    expect(prompt).toBe('Updated prompt');
    expect(unlinkMock).toHaveBeenCalledWith(tmpFile);
  });

  it('reports editor launch failures and still attempts prompt-file cleanup', async () => {
    const child = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('editor unavailable')));
      return child;
    });
    const h = harness();

    await h.api.openInEditor('Original prompt', vi.fn());

    expect(h.statuses).toContain('Failed to open prompt editor: editor unavailable');
    expect(unlinkMock).toHaveBeenCalledWith(writeFileMock.mock.calls[0][0]);
  });

  it('reports prompt-file read failures and still attempts cleanup', async () => {
    const child = new EventEmitter();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    readFileMock.mockRejectedValue(new Error('prompt file unavailable'));
    const h = harness();

    await h.api.openInEditor('Original prompt', vi.fn());

    expect(h.statuses).toContain('Failed to open prompt editor: prompt file unavailable');
    expect(unlinkMock).toHaveBeenCalledWith(writeFileMock.mock.calls[0][0]);
  });

  it('rejects hostile editor command strings before launching them', async () => {
    process.env.EDITOR = 'nano --wait; $(touch sentinel)';
    const h = harness();

    await h.api.openInEditor('Original prompt', vi.fn());

    expect(spawnMock).not.toHaveBeenCalled();
    expect(h.statuses.some((status) => status.includes('single executable path'))).toBe(true);
    expect(unlinkMock).toHaveBeenCalledWith(writeFileMock.mock.calls[0][0]);
  });
});

describe('createNewPane', () => {
  it('persists an existing-worktree pane through createPane before returning', async () => {
    const reusedPane = {
      ...pane('reused'),
      worktreePath: `${ROOT}/.psyche/worktrees/reused`,
    };
    createPaneMock.mockImplementation(async (options: any) => {
      await options.persistReusedPane(reusedPane);
      return { pane: reusedPane, needsAgentChoice: false };
    });
    const h = harness();

    const created = await h.api.createNewPane('Resume work', 'claude', {
      existingWorktree: {
        slug: 'reused',
        worktreePath: reusedPane.worktreePath,
        branchName: 'feature/reused',
      },
    });

    expect(created).toBe(reusedPane);
    expect(createPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        existingWorktree: expect.objectContaining({
          worktreePath: reusedPane.worktreePath,
        }),
        persistReusedPane: expect.any(Function),
      }),
      expect.any(Array)
    );
    expect(h.savePanes).toHaveBeenCalledTimes(1);
    expect(h.savePanes).toHaveBeenCalledWith([reusedPane]);
  });

  it('does not persist a reused pane again after its reservation callback saved it', async () => {
    const reusedPane = {
      ...pane('reused'),
      worktreePath: `${ROOT}/.psyche/worktrees/reused`,
    };
    createPaneMock.mockImplementation(async (options: any) => {
      await options.persistReusedPane(reusedPane);
      return { pane: reusedPane, needsAgentChoice: false };
    });
    const h = harness();

    await h.api.createNewPane('Resume work', 'claude', {
      existingWorktree: {
        slug: 'reused',
        worktreePath: reusedPane.worktreePath,
        branchName: 'feature/reused',
      },
    });

    expect(h.savePanes).toHaveBeenCalledTimes(1);
  });
});

describe('createPanesForAgents', () => {
  it('creates one pane per selected agent', async () => {
    let n = 0;
    createPaneMock.mockImplementation(async () => ({
      pane: pane(`psyche-${++n}`),
      needsAgentChoice: false,
    }));
    const h = harness();

    const created = await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude']);

    expect(created).toHaveLength(2);
    expect(createPaneMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repeated agent selections', async () => {
    createPaneMock.mockImplementation(async () => ({ pane: pane('p'), needsAgentChoice: false }));
    const h = harness();

    await h.api.createPanesForAgents('Fix auth', ['claude', 'claude', 'claude']);

    expect(createPaneMock).toHaveBeenCalledTimes(1);
  });

  it('returns early without touching anything when no agents are selected', async () => {
    const h = harness();
    expect(await h.api.createPanesForAgents('Fix auth', [])).toEqual([]);
    expect(createPaneMock).not.toHaveBeenCalled();
    expect(h.savePanes).not.toHaveBeenCalled();
  });

  // Persisting once at the end is what makes the fan-out atomic from the
  // config's point of view rather than N interleaved writes.
  it('persists all created panes in a single save', async () => {
    let n = 0;
    createPaneMock.mockImplementation(async () => ({
      pane: pane(`psyche-${++n}`),
      needsAgentChoice: false,
    }));
    const h = harness([pane('existing')]);

    await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude', 'codex']);

    expect(h.savePanes).toHaveBeenCalledTimes(1);
    expect(h.savePanes.mock.calls[0][0]).toHaveLength(4);
    expect(h.loadPanes).toHaveBeenCalledTimes(1);
  });

  it('shares one slug stem across sibling lanes', async () => {
    createPaneMock.mockImplementation(async () => ({ pane: pane('p'), needsAgentChoice: false }));
    const h = harness();

    await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude']);

    for (const call of createPaneMock.mock.calls) {
      expect(call[0].slugBase).toBe('fix-auth');
    }
    const suffixes = createPaneMock.mock.calls.map((call) => call[0].slugSuffix);
    expect(new Set(suffixes).size).toBe(2);
  });

  describe('partial failure', () => {
    it('keeps and persists the lanes that succeeded', async () => {
      createPaneMock.mockImplementation(async (options: any) => {
        if (options.agent === 'claude') throw new Error('claude lane exploded');
        return { pane: pane(`psyche-${options.agent}`), needsAgentChoice: false };
      });
      const h = harness();

      const created = await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude', 'codex']);

      expect(created.map((p) => p.id)).toEqual(['psyche-coven-code', 'psyche-codex']);
      expect(h.savePanes).toHaveBeenCalledTimes(1);
    });

    it('reports how many lanes failed', async () => {
      createPaneMock.mockImplementation(async (options: any) => {
        if (options.agent === 'claude') throw new Error('nope');
        return { pane: pane('p'), needsAgentChoice: false };
      });
      const h = harness();

      await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude']);

      expect(h.statuses).toContain('Created 1/2 panes (1 failed)');
    });

    it('does not persist when every lane fails', async () => {
      createPaneMock.mockImplementation(async () => { throw new Error('all broken'); });
      const h = harness();

      const created = await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude']);

      expect(created).toEqual([]);
      expect(h.savePanes).not.toHaveBeenCalled();
      expect(h.statuses).toContain('Created 0/2 panes (2 failed)');
    });
  });

  it('reports plain success when every lane completes', async () => {
    createPaneMock.mockImplementation(async () => ({ pane: pane('p'), needsAgentChoice: false }));
    const h = harness();

    await h.api.createPanesForAgents('Fix auth', ['coven-code', 'claude']);

    expect(h.statuses).toContain('Created 2 panes');
  });
});
