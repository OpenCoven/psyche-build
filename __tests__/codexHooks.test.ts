import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installCodexPaneHooks } from '../src/utils/codexHooks.js';

function readStopHooks(worktreePath: string): any[] {
  const hooksPath = path.join(worktreePath, '.codex', 'hooks.json');
  return JSON.parse(fs.readFileSync(hooksPath, 'utf-8')).hooks.Stop;
}

function stopHookCommands(worktreePath: string): string[] {
  return readStopHooks(worktreePath).flatMap((group: any) =>
    group.hooks.map((handler: any) => handler.command as string),
  );
}

describe('installCodexPaneHooks', () => {
  let worktreePath: string;

  beforeEach(() => {
    worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-codex-hooks-'));
  });

  afterEach(() => {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  });

  it('writes the stop hook under .codex/psyche and never .codex/comux', () => {
    const result = installCodexPaneHooks({
      worktreePath,
      psychePaneId: 'psyche-1',
      tmuxPaneId: '%1',
    });

    expect(fs.existsSync(path.join(worktreePath, '.codex', 'psyche'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.codex', 'comux'))).toBe(false);
    expect(result.eventFile).toContain(path.join('.codex', 'psyche'));
    expect(result.eventFile).not.toMatch(/comux/i);

    const scriptPath = path.join(worktreePath, '.codex', 'hooks', 'psyche-stop-hook.cjs');
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.readFileSync(scriptPath, 'utf-8')).not.toMatch(/comux/i);
  });

  it('replaces its own hook on reinstall instead of stacking duplicates', () => {
    installCodexPaneHooks({ worktreePath, psychePaneId: 'psyche-1', tmuxPaneId: '%1' });
    installCodexPaneHooks({ worktreePath, psychePaneId: 'psyche-1', tmuxPaneId: '%1' });

    const managed = stopHookCommands(worktreePath)
      .filter((command) => command.includes('psyche-stop-hook.cjs'));
    expect(managed).toHaveLength(1);
  });

  // Regression: Codex hook configs live in each worktree's .codex/hooks.json,
  // outside this repo, so configs written before the comux -> psyche rename
  // still reference comux-stop-hook.cjs. If the de-dupe predicate only matched
  // the current name, that stale entry would survive forever and Codex would
  // ENOENT on every turn.
  it('evicts a pre-rename comux stop hook left in an existing config', () => {
    const codexDir = path.join(worktreePath, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{
                type: 'command',
                command: 'node "/old/path/.codex/hooks/comux-stop-hook.cjs"',
                timeout: 5,
              }],
            },
          ],
        },
      }),
    );

    installCodexPaneHooks({ worktreePath, psychePaneId: 'psyche-1', tmuxPaneId: '%1' });

    const commands = stopHookCommands(worktreePath);
    expect(commands.some((command) => command.includes('comux-stop-hook.cjs'))).toBe(false);
    expect(commands.filter((command) => command.includes('psyche-stop-hook.cjs'))).toHaveLength(1);
  });

  it('leaves unrelated stop hooks alone', () => {
    const codexDir = path.join(worktreePath, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node ./my-own-hook.cjs', timeout: 5 }] },
          ],
        },
      }),
    );

    installCodexPaneHooks({ worktreePath, psychePaneId: 'psyche-1', tmuxPaneId: '%1' });

    const commands = stopHookCommands(worktreePath);
    expect(commands).toContain('node ./my-own-hook.cjs');
  });
});
