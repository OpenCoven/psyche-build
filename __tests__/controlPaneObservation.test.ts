import { describe, expect, it, vi } from 'vitest';
import { AGENT_CONTROL_LIMITS } from '../src/control/limits.js';
import { PaneObservationStore } from '../src/control/resources/paneObservation.js';
import { PaneResourceController, type PaneResourceProjection } from '../src/control/resources/panes.js';
import { SurfaceRegistry } from '../src/control/surfaces.js';
import { EventEmitter } from 'node:events';
import { CapabilityLeaseStore } from '../src/control/capabilityLeases.js';

describe('PaneObservationStore', () => {
  it('returns monotonically sequenced chunks after an exact cursor', () => {
    const store = new PaneObservationStore();
    for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) {
      store.append('pane-1', Buffer.from(text));
    }

    expect(store.read('pane-1', { afterSequence: 4 })).toEqual({
      paneId: 'pane-1', fromSequence: 5, nextSequence: 7,
      text: 'fivesix', bytes: 7, truncated: false,
    });
  });

  it('caps retained output at exactly 512 chunks and marks an evicted cursor truncated', () => {
    const store = new PaneObservationStore();
    for (let i = 0; i < AGENT_CONTROL_LIMITS.paneOutputChunks + 1; i += 1) {
      store.append('pane-1', Buffer.from('x'));
    }

    const read = store.read('pane-1', { afterSequence: 0 });
    expect(read.bytes).toBe(AGENT_CONTROL_LIMITS.paneOutputChunks);
    expect(read.fromSequence).toBe(2);
    expect(read.nextSequence).toBe(514);
    expect(read.truncated).toBe(true);
  });

  it('caps retained output at exactly 64 KiB by evicting oldest bytes', () => {
    const store = new PaneObservationStore();
    store.append('pane-1', Buffer.alloc(AGENT_CONTROL_LIMITS.paneOutputBytes + 17, 0x61));

    const read = store.read('pane-1', { afterSequence: 0 });
    expect(read.bytes).toBe(AGENT_CONTROL_LIMITS.paneOutputBytes);
    expect(Buffer.byteLength(read.text)).toBe(AGENT_CONTROL_LIMITS.paneOutputBytes);
    expect(read.truncated).toBe(true);
  });

  it('preserves UTF-8 characters split across arbitrary chunks', () => {
    const store = new PaneObservationStore();
    const bytes = Buffer.from('A🧪éZ');
    for (const byte of bytes) store.append('pane-1', Buffer.from([byte]));

    const read = store.read('pane-1', { afterSequence: 0 });
    expect(read.text).toBe('A🧪éZ');
    expect(read.text).not.toContain('\ufffd');
  });

  it('does not advance a resumable cursor past an incomplete split character', () => {
    const store = new PaneObservationStore();
    const emoji = Buffer.from('🧪');
    store.append('pane-1', Buffer.from('A'));
    store.append('pane-1', emoji.subarray(0, 1));

    const first = store.read('pane-1', { afterSequence: 0 });
    expect(first).toMatchObject({ text: 'A', fromSequence: 1, nextSequence: 2 });
    store.append('pane-1', emoji.subarray(1, 3));
    const second = store.read('pane-1', { afterSequence: first.nextSequence - 1 });
    expect(second).toMatchObject({ text: '', fromSequence: 2, nextSequence: 2 });
    store.append('pane-1', Buffer.concat([emoji.subarray(3), Buffer.from('Z')]));
    const third = store.read('pane-1', { afterSequence: second.nextSequence - 1 });
    expect(third).toMatchObject({ text: '🧪Z', fromSequence: 2, nextSequence: 5 });
    expect(`${first.text}${second.text}${third.text}`).toBe('A🧪Z');
    expect(third.text).not.toContain('\ufffd');
  });

  it('keeps safe resumable semantics when eviction cuts a split character', () => {
    const store = new PaneObservationStore();
    const emoji = Buffer.from('🧪');
    store.append('pane-1', Buffer.concat([
      Buffer.alloc(AGENT_CONTROL_LIMITS.paneOutputBytes, 0x61), emoji.subarray(0, 2),
    ]));
    store.append('pane-1', Buffer.concat([emoji.subarray(2), Buffer.from('Z')]));
    const read = store.read('pane-1', { afterSequence: 0 });
    expect(read.truncated).toBe(true);
    expect(read.text.endsWith('🧪Z')).toBe(true);
    expect(read.text).not.toContain('\ufffd');
    expect(Number.isSafeInteger(read.nextSequence)).toBe(true);
  });

  it('fails safely without replacement characters when eviction cuts a UTF-8 sequence', () => {
    const store = new PaneObservationStore();
    const prefix = Buffer.alloc(AGENT_CONTROL_LIMITS.paneOutputBytes - 2, 0x61);
    store.append('pane-1', Buffer.concat([Buffer.from('🧪'), prefix]));
    store.append('pane-1', Buffer.from('z'));

    const read = store.read('pane-1', { afterSequence: 0 });
    expect(read.bytes).toBeLessThanOrEqual(AGENT_CONTROL_LIMITS.paneOutputBytes);
    expect(read.text).not.toContain('\ufffd');
    expect(read.text.endsWith('z')).toBe(true);
    expect(read.truncated).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid afterSequence cursor %s',
    (afterSequence) => {
      const store = new PaneObservationStore();
      expect(() => store.read('pane-1', { afterSequence })).toThrowError(
        expect.objectContaining({ code: 'invalid_cursor' }),
      );
    },
  );

  it('fails closed before pane sequences can overflow safe integers', () => {
    const store = new PaneObservationStore({ initialSequence: Number.MAX_SAFE_INTEGER - 1 });
    expect(store.append('pane-1', Buffer.from('last'))).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(store.read('pane-1', { afterSequence: Number.MAX_SAFE_INTEGER - 2 })).toMatchObject({
      fromSequence: Number.MAX_SAFE_INTEGER - 1,
      nextSequence: Number.MAX_SAFE_INTEGER,
    });
    expect(() => store.append('pane-1', Buffer.from('overflow'))).toThrowError(
      expect.objectContaining({ code: 'sequence_exhausted' }),
    );
  });

  it('copies validated constructor options without retaining the caller alias', () => {
    const options = { initialSequence: 7, maxChunks: 2, maxBytes: 3 };
    const store = new PaneObservationStore(options);
    options.initialSequence = 100;
    options.maxChunks = 100;
    options.maxBytes = 100;
    expect(store.append('pane-1', Buffer.from('ab'))).toBe(7);
    store.append('pane-1', Buffer.from('cd'));
    expect(store.read('pane-1', { afterSequence: 0 })).toMatchObject({
      fromSequence: 7, nextSequence: 9, text: 'bcd', bytes: 3, truncated: true,
    });
  });

  it.each([
    { initialSequence: 1.5 },
    { maxChunks: 1.5 },
    { maxBytes: 1.5 },
    { maxChunks: 0 },
    { maxBytes: AGENT_CONTROL_LIMITS.paneOutputBytes + 1 },
  ])('rejects invalid observation options %j', (options) => {
    expect(() => new PaneObservationStore(options)).toThrowError(
      expect.objectContaining({ code: 'invalid_observation_options' }),
    );
  });

  it('returns a stable immutable empty observation for a missing pane', () => {
    const store = new PaneObservationStore();
    const read = store.read('missing', { afterSequence: 4 });
    expect(read).toEqual({
      paneId: 'missing', fromSequence: 5, nextSequence: 5,
      text: '', bytes: 0, truncated: false,
    });
    expect(Object.isFrozen(read)).toBe(true);
  });

  it('copies appended buffers and resets bounded state on replacement or removal', () => {
    const store = new PaneObservationStore();
    const source = Buffer.from('safe');
    store.append('pane-1', source);
    source.fill(0x78);
    expect(store.read('pane-1', { afterSequence: 0 }).text).toBe('safe');

    store.reset('pane-1');
    expect(store.read('pane-1', { afterSequence: 0 }).text).toBe('');
    expect(store.append('pane-1', Buffer.from('new'))).toBe(1);
    store.remove('pane-1');
    expect(store.read('pane-1', { afterSequence: 0 }).text).toBe('');
  });
});

describe('PaneResourceController', () => {
  it('rejects duplicate native bindings without replacing the valid stable resource', () => {
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(), projectRoot: '/repo',
    });
    const first = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/a', writable: true,
    });
    expect(() => controller.upsert({
      id: 'psyche-2', tmuxPaneId: '%3', worktreeRoot: '/repo/b', writable: true,
    })).toThrowError(expect.objectContaining({ code: 'duplicate_tmux_binding' }));
    expect(controller.current(first.id)).toBe(first);
    expect(controller.current('psyche-2')).toBeUndefined();
    expect(controller.appendTmuxOutput('%3', Buffer.from('owned'))).toBe(1);
    expect(controller.observe(first.id, first.generation, 0).text).toBe('owned');
  });

  it('rejects a duplicate configured tmux binding before publishing any ambiguous newcomer', async () => {
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(), projectRoot: '/repo',
      load: async () => [
        { id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/a', writable: true },
        { id: 'psyche-2', tmuxPaneId: '%3', worktreeRoot: '/repo/b', writable: true },
      ],
    });
    await expect(controller.refresh()).rejects.toMatchObject({ code: 'duplicate_tmux_binding' });
    expect(controller.current('psyche-1')).toBeUndefined();
    expect(controller.current('psyche-2')).toBeUndefined();
  });

  it('keeps an existing valid binding when refreshed config tries to reassign its native pane', async () => {
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(), projectRoot: '/repo',
      load: async () => [
        { id: 'psyche-2', tmuxPaneId: '%3', worktreeRoot: '/repo/b', writable: true },
      ],
    });
    const first = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/a', writable: true,
    });

    await expect(controller.refresh()).rejects.toMatchObject({ code: 'duplicate_tmux_binding' });
    expect(controller.current(first.id)).toBe(first);
    expect(controller.current('psyche-2')).toBeUndefined();
  });

  it('resolves output through the current tmux binding and resets on replacement', () => {
    const observations = new PaneObservationStore();
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations, projectRoot: '/repo',
    });
    const first = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/wt', writable: true,
    });
    expect(controller.appendTmuxOutput('%3', Buffer.from('old'))).toBe(1);
    expect(controller.observe(first.id, first.generation, 0).text).toBe('old');

    const replacement = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%9', worktreeRoot: '/repo/wt', writable: true,
    });
    expect(replacement.generation).toBe(first.generation + 1);
    expect(controller.appendTmuxOutput('%3', Buffer.from('stale'))).toBeUndefined();
    expect(controller.observe(replacement.id, replacement.generation, 0).text).toBe('');
    expect(controller.appendTmuxOutput('%9', Buffer.from('new'))).toBe(1);
    expect(controller.observe(replacement.id, replacement.generation, 0).text).toBe('new');
  });

  it('removes stale resources and their retained output', () => {
    const surfaces = new SurfaceRegistry();
    const observations = new PaneObservationStore();
    const controller = new PaneResourceController({ surfaces, observations, projectRoot: '/repo' });
    const pane = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/wt', writable: true,
    });
    controller.appendTmuxOutput('%3', Buffer.from('secret'));

    expect(controller.removeByTmuxPaneId('%3')).toEqual({ id: pane.id, generation: pane.generation });
    expect(surfaces.get(pane.id)).toBeUndefined();
    expect(controller.appendTmuxOutput('%3', Buffer.from('stale'))).toBeUndefined();
    expect(observations.read(pane.id, { afterSequence: 0 }).text).toBe('');
  });

  it('reports the exact removed generation to the authority revocation seam', () => {
    const onRemove = vi.fn();
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(),
      projectRoot: '/repo', onRemove,
    });
    const pane = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/wt', writable: true,
    });
    controller.remove(pane.id, pane.generation);
    expect(onRemove).toHaveBeenCalledWith(pane);
  });

  it('revokes and resets the old generation before publishing a rebound pane', () => {
    const surfaces = new SurfaceRegistry();
    const observations = new PaneObservationStore();
    const lifecycle: string[] = [];
    const capabilityLeases = new CapabilityLeaseStore(
      () => new Date('2026-08-12T12:00:00.000Z'), 7,
    );
    const controller = new PaneResourceController({
      surfaces, observations, projectRoot: '/repo',
      onRemove: (resource) => {
        lifecycle.push(`revoke:${resource.generation}:${observations.sequence(resource.id)}`);
        capabilityLeases.revokeTarget({ kind: 'pane', id: resource.id, generation: resource.generation });
        expect(surfaces.get(resource.id)).toBe(resource);
      },
    });
    const first = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/wt', writable: true,
    });
    controller.appendTmuxOutput('%3', Buffer.from('old'));
    capabilityLeases.grant({
      requestId: 'request-old', actorId: 'agent', taskId: 'task', grantedBy: 'operator', ttlMs: 60_000,
      grants: [{
        target: { kind: 'pane', id: first.id, generation: first.generation },
        capabilities: ['pane.focus'],
      }],
    });
    const rebound = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%9', worktreeRoot: '/repo/wt', writable: true,
    });
    expect(lifecycle).toEqual(['revoke:1:0']);
    expect(capabilityLeases.snapshot()).toEqual([]);
    expect(rebound).toMatchObject({ generation: first.generation + 1, outputSequence: 0 });
    expect(() => controller.resolve(first.id, first.generation)).toThrowError(
      expect.objectContaining({ code: 'resource_replaced' }),
    );
  });

  it('subscribes once to shared tmux output/pane-set changes and cleans up', () => {
    const tmux = new EventEmitter() as EventEmitter & { listPaneIds: () => Promise<readonly string[]> };
    tmux.listPaneIds = vi.fn(async () => []);
    const observations = new PaneObservationStore();
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations, projectRoot: '/repo',
    });
    const pane = controller.upsert({
      id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/wt', writable: true,
    });
    const cleanup = controller.subscribe(tmux);
    expect(tmux.listenerCount('output')).toBe(1);
    expect(tmux.listenerCount('paneSetChanged')).toBe(1);
    tmux.emit('output', '%3', Buffer.from('live'));
    expect(controller.observe(pane.id, pane.generation, 0).text).toBe('live');
    cleanup();
    expect(tmux.listenerCount('output')).toBe(0);
    expect(tmux.listenerCount('paneSetChanged')).toBe(0);
  });

  it('coalesces real pane-set notifications and removes only authoritatively missing panes', async () => {
    vi.useFakeTimers();
    try {
      const tmux = new EventEmitter() as EventEmitter & { listPaneIds: () => Promise<readonly string[]> };
      const listPaneIds = vi.fn(async (): Promise<readonly string[]> => ['%9']);
      tmux.listPaneIds = listPaneIds;
      let projections: readonly PaneResourceProjection[] = [
        { id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/a', writable: true },
        { id: 'psyche-2', tmuxPaneId: '%9', worktreeRoot: '/repo/b', writable: true },
      ];
      const removed: string[] = [];
      const controller = new PaneResourceController({
        surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(), projectRoot: '/repo',
        load: async () => projections,
        onRemove: ({ id }) => removed.push(id),
      });
      controller.upsert(projections[0]);
      const cleanup = controller.subscribe(tmux);
      tmux.emit('paneSetChanged');
      tmux.emit('paneSetChanged');
      tmux.emit('paneSetChanged');
      expect(listPaneIds).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(listPaneIds).toHaveBeenCalledTimes(1);
      expect(controller.current('psyche-1')).toBeUndefined();
      expect(controller.current('psyche-2')).toMatchObject({ tmuxPaneId: '%9' });
      expect(removed).toEqual(['psyche-1']);

      projections = [{ id: 'psyche-2', tmuxPaneId: '%10', worktreeRoot: '/repo/b', writable: true }];
      listPaneIds.mockResolvedValueOnce(['%10']);
      tmux.emit('paneSetChanged');
      await vi.advanceTimersByTimeAsync(20);
      expect(controller.current('psyche-2')).toMatchObject({ tmuxPaneId: '%10', generation: 2 });
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending reconciliation and removes the final pane once on terminal control loss', async () => {
    vi.useFakeTimers();
    try {
      const tmux = new EventEmitter() as EventEmitter & { listPaneIds: () => Promise<readonly string[]> };
      const listPaneIds = vi.fn(async (): Promise<readonly string[]> => ['%3']);
      tmux.listPaneIds = listPaneIds;
      const observations = new PaneObservationStore();
      const removed: string[] = [];
      const controller = new PaneResourceController({
        surfaces: new SurfaceRegistry(), observations, projectRoot: '/repo',
        load: async () => [{
          id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/a', writable: true,
        }],
        onRemove: ({ id }) => removed.push(id),
      });
      const pane = controller.upsert({
        id: 'psyche-1', tmuxPaneId: '%3', worktreeRoot: '/repo/a', writable: true,
      });
      observations.append(pane.id, Buffer.from('secret'));
      const cleanup = controller.subscribe(tmux);
      tmux.emit('paneSetChanged');
      tmux.emit('paneSetEmpty');
      tmux.emit('paneSetEmpty');
      await vi.advanceTimersByTimeAsync(20);
      expect(listPaneIds).not.toHaveBeenCalled();
      expect(controller.current(pane.id)).toBeUndefined();
      expect(observations.read(pane.id, { afterSequence: 0 }).text).toBe('');
      expect(removed).toEqual([pane.id]);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it('generation-fences delayed reconciliation after unsubscribe and source replacement', async () => {
    let resolveOldList!: (ids: readonly string[]) => void;
    const oldTmux = new EventEmitter() as EventEmitter & { listPaneIds: () => Promise<readonly string[]> };
    oldTmux.listPaneIds = vi.fn(() => new Promise<readonly string[]>((resolve) => { resolveOldList = resolve; }));
    const newTmux = new EventEmitter() as EventEmitter & { listPaneIds: () => Promise<readonly string[]> };
    newTmux.listPaneIds = vi.fn(async () => ['%9']);
    let projections: readonly PaneResourceProjection[] = [
      { id: 'psyche-old', tmuxPaneId: '%3', worktreeRoot: '/repo/old', writable: true },
    ];
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(), projectRoot: '/repo',
      load: async () => projections,
    });
    const cleanupOld = controller.subscribe(oldTmux);
    const stale = controller.refresh();
    await vi.waitFor(() => expect(oldTmux.listPaneIds).toHaveBeenCalledTimes(1));
    cleanupOld();
    projections = [{ id: 'psyche-new', tmuxPaneId: '%9', worktreeRoot: '/repo/new', writable: true }];
    const cleanupNew = controller.subscribe(newTmux);
    resolveOldList(['%3']);
    await stale;
    await controller.refresh();
    expect(controller.current('psyche-old')).toBeUndefined();
    expect(controller.current('psyche-new')).toMatchObject({ tmuxPaneId: '%9' });
    cleanupNew();
  });

  it('generation-fences a delayed config load after unsubscribe', async () => {
    let resolveConfig!: (items: readonly PaneResourceProjection[]) => void;
    const tmux = new EventEmitter() as EventEmitter & { listPaneIds: () => Promise<readonly string[]> };
    tmux.listPaneIds = vi.fn(async () => ['%3']);
    const controller = new PaneResourceController({
      surfaces: new SurfaceRegistry(), observations: new PaneObservationStore(), projectRoot: '/repo',
      load: () => new Promise((resolve) => { resolveConfig = resolve; }),
    });
    const cleanup = controller.subscribe(tmux);
    const stale = controller.refresh();
    await vi.waitFor(() => expect(resolveConfig).toBeTypeOf('function'));
    cleanup();
    resolveConfig([{ id: 'stale', tmuxPaneId: '%3', worktreeRoot: '/repo/stale', writable: true }]);
    await stale;
    expect(tmux.listPaneIds).not.toHaveBeenCalled();
    expect(controller.current('stale')).toBeUndefined();
  });
});
