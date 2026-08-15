import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import type { PaneSummary } from './protocol.js';
import { assertTmuxPaneId } from '../utils/tmuxTarget.js';
<<<<<<< HEAD
import {
  getCurrentTmuxServerIdentity,
  isTmuxServerIdentity,
  sameTmuxServerIdentity,
  type TmuxServerIdentity,
} from '../services/TmuxServerIdentity.js';
=======
>>>>>>> origin/main

/**
 * Read psyche's on-disk config for a project root and return a summary list.
 *
 * psyche persists panes in `<projectRoot>/.psyche/psyche.config.json`. For v0,
 * the daemon is scoped to one project root (passed in from the CLI).
 */
export async function listPanes(projectRoot: string): Promise<PaneSummary[]> {
  const panes = await readPaneRecords(projectRoot);
  return panes.map((p): PaneSummary => {
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

export interface PaneSurfaceBinding {
  id: string;
  tmuxPaneId: string;
  worktreeRoot: string;
  title?: string;
  agent?: string;
}

export type PaneLivenessProbe = (tmuxPaneId: string) => boolean | Promise<boolean>;
<<<<<<< HEAD
export type TmuxIdentityProbe = (
  tmuxPaneId: string,
) => TmuxServerIdentity | undefined | Promise<TmuxServerIdentity | undefined>;
=======
>>>>>>> origin/main

export function isTmuxPaneLive(
  tmuxPaneId: string,
  run: typeof execFileSync = execFileSync,
): boolean {
  const target = assertTmuxPaneId(tmuxPaneId);
  try {
    return String(run('tmux', ['display-message', '-p', '-t', target, '#{pane_id}'], {
      encoding: 'utf8',
    })).trim() === target;
  } catch {
    return false;
  }
}

export async function listPaneSurfaceBindings(
  projectRoot: string,
  isPaneLive: PaneLivenessProbe = isTmuxPaneLive,
<<<<<<< HEAD
  getTmuxIdentity: TmuxIdentityProbe = getCurrentTmuxServerIdentity,
=======
>>>>>>> origin/main
): Promise<PaneSurfaceBinding[]> {
  const panes = await readPaneRecords(projectRoot);
  const bindings: PaneSurfaceBinding[] = [];
  for (const pane of panes) {
    const id = String(pane.id ?? pane.paneId ?? '');
    const tmuxPaneId = String(pane.paneId ?? '');
<<<<<<< HEAD
    if (!id || !tmuxPaneId) continue;
    const persistedIdentity = pane.tmuxServerIdentity;
    let currentIdentity: TmuxServerIdentity | undefined;
    try {
      currentIdentity = await getTmuxIdentity(tmuxPaneId);
    } catch {
      continue;
    }
    if (
      !isTmuxServerIdentity(persistedIdentity)
      || !currentIdentity
      || !sameTmuxServerIdentity(persistedIdentity, currentIdentity)
      || !await isPaneLive(tmuxPaneId)
    ) continue;
=======
    if (!id || !tmuxPaneId || !await isPaneLive(tmuxPaneId)) continue;
>>>>>>> origin/main
    bindings.push({
      id,
      tmuxPaneId,
      worktreeRoot: String(pane.worktreePath ?? pane.worktreeDir ?? pane.cwd ?? projectRoot),
      ...(typeof pane.title === 'string' ? { title: pane.title } : {}),
      ...(typeof pane.agent === 'string' ? { agent: pane.agent } : {}),
    });
  }
  return bindings;
}

async function readPaneRecords(projectRoot: string): Promise<Array<Record<string, unknown>>> {
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
  return config.panes;
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
