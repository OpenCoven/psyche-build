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
const encoder = new $TextEncoder();
const started = Reflect.apply($now, $performance, []);
const stringify = (value) => Reflect.apply($jsonStringify, $JSON, [value]);
const textEncode = (value) => Reflect.apply($textEncode, encoder, [value]);
const fail = (code) => stringify({ ok: false, code });
const LIMITS = Object.freeze({
  snapshotNodes: 2048,
  snapshotDepth: 64,
  nodeText: 2048,
  snapshotBytes: 262144,
  mutations: 256,
  mutationBytes: 262144,
  mutationValue: 65536,
  workerTimeoutMs: 4000,
});
const SAFE_ATTRIBUTES = /^(?:aria-[a-z0-9_.:-]+|data-[a-z0-9_.:-]+|title|alt|placeholder|role|class|name|type)$/;
const SAFE_BOOLEAN_PROPERTIES = new Set(["disabled", "readOnly", "hidden"]);
const SAFE_FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const BLOCKED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK"]);

const encodeSuccess = (value) => {
  const json = stringify(value);
  if (typeof json !== "string") return fail("serialization_failed");
  const byteCount = textEncode(json).byteLength;
  if (byteCount > LIMITS.mutationBytes) return fail("result_too_large");
  const elapsed = Reflect.apply($now, $performance, []) - started;
  const durationMs = elapsed >= 0 && Reflect.apply($numberIsFinite, $Number, [elapsed]) ? elapsed : 0;
  return stringify({ ok: true, json, byteCount, durationMs });
};

const captureSnapshot = () => {
  const nodes = [];
  const liveNodes = new Map();
  const queue = [{ node: document.documentElement, parentId: null, depth: 0 }];
  while (queue.length && nodes.length < LIMITS.snapshotNodes) {
    const current = queue.shift();
    if (!current || current.depth >= LIMITS.snapshotDepth) continue;
    const node = current.node;
    if (!node || typeof node.tagName !== "string") continue;
    const id = "n" + (nodes.length + 1);
    const tagName = node.tagName.toUpperCase();
    const attributes = {};
    for (const attribute of Array.from(node.attributes || [])) {
      if (attribute && typeof attribute.name === "string" &&
          typeof attribute.value === "string" && SAFE_ATTRIBUTES.test(attribute.name) &&
          attribute.value.length <= LIMITS.mutationValue) {
        attributes[attribute.name] = attribute.value;
      }
    }
    nodes.push({
      id,
      parentId: current.parentId,
      tagName,
      text: String(node.textContent || "").slice(0, LIMITS.nodeText),
      attributes,
      value: SAFE_FORM_TAGS.has(tagName) ? String(node.value || "").slice(0, LIMITS.mutationValue) : undefined,
      checked: typeof node.checked === "boolean" ? node.checked : undefined,
      disabled: node.disabled === true,
      readOnly: node.readOnly === true,
    });
    liveNodes.set(id, node);
    for (const child of Array.from(node.children || [])) {
      queue.push({ node: child, parentId: id, depth: current.depth + 1 });
    }
  }
  const snapshot = { nodes, truncated: queue.length > 0 };
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

const preflightMutation = (liveNodes, mutation) => {
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
  if (!node || node.isConnected !== true || node.ownerDocument !== document) {
    throw mutationError("mutation_target_stale");
  }
  const tagName = String(node.tagName).toUpperCase();
  if (tagName.includes("-") || BLOCKED_TAGS.has(tagName)) {
    throw mutationError("mutation_not_allowed");
  }

  if (kind === "set_text") {
    const value = boundedString(mutation.value);
    return () => { node.textContent = value; };
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
      return () => node.setAttribute(name, value);
    }
    return () => node.removeAttribute(name);
  }
  if (kind === "set_property") {
    const name = boundedString(mutation.name);
    if (!SAFE_BOOLEAN_PROPERTIES.has(name) || typeof mutation.value !== "boolean") {
      throw mutationError("mutation_not_allowed");
    }
    return () => { node[name] = mutation.value; };
  }
  if (kind === "set_form_value") {
    if (!SAFE_FORM_TAGS.has(tagName)) throw mutationError("mutation_not_allowed");
    const value = boundedString(mutation.value);
    return () => { node.value = value; };
  }
  if (kind === "set_checked") {
    const type = String(node.type || (node.getAttribute && node.getAttribute("type")) || "").toLowerCase();
    if (tagName !== "INPUT" || (type !== "checkbox" && type !== "radio") || typeof mutation.value !== "boolean") {
      throw mutationError("mutation_not_allowed");
    }
    return () => { node.checked = mutation.value; };
  }
  if (kind === "focus") return () => node.focus();
  throw mutationError("mutation_plan_invalid");
};

try {
  if (!input || typeof input.source !== "string" || typeof input.workerSource !== "string") {
    return fail("automation_failed");
  }
  const { snapshot, liveNodes } = captureSnapshot();
  const workerEnvelope = await runWorker(input.workerSource, {
    source: input.source,
    args: input.args,
    snapshot,
  });
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
  const apply = workerEnvelope.mutations.map((item) => preflightMutation(liveNodes, item));
  for (const operation of apply) operation();
  return encodeSuccess(workerEnvelope.value);
} catch (error) {
  return fail(error && typeof error.code === "string" ? error.code : "automation_failed");
}
})
