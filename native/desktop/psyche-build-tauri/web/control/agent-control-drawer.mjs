const ERROR_LIMIT = 512;

function boundedError(error) {
  const candidate = typeof error?.message === 'string' ? error.message
    : (typeof error === 'string' ? error : 'Operator command failed');
  return candidate.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ERROR_LIMIT)
    || 'Operator command failed';
}

function element(document, tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function focusIdentity(action, payload, resource) {
  return [action, payload.leaseId || payload.approvalId || payload.requestId,
    payload.leaseRevision ?? '', resource?.kind || '', resource?.id || '', resource?.generation ?? ''].join(':');
}

function actionButton(document, label, action, payload, enabled, run, card, resource) {
  const button = element(document, 'button', `agent-control-action is-${action}`, label);
  button.type = 'button';
  button.disabled = !enabled;
  button.dataset.controlFocus = focusIdentity(action, payload, resource);
  button.addEventListener('click', () => run(action, payload, button, card));
  return button;
}

function detailRows(document, item) {
  const fragment = document.createDocumentFragment();
  for (const [name, value] of [['Agent', item.agent], ['Task', item.task], ['Approval', item.approvalId],
    ['Digest', item.payloadDigest], ['Lease', item.leaseId],
    ['Revision', item.revision ?? item.leaseRevision], ['Requested', item.requestedAt],
    ['Lease duration', item.leaseDurationMs === undefined ? undefined : `${item.leaseDurationMs} ms`],
    ['Expires', item.expiresAt]]) {
    if (value === '' || value === undefined || value === null) continue;
    const row = element(document, 'div', 'agent-control-detail');
    row.append(element(document, 'span', 'agent-control-detail-label', name),
      element(document, 'span', '', String(value)));
    fragment.append(row);
  }
  for (const resource of item.resources || (item.resource ? [item.resource] : [])) {
    if (!resource) continue;
    const row = element(document, 'div', 'agent-control-resource');
    row.append(element(document, 'span', 'agent-control-resource-name',
      `${resource.kind} · ${resource.id}${resource.generation === undefined ? '' : ` · generation ${resource.generation}`}`));
    if (resource.capabilities) row.append(element(document, 'span', 'agent-control-capabilities', resource.capabilities.join(' · ')));
    fragment.append(row);
  }
  return fragment;
}

export function createAgentControlDrawer({
  root, dialog = root, closeButton = null, opener = null, getContextToken = () => '', onClose = () => {},
  onGrant, onDeny, onApprove, onRevoke,
}) {
  let model = null;
  let failure = null;
  let focusTargets = new Map();
  const document = root.ownerDocument;

  function render(nextModel = model, focusKey = '') {
    model = nextModel;
    if (!document?.createElement) {
      root.replaceChildren();
      if (focusKey) failure?.trigger?.focus?.();
      return;
    }
    const body = element(document, 'div', 'agent-control-content');
    if (model.fetchError) body.append(element(document, 'div', 'agent-control-error', model.fetchError));
    if (failure) {
      const failed = element(document, 'article', 'agent-control-card is-failed');
      failed.dataset.controlCard = failure.card.id;
      failed.append(element(document, 'div', 'agent-control-error', failure.message));
      failed.append(detailRows(document, failure.card));
      const marker = element(document, 'button', 'agent-control-action', failure.label);
      marker.type = 'button';
      marker.setAttribute('aria-disabled', 'true');
      marker.dataset.controlFocus = failure.focusKey;
      failed.append(marker);
      body.append(failed);
    }
    const sections = [['Requested', model.groups.requested], ['Active', model.groups.active],
      ['Expired', model.groups.expired], ['Revoked', model.groups.revoked]];
    for (const [title, items] of sections) {
      const section = element(document, 'section', 'agent-control-section');
      section.append(element(document, 'h3', '', `${title} · ${items.length}`));
      for (const item of items) {
        const card = element(document, 'article', 'agent-control-card');
        card.dataset.controlCard = item.id;
        card.append(detailRows(document, item));
        const actions = element(document, 'div', 'agent-control-actions');
        if (item.status === 'requested') actions.append(actionButton(document, 'Grant lease', 'grant',
          { ...item.grantCommand }, item.canGrant, run, item));
        if (item.status === 'active') {
          const count = (item.resources || []).length;
          const revoke = actionButton(document, `Revoke lease · all ${count} resources`, 'revoke', {
            leaseId: item.leaseId, leaseRevision: item.revision,
          }, item.canRevoke, run, item);
          revoke.setAttribute('aria-label', `Revoke lease ${item.leaseId} for ${item.agent} ${item.task}; ${count} resources lose authority; expires ${item.expiresAt}`);
          actions.append(revoke);
        }
        if (actions.childNodes.length) card.append(actions);
        section.append(card);
      }
      body.append(section);
    }
    const approvalSection = element(document, 'section', 'agent-control-section');
    approvalSection.append(element(document, 'h3', '', `Approvals · ${model.approvals.length}`));
    for (const approval of model.approvals) {
      const card = element(document, 'article', 'agent-control-card is-approval');
      card.dataset.controlCard = approval.id;
      card.append(detailRows(document, approval));
      card.append(element(document, 'div', 'agent-control-effect',
        `${approval.effect.kind} · ${approval.capability} · ${approval.effect.targetDigest}`));
      const actions = element(document, 'div', 'agent-control-actions');
      const payload = { approvalId: approval.approvalId, payloadDigest: approval.payloadDigest,
        leaseId: approval.leaseId, leaseRevision: approval.leaseRevision };
      actions.append(actionButton(document, 'Approve once', 'approve', payload, approval.canApprove, run, approval, approval.resource));
      actions.append(actionButton(document, 'Deny', 'deny', payload, approval.canDeny, run, approval, approval.resource));
      actions.append(actionButton(document, 'Revoke lease', 'revoke', { leaseId: approval.leaseId,
        leaseRevision: approval.leaseRevision }, approval.canApprove, run, approval, approval.resource));
      card.append(actions);
      approvalSection.append(card);
    }
    body.append(approvalSection);
    const activity = element(document, 'section', 'agent-control-section');
    activity.append(element(document, 'h3', '', `Recent activity · ${model.recentActivity?.length || 0}`));
    for (const receipt of model.recentActivity || []) {
      const generation = receipt.resource.generation === undefined ? '' : ` generation ${receipt.resource.generation}`;
      const label = `${receipt.agent} · ${receipt.task} · ${receipt.action} · ${receipt.outcome} · ${receipt.timestamp} · `
        + `${receipt.resource.kind} ${receipt.resource.id}${generation} · worktree ${receipt.worktreeRoot} · redacted result unavailable`;
      const row = element(document, 'div', 'agent-control-card', label);
      row.setAttribute('aria-label', label);
      activity.append(row);
    }
    body.append(activity);
    root.replaceChildren(body);
    focusTargets = new Map([...root.querySelectorAll('[data-control-focus]')].map((node) => [node.dataset.controlFocus, node]));
    if (focusKey) (focusTargets.get(focusKey) || failure?.trigger)?.focus?.();
  }

  async function run(action, payload, trigger, card) {
    const focusKey = trigger?.dataset?.controlFocus || '';
    const contextToken = getContextToken();
    const callback = { grant: onGrant, deny: onDeny, approve: onApprove, revoke: onRevoke }[action];
    failure = null;
    try {
      await callback(payload);
    } catch (error) {
      if (contextToken !== getContextToken()) return;
      failure = { card: Object.freeze({ ...card }), message: boundedError(error), focusKey, trigger,
        label: trigger?.textContent || 'Failed command' };
      render(model, focusKey);
    }
  }

  function focusables() {
    return [...dialog.querySelectorAll('button:not([disabled])')].filter((node) => node.hidden !== true);
  }
  function open() {
    root.hidden = false;
    const actionable = root.querySelector('button:not([disabled])');
    (actionable || closeButton)?.focus?.();
  }
  function close() { root.hidden = true; opener?.focus?.(); }
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1)
      : (index === items.length - 1 ? 0 : index + 1);
    event.preventDefault(); items[next].focus();
  });
  return Object.freeze({ render, run, open, close, error: () => failure?.message || '' });
}
