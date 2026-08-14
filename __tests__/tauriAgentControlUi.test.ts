import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createAgentControlModel,
  resourceLeaseBadge,
} from '../native/desktop/psyche-build-tauri/web/control/agent-control-model.mjs';
import { runFocusedOperatorAction } from '../native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs';

const NOW = Date.parse('2026-08-13T01:00:00.000Z');

function snapshot(ownerEpoch = 7) {
  return {
    ownerEpoch,
    leaseRequests: [
      {
        id: 'request-pending', actorId: 'agent-a', taskId: 'task-pending', status: 'pending',
        createdAt: '2026-08-13T00:55:00.000Z', ttlMs: 60_000,
        grants: [{ target: { kind: 'pane', id: 'pane-2', generation: 5 }, capabilities: ['pane.observe'] }],
      },
      { id: 'request-revoked', actorId: 'agent-r', taskId: 'task-revoked', status: 'revoked', createdAt: '2026-08-13T00:40:00.000Z' },
    ],
    capabilityLeases: [
      {
        id: 'lease-active', requestId: 'request-active', revision: 2, ownerEpoch,
        actorId: 'agent-b', taskId: 'task-active', grantedBy: 'operator',
        createdAt: '2026-08-13T00:50:00.000Z', expiresAt: '2026-08-13T01:10:00.000Z',
        grants: [{
          target: { kind: 'pane', id: 'pane-1', generation: 3 },
          capabilities: ['pane.observe', 'pane.input'],
        }],
      },
      {
        id: 'lease-expired', requestId: 'request-expired', revision: 1, ownerEpoch,
        actorId: 'agent-c', taskId: 'task-expired', grantedBy: 'operator',
        createdAt: '2026-08-13T00:30:00.000Z', expiresAt: '2026-08-13T00:59:00.000Z',
        grants: [{
          target: { kind: 'browser_tab', id: 'tab-1', generation: 4 },
          capabilities: ['browser.inspect'],
        }],
      },
    ],
    approvals: [{
      id: 'approval-1', status: 'pending', actionId: 'action-1', ownerEpoch,
      leaseId: 'lease-active', leaseRevision: 2,
      resource: { kind: 'pane', id: 'pane-1', generation: 3 },
      capability: 'pane.close', effect: { kind: 'close', target: 'pane:pane-1' },
      payloadDigest: 'digest-1', executablePayloadDigest: 'digest-2',
      createdAt: '2026-08-13T00:58:00.000Z', expiresAt: '2026-08-13T01:03:00.000Z',
    }],
  };
}

describe('agent control operator model', () => {
  it('groups request, active, expired, and revoked authority with exact details', () => {
    const model = createAgentControlModel(snapshot(), { now: NOW, operator: true });

    expect(model.groups.requested).toMatchObject([{
      requestId: 'request-pending', agentId: 'agent-a', taskId: 'task-pending', canGrant: true,
      ttlMs: 60_000,
      resources: [{ kind: 'pane', id: 'pane-2', generation: 5, capabilities: ['pane.observe'] }],
    }]);
    expect(model.groups.active).toMatchObject([{
      leaseId: 'lease-active', revision: 2, agentId: 'agent-b', taskId: 'task-active', canRevoke: true,
      resources: [{
        kind: 'pane', id: 'pane-1', generation: 3,
        capabilities: ['pane.observe', 'pane.input'],
      }],
    }]);
    expect(model.groups.expired).toMatchObject([{ leaseId: 'lease-expired', canRevoke: false }]);
    expect(model.groups.revoked).toMatchObject([{
      requestId: 'request-revoked', agentId: 'agent-r', taskId: 'task-revoked', canGrant: false,
    }]);
  });

  it('exposes only redacted approval details and operator actions', () => {
    const operator = createAgentControlModel(snapshot(), { now: NOW, operator: true });
    expect(operator.approvals).toEqual([expect.objectContaining({
      approvalId: 'approval-1', payloadDigest: 'digest-1', effect: {
        kind: 'close', target: 'pane:pane-1',
      }, canApprove: true, canDeny: true,
    })]);
    expect(JSON.stringify(operator)).not.toContain('executablePayloadDigest');

    const agent = createAgentControlModel(snapshot(), { now: NOW, operator: false });
    expect(agent.approvals[0]).toMatchObject({ canApprove: false, canDeny: false });
    expect(agent.groups.active[0]).toMatchObject({ canRevoke: false });
    expect(agent.groups.requested[0]).toMatchObject({ canGrant: false });
  });

  it('binds a resource badge to exact lease identity and drops it on epoch change', () => {
    const model = createAgentControlModel(snapshot(), { now: NOW, operator: true });
    expect(resourceLeaseBadge(model, { kind: 'pane', id: 'pane-1', generation: 3 })).toMatchObject({
      leaseId: 'lease-active', revision: 2, agentId: 'agent-b', taskId: 'task-active',
    });
    expect(resourceLeaseBadge(model, { kind: 'pane', id: 'pane-1', generation: 4 })).toBeNull();

    const restarted = createAgentControlModel(snapshot(8), {
      now: NOW, operator: true, previousOwnerEpoch: 7,
    });
    expect(restarted.badges).toEqual([]);
  });

  it('retains command focus and exposes the failure without removing its card', async () => {
    const focus = vi.fn();
    const onError = vi.fn();
    const failure = new Error('owner unavailable');

    await expect(runFocusedOperatorAction({ focus }, async () => { throw failure; }, onError))
      .rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith('owner unavailable');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('wires a persistent titlebar button, modal drawer, typed operator calls, and resource badges', async () => {
    const [html, styles, main, entry, drawer] = await Promise.all([
      readFile('native/desktop/psyche-build-tauri/web/index.html', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/styles.css', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/main.js', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/control/control-entry.js', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs', 'utf8'),
    ]);

    expect(html).toContain('id="agent-control-toggle"');
    expect(html).toMatch(/id="agent-control-drawer"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
    expect(styles).toContain('.agent-control-badge');
    expect(main).toContain('invoke("control_state"');
    expect(main).toContain('invoke("control_operator_submit"');
    expect(main).not.toMatch(/control_operator_submit[\s\S]{0,300}(spawnBridgePane|TmuxControl|execFileSync)/);
    expect(entry).toContain("from './agent-control-model.mjs'");
    expect(entry).toContain("from './agent-control-drawer.mjs'");
    expect(drawer).toMatch(/requested TTL[\s\S]{0,80}request\.ttlMs|request\.ttlMs[\s\S]{0,80}requested TTL/);
    expect(drawer).toMatch(/request\.resources[\s\S]{0,160}resource|resource[\s\S]{0,160}request\.resources/);
    expect(drawer).toMatch(/resource\.kind[\s\S]{0,80}resource\.id[\s\S]{0,80}resource\.generation/);
    expect(drawer).toMatch(/resource\.capabilities[\s\S]{0,80}\.join\s*\(/);
  });
});
