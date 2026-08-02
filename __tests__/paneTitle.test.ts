import { describe, expect, it } from 'vitest';
import {
  LEGACY_PANE_TITLE_DELIMITERS,
  PANE_TITLE_DELIMITER,
  TMUX_PANE_TITLE_DISPLAY_FORMAT,
  buildWorktreePaneTitle,
  getPaneDisplayName,
  getPaneTitleCandidates,
  getPaneTmuxTitle,
} from '../src/utils/paneTitle.js';
import { createWorktreePane } from './fixtures/mockPanes.js';

describe('pane title helpers', () => {
  it('uses a tmux-safe delimiter for border title rendering', () => {
    expect(PANE_TITLE_DELIMITER.includes(':')).toBe(false);
  });

  // These pin literal VALUES rather than reading the constants back. Tests
  // that reference PANE_TITLE_DELIMITER on both sides pass no matter what the
  // constant holds, so a rename sweep could change it silently.
  it('pins the delimiter written into real tmux pane titles', () => {
    expect(PANE_TITLE_DELIMITER).toBe('__psyche__');
    expect(TMUX_PANE_TITLE_DISPLAY_FORMAT).toBe('#{s|__psyche__.*$||:pane_title}');
  });

  // Regression: the legacy list exists to recognize titles already sitting in
  // a running tmux server, so it must name what actually shipped. A rename
  // sweep that also renames this entry leaves a list matching nothing — which
  // is exactly what the vmux -> comux rename did in fe18067.
  it('keeps the pre-rename delimiter that really shipped', () => {
    expect(LEGACY_PANE_TITLE_DELIMITERS).toContain('::comux::');
    expect(LEGACY_PANE_TITLE_DELIMITERS).not.toContain('::psyche::');
  });

  it('prefers the custom display name for UI labels', () => {
    const pane = createWorktreePane({
      slug: 'fix-auth',
      displayName: 'Auth Review',
    });

    expect(getPaneDisplayName(pane)).toBe('Auth Review');
  });

  it('encodes a custom display name into the tmux title while preserving a stable suffix', () => {
    const pane = createWorktreePane({
      slug: 'fix-auth',
      displayName: 'Auth Review',
      projectRoot: '/tmp/project',
    });

    expect(getPaneTmuxTitle(pane, '/tmp/project')).toBe(
      `Auth Review${PANE_TITLE_DELIMITER}fix-auth`
    );
    expect(getPaneTitleCandidates(pane, '/tmp/project')).toContain('fix-auth');
    expect(getPaneTitleCandidates(pane, '/tmp/project')).toContain(
      `Auth Review${LEGACY_PANE_TITLE_DELIMITERS[0]}fix-auth`
    );
  });

  it('keeps the legacy multi-project title when no custom name is set', () => {
    const pane = createWorktreePane({
      slug: 'fix-auth',
      projectRoot: '/tmp/other-project',
      projectName: 'other-project',
    });

    expect(getPaneTmuxTitle(pane, '/tmp/session-project', 'session-project')).toBe(
      buildWorktreePaneTitle('fix-auth', '/tmp/other-project', 'other-project')
    );
  });
});
