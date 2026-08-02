import { describe, expect, it } from 'vitest';
import {
  buildDesktopUseQuickInput,
  buildDesktopUseStateFromEvents,
  isDesktopUsePane,
} from '../src/utils/covenDesktopUse.js';
import type { CovenSessionEvent, CovenSessionSummary } from '../src/daemon/protocol.js';

const session: CovenSessionSummary = {
  id: 'session-1',
  projectRoot: '/repo',
  harness: 'codex',
  title: 'desktop-use',
  status: 'running',
  createdAt: '2026-05-10T08:00:00Z',
  updatedAt: '2026-05-10T08:00:03Z',
};

describe('desktop-use Coven state helpers', () => {
  it('recognizes desktop-use pane records', () => {
    expect(isDesktopUsePane({
      id: 'psyche-1',
      slug: 'desktop-use',
      prompt: '',
      paneId: '%1',
      type: 'desktop-use',
    })).toBe(true);
  });

  it('summarizes desktop-use actions, permissions, screenshots, and accessibility state', () => {
    const events: CovenSessionEvent[] = [
      {
        id: 'evt-1',
        sessionId: 'session-1',
        kind: 'tool_call',
        payloadJson: JSON.stringify({
          tool: 'computer_use',
          input: { action: 'inspect' },
          result: {
            permissions: { accessibility: 'granted', screenCapture: 'required-by-system' },
            accessibility: { role: 'window', title: 'OpenSide' },
          },
        }),
        createdAt: '2026-05-10T08:00:01Z',
      },
      {
        id: 'evt-2',
        sessionId: 'session-1',
        kind: 'tool_result',
        payloadJson: JSON.stringify({
          source: 'openside',
          action: 'screenshot',
          imagePath: '/tmp/screen.png',
          traceId: 'coven-123',
        }),
        createdAt: '2026-05-10T08:00:02Z',
      },
    ];

    const state = buildDesktopUseStateFromEvents('pane-1', 'session-1', events, session);

    expect(state.connected).toBe(true);
    expect(state.session?.id).toBe('session-1');
    expect(state.currentAction?.label).toBe('screenshot');
    expect(state.actions.map((action) => action.label)).toEqual(['screenshot', 'inspect']);
    expect(state.permissions).toMatchObject({ accessibility: 'granted', screenCapture: 'required-by-system' });
    expect(state.accessibilitySummary).toBe('window · OpenSide');
    expect(state.screenshotPath).toBe('/tmp/screen.png');
  });

  it('builds quick inputs for Coven codex harnesses', () => {
    expect(buildDesktopUseQuickInput('screenshot')).toContain('computer_use');
    expect(buildDesktopUseQuickInput('approve')).toContain('Approve');
  });
});
