import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityLeaseStore } from '../src/control/capabilityLeases.js';
import { ControlRuntime, type ControlHandlers } from '../src/control/runtime.js';
import { authorizeCommand } from '../src/control/server.js';
import { SurfaceRegistry } from '../src/control/surfaces.js';
import type { ControlCommand } from '../src/control/types.js';

function handlers(): ControlHandlers {
  const effect = vi.fn(async () => ({}));
  return {
    executeOrchestration: effect, spawnPane: effect, sendPrompt: effect, interruptPane: effect,
    sendInput: effect, openTerminal: effect, resizePane: effect, focusPane: effect,
    killPane: effect, respawnPane: effect, openConflictPane: effect, updatePaneOption: effect,
    updatePaneMeta: effect, launchRitual: effect, launchCovenSession: effect,
    openCovenSession: effect, runCovenDesktopAction: effect, executeCovenCapability: effect,
    observePane: effect, actOnPane: effect, inspectBrowser: effect, actOnBrowser: effect,
    runBrowserScript: effect,
  };
}

function command(overrides: Partial<ControlCommand>): ControlCommand {
  return {
    id: 'security-command', idempotencyKey: 'security-command', kind: 'browser.action',
    projectRoot: '/repo', actor: { id: 'agent-1', kind: 'psyche' }, ownerEpoch: 7,
    createdAt: '2026-08-12T00:00:00.000Z', payload: {} as never, ...overrides,
  } as ControlCommand;
}

function journal() {
  const events: Array<{ sequence: number; kind: string; payload: Record<string, unknown> }> = [];
  return {
    append: vi.fn(async (kind: string, payload: Record<string, unknown>) => {
      const event = { sequence: events.length + 1, kind, payload }; events.push(event); return event;
    }),
    read: () => events,
    findByIdempotencyKey: () => undefined,
    recoverNonterminalCommands: vi.fn(async () => []),
  };
}

describe('agent surface control adversarial boundaries', () => {
  it.each(['lease.grant', 'lease.revoke', 'approval.resolve', 'provider.resource.upsert'] as const)(
    'rejects agent self-administration through %s before runtime dispatch', (kind) => {
      expect(authorizeCommand({ id: 'agent-1', kind: 'agent', capabilities: ['read', 'mutate'] }, kind))
        .toMatchObject({ status: 'rejected', code: 'operator_required' });
    },
  );

  it('rejects cross-project, replacement-generation, undelegated, and selector injection before effects', async () => {
    const effects = handlers();
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'tab-1', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'desktop', webviewLabel: 'tab', url: 'https://example.test', title: 'Example',
      loading: false, viewport: { width: 800, height: 600 } });
    const leases = new CapabilityLeaseStore(() => new Date('2026-08-12T00:00:00.000Z'), 7);
    const lease = leases.grant({ requestId: 'request', actorId: 'agent-1', taskId: 'task-1',
      grantedBy: 'operator', ttlMs: 60_000, grants: [{ target: { kind: 'browser_tab', id: tab.id,
        generation: tab.generation }, capabilities: ['browser.history', 'browser.interact'] }] });
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers: effects, journal: journal(),
      surfaces, capabilityLeases: leases });
    const payload = { taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
      tabId: tab.id, generation: tab.generation, action: { kind: 'reload' as const } };
    const attacks = [
      command({ id: 'other-project', idempotencyKey: 'other-project', projectRoot: '/other', payload }),
      command({ id: 'replacement', idempotencyKey: 'replacement', payload: { ...payload, generation: 99 } }),
      command({ id: 'undelegated', idempotencyKey: 'undelegated', payload: { ...payload, tabId: 'tab-2' } }),
      command({ id: 'selector', idempotencyKey: 'selector', payload: { ...payload,
        action: { kind: 'click', elementRef: 'e1', selector: '#password' } as never } }),
      command({ id: 'coordinates', idempotencyKey: 'coordinates', payload: { ...payload,
        action: { kind: 'click', elementRef: 'e1', x: 1, y: 2 } as never } }),
      command({ id: 'xpath', idempotencyKey: 'xpath', payload: { ...payload,
        action: { kind: 'click', elementRef: 'e1', xpath: '//button' } as never } }),
    ];
    for (const attack of attacks) {
      await expect(runtime.submit(attack)).resolves.toMatchObject({
        status: 'failed', code: 'action_validation_failed',
      });
    }
    expect(effects.actOnBrowser).not.toHaveBeenCalled();
  });

  it('contains no whole-desktop or coordinate fallback in the provider authority path', () => {
    const paths = [
      '../src/control/browserProviderBroker.ts',
      '../native/desktop/psyche-build-tauri/src-tauri/src/control_provider.rs',
      '../native/desktop/psyche-build-tauri/web/control/browser-automation.mjs',
    ];
    const source = paths.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
    expect(source).not.toMatch(/AXUIElement|CGEvent|cliclick|coordinate capture|desktop capture/i);
  });
});
