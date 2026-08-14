(async function browserScriptRuntime(input) {
"use strict";
const $JSON = JSON;
const $Number = Number;
const $TextEncoder = TextEncoder;
const $performance = performance;
const $jsonStringify = $JSON.stringify;
const $numberIsFinite = $Number.isFinite;
const $textEncode = $TextEncoder.prototype.encode;
const $now = $performance.now;
const $apply = Reflect.apply;
const $getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const $elementGetAttribute = typeof Element === "function"
  ? $getOwnPropertyDescriptor(Element.prototype, "getAttribute").value
  : null;
const $inputValueGetter = typeof HTMLInputElement === "function"
  ? $getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get
  : null;
const $textAreaValueGetter = typeof HTMLTextAreaElement === "function"
  ? $getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").get
  : null;
const $selectValueGetter = typeof HTMLSelectElement === "function"
  ? $getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").get
  : null;
const encoder = new $TextEncoder();
const started = Reflect.apply($now, $performance, []);
const stringify = (value) => Reflect.apply($jsonStringify, $JSON, [value]);
const textEncode = (value) => Reflect.apply($textEncode, encoder, [value]);
const fail = (code) => stringify({ ok: false, code });
const LIMITS = Object.freeze({
  snapshotNodes: 2048,
  snapshotDepth: 64,
  snapshotName: 256,
  nodeText: 2048,
  snapshotBytes: 262144,
  mutations: 256,
  mutationBytes: 262144,
  mutationValue: 65536,
  workerTimeoutMs: 4000,
});
const SAFE_ATTRIBUTES = /^(?:aria-[a-z0-9_.:-]+|title|alt|placeholder|role|name)$/;
const SAFE_BOOLEAN_PROPERTIES = new Set(["disabled", "readOnly"]);
const SAFE_FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const BLOCKED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK"]);
const SENSITIVE_INPUT_TYPES = new Set(["file", "hidden", "password"]);
const SENSITIVE_AUTOCOMPLETE = new Set([
  "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-number",
  "current-password", "new-password", "one-time-code",
]);
const DOCUMENT_CONTEXT_KEY = "__PSYCHE_BROWSER_SCRIPT_DOCUMENT_CONTEXT__";

const encodeSuccess = (value) => {
  const json = stringify(value);
  if (typeof json !== "string") return fail("serialization_failed");
  const byteCount = textEncode(json).byteLength;
  if (byteCount > LIMITS.mutationBytes) return fail("result_too_large");
  const elapsed = Reflect.apply($now, $performance, []) - started;
  const durationMs = elapsed >= 0 && Reflect.apply($numberIsFinite, $Number, [elapsed]) ? elapsed : 0;
  return stringify({ ok: true, json, byteCount, durationMs });
};

const directText = (node) => {
  let text = "";
  const childNodes = node && node.childNodes;
  const length = childNodes && typeof childNodes.length === "number"
    ? Math.min(childNodes.length, LIMITS.nodeText)
    : 0;
  for (let index = 0; index < length && text.length < LIMITS.nodeText; index += 1) {
    const child = childNodes[index];
    if (!child || (child.nodeType !== 3 && child.nodeType !== 4) ||
        typeof child.data !== "string") {
      continue;
    }
    text += child.data.slice(0, LIMITS.nodeText - text.length);
  }
  return text;
};
const readAttribute = (node, name) => {
  if ($elementGetAttribute) return $apply($elementGetAttribute, node, [name]);
  if (node.attributes && typeof node.attributes.get === "function") {
    return node.attributes.get(name) || null;
  }
  return typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
};
const readFormValue = (node, tagName) => {
  const getter = tagName === "INPUT"
    ? $inputValueGetter
    : tagName === "TEXTAREA"
      ? $textAreaValueGetter
      : $selectValueGetter;
  return getter ? $apply(getter, node, []) : node.value;
};
const formValueIsSensitive = (node, tagName) => {
  const autocomplete = String(readAttribute(node, "autocomplete") || "")
    .toLowerCase()
    .split(/\s+/);
  if (autocomplete.some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) return true;
  if (tagName !== "INPUT") return false;
  const type = String(readAttribute(node, "type") || "text").toLowerCase();
  return SENSITIVE_INPUT_TYPES.has(type);
};

const captureSnapshot = (invocationDocument, invocationRoot) => {
  const nodes = [];
  const liveNodes = new Map();
  const queue = [{ node: invocationRoot, parentId: null, depth: 0 }];
  let cursor = 0;
  let snapshotBytes = 0;
  let truncated = false;
  while (cursor < queue.length && nodes.length < LIMITS.snapshotNodes) {
    const current = queue[cursor++];
    if (!current || current.depth >= LIMITS.snapshotDepth) {
      truncated = true;
      continue;
    }
    const node = current.node;
    if (!node || typeof node.tagName !== "string") continue;
    if (node.tagName.length > LIMITS.snapshotName) {
      throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
    }
    const id = "n" + (nodes.length + 1);
    const tagName = node.tagName.toUpperCase();
    const attributes = {};
    let recordBudget = 256;
    const accountField = (value) => {
      recordBudget += textEncode(stringify(value)).byteLength;
      if (snapshotBytes + recordBudget > LIMITS.snapshotBytes) {
        throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
      }
    };
    const nodeAttributes = node.attributes;
    const attributeCount = nodeAttributes && typeof nodeAttributes.length === "number"
      ? Math.min(nodeAttributes.length, 64)
      : 0;
    for (let index = 0; index < attributeCount; index += 1) {
      const attribute = typeof nodeAttributes.item === "function"
        ? nodeAttributes.item(index)
        : nodeAttributes[index];
      if (attribute && typeof attribute.name === "string" &&
          typeof attribute.value === "string") {
        if (attribute.name.length > LIMITS.snapshotName) {
          throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
        }
        if (!SAFE_ATTRIBUTES.test(attribute.name) ||
            attribute.value.length > LIMITS.mutationValue) {
          continue;
        }
        accountField([attribute.name, attribute.value]);
        attributes[attribute.name] = attribute.value;
      }
    }
    const formValue = SAFE_FORM_TAGS.has(tagName);
    const valueRedacted = formValue && formValueIsSensitive(node, tagName);
    const text = BLOCKED_TAGS.has(tagName) || valueRedacted ? "" : directText(node);
    accountField(text);
    const value = formValue && !valueRedacted
      ? String(readFormValue(node, tagName) || "").slice(0, LIMITS.mutationValue)
      : undefined;
    if (value !== undefined) accountField(value);
    const record = {
      id,
      parentId: current.parentId,
      tagName,
      text,
      attributes,
      value,
      valueRedacted: formValue ? valueRedacted : undefined,
      checked: typeof node.checked === "boolean" ? node.checked : undefined,
      disabled: node.disabled === true,
      readOnly: node.readOnly === true,
    };
    snapshotBytes += textEncode(stringify(record)).byteLength + 1;
    if (snapshotBytes > LIMITS.snapshotBytes) {
      throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
    }
    nodes.push(record);
    liveNodes.set(id, node);
    if (BLOCKED_TAGS.has(tagName) || valueRedacted) continue;
    const children = node.children;
    const childCount = children && typeof children.length === "number" ? children.length : 0;
    const available = LIMITS.snapshotNodes - queue.length;
    const enqueueCount = Math.min(childCount, Math.max(0, available));
    if (enqueueCount < childCount) truncated = true;
    for (let index = 0; index < enqueueCount; index += 1) {
      const child = children[index];
      if (!child) continue;
      queue.push({ node: child, parentId: id, depth: current.depth + 1 });
    }
  }
  if (cursor < queue.length) truncated = true;
  const snapshot = { nodes, truncated };
  if (textEncode(stringify(snapshot)).byteLength > LIMITS.snapshotBytes) {
    throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
  }
  return { snapshot, liveNodes };
};

const runWorker = async (workerSource, workerInput) => {
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Object.assign(new Error("effect_unknown"), { code: "effect_unknown" })),
        LIMITS.workerTimeoutMs,
      );
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data);
      };
      worker.onerror = () => {
        clearTimeout(timeout);
        reject(Object.assign(new Error("automation_failed"), { code: "automation_failed" }));
      };
      worker.postMessage(workerInput);
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
};

const ownKeysExactly = (value, allowed) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
};
const boundedString = (value) => {
  if (typeof value !== "string" || value.length > LIMITS.mutationValue) {
    throw Object.assign(new Error("mutation_plan_invalid"), { code: "mutation_plan_invalid" });
  }
  return value;
};
const mutationError = (code) => Object.assign(new Error(code), { code });

const preflightMutation = (liveNodes, invocationDocument, mutation) => {
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) {
    throw mutationError("mutation_plan_invalid");
  }
  const kind = mutation.kind;
  const allowedKeys = {
    set_text: ["kind", "nodeId", "value"],
    set_attribute: ["kind", "nodeId", "name", "value"],
    remove_attribute: ["kind", "nodeId", "name"],
    set_property: ["kind", "nodeId", "name", "value"],
    set_form_value: ["kind", "nodeId", "value"],
    set_checked: ["kind", "nodeId", "value"],
    focus: ["kind", "nodeId"],
  }[kind];
  if (!allowedKeys || !ownKeysExactly(mutation, allowedKeys)) {
    throw mutationError("mutation_plan_invalid");
  }
  const nodeId = boundedString(mutation.nodeId);
  const node = liveNodes.get(nodeId);
  const validateTarget = () => {
    if (!node || node.isConnected !== true || node.ownerDocument !== invocationDocument) {
      throw mutationError("mutation_target_stale");
    }
    const currentTagName = String(node.tagName).toUpperCase();
    if (currentTagName.includes("-") || BLOCKED_TAGS.has(currentTagName)) {
      throw mutationError("mutation_not_allowed");
    }
    return currentTagName;
  };
  const operation = (validate, apply) => {
    validateTarget();
    validate();
    return () => {
      validateTarget();
      validate();
      apply();
    };
  };
  validateTarget();

  if (kind === "set_text") {
    const value = boundedString(mutation.value);
    const validate = () => {
      if (node.children && node.children.length > 0) {
        throw mutationError("mutation_not_allowed");
      }
    };
    return operation(validate, () => { node.textContent = value; });
  }
  if (kind === "set_attribute" || kind === "remove_attribute") {
    const name = boundedString(mutation.name);
    const normalized = name.toLowerCase();
    if (!SAFE_ATTRIBUTES.test(normalized) || normalized.startsWith("on") ||
        ["style", "srcdoc", "href", "src", "action", "formaction"].includes(normalized)) {
      throw mutationError("mutation_not_allowed");
    }
    if (kind === "set_attribute") {
      const value = boundedString(mutation.value);
      return operation(() => {}, () => node.setAttribute(name, value));
    }
    return operation(() => {}, () => node.removeAttribute(name));
  }
  if (kind === "set_property") {
    const name = boundedString(mutation.name);
    if (!SAFE_BOOLEAN_PROPERTIES.has(name) || typeof mutation.value !== "boolean") {
      throw mutationError("mutation_not_allowed");
    }
    return operation(() => {}, () => { node[name] = mutation.value; });
  }
  if (kind === "set_form_value") {
    const value = boundedString(mutation.value);
    const validate = () => {
      const currentTagName = String(node.tagName).toUpperCase();
      const type = String(
        node.type || (node.getAttribute && node.getAttribute("type")) || "",
      ).toLowerCase();
      if (!SAFE_FORM_TAGS.has(currentTagName) ||
          (currentTagName === "INPUT" && type === "file")) {
        throw mutationError("mutation_not_allowed");
      }
    };
    return operation(validate, () => { node.value = value; });
  }
  if (kind === "set_checked") {
    if (typeof mutation.value !== "boolean") {
      throw mutationError("mutation_not_allowed");
    }
    const validate = () => {
      const currentTagName = String(node.tagName).toUpperCase();
      const type = String(
        node.type || (node.getAttribute && node.getAttribute("type")) || "",
      ).toLowerCase();
      if (currentTagName !== "INPUT" || (type !== "checkbox" && type !== "radio")) {
        throw mutationError("mutation_not_allowed");
      }
    };
    return operation(validate, () => { node.checked = mutation.value; });
  }
  if (kind === "focus") return operation(() => {}, () => node.focus());
  throw mutationError("mutation_plan_invalid");
};

let applyStarted = false;
try {
  if (!input || typeof input.source !== "string" || typeof input.workerSource !== "string") {
    return fail("automation_failed");
  }
  if (typeof input.expectedUrl !== "string" ||
      typeof input.expectedDocumentToken !== "string") {
    return fail("automation_failed");
  }
  const invocationDocument = document;
  const invocationRoot = invocationDocument.documentElement;
  const expectedUrl = input.expectedUrl;
  const expectedDocumentToken = input.expectedDocumentToken;
  const documentMatches = () => {
    const context = globalThis[DOCUMENT_CONTEXT_KEY];
    return document === invocationDocument &&
      invocationDocument.documentElement === invocationRoot &&
      String(location.href) === expectedUrl &&
      context && context.document === invocationDocument &&
      context.root === invocationRoot &&
      context.token === expectedDocumentToken;
  };
  if (!documentMatches()) return fail("effect_unknown");
  const { snapshot, liveNodes } = captureSnapshot(invocationDocument, invocationRoot);
  const workerEnvelope = await runWorker(input.workerSource, {
    source: input.source,
    args: input.args,
    snapshot,
  });
  if (!documentMatches()) return fail("effect_unknown");
  if (!workerEnvelope || workerEnvelope.ok !== true) {
    return fail(workerEnvelope && workerEnvelope.code || "automation_failed");
  }
  if (!Array.isArray(workerEnvelope.mutations) || workerEnvelope.mutations.length > LIMITS.mutations) {
    return fail("mutation_plan_invalid");
  }
  const encodedPlan = stringify(workerEnvelope.mutations);
  if (textEncode(encodedPlan).byteLength > LIMITS.mutationBytes) {
    return fail("mutation_plan_invalid");
  }
  const apply = workerEnvelope.mutations.map(
    (item) => preflightMutation(liveNodes, invocationDocument, item),
  );
  if (!documentMatches()) return fail("effect_unknown");
  applyStarted = true;
  for (const operation of apply) {
    if (!documentMatches()) throw mutationError("effect_unknown");
    operation();
    if (!documentMatches()) throw mutationError("effect_unknown");
  }
  return encodeSuccess(workerEnvelope.value);
} catch (error) {
  if (applyStarted) return fail("effect_unknown");
  return fail(error && typeof error.code === "string" ? error.code : "automation_failed");
}
})
