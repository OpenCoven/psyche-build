const LABELS = { provenance: 'Provenance', persistence: 'Project recovery', providers: 'Providers', lifecycle: 'Lifecycle',
  updater: 'Updater', graphics: 'Graphics', receipts: 'Receipts', terminal: 'Terminal content' };
const REASONS = { unverified: 'unverified snapshot', project_recovery_only: 'project recovery metadata only',
  filesystem_only: 'executable presence only; nothing launched', counts_only: 'pane count only',
  native_snapshot: 'native updater snapshot', engine_only: 'WebView engine only; acceleration unknown',
  owner_unavailable: 'owning runtime projection unavailable', content_excluded: 'raw content is never collected' };
function failure(code) {
  if (String(code).includes('node_unavailable')) return 'Node.js is unavailable. Install the supported Node.js prerequisite and reopen the app, then try again.';
  if (String(code).includes('write_failed')) return 'Could not save the bundle. Check project storage, free space and permissions, then try again.';
  if (String(code).includes('project_unavailable')) return 'Open the project in Psyche Build before creating its support bundle.';
  return 'Support export could not finish. Check the project and runtime prerequisites, then try again. No private error details were copied.';
}

export function createSupportBundleController({ elements: e, invoke, getProject, getActiveElement = () => null }) {
  let busy = false, disposed = false, job = null, previousFocus = null, timer = null, cancelRequested = false;
  e.cancel.disabled = true; e.reveal.disabled = true;
  function controls() { e.create.disabled = busy; e.cancel.disabled = !busy || cancelRequested; }
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
      e.status.textContent = 'Export needs recovery: the worker stopped without confirming whether a file was saved. Inspect the project support-bundles directory before retrying.';
    } else e.status.textContent = failure(result.code);
  }
  async function poll() {
    if (disposed || !busy || !job) return;
    try {
      show(await invoke('support_bundle_status', { id: job.id }));
      if (busy) timer = setTimeout(poll, 100);
    } catch {
      show({ state: 'recovery_required' });
    }
  }
  async function cancel() {
    if (!busy || cancelRequested) return;
    cancelRequested = true; controls(); e.status.textContent = 'Cancelling support export…';
    if (job) {
      try { show(await invoke('support_bundle_cancel', { id: job.id })); }
      catch { show({ state: 'recovery_required' }); }
    }
  }
  async function create() {
    if (busy || disposed) return;
    const project = getProject();
    if (!project) { e.status.textContent = failure('project_unavailable'); return; }
    busy = true; cancelRequested = false; job = null;
    e.summary.textContent = ''; e.reveal.disabled = true;
    controls(); e.status.textContent = 'Collecting a local support bundle…'; e.cancel.focus();
    try {
      const started = await invoke('support_bundle_start', { root: project.root, panes: project.panes });
      if (disposed) return;
      show(started);
      if (busy && cancelRequested) {
        show(await invoke('support_bundle_cancel', { id: job.id }));
      }
      if (busy) timer = setTimeout(poll, 100);
    } catch (error) {
      busy = false; controls(); e.status.textContent = failure(error);
      e.create.focus();
    }
  }
  async function reveal() {
    if (e.reveal.disabled || !job) return;
    try { await invoke('support_bundle_reveal', { id: job.id }); }
    catch { e.status.textContent = 'Could not reveal this bundle. Reopen its project and check that the saved file is still present.'; }
  }
  function close() { e.dialog.hidden = true; if (previousFocus?.focus && previousFocus.isConnected !== false) previousFocus.focus(); }
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
    open(returnFocus) { if (e.dialog.hidden) previousFocus = returnFocus || getActiveElement(); else previousFocus ||= returnFocus || getActiveElement(); e.dialog.hidden = false; (busy ? e.cancel : e.create).focus(); },
    close,
    dispose() { disposed = true; clearTimeout(timer); for (const [element, name, handler] of listeners) element.removeEventListener(name, handler); },
  };
}
