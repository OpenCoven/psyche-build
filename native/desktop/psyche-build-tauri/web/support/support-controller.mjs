export function createHelpModalController({ dialog, trigger, action, close, getActiveElement, onVisibilityChange = () => {} }) {
  let previousFocus = null;
  function setOpen(open) {
    const wasOpen = !dialog.hidden;
    if (open && !wasOpen) previousFocus = getActiveElement();
    dialog.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) (action.disabled ? close : action).focus();
    else if (wasOpen) {
      const target = canFocus(previousFocus) ? previousFocus : trigger;
      if (canFocus(target)) target.focus();
    }
    onVisibilityChange();
  }
  close.addEventListener('click', () => setOpen(false));
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    if (event.key === 'Tab') {
      if (event.shiftKey && getActiveElement() === action) { event.preventDefault(); close.focus(); }
      else if (!event.shiftKey && getActiveElement() === close) { event.preventDefault(); (action.disabled ? close : action).focus(); }
    }
  });
  return { setOpen };
}

function canFocus(element) {
  return element && !element.disabled && element.isConnected !== false && typeof element.focus === 'function'
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

export function createSupportBundleController({ elements: e, invoke, getProject, getActiveElement = () => null }) {
  let busy = false, disposed = false, job = null, previousFocus = null, timer = null, cancelRequested = false;
  let generation = 0;
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
  function close() { e.dialog.hidden = true; if (canFocus(previousFocus)) previousFocus.focus(); }
  function keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const buttons = [e.create, e.cancel, e.reveal, e.close].filter(button => !button.disabled);
      const active = getActiveElement();
      if (event.shiftKey && active === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
      else if (!event.shiftKey && active === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
    }
  }
  const listeners = [[e.create, 'click', create], [e.cancel, 'click', cancel], [e.reveal, 'click', reveal], [e.close, 'click', close], [e.dialog, 'keydown', keydown]];
  for (const [element, name, handler] of listeners) element.addEventListener(name, handler);
  return {
    open(returnFocus) { if (e.dialog.hidden) previousFocus = canFocus(returnFocus) ? returnFocus : getActiveElement(); else previousFocus ||= canFocus(returnFocus) ? returnFocus : getActiveElement(); e.dialog.hidden = false; (busy ? (cancelRequested ? e.close : e.cancel) : e.create).focus(); },
    close,
    dispose() { disposed = true; generation++; clearTimeout(timer); for (const [element, name, handler] of listeners) element.removeEventListener(name, handler); },
  };
}
