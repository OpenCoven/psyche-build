import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { PaneSummary } from './protocol.js';

/**
 * Read psyche's on-disk config for a project root and return a summary list.
 *
 * psyche persists panes in `<projectRoot>/.psyche/psyche.config.json`. For v0,
 * the daemon is scoped to one project root (passed in from the CLI).
 */
export async function listPanes(projectRoot: string): Promise<PaneSummary[]> {
  const configPath = path.join(projectRoot, '.psyche', 'psyche.config.json');

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const config = parsed as { panes?: Array<Record<string, unknown>> };
  if (!config.panes || !Array.isArray(config.panes)) {
    return [];
  }

  // `id` must be the tmux pane identifier (`%3`) because every downstream
  // op (send-keys, capture-pane, resize-pane) keys on it. The psyche-internal
  // id (`psyche-2`) falls back as `title` so the rail has something readable.
  return config.panes.map((p): PaneSummary => {
    const tmuxId = String(p.paneId ?? p.id ?? '');
    const fallbackTitle =
      typeof p.title === 'string' ? p.title :
      typeof p.slug === 'string' ? p.slug :
      typeof p.id === 'string' ? p.id : undefined;
    return {
      id: tmuxId,
      cwd: String(p.worktreePath ?? p.worktreeDir ?? p.cwd ?? projectRoot),
      branch: typeof p.branchName === 'string' ? p.branchName : typeof p.branch === 'string' ? p.branch : undefined,
      agent: typeof p.agent === 'string' ? p.agent : undefined,
      title: fallbackTitle,
      lastActivity: typeof p.lastUpdated === 'string' ? p.lastUpdated : undefined,
    };
  }).filter((p) => p.id);
}

/**
 * One-shot capture of a tmux pane's current visible buffer + scrollback.
 *
 * Returns ANSI-escaped bytes suitable for piping into xterm.js. Used on
 * attach to seed the client's terminal before the live stream takes over.
 *
 * TODO(step-2): swap the polling attach path for `tmux -C` control mode
 * so we get `%output` events instead of re-capturing on a timer.
 */
export function capturePaneSync(tmuxPaneId: string): Buffer {
  try {
    return execSync(
      `tmux capture-pane -p -e -J -S - -t ${shellQuote(tmuxPaneId)}`,
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return Buffer.alloc(0);
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
