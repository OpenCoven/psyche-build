import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findHook, initializeHooksDirectory } from '../src/utils/hooks.js';
import { SPACER_PANE_TITLE } from '../src/constants/layout.js';
import { SERVER_NAME, TOOLS } from '../src/mcp/server.js';
import { PSYCHE_RUNTIME_GITIGNORE_ENTRY } from '../src/utils/gitignore.js';
import {
  PSYCHE_TMUX_CONFIG_END,
  PSYCHE_TMUX_CONFIG_START,
} from '../src/utils/tmuxManagedConfig.js';

/**
 * Literal pins for the runtime names the comux -> psyche rename changed.
 *
 * These exist because a global rename rewrites an assertion and the
 * implementation it checks in the same stroke, so any test that compares a
 * constant to itself keeps passing no matter what the constant holds. Each
 * expectation below states the literal string, and each was verified to FAIL
 * when the corresponding implementation value is mutated.
 *
 * All of these are contracts with something outside this repo — a live tmux
 * server, a user's hook scripts, an MCP client, or a checked-in .gitignore.
 */
describe('renamed runtime contracts', () => {
  describe('hook discovery', () => {
    let projectRoot: string;

    beforeEach(() => {
      projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'psyche-hooks-'));
    });

    afterEach(() => {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    });

    function writeExecutableHook(dir: string, name: string): string {
      fs.mkdirSync(dir, { recursive: true });
      const hookPath = path.join(dir, name);
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(hookPath, 0o755);
      return hookPath;
    }

    it('finds team hooks in .psyche-hooks/', () => {
      const expected = writeExecutableHook(
        path.join(projectRoot, '.psyche-hooks'),
        'worktree_created',
      );
      expect(findHook(projectRoot, 'worktree_created')).toBe(expected);
    });

    it('finds project-local hooks in .psyche/hooks/', () => {
      const expected = writeExecutableHook(
        path.join(projectRoot, '.psyche', 'hooks'),
        'worktree_created',
      );
      expect(findHook(projectRoot, 'worktree_created')).toBe(expected);
    });

    // The silent-failure case this whole rename risks: a hook sitting in the
    // old directory is not found, and nothing reports it.
    it('does not find hooks left in the pre-rename .comux-hooks/', () => {
      writeExecutableHook(path.join(projectRoot, '.comux-hooks'), 'worktree_created');
      expect(findHook(projectRoot, 'worktree_created')).toBeNull();
    });

    it('scaffolds into .psyche-hooks/ and never .comux-hooks/', () => {
      initializeHooksDirectory(projectRoot);
      expect(fs.existsSync(path.join(projectRoot, '.psyche-hooks'))).toBe(true);
      expect(fs.existsSync(path.join(projectRoot, '.comux-hooks'))).toBe(false);
    });
  });

  describe('tmux pane contracts', () => {
    it('pins the spacer pane title', () => {
      expect(SPACER_PANE_TITLE).toBe('psyche-spacer');
    });

    it('pins the managed tmux config markers', () => {
      expect(PSYCHE_TMUX_CONFIG_START).toBe('# >>> psyche');
      expect(PSYCHE_TMUX_CONFIG_END).toBe('# <<< psyche');
    });
  });

  describe('gitignore contract', () => {
    it('pins the runtime ignore entry', () => {
      expect(PSYCHE_RUNTIME_GITIGNORE_ENTRY).toBe('.psyche*');
    });

    // '.psyche-build*' would not match the '.psyche/' directory actually
    // created at runtime, so the ignore rule has to track the command name.
    it('matches the runtime directory it is meant to ignore', () => {
      expect('.psyche/'.startsWith(PSYCHE_RUNTIME_GITIGNORE_ENTRY.replace('*', ''))).toBe(true);
    });
  });

  describe('MCP surface', () => {
    it('pins the advertised server name', () => {
      expect(SERVER_NAME).toBe('psyche');
    });

    it('pins every tool name clients dispatch on', () => {
      expect(TOOLS.map((tool) => tool.name).sort()).toEqual([
        'psyche_create_pane',
        'psyche_execute_task',
        'psyche_get_pane_output',
        'psyche_kill_pane',
        'psyche_list_panes',
        'psyche_list_rituals',
        'psyche_list_worktrees',
      ]);
    });

    it('exposes no tool still carrying the old prefix', () => {
      for (const tool of TOOLS) {
        expect(tool.name).not.toMatch(/comux/i);
        expect(tool.description ?? '').not.toMatch(/comux/i);
      }
    });
  });
});
