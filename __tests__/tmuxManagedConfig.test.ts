import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  PSYCHE_TMUX_CONFIG_END,
  PSYCHE_TMUX_CONFIG_START,
  buildPsycheManagedTmuxConfigBlock,
  hasLegacyComuxManagedTmuxConfigBlock,
  hasPsycheManagedTmuxConfigBlock,
  stripLegacyComuxManagedTmuxConfigBlock,
  upsertPsycheManagedTmuxConfigBlock,
  writePsycheManagedTmuxConfig,
} from '../src/utils/tmuxManagedConfig.js';

const LEGACY_BLOCK = [
  '# >>> comux',
  '# Managed by comux. Edit outside this block; comux may replace this block.',
  'bind-key -n M-n run-shell "comux new"',
  '# <<< comux',
].join('\n');

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

  describe('legacy comux block eviction', () => {
    it('detects a pre-rename comux block', () => {
      expect(hasLegacyComuxManagedTmuxConfigBlock(LEGACY_BLOCK)).toBe(true);
      expect(hasLegacyComuxManagedTmuxConfigBlock('set -g mouse on')).toBe(false);
    });

    it('strips the legacy block while preserving surrounding user config', () => {
      const existing = `set -g mouse on\n\n${LEGACY_BLOCK}\n\nset -g history-limit 50000\n`;
      const stripped = stripLegacyComuxManagedTmuxConfigBlock(existing);

      expect(stripped).toContain('set -g mouse on');
      expect(stripped).toContain('set -g history-limit 50000');
      expect(stripped).not.toMatch(/comux/i);
    });

    it('removes the legacy block when installing the psyche block', () => {
      const block = buildPsycheManagedTmuxConfigBlock('dark');
      const result = upsertPsycheManagedTmuxConfigBlock(`${LEGACY_BLOCK}\n`, block);

      expect(result.content).not.toMatch(/comux/i);
      expect(hasPsycheManagedTmuxConfigBlock(result.content)).toBe(true);
      expect(result.changed).toBe(true);
    });

    // Regression: `changed` must be computed against the original content. If
    // it were computed against the stripped copy, a file whose only defect was
    // a leftover comux block would report unchanged, never be written, and
    // keep the dead block through every `doctor --fix`.
    it('reports changed when the psyche block is already current but a legacy block lingers', () => {
      const block = buildPsycheManagedTmuxConfigBlock('dark');
      const current = upsertPsycheManagedTmuxConfigBlock('', block);
      expect(upsertPsycheManagedTmuxConfigBlock(current.content, block).changed).toBe(false);

      const polluted = `${LEGACY_BLOCK}\n\n${current.content}`;
      const result = upsertPsycheManagedTmuxConfigBlock(polluted, block);

      expect(result.changed).toBe(true);
      expect(result.content).not.toMatch(/comux/i);
    });

    it('leaves a config with no legacy block untouched', () => {
      const existing = 'set -g mouse on\n';
      expect(stripLegacyComuxManagedTmuxConfigBlock(existing)).toBe(existing);
    });
  });

});
