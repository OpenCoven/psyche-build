import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createAgentControlModel,
  resourceLeaseBadge,
  surfaceResourceIdentity,
} from '../native/desktop/psyche-build-tauri/web/control/agent-control-model.mjs';
import {
  installAgentControlUiLifecycle,
  renderAgentControlDrawer,
  runFocusedOperatorAction,
  trapAgentControlFocus,
} from '../native/desktop/psyche-build-tauri/web/control/agent-control-drawer.mjs';

const NOW = Date.parse('2026-08-13T01:00:00.000Z');

function snapshot(ownerEpoch = 7) {
  return {
    ownerEpoch,
    resources: [
      { kind: 'pane', id: 'pane-1', generation: 3 },
      { kind: 'pane', id: 'pane-2', generation: 5 },
      { kind: 'browser_tab', id: 'tab-1', generation: 4 },
    ],
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

class FakeElement {
  ownerDocument: FakeDocument;
  tagName: string;
  className = '';
  private ownText = '';
  hidden = false;
  disabled = false;
  type = '';
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<(event: any) => void>>();

  constructor(ownerDocument: FakeDocument, tagName = 'div') {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
  }

  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.ownText = String(value); this.children = []; }

  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  appendChild(node: FakeElement) { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeElement[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, init: Record<string, unknown> = {}) {
    const event = { type, target: this, key: '', shiftKey: false, preventDefault: vi.fn(), ...init };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector: string): FakeElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
    if (selector.includes('button')) return descendants.filter((child) => child.tagName === 'BUTTON' && !child.disabled && !child.hidden);
    if (selector === '[data-action-key]') return descendants.filter((child) => Boolean(child.dataset.actionKey));
    const actionKey = selector.match(/^\[data-action-key="(.+)"\]$/)?.[1];
    return actionKey ? descendants.filter((child) => child.dataset.actionKey === actionKey) : [];
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string) { return new FakeElement(this, tag); }
}

function buttonByLabel(root: FakeElement, label: string) {
  return root.querySelectorAll('button').find((button) => button.getAttribute('aria-label') === label);
}

async function flushActions() {
  await Promise.resolve();
  await Promise.resolve();
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

  it('uses the trusted current resource generation when a pane or tab is replaced', () => {
    const model = createAgentControlModel(snapshot(), { now: NOW, operator: true });
    expect(surfaceResourceIdentity(model, 'pane', 'pane-1')).toEqual({
      kind: 'pane', id: 'pane-1', generation: 3,
    });
    expect(resourceLeaseBadge(model, surfaceResourceIdentity(model, 'pane', 'pane-1'))).not.toBeNull();

    const replaced = snapshot();
    replaced.resources = [
      { kind: 'pane', id: 'pane-1', generation: 4 },
      { kind: 'browser_tab', id: 'tab-1', generation: 5 },
    ];
    const replacedModel = createAgentControlModel(replaced, { now: NOW, operator: true });
    expect(resourceLeaseBadge(replacedModel, surfaceResourceIdentity(replacedModel, 'pane', 'pane-1'))).toBeNull();
    expect(resourceLeaseBadge(replacedModel, surfaceResourceIdentity(replacedModel, 'browser_tab', 'tab-1'))).toBeNull();
  });

  it('installs once across restored boot and repeated add-project calls, with explicit cleanup', () => {
    const document = new FakeDocument();
    const toggle = document.createElement('button');
    const overlay = document.createElement('div');
    const close = document.createElement('button');
    overlay.append(close);
    const refresh = vi.fn(() => Promise.resolve());
    const setIntervalFn = vi.fn(() => 41);
    const clearIntervalFn = vi.fn();
    const options = { toggle, overlay, close, refresh, setInterval: setIntervalFn, clearInterval: clearIntervalFn };

    const restoredBoot = installAgentControlUiLifecycle(options);
    const firstAddProject = installAgentControlUiLifecycle(options);
    const secondAddProject = installAgentControlUiLifecycle(options);

    expect(firstAddProject).toBe(restoredBoot);
    expect(secondAddProject).toBe(restoredBoot);
    expect(setIntervalFn).toHaveBeenCalledOnce();
    expect(toggle.listeners.get('click')?.size).toBe(1);
    expect(overlay.listeners.get('keydown')?.size).toBe(1);
    toggle.dispatch('click');
    expect(overlay.hidden).toBe(false);
    const escape = overlay.dispatch('keydown', { key: 'Escape' });
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(overlay.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    restoredBoot!.dispose();
    expect(clearIntervalFn).toHaveBeenCalledWith(41);
    expect(toggle.listeners.get('click')?.size).toBe(0);
    expect(overlay.listeners.get('keydown')?.size).toBe(0);
  });

  it('contains modal Tab and Shift+Tab focus while Escape restoration remains lifecycle-owned', () => {
    const document = new FakeDocument();
    const drawer = document.createElement('div');
    const first = document.createElement('button');
    const middle = document.createElement('button');
    const last = document.createElement('button');
    drawer.append(first, middle, last);

    last.focus();
    const forward = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    expect(trapAgentControlFocus(forward, drawer)).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(forward.preventDefault).toHaveBeenCalledOnce();

    first.focus();
    const backward = { key: 'Tab', shiftKey: true, preventDefault: vi.fn() };
    expect(trapAgentControlFocus(backward, drawer)).toBe(true);
    expect(document.activeElement).toBe(last);

    middle.focus();
    const interior = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() };
    expect(trapAgentControlFocus(interior, drawer)).toBe(false);
    expect(document.activeElement).toBe(middle);
  });

  it('keeps failed command card, error, and logical focus across a polling render', async () => {
    const document = new FakeDocument();
    const content = document.createElement('div');
    const failure = vi.fn(() => Promise.reject(new Error('owner unavailable')));
    const model = createAgentControlModel(snapshot(), { now: NOW, operator: true });

    renderAgentControlDrawer(content, model, { onGrant: failure });
    const grant = buttonByLabel(content, 'Grant request request-pending');
    expect(grant).toBeDefined();
    grant!.dispatch('click');
    await flushActions();
    expect(content.textContent).toContain('owner unavailable');
    expect(document.activeElement).toBe(grant);

    renderAgentControlDrawer(content, model, { onGrant: failure });
    const restoredGrant = buttonByLabel(content, 'Grant request request-pending');
    expect(restoredGrant).toBeDefined();
    expect(document.activeElement).toBe(restoredGrant);
    expect(content.children.some((card) => card.dataset.requestId === 'request-pending')).toBe(true);
    expect(content.textContent).toContain('owner unavailable');

    model.groups.requested = [];
    renderAgentControlDrawer(content, model, { onGrant: failure });
    expect(content.children.some((card) => card.dataset.failedActionKey === 'grant:request-pending')).toBe(true);
    expect(document.activeElement?.dataset.actionKey).toBe('grant:request-pending');
    buttonByLabel(content, 'Dismiss error for Grant request request-pending')!.dispatch('click');
    renderAgentControlDrawer(content, model, { onGrant: failure });
    expect(content.children.some((card) => card.dataset.failedActionKey === 'grant:request-pending')).toBe(false);
  });

  it('renders an immediate exact revoke control for every leased resource', async () => {
    const document = new FakeDocument();
    const content = document.createElement('div');
    const onRevoke = vi.fn(() => Promise.resolve());
    const model = createAgentControlModel(snapshot(), { now: NOW, operator: true });
    model.groups.active[0].resources.push({
      kind: 'browser_tab', id: 'tab-2', generation: 9, capabilities: ['browser.inspect'],
    });
    model.groups.active[0].resources.push({
      kind: 'project', id: 'project-1', capabilities: ['project.observe'],
    });

    renderAgentControlDrawer(content, model, { onRevoke });
    const paneRevoke = buttonByLabel(content, 'Revoke pane pane-1 generation 3');
    const tabRevoke = buttonByLabel(content, 'Revoke browser tab tab-2 generation 9');
    const projectRevoke = buttonByLabel(content, 'Revoke project project-1');
    expect(paneRevoke).toBeDefined();
    expect(tabRevoke).toBeDefined();
    expect(projectRevoke).toBeDefined();
    paneRevoke!.dispatch('click');
    tabRevoke!.dispatch('click');
    projectRevoke!.dispatch('click');
    await flushActions();
    expect(onRevoke).toHaveBeenNthCalledWith(1, {
      leaseId: 'lease-active', revision: 2,
      resource: { kind: 'pane', id: 'pane-1', generation: 3 },
    });
    expect(onRevoke).toHaveBeenNthCalledWith(2, {
      leaseId: 'lease-active', revision: 2,
      resource: { kind: 'browser_tab', id: 'tab-2', generation: 9 },
    });
    expect(onRevoke).toHaveBeenNthCalledWith(3, {
      leaseId: 'lease-active', revision: 2,
      resource: { kind: 'project', id: 'project-1' },
    });
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
    const [html, styles, main, entry] = await Promise.all([
      readFile('native/desktop/psyche-build-tauri/web/index.html', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/styles.css', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/main.js', 'utf8'),
      readFile('native/desktop/psyche-build-tauri/web/control/control-entry.js', 'utf8'),
    ]);

    expect(html).toContain('id="agent-control-toggle"');
    expect(html).toMatch(/id="agent-control-drawer"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
    expect(styles).toContain('.agent-control-badge');
    expect(main).toContain('invoke("control_state"');
    expect(main).toContain('invoke("control_operator_submit"');
    expect(main).toMatch(/async function boot[\s\S]*installAgentControlUi\(\)/);
    expect(main).toContain('surfaceResourceIdentity(agentControlModel, "pane", threadId)');
    expect(main).toContain('surfaceResourceIdentity(agentControlModel, "browser_tab", tabNode.dataset.tabId)');
    expect(main).toContain('dataset.controlGeneration');
    expect(main).not.toMatch(/control_operator_submit[\s\S]{0,300}(spawnBridgePane|TmuxControl|execFileSync)/);
    expect(entry).toContain("from './agent-control-model.mjs'");
    expect(entry).toContain("from './agent-control-drawer.mjs'");
  });
});
