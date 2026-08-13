const SNAPSHOT_SCHEMA = 'psyche.browser.snapshot/v1';
const MAX_NODES = 2_000;
const MAX_VISITED_NODES = 2_000;
const MAX_DEPTH = 32;
const MAX_NAME_BYTES = 512;
const MAX_NAME_NODES = 2_000;
const MAX_NAME_WORK = 10_000;
const MAX_NAME_TOTAL_BYTES = 1024 * 1024;
const SNAPSHOT_TTL_MS = 30_000;
const SCRIPT_SOURCE_BYTES = 64 * 1024;
const SCRIPT_RESULT_BYTES = 256 * 1024;
const SCRIPT_TIMEOUT_MS = 5_000;
const TrustedMap = Map;
const TrustedWeakMap = WeakMap;
const TrustedSet = Set;
const textEncoder = new TextEncoder();
const encodeText = textEncoder.encode.bind(textEncoder);
const objectAssign = Object.assign.bind(Object);
const objectDefineProperty = Object.defineProperty.bind(Object);
const objectFreeze = Object.freeze.bind(Object);
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const reflectApply = Reflect.apply.bind(Reflect);
const trustedElementGetAttribute = globalThis.Element?.prototype?.getAttribute;
const trustedElementHasAttribute = globalThis.Element?.prototype?.hasAttribute;
const trustedElementGetBoundingClientRect = globalThis.Element?.prototype?.getBoundingClientRect;
const trustedDocumentGetElementById = globalThis.Document?.prototype?.getElementById;
const trustedDocumentQuerySelectorAll = globalThis.Document?.prototype?.querySelectorAll;
const trustedGetComputedStyle = globalThis.getComputedStyle?.bind(globalThis);
const trustedInputTypeGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'type')?.get;
const trustedInputValueGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'value')?.get;
const trustedInputCheckedGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'checked')?.get;
const trustedInputDisabledGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'disabled')?.get;
const trustedInputLabelsGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'labels')?.get;
const trustedTextareaValueGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, 'value')?.get;
const trustedTextareaDisabledGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, 'disabled')?.get;
const trustedTextareaLabelsGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, 'labels')?.get;
const trustedSelectValueGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, 'value')?.get;
const trustedSelectDisabledGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, 'disabled')?.get;
const trustedSelectLabelsGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, 'labels')?.get;
const trustedOptionSelectedGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLOptionElement?.prototype || {}, 'selected')?.get;
const trustedNodeIsConnectedGetter = objectGetOwnPropertyDescriptor(globalThis.Node?.prototype || {}, 'isConnected')?.get;
const trustedElementTagNameGetter = objectGetOwnPropertyDescriptor(globalThis.Element?.prototype || {}, 'tagName')?.get;
const trustedElementChildrenGetter = objectGetOwnPropertyDescriptor(globalThis.Element?.prototype || {}, 'children')?.get;
const trustedParentElementGetter = objectGetOwnPropertyDescriptor(globalThis.Node?.prototype || {}, 'parentElement')?.get;
const trustedButtonDisabledGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLButtonElement?.prototype || {}, 'disabled')?.get;
const trustedButtonTypeGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLButtonElement?.prototype || {}, 'type')?.get;
const trustedButtonFormGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLButtonElement?.prototype || {}, 'form')?.get;
const trustedInputFormGetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'form')?.get;
const trustedHTMLElementClick = globalThis.HTMLElement?.prototype?.click;
const trustedHTMLElementFocus = globalThis.HTMLElement?.prototype?.focus;
const trustedDispatchEvent = globalThis.EventTarget?.prototype?.dispatchEvent;
const trustedRequestSubmit = globalThis.HTMLFormElement?.prototype?.requestSubmit;
const trustedInputValueSetter = objectGetOwnPropertyDescriptor(globalThis.HTMLInputElement?.prototype || {}, 'value')?.set;
const trustedTextareaValueSetter = objectGetOwnPropertyDescriptor(globalThis.HTMLTextAreaElement?.prototype || {}, 'value')?.set;
const trustedSelectValueSetter = objectGetOwnPropertyDescriptor(globalThis.HTMLSelectElement?.prototype || {}, 'value')?.set;
const trustedOptionSelectedSetter = objectGetOwnPropertyDescriptor(globalThis.HTMLOptionElement?.prototype || {}, 'selected')?.set;
const TrustedEvent = globalThis.Event;
const TrustedInputEvent = globalThis.InputEvent;
const INSTALLED = new TrustedWeakMap();

const INTERACTIVE_TAGS = new TrustedSet(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'IFRAME']);
const ALLOWED_ROLES = new TrustedSet(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'frame', 'img', 'heading', 'status', 'dialog', 'menu', 'menuitem', 'tab', 'tabpanel', 'switch']);

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
    if (request.type === 'action') {
      if (!request.action || typeof request.action !== 'object' || Array.isArray(request.action)) {
        throw automationError('bad_request', 'bad_request: browser action is invalid');
      }
      if (request.action.kind === 'permission_response') {
        assertActionRequest(request.action);
        throw automationError('backend_unavailable', 'backend_unavailable: native interception is required');
      }
      assertActionRequest(request.action);
      const target = requireCurrent({ snapshotId: request.snapshotId, ref: request.action.elementRef });
      assertActionTarget(target.element, target.semantic, current, globalObject);
      const result = performAction(target.element, target.semantic, request.action, globalObject);
      if (result.invalidate === true) invalidate();
      const { invalidate: _invalidate, ...boundedResult } = result;
      return boundedResult;
    }
    if (request.type === 'script') return runScript(request, globalObject, now);
    if (request.type !== 'resolve') {
      throw automationError('unsupported_operation', 'unsupported_operation: automation operation is not allowed');
    }
    const target = requireCurrent(request);
    if (request.type === 'resolve') return { ...target.semantic };
    throw automationError('unsupported_operation', 'unsupported_operation: automation operation is not allowed');
  }

  const api = { schema: 'psyche.browser.automation/v1', dispatch, invalidate };
  if (options.installNonce) objectDefineProperty(api, '__psycheInstallNonce', { value: options.installNonce });
  objectFreeze(api);
  objectDefineProperty(globalObject, '__PSYCHE_AUTOMATION__', {
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
  const installNonce = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `(function(globalObject){
    var existing=globalObject.__PSYCHE_AUTOMATION__;
    var installNonce=${JSON.stringify(installNonce)};
    if (existing && existing.__psycheInstallNonce===installNonce) return;
    if (existing) delete globalObject.__PSYCHE_AUTOMATION__;
    const SNAPSHOT_SCHEMA=${JSON.stringify(SNAPSHOT_SCHEMA)};
    const MAX_NODES=${MAX_NODES}; const MAX_VISITED_NODES=${MAX_VISITED_NODES}; const MAX_DEPTH=${MAX_DEPTH}; const MAX_NAME_BYTES=${MAX_NAME_BYTES};
    const MAX_NAME_NODES=${MAX_NAME_NODES};
    const MAX_NAME_WORK=${MAX_NAME_WORK}; const MAX_NAME_TOTAL_BYTES=${MAX_NAME_TOTAL_BYTES};
    const TrustedMap=Map; const TrustedWeakMap=WeakMap; const TrustedSet=Set;
    const textEncoder=new TextEncoder(); const encodeText=textEncoder.encode.bind(textEncoder);
    const objectAssign=Object.assign.bind(Object); const objectDefineProperty=Object.defineProperty.bind(Object); const objectFreeze=Object.freeze.bind(Object); const objectGetOwnPropertyDescriptor=Object.getOwnPropertyDescriptor.bind(Object);
    const reflectApply=Reflect.apply.bind(Reflect);
    const trustedElementGetAttribute=globalObject.Element?.prototype?.getAttribute;
    const trustedElementHasAttribute=globalObject.Element?.prototype?.hasAttribute;
    const trustedElementGetBoundingClientRect=globalObject.Element?.prototype?.getBoundingClientRect;
    const trustedDocumentGetElementById=globalObject.Document?.prototype?.getElementById;
    const trustedDocumentQuerySelectorAll=globalObject.Document?.prototype?.querySelectorAll;
    const trustedGetComputedStyle=globalObject.getComputedStyle?.bind(globalObject);
    const trustedInputTypeGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'type')?.get;
    const trustedInputValueGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'value')?.get;
    const trustedInputCheckedGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'checked')?.get;
    const trustedInputDisabledGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'disabled')?.get;
    const trustedInputLabelsGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'labels')?.get;
    const trustedTextareaValueGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLTextAreaElement?.prototype||{},'value')?.get;
    const trustedTextareaDisabledGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLTextAreaElement?.prototype||{},'disabled')?.get;
    const trustedTextareaLabelsGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLTextAreaElement?.prototype||{},'labels')?.get;
    const trustedSelectValueGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLSelectElement?.prototype||{},'value')?.get;
    const trustedSelectDisabledGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLSelectElement?.prototype||{},'disabled')?.get;
    const trustedSelectLabelsGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLSelectElement?.prototype||{},'labels')?.get;
    const trustedOptionSelectedGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLOptionElement?.prototype||{},'selected')?.get;
    const trustedNodeIsConnectedGetter=objectGetOwnPropertyDescriptor(globalObject.Node?.prototype||{},'isConnected')?.get;
    const trustedElementTagNameGetter=objectGetOwnPropertyDescriptor(globalObject.Element?.prototype||{},'tagName')?.get;
    const trustedElementChildrenGetter=objectGetOwnPropertyDescriptor(globalObject.Element?.prototype||{},'children')?.get;
    const trustedParentElementGetter=objectGetOwnPropertyDescriptor(globalObject.Node?.prototype||{},'parentElement')?.get;
    const trustedButtonDisabledGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLButtonElement?.prototype||{},'disabled')?.get;
    const trustedButtonTypeGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLButtonElement?.prototype||{},'type')?.get;
    const trustedButtonFormGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLButtonElement?.prototype||{},'form')?.get;
    const trustedInputFormGetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'form')?.get;
    const trustedHTMLElementClick=globalObject.HTMLElement?.prototype?.click;
    const trustedHTMLElementFocus=globalObject.HTMLElement?.prototype?.focus;
    const trustedDispatchEvent=globalObject.EventTarget?.prototype?.dispatchEvent;
    const trustedRequestSubmit=globalObject.HTMLFormElement?.prototype?.requestSubmit;
    const trustedInputValueSetter=objectGetOwnPropertyDescriptor(globalObject.HTMLInputElement?.prototype||{},'value')?.set;
    const trustedTextareaValueSetter=objectGetOwnPropertyDescriptor(globalObject.HTMLTextAreaElement?.prototype||{},'value')?.set;
    const trustedSelectValueSetter=objectGetOwnPropertyDescriptor(globalObject.HTMLSelectElement?.prototype||{},'value')?.set;
    const trustedOptionSelectedSetter=objectGetOwnPropertyDescriptor(globalObject.HTMLOptionElement?.prototype||{},'selected')?.set;
    const TrustedEvent=globalObject.Event; const TrustedInputEvent=globalObject.InputEvent;
    const SNAPSHOT_TTL_MS=${SNAPSHOT_TTL_MS}; const INSTALLED=new TrustedWeakMap();
    const SCRIPT_SOURCE_BYTES=${SCRIPT_SOURCE_BYTES}; const SCRIPT_RESULT_BYTES=${SCRIPT_RESULT_BYTES}; const SCRIPT_TIMEOUT_MS=${SCRIPT_TIMEOUT_MS};
    const INTERACTIVE_TAGS=new TrustedSet(${JSON.stringify([...INTERACTIVE_TAGS])});
    const ALLOWED_ROLES=new TrustedSet(${JSON.stringify([...ALLOWED_ROLES])});
    ${automationError.toString()}
    ${readAttribute.toString()}
    ${hasAttribute.toString()}
    ${readRect.toString()}
    ${findElementById.toString()}
    ${selectElements.toString()}
    ${computedStyle.toString()}
    ${readWebIdl.toString()}
    ${readInputType.toString()}
    ${consumeNameWork.toString()}
    ${boundedText.toString()}
    ${finiteBound.toString()}
    ${clipRect.toString()}
    ${safeRect.toString()}
    ${isHidden.toString()}
    ${visibleText.toString()}
    ${cachedVisibleText.toString()}
    ${accessibleName.toString()}
    ${roleFor.toString()}
    ${semanticNode.toString()}
    ${assertActionRequest.toString()}
    ${assertActionTarget.toString()}
    ${actionTargetSemantics.toString()}
    ${readTagName.toString()}
    ${readChildren.toString()}
    ${readConnected.toString()}
    ${readForm.toString()}
    ${invokeTrusted.toString()}
    ${containsStoredElement.toString()}
    ${dispatchInputEvent.toString()}
    ${performAction.toString()}
    ${submitMetadata.toString()}
    ${assertJsonValue.toString()}
    ${runScript.toString()}
    ${captureSnapshot.toString()}
    ${installBrowserAutomation.toString()}
    installBrowserAutomation(globalObject,{installNonce:installNonce});
  })(globalThis);`;
}

function assertJsonValue(value, seen, depth = 0) {
  if (depth > 64) throw automationError('serialization_failed', 'serialization_failed: result nesting exceeds maximum');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw automationError('serialization_failed', 'serialization_failed: result contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') throw automationError('serialization_failed', 'serialization_failed: result is not JSON data');
  if (seen.has(value)) throw automationError('serialization_failed', 'serialization_failed: result contains a cycle');
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw automationError('serialization_failed', 'serialization_failed: result contains a native object');
  }
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const item of entries) assertJsonValue(item, seen, depth + 1);
  seen.delete(value);
}

async function runScript(request, globalObject, now) {
  if (typeof request.source !== 'string' || encodeText(request.source).length > SCRIPT_SOURCE_BYTES) {
    throw automationError('script_source_too_large', 'script_source_too_large: browser script source exceeds maximum');
  }
  const startedAt = now();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(automationError('action_timeout', 'action_timeout: browser script exceeded five seconds')), SCRIPT_TIMEOUT_MS);
  });
  let value;
  try {
    const execute = Function('args', `"use strict"; return (async()=>{${request.source}\n})();`);
    value = await Promise.race([Promise.resolve().then(() => execute(request.args)), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
  assertJsonValue(value, new WeakSet());
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw automationError('serialization_failed', 'serialization_failed: result cannot be encoded'); }
  if (encoded === undefined) throw automationError('serialization_failed', 'serialization_failed: result is not JSON data');
  const resultBytes = encodeText(encoded).length;
  if (resultBytes > SCRIPT_RESULT_BYTES) throw automationError('result_too_large', 'result_too_large: browser script result exceeds maximum');
  let parsed;
  try { parsed = JSON.parse(encoded); }
  catch { throw automationError('serialization_failed', 'serialization_failed: result cannot be decoded'); }
  return { value: parsed, resultBytes, durationMs: Math.max(0, now() - startedAt) };
}

function assertActionRequest(action) {
  const allowedByKind = {
    click: ['kind', 'elementRef'],
    type: ['kind', 'elementRef', 'text', 'append'],
    select: ['kind', 'elementRef', 'values'],
    scroll: ['kind', 'elementRef', 'deltaX', 'deltaY'],
    focus: ['kind', 'elementRef'],
    submit: ['kind', 'elementRef'],
    upload: ['kind', 'elementRef', 'path'],
    download: ['kind', 'elementRef', 'destination'],
    permission_response: ['kind', 'permission', 'origin', 'decision'],
  };
  const allowed = allowedByKind[action.kind];
  if (!allowed || Object.keys(action).some((key) => !allowed.includes(key))) {
    throw automationError('bad_request', 'bad_request: browser action shape is invalid');
  }
  if (action.kind !== 'permission_response' && (typeof action.elementRef !== 'string' || !action.elementRef)) {
    throw automationError('bad_request', 'bad_request: element reference is required');
  }
  if (action.kind === 'type' && typeof action.text !== 'string') throw automationError('bad_request', 'bad_request: text is required');
  if (action.kind === 'select' && (!Array.isArray(action.values) || action.values.some((value) => typeof value !== 'string'))) {
    throw automationError('bad_request', 'bad_request: select values are invalid');
  }
  if (action.kind === 'scroll' && [action.deltaX, action.deltaY].some((value) => value !== undefined && !Number.isFinite(value))) {
    throw automationError('bad_request', 'bad_request: scroll deltas are invalid');
  }
}

function assertActionTarget(element, semantic, current, globalObject) {
  const next = actionTargetSemantics(element, globalObject);
  if (!element || !readConnected(element) || !containsStoredElement(current.documentElement, element)
      || isHidden(element, globalObject) || next.role !== semantic?.role
      || next.disabled !== (semantic?.disabled === true) || next.submit !== (semantic?.submit === true)
      || next.submitMethod !== semantic?.submitMethod || next.submitDestination !== semantic?.submitDestination
      || next.secret !== (semantic?.secret === true)) {
    throw automationError('target_changed', 'target_changed: semantic target changed before dispatch');
  }
}

function actionTargetSemantics(element, globalObject) {
  const tag = readTagName(element);
  const inputType = tag === 'INPUT' ? readInputType(element) : '';
  const buttonType = tag === 'BUTTON' ? String(readWebIdl(trustedButtonTypeGetter, element, 'type') || '').toLowerCase() : inputType;
  const form = readForm(element, tag);
  const disabledGetter = tag === 'BUTTON' ? trustedButtonDisabledGetter : tag === 'INPUT' ? trustedInputDisabledGetter
    : tag === 'TEXTAREA' ? trustedTextareaDisabledGetter : tag === 'SELECT' ? trustedSelectDisabledGetter : null;
  const submit = (tag === 'BUTTON' || tag === 'INPUT') && (buttonType === 'submit' || (tag === 'BUTTON' && !buttonType && !!form));
  const metadata = submit ? submitMetadata(element, globalObject) : null;
  return {
    role: roleFor(element, tag),
    disabled: readWebIdl(disabledGetter, element, 'disabled') === true || hasAttribute(element, 'disabled') || readAttribute(element, 'aria-disabled') === 'true',
    submit,
    ...(metadata ? { submitMethod: metadata.method, submitDestination: metadata.destination } : {}),
    secret: tag === 'INPUT' && (!inputType || inputType === 'password'),
  };
}
function readTagName(element) { return String(readWebIdl(trustedElementTagNameGetter, element, 'tagName') || '').toUpperCase(); }
function readChildren(element) { return readWebIdl(trustedElementChildrenGetter, element, 'children') || []; }
function readConnected(element) { return readWebIdl(trustedNodeIsConnectedGetter, element, 'isConnected') !== false; }
function readForm(element, tag) { return readWebIdl(tag === 'BUTTON' ? trustedButtonFormGetter : tag === 'INPUT' ? trustedInputFormGetter : null, element, 'form') || null; }
function invokeTrusted(method, receiver, args, fallback) {
  if (typeof method === 'function' && trustedElementTagNameGetter) return reflectApply(method, receiver, args);
  if (typeof receiver?.[fallback] === 'function') return receiver[fallback](...args);
  throw automationError('backend_unavailable', `backend_unavailable: ${fallback} is unavailable`);
}

function containsStoredElement(root, target) {
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < MAX_VISITED_NODES) {
    const item = stack.pop();
    visited += 1;
    if (item === target) return true;
    const children = readChildren(item);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return false;
}

function dispatchInputEvent(element, globalObject, type, init) {
  const EventCtor = TrustedInputEvent || TrustedEvent;
  if (typeof EventCtor !== 'function') throw automationError('backend_unavailable', 'backend_unavailable: browser events are unavailable');
  invokeTrusted(trustedDispatchEvent, element, [new EventCtor(type, { bubbles: true, cancelable: type === 'beforeinput', ...init })], 'dispatchEvent');
}

function performAction(element, semantic, action, globalObject) {
  switch (action.kind) {
    case 'click': {
      invokeTrusted(trustedHTMLElementClick, element, [], 'click');
      return { clicked: true, invalidate: true };
    }
    case 'type': {
      const tag = readTagName(element);
      if (!['INPUT', 'TEXTAREA'].includes(tag)) {
        throw automationError('target_unavailable', 'target_unavailable: target is not editable');
      }
      const secret = semantic?.secret === true;
      const previousValue = readWebIdl(tag === 'INPUT' ? trustedInputValueGetter : trustedTextareaValueGetter, element, 'value');
      const previous = typeof previousValue === 'string' ? previousValue : '';
      const next = action.append === true ? previous + action.text : action.text;
      invokeTrusted(trustedHTMLElementFocus, element, [], 'focus');
      dispatchInputEvent(element, globalObject, 'beforeinput', { data: action.text, inputType: action.append === true ? 'insertText' : 'insertReplacementText' });
      const setter = tag === 'INPUT' ? trustedInputValueSetter : trustedTextareaValueSetter;
      if (setter) reflectApply(setter, element, [next]); else element.value = next;
      dispatchInputEvent(element, globalObject, 'input', { data: action.text, inputType: 'insertText' });
      dispatchInputEvent(element, globalObject, 'change');
      return secret ? { valuePresent: next.length > 0, secret: true } : { value: boundedText(next, MAX_NAME_BYTES), secret: false };
    }
    case 'select': {
      if (readTagName(element) !== 'SELECT') throw automationError('target_unavailable', 'target_unavailable: target is not a select');
      const wanted = new TrustedSet(action.values);
      const selectedValues = [];
      for (const option of element.options || readChildren(element)) {
        const value = String(option.value ?? readAttribute(option, 'value') ?? option.textContent ?? '');
        const selected = wanted.has(value);
        if (trustedOptionSelectedSetter && trustedElementTagNameGetter) reflectApply(trustedOptionSelectedSetter, option, [selected]); else option.selected = selected;
        if (selected && selectedValues.length < 128) selectedValues.push(boundedText(value, MAX_NAME_BYTES));
      }
      if (!element.multiple && selectedValues.length) {
        if (trustedSelectValueSetter && trustedElementTagNameGetter) reflectApply(trustedSelectValueSetter, element, [selectedValues[0]]); else element.value = selectedValues[0];
      }
      dispatchInputEvent(element, globalObject, 'input');
      dispatchInputEvent(element, globalObject, 'change');
      return semantic?.secret === true ? { selectedValues: ['[redacted]'] } : { selectedValues };
    }
    case 'scroll': {
      const dx = finiteBound(action.deltaX || 0, -100_000, 100_000);
      const dy = finiteBound(action.deltaY || 0, -100_000, 100_000);
      element.scrollLeft = finiteBound(Number(element.scrollLeft || 0) + dx, -100_000, 100_000);
      element.scrollTop = finiteBound(Number(element.scrollTop || 0) + dy, -100_000, 100_000);
      return { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop };
    }
    case 'focus':
      invokeTrusted(trustedHTMLElementFocus, element, [], 'focus');
      return { focused: true };
    case 'submit': {
      const metadata = submitMetadata(element, globalObject);
      if (!metadata.form || (typeof trustedRequestSubmit !== 'function' && typeof metadata.form.requestSubmit !== 'function')) {
        throw automationError('backend_unavailable', 'backend_unavailable: native form submission is unavailable');
      }
      invokeTrusted(trustedRequestSubmit, metadata.form, [element], 'requestSubmit');
      return { submitted: true, method: metadata.method, destination: metadata.destination, invalidate: true };
    }
    case 'upload':
    case 'download':
    case 'permission_response':
      throw automationError('backend_unavailable', 'backend_unavailable: native interception is required');
    default:
      throw automationError('unsupported_operation', 'unsupported_operation: browser action is not supported');
  }
}

function submitMetadata(element, globalObject) {
  const tag = readTagName(element);
  const form = readForm(element, tag) || (tag === 'FORM' ? element : null);
  if (!form) throw automationError('target_unavailable', 'target_unavailable: submit target has no form');
  const method = String(readAttribute(element, 'formmethod') || readAttribute(form, 'method') || 'get').toUpperCase().slice(0, 16);
  const rawAction = readAttribute(element, 'formaction') || readAttribute(form, 'action') || globalObject.location?.href || '';
  let destination;
  try { destination = String(new globalObject.URL(rawAction, globalObject.location?.href).href).slice(0, 2048); }
  catch { throw automationError('target_unavailable', 'target_unavailable: form destination is invalid'); }
  return { form, method, destination };
}

function captureSnapshot(globalObject, sequence, createdAt) {
  const document = globalObject.document;
  if (!document?.documentElement) throw automationError('backend_unavailable', 'backend_unavailable: document is unavailable');
  const viewportWidth = finiteBound(globalObject.innerWidth, 0, 100_000);
  const viewportHeight = finiteBound(globalObject.innerHeight, 0, 100_000);
  const nodes = [];
  const refs = new TrustedMap();
  const root = document.body || document.documentElement;
  const labelsByFor = new TrustedMap();
  const referencedText = new TrustedMap();
  const labelTextByFor = new TrustedMap();
  const visibleTextCache = new TrustedWeakMap();
  const nameBudget = { nodes: MAX_NAME_WORK, bytes: MAX_NAME_TOTAL_BYTES, truncated: false };
  let labelIndexExhausted = false;
  if (trustedDocumentQuerySelectorAll || typeof document.querySelectorAll === 'function') {
    let indexedLabels = 0;
    const labelList = selectElements(document, 'label');
    const labelIterator = labelList[Symbol.iterator]();
    while (indexedLabels < MAX_VISITED_NODES) {
      const nextLabel = labelIterator.next();
      if (nextLabel.done) break;
      const label = nextLabel.value;
      indexedLabels += 1;
      const target = readAttribute(label, 'for');
      if (target && !labelsByFor.has(target)) labelsByFor.set(target, []);
      if (target) labelsByFor.get(target).push(label);
    }
    labelIndexExhausted = typeof labelList.length === 'number'
      ? labelList.length > indexedLabels
      : indexedLabels === MAX_VISITED_NODES;
  }

  let visited = 0;
  let truncated = false;
  const stack = root ? [{ element: root, depth: 0, entered: false, iterator: null }] : [];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame.entered) {
      if (visited >= MAX_VISITED_NODES) { truncated = true; break; }
      visited += 1;
      frame.entered = true;
      const hidden = isHidden(frame.element, globalObject);
      if (!hidden) {
        const semantic = semanticNode(frame.element, document, viewportWidth, viewportHeight, globalObject, labelsByFor, referencedText, labelTextByFor, visibleTextCache, nameBudget);
        if (semantic && nodes.length < MAX_NODES) {
          const ref = `e${nodes.length + 1}`;
          nodes.push({ ref, ...semantic });
          refs.set(ref, frame.element);
        }
      }
      const children = readChildren(frame.element);
      if (hidden) { stack.pop(); continue; }
      if (frame.depth === MAX_DEPTH) {
        if (children.length) truncated = true;
        stack.pop();
        continue;
      }
      frame.iterator = children[Symbol.iterator]();
    }
    const next = frame.iterator.next();
    if (next.done) { stack.pop(); continue; }
    stack.push({ element: next.value, depth: frame.depth + 1, entered: false, iterator: null });
  }

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
      truncated: truncated || labelIndexExhausted || nameBudget.truncated,
    },
  };
}

function semanticNode(element, document, viewportWidth, viewportHeight, globalObject, labelsByFor, referencedText, labelTextByFor, visibleTextCache, nameBudget) {
  const tag = readTagName(element);
  const role = roleFor(element, tag);
  if (!role) return null;
  const rect = safeRect(element);
  const clipped = clipRect(rect, viewportWidth, viewportHeight);
  if (!clipped && !INTERACTIVE_TAGS.has(tag)) return null;
  const name = accessibleName(element, document, globalObject, labelsByFor, referencedText, labelTextByFor, visibleTextCache, nameBudget);
  const result = { role, name, bounds: clipped || { x: 0, y: 0, width: 0, height: 0, clipped: true } };
  const disabledGetter = tag === 'BUTTON' ? trustedButtonDisabledGetter
    : tag === 'INPUT' ? trustedInputDisabledGetter
    : tag === 'TEXTAREA' ? trustedTextareaDisabledGetter
      : tag === 'SELECT' ? trustedSelectDisabledGetter : null;
  if (readWebIdl(disabledGetter, element, 'disabled') === true || hasAttribute(element, 'disabled') || readAttribute(element, 'aria-disabled') === 'true') result.disabled = true;
  if (role === 'button') {
    const buttonType = tag === 'INPUT' ? readInputType(element) : boundedText(readAttribute(element, 'type') || '', 64).toLowerCase();
    result.submit = buttonType === 'submit' || (tag === 'BUTTON' && !buttonType && !!readForm(element, tag));
    if (result.submit) {
      const metadata = submitMetadata(element, globalObject);
      result.submitMethod = metadata.method;
      result.submitDestination = metadata.destination;
    }
  }
  if (role === 'checkbox' || role === 'radio') result.checked = readWebIdl(trustedInputCheckedGetter, element, 'checked') === true || readAttribute(element, 'aria-checked') === 'true';
  if (role === 'option') result.selected = readWebIdl(trustedOptionSelectedGetter, element, 'selected') === true || readAttribute(element, 'aria-selected') === 'true';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const inputType = tag === 'INPUT' ? readInputType(element) : '';
    const secret = tag === 'INPUT' && (!inputType || inputType === 'password');
    const value = tag === 'INPUT'
      ? readWebIdl(trustedInputValueGetter, element, 'value')
      : tag === 'TEXTAREA'
        ? readWebIdl(trustedTextareaValueGetter, element, 'value')
        : readWebIdl(trustedSelectValueGetter, element, 'value');
    if (secret) {
      result.secret = true;
      result.valuePresent = typeof value === 'string' && value.length > 0;
    } else if (typeof value === 'string') {
      result.value = boundedText(value, MAX_NAME_BYTES);
    }
  }
  if (tag === 'IFRAME' || tag === 'FRAME') result.opaque = true;
  return result;
}

function roleFor(element, tag) {
  const explicit = boundedText(readAttribute(element, 'role') || '', 64).toLowerCase();
  if (explicit) {
    for (const token of explicit.split(/\s+/)) if (ALLOWED_ROLES.has(token)) return token;
    return null;
  }
  if (tag === 'BUTTON') return 'button';
  if (tag === 'A' && readAttribute(element, 'href')) return 'link';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return 'combobox';
  if (tag === 'OPTION') return 'option';
  if (tag === 'IFRAME' || tag === 'FRAME') return 'frame';
  if (tag === 'IMG' && readAttribute(element, 'alt')) return 'img';
  if (tag === 'INPUT') {
    const type = readInputType(element);
    if (!type) return 'textbox';
    if (type === 'hidden') return null;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    return 'textbox';
  }
  return null;
}

function accessibleName(element, document, globalObject, labelsByFor, referencedText, labelTextByFor, visibleTextCache, nameBudget) {
  const direct = readAttribute(element, 'aria-label');
  if (direct) return boundedText(direct, MAX_NAME_BYTES);
  const labelledBy = String(readAttribute(element, 'aria-labelledby') || '').trim();
  if (labelledBy) {
    if (nameBudget.nodes <= 0) {
      nameBudget.truncated = true;
      return '';
    }
    const parts = [];
    let references = 0;
    for (const match of labelledBy.slice(0, 65536).matchAll(/\S+/g)) {
      if (!consumeNameWork(nameBudget)) break;
      if (references++ >= MAX_NAME_NODES) break;
      if (!referencedText.has(match[0])) referencedText.set(match[0], cachedVisibleText(findElementById(document, match[0]), globalObject, nameBudget, visibleTextCache));
      const text = referencedText.get(match[0]);
      if (text) parts.push(text);
      if (encodeText(boundedText(parts.join(' '), MAX_NAME_BYTES)).length >= MAX_NAME_BYTES) break;
    }
    const label = boundedText(parts.join(' '), MAX_NAME_BYTES);
    if (label) return boundedText(label, MAX_NAME_BYTES);
  }
  const tag = readTagName(element);
  const labelsGetter = tag === 'INPUT' ? trustedInputLabelsGetter
    : tag === 'TEXTAREA' ? trustedTextareaLabelsGetter
      : tag === 'SELECT' ? trustedSelectLabelsGetter : null;
  const labels = nameBudget.nodes > 0 ? readWebIdl(labelsGetter, element, 'labels') : null;
  if (labels?.length) {
    const parts = [];
    let references = 0;
    for (const item of labels) {
      if (!consumeNameWork(nameBudget)) break;
      if (references++ >= MAX_NAME_NODES) break;
      const text = cachedVisibleText(item, globalObject, nameBudget, visibleTextCache);
      if (text) parts.push(text);
      if (encodeText(boundedText(parts.join(' '), MAX_NAME_BYTES)).length >= MAX_NAME_BYTES) break;
    }
    const label = boundedText(parts.join(' '), MAX_NAME_BYTES);
    if (label) return boundedText(label, MAX_NAME_BYTES);
  }
  const id = readAttribute(element, 'id');
  if (id) {
    if (!labelTextByFor.has(id)) {
      const parts = [];
      let references = 0;
      for (const item of labelsByFor.get(id) || []) {
        if (references++ >= MAX_NAME_NODES) break;
        const text = cachedVisibleText(item, globalObject, nameBudget, visibleTextCache);
        if (text) parts.push(text);
        if (encodeText(boundedText(parts.join(' '), MAX_NAME_BYTES)).length >= MAX_NAME_BYTES) break;
      }
      labelTextByFor.set(id, boundedText(parts.join(' '), MAX_NAME_BYTES));
    }
    const label = labelTextByFor.get(id);
    if (label) return boundedText(label, MAX_NAME_BYTES);
  }
  const alt = readAttribute(element, 'alt');
  if (alt) return boundedText(alt, MAX_NAME_BYTES);
  const title = readAttribute(element, 'title');
  if (title) return boundedText(title, MAX_NAME_BYTES);
  return boundedText(cachedVisibleText(element, globalObject, nameBudget, visibleTextCache), MAX_NAME_BYTES);
}

function cachedVisibleText(element, globalObject, budget, cache) {
  if (!element || (typeof element !== 'object' && typeof element !== 'function')) return '';
  if (cache.has(element)) return cache.get(element);
  const text = visibleText(element, globalObject, budget);
  cache.set(element, text);
  return text;
}

function visibleText(element, globalObject, budget) {
  if (!element) return '';
  if (budget.nodes <= 0 || budget.bytes <= 0) {
    budget.truncated = true;
    return '';
  }
  if (isHidden(element, globalObject)) return '';
  const parts = [];
  let remaining = MAX_NAME_BYTES;
  let visited = 0;

  function append(value) {
    if (remaining <= 0 || budget.bytes <= 0) { budget.truncated = true; return; }
    const text = boundedText(value, Math.min(remaining, budget.bytes));
    if (!text) return;
    if (parts.length) remaining -= 1;
    if (remaining <= 0) return;
    const bounded = boundedText(text, remaining);
    if (!bounded) return;
    parts.push(bounded);
    const used = encodeText(bounded).length;
    remaining -= used;
    budget.bytes -= used;
  }

  function visit(node, depth, root) {
    if (!node || remaining <= 0 || visited >= MAX_NAME_NODES || depth > MAX_DEPTH) return;
    if (budget.nodes <= 0) { budget.truncated = true; return; }
    budget.nodes -= 1;
    visited += 1;
    if (node.nodeType === 3) {
      append(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    if (!root && (isHidden(node, globalObject) ||
        !clipRect(safeRect(node), finiteBound(globalObject.innerWidth, 0, 100_000), finiteBound(globalObject.innerHeight, 0, 100_000)))) return;
    const childNodes = node.childNodes || [];
    if (childNodes.length) {
      for (const child of childNodes) {
        visit(child, depth + 1, false);
        if (remaining <= 0 || visited >= MAX_NAME_NODES) break;
      }
      return;
    }
    const children = node.children || [];
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

function consumeNameWork(budget) {
  if (budget.nodes <= 0) {
    budget.truncated = true;
    return false;
  }
  budget.nodes -= 1;
  return true;
}

function isHidden(element, globalObject) {
  let current = element;
  for (let depth = 0; current && depth <= MAX_DEPTH; depth += 1, current = readWebIdl(trustedParentElementGetter, current, 'parentElement')) {
    if (current.hidden === true || hasAttribute(current, 'hidden') || readAttribute(current, 'aria-hidden') === 'true') return true;
    const style = computedStyle(current, globalObject);
    if (style?.display === 'none' || style?.visibility === 'hidden') return true;
  }
  return false;
}

function safeRect(element) {
  try {
    const rect = readRect(element);
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
  const source = String(value || '');
  let output = '';
  let bytes = 0;
  let pendingSpace = false;
  for (const character of source) {
    if (/\s/.test(character)) {
      if (output) pendingSpace = true;
      continue;
    }
    const prefix = pendingSpace && output ? ' ' : '';
    const characterBytes = encodeText(prefix + character).length;
    if (bytes + characterBytes > maxBytes) break;
    output += prefix + character;
    bytes += characterBytes;
    pendingSpace = false;
  }
  return output;
}

function readAttribute(element, name) {
  try {
    if (trustedElementGetAttribute) return reflectApply(trustedElementGetAttribute, element, [name]);
  } catch {}
  return element?.getAttribute?.(name) ?? null;
}

function hasAttribute(element, name) {
  try {
    if (trustedElementHasAttribute) return reflectApply(trustedElementHasAttribute, element, [name]);
  } catch {}
  return element?.hasAttribute?.(name) === true;
}

function readRect(element) {
  try {
    if (trustedElementGetBoundingClientRect) return reflectApply(trustedElementGetBoundingClientRect, element, []);
  } catch {}
  return element?.getBoundingClientRect?.() ?? null;
}

function findElementById(document, id) {
  try {
    if (trustedDocumentGetElementById) return reflectApply(trustedDocumentGetElementById, document, [id]);
  } catch {}
  return document?.getElementById?.(id) ?? null;
}

function selectElements(document, selector) {
  try {
    if (trustedDocumentQuerySelectorAll) return reflectApply(trustedDocumentQuerySelectorAll, document, [selector]);
  } catch {}
  return document.querySelectorAll(selector);
}

function computedStyle(element, globalObject) {
  try {
    if (trustedGetComputedStyle) return trustedGetComputedStyle(element);
  } catch {}
  return typeof globalObject.getComputedStyle === 'function' ? globalObject.getComputedStyle(element) : null;
}

function readWebIdl(getter, element, fallbackProperty) {
  try {
    if (getter) return reflectApply(getter, element, []);
  } catch {
    return undefined;
  }
  return element?.[fallbackProperty];
}

function readInputType(element) {
  const attribute = readAttribute(element, 'type');
  if (attribute !== null) return boundedText(attribute, 64).toLowerCase();
  const nativeType = readWebIdl(trustedInputTypeGetter, element, 'type');
  return typeof nativeType === 'string' ? boundedText(nativeType, 64).toLowerCase() : '';
}

function automationError(code, message) {
  return objectAssign(new Error(message), { code });
}
