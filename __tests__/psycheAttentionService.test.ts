import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PsycheAttentionService } from '../src/services/PsycheAttentionService.js';
import { PsycheFocusService } from '../src/services/PsycheFocusService.js';
import { getStatusDetector, resetStatusDetector } from '../src/services/StatusDetector.js';
import { createDeferred } from './utils/deferred.js';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

class MockFocusService extends EventEmitter {
  isPaneFullyFocused = vi.fn(() => false);
  getPaneAttentionSurface = vi.fn(async (_tmuxPaneId?: string) => 'background');
  flashPaneAttention = vi.fn(async (
    _tmuxPaneId?: string,
    _ownership?: { signal: AbortSignal; isCurrent: () => boolean },
  ) => undefined);
  setPaneAttentionIndicator = vi.fn(() => undefined);
  sendAttentionNotification = vi.fn(async (
    _request?: unknown,
    _ownership?: { signal: AbortSignal; isCurrent: () => boolean },
  ) => true);
}

function emitStatusUpdated(event: {
  paneId: string;
  status: 'idle' | 'analyzing' | 'waiting' | 'working';
}): void {
  getStatusDetector().emit('status-updated', event);
}

function emitAttentionNeeded(event: {
  paneId: string;
  tmuxPaneId: string;
  lifecycle?: symbol;
  status: 'idle' | 'waiting';
  title: string;
  body: string;
  subtitle?: string;
  fingerprint: string;
}): void {
  getStatusDetector().emit('attention-needed', event);
}

function emitPaneUserInteraction(event: { paneId: string }): void {
  getStatusDetector().emit('pane-user-interaction', event);
}

function emitPaneReset(event: { paneId: string }): void {
  getStatusDetector().emit('pane-reset', event);
}

function emitPaneRemoved(event: { paneId: string }): void {
  getStatusDetector().emit('pane-removed', event);
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('PsycheAttentionService', () => {
  beforeEach(() => {
    setPlatform('darwin');
  });

  afterEach(() => {
    resetStatusDetector();
    setPlatform(originalPlatform);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('suppresses startup attention notifications until pane activity is observed', async () => {
    const focusService = new MockFocusService();
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitAttentionNeeded({
      paneId: 'pane-1',
      tmuxPaneId: '%1',
      status: 'idle',
      title: 'Ready for the next prompt',
      body: 'The agent finished its current step. Open the pane and continue the work.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();

    focusService.emit('focus-changed', {
      fullyFocusedPaneId: null,
      helperFocused: false,
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();

    service.stop();
  });

  it('notifies once a pane returns to attention after working', async () => {
    const focusService = new MockFocusService();
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitAttentionNeeded({
      paneId: 'pane-1',
      tmuxPaneId: '%1',
      status: 'idle',
      title: 'Ready for the next prompt',
      body: 'The agent finished its current step. Open the pane and continue the work.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();

    emitStatusUpdated({
      paneId: 'pane-1',
      status: 'working',
    });

    emitAttentionNeeded({
      paneId: 'pane-1',
      tmuxPaneId: '%1',
      status: 'idle',
      title: 'Ready for the next prompt',
      body: 'The agent finished its current step. Open the pane and continue the work.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);
    expect(focusService.sendAttentionNotification).toHaveBeenCalledWith(
      {
        title: 'Ready for the next prompt',
        subtitle: undefined,
        body: 'The agent finished its current step. Open the pane and continue the work.',
        tmuxPaneId: '%1',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    service.stop();
  });

  it('flashes the pane instead of sending a native notification when the terminal window is focused', async () => {
    const focusService = new MockFocusService();
    focusService.getPaneAttentionSurface.mockResolvedValue('same-window');
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitStatusUpdated({
      paneId: 'pane-2',
      status: 'working',
    });

    emitAttentionNeeded({
      paneId: 'pane-2',
      tmuxPaneId: '%9',
      status: 'idle',
      title: 'Review result',
      body: 'The pane settled and is waiting for your next step.',
      fingerprint: 'idle:review-result',
    });
    await flushAsyncWork();

    expect(focusService.flashPaneAttention).toHaveBeenCalledTimes(1);
    expect(focusService.flashPaneAttention).toHaveBeenCalledWith(
      '%9',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(focusService.setPaneAttentionIndicator).toHaveBeenCalledWith('%9', true);
    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();

    service.stop();
  });

  it('does not send a native notification when the tmux pane is already fully focused', async () => {
    const focusService = new MockFocusService();
    focusService.getPaneAttentionSurface.mockResolvedValue('fully-focused');
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitStatusUpdated({
      paneId: 'psyche-pane-7',
      status: 'working',
    });

    emitAttentionNeeded({
      paneId: 'psyche-pane-7',
      tmuxPaneId: '%12',
      status: 'idle',
      title: 'Stay here',
      body: 'This pane is already focused.',
      fingerprint: 'idle:stay-here',
    });
    await flushAsyncWork();

    expect(focusService.getPaneAttentionSurface).toHaveBeenCalledWith('%12');
    expect(focusService.flashPaneAttention).not.toHaveBeenCalled();
    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();

    service.stop();
  });

  it('still sends a native notification when the pane is selected but the terminal window is in the background', async () => {
    const focusService = new MockFocusService();
    focusService.getPaneAttentionSurface.mockResolvedValue('background');
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitStatusUpdated({
      paneId: 'pane-foreground-in-tmux',
      status: 'working',
    });

    emitAttentionNeeded({
      paneId: 'pane-foreground-in-tmux',
      tmuxPaneId: '%21',
      status: 'idle',
      title: 'Background terminal',
      body: 'The pane finished work while the terminal window was not active.',
      fingerprint: 'idle:background-terminal',
    });
    await flushAsyncWork();

    expect(focusService.getPaneAttentionSurface).toHaveBeenCalledWith('%21');
    expect(focusService.flashPaneAttention).not.toHaveBeenCalled();
    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);
    expect(focusService.sendAttentionNotification).toHaveBeenCalledWith(
      {
        title: 'Background terminal',
        subtitle: undefined,
        body: 'The pane finished work while the terminal window was not active.',
        tmuxPaneId: '%21',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    service.stop();
  });

  it('clears pending attention when the user interacts with the pane', async () => {
    const focusService = new MockFocusService();
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitStatusUpdated({
      paneId: 'pane-3',
      status: 'working',
    });

    emitAttentionNeeded({
      paneId: 'pane-3',
      tmuxPaneId: '%5',
      status: 'idle',
      title: 'Ready',
      body: 'Continue the work.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);
    expect(focusService.setPaneAttentionIndicator).toHaveBeenCalledWith('%5', true);

    emitPaneUserInteraction({ paneId: 'pane-3' });
    focusService.sendAttentionNotification.mockClear();

    focusService.emit('focus-changed', {
      fullyFocusedPaneId: null,
      helperFocused: false,
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();
    expect(focusService.setPaneAttentionIndicator).toHaveBeenCalledWith('%5', false);

    service.stop();
  });

  it('does not notify again while an existing attention alert is still active', async () => {
    const focusService = new MockFocusService();
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();

    emitStatusUpdated({
      paneId: 'pane-4',
      status: 'working',
    });

    emitAttentionNeeded({
      paneId: 'pane-4',
      tmuxPaneId: '%6',
      status: 'idle',
      title: 'Review pass one',
      body: 'The agent stopped after the first pass.',
      fingerprint: 'idle:review-pass-one',
    });
    await flushAsyncWork();

    emitAttentionNeeded({
      paneId: 'pane-4',
      tmuxPaneId: '%6',
      status: 'idle',
      title: 'Review pass two',
      body: 'The agent is still waiting for you.',
      fingerprint: 'idle:review-pass-two',
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);
    expect(focusService.setPaneAttentionIndicator).toHaveBeenCalledWith('%6', true);

    service.stop();
  });

  it('clears attention and notification fingerprints on repeated pane resets', async () => {
    const focusService = new MockFocusService();
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-reset', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-reset',
      tmuxPaneId: '%30',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();
    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);

    emitPaneReset({ paneId: 'pane-reset' });
    emitPaneReset({ paneId: 'pane-reset' });
    expect(focusService.setPaneAttentionIndicator).toHaveBeenCalledWith('%30', false);

    focusService.sendAttentionNotification.mockClear();
    emitStatusUpdated({ paneId: 'pane-reset', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-reset',
      tmuxPaneId: '%31',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);
    expect(focusService.sendAttentionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxPaneId: '%31' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    emitPaneRemoved({ paneId: 'pane-reset' });
    emitPaneRemoved({ paneId: 'pane-reset' });
    expect(focusService.setPaneAttentionIndicator).toHaveBeenCalledWith('%31', false);

    focusService.sendAttentionNotification.mockClear();
    emitStatusUpdated({ paneId: 'pane-reset', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-reset',
      tmuxPaneId: '%32',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it.each([
    ['reset', emitPaneReset],
    ['removal', emitPaneRemoved],
    ['disarm', emitPaneUserInteraction],
  ] as const)('invalidates deferred surface work after pane %s', async (_reason, endLifecycle) => {
    const focusService = new MockFocusService();
    const surface = createDeferred<'background'>();
    focusService.getPaneAttentionSurface.mockReturnValue(surface.promise);
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-deferred', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-deferred',
      tmuxPaneId: '%40',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await vi.waitFor(() => expect(focusService.getPaneAttentionSurface).toHaveBeenCalledOnce());

    endLifecycle({ paneId: 'pane-deferred' });
    surface.resolve('background');
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();
    expect(focusService.setPaneAttentionIndicator).not.toHaveBeenCalledWith('%40', true);
    expect((service as any).activeAttentionPanes.has('pane-deferred')).toBe(false);
    expect((service as any).notifiedFingerprints.has('pane-deferred')).toBe(false);
    service.stop();
  });

  it('invalidates deferred work when a candidate is replaced', async () => {
    const focusService = new MockFocusService();
    const oldSurface = createDeferred<'background'>();
    focusService.getPaneAttentionSurface.mockImplementation((tmuxPaneId?: string) => (
      tmuxPaneId === '%50' ? oldSurface.promise : Promise.resolve('background')
    ));
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-replaced', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-replaced',
      tmuxPaneId: '%50',
      status: 'idle',
      title: 'Old',
      body: 'Old candidate.',
      fingerprint: 'idle:old',
    });
    await vi.waitFor(() => expect(focusService.getPaneAttentionSurface).toHaveBeenCalledWith('%50'));

    emitAttentionNeeded({
      paneId: 'pane-replaced',
      tmuxPaneId: '%51',
      status: 'idle',
      title: 'New',
      body: 'New candidate.',
      fingerprint: 'idle:new',
    });
    await vi.waitFor(() => expect(focusService.sendAttentionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxPaneId: '%51' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    oldSurface.resolve('background');
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ tmuxPaneId: '%50' }),
      expect.anything(),
    );
    expect(focusService.setPaneAttentionIndicator).not.toHaveBeenCalledWith('%50', true);
    service.stop();
  });

  it('invalidates deferred work when the service stops', async () => {
    const focusService = new MockFocusService();
    const surface = createDeferred<'background'>();
    focusService.getPaneAttentionSurface.mockReturnValue(surface.promise);
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-stopped', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-stopped',
      tmuxPaneId: '%52',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await vi.waitFor(() => expect(focusService.getPaneAttentionSurface).toHaveBeenCalledOnce());

    service.stop();
    surface.resolve('background');
    await flushAsyncWork();

    expect(focusService.sendAttentionNotification).not.toHaveBeenCalled();
    expect(focusService.setPaneAttentionIndicator).not.toHaveBeenCalledWith('%52', true);
  });

  it('does not resurrect attention when reset occurs during notification delivery', async () => {
    const focusService = new MockFocusService();
    const notification = createDeferred<boolean>();
    focusService.sendAttentionNotification.mockReturnValue(notification.promise);
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-notifying', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-notifying',
      tmuxPaneId: '%41',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await vi.waitFor(() => expect(focusService.sendAttentionNotification).toHaveBeenCalledOnce());

    emitPaneReset({ paneId: 'pane-notifying' });
    notification.resolve(true);
    await flushAsyncWork();

    expect(focusService.setPaneAttentionIndicator).not.toHaveBeenCalledWith('%41', true);
    expect((service as any).activeAttentionPanes.has('pane-notifying')).toBe(false);
    expect((service as any).notifiedFingerprints.has('pane-notifying')).toBe(false);
    service.stop();
  });

  it('aborts notification socket setup on reset before any write occurs', async () => {
    const focusService = new MockFocusService();
    const setupStarted = createDeferred<void>();
    const releaseSetup = createDeferred<void>();
    const writes: string[] = [];
    let notificationSignal: AbortSignal | undefined;
    focusService.sendAttentionNotification.mockImplementation(async (_request, ownership) => {
      notificationSignal = ownership?.signal;
      setupStarted.resolve();
      await releaseSetup.promise;
      if (!ownership?.signal.aborted) {
        writes.push('notify');
      }
      return !ownership?.signal.aborted;
    });
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-socket-setup', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-socket-setup',
      tmuxPaneId: '%60',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await setupStarted.promise;

    emitPaneReset({ paneId: 'pane-socket-setup' });
    expect(notificationSignal?.aborted).toBe(true);
    releaseSetup.resolve();
    await flushAsyncWork();

    expect(writes).toEqual([]);
    expect(focusService.setPaneAttentionIndicator).not.toHaveBeenCalledWith('%60', true);
    service.stop();
  });

  it.each([
    ['reset', emitPaneReset],
    ['removal', emitPaneRemoved],
    ['disarm', emitPaneUserInteraction],
  ] as const)('aborts active candidate work on pane %s', async (_reason, endLifecycle) => {
    const focusService = new MockFocusService();
    const notification = createDeferred<boolean>();
    let signal: AbortSignal | undefined;
    focusService.sendAttentionNotification.mockImplementation((_request, ownership) => {
      signal = ownership?.signal;
      return notification.promise;
    });
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-cancelled', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-cancelled',
      tmuxPaneId: '%61',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await vi.waitFor(() => expect(focusService.sendAttentionNotification).toHaveBeenCalledOnce());

    endLifecycle({ paneId: 'pane-cancelled' });

    expect(signal?.aborted).toBe(true);
    notification.resolve(false);
    await flushAsyncWork();
    service.stop();
  });

  it('aborts old candidate work when a replacement candidate arrives', async () => {
    const focusService = new MockFocusService();
    const oldNotification = createDeferred<boolean>();
    let oldSignal: AbortSignal | undefined;
    focusService.sendAttentionNotification.mockImplementation((request: any, ownership) => {
      if (request.tmuxPaneId === '%62') {
        oldSignal = ownership?.signal;
        return oldNotification.promise;
      }
      return Promise.resolve(true);
    });
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-replacement-abort', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-replacement-abort',
      tmuxPaneId: '%62',
      status: 'idle',
      title: 'Old',
      body: 'Old.',
      fingerprint: 'idle:old',
    });
    await vi.waitFor(() => expect(focusService.sendAttentionNotification).toHaveBeenCalledOnce());

    emitAttentionNeeded({
      paneId: 'pane-replacement-abort',
      tmuxPaneId: '%63',
      status: 'idle',
      title: 'New',
      body: 'New.',
      fingerprint: 'idle:new',
    });

    expect(oldSignal?.aborted).toBe(true);
    oldNotification.resolve(false);
    await flushAsyncWork();
    service.stop();
  });

  it('aborts all active candidate work when stopped', async () => {
    const focusService = new MockFocusService();
    const notification = createDeferred<boolean>();
    let signal: AbortSignal | undefined;
    focusService.sendAttentionNotification.mockImplementation((_request, ownership) => {
      signal = ownership?.signal;
      return notification.promise;
    });
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-stop-abort', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-stop-abort',
      tmuxPaneId: '%64',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await vi.waitFor(() => expect(focusService.sendAttentionNotification).toHaveBeenCalledOnce());

    service.stop();

    expect(signal?.aborted).toBe(true);
    notification.resolve(false);
    await flushAsyncWork();
  });

  it('does not re-enable attention when reset occurs during a pane flash', async () => {
    const focusService = new MockFocusService();
    const flash = createDeferred<undefined>();
    focusService.getPaneAttentionSurface.mockResolvedValue('same-window');
    focusService.flashPaneAttention.mockReturnValue(flash.promise);
    const service = new PsycheAttentionService({ focusService: focusService as any });

    service.start();
    emitStatusUpdated({ paneId: 'pane-flashing', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-flashing',
      tmuxPaneId: '%42',
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await vi.waitFor(() => expect(focusService.flashPaneAttention).toHaveBeenCalledOnce());

    emitPaneReset({ paneId: 'pane-flashing' });
    flash.resolve(undefined);
    await flushAsyncWork();

    expect(focusService.setPaneAttentionIndicator).not.toHaveBeenCalledWith('%42', true);
    expect((service as any).activeAttentionPanes.has('pane-flashing')).toBe(false);
    expect((service as any).notifiedFingerprints.has('pane-flashing')).toBe(false);
    service.stop();
  });

  it('cancels real flash timers on reset without mutating a replacement lifecycle', async () => {
    vi.useFakeTimers();
    const detector = getStatusDetector();
    const lifecycle = Symbol('old-pane');
    (detector as any).paneIdMap.set('pane-real-flash', '%80');
    (detector as any).paneLifecycles.set('pane-real-flash', lifecycle);
    const focusService = new PsycheFocusService({ projectName: 'test' });
    (focusService as any).active = true;
    vi.spyOn(focusService, 'getPaneAttentionSurface').mockResolvedValue('same-window');
    const tmux = (focusService as any).tmuxService;
    const setOption = vi.spyOn(tmux, 'setPaneOptionSync').mockReturnValue(undefined);
    const unsetOption = vi.spyOn(tmux, 'unsetPaneOptionSync').mockReturnValue(undefined);
    vi.spyOn(tmux, 'getPaneOptionSync').mockReturnValue('bg=colour20');
    vi.spyOn(tmux, 'getGlobalOptionSync').mockReturnValue('bg=colour20');
    const service = new PsycheAttentionService({ focusService });

    service.start();
    emitStatusUpdated({ paneId: 'pane-real-flash', status: 'working' });
    emitAttentionNeeded({
      paneId: 'pane-real-flash',
      tmuxPaneId: '%80',
      lifecycle,
      status: 'idle',
      title: 'Ready',
      body: 'Continue.',
      fingerprint: 'idle:ready',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(setOption).toHaveBeenCalledWith('%80', 'window-style', 'bg=colour21');

    setOption.mockClear();
    unsetOption.mockClear();
    (detector as any).messageBus.handleWorkerMessage('pane-real-flash', {
      type: 'pane-reset',
      payload: { reason: 'Pane was replaced' },
    });
    (detector as any).paneIdMap.set('pane-real-flash', '%80');
    (detector as any).paneLifecycles.set('pane-real-flash', Symbol('replacement'));
    await vi.runAllTimersAsync();

    expect(setOption).not.toHaveBeenCalledWith('%80', 'window-style', expect.anything());
    expect(unsetOption).not.toHaveBeenCalledWith('%80', 'window-style');
    expect((service as any).activeAttentionPanes.has('pane-real-flash')).toBe(false);
    expect((focusService as any).flashingTmuxPaneIds.has('%80')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    service.stop();
  });

  it('does not duplicate or leak lifecycle listeners', () => {
    const detector = getStatusDetector();
    const focusService = new MockFocusService();
    const service = new PsycheAttentionService({ focusService: focusService as any });
    const resetListenersBefore = detector.listenerCount('pane-reset');
    const removedListenersBefore = detector.listenerCount('pane-removed');

    service.start();
    service.start();
    expect(detector.listenerCount('pane-reset')).toBe(resetListenersBefore + 1);
    expect(detector.listenerCount('pane-removed')).toBe(removedListenersBefore + 1);

    service.stop();
    service.stop();
    expect(detector.listenerCount('pane-reset')).toBe(resetListenersBefore);
    expect(detector.listenerCount('pane-removed')).toBe(removedListenersBefore);
  });
});
