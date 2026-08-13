import { describe, expect, it } from 'vitest';
import { BrowserSemanticSnapshotRegistry } from '../src/control/browserSemanticSnapshots.js';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'psyche.browser.snapshot/v1', id: 'snap-1', tabId: 'tab-1', generation: 1,
    url: 'https://example.test', title: 'Example', loading: false,
    viewport: { width: 800, height: 600 }, capturedAt: '2026-08-12T12:00:00.000Z',
    nodes: [{ ref: 'e1', role: 'button', name: 'Submit', value: { kind: 'text', secret: true } }],
    truncated: false, opaqueFrames: 0, expiresAt: '2026-08-12T12:00:30.000Z',
    ...overrides,
  };
}

describe('BrowserSemanticSnapshotRegistry', () => {
  it('resolves only exact live tab generations and canonical refs', () => {
    const registry = new BrowserSemanticSnapshotRegistry(() => new Date('2026-08-12T12:00:01.000Z'));
    registry.store(snapshot(), 'tab-1', 1);
    expect(registry.resolve({ tabId: 'tab-1', generation: 1, snapshotId: 'snap-1', elementRef: 'e1' }))
      .toMatchObject({ role: 'button', submit: true, secret: true });
    expect(() => registry.resolve({ tabId: 'tab-1', generation: 2, snapshotId: 'snap-1', elementRef: 'e1' }))
      .toThrow(/missing or stale/);
  });

  it('invalidates replacement generations and rejects expired or extra fields', () => {
    const registry = new BrowserSemanticSnapshotRegistry(() => new Date('2026-08-12T12:00:01.000Z'));
    registry.store(snapshot(), 'tab-1', 1);
    registry.store(snapshot({ id: 'snap-2', generation: 2 }), 'tab-1', 2);
    expect(() => registry.resolve({ tabId: 'tab-1', generation: 1, snapshotId: 'snap-1', elementRef: 'e1' })).toThrow();
    expect(() => registry.store(snapshot({ expiresAt: '2026-08-12T12:00:00.000Z' }), 'tab-1', 1)).toThrow(/malformed/);
    expect(() => registry.store(snapshot({ injected: true }), 'tab-1', 1)).toThrow(/malformed/);
  });

  it('keeps only the newest same-generation snapshot and owns deep immutable node data', () => {
    const registry = new BrowserSemanticSnapshotRegistry(() => new Date('2026-08-12T12:00:01.000Z'));
    const mutable = snapshot() as any;
    registry.store(mutable, 'tab-1', 1);
    registry.store(snapshot({ id: 'snap-2' }), 'tab-1', 1);
    expect(() => registry.resolve({ tabId: 'tab-1', generation: 1, snapshotId: 'snap-1', elementRef: 'e1' })).toThrow(/stale/);

    const owned = snapshot({ id: 'snap-owned' }) as any;
    registry.store(owned, 'tab-1', 1);
    owned.nodes[0].role = 'textbox';
    owned.nodes[0].value.secret = false;
    expect(registry.resolve({ tabId: 'tab-1', generation: 1, snapshotId: 'snap-owned', elementRef: 'e1' }))
      .toMatchObject({ role: 'button', secret: true });
    expect(() => registry.store(snapshot({ nodes: [{ ref: 'e1', role: 'button', name: 'x', injected: true }] }), 'tab-1', 1))
      .toThrow(/malformed/);
  });
});
