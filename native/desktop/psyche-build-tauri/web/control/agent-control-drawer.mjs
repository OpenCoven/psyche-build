import {
  AGENT_CONTROL_UI_LIMITS,
  boundedAgentControlText,
} from './agent-control-limits.mjs';

export async function runFocusedOperatorAction(target, action, onError = () => {}) {
  try {
    return await action();
  } catch (error) {
    const shouldFocus = onError(error instanceof Error ? error.message : String(error)) !== false;
    if (shouldFocus && target && typeof target.focus === 'function') target.focus();
    throw error;
  }
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const drawerStates = new WeakMap();
const lifecycleByToggle = new WeakMap();

function actionTarget(container, actionKey) {
  return [...container.querySelectorAll('[data-action-key]')]
    .find((node) => node.dataset.actionKey === actionKey) || null;
}

function setCohortDisabled(container, cohortKey, disabled) {
  for (const node of container.querySelectorAll('[data-action-key]')) {
    if (node.dataset.actionCohort === cohortKey) node.disabled = disabled;
  }
}

function actionButton(document, label, actionKey, cohortKey, action, state, error, onStateChange) {
  const button = element(document, 'button', 'agent-control-action', label);
  button.type = 'button';
  button.dataset.actionKey = actionKey;
  button.dataset.actionCohort = cohortKey;
  button.disabled = state.inFlight.has(cohortKey);
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => {
    if (state.inFlight.has(cohortKey)) return;
    const contextToken = state.contextToken;
    state.inFlight.add(cohortKey);
    setCohortDisabled(state.container, cohortKey, true);
    state.focusKey = actionKey;
    void runFocusedOperatorAction(button, action, (message) => {
      if (state.contextToken !== contextToken) return false;
      state.inFlight.delete(cohortKey);
      setCohortDisabled(state.container, cohortKey, false);
      state.failures.set(actionKey, { action, label, message });
      error.textContent = message;
      error.hidden = false;
      return true;
    }).then(() => {
      if (state.contextToken !== contextToken) return undefined;
      state.failures.delete(actionKey);
      state.focusKey = null;
      error.textContent = '';
      error.hidden = true;
      return Promise.resolve().then(() => onStateChange()).catch((refreshError) => {
        if (state.contextToken !== contextToken) return;
        const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
        state.failures.set(actionKey, { action, label, message });
        error.textContent = message;
        error.hidden = false;
      }).finally(() => {
        if (state.contextToken !== contextToken) return;
        state.inFlight.delete(cohortKey);
        setCohortDisabled(state.container, cohortKey, false);
      });
    }).catch(() => {});
  });
  return button;
}

function appendAction(document, parent, label, actionKey, action, state, onStateChange, cohortKey = actionKey) {
  const failure = state.failures.get(actionKey);
  const error = element(document, 'div', 'agent-control-error', failure?.message || '');
  error.setAttribute('role', 'alert');
  error.hidden = !failure;
  parent.append(actionButton(document, label, actionKey, cohortKey, action, state, error, onStateChange));
  parent.append(error);
  if (failure) {
    const dismiss = element(document, 'button', 'agent-control-action', 'Dismiss error');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', `Dismiss error for ${label}`);
    dismiss.addEventListener('click', () => {
      state.failures.delete(actionKey);
      state.focusKey = actionKey;
      error.textContent = '';
      error.hidden = true;
      dismiss.hidden = true;
      const target = actionTarget(parent, actionKey);
      if (target && typeof target.focus === 'function') target.focus();
    });
    parent.append(dismiss);
  }
  return actionKey;
}

function resourceLabel(resource) {
  const kind = resource.kind === 'browser_tab' ? 'browser tab' : boundedText(resource.kind, 32);
  const base = `${kind} ${boundedText(resource.id, 96)}`;
  return Number.isSafeInteger(resource.generation) ? `${base} generation ${resource.generation}` : base;
}

function boundedText(value, limit = AGENT_CONTROL_UI_LIMITS.textBytes) {
  return boundedAgentControlText(value, limit);
}

function capabilityText(capabilities) {
  const visible = capabilities.map((capability) => boundedText(capability, AGENT_CONTROL_UI_LIMITS.capabilityBytes));
  return visible.join(', ');
}

function appendOverflow(document, parent, count, noun) {
  if (count > 0) parent.append(element(document, 'div', 'agent-control-overflow', `+${count} more ${noun}`));
}

function renderRequestedAuthority(document, request, callbacks, state, renderedKeys) {
  const card = element(document, 'article', 'agent-control-card');
  card.dataset.requestId = request.requestId;
  card.append(element(
    document,
    'strong',
    '',
    `${boundedText(request.agentId, 96)} · ${boundedText(request.taskId, 96)}`,
  ));
  const ttlSeconds = Number.isFinite(request.ttlMs)
    ? Math.max(0, Math.ceil(request.ttlMs / 1_000))
    : 0;
  const timing = element(
    document,
    'div',
    'agent-control-meta',
    `Expires ${ttlSeconds}s after grant`,
  );
  timing.setAttribute(
    'aria-label',
    `Requested authority expires ${ttlSeconds} seconds after grant`,
  );
  card.append(timing);
  for (const resource of request.resources) {
    const capabilities = capabilityText(resource.capabilities);
    const row = element(
      document,
      'div',
      'agent-control-resource',
      `${boundedText(resource.kind, 32)}:${boundedText(resource.id, 96)}@${resource.generation ?? '-'} · ${capabilities}`,
    );
    row.setAttribute(
      'aria-label',
      `Requested ${resourceLabel(resource)}; capabilities ${capabilities}`,
    );
    card.append(row);
    appendOverflow(document, row, resource.capabilityOverflow, 'capabilities');
  }
  appendOverflow(document, card, request.resourceOverflow, 'resources');
  if (request.requiresNarrowerRequest) {
    card.append(element(
      document,
      'div',
      'agent-control-error',
      'Request exceeds display limits; submit a narrower request',
    ));
  }
  if (request.canGrant) {
    renderedKeys.add(appendAction(
      document,
      card,
      `Grant request ${boundedText(request.requestId, 96)}`,
      `grant:${request.requestId}`,
      () => callbacks.onGrant(request),
      state,
      callbacks.onStateChange,
    ));
  }
  return card;
}

function renderLease(document, lease, callbacks, state, renderedKeys) {
  const card = element(document, 'article', 'agent-control-card');
  card.dataset.leaseId = lease.leaseId;
  card.append(element(document, 'strong', '', `${lease.agentId} · ${lease.taskId}`));
  card.append(element(document, 'div', 'agent-control-meta', `expires ${lease.expiresAt}`));
  for (const resource of lease.resources) {
    const capabilities = capabilityText(resource.capabilities);
    const row = element(
      document,
      'div',
      'agent-control-resource',
      `${boundedText(resource.kind, 32)}:${boundedText(resource.id)}@${resource.generation ?? '-'} · ${capabilities}`,
    );
    appendOverflow(document, row, resource.capabilityOverflow, 'capabilities');
    if (lease.canRevoke) {
      const target = { kind: resource.kind, id: resource.id };
      if (Number.isSafeInteger(resource.generation)) target.generation = resource.generation;
      const label = `Revoke entire lease for ${resourceLabel(resource)}`;
      const actionKey = `revoke:${lease.leaseId}:${lease.revision}:${resource.kind}:${resource.id}:${resource.generation ?? '-'}`;
      renderedKeys.add(appendAction(
        document,
        row,
        label,
        actionKey,
        () => callbacks.onRevoke({ leaseId: lease.leaseId, revision: lease.revision, resource: target }),
        state,
        callbacks.onStateChange,
        `lease:${lease.leaseId}:${lease.revision}`,
      ));
    }
    card.append(row);
  }
  appendOverflow(document, card, lease.resourceOverflow, 'resources');
  return card;
}

function renderApproval(document, approval, callbacks, state, renderedKeys) {
  const card = element(document, 'article', 'agent-control-card agent-control-approval');
  card.dataset.approvalId = approval.approvalId;
  card.append(element(document, 'strong', '', `${boundedText(approval.agentId)} · ${boundedText(approval.taskId)}`));
  card.append(element(document, 'div', 'agent-control-meta', `${boundedText(approval.effect.kind)} · ${boundedText(approval.capability, AGENT_CONTROL_UI_LIMITS.capabilityBytes)}`));
  card.append(element(document, 'div', 'agent-control-meta', boundedText(approval.effect.target)));
  if (approval.resource) card.append(element(document, 'div', 'agent-control-resource', resourceLabel(approval.resource)));
  card.append(element(document, 'div', 'agent-control-meta', `expires ${boundedText(approval.expiresAt)}`));
  card.append(element(document, 'div', 'agent-control-meta', approval.leaseCurrent ? 'current lease context' : 'stale lease context'));
  const approvalCohort = `approval:${approval.approvalId}`;
  if (approval.canDeny) {
    renderedKeys.add(appendAction(document, card, 'Deny', `deny:${approval.approvalId}`, () => callbacks.onDeny(approval), state, callbacks.onStateChange, approvalCohort));
  }
  if (approval.canApprove) {
    renderedKeys.add(appendAction(document, card, 'Approve once', `approve:${approval.approvalId}`, () => callbacks.onApprove(approval), state, callbacks.onStateChange, approvalCohort));
  }
  if (approval.canRevokeLease && approval.resource) {
    const label = `Revoke entire lease for ${resourceLabel(approval.resource)}`;
    renderedKeys.add(appendAction(document, card, label, `approval-revoke:${approval.approvalId}`, () => callbacks.onRevoke({
      leaseId: approval.leaseId,
      revision: approval.leaseRevision,
      resource: approval.resource,
    }), state, callbacks.onStateChange, `lease:${approval.leaseId}:${approval.leaseRevision}`));
  }
  return card;
}

export function renderAgentControlDrawer(container, model, callbacks = {}) {
  const document = container.ownerDocument;
  const normalizedCallbacks = {
    onGrant: callbacks.onGrant || (() => Promise.resolve()),
    onDeny: callbacks.onDeny || (() => Promise.resolve()),
    onApprove: callbacks.onApprove || (() => Promise.resolve()),
    onRevoke: callbacks.onRevoke || (() => Promise.resolve()),
    onStateChange: callbacks.onStateChange || (() => Promise.resolve()),
  };
  let state = drawerStates.get(container);
  if (!state || state.contextKey !== model.contextKey) {
    if (state) state.contextToken = {};
    state = {
      contextKey: model.contextKey,
      contextToken: {},
      container,
      failures: new Map(),
      inFlight: new Set(),
      focusKey: null,
    };
  }
  drawerStates.set(container, state);
  const focusedKey = container.ownerDocument.activeElement?.dataset?.actionKey || state.focusKey;
  container.replaceChildren();
  const renderedKeys = new Set();

  for (const request of model.groups.requested) {
    container.append(renderRequestedAuthority(
      document,
      request,
      normalizedCallbacks,
      state,
      renderedKeys,
    ));
  }
  for (const approval of model.approvals.filter((item) => item.status === 'pending')) {
    container.append(renderApproval(document, approval, normalizedCallbacks, state, renderedKeys));
  }
  for (const lease of model.groups.active) {
    container.append(renderLease(document, lease, normalizedCallbacks, state, renderedKeys));
  }
  appendOverflow(
    document,
    container,
    model.overflow?.leaseRequests,
    model.overflow?.leaseRequests === 1 ? 'requested lease request' : 'requested lease requests',
  );
  appendOverflow(document, container, model.overflow?.leases, 'leases');
  appendOverflow(document, container, model.overflow?.approvals, 'approvals');
  for (const [actionKey, failure] of state.failures) {
    if (renderedKeys.has(actionKey)) continue;
    const card = element(document, 'article', 'agent-control-card agent-control-failed');
    card.dataset.failedActionKey = actionKey;
    card.append(element(document, 'strong', '', failure.label));
    appendAction(document, card, failure.label, actionKey, failure.action, state, normalizedCallbacks.onStateChange);
    container.append(card);
  }
  if (focusedKey) {
    const focusTarget = actionTarget(container, focusedKey);
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  }
  return { failures: state.failures };
}

export function trapAgentControlFocus(event, drawer) {
  if (!event || event.key !== 'Tab' || !drawer) return false;
  const focusable = [...drawer.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden);
  if (focusable.length === 0) {
    event.preventDefault();
    if (typeof drawer.focus === 'function') drawer.focus();
    return true;
  }
  const active = drawer.ownerDocument.activeElement;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (active === first || !focusable.includes(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !focusable.includes(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function installAgentControlUiLifecycle(options) {
  const { toggle, overlay, close, refresh } = options;
  if (!toggle || !overlay || !close || typeof refresh !== 'function') return null;
  const installed = lifecycleByToggle.get(toggle);
  if (installed) return installed;
  const setIntervalFn = options.setInterval || globalThis.setInterval;
  const clearIntervalFn = options.clearInterval || globalThis.clearInterval;
  const hide = () => {
    overlay.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  };
  const show = () => {
    overlay.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    close.focus();
    try {
      void Promise.resolve(refresh()).catch(() => {});
    } catch (_) {}
  };
  const onClose = () => hide();
  const onOverlayClick = (event) => { if (event.target === overlay) hide(); };
  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      hide();
      return;
    }
    trapAgentControlFocus(event, overlay);
  };
  toggle.addEventListener('click', show);
  close.addEventListener('click', onClose);
  overlay.addEventListener('click', onOverlayClick);
  overlay.addEventListener('keydown', onKeydown);
  void refresh();
  const timer = setIntervalFn(refresh, 2000);
  const lifecycle = {
    dispose() {
      if (lifecycleByToggle.get(toggle) !== lifecycle) return;
      clearIntervalFn(timer);
      toggle.removeEventListener('click', show);
      close.removeEventListener('click', onClose);
      overlay.removeEventListener('click', onOverlayClick);
      overlay.removeEventListener('keydown', onKeydown);
      lifecycleByToggle.delete(toggle);
    },
  };
  lifecycleByToggle.set(toggle, lifecycle);
  return lifecycle;
}
