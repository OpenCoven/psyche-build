import { describe, expect, it, vi } from 'vitest';

import { watchCreatedPaneAgentLaunch } from '../src/utils/paneCreation.js';

const NONCE = '0a1b2c3d';
const LAUNCH = {
  tmuxPaneId: '%7',
  psychePaneId: 'psyche-7',
  agent: 'claude' as const,
  nonce: NONCE,
};

function deps(reads: Array<string | undefined>) {
  let clock = 0;
  return {
    readExitOption: vi.fn(async () => reads.shift()),
    // A fake clock: the watch window elapses without real waiting.
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    logWarn: vi.fn(),
    showToast: vi.fn(),
  };
}

describe('watchCreatedPaneAgentLaunch', () => {
  it('reports one recorded failure as exactly one toast and one log line', async () => {
    const injected = deps([undefined, `${NONCE}:127`, `${NONCE}:127`]);

    await watchCreatedPaneAgentLaunch(LAUNCH, injected);

    expect(injected.readExitOption).toHaveBeenCalledWith('%7');
    expect(injected.showToast).toHaveBeenCalledTimes(1);
    expect(injected.logWarn).toHaveBeenCalledTimes(1);
    const [toast] = injected.showToast.mock.calls[0];
    expect(toast).toContain('Claude Code did not start (command not found, exit 127)');
    const [line, source, paneId] = injected.logWarn.mock.calls[0];
    expect(line).toContain('[agent_launch_failed:command_not_found:check_agent_install]');
    expect(source).toBe('paneCreation');
    expect(paneId).toBe('psyche-7');
  });

  it('reports nothing for an operator cancel (exit 130)', async () => {
    const injected = deps([`${NONCE}:130`]);

    await watchCreatedPaneAgentLaunch(LAUNCH, injected);

    expect(injected.showToast).not.toHaveBeenCalled();
    expect(injected.logWarn).not.toHaveBeenCalled();
  });

  it('reports nothing for a status recorded by another launch', async () => {
    const injected = deps([]);
    injected.readExitOption.mockResolvedValue('ffffffff:1');

    await watchCreatedPaneAgentLaunch(LAUNCH, injected);

    expect(injected.showToast).not.toHaveBeenCalled();
  });
});
