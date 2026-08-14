export async function runFocusedOperatorAction(target, action, onError = () => {}) {
  try {
    return await action();
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
    if (target && typeof target.focus === 'function') target.focus();
    throw error;
  }
}

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(document, label, action, onError) {
  const button = element(document, 'button', 'agent-control-action', label);
  button.type = 'button';
  button.addEventListener('click', () => {
    void runFocusedOperatorAction(button, action, onError).catch(() => {});
  });
  return button;
}

function renderLease(document, lease, callbacks, onError) {
  const card = element(document, 'article', 'agent-control-card');
  card.dataset.leaseId = lease.leaseId;
  card.append(element(document, 'strong', '', `${lease.agentId} · ${lease.taskId}`));
  card.append(element(document, 'div', 'agent-control-meta', `expires ${lease.expiresAt}`));
  for (const resource of lease.resources) {
    card.append(element(
      document,
      'div',
      'agent-control-resource',
      `${resource.kind}:${resource.id}@${resource.generation ?? '-'} · ${resource.capabilities.join(', ')}`,
    ));
  }
  if (lease.canRevoke) {
    card.append(actionButton(document, 'Revoke lease', () => callbacks.onRevoke(lease), onError));
  }
  return card;
}

function renderRequest(document, request, callbacks, onError) {
  const card = element(document, 'article', 'agent-control-card');
  card.dataset.requestId = request.requestId;
  card.append(element(document, 'strong', '', `${request.agentId} · ${request.taskId}`));
  card.append(element(document, 'div', 'agent-control-meta', `requested TTL ${request.ttlMs} ms`));
  for (const resource of request.resources) {
    card.append(element(
      document,
      'div',
      'agent-control-resource',
      `${resource.kind}:${resource.id}@${resource.generation ?? '-'} · ${resource.capabilities.join(', ')}`,
    ));
  }
  if (request.canGrant) {
    card.append(actionButton(document, 'Grant', () => callbacks.onGrant(request), onError));
  }
  return card;
}

function renderApproval(document, approval, callbacks, onError) {
  const card = element(document, 'article', 'agent-control-card agent-control-approval');
  card.dataset.approvalId = approval.approvalId;
  card.append(element(document, 'strong', '', `${approval.effect.kind} · ${approval.capability}`));
  card.append(element(document, 'div', 'agent-control-meta', approval.effect.target));
  if (approval.canDeny) {
    card.append(actionButton(document, 'Deny', () => callbacks.onDeny(approval), onError));
  }
  if (approval.canApprove) {
    card.append(actionButton(document, 'Approve once', () => callbacks.onApprove(approval), onError));
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
  };
  container.replaceChildren();
  const error = element(document, 'div', 'agent-control-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const onError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  container.append(error);

  for (const request of model.groups.requested) {
    container.append(renderRequest(document, request, normalizedCallbacks, onError));
  }
  for (const approval of model.approvals.filter((item) => item.status === 'pending')) {
    container.append(renderApproval(document, approval, normalizedCallbacks, onError));
  }
  for (const lease of model.groups.active) {
    container.append(renderLease(document, lease, normalizedCallbacks, onError));
  }
  return { error };
}
