import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';

function handlersWithCovenClient(
  sendInput: (sessionId: string, input: string) => Promise<void>,
  projectRoot = '/tmp/psyche-test-root',
  sessionIds = ['sess-1'],
) {
  return createDaemonControlHandlers({
    tmux: new TmuxControl('psyche-test'),
    projectRoot,
    sessionName: 'psyche-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => ({
      listSessions: async () => sessionIds.map((id) => ({
        id,
        projectRoot,
        harness: 'codex',
        title: id,
        status: 'running',
        createdAt: '2026-04-27T10:00:00Z',
        updatedAt: '2026-04-27T10:01:00Z',
      })),
      sendInput,
    }),
  });
}

describe('createDaemonControlHandlers runCovenDesktopAction', () => {
  it('sends a known desktop quick action to the coven client', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-handler-'));
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});
    const handlers = handlersWithCovenClient(sendInput, root);

    try {
      const result = await handlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'screenshot' });

      expect(sendInput).toHaveBeenCalledTimes(1);
      expect(sendInput.mock.calls[0][0]).toBe('sess-1');
      expect(sendInput.mock.calls[0][1]).toContain('computer_use');
      expect(result).toMatchObject({ sessionId: 'sess-1', action: 'screenshot', accepted: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not send desktop input to a session outside the project scope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'psyche-desktop-outside-'));
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});

    try {
      // Build handlers for root while the client reports its session under outside.
      const scopedHandlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({
          listSessions: async () => [{
            id: 'sess-1', projectRoot: outside, harness: 'codex', title: 'Outside', status: 'running',
            createdAt: '2026-04-27T10:00:00Z', updatedAt: '2026-04-27T10:01:00Z',
          }],
          sendInput,
        }),
      });
      await expect(scopedHandlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'approve' }))
        .rejects.toMatchObject({ code: 'coven_session_not_found' });
      expect(sendInput).not.toHaveBeenCalled();
    } finally {
      await Promise.all([root, outside].map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  it('rejects an unknown desktop action instead of sending undefined input', async () => {
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});
    const handlers = handlersWithCovenClient(sendInput);

    await expect(
      handlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'not-a-real-action' }),
    ).rejects.toMatchObject({ code: 'invalid_desktop_action' });
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe('createDaemonControlHandlers updatePaneMeta', () => {
  it('patches the pane registry through the bridge', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-meta-handler-'));
    try {
      await mkdir(path.join(root, '.psyche'), { recursive: true });
      const configPath = path.join(root, '.psyche', 'psyche.config.json');
      await writeFile(
        configPath,
        JSON.stringify({ panes: [{ id: 'psyche-1', paneId: '%3', title: 'old', agent: 'codex' }] }, null, 2),
      );

      const handlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({ listSessions: async () => [] }),
      });

      await handlers.updatePaneMeta({ paneId: '%3', title: 'renamed', agent: 'claude' });

      const config = JSON.parse(await readFile(configPath, 'utf8'));
      expect(config.panes[0]).toMatchObject({ paneId: '%3', title: 'renamed', agent: 'claude' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects when the pane is not in the registry', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-meta-handler-'));
    try {
      await mkdir(path.join(root, '.psyche'), { recursive: true });
      await writeFile(
        path.join(root, '.psyche', 'psyche.config.json'),
        JSON.stringify({ panes: [] }, null, 2),
      );

      const handlers = createDaemonControlHandlers({
        tmux: new TmuxControl('psyche-test'),
        projectRoot: root,
        sessionName: 'psyche-test',
        capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
        createCovenClient: () => ({ listSessions: async () => [] }),
      });

      await expect(
        handlers.updatePaneMeta({ paneId: '%404', title: 'x' }),
      ).rejects.toThrow(/not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
