// Notify-only update banner (outcome #477, item 3.2).
//
// The native side (src-tauri/src/update_check.rs) verifies the signed release
// manifest and exposes one bounded state. This module only renders it. The
// banner has no install button: it tells the user how to upgrade (Homebrew or
// the release DMG) and never downloads, installs, or restarts anything.

export const CASK_UPGRADE_COMMAND = 'brew upgrade --cask psyche-build';
const RELEASE_URL_PREFIX = 'https://github.com/OpenCoven/psyche-build/releases/tag/v';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const INSTALL_SOURCES = new Set(['homebrew_cask', 'dmg', 'unknown']);

/**
 * Reduces an `update_status` reply to what the banner shows, or null when it
 * must stay hidden. Anything unexpected hides the banner (fail closed).
 */
export function bannerModel(status) {
  if (!status || status.state !== 'available' || status.skipped || status.dismissed) return null;
  const available = status.available;
  if (!available || typeof available.version !== 'string' || !STABLE_VERSION.test(available.version)) {
    return null;
  }
  const releaseUrl = `${RELEASE_URL_PREFIX}${available.version}`;
  if (available.release_url !== releaseUrl) return null;
  const source = INSTALL_SOURCES.has(status.install_source) ? status.install_source : 'unknown';
  const sha256 = typeof available.dmg_sha256 === 'string' && SHA256_HEX.test(available.dmg_sha256)
    ? available.dmg_sha256
    : null;
  return {
    version: available.version,
    runningVersion: typeof status.running_version === 'string' ? status.running_version : '',
    showCask: source !== 'dmg',
    showDmg: source !== 'homebrew_cask',
    releaseUrl,
    arch: typeof available.arch === 'string' ? available.arch : null,
    sha256,
  };
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc, label, action, onClick) {
  const node = element(doc, 'button', 'update-banner-button', label);
  node.type = 'button';
  node.dataset.updateAction = action;
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Renders `model` into `container`. The container itself is the polite live
 * region (`role="status"`), so assistive technology announces the notice once
 * without moving focus.
 */
export function renderUpdateBanner(container, model, handlers, doc = container.ownerDocument) {
  if (!model) {
    container.replaceChildren();
    container.hidden = true;
    return;
  }
  const title = element(doc, 'p', 'update-banner-title', `Psyche Build ${model.version} is available.`);
  const note = element(
    doc,
    'p',
    'update-banner-note',
    `${model.runningVersion ? `You have ${model.runningVersion}. ` : ''}Psyche Build never installs updates or restarts by itself.`,
  );
  const steps = element(doc, 'div', 'update-banner-steps');
  if (model.showCask) {
    const row = element(doc, 'p', 'update-banner-step');
    row.append(
      element(doc, 'span', '', model.showDmg ? 'Installed with Homebrew: ' : 'Upgrade with Homebrew: '),
      element(doc, 'code', 'update-banner-command', CASK_UPGRADE_COMMAND),
      button(doc, 'Copy command', 'copy-command', () => handlers.copy(CASK_UPGRADE_COMMAND)),
    );
    steps.append(row);
  }
  if (model.showDmg) {
    const row = element(doc, 'p', 'update-banner-step');
    row.append(
      element(doc, 'span', '', model.showCask ? 'Installed from a DMG: ' : 'Download the DMG: '),
      button(doc, 'Open release page', 'open-release', () => handlers.openRelease(model.releaseUrl)),
    );
    steps.append(row);
    if (model.sha256) {
      const digest = element(doc, 'p', 'update-banner-step');
      digest.append(
        element(doc, 'span', '', `SHA-256${model.arch ? ` (${model.arch})` : ''}: `),
        element(doc, 'code', 'update-banner-digest', model.sha256),
      );
      steps.append(digest);
    }
  }
  const actions = element(doc, 'div', 'update-banner-actions');
  actions.append(
    button(doc, 'Skip this version', 'skip', () => handlers.skip(model.version)),
    button(doc, 'Dismiss', 'dismiss', () => handlers.dismiss()),
  );
  container.replaceChildren(title, note, steps, actions);
  container.hidden = false;
}

/**
 * Wires the banner and the optional "Check for updates" setting to the native
 * commands. `invoke` is `window.__TAURI__.core.invoke`.
 */
export function createUpdateBannerController({
  invoke,
  listen = null,
  container,
  checksToggle = null,
  checksRow = null,
  writeText = null,
  openUrl = null,
  announce = () => {},
}) {
  let status = null;
  let disposed = false;
  let unlisten = null;

  function apply(next) {
    status = next && typeof next === 'object' ? next : null;
    renderUpdateBanner(container, bannerModel(status), handlers);
    if (checksToggle) {
      const supported = Boolean(status && status.checks_supported);
      if (checksRow) checksRow.hidden = !supported;
      checksToggle.disabled = !supported;
      checksToggle.checked = supported && Boolean(status.checks_enabled);
    }
    return status;
  }

  async function call(command, args) {
    try {
      return apply(await invoke(command, args));
    } catch (error) {
      // A refused or failed command leaves the banner as it was; it never
      // falls back to some other action.
      console.warn(`[update] ${command} failed`, error);
      return status;
    }
  }

  const handlers = {
    async copy(text) {
      if (!writeText) return;
      try {
        await writeText(text);
        announce('Command copied.');
      } catch (error) {
        console.warn('[update] copy failed', error);
      }
    },
    async openRelease(url) {
      if (!openUrl || !url.startsWith(RELEASE_URL_PREFIX)) return;
      try {
        await openUrl(url);
      } catch (error) {
        console.warn('[update] opening the release page failed', error);
      }
    },
    skip: (version) => call('update_skip_version', { version }),
    dismiss: () => call('update_dismiss'),
  };

  function onKeydown(event) {
    if (event.key === 'Escape' && !container.hidden) {
      event.preventDefault();
      handlers.dismiss();
    }
  }
  container.addEventListener('keydown', onKeydown);

  function onToggle() {
    call('update_set_checks_enabled', { enabled: Boolean(checksToggle.checked) });
  }
  if (checksToggle) checksToggle.addEventListener('change', onToggle);

  const refresh = () => call('update_status');

  if (listen) {
    Promise.resolve(listen('update:status-changed', () => refresh()))
      .then((stop) => {
        if (disposed && typeof stop === 'function') stop();
        else unlisten = stop;
      })
      .catch((error) => console.warn('[update] status events unavailable', error));
  }

  return {
    refresh,
    handlers,
    get status() {
      return status;
    },
    dispose() {
      disposed = true;
      container.removeEventListener('keydown', onKeydown);
      if (checksToggle) checksToggle.removeEventListener('change', onToggle);
      if (typeof unlisten === 'function') unlisten();
    },
  };
}
