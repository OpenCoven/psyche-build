import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityLeaseStore } from '../src/control/capabilityLeases.js';
import { ControlJournal } from '../src/control/journal.js';
import { createCanonicalElementSemantics } from '../src/control/policy.js';
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
  it.each([
    ['self-grant', 'lease.grant'],
    ['lease widening', 'lease.grant'],
    ['lease renewal', 'lease.grant'],
    ['lease revocation', 'lease.revoke'],
    ['self-approval', 'approval.resolve'],
    ['provider impersonation', 'provider.resource.upsert'],
  ] as const)(
    'rejects agent %s before runtime dispatch', (_attempt, kind) => {
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
      command({ id: 'html', idempotencyKey: 'html', payload: { ...payload,
        action: { kind: 'click', elementRef: 'e1', html: '<button>steal</button>' } as never } }),
      command({ id: 'raw-tmux', idempotencyKey: 'raw-tmux', payload: { ...payload,
        action: { kind: 'reload', rawTmuxCommand: 'send-keys -t %1 C-c' } as never } }),
      command({ id: 'accessibility', idempotencyKey: 'accessibility', payload: { ...payload,
        action: { kind: 'click', elementRef: 'e1', accessibilityNode: 'AXButton' } as never } }),
      command({ id: 'other-provider', idempotencyKey: 'other-provider', payload: { ...payload,
        providerId: 'attacker-provider' } as never }),
      command({ id: 'newline-pane', idempotencyKey: 'newline-pane', kind: 'pane.action', payload: {
        taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        paneId: '%1\nrun-shell attacker', generation: 1, action: { kind: 'focus' },
      } as never }),
    ];
    for (const attack of attacks) {
      await expect(runtime.submit(attack)).resolves.toMatchObject({
        status: 'failed', code: 'action_validation_failed',
      });
    }
    expect(effects.actOnBrowser).not.toHaveBeenCalled();
    expect(effects.actOnPane).not.toHaveBeenCalled();
  });

  it.each([
    ['typed text',
      { kind: 'type', elementRef: 'target', text: 'alpha' },
      { kind: 'type', elementRef: 'target', text: 'beta' },
      { role: 'textbox', secret: true }],
    ['upload path',
      { kind: 'upload', elementRef: 'target', path: '/first/evidence.txt' },
      { kind: 'upload', elementRef: 'target', path: '/second/evidence.txt' },
      { role: 'button' }],
    ['permission',
      { kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'allow' },
      { kind: 'permission_response', permission: 'camera', origin: 'https://example.test', decision: 'deny' },
      {}],
    ['target',
      { kind: 'submit', elementRef: 'create-issue' },
      { kind: 'submit', elementRef: 'merge-pr' },
      { role: 'button', submit: true }],
  ] as const)('rejects approval reuse with changed %s before an effect', async (
    label, originalAction, changedAction, semantics,
  ) => {
    const effects = handlers();
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: `tab-${label}`, projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'desktop', webviewLabel: `tab-${label}`, url: 'https://example.test', title: 'Example',
      loading: false, viewport: { width: 800, height: 600 } });
    const leases = new CapabilityLeaseStore(() => new Date('2026-08-12T00:00:00.000Z'), 7);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers: effects, journal: journal(),
      surfaces, capabilityLeases: leases,
      resolveBrowserElementSemantics: () => createCanonicalElementSemantics(semantics) });
    const lease = leases.grant({ requestId: `request-${label}`, actorId: 'agent-1', taskId: 'task-1',
      grantedBy: 'operator', ttlMs: 60_000, grants: [{ target: { kind: 'browser_tab', id: tab.id,
        generation: tab.generation }, capabilities: ['browser.interact'] }] });
    const base = command({ id: `approval-${label}`, idempotencyKey: `approval-${label}-first`,
      payload: { taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: tab.id, generation: tab.generation,
        ...('elementRef' in originalAction ? { snapshotId: 'snapshot-1' } : {}), action: originalAction } as never });
    await expect(runtime.submit(base)).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'approval_required' },
    });
    await expect(runtime.submit(command({ ...base, idempotencyKey: `approval-${label}-changed`, payload: {
      ...(base.payload as object), action: changedAction,
    } as never }))).resolves.toMatchObject({ status: 'failed', code: 'approval_action_conflict' });
    expect(effects.actOnBrowser).not.toHaveBeenCalled();
  });

  it('rejects approval reuse with changed script source before an effect', async () => {
    const effects = handlers();
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'script-tab', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'desktop', webviewLabel: 'script-tab', url: 'https://example.test', title: 'Example',
      loading: false, viewport: { width: 800, height: 600 } });
    const leases = new CapabilityLeaseStore(() => new Date('2026-08-12T00:00:00.000Z'), 7);
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers: effects, journal: journal(),
      surfaces, capabilityLeases: leases });
    const lease = leases.grant({ requestId: 'script-request', actorId: 'agent-1', taskId: 'task-1',
      grantedBy: 'operator', ttlMs: 60_000, grants: [{ target: { kind: 'browser_tab', id: tab.id,
        generation: tab.generation }, capabilities: ['browser.script'] }] });
    const base = command({ id: 'script-approval', idempotencyKey: 'script-first', kind: 'browser.script',
      payload: { taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: tab.id, generation: tab.generation, source: 'return alpha' } as never });
    await expect(runtime.submit(base)).resolves.toMatchObject({
      status: 'succeeded', value: { state: 'approval_required' },
    });
    await expect(runtime.submit(command({ ...base, idempotencyKey: 'script-changed',
      payload: { ...base.payload, source: 'return beta' } as never })))
      .resolves.toMatchObject({ status: 'failed', code: 'approval_action_conflict' });
    expect(effects.runBrowserScript).not.toHaveBeenCalled();
  });

  it('does not expose effect secrets through state, events, errors, or receipts', async () => {
    const effects = handlers();
    effects.actOnBrowser = vi.fn(async () => {
      throw Object.assign(new Error('password page script output cookie Authorization: secret'), {
        code: 'backend_unavailable',
      });
    });
    const surfaces = new SurfaceRegistry();
    const tab = surfaces.upsertBrowserTab({ id: 'redaction-tab', projectRoot: '/repo', worktreeRoot: '/repo',
      providerId: 'desktop', webviewLabel: 'redaction-tab', url: 'https://example.test', title: 'Example',
      loading: false, viewport: { width: 800, height: 600 } });
    const leases = new CapabilityLeaseStore(() => new Date('2026-08-12T00:00:00.000Z'), 7);
    const eventJournal = journal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers: effects, journal: eventJournal,
      surfaces, capabilityLeases: leases });
    const lease = leases.grant({ requestId: 'redaction-request', actorId: 'agent-1', taskId: 'task-1',
      grantedBy: 'operator', ttlMs: 60_000, grants: [{ target: { kind: 'browser_tab', id: tab.id,
        generation: tab.generation }, capabilities: ['browser.history'] }] });
    const outcome = await runtime.submit(command({ id: 'redaction-error', idempotencyKey: 'redaction-error',
      payload: { taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
        tabId: tab.id, generation: tab.generation, action: { kind: 'reload' } } as never }));
    expect(outcome).toMatchObject({ status: 'failed', code: 'backend_unavailable' });
    const recoverySurfaces = JSON.stringify({ state: runtime.snapshot(), events: eventJournal.read(), error: outcome,
      receipts: runtime.snapshot().receipts });
    expect(recoverySurfaces).not.toMatch(/password|page script|cookie|Authorization|secret/);
  });

  it('does not persist an absolute project path for a failed pane-create action', async () => {
    const effects = handlers();
    const eventJournal = journal();
    const runtime = await ControlRuntime.create({ ownerEpoch: 7, handlers: effects, journal: eventJournal });
    const absoluteProject = '/Users/val/Projects/customer-secret-repo';
    await expect(runtime.submit(command({
      id: 'path-redaction', idempotencyKey: 'path-redaction', kind: 'pane.action',
      projectRoot: absoluteProject, payload: {
        taskId: 'task-1', leaseId: 'missing-lease', leaseRevision: 1,
        projectId: absoluteProject, action: { kind: 'create', cwd: absoluteProject },
      } as never,
    }))).resolves.toMatchObject({ status: 'failed', code: 'action_validation_failed' });
    const durable = JSON.stringify(eventJournal.read());
    expect(durable).not.toContain(absoluteProject);
    expect(durable).not.toContain('/Users/val');
    expect(durable).toContain('idDigest');
    expect(effects.actOnPane).not.toHaveBeenCalled();
  });

  it('recovers a joint persisted restart without authority, resources, or effect replay', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-agent-restart-'));
    try {
      const firstJournal = await ControlJournal.open(root, 7);
      await firstJournal.append('lease.granted', { leaseId: 'lease-active', actorId: 'agent-1', taskId: 'task-1' });
      await firstJournal.append('approval.requested', {
        commandId: 'approval-pending', approvalId: 'approval-1', payloadDigest: 'a'.repeat(64),
      });
      await firstJournal.append('command.requested', {
        commandId: 'browser-dispatched', idempotencyKey: 'completed-old-key',
      });
      await firstJournal.append('command.succeeded', {
        commandId: 'browser-dispatched', idempotencyKey: 'completed-old-key', status: 'succeeded',
      });
      await firstJournal.append('command.requested', {
        commandId: 'browser-dispatched', idempotencyKey: 'browser-dispatched', kind: 'browser.action', ownerEpoch: 7,
      });
      await firstJournal.append('command.running', {
        commandId: 'browser-dispatched', idempotencyKey: 'browser-dispatched',
      });

      const replayedEffect = vi.fn(async () => ({}));
      const restartedHandlers = handlers();
      restartedHandlers.actOnBrowser = replayedEffect;
      const reopened = await ControlJournal.open(root, 8);
      const restarted = await ControlRuntime.create({ ownerEpoch: 8, handlers: restartedHandlers, journal: reopened });
      expect(restarted.snapshot()).toMatchObject({
        ownerEpoch: 8, capabilityLeases: [], approvals: [], resources: [],
      });
      expect(reopened.read(0)).toContainEqual(expect.objectContaining({
        kind: 'command.unknown', ownerEpoch: 8,
        payload: expect.objectContaining({ commandId: 'browser-dispatched', idempotencyKey: 'browser-dispatched' }),
      }));
      await expect(restarted.submit(command({ id: 'browser-after-restart',
        idempotencyKey: 'browser-dispatched', ownerEpoch: 8 })))
        .resolves.toMatchObject({ status: 'unknown' });
      expect(replayedEffect).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays a completed durable receipt without inventing an invalid public receipt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'psyche-agent-completed-retry-'));
    try {
      const absoluteProject = '/Users/val/Projects/customer-private-repo';
      const firstJournal = await ControlJournal.open(root, 7);
      const firstHandlers = handlers();
      const first = await ControlRuntime.create({ ownerEpoch: 7, handlers: firstHandlers, journal: firstJournal });
      const lease = first.capabilityLeases.grant({
        requestId: 'completed-request', actorId: 'agent-1', taskId: 'task-1', grantedBy: 'operator',
        ttlMs: 60_000, grants: [{ target: { kind: 'project', id: absoluteProject },
          capabilities: ['pane.create'] }],
      });
      const completed = command({
        id: 'completed-create', idempotencyKey: 'completed-create', kind: 'pane.action',
        projectRoot: absoluteProject, payload: {
          taskId: 'task-1', leaseId: lease.id, leaseRevision: lease.revision,
          projectId: absoluteProject, action: { kind: 'create', cwd: absoluteProject },
        } as never,
      });
      await expect(first.submit(completed)).resolves.toMatchObject({
        status: 'succeeded', value: { schema: 'psyche.control.receipt/v1', resource: { id: absoluteProject } },
      });
      expect(firstHandlers.actOnPane).toHaveBeenCalledOnce();
      expect(JSON.stringify(firstJournal.read(0))).not.toContain(absoluteProject);

      const replayHandler = vi.fn(async () => ({}));
      const restartedHandlers = handlers();
      restartedHandlers.actOnPane = replayHandler;
      const reopened = await ControlJournal.open(root, 8);
      const restarted = await ControlRuntime.create({ ownerEpoch: 8, handlers: restartedHandlers, journal: reopened });
      const retry = await restarted.submit(command({ ...completed, id: 'completed-retry', ownerEpoch: 8 }));
      expect(retry).toEqual({ status: 'succeeded' });
      expect(retry).not.toHaveProperty('value');
      expect(replayHandler).not.toHaveBeenCalled();
      expect(JSON.stringify({ retry, events: reopened.read(0) })).not.toContain(absoluteProject);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
