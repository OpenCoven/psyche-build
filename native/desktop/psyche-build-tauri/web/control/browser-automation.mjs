const SNAPSHOT_SCHEMA = 'psyche.browser.snapshot/v1';
const MAX_NODES = 2_000;
const MAX_DEPTH = 32;
const MAX_NAME_BYTES = 512;
const MAX_NAME_NODES = 2_000;
const SNAPSHOT_TTL_MS = 30_000;
const INSTALLED = new WeakMap();

const INTERACTIVE_TAGS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IFRAME']);

export function installBrowserAutomation(globalObject, options = {}) {
  if (!globalObject || (typeof globalObject !== 'object' && typeof globalObject !== 'function')) {
    throw automationError('bad_request', 'global object is required');
  }
  const existing = INSTALLED.get(globalObject);
  if (existing) return existing;

  const now = typeof options.now === 'function' ? options.now : () => globalObject.Date?.now?.() ?? Date.now();
  let sequence = 0;
  let current = null;

  function invalidate() {
    current = null;
  }

  function requireCurrent(request) {
    if (!current || request.snapshotId !== current.snapshot.snapshotId ||
        now() - current.createdAt >= SNAPSHOT_TTL_MS ||
        current.document !== globalObject.document ||
        current.documentElement !== globalObject.document?.documentElement) {
      invalidate();
      throw automationError('snapshot_stale', 'snapshot_stale: browser snapshot is no longer current');
    }
    const element = current.refs.get(request.ref);
    if (!element) throw automationError('ref_missing', 'ref_missing: semantic reference is unavailable');
    return { element, semantic: current.snapshot.nodes.find((node) => node.ref === request.ref) };
  }

  function dispatch(request) {
    if (!request || typeof request.type !== 'string') throw automationError('bad_request', 'automation request is invalid');
    if (request.type === 'invalidate') {
      invalidate();
      return { ok: true };
    }
    if (request.type === 'snapshot') {
      const captured = captureSnapshot(globalObject, ++sequence, now());
      current = captured;
      return captured.snapshot;
    }
    if (request.type !== 'resolve') {
      throw automationError('unsupported_operation', 'unsupported_operation: automation operation is not allowed');
    }
    const target = requireCurrent(request);
    if (request.type === 'resolve') return { ...target.semantic };
    throw automationError('unsupported_operation', 'unsupported_operation: automation operation is not allowed');
  }

  const api = Object.freeze({ schema: 'psyche.browser.automation/v1', dispatch, invalidate });
  Object.defineProperty(globalObject, '__PSYCHE_AUTOMATION__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });
  INSTALLED.set(globalObject, api);
  return api;
}

export function dispatchBrowserAutomation(globalObject, request) {
  return installBrowserAutomation(globalObject).dispatch(request);
}

export function browserAutomationSource() {
  return `(function(globalObject){
    var existing=globalObject.__PSYCHE_AUTOMATION__;
    if (existing && existing.schema==='psyche.browser.automation/v1' &&
        typeof existing.dispatch==='function' && typeof existing.invalidate==='function') return;
    if (existing) delete globalObject.__PSYCHE_AUTOMATION__;
    const SNAPSHOT_SCHEMA=${JSON.stringify(SNAPSHOT_SCHEMA)};
    const MAX_NODES=${MAX_NODES}; const MAX_DEPTH=${MAX_DEPTH}; const MAX_NAME_BYTES=${MAX_NAME_BYTES};
    const MAX_NAME_NODES=${MAX_NAME_NODES};
    const SNAPSHOT_TTL_MS=${SNAPSHOT_TTL_MS}; const INSTALLED=new WeakMap();
    const INTERACTIVE_TAGS=new Set(${JSON.stringify([...INTERACTIVE_TAGS])});
    ${automationError.toString()}
    ${boundedText.toString()}
    ${finiteBound.toString()}
    ${clipRect.toString()}
    ${safeRect.toString()}
    ${isHidden.toString()}
    ${visibleText.toString()}
    ${accessibleName.toString()}
    ${roleFor.toString()}
    ${semanticNode.toString()}
    ${captureSnapshot.toString()}
    ${installBrowserAutomation.toString()}
    installBrowserAutomation(globalObject);
  })(globalThis);`;
}

function captureSnapshot(globalObject, sequence, createdAt) {
  const document = globalObject.document;
  if (!document?.documentElement) throw automationError('backend_unavailable', 'backend_unavailable: document is unavailable');
  const viewportWidth = finiteBound(globalObject.innerWidth, 0, 100_000);
  const viewportHeight = finiteBound(globalObject.innerHeight, 0, 100_000);
  const nodes = [];
  const refs = new Map();
  const root = document.body || document.documentElement;

  function visit(element, depth) {
    if (!element || nodes.length >= MAX_NODES || depth > MAX_DEPTH) return;
    const hidden = isHidden(element, globalObject);
    if (!hidden) {
      const semantic = semanticNode(element, document, viewportWidth, viewportHeight, globalObject);
      if (semantic) {
        const ref = `e${nodes.length + 1}`;
        nodes.push({ ref, ...semantic });
        refs.set(ref, element);
      }
    }
    if (hidden || depth === MAX_DEPTH) return;
    for (const child of Array.from(element.children || [])) {
      if (nodes.length >= MAX_NODES) break;
      visit(child, depth + 1);
    }
  }
  visit(root, 0);

  return {
    createdAt,
    document,
    documentElement: document.documentElement,
    refs,
    snapshot: {
      schema: SNAPSHOT_SCHEMA,
      snapshotId: `s${createdAt.toString(36)}-${sequence.toString(36)}`,
      url: boundedText(globalObject.location?.href || '', 2_048),
      viewport: { width: viewportWidth, height: viewportHeight },
      nodes,
      truncated: nodes.length >= MAX_NODES,
    },
  };
}

function semanticNode(element, document, viewportWidth, viewportHeight, globalObject) {
  const tag = String(element.tagName || '').toUpperCase();
  const role = roleFor(element, tag);
  if (!role) return null;
  const rect = safeRect(element);
  const clipped = clipRect(rect, viewportWidth, viewportHeight);
  if (!clipped && !INTERACTIVE_TAGS.has(tag)) return null;
  const name = accessibleName(element, document, globalObject);
  const result = { role, name, bounds: clipped || { x: 0, y: 0, width: 0, height: 0, clipped: true } };
  if (element.disabled === true || element.hasAttribute?.('disabled') || element.getAttribute?.('aria-disabled') === 'true') result.disabled = true;
  if (role === 'checkbox' || role === 'radio') result.checked = element.checked === true || element.getAttribute?.('aria-checked') === 'true';
  if (role === 'option') result.selected = element.selected === true || element.getAttribute?.('aria-selected') === 'true';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const secret = tag === 'INPUT' && String(element.type || element.getAttribute?.('type') || '').toLowerCase() === 'password';
    if (secret) {
      result.secret = true;
      result.valuePresent = String(element.value || '').length > 0;
    } else if (typeof element.value === 'string') {
      result.value = boundedText(element.value, MAX_NAME_BYTES);
    }
  }
  if (tag === 'IFRAME' || tag === 'FRAME') result.opaque = true;
  return result;
}

function roleFor(element, tag) {
  const explicit = boundedText(element.getAttribute?.('role') || '', 64);
  if (explicit) return explicit;
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A' && element.getAttribute?.('href')) return 'link';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'OPTION') return 'option';
  if (tag === 'IFRAME' || tag === 'FRAME') return 'frame';
  if (tag === 'IMG' && element.getAttribute?.('alt')) return 'img';
  if (tag === 'INPUT') {
    const type = String(element.type || element.getAttribute?.('type') || 'text').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    return 'textbox';
  }
  return null;
}

function accessibleName(element, document, globalObject) {
  const direct = element.getAttribute?.('aria-label');
  if (direct) return boundedText(direct, MAX_NAME_BYTES);
  const labelledBy = String(element.getAttribute?.('aria-labelledby') || '').trim();
  if (labelledBy) {
    const label = labelledBy.split(/\s+/).map((id) => visibleText(document.getElementById?.(id), globalObject)).join(' ').trim();
    if (label) return boundedText(label, MAX_NAME_BYTES);
  }
  if (element.labels?.length) {
    const label = Array.from(element.labels).map((item) => visibleText(item, globalObject)).join(' ').trim();
    if (label) return boundedText(label, MAX_NAME_BYTES);
  }
  const id = element.getAttribute?.('id');
  if (id && typeof document.querySelectorAll === 'function') {
    const labels = Array.from(document.querySelectorAll('label')).filter((label) => label.getAttribute?.('for') === id);
    const label = labels.map((item) => visibleText(item, globalObject)).join(' ').trim();
    if (label) return boundedText(label, MAX_NAME_BYTES);
  }
  const alt = element.getAttribute?.('alt');
  if (alt) return boundedText(alt, MAX_NAME_BYTES);
  const title = element.getAttribute?.('title');
  if (title) return boundedText(title, MAX_NAME_BYTES);
  return boundedText(visibleText(element, globalObject), MAX_NAME_BYTES);
}

function visibleText(element, globalObject) {
  if (!element || isHidden(element, globalObject)) return '';
  const parts = [];
  const encoder = new TextEncoder();
  let remaining = MAX_NAME_BYTES;
  let visited = 0;

  function append(value) {
    if (remaining <= 0) return;
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (parts.length) remaining -= 1;
    if (remaining <= 0) return;
    const bounded = boundedText(text, remaining);
    if (!bounded) return;
    parts.push(bounded);
    remaining -= encoder.encode(bounded).length;
  }

  function visit(node, depth, root) {
    if (!node || remaining <= 0 || visited >= MAX_NAME_NODES || depth > MAX_DEPTH) return;
    visited += 1;
    if (node.nodeType === 3) {
      append(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    if (!root && (isHidden(node, globalObject) ||
        !clipRect(safeRect(node), finiteBound(globalObject.innerWidth, 0, 100_000), finiteBound(globalObject.innerHeight, 0, 100_000)))) return;
    const childNodes = Array.from(node.childNodes || []);
    if (childNodes.length) {
      for (const child of childNodes) {
        visit(child, depth + 1, false);
        if (remaining <= 0 || visited >= MAX_NAME_NODES) break;
      }
      return;
    }
    const children = Array.from(node.children || []);
    if (children.length) {
      for (const child of children) {
        visit(child, depth + 1, false);
        if (remaining <= 0 || visited >= MAX_NAME_NODES) break;
      }
      return;
    }
    append(node.textContent);
  }

  visit(element, 0, true);
  return parts.join(' ');
}

function isHidden(element, globalObject) {
  if (element.hidden === true || element.hasAttribute?.('hidden') || element.getAttribute?.('aria-hidden') === 'true') return true;
  const style = typeof globalObject.getComputedStyle === 'function' ? globalObject.getComputedStyle(element) : null;
  return style?.display === 'none' || style?.visibility === 'hidden';
}

function safeRect(element) {
  try {
    const rect = element.getBoundingClientRect?.();
    if (!rect) return null;
    const x = Number(rect.x ?? rect.left);
    const y = Number(rect.y ?? rect.top);
    const width = Number(rect.width);
    const height = Number(rect.height);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
  } catch { return null; }
}

function clipRect(rect, viewportWidth, viewportHeight) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewportWidth, rect.x + rect.width);
  const bottom = Math.min(viewportHeight, rect.y + rect.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top),
    clipped: left !== rect.x || top !== rect.y || right !== rect.x + rect.width || bottom !== rect.y + rect.height,
  };
}

function finiteBound(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(minimum, Math.min(maximum, number))) : minimum;
}

function boundedText(value, maxBytes) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let output = '';
  for (const character of text) {
    if (encoder.encode(output + character).length > maxBytes) break;
    output += character;
  }
  return output;
}

function automationError(code, message) {
  return Object.assign(new Error(message), { code });
}
