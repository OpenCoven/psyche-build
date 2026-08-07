import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { canonicalizePathWithExistingAncestor } from './WorktreePath.js';

export type LiveTmuxWorktreeGuardState = 'safe' | 'in_use' | 'unknown';

export interface LiveTmuxWorktreeGuardResult {
  state: LiveTmuxWorktreeGuardState;
  consumers?: Array<{
    paneId: string;
    windowId: string;
    cwd: string;
  }>;
  error?: string;
}

/**
 * `list-panes -a` includes panes in detached windows and other sessions.
 * Those panes are intentionally not filtered to Psyche-owned records: an
 * untracked shell can still have its cwd inside a worktree we might delete.
 */
export function inspectLiveTmuxWorktreeConsumers(
  targetWorktreePath: string,
): LiveTmuxWorktreeGuardResult {
  const target = canonicalizePathWithExistingAncestor(targetWorktreePath);
  let output: string;
  try {
    const result: unknown = execFileSync(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_id}\t#{window_id}\t#{pane_current_path}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      },
    );
    output = typeof result === 'string' ? result : String(result);
  } catch (error) {
    return {
      state: 'unknown',
      error: `could not query live tmux pane paths: ${errorMessage(error)}`,
    };
  }

  const consumers: Array<{ paneId: string; windowId: string; cwd: string }> = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const [paneId, windowId, cwd, ...extra] = line.split('\t');
    if (!paneId || !windowId || !cwd || extra.length > 0) {
      return {
        state: 'unknown',
        error: 'tmux returned an incomplete pane_current_path record',
      };
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = canonicalizePathWithExistingAncestor(cwd);
    } catch (error) {
      return {
        state: 'unknown',
        error: `could not canonicalize tmux cwd ${cwd}: ${errorMessage(error)}`,
      };
    }

    if (isPathInsideOrEqual(target, canonicalCwd)) {
      consumers.push({ paneId, windowId, cwd: canonicalCwd });
    }
  }

  return consumers.length > 0
    ? { state: 'in_use', consumers }
    : { state: 'safe' };
}

export function describeLiveTmuxWorktreeGuard(
  result: LiveTmuxWorktreeGuardResult,
): string {
  if (result.state === 'safe') {
    return 'no live tmux pane is using the worktree';
  }
  if (result.state === 'unknown') {
    return result.error || 'live tmux pane paths could not be verified';
  }
  return `live tmux pane(s) still use the worktree: ${
    result.consumers?.map((consumer) =>
      `${consumer.paneId} in ${consumer.windowId} (${consumer.cwd})`
    ).join(', ')
  }`;
}

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
