import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  buildOpenRouterExportLine,
  getShellConfigCandidates,
  hasCompletedOpenRouterOnboarding,
  persistOpenRouterApiKeyToShell,
  readOnboardingState,
  upsertOpenRouterKeyBlock,
  writeOpenRouterOnboardingState,
} from '../src/utils/openRouterApiKeySetup.js';

describe('openRouterApiKeySetup', () => {
  it('returns shell config candidates for zsh', () => {
    const homeDir = '/tmp/example-home';
    const candidates = getShellConfigCandidates('/bin/zsh', homeDir);

    expect(candidates).toEqual([
      path.join(homeDir, '.zshrc'),
      path.join(homeDir, '.zprofile'),
    ]);
  });

  it('upserts managed block into empty content', () => {
    const exportLine = buildOpenRouterExportLine('sk-test-123', '/bin/zsh');
    const updated = upsertOpenRouterKeyBlock('', exportLine);

    expect(updated).toContain('# >>> psyche openrouter >>>');
    expect(updated).toContain("export OPENROUTER_API_KEY='sk-test-123'");
    expect(updated).toContain('# <<< psyche openrouter <<<');
  });

  it('replaces existing managed block', () => {
    const initial = [
      '# >>> psyche openrouter >>>',
      "export OPENROUTER_API_KEY='old-key'",
      '# <<< psyche openrouter <<<',
      '',
    ].join('\n');

    const nextLine = buildOpenRouterExportLine('new-key', '/bin/zsh');
    const updated = upsertOpenRouterKeyBlock(initial, nextLine);

    expect(updated).not.toContain('old-key');
    expect(updated).toContain("export OPENROUTER_API_KEY='new-key'");
  });

  it('persists key to shell config file', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-openrouter-'));

    try {
      const zshrcPath = path.join(homeDir, '.zshrc');
      writeFileSync(zshrcPath, '# existing config\n', 'utf-8');

      const result = await persistOpenRouterApiKeyToShell('sk-live-abc', {
        shellPath: '/bin/zsh',
        homeDir,
      });

      const content = readFileSync(result.shellConfigPath, 'utf-8');
      expect(result.shellConfigPath).toBe(zshrcPath);
      expect(content).toContain("export OPENROUTER_API_KEY='sk-live-abc'");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writes openrouter onboarding state without clobbering existing keys', async () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'psyche-openrouter-state-'));

    try {
      const onboardingDir = path.join(homeDir, '.psyche');
      mkdirSync(onboardingDir, { recursive: true });
      writeFileSync(
        path.join(onboardingDir, 'onboarding.json'),
        JSON.stringify(
          {
            tmuxConfigOnboarding: {
              completed: true,
              completedAt: '2025-01-01T00:00:00.000Z',
              outcome: 'skip',
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      await writeOpenRouterOnboardingState(homeDir, 'configured', path.join(homeDir, '.zshrc'));

      const state = await readOnboardingState(homeDir);
      expect(state.tmuxConfigOnboarding).toBeDefined();
      expect(state.openRouterApiKeyOnboarding).toBeDefined();
      expect(await hasCompletedOpenRouterOnboarding(homeDir)).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
