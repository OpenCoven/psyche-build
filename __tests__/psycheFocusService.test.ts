import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseHelperSocketOwnerProcessIds,
  PsycheFocusService,
} from '../src/services/PsycheFocusService.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PsycheFocusService helper restart', () => {
  it('only returns processes that own the helper socket path', () => {
    const socketPath = '/Users/test/.psyche/native-helper/run/psyche-helper.sock';
    const lsofOutput = [
      'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      `psyche-help 35876 test    3u  unix 0x123      0t0      ${socketPath}`,
      `psyche-help 35876 test    4u  unix 0x456      0t0      ${socketPath}`,
      'node      39503 test   19u  unix 0x789      0t0      ->0x456',
      'node      39504 test   20u  unix 0xabc      0t0      ->0x123',
    ].join('\n');

    expect(parseHelperSocketOwnerProcessIds(lsofOutput, socketPath, 99999)).toEqual([35876]);
  });

  it('filters out the current process id', () => {
    const socketPath = '/Users/test/.psyche/native-helper/run/psyche-helper.sock';
    const lsofOutput = [
      'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      `psyche-help 12345 test    3u  unix 0x123      0t0      ${socketPath}`,
    ].join('\n');

    expect(parseHelperSocketOwnerProcessIds(lsofOutput, socketPath, 12345)).toEqual([]);
  });

  it('restores the captured pane style when a flash is canceled without mutating a replacement', async () => {
    vi.useFakeTimers();
    const service = new PsycheFocusService({ projectName: 'test' });
    const tmux = (service as any).tmuxService;
    const setOption = vi.spyOn(tmux, 'setPaneOptionSync').mockReturnValue(undefined);
    vi.spyOn(tmux, 'unsetPaneOptionSync').mockReturnValue(undefined);
    vi.spyOn(tmux, 'getPaneOptionSync').mockReturnValue('bg=colour20');
    vi.spyOn(tmux, 'getGlobalOptionSync').mockReturnValue('bg=colour20');
    (service as any).active = true;
    const controller = new AbortController();
    let current = true;

    await service.flashPaneAttention('%old', {
      signal: controller.signal,
      isCurrent: () => current,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(setOption).toHaveBeenCalledWith('%old', 'window-style', 'bg=colour21');

    current = false;
    setOption.mockClear();
    controller.abort();
    await vi.runAllTimersAsync();

    expect(setOption).toHaveBeenCalledOnce();
    expect(setOption).toHaveBeenCalledWith('%old', 'window-style', 'bg=colour20');
    expect(setOption).not.toHaveBeenCalledWith('%new', 'window-style', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
    expect((service as any).flashingTmuxPaneIds.has('%old')).toBe(false);
  });

  it('tolerates a captured pane vanishing before cancellation restores its style', async () => {
    vi.useFakeTimers();
    const service = new PsycheFocusService({ projectName: 'test' });
    const tmux = (service as any).tmuxService;
    const setOption = vi.spyOn(tmux, 'setPaneOptionSync')
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error("can't find pane: %old");
      });
    vi.spyOn(tmux, 'unsetPaneOptionSync').mockReturnValue(undefined);
    vi.spyOn(tmux, 'getPaneOptionSync').mockReturnValue('bg=colour20');
    vi.spyOn(tmux, 'getGlobalOptionSync').mockReturnValue('bg=colour20');
    (service as any).active = true;
    const controller = new AbortController();

    await service.flashPaneAttention('%old', {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(() => controller.abort()).not.toThrow();
    await vi.runAllTimersAsync();

    expect(setOption).toHaveBeenLastCalledWith('%old', 'window-style', 'bg=colour20');
    expect(vi.getTimerCount()).toBe(0);
    expect((service as any).flashingTmuxPaneIds.has('%old')).toBe(false);
  });

  it('keeps normal pane flash behavior and restores the original style', async () => {
    vi.useFakeTimers();
    const service = new PsycheFocusService({ projectName: 'test' });
    const tmux = (service as any).tmuxService;
    const setOption = vi.spyOn(tmux, 'setPaneOptionSync').mockReturnValue(undefined);
    vi.spyOn(tmux, 'unsetPaneOptionSync').mockReturnValue(undefined);
    vi.spyOn(tmux, 'getPaneOptionSync').mockReturnValue('bg=colour20');
    vi.spyOn(tmux, 'getGlobalOptionSync').mockReturnValue('bg=colour20');
    (service as any).active = true;
    const controller = new AbortController();

    await service.flashPaneAttention('%71', {
      signal: controller.signal,
      isCurrent: () => true,
    });
    await vi.runAllTimersAsync();

    expect(setOption).toHaveBeenCalledWith('%71', 'window-style', 'bg=colour21');
    expect(setOption).toHaveBeenLastCalledWith('%71', 'window-style', 'bg=colour20');
    expect((service as any).flashingTmuxPaneIds.has('%71')).toBe(false);
  });

  it('destroys a pending notification socket and never writes after cancellation', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    const service = new PsycheFocusService({ projectName: 'test' });
    const socket = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    socket.write = vi.fn();
    socket.destroy = vi.fn();
    (service as any).ensureHelperSocketPath = vi.fn(async () => '/fake/helper.sock');
    (service as any).createNotificationSocket = vi.fn(() => socket);
    const controller = new AbortController();

    try {
      const result = service.sendAttentionNotification({
        title: 'Ready',
        body: 'Continue.',
        tmuxPaneId: '%72',
      }, {
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
      });
      await vi.waitFor(() => expect((service as any).createNotificationSocket).toHaveBeenCalledOnce());

      controller.abort();
      socket.emit('connect');

      await expect(result).resolves.toBe(false);
      expect(socket.destroy).toHaveBeenCalled();
      expect(socket.write).not.toHaveBeenCalled();
      expect(socket.listenerCount('connect')).toBe(0);
      expect(socket.listenerCount('error')).toBe(0);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
    }
  });
});
