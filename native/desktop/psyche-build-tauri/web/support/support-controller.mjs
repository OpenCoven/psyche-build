function createModalFocusScope({ dialog, getActiveElement, getTargets, getPreferred, onEscape }) {
  const owner = dialog.ownerDocument || dialog;
  const activation = owner.defaultView;
  const keyTarget = activation || owner;
  let background = null;
  function targets() { return getTargets().filter(canFocus); }
  function inside() {
    const active = getActiveElement();
    return targets().includes(active) || Boolean(active && dialog.contains?.(active));
  }
  function recover() {
    if (!dialog.hidden && !inside()) {
      const preferred = getPreferred();
      const target = canFocus(preferred) ? preferred : targets()[0];
      target?.focus();
    }
  }
  function keydown(event) {
    if (dialog.hidden) return;
    // Window capture runs before the cockpit's document shortcuts, including
    // when a native activation or backdrop interaction left focus on the body.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { event.preventDefault(); onEscape(); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = targets(), index = buttons.indexOf(getActiveElement());
      const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (!inside()) {
      event.preventDefault(); recover();
    }
  }
  function release() {
    const previous = background; background = null;
    for (const [element, inert] of previous || []) element.inert = inert;
  }
  keyTarget.addEventListener('keydown', keydown, true);
  owner.addEventListener('focusin', recover, true);
  activation?.addEventListener('focus', recover);
  return {
    activate() {
      if (!background) {
        background = Array.from(dialog.parentElement?.children || [])
          .filter(element => element !== dialog).map(element => [element, element.inert]);
        for (const [element] of background) element.inert = true;
      }
      recover();
    },
    release,
    dispose() {
      release();
      keyTarget.removeEventListener('keydown', keydown, true);
      owner.removeEventListener('focusin', recover, true);
      activation?.removeEventListener('focus', recover);
    },
  };
}

export function createHelpModalController({ dialog, trigger, action, close, getActiveElement, onVisibilityChange = () => {} }) {
  let previousFocus = null;
  const scope = createModalFocusScope({ dialog, getActiveElement, getTargets: () => [action, close],
    getPreferred: () => action.disabled ? close : action, onEscape: () => setOpen(false) });
  function setOpen(open) {
    const wasOpen = !dialog.hidden;
    if (open && !wasOpen) previousFocus = getActiveElement();
    dialog.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) { scope.activate(); (action.disabled ? close : action).focus(); }
    else {
      scope.release();
      if (!wasOpen) { onVisibilityChange(); return; }
      const target = canFocus(previousFocus) ? previousFocus : trigger;
      if (canFocus(target)) target.focus();
    }
    onVisibilityChange();
  }
  const closeHelp = () => setOpen(false);
  close.addEventListener('click', closeHelp);
  return { setOpen, dispose() { setOpen(false); scope.dispose(); close.removeEventListener('click', closeHelp); } };
}

function canFocus(element) {
  return element && !element.disabled && !element.inert && element.isConnected !== false && typeof element.focus === 'function'
    && (typeof element.getClientRects !== 'function' || element.getClientRects().length > 0);
}

const LABELS = { provenance: 'Provenance', persistence: 'Project recovery', providers: 'Providers', lifecycle: 'Lifecycle',
  updater: 'Updater', graphics: 'Graphics', receipts: 'Receipts', terminal: 'Terminal content' };
const REASONS = { unverified: 'unverified snapshot', project_recovery_only: 'project recovery metadata only',
  filesystem_only: 'executable presence only; nothing launched', counts_only: 'pane count only',
  native_snapshot: 'native updater snapshot', engine_only: 'WebView engine only; acceleration unknown',
  owner_unavailable: 'owning runtime projection unavailable', content_excluded: 'raw content is never collected',
  collection_failed: 'collection failed; see the bounded error category', truncated: 'omitted to preserve payload bounds' };
function failure(code) {
  if (String(code).includes('node_unavailable')) return 'Node.js is unavailable. Install the supported Node.js prerequisite and reopen the app, then try again.';
  if (String(code).includes('write_failed')) return 'Could not save the bundle. Check project storage, free space and permissions, then try again.';
  if (String(code).includes('project_unavailable')) return 'Open the project in Psyche Build before creating its support bundle.';
  return 'Support export could not finish. Check the project and runtime prerequisites, then try again. No private error details were copied.';
}

export function createSupportBundleController({ elements: e, invoke, getProject, getActiveElement = () => null, onVisibilityChange = () => {} }) {
  let busy = false, disposed = false, job = null, previousFocus = null, timer = null, cancelRequested = false;
  let generation = 0;
  const preferred = () => busy ? (cancelRequested ? e.close : e.cancel) : e.create;
  const scope = createModalFocusScope({ dialog: e.dialog, getActiveElement,
    getTargets: () => [e.create, e.cancel, e.reveal, e.close], getPreferred: preferred, onEscape: close });
  e.cancel.disabled = true; e.reveal.disabled = true;
  function controls() {
    e.create.disabled = busy; e.cancel.disabled = !busy || cancelRequested;
    const active = getActiveElement();
    if (!e.dialog.hidden && active?.disabled && [e.create, e.cancel, e.reveal].includes(active)) e.close.focus();
  }
  function show(view) {
    if (disposed) return;
    job = view;
    if (view.state === 'collecting' || view.state === 'cancelling') {
      busy = true;
      e.status.textContent = cancelRequested || view.state === 'cancelling' ? 'Cancelling support export…' : 'Collecting a local support bundle…';
      controls(); return;
    }
    busy = false; controls();
    const result = view.result || view;
    e.reveal.disabled = result.state !== 'saved';
    if (result.state === 'saved') {
      e.status.textContent = 'Saved a local support bundle. Nothing was uploaded.';
      const categories = Array.isArray(result.categories) ? result.categories : [];
      const lines = categories.filter(c => Object.hasOwn(LABELS, c.category)).map(c =>
        `${LABELS[c.category]}: ${c.disposition === 'collected' ? 'collected' : 'omitted'} (${REASONS[c.reason] || 'unavailable'}).`);
      e.summary.textContent = [String(result.fileName || 'Support bundle'), `${result.bytes || 0} bytes; status: ${result.bundleStatus || 'partial'} (unverified).`,
        `${result.redactedFields || 0} redacted fields; ${result.omittedFields || 0} omitted fields.`,
        result.truncated ? 'Some data was truncated to preserve bounds.' : 'No payload truncation reported.',
        result.retentionFailures ? 'Some old bundles could not be pruned; the new bundle is saved.' : 'Only the newest ten owned bundles are retained.', ...lines].join('\n');
    } else if (result.state === 'cancelled') {
      e.status.textContent = 'Cancelled before saving a bundle.';
    } else if (result.state === 'recovery_required') {
      e.status.textContent = 'Export needs recovery: no verified saved-file result was received. Check project storage before retrying; a file may already have been written.';
    } else e.status.textContent = failure(result.code);
  }
  async function poll(run, id) {
    if (disposed || !busy || generation !== run || job?.id !== id) return;
    try {
      const view = await invoke('support_bundle_status', { id });
      if (disposed || generation !== run || job?.id !== id) return;
      show(view.id === id ? view : { state: 'recovery_required' });
      if (busy) timer = setTimeout(() => poll(run, id), 100);
    } catch {
      if (!disposed && generation === run && job?.id === id) show({ state: 'recovery_required' });
    }
  }
  async function cancel() {
    if (!busy || cancelRequested) return;
    cancelRequested = true; controls(); e.status.textContent = 'Cancelling support export…';
    if (job) {
      const run = generation, id = job.id;
      try {
        const view = await invoke('support_bundle_cancel', { id });
        if (!disposed && generation === run && job?.id === id) show(view.id === id ? view : { state: 'recovery_required' });
      } catch { if (!disposed && generation === run && job?.id === id) show({ state: 'recovery_required' }); }
    }
  }
  async function create() {
    if (busy || disposed) return;
    const project = getProject();
    if (!project) { e.status.textContent = failure('project_unavailable'); return; }
    clearTimeout(timer);
    const run = ++generation;
    busy = true; cancelRequested = false; job = null;
    e.summary.textContent = ''; e.reveal.disabled = true;
    controls(); e.status.textContent = 'Collecting a local support bundle…'; e.cancel.focus();
    try {
      const started = await invoke('support_bundle_start', { root: project.root, panes: project.panes });
      if (disposed || generation !== run) return;
      show(started);
      if (busy && cancelRequested) {
        const id = job.id;
        const view = await invoke('support_bundle_cancel', { id });
        if (disposed || generation !== run || job?.id !== id) return;
        show(view.id === id ? view : { state: 'recovery_required' });
      }
      if (busy) { const id = job.id; timer = setTimeout(() => poll(run, id), 100); }
    } catch (error) {
      if (disposed || generation !== run) return;
      busy = false; controls(); e.status.textContent = failure(error);
      e.create.focus();
    }
  }
  async function reveal() {
    if (e.reveal.disabled || !job) return;
    const run = generation, id = job.id;
    try { await invoke('support_bundle_reveal', { id }); }
    catch { if (!disposed && generation === run && job?.id === id) e.status.textContent = 'Could not reveal this bundle. Reopen its project and check that the saved file is still present.'; }
  }
  function close() {
    const wasOpen = !e.dialog.hidden;
    e.dialog.hidden = true; scope.release();
    if (wasOpen && canFocus(previousFocus)) previousFocus.focus();
    onVisibilityChange();
  }
  const listeners = [[e.create, 'click', create], [e.cancel, 'click', cancel], [e.reveal, 'click', reveal], [e.close, 'click', close]];
  for (const [element, name, handler] of listeners) element.addEventListener(name, handler);
  return {
    open(returnFocus) { if (disposed) return; if (e.dialog.hidden) previousFocus = canFocus(returnFocus) ? returnFocus : getActiveElement(); else previousFocus ||= canFocus(returnFocus) ? returnFocus : getActiveElement(); e.dialog.hidden = false; scope.activate(); preferred().focus(); onVisibilityChange(); },
    close,
    dispose() { disposed = true; generation++; clearTimeout(timer); close(); scope.dispose(); for (const [element, name, handler] of listeners) element.removeEventListener(name, handler); },
  };
}
