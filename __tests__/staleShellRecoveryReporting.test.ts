import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oldGeneration = {
  pid: 111,
  processStartIdentity: 'old-start',
  socketPath: '/tmp/old-tmux.sock',
  sessionId: '$999',
};
const currentGeneration = {
  pid: 222,
  processStartIdentity: 'current-start',
  socketPath: '/tmp/current-tmux.sock',
  sessionId: '$1',
};

const tmuxServiceMock = vi.hoisted(() => ({
  getAllPaneInfo: vi.fn(),
  getAllPaneIds: vi.fn(),
}));
const showToastMock = vi.hoisted(() => vi.fn());
const currentTmuxServerIdentityMock = vi.hoisted(() => vi.fn());
const projectConfigFailure = vi.hoisted(() => ({
  remove: false,
  normalize: false,
  read: false,
}));

vi.mock('../src/services/TmuxService.js', () => ({
  TmuxService: {
    getInstance: vi.fn(() => tmuxServiceMock),
  },
}));

vi.mock('../src/services/TmuxServerIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/services/TmuxServerIdentity.js')
  >();
  return {
    ...actual,
    getCurrentTmuxServerIdentity: currentTmuxServerIdentityMock,
  };
});

vi.mock('../src/services/ProjectPaneConfig.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/services/ProjectPaneConfig.js')
  >();
  return {
    ...actual,
    removeProjectPaneConfigPaneIdentities: async (
      ...args: Parameters<typeof actual.removeProjectPaneConfigPaneIdentities>
    ) => {
      if (projectConfigFailure.remove) {
        throw new Error('config disk unavailable');
      }
      return actual.removeProjectPaneConfigPaneIdentities(...args);
    },
    mutateProjectPaneConfig: async (
      ...args: Parameters<typeof actual.mutateProjectPaneConfig>
    ) => {
      if (projectConfigFailure.normalize) {
        throw new Error('sidebar normalization unavailable');
      }
      return actual.mutateProjectPaneConfig(...args);
    },
    readProjectPaneConfig: async (
      ...args: Parameters<typeof actual.readProjectPaneConfig>
    ) => {
      if (projectConfigFailure.read) {
        throw new actual.ProjectPaneConfigError(
          'config_unreadable',
          'config disk unavailable',
        );
      }
      return actual.readProjectPaneConfig(...args);
    },
  };
});

vi.mock('../src/shared/StateManager.js', () => ({
  StateManager: {
    getInstance: vi.fn(() => ({
      getState: () => ({ projectRoot: '/repo' }),
      showToast: showToastMock,
    })),
  },
}));

const roots: string[] = [];

function createStaleShellConfig(): string {
  const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-stale-report-'));
  roots.push(projectRoot);
  const configDir = join(projectRoot, '.psyche');
  mkdirSync(configDir, { recursive: true });
  const panesFile = join(configDir, 'psyche.config.json');
  writeFileSync(panesFile, JSON.stringify({
    projectName: 'project',
    projectRoot,
    panes: [{
      id: 'shell-1',
      slug: 'shell',
      prompt: '',
      paneId: '%0',
      tmuxServerIdentity: oldGeneration,
      type: 'shell',
    }],
    settings: {},
  }));
  return panesFile;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('startup stale shell recovery reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmuxServiceMock.getAllPaneInfo.mockResolvedValue([
      {
        paneId: '%0',
        title: 'control',
        left: 0,
        top: 0,
        width: 80,
        height: 24,
      },
    ]);
    tmuxServiceMock.getAllPaneIds.mockResolvedValue(['%0']);
    currentTmuxServerIdentityMock.mockReturnValue(currentGeneration);
    projectConfigFailure.remove = false;
    projectConfigFailure.normalize = false;
    projectConfigFailure.read = false;
  });

  it('returns an explicit recovery notice when a stale tmux generation is removed', async () => {
    const panesFile = createStaleShellConfig();

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const result = await loadAndProcessPanes(panesFile, true);

    expect(result.panes).toEqual([]);
    expect(JSON.parse(readFileSync(panesFile, 'utf8')).panes).toEqual([]);
    const expectedNotice = {
      code: 'stale_shell_pane_removed',
      severity: 'warning',
      paneRecordIds: ['shell-1'],
      message: expect.stringMatching(/stale tmux identity.*shell.*reopen/i),
    };
    expect(result.recoveryNotices).toEqual([expectedNotice]);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringMatching(/stale tmux identity.*shell.*reopen/i),
      'warning',
    );
  });

  it('reports recovery required when stale identity cleanup cannot persist', async () => {
    projectConfigFailure.remove = true;
    const panesFile = createStaleShellConfig();

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const result = await loadAndProcessPanes(panesFile, true);

    expect(result.panes).toEqual([]);
    expect(result.recoveryNotices).toEqual([{
      code: 'stale_shell_pane_recovery_required',
      severity: 'error',
      paneRecordIds: ['shell-1'],
      message: expect.stringMatching(/stale tmux identity.*could not be saved.*recovery is required/i),
    }]);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringMatching(/stale tmux identity.*could not be saved.*recovery is required/i),
      'error',
    );
  });

  it('does not claim recovery is required when only sidebar normalization fails', async () => {
    projectConfigFailure.normalize = true;
    const panesFile = createStaleShellConfig();

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const result = await loadAndProcessPanes(panesFile, true);

    expect(JSON.parse(readFileSync(panesFile, 'utf8')).panes).toEqual([]);
    expect(result.recoveryNotices).toEqual([expect.objectContaining({
      code: 'stale_shell_pane_removed',
      severity: 'warning',
    })]);
    expect(result.recoveryNotices).not.toEqual([
      expect.objectContaining({ code: 'stale_shell_pane_recovery_required' }),
    ]);
  });

  it('reports a corrupt pane config without replacing its bytes', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-corrupt-report-'));
    roots.push(projectRoot);
    const configDir = join(projectRoot, '.psyche');
    mkdirSync(configDir, { recursive: true });
    const panesFile = join(configDir, 'psyche.config.json');
    const corruptBytes = '{"panes": [';
    writeFileSync(panesFile, corruptBytes);

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const result = await loadAndProcessPanes(panesFile, true);

    expect(result.panes).toEqual([]);
    expect(readFileSync(panesFile, 'utf8')).toBe(corruptBytes);
    expect(result.recoveryNotices).toEqual([{
      code: 'project_config_corrupt',
      severity: 'error',
      paneRecordIds: [],
      message: expect.stringMatching(/pane config is corrupt.*preserved.*recovery is required/i),
    }]);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.stringMatching(/pane config is corrupt.*preserved.*recovery is required/i),
      'error',
    );
  });

  it('classifies structurally invalid JSON as corrupt', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-invalid-report-'));
    roots.push(projectRoot);
    const configDir = join(projectRoot, '.psyche');
    mkdirSync(configDir, { recursive: true });
    const panesFile = join(configDir, 'psyche.config.json');
    const corruptBytes = '{"panes":{}}';
    writeFileSync(panesFile, corruptBytes);

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const result = await loadAndProcessPanes(panesFile, true);

    expect(readFileSync(panesFile, 'utf8')).toBe(corruptBytes);
    expect(result.recoveryNotices).toEqual([
      expect.objectContaining({ code: 'project_config_corrupt' }),
    ]);
  });

  it.each([
    ['legacy array member', '[null]'],
    ['object pane member', '{"panes":[null]}'],
  ])('classifies an invalid %s as corrupt', async (_label, corruptBytes) => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-entry-report-'));
    roots.push(projectRoot);
    const configDir = join(projectRoot, '.psyche');
    mkdirSync(configDir, { recursive: true });
    const panesFile = join(configDir, 'psyche.config.json');
    writeFileSync(panesFile, corruptBytes);

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const result = await loadAndProcessPanes(panesFile, true);

    expect(readFileSync(panesFile, 'utf8')).toBe(corruptBytes);
    expect(result.recoveryNotices).toEqual([
      expect.objectContaining({ code: 'project_config_corrupt' }),
    ]);
  });

  it('reports a persistent config failure once and reports it again after recovery', async () => {
    const projectRoot = mkdtempSync(join(process.cwd(), '.psyche-repeat-report-'));
    roots.push(projectRoot);
    const configDir = join(projectRoot, '.psyche');
    mkdirSync(configDir, { recursive: true });
    const panesFile = join(configDir, 'psyche.config.json');
    writeFileSync(panesFile, '{"panes": [');

    const { loadAndProcessPanes } = await import('../src/hooks/usePaneLoading.js');
    const first = await loadAndProcessPanes(panesFile, true);
    const repeated = await loadAndProcessPanes(panesFile, false);

    expect(first.recoveryNotices).toHaveLength(1);
    expect(repeated.recoveryNotices).toEqual([]);
    expect(showToastMock).toHaveBeenCalledTimes(1);

    writeFileSync(panesFile, JSON.stringify({
      projectName: 'project',
      projectRoot,
      panes: [],
      settings: {},
    }));
    projectConfigFailure.read = true;
    const unreadable = await loadAndProcessPanes(panesFile, false);

    expect(unreadable.recoveryNotices).toEqual([
      expect.objectContaining({ code: 'project_config_unreadable' }),
    ]);
    expect(showToastMock).toHaveBeenCalledTimes(2);

    projectConfigFailure.read = false;
    writeFileSync(panesFile, '{"panes": [');
    const alternating = await loadAndProcessPanes(panesFile, false);

    expect(alternating.recoveryNotices).toEqual([]);
    expect(showToastMock).toHaveBeenCalledTimes(2);

    writeFileSync(panesFile, JSON.stringify({
      projectName: 'project',
      projectRoot,
      panes: [],
      settings: {},
    }));
    await loadAndProcessPanes(panesFile, false);

    writeFileSync(panesFile, '{"panes": [');
    const recurred = await loadAndProcessPanes(panesFile, false);

    expect(recurred.recoveryNotices).toHaveLength(1);
    expect(showToastMock).toHaveBeenCalledTimes(3);
  });
});
