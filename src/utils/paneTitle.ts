import { createHash } from 'crypto';
import path from 'path';
import type { PsychePane } from '../types.js';
import { getPaneProjectName, getPaneProjectRoot } from './paneProject.js';

export const PANE_TITLE_DELIMITER = '__psyche__';
export const MANAGED_PANE_TITLE_SEPARATOR = ' · ';
/**
 * Delimiters that were actually written into pane titles by earlier releases.
 *
 * These must NOT be renamed along with the current delimiter. The whole point
 * of the list is to recognize titles that already exist in a running tmux
 * server, so it has to name the string that is really out there. `::psyche::`
 * never shipped; `::comux::` did.
 *
 * (The vmux -> comux rename got this wrong in fe18067, renaming the legacy
 * entry too and leaving a list that matched nothing.)
 */
export const LEGACY_PANE_TITLE_DELIMITERS = ['::comux::'] as const;
const ALL_PANE_TITLE_DELIMITERS = [PANE_TITLE_DELIMITER, ...LEGACY_PANE_TITLE_DELIMITERS];

// Tmux's s/foo/bar/: modifier uses ":" to separate the target variable, so the
// encoded title delimiter itself must not contain ":" or the format expands blank.
export const TMUX_PANE_TITLE_DISPLAY_FORMAT = `#{s|${PANE_TITLE_DELIMITER}.*$||:pane_title}`;

function getProjectTag(projectRoot: string, projectName: string): string {
  const hash = createHash('md5')
    .update(projectRoot)
    .digest('hex')
    .slice(0, 4);
  const sanitizedName = projectName.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${sanitizedName}-${hash}`;
}

export function sanitizePaneDisplayName(value: string): string {
  return ALL_PANE_TITLE_DELIMITERS.reduce(
    (sanitized, delimiter) => sanitized.replaceAll(delimiter, ' '),
    value
  )
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getPaneDisplayName(
  pane: Pick<PsychePane, 'slug' | 'displayName'>
): string {
  const displayName = typeof pane.displayName === 'string'
    ? sanitizePaneDisplayName(pane.displayName)
    : '';
  return displayName || pane.slug;
}

export function buildManagedPaneTitle(label: string | undefined, slug: string): string {
  const stableSlug = sanitizePaneDisplayName(slug);
  const displayLabel = typeof label === 'string'
    ? sanitizePaneDisplayName(label)
    : '';
  if (!displayLabel || displayLabel === stableSlug) {
    return stableSlug;
  }
  if (displayLabel.endsWith(`${MANAGED_PANE_TITLE_SEPARATOR}${stableSlug}`)) {
    return displayLabel;
  }
  return `${displayLabel}${MANAGED_PANE_TITLE_SEPARATOR}${stableSlug}`;
}

function encodePaneTmuxTitle(
  displayTitle: string,
  stableTitle: string,
  delimiter: string = PANE_TITLE_DELIMITER
): string {
  if (displayTitle === stableTitle) {
    return stableTitle;
  }
  return `${displayTitle}${delimiter}${stableTitle}`;
}

function getCustomPaneDisplayName(
  pane: Pick<PsychePane, 'displayName'>
): string | undefined {
  if (typeof pane.displayName !== 'string') {
    return undefined;
  }

  const displayName = sanitizePaneDisplayName(pane.displayName);
  return displayName || undefined;
}

function getStablePaneTmuxTitle(
  pane: PsychePane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string {
  if (pane.type === 'shell' || pane.type === 'desktop-use') {
    return pane.slug;
  }

  const projectRoot = pane.projectRoot
    || (fallbackProjectRoot ? getPaneProjectRoot(pane, fallbackProjectRoot) : undefined);
  if (!projectRoot) {
    return pane.slug;
  }

  if (
    fallbackProjectRoot
    && path.resolve(projectRoot) === path.resolve(fallbackProjectRoot)
  ) {
    // Keep the original title style for panes in the session's primary project.
    return pane.slug;
  }

  const projectName = getPaneProjectName(pane, projectRoot, fallbackProjectName);
  return buildWorktreePaneTitle(pane.slug, projectRoot, projectName);
}

export function getPaneTmuxDisplayTitle(
  pane: PsychePane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string {
  return getCustomPaneDisplayName(pane)
    || getStablePaneTmuxTitle(pane, fallbackProjectRoot, fallbackProjectName);
}

/**
 * Tmux pane title used for rebinding. Includes a stable project tag for
 * worktree panes so duplicate slugs across projects do not collide.
 */
export function getPaneTmuxTitle(
  pane: PsychePane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string {
  const stableTitle = getStablePaneTmuxTitle(pane, fallbackProjectRoot, fallbackProjectName);
  const displayTitle = getPaneTmuxDisplayTitle(pane, fallbackProjectRoot, fallbackProjectName);

  if (displayTitle.endsWith(`${MANAGED_PANE_TITLE_SEPARATOR}${pane.slug}`)) {
    return displayTitle;
  }
  return displayTitle
    ? encodePaneTmuxTitle(displayTitle, stableTitle)
    : stableTitle;
}

/**
 * Candidate titles to check when rebinding panes.
 * Includes legacy encoded titles so existing sessions keep rebinding after
 * delimiter migrations.
 */
export function getPaneTitleCandidates(
  pane: PsychePane,
  fallbackProjectRoot?: string,
  fallbackProjectName?: string
): string[] {
  const stableTitle = getStablePaneTmuxTitle(pane, fallbackProjectRoot, fallbackProjectName);
  const displayTitle = getCustomPaneDisplayName(pane);
  const candidates = new Set<string>([stableTitle, pane.slug]);

  if (!displayTitle) {
    return Array.from(candidates);
  }
  if (displayTitle.endsWith(`${MANAGED_PANE_TITLE_SEPARATOR}${pane.slug}`)) {
    candidates.add(displayTitle);
  }

  for (const delimiter of ALL_PANE_TITLE_DELIMITERS) {
    candidates.add(encodePaneTmuxTitle(displayTitle, stableTitle, delimiter));
  }

  return Array.from(candidates);
}

export function buildWorktreePaneTitle(
  slug: string,
  projectRoot: string,
  projectName?: string
): string {
  const name = projectName || 'project';
  return `${slug}@${getProjectTag(projectRoot, name)}`;
}
