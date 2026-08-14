import { describe, expect, it } from 'vitest';
import { SurfaceRegistry } from '../src/control/surfaces.js';
import { AGENT_CONTROL_LIMITS } from '../src/control/limits.js';

function assertReadonlySurfaceTypes(registry: SurfaceRegistry): void {
  const pane = registry.get('pane-1');
  if (pane?.kind === 'pane') {
    // @ts-expect-error Surface records expose immutable identity.
    pane.tmuxPaneId = '%99';
  }
  const tab = registry.list().find((surface) => surface.kind === 'browser_tab');
  if (tab?.kind === 'browser_tab') {
    // @ts-expect-error Nested viewport state is immutable.
    tab.viewport.width = 1;
  }
}
void assertReadonlySurfaceTypes;

describe('SurfaceRegistry', () => {
  it('keeps generation for an unchanged native binding', () => {
    const registry = new SurfaceRegistry();
    const first = registry.upsertPane({
      id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo/wt',
      title: 'agent', writable: true, outputSequence: 0,
    });
    const second = registry.upsertPane({ ...first, title: 'renamed' });
    expect(second.generation).toBe(first.generation);
  });

  it('increments generation when the native binding changes', () => {
    const registry = new SurfaceRegistry();
    const first = registry.upsertBrowserTab({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.com',
      title: 'Example', loading: false, viewport: { width: 800, height: 600 },
    });
    const second = registry.upsertBrowserTab({ ...first, webviewLabel: 'browser-b' });
    expect(second.generation).toBe(first.generation + 1);
    expect(() => registry.require('tab-1', first.generation)).toThrowError(
      expect.objectContaining({ code: 'resource_replaced' }),
    );
  });

  it('increments browser generation when the provider changes', () => {
    const registry = new SurfaceRegistry();
    const first = registry.upsertBrowserTab({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.com',
      title: 'Example', loading: false, viewport: { width: 800, height: 600 },
    });
    const second = registry.upsertBrowserTab({ ...first, providerId: 'desktop-2' });
    expect(second.generation).toBe(first.generation + 1);
  });

  it('reports missing resources and removes browser records by provider', () => {
    const registry = new SurfaceRegistry();
    const tab = registry.upsertBrowserTab({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.com',
      title: 'Example', loading: false, viewport: { width: 800, height: 600 },
    });
    registry.upsertPane({
      id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo/wt',
      writable: true, outputSequence: 0,
    });

    expect(registry.removeByProvider('desktop-1')).toEqual([tab]);
    expect(() => registry.require('tab-1', tab.generation)).toThrowError(
      expect.objectContaining({ code: 'resource_missing' }),
    );
    expect(registry.require('pane-1', 1).kind).toBe('pane');
  });

  it('does not reuse a generation after provider removal', () => {
    const registry = new SurfaceRegistry();
    const input = {
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.com',
      title: 'Example', loading: false, viewport: { width: 800, height: 600 },
    };
    const first = registry.upsertBrowserTab(input);
    registry.removeByProvider('desktop-1');
    const replacement = registry.upsertBrowserTab(input);

    expect(replacement.generation).toBe(first.generation + 1);
  });

  it('removes an exited pane and increments generation if its id returns', () => {
    const registry = new SurfaceRegistry();
    const input = {
      id: 'pane-1', tmuxPaneId: '%3', projectRoot: '/repo', worktreeRoot: '/repo',
      writable: true, outputSequence: 0,
    };
    const first = registry.upsertPane(input);

    expect(registry.remove('pane-1')).toBe(first);
    expect(registry.list()).toEqual([]);
    expect(registry.upsertPane({ ...input, tmuxPaneId: '%4' }).generation)
      .toBe(first.generation + 1);
  });

  it('does not retain caller aliases or expose mutable registry records', () => {
    const registry = new SurfaceRegistry();
    const viewport = { width: 800, height: 600 };
    const first = registry.upsertBrowserTab({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      projectRoot: '/repo', worktreeRoot: '/repo', url: 'https://example.com',
      title: 'Example', loading: false, viewport,
    });

    viewport.width = 1;
    try { (first as { providerId: string }).providerId = 'attacker'; } catch { /* frozen */ }
    try { (first.viewport as { width: number }).width = 1; } catch { /* frozen */ }
    const listed = registry.list()[0]!;
    try { (listed as { id: string }).id = 'attacker'; } catch { /* frozen */ }

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.viewport)).toBe(true);
    expect(registry.get('tab-1')).toMatchObject({
      id: 'tab-1', providerId: 'desktop-1', webviewLabel: 'browser-a',
      viewport: { width: 800, height: 600 }, generation: 1,
    });
    expect(registry.require('tab-1', 1)).toBe(first);
    const metadataUpdate = registry.upsertBrowserTab({ ...first, title: 'Renamed' });
    expect(metadataUpdate.generation).toBe(1);
    const removed = registry.removeByProvider('desktop-1');
    expect(Object.isFrozen(removed)).toBe(true);
    expect(Object.isFrozen(removed[0])).toBe(true);
  });

  it('pins all fixed agent-control limits', () => {
    expect(AGENT_CONTROL_LIMITS).toEqual({
      leaseTtlMs: 30 * 60_000,
      leaseRequestGrants: 32,
      leaseRequestCapabilitiesPerGrant: 12,
      leaseRequestTextBytes: 128,
      leaseRequestCapabilityBytes: 64,
      approvalTtlMs: 5 * 60_000,
      paneOutputBytes: 64 * 1024,
      paneOutputChunks: 512,
      semanticNodes: 2_000,
      semanticDepth: 32,
      accessibleNameBytes: 512,
      snapshotTtlMs: 30_000,
      screenshotBytes: 4 * 1024 * 1024,
      scriptSourceBytes: 64 * 1024,
      scriptResultBytes: 256 * 1024,
      actionTimeoutMs: 15_000,
      scriptTimeoutMs: 5_000,
    });
    expect(Object.isFrozen(AGENT_CONTROL_LIMITS)).toBe(true);
  });
});
