import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateWelcomePane,
  mockWelcomePaneExists,
  mockDestroyWelcomePane,
} = vi.hoisted(() => ({
  mockCreateWelcomePane: vi.fn(),
  mockWelcomePaneExists: vi.fn(),
  mockDestroyWelcomePane: vi.fn(),
}));

vi.mock('../src/utils/welcomePane.js', () => ({
  createWelcomePane: mockCreateWelcomePane,
  welcomePaneExists: mockWelcomePaneExists,
  destroyWelcomePane: mockDestroyWelcomePane,
}));

vi.mock('../src/services/LogService.js', () => ({
  LogService: {
    getInstance: () => ({
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import {
  createWelcomePaneCoordinated,
  syncWelcomePaneVisibility,
} from '../src/utils/welcomePaneManager.js';
import { SIDEBAR_WIDTH } from '../src/utils/tmux.js';

describe('welcomePaneManager', () => {
  let tempProjectRoot = '';
  let configPath = '';
  let nowTick = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000 + (nowTick++ * 1_000));

    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-welcome-pane-'));
    const psycheDir = path.join(tempProjectRoot, '.psyche');
    fs.mkdirSync(psycheDir, { recursive: true });
    configPath = path.join(psycheDir, 'psyche.config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'test-project',
      projectRoot: tempProjectRoot,
      panes: [],
      settings: {},
      lastUpdated: new Date().toISOString(),
      controlPaneId: '%1',
    }, null, 2));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempProjectRoot && fs.existsSync(tempProjectRoot)) {
      fs.rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  it('creates welcome pane using project root as cwd', async () => {
    mockWelcomePaneExists.mockResolvedValue(false);
    mockCreateWelcomePane.mockResolvedValue('%77');

    const created = await createWelcomePaneCoordinated(tempProjectRoot, '%1');

    expect(created).toBe(true);
    expect(mockCreateWelcomePane).toHaveBeenCalledWith('%1', tempProjectRoot, undefined, SIDEBAR_WIDTH);

    const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(updatedConfig.welcomePaneId).toBe('%77');
  });

  it('creates welcome pane with the active project theme when all panes are hidden', async () => {
    mockWelcomePaneExists.mockResolvedValue(false);
    mockCreateWelcomePane.mockResolvedValue('%88');

    const synced = await syncWelcomePaneVisibility(
      tempProjectRoot,
      '%1',
      true,
      'purple'
    );

    expect(synced).toBe(true);
    expect(mockCreateWelcomePane).toHaveBeenCalledWith('%1', tempProjectRoot, 'purple', SIDEBAR_WIDTH);

    const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(updatedConfig.welcomePaneId).toBe('%88');
  });

  it('destroys the welcome pane when psyche panes become visible again', async () => {
    mockWelcomePaneExists.mockResolvedValue(true);

    fs.writeFileSync(configPath, JSON.stringify({
      projectName: 'test-project',
      projectRoot: tempProjectRoot,
      panes: [],
      settings: {},
      lastUpdated: new Date().toISOString(),
      controlPaneId: '%1',
      welcomePaneId: '%99',
    }, null, 2));

    const synced = await syncWelcomePaneVisibility(
      tempProjectRoot,
      '%1',
      false,
      'purple'
    );

    expect(synced).toBe(true);
    expect(mockDestroyWelcomePane).toHaveBeenCalledWith('%99');

    const updatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(updatedConfig.welcomePaneId).toBeUndefined();
  });
});
