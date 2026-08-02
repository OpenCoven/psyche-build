import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildRecommendedTmuxConfig,
  getTmuxConfigCandidatePaths,
  hasMeaningfulTmuxConfig,
  runTmuxConfigOnboardingIfNeeded,
} from '../src/utils/tmuxConfigOnboarding.js';

describe('tmux config onboarding utils', () => {
  it('returns expected tmux config candidate paths', () => {
    const home = '/tmp/example-home';
    const paths = getTmuxConfigCandidatePaths(home);

    expect(paths).toEqual([
      path.join(home, '.tmux.conf'),
      path.join(home, '.config', 'tmux', 'tmux.conf'),
    ]);
  });

  it('detects missing tmux config', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));

    try {
      const result = await hasMeaningfulTmuxConfig(homeDir);
      expect(result).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('detects existing tmux config from ~/.tmux.conf', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));

    try {
      writeFileSync(path.join(homeDir, '.tmux.conf'), "set -g mouse on\n", 'utf-8');
      const result = await hasMeaningfulTmuxConfig(homeDir);
      expect(result).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('treats empty tmux config as not configured', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));

    try {
      writeFileSync(path.join(homeDir, '.tmux.conf'), '', 'utf-8');
      const result = await hasMeaningfulTmuxConfig(homeDir);
      expect(result).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('detects existing tmux config from ~/.config/tmux/tmux.conf', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));

    try {
      const configDir = path.join(homeDir, '.config', 'tmux');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(path.join(configDir, 'tmux.conf'), "set -g mouse on\n", 'utf-8');

      const result = await hasMeaningfulTmuxConfig(homeDir);
      expect(result).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('builds dark and light presets with theme-specific colors', () => {
    const dark = buildRecommendedTmuxConfig('dark');
    const light = buildRecommendedTmuxConfig('light');

    expect(dark).toContain("set -g window-style 'fg=default,bg=default'");
    expect(light).toContain("set -g window-style 'fg=default,bg=default'");
    expect(dark).toContain("set -g window-active-style 'fg=default,bg=default'");
    expect(light).toContain("set -g window-active-style 'fg=default,bg=default'");

    expect(dark).toContain('set -g pane-border-status top');
    expect(light).toContain('set -g pane-border-status top');
  });

  it('writes managed config and onboarding state when setup is accepted', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));
    const sourcedPaths: string[] = [];

    try {
      await runTmuxConfigOnboardingIfNeeded({
        homeDir,
        isInteractive: true,
        now: new Date('2026-04-24T12:00:00.000Z'),
        promptForSetup: async () => 'install-dark',
        sourceConfig: (configPath) => {
          sourcedPaths.push(configPath);
        },
      });

      const configPath = path.join(homeDir, '.tmux.conf');
      const statePath = path.join(homeDir, '.psyche', 'onboarding.json');
      const config = readFileSync(configPath, 'utf-8');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));

      expect(config).toContain('# >>> psyche');
      expect(config).toContain('# <<< psyche');
      expect(state.tmuxConfigOnboarding).toMatchObject({
        completed: true,
        completedAt: '2026-04-24T12:00:00.000Z',
        outcome: 'install-dark',
        configPath,
        managedBlockVersion: 1,
      });
      expect(sourcedPaths).toEqual([configPath]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('marks onboarding skipped without creating tmux config', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));

    try {
      await runTmuxConfigOnboardingIfNeeded({
        homeDir,
        isInteractive: true,
        now: new Date('2026-04-24T12:00:00.000Z'),
        promptForSetup: async () => 'skip',
        sourceConfig: () => {
          throw new Error('sourceConfig should not run for skip');
        },
      });

      const state = JSON.parse(readFileSync(path.join(homeDir, '.psyche', 'onboarding.json'), 'utf-8'));
      expect(state.tmuxConfigOnboarding).toMatchObject({
        completed: true,
        completedAt: '2026-04-24T12:00:00.000Z',
        outcome: 'skip',
      });
      expect(existsSync(path.join(homeDir, '.tmux.conf'))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves existing tmux config and creates a backup when setup is accepted', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-onboarding-'));
    const configPath = path.join(homeDir, '.tmux.conf');

    try {
      writeFileSync(configPath, 'set -g history-limit 5000\n', 'utf-8');

      await runTmuxConfigOnboardingIfNeeded({
        homeDir,
        isInteractive: true,
        promptForSetup: async (hasExistingConfig) => {
          expect(hasExistingConfig).toBe(true);
          return 'install-dark';
        },
        sourceConfig: () => undefined,
      });

      const config = readFileSync(configPath, 'utf-8');
      const backups = readdirSync(homeDir).filter(name => name.startsWith('.tmux.conf.psyche-backup-'));

      expect(config).toContain('set -g history-limit 5000');
      expect(config).toContain('# >>> psyche');
      expect(backups).toHaveLength(1);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
