import { describe, expect, it } from 'vitest';
import { AGENT_CONTROL_LIMITS } from '../src/control/limits.js';
import { PaneObservationStore } from '../src/control/resources/paneObservation.js';

describe('PaneObservationStore', () => {
  it('returns sequenced incremental pane output', () => {
    const store = new PaneObservationStore();
    store.append('pane-1', Buffer.from('one'));
    store.append('pane-1', Buffer.from('two'));
    store.append('pane-1', Buffer.from('three'));

    expect(store.read('pane-1', { afterSequence: 1 })).toMatchObject({
      paneId: 'pane-1',
      fromSequence: 2,
      nextSequence: 3,
      text: 'twothree',
      bytes: 8,
      truncated: false,
    });
  });

  it('evicts complete chunks at the chunk cap', () => {
    const store = new PaneObservationStore();
    for (let index = 0; index < AGENT_CONTROL_LIMITS.paneOutputChunks + 2; index += 1) {
      store.append('pane-1', Buffer.from('x'));
    }

    const result = store.read('pane-1', { afterSequence: 0 });
    expect(result.fromSequence).toBe(3);
    expect(result.nextSequence).toBe(AGENT_CONTROL_LIMITS.paneOutputChunks + 2);
    expect(result.bytes).toBeLessThanOrEqual(AGENT_CONTROL_LIMITS.paneOutputBytes);
    expect(result.truncated).toBe(true);
  });

  it('evicts complete chunks at the byte cap', () => {
    const store = new PaneObservationStore();
    store.append('pane-1', Buffer.alloc(40 * 1024, 0x61));
    store.append('pane-1', Buffer.alloc(40 * 1024, 0x62));

    const result = store.read('pane-1', { afterSequence: 0 });
    expect(result.fromSequence).toBe(2);
    expect(result.bytes).toBe(40 * 1024);
    expect(result.bytes).toBeLessThanOrEqual(AGENT_CONTROL_LIMITS.paneOutputBytes);
    expect(result.truncated).toBe(true);
  });

  it('decodes UTF-8 only after joining split chunks', () => {
    const store = new PaneObservationStore();
    const encoded = Buffer.from('👩‍💻', 'utf8');
    store.append('pane-1', encoded.subarray(0, 3));
    store.append('pane-1', encoded.subarray(3, 7));
    store.append('pane-1', encoded.subarray(7));

    const result = store.read('pane-1', { afterSequence: 0 });
    expect(result.text).toBe('👩‍💻');
    expect(result.text).not.toContain('\uFFFD');
  });

  it('advances raw chunk sequence while withholding an incomplete code point', () => {
    const store = new PaneObservationStore();
    const encoded = Buffer.from('🧪', 'utf8');
    expect(store.append('pane-1', encoded.subarray(0, 2))).toBe(1);

    expect(store.read('pane-1', { afterSequence: 0 })).toMatchObject({
      nextSequence: 1, text: '', bytes: 0,
    });

    const cursor = store.read('pane-1', { afterSequence: 0 }).nextSequence;
    expect(store.append('pane-1', encoded.subarray(2))).toBe(2);
    expect(store.read('pane-1', { afterSequence: cursor })).toMatchObject({
      fromSequence: 2, nextSequence: 2, text: '🧪', bytes: 4, truncated: false,
    });
  });

  it('does not expose replacement characters when eviction starts inside a code point', () => {
    const store = new PaneObservationStore();
    const encoded = Buffer.from('🧪', 'utf8');
    store.append('pane-1', Buffer.concat([Buffer.alloc(63 * 1024, 0x61), encoded.subarray(0, 2)]));
    store.append('pane-1', Buffer.concat([encoded.subarray(2), Buffer.alloc(2 * 1024, 0x62)]));

    const result = store.read('pane-1');
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('\uFFFD');
    expect(result.text).toBe(`🧪${'b'.repeat(2 * 1024)}`);
  });

  it('keeps pane sequences independent and returns an empty boundary for unknown panes', () => {
    const store = new PaneObservationStore();
    store.append('pane-1', Buffer.from('a'));
    store.append('pane-2', Buffer.from('b'));

    expect(store.read('pane-1')).toMatchObject({ nextSequence: 1, text: 'a' });
    expect(store.read('pane-2')).toMatchObject({ nextSequence: 1, text: 'b' });
    expect(store.read('missing')).toEqual({
      paneId: 'missing', fromSequence: 0, nextSequence: 0, text: '', bytes: 0, truncated: false,
    });
  });
});
