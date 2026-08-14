const MAX_VISITED = 2000;
const MAX_NODES = 2000;
const MAX_DEPTH = 32;
const MAX_NAME_BYTES = 512;
const MAX_URL_BYTES = 2048;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_METADATA_RESERVE_BYTES = 8 * 1024;
const SNAPSHOT_TTL_MS = 30_000;
const MAX_SCRIPT_RESULT_BYTES = 256 * 1024;
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
  const visit = (element, depth, offsetX = 0, offsetY = 0, clip = null, frames = []) => {
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
        encodedNodeBytes += nodeBytes; refs.set(ref, { element, frames, offsetX, offsetY, clip }); nodes.push(node);
        if (childDocument) {
          frameDocuments.push({ frame: element, document: childDocument });
          const childLeft = offsetX + rect.left; const childTop = offsetY + rect.top;
          const childClip = intersectClip(childLeft, childTop, childLeft + rect.width, childTop + rect.height,
            clip, runtime.globalObject);
          visit(childDocument.documentElement, depth + 1, childLeft, childTop, childClip,
            [...frames, { frame: element, document: childDocument }]);
        }
      } else {
        const nodeBytes = new TextEncoder().encode(JSON.stringify(node)).byteLength + (nodes.length ? 1 : 0);
        if (encodedNodeBytes + nodeBytes >= MAX_SNAPSHOT_BYTES - SNAPSHOT_METADATA_RESERVE_BYTES) {
          truncated = true; return;
        }
        encodedNodeBytes += nodeBytes; refs.set(ref, { element, frames, offsetX, offsetY, clip }); nodes.push(node);
      }
    }
    if (visited >= MAX_VISITED || nodes.length >= MAX_NODES) { truncated = true; return; }
    const children = element.children || [];
    for (let index = 0; index < children.length && visited < MAX_VISITED && nodes.length < MAX_NODES; index += 1) {
      visit(children[index], depth + 1, offsetX, offsetY, clip, frames);
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

function currentElement(runtime, request) {
  const current = runtime.current;
  const framesCurrent = current && current.frameDocuments.every((entry) => {
    try { return entry.frame.contentDocument === entry.document; } catch { return false; }
  });
  const stored = current?.refs.get(request.ref);
  const element = stored?.element;
  const ownerDocument = element?.ownerDocument;
  if (!current || current.value.snapshotId !== request.snapshotId ||
      current.document !== runtime.globalObject.document || !framesCurrent ||
      runtime.now() - current.createdAt >= SNAPSHOT_TTL_MS || !element ||
      !ownerDocument || !ownerDocument.contains?.(element)) {
    runtime.current = null;
    throw codedError('snapshot_stale', 'browser snapshot is stale');
  }
  if (boundedText(runtime.globalObject.document.location?.href || '', MAX_URL_BYTES) !== current.value.url) {
    runtime.current = null; throw codedError('snapshot_stale', 'browser URL changed');
  }
  let offsetX = 0; let offsetY = 0; let clip = null;
  for (const entry of stored.frames) {
    if (!entry.frame.ownerDocument?.contains?.(entry.frame) || entry.frame.contentDocument !== entry.document ||
        hiddenByTree(entry.frame, runtime.globalObject) ||
        !visible(entry.frame, runtime.globalObject, offsetX, offsetY, clip)) {
      runtime.current = null; throw codedError('snapshot_stale', 'containing browser frame is stale');
    }
    const rect = entry.frame.getBoundingClientRect();
    const left = offsetX + rect.left; const top = offsetY + rect.top;
    clip = intersectClip(left, top, left + rect.width, top + rect.height, clip, runtime.globalObject);
    offsetX = left; offsetY = top;
  }
  if (hiddenByTree(element, runtime.globalObject) ||
      !visible(element, runtime.globalObject, offsetX, offsetY, clip)) {
    runtime.current = null;
    throw codedError('snapshot_stale', 'browser element is no longer visible');
  }
  if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
    throw codedError('element_disabled', 'browser element is disabled');
  }
  return element;
}

function eventFor(element, name, input = false, data = null, inputType = '') {
  const view = element.ownerDocument?.defaultView;
  const Constructor = input ? (view?.InputEvent || view?.Event) : view?.Event;
  const options = { bubbles: true, cancelable: name === 'beforeinput', ...(input ? { data, inputType } : {}) };
  const event = Constructor ? new Constructor(name, options) : { type: name, ...options };
  if (input && event.data === undefined) {
    try { Object.defineProperties(event, { data: { value: data }, inputType: { value: inputType } }); } catch {}
  }
  return event;
}

function dispatchEvent(element, name, input = false, data = null, inputType = '') {
  return element.dispatchEvent?.(eventFor(element, name, input, data, inputType)) !== false;
}

function submitMetadata(element, runtime, requireForm = false) {
  const tag = String(element.tagName || '').toLowerCase();
  const type = String(element.type || element.getAttribute?.('type') || '').toLowerCase();
  const form = tag === 'form' ? element : element.form;
  const submit = tag === 'form' || ((tag === 'button' && (!type || type === 'submit')) ||
    (tag === 'input' && (type === 'submit' || type === 'image'))) && !!form;
  let formId;
  if ((submit || requireForm) && form && runtime) {
    formId = runtime.formIds.get(form);
    if (!formId) { formId = `f${++runtime.formSequence}`; runtime.formIds.set(form, formId); }
  }
  return { submit, ...(formId ? { formId } : {}) };
}

function actionPostcondition(runtime, request) {
  if (request.kind === 'upload' || request.kind === 'download' || request.kind === 'permission_response') {
    throw codedError('backend_unavailable', `${request.kind} requires unavailable native interception`);
  }
  const element = currentElement(runtime, request);
  const secret = String(element.type || '').toLowerCase() === 'password';
  if (request.kind === 'click' || request.kind === 'type' || request.kind === 'submit') {
    const metadata = request.kind === 'click' || request.kind === 'submit'
      ? submitMetadata(element, runtime, request.kind === 'submit') : null;
    const actualRisk = { documentId: runtime.current?.value.documentId,
      submit: request.kind === 'type' ? null : metadata.submit,
      formId: request.kind === 'type' ? null : (metadata.formId || null),
      secret: request.kind === 'type' ? secret : null };
    const expected = request.expectedRisk;
    const keys = expected && typeof expected === 'object' ? Object.keys(expected).sort() : [];
    if (keys.join(',') !== 'documentId,formId,secret,submit' ||
        keys.some((key) => expected[key] !== actualRisk[key])) {
      throw codedError('approval_identity_mismatch', 'browser action risk identity changed');
    }
  }
  switch (request.kind) {
    case 'focus':
      element.focus?.();
      {
        const result = { focused: element.ownerDocument?.activeElement === element };
        runtime.current = null; return result;
      }
    case 'type': {
      const tag = String(element.tagName || '').toLowerCase();
      const type = String(element.type || '').toLowerCase();
      if (!(tag === 'textarea' || (tag === 'input' &&
          !['button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio', 'range'].includes(type)))) {
        throw codedError('invalid_action', 'type requires a text-like control');
      }
      element.focus?.();
      const previous = String(element.value || '');
      const text = String(request.text || '');
      const inputType = request.append === true ? 'insertText' : text ? 'insertReplacementText' : 'deleteContentBackward';
      const data = inputType === 'deleteContentBackward' ? null : text;
      if (!dispatchEvent(element, 'beforeinput', true, data, inputType)) {
        runtime.current = null; return { canceled: true, secret,
          ...(secret ? { valuePresent: previous.length > 0 } : {}) };
      }
      element.value = request.append === true ? previous + text : text;
      dispatchEvent(element, 'input', true, data, inputType);
      dispatchEvent(element, 'change');
      const result = secret ? { secret: true, valuePresent: element.value.length > 0 } :
        { secret: false, value: boundedText(element.value, MAX_NAME_BYTES) };
      runtime.current = null; return result;
    }
    case 'select': {
      if (String(element.tagName || '').toLowerCase() !== 'select') throw codedError('invalid_action', 'select requires a select control');
      const wanted = new Set(Array.isArray(request.values) ? request.values.map(String) : []);
      if (!element.multiple && wanted.size > 1) throw codedError('invalid_action', 'single select accepts one value');
      const available = new Map(Array.from(element.options || []).map((option) => [String(option.value), option]));
      for (const value of wanted) {
        const option = available.get(value);
        if (!option || option.disabled) throw codedError('invalid_action', 'requested option is unavailable');
      }
      const selected = [];
      for (const option of Array.from(element.options || [])) {
        option.selected = wanted.has(String(option.value));
        if (option.selected) selected.push(boundedText(option.value, MAX_NAME_BYTES));
      }
      if (!element.multiple) element.value = selected[0] || '';
      dispatchEvent(element, 'input'); dispatchEvent(element, 'change');
      if (!element.ownerDocument?.contains?.(element)) {
        runtime.current = null; throw codedError('effect_unknown', 'select postcondition is unavailable after page mutation');
      }
      const finalSelected = [];
      for (const option of Array.from(element.options || [])) {
        if (option.selected) finalSelected.push(boundedText(option.value, MAX_NAME_BYTES));
        if (finalSelected.length >= 100) break;
      }
      const result = secret ? { secret: true, valuePresent: finalSelected.length > 0 } : { values: finalSelected };
      runtime.current = null; return result;
    }
    case 'scroll': {
      element.scrollBy?.({ left: Number(request.deltaX || 0), top: Number(request.deltaY || 0), behavior: 'auto' });
      const result = { scrollLeft: Number(element.scrollLeft || 0), scrollTop: Number(element.scrollTop || 0) };
      runtime.current = null; return result;
    }
    case 'click': {
      const metadata = submitMetadata(element, runtime);
      element.focus?.(); element.click?.();
      runtime.current = null;
      return { clicked: true, submit: metadata.submit,
        url: boundedText(runtime.globalObject.document.location?.href || '', MAX_URL_BYTES),
        title: boundedText(runtime.globalObject.document.title || '', MAX_NAME_BYTES) };
    }
    case 'submit': {
      const metadata = submitMetadata(element, runtime);
      const form = String(element.tagName || '').toLowerCase() === 'form' ? element : element.form;
      if (!form || typeof form.requestSubmit !== 'function') throw codedError('invalid_action', 'element has no submittable form');
      form.requestSubmit(element === form ? undefined : element);
      runtime.current = null;
      return { submitted: true, submit: metadata.submit || !!form,
        url: boundedText(runtime.globalObject.document.location?.href || '', MAX_URL_BYTES),
        title: boundedText(runtime.globalObject.document.title || '', MAX_NAME_BYTES) };
    }
    default:
      throw codedError('unsupported_operation', 'browser automation operation is unsupported');
  }
}

export function installBrowserAutomation(globalObject, options = {}) {
  const existing = globalObject.__PSYCHE_AUTOMATION__;
  if (existing && existing.document === globalObject.document && existing.__psycheRuntime === true) return existing;
  const runtime = { __psycheRuntime: true, document: globalObject.document, globalObject,
    sessionId: options.sessionId || randomSession(globalObject, options), now: options.now || (() => Date.now()),
    sequence: 0, current: null, formIds: new WeakMap(), formSequence: 0, dispatch(request) {
      if (!request || request.kind === 'snapshot' || request.kind === 'inspect') return createSnapshot(runtime, request || {});
      if (request.kind === 'navigation' || request.kind === 'invalidate') { runtime.current = null; return { invalidated: true }; }
      if (request.kind === 'resolve') {
        const element = currentElement(runtime, request);
        const metadata = request.actionKind === 'click' || request.actionKind === 'submit'
          ? submitMetadata(element, runtime, request.actionKind === 'submit') : null;
        const risk = { submit: request.actionKind === 'type' ? null : metadata ? metadata.submit : null,
          formId: metadata?.formId || null,
          secret: request.actionKind === 'type' ? String(element.type || '').toLowerCase() === 'password' : null };
        return { snapshotId: runtime.current.value.snapshotId, ref: request.ref,
          actionKind: request.actionKind, documentId: runtime.current.value.documentId, ...risk };
      }
      return actionPostcondition(runtime, request);
    } };
  globalObject.__PSYCHE_AUTOMATION__ = runtime;
  return runtime;
}

export function dispatchBrowserAutomation(globalObject, request) {
  return installBrowserAutomation(globalObject).dispatch(request);
}

function canonicalScriptJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  if (isArray) {
    if (keys.some((key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !('value' in descriptor) || !canonicalScriptJson(descriptor.value, seen)) return false;
    }
  } else {
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !('value' in descriptor) || !canonicalScriptJson(descriptor.value, seen)) return false;
    }
  }
  seen.delete(value); return true;
}

export function serializeBrowserScriptResult(value) {
  if (!canonicalScriptJson(value)) throw codedError('script_serialization_failed', 'browser script result is not plain JSON');
  let json;
  try { json = JSON.stringify(value); } catch (_) {
    throw codedError('script_serialization_failed', 'browser script result is not serializable');
  }
  if (typeof json !== 'string') throw codedError('script_serialization_failed', 'browser script result is not serializable');
  const byteCount = new TextEncoder().encode(json).byteLength;
  if (byteCount > MAX_SCRIPT_RESULT_BYTES) throw codedError('result_too_large', 'browser script result exceeds the control limit');
  return { json, byteCount };
}

export function browserAutomationSource() {
  const definitions = { MAX_VISITED, MAX_NODES, MAX_DEPTH, MAX_NAME_BYTES, MAX_URL_BYTES, MAX_SNAPSHOT_BYTES,
    SNAPSHOT_METADATA_RESERVE_BYTES, SNAPSHOT_TTL_MS, APPROVED_ROLES,
    codedError, boundedText, roleFor, nodeText, accessibleName, hiddenByTree, visible, intersectClip, stateFor, randomSession,
    createSnapshot, currentElement, eventFor, dispatchEvent, submitMetadata, actionPostcondition, installBrowserAutomation };
  return `(function(){${Object.entries(definitions).map(([name, definition]) =>
    `const ${name}=${typeof definition === 'function' ? definition.toString() : JSON.stringify(definition)};`).join('')}installBrowserAutomation(window);})()`;
}
