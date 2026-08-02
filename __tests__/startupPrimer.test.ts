import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  hasCompletedStartupPrimer,
  writeStartupPrimerState,
} from '../src/utils/startupPrimer.js';

describe('startup primer state', () => {
  it('persists dismissal without clobbering other onboarding state', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psyche-startup-primer-'));
    const statePath = path.join(homeDir, '.psyche', 'onboarding.json');

    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({
          tmuxConfigOnboarding: {
            completed: true,
            completedAt: '2026-04-24T00:00:00.000Z',
            outcome: 'existing-config',
          },
        }),
        'utf-8'
      );

      expect(await hasCompletedStartupPrimer(homeDir)).toBe(false);
      await writeStartupPrimerState('dismissed', homeDir);

      const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));
      expect(state.tmuxConfigOnboarding).toBeDefined();
      expect(state.startupPrimer).toMatchObject({
        completed: true,
        outcome: 'dismissed',
      });
      expect(await hasCompletedStartupPrimer(homeDir)).toBe(true);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
