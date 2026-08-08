import { describe, expect, it, vi } from 'vitest';
import { createDaemonControlHandlers } from '../../src/daemon/controlHandlers.js';
import { AgenticCapabilityRouter } from '../../src/orchestration/capabilityRouter.js';
import { TmuxControl } from '../../src/services/tmuxControl.js';

function handlersWithCovenClient(
  sendInput: (sessionId: string, input: string) => Promise<void>,
) {
  return createDaemonControlHandlers({
    tmux: new TmuxControl('psyche-test'),
    projectRoot: '/tmp/psyche-test-root',
    sessionName: 'psyche-test',
    capabilityRouter: new AgenticCapabilityRouter({ strategies: [] }),
    createCovenClient: () => ({ listSessions: async () => [], sendInput }),
  });
}

describe('createDaemonControlHandlers runCovenDesktopAction', () => {
  it('sends a known desktop quick action to the coven client', async () => {
    const sendInput = vi.fn(async (_sessionId: string, _input: string) => {});
    const handlers = handlersWithCovenClient(sendInput);

    const result = await handlers.runCovenDesktopAction({ sessionId: 'sess-1', action: 'screenshot' });

    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0][0]).toBe('sess-1');
    expect(sendInput.mock.calls[0][1]).toContain('computer_use');
    expect(result).toMatchObject({ sessionId: 'sess-1', action: 'screenshot', accepted: true });
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
