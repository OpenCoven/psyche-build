const MAX_VISITED = 2000;
const MAX_NODES = 2000;
const MAX_DEPTH = 32;
const MAX_NAME_BYTES = 512;
const MAX_URL_BYTES = 2048;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_METADATA_RESERVE_BYTES = 8 * 1024;
const SNAPSHOT_TTL_MS = 30_000;
const APPROVED_ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'combobox', 'heading',
  'img', 'iframe', 'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'list', 'listitem',
  'tab', 'tablist', 'menu', 'menuitem', 'dialog', 'alert', 'status', 'searchbox', 'spinbutton', 'slider'];

function codedError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function boundedText(value, limit) {
  const text = String(value || '').slice(0, limit * 2 + 1).replace(/\s+/g, ' ').trim();
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) return text;
  let low = 0; let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).byteLength <= limit) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
  return text.slice(0, low);
}

function roleFor(element) {
  const explicit = element.getAttribute?.('role');
  if (explicit) {
    const role = boundedText(explicit, 64).split(' ')[0];
    if (APPROVED_ROLES.includes(role)) return role;
  }
  const tag = String(element.tagName || '').toLowerCase();
  const type = String(element.type || element.getAttribute?.('type') || '').toLowerCase();
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'nav') return 'navigation';
  if (tag === 'main') return 'main';
  if (tag === 'header') return 'banner';
  if (tag === 'footer') return 'contentinfo';
  if (tag === 'aside') return 'complementary';
  if (tag === 'ul' || tag === 'ol') return 'list';
  if (tag === 'li') return 'listitem';
  if (tag === 'img') return 'img';
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute?.('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag === 'iframe') return 'iframe';
  if (tag === 'input') {
    if (type === 'checkbox') return element.getAttribute?.('role') === 'switch' ? 'switch' : 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type !== 'hidden') return 'textbox';
  }
  return null;
}

function nodeText(node) {
  if (!node) return '';
  if (node.textContent) return node.textContent;
  const children = node.children || []; const parts = [];
  for (let index = 0; index < children.length && index < 32; index += 1) parts.push(nodeText(children[index]));
  return parts.join(' ');
}

function accessibleName(element, document) {
  document = element.ownerDocument || document;
  const aria = element.getAttribute?.('aria-label');
  if (aria) return boundedText(aria, MAX_NAME_BYTES);
  const labelledBy = element.getAttribute?.('aria-labelledby');
  if (labelledBy) {
    const text = boundedText(labelledBy, 2_048).split(/\s+/).slice(0, 32)
      .map((id) => nodeText(document.getElementById?.(id))).join(' ');
    if (text.trim()) return boundedText(text, MAX_NAME_BYTES);
  }
  const labelCollection = element.labels || []; const labels = [];
  for (let index = 0; index < labelCollection.length && index < 32; index += 1) labels.push(labelCollection[index]);
  if (labels.length) return boundedText(labels.map(nodeText).join(' '), MAX_NAME_BYTES);
  for (const attribute of ['alt', 'title']) {
    const value = element.getAttribute?.(attribute);
    if (value) return boundedText(value, MAX_NAME_BYTES);
  }
  const tag = String(element.tagName || '').toLowerCase();
  const type = String(element.type || '').toLowerCase();
  if (tag === 'input' && ['button', 'submit', 'reset'].includes(type) && element.value) {
    return boundedText(element.value, MAX_NAME_BYTES);
  }
  return boundedText(nodeText(element), MAX_NAME_BYTES);
}

function hiddenByTree(element, globalObject) {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.hasAttribute?.('inert') || current.getAttribute?.('aria-hidden') === 'true') return true;
    const style = globalObject.getComputedStyle?.(current) || {};
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
  }
  return false;
}

function visible(element, globalObject, offsetX = 0, offsetY = 0, clip = null) {
  if (hiddenByTree(element, globalObject)) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const absolute = { left: offsetX + rect.left, top: offsetY + rect.top,
    right: offsetX + rect.right, bottom: offsetY + rect.bottom };
  const viewport = clip || { left: 0, top: 0, right: globalObject.innerWidth, bottom: globalObject.innerHeight };
  return absolute.right > viewport.left && absolute.bottom > viewport.top &&
    absolute.left < viewport.right && absolute.top < viewport.bottom;
}

function intersectClip(left, top, right, bottom, clip, globalObject) {
  const parent = clip || { left: 0, top: 0, right: globalObject.innerWidth, bottom: globalObject.innerHeight };
  return { left: Math.max(left, parent.left), top: Math.max(top, parent.top),
    right: Math.min(right, parent.right), bottom: Math.min(bottom, parent.bottom) };
}

function stateFor(element) {
  const tag = String(element.tagName || '').toLowerCase();
  const type = String(element.type || '').toLowerCase();
  if (tag === 'input' && type === 'password') {
    return { secret: true, valuePresent: String(element.value || '').length > 0 };
  }
  const state = {};
  if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') state.disabled = true;
  if (type === 'checkbox' || type === 'radio') state.checked = !!element.checked;
  if (tag === 'textarea' || tag === 'select' || (tag === 'input' && type !== 'password')) {
    state.value = boundedText(element.value, MAX_NAME_BYTES);
  }
  if (/^h[1-6]$/i.test(element.tagName || '')) state.level = Number(String(element.tagName).slice(1));
  return state;
}

function randomSession(globalObject, options) {
  const cryptoObject = options.crypto || globalObject.crypto || globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes); return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw codedError('backend_unavailable', 'secure browser snapshot identity is unavailable');
}

function createSnapshot(runtime, request) {
  runtime.current = null;
  const document = runtime.globalObject.document;
  const refs = new Map(); const nodes = [];
  const frameDocuments = [];
  let truncated = false; let visited = 0; let encodedNodeBytes = 0;
  const visit = (element, depth, offsetX = 0, offsetY = 0, clip = null) => {
    if (!element || depth > MAX_DEPTH || visited >= MAX_VISITED) { if (element) truncated = true; return; }
    visited += 1;
    const role = roleFor(element);
    if (role && visible(element, runtime.globalObject, offsetX, offsetY, clip)) {
      if (nodes.length >= MAX_NODES) { truncated = true; return; }
      const ref = `e${nodes.length + 1}`;
      const rect = element.getBoundingClientRect();
      const node = { ref, depth, role, name: accessibleName(element, document), state: stateFor(element),
        bounds: { x: offsetX + rect.left, y: offsetY + rect.top, width: rect.width, height: rect.height } };
      if (role === 'iframe') {
        let childDocument = null;
        try { childDocument = element.contentDocument || null; } catch { childDocument = null; }
        node.opaque = !childDocument;
        const nodeBytes = new TextEncoder().encode(JSON.stringify(node)).byteLength + (nodes.length ? 1 : 0);
        if (encodedNodeBytes + nodeBytes >= MAX_SNAPSHOT_BYTES - SNAPSHOT_METADATA_RESERVE_BYTES) {
          truncated = true; return;
        }
        encodedNodeBytes += nodeBytes; refs.set(ref, element); nodes.push(node);
        if (childDocument) {
          frameDocuments.push({ frame: element, document: childDocument });
          const childLeft = offsetX + rect.left; const childTop = offsetY + rect.top;
          const childClip = intersectClip(childLeft, childTop, childLeft + rect.width, childTop + rect.height,
            clip, runtime.globalObject);
          visit(childDocument.documentElement, depth + 1, childLeft, childTop, childClip);
        }
      } else {
        const nodeBytes = new TextEncoder().encode(JSON.stringify(node)).byteLength + (nodes.length ? 1 : 0);
        if (encodedNodeBytes + nodeBytes >= MAX_SNAPSHOT_BYTES - SNAPSHOT_METADATA_RESERVE_BYTES) {
          truncated = true; return;
        }
        encodedNodeBytes += nodeBytes; refs.set(ref, element); nodes.push(node);
      }
    }
    if (visited >= MAX_VISITED || nodes.length >= MAX_NODES) { truncated = true; return; }
    const children = element.children || [];
    for (let index = 0; index < children.length && visited < MAX_VISITED && nodes.length < MAX_NODES; index += 1) {
      visit(children[index], depth + 1, offsetX, offsetY, clip);
    }
  };
  visit(document.documentElement, 0);
  const createdAt = runtime.now();
  const value = { schema: 'psyche.browser.snapshot/v1',
    snapshotId: `${runtime.sessionId}:${++runtime.sequence}`, documentId: request.documentId || runtime.sessionId,
    tabId: request.tabId || null, generation: request.generation ?? 0,
    url: boundedText(document.location?.href || runtime.globalObject.location?.href || '', MAX_URL_BYTES),
    title: boundedText(document.title || '', MAX_NAME_BYTES), loading: document.readyState === 'loading',
    capturedAt: createdAt, viewport: { width: runtime.globalObject.innerWidth || 0, height: runtime.globalObject.innerHeight || 0 },
    nodes, visited, truncated };
  const encoder = new TextEncoder();
  while (value.nodes.length && encoder.encode(JSON.stringify(value)).byteLength >= MAX_SNAPSHOT_BYTES) {
    refs.delete(value.nodes.pop().ref); value.truncated = true;
  }
  if (encoder.encode(JSON.stringify(value)).byteLength >= MAX_SNAPSHOT_BYTES) {
    throw codedError('result_too_large', 'browser snapshot metadata exceeds the encoded result limit');
  }
  runtime.current = { value, refs, document, frameDocuments, createdAt };
  return value;
}

export function installBrowserAutomation(globalObject, options = {}) {
  const existing = globalObject.__PSYCHE_AUTOMATION__;
  if (existing && existing.document === globalObject.document && existing.__psycheRuntime === true) return existing;
  const runtime = { __psycheRuntime: true, document: globalObject.document, globalObject,
    sessionId: options.sessionId || randomSession(globalObject, options), now: options.now || (() => Date.now()),
    sequence: 0, current: null, dispatch(request) {
      if (!request || request.kind === 'snapshot' || request.kind === 'inspect') return createSnapshot(runtime, request || {});
      if (request.kind === 'navigation' || request.kind === 'invalidate') { runtime.current = null; return { invalidated: true }; }
      if (request.kind === 'resolve') {
        const current = runtime.current;
        var framesCurrent = current && current.frameDocuments.every((entry) => {
          try { return entry.frame.contentDocument === entry.document; } catch { return false; }
        });
        if (!current || current.value.snapshotId !== request.snapshotId || current.document !== globalObject.document || !framesCurrent ||
            runtime.now() - current.createdAt >= SNAPSHOT_TTL_MS || !current.refs.has(request.ref)) {
          runtime.current = null; throw codedError('snapshot_stale', 'browser snapshot is stale');
        }
        return { snapshotId: current.value.snapshotId, ref: request.ref };
      }
      throw codedError('unsupported_operation', 'browser automation operation is unsupported');
    } };
  globalObject.__PSYCHE_AUTOMATION__ = runtime;
  return runtime;
}

export function dispatchBrowserAutomation(globalObject, request) {
  return installBrowserAutomation(globalObject).dispatch(request);
}

export function browserAutomationSource() {
  const definitions = { MAX_VISITED, MAX_NODES, MAX_DEPTH, MAX_NAME_BYTES, MAX_URL_BYTES, MAX_SNAPSHOT_BYTES,
    SNAPSHOT_METADATA_RESERVE_BYTES, SNAPSHOT_TTL_MS, APPROVED_ROLES,
    codedError, boundedText, roleFor, nodeText, accessibleName, hiddenByTree, visible, intersectClip, stateFor, randomSession,
    createSnapshot, installBrowserAutomation };
  return `(function(){${Object.entries(definitions).map(([name, definition]) =>
    `const ${name}=${typeof definition === 'function' ? definition.toString() : JSON.stringify(definition)};`).join('')}installBrowserAutomation(window);})()`;
}
