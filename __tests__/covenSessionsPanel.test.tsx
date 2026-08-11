import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import CovenSessionsPanel from '../src/components/panes/CovenSessionsPanel.js';
import PanesGrid from '../src/components/panes/PanesGrid.js';
import type { CovenSessionsLoadState } from '../src/utils/covenSessions.js';

const READY_STATE: CovenSessionsLoadState = {
  status: 'ready',
  source: 'coven sessions --json',
  loadedAt: '2026-04-28T12:00:00.000Z',
  sessions: [
    {
      id: 'session-1',
      projectRoot: '/repo',
      harness: 'codex',
      title: 'Fix tests',
      status: 'running',
    },
    {
      id: 'session-2',
      projectRoot: '/repo',
      harness: 'codex',
      title: 'Archived plan',
      status: 'archived',
      archivedAt: '2026-04-28T12:02:00.000Z',
    },
    {
      id: 'session-other',
      projectRoot: '/other-repo',
      harness: 'claude',
      title: 'Unrelated project',
      status: 'running',
    },
  ],
};

describe('Coven sessions panel', () => {
  it('renders scoped Coven sessions in the project side panel', () => {
    const { lastFrame } = render(
      <PanesGrid
        panes={[]}
        selectedIndex={0}
        activeProjectRoot="/repo"
        isLoading={false}
        themeName="purple"
        projectThemeByRoot={new Map([['/repo', 'purple']])}
        sidebarProjects={[]}
        fallbackProjectRoot="/repo"
        fallbackProjectName="repo"
        covenSessionsState={READY_STATE}
      />
    );

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('☾ Coven sessions');
    expect(frame).toContain('[o]pen');
    expect(frame).toContain('[codex] Fix tests · running');
    expect(frame).toContain('[codex] Archived plan · archived');
    expect(frame).toContain('[o] open Archived plan');
    expect(frame).not.toContain('Unrelated project');
  });

  it('renders nothing when inactive and Coven is unavailable', () => {
    const state: CovenSessionsLoadState = {
      status: 'unavailable',
      sessions: [],
      reason: 'coven CLI not found',
      loadedAt: '2026-04-28T12:00:00.000Z',
    };

    const { lastFrame } = render(
      <CovenSessionsPanel
        projectRoot="/repo"
        state={state}
        isActive={false}
        themeName="purple"
      />
    );

    expect(stripAnsi(lastFrame() ?? '')).toBe('');
  });

  it('renders a friendly install hint when active and the Coven CLI is missing', () => {
    const state: CovenSessionsLoadState = {
      status: 'unavailable',
      sessions: [],
      reason: 'coven CLI not found',
      loadedAt: '2026-04-28T12:00:00.000Z',
    };

    const { lastFrame } = render(
      <CovenSessionsPanel
        projectRoot="/repo"
        state={state}
        isActive
        themeName="purple"
      />
    );

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('☾ Coven not running');
    expect(frame).toContain('  install: npm i -g @opencoven/cli');
  });

  it('renders a friendly start hint when active and Coven is unavailable', () => {
    const state: CovenSessionsLoadState = {
      status: 'unavailable',
      sessions: [],
      reason: 'coven sessions --json timed out',
      loadedAt: '2026-04-28T12:00:00.000Z',
    };

    const { lastFrame } = render(
      <CovenSessionsPanel
        projectRoot="/repo"
        state={state}
        isActive
        themeName="purple"
      />
    );

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('☾ Coven not running');
    expect(frame).toContain('  run: coven start');
  });

  it('renders a friendly empty hint when active and there are no Coven sessions', () => {
    const state: CovenSessionsLoadState = {
      status: 'empty',
      sessions: [],
      source: 'coven sessions --json',
      loadedAt: '2026-04-28T12:00:00.000Z',
    };

    const { lastFrame } = render(
      <CovenSessionsPanel
        projectRoot="/repo"
        state={state}
        isActive
        themeName="purple"
      />
    );

    expect(stripAnsi(lastFrame() ?? '')).toContain('☾ Coven: no sessions yet');
  });
});
