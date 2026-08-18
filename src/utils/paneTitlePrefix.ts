import type { PsychePane, SidebarProject } from '../types.js';
import type { PaneOptionMutation } from '../services/TmuxService.js';
import { getPsycheThemeAccent } from '../theme/colors.js';
import { getPaneColorTheme } from './paneColors.js';

export type { PaneOptionMutation } from '../services/TmuxService.js';

export interface PaneOptionCacheChange {
  cache: Map<string, string>;
  mutation: PaneOptionMutation;
}

export const PANE_TITLE_BUSY_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/**
 * Spinner frame duration.
 *
 * Every frame writes a tmux option per busy pane, so the interval is a process
 * spawn rate, not just an animation speed. 150ms still reads as spinning while
 * costing under half of what 90ms did.
 */
export const PANE_TITLE_SPINNER_INTERVAL_MS = 150;
export const PANE_TITLE_IDLE_MARKER = '⠿';
export const TMUX_PANE_TITLE_PREFIX_FORMAT = '#{?@psyche_title_prefix,#{@psyche_title_prefix} ,}';
const ACTIVE_TITLE_STYLE_CONDITION = '#{&&:#{pane_active},#{!=:#{@psyche_active_border_style},}}';
export const TMUX_PANE_TITLE_LABEL_FORMAT = `#{?${ACTIVE_TITLE_STYLE_CONDITION},#[#{@psyche_active_border_style}],}#{?@psyche_title_label,#{@psyche_title_label},#{s|__psyche__.*$||:pane_title}}#{?${ACTIVE_TITLE_STYLE_CONDITION},#[default],}`;

function isBusyPane(pane: PsychePane): boolean {
  return pane.agentStatus === 'working';
}

export function getPaneTitlePrefixValue(
  pane: PsychePane,
  sidebarProjects: SidebarProject[],
  fallbackProjectRoot: string,
  spinnerFrameIndex: number = 0
): string {
  const themeName = getPaneColorTheme(pane, sidebarProjects, fallbackProjectRoot);
  const marker = isBusyPane(pane)
    ? PANE_TITLE_BUSY_FRAMES[spinnerFrameIndex % PANE_TITLE_BUSY_FRAMES.length]
    : PANE_TITLE_IDLE_MARKER;
  return `#[fg=${getPsycheThemeAccent(themeName)}]${marker}#[default]`;
}

export function paneNeedsAnimatedTitlePrefix(pane: PsychePane): boolean {
  return isBusyPane(pane);
}

export function flushPaneOptionCacheChanges(
  changes: ReadonlyArray<PaneOptionCacheChange>,
  writeBatch: (mutations: ReadonlyArray<PaneOptionMutation>) => boolean
): boolean {
  const pendingChanges = changes.filter(({ cache, mutation }) =>
    'unset' in mutation
      ? cache.has(mutation.paneId)
      : cache.get(mutation.paneId) !== mutation.value
  );

  if (pendingChanges.length === 0) {
    return true;
  }

  const mutations = [
    ...pendingChanges
      .filter(({ mutation }) => !('unset' in mutation))
      .map(({ mutation }) => mutation),
    ...pendingChanges
      .filter(({ mutation }) => 'unset' in mutation)
      .map(({ mutation }) => mutation),
  ];

  if (!writeBatch(mutations)) {
    return false;
  }

  for (const { cache, mutation } of pendingChanges) {
    if ('unset' in mutation) {
      cache.delete(mutation.paneId);
    } else {
      cache.set(mutation.paneId, mutation.value);
    }
  }

  return true;
}
