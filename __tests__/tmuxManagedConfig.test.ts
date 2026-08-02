import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  PSYCHE_TMUX_CONFIG_END,
  PSYCHE_TMUX_CONFIG_START,
  buildPsycheManagedTmuxConfigBlock,
  hasPsycheManagedTmuxConfigBlock,
  upsertPsycheManagedTmuxConfigBlock,
  writePsycheManagedTmuxConfig,
} from '../src/utils/tmuxManagedConfig.js';

describe('tmux managed config', () => {
  it('inserts the psyche block without changing user-owned config', () => {
    const existing = 'set -g mouse off\n';
    const block = buildPsycheManagedTmuxConfigBlock('dark');
    const result = upsertPsycheManagedTmuxConfigBlock(existing, block);

    expect(result.action).toBe('inserted');
    expect(result.changed).toBe(true);
    expect(result.content).toContain('set -g mouse off');
    expect(result.content).toContain(PSYCHE_TMUX_CONFIG_START);
    expect(result.content).toContain(PSYCHE_TMUX_CONFIG_END);
  });

  it('replaces only the existing psyche block', () => {
    const oldBlock = [
      PSYCHE_TMUX_CONFIG_START,
      'old psyche setting',
      PSYCHE_TMUX_CONFIG_END,
    ].join('\n');
    const existing = `set -g prefix C-a\n\n${oldBlock}\n\nset -g status off\n`;
    const result = upsertPsycheManagedTmuxConfigBlock(
      existing,
      buildPsycheManagedTmuxConfigBlock('dark')
    );

    expect(result.action).toBe('updated');
    expect(result.content).toContain('set -g prefix C-a');
    expect(result.content).toContain('set -g status off');
    expect(result.content).not.toContain('old psyche setting');
  });

  it('writes a timestamped backup before modifying an existing config', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psyche-managed-config-'));

    try {
      await fs.writeFile(path.join(homeDir, '.tmux.conf'), 'set -g mouse off\n', 'utf-8');
      const result = await writePsycheManagedTmuxConfig(
        homeDir,
        'dark',
        new Date('2026-04-24T12:34:56.000Z')
      );

      expect(result.action).toBe('inserted');
      expect(result.backupPath).toContain('.tmux.conf.psyche-backup-2026-04-24T12-34-56-000Z');
      expect(result.backupPath).toBeDefined();
      expect(await fs.readFile(result.backupPath!, 'utf-8')).toBe('set -g mouse off\n');
      expect(hasPsycheManagedTmuxConfigBlock(await fs.readFile(result.configPath, 'utf-8'))).toBe(true);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
