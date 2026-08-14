# Browser Script Authority Revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute approved browser scripts in a one-shot Worker that can inspect a bounded snapshot and request validated synchronous DOM mutations without retaining callbacks or page authority after completion.

**Architecture:** The trusted `WKContentWorld` script captures a bounded DOM snapshot and owns the live node map. Approved source runs in a fresh Worker with ambient network/scheduling authority shadowed; it returns canonical JSON and a declarative mutation plan. The Worker is terminated before trusted code validates and synchronously applies the plan, then native code revalidates URL and document identity before reporting success.

**Tech Stack:** Tauri 2, Rust, macOS WebKit `WKContentWorld`, browser Web Workers, JavaScript, TypeScript, Vitest.

---

## File map

- Create `native/desktop/psyche-build-tauri/web/control/browser-script-worker-runtime.js`
  - Own the approved-source Worker environment, snapshot query API, mutation-plan builder, canonical result validation, and Worker response envelope.
- Modify `native/desktop/psyche-build-tauri/web/control/browser-script-runtime.js`
  - Capture the bounded DOM snapshot, launch and terminate the Worker, validate the mutation plan, apply allowed synchronous mutations, and encode the final result.
- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
  - Embed both trusted scripts, bound native arguments, pass the Worker source into the page runtime, accept the new stable failure codes, and retain URL/document checks.
- Modify `native/desktop/psyche-build-tauri/web/main.js`
  - Map new stable native script errors without exposing backend details.
- Modify `__tests__/tauriBrowserScriptAuthority.test.ts`
  - Add Worker authority, lifecycle, snapshot, mutation, stale-target, and error-contract tests.
- Modify `__tests__/tauriBrowserSemanticProvider.test.ts`
  - Pin provider completion/quarantine behavior for the new stable errors and ambiguous outcomes.
- Modify `docs/AGENT-SURFACE-CONTROL.md`
  - Document the `args` + `page` approved-script environment and allowed mutation methods.
- Modify `CHANGELOG.md`
  - Record revocation of approved script authority after every invocation.

### Task 1: Build the one-shot Worker contract

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/control/browser-script-worker-runtime.js`
- Modify: `__tests__/tauriBrowserScriptAuthority.test.ts`

- [ ] **Step 1: Replace the old live-realm test helper with a Worker-runtime helper**

Add this helper beside `runtimeSource()`:

```ts
function workerRuntimeSource(): string {
  return readFileSync(new URL(
    '../native/desktop/psyche-build-tauri/web/control/browser-script-worker-runtime.js',
    import.meta.url,
  ), 'utf8');
}

async function runWorker(
  source: string,
  args: unknown = null,
  snapshot: unknown = { nodes: [] },
): Promise<Record<string, unknown>> {
  const messages: unknown[] = [];
  const context = createContext({
    TextEncoder,
    performance,
    postMessage(value: unknown) { messages.push(value); },
  });
  runInContext(workerRuntimeSource(), context);
  await runInContext(
    `onmessage({ data: ${JSON.stringify({ source, args, snapshot })} })`,
    context,
  );
  expect(messages).toHaveLength(1);
  return messages[0] as Record<string, unknown>;
}
```

- [ ] **Step 2: Write failing authority and mutation-builder tests**

Add tests with these exact expectations:

```ts
it('removes scheduling, network, import, and nested-worker authority', async () => {
  const envelope = await runWorker(`
    return {
      fetch: typeof fetch,
      xhr: typeof XMLHttpRequest,
      socket: typeof WebSocket,
      timer: typeof setTimeout,
      interval: typeof setInterval,
      animation: typeof requestAnimationFrame,
      importScripts: typeof importScripts,
      worker: typeof Worker,
      sharedWorker: typeof SharedWorker,
      postMessage: typeof postMessage,
      addEventListener: typeof addEventListener,
      mutationObserver: typeof MutationObserver,
    };
  `);
  expect(envelope).toMatchObject({
    ok: true,
    value: {
      fetch: 'undefined',
      xhr: 'undefined',
      socket: 'undefined',
      timer: 'undefined',
      interval: 'undefined',
      animation: 'undefined',
      importScripts: 'undefined',
      worker: 'undefined',
      sharedWorker: 'undefined',
      postMessage: 'undefined',
      addEventListener: 'undefined',
      mutationObserver: 'undefined',
    },
    mutations: [],
  });
});

it('exposes snapshot queries and declarative mutation builders only', async () => {
  const envelope = await runWorker(`
    const node = page.get("n1");
    page.setText(node.id, args.text);
    page.setAttribute(node.id, "aria-label", "Updated");
    page.setFormValue(node.id, "value");
    page.setChecked(node.id, true);
    page.focus(node.id);
    return { tag: node.tagName };
  `, { text: 'Hello' }, {
    nodes: [{ id: 'n1', tagName: 'INPUT', text: '', attributes: {}, value: '' }],
  });
  expect(envelope).toEqual({
    ok: true,
    value: { tag: 'INPUT' },
    mutations: [
      { kind: 'set_text', nodeId: 'n1', value: 'Hello' },
      { kind: 'set_attribute', nodeId: 'n1', name: 'aria-label', value: 'Updated' },
      { kind: 'set_form_value', nodeId: 'n1', value: 'value' },
      { kind: 'set_checked', nodeId: 'n1', value: true },
      { kind: 'focus', nodeId: 'n1' },
    ],
  });
});

it('rejects non-canonical values and oversized mutation plans', async () => {
  const nonCanonical = await runWorker('return { get secret() { return 1; } };');
  expect(nonCanonical).toEqual({ ok: false, code: 'serialization_failed' });

  const oversized = await runWorker(`
    for (let index = 0; index < 257; index += 1) page.setText("n1", "x");
    return null;
  `, null, { nodes: [{ id: 'n1', tagName: 'DIV', text: '', attributes: {} }] });
  expect(oversized).toEqual({ ok: false, code: 'mutation_plan_invalid' });
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserScriptAuthority.test.ts
```

Expected: FAIL because `browser-script-worker-runtime.js` and `runWorker` behavior do not exist.

- [ ] **Step 4: Implement the Worker runtime**

Create `browser-script-worker-runtime.js` with this contract:

```js
(function installBrowserScriptWorkerRuntime() {
  "use strict";

  const $postMessage = globalThis.postMessage.bind(globalThis);
  const $Function = Function;
  const $Object = Object;
  const $Array = Array;
  const $Number = Number;
  const $String = String;
  const $JSON = JSON;
  const $Reflect = Reflect;
  const $Set = Set;
  const $TextEncoder = TextEncoder;
  const $apply = $Reflect.apply;
  const $ownKeys = $Reflect.ownKeys;
  const $getPrototypeOf = $Object.getPrototypeOf;
  const $getOwnPropertyDescriptor = $Object.getOwnPropertyDescriptor;
  const $arrayIsArray = $Array.isArray;
  const $numberIsFinite = $Number.isFinite;
  const $jsonStringify = $JSON.stringify;
  const $textEncode = $TextEncoder.prototype.encode;
  const $encoder = new $TextEncoder();
  const MAX_DEPTH = 64;
  const MAX_MUTATIONS = 256;
  const MAX_RESULT_BYTES = 262144;
  const blocked = [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "requestAnimationFrame", "cancelAnimationFrame", "queueMicrotask",
    "importScripts", "Worker", "SharedWorker", "BroadcastChannel",
    "postMessage", "close", "addEventListener", "removeEventListener",
    "MutationObserver", "ResizeObserver", "IntersectionObserver",
    "indexedDB", "caches",
  ];

  blocked.forEach((name) => {
    try {
      $Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch (_) {
      try { globalThis[name] = undefined; } catch (_) {}
    }
  });

  const canonical = (value, seen = new $Set(), depth = 0) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return $apply($numberIsFinite, $Number, [value]);
    if (typeof value !== "object" || depth >= MAX_DEPTH || seen.has(value)) return false;
    const array = $apply($arrayIsArray, $Array, [value]);
    if ($apply($getPrototypeOf, $Object, [value]) !== (array ? $Array.prototype : $Object.prototype)) return false;
    seen.add(value);
    const keys = $apply($ownKeys, $Reflect, [value]);
    for (const key of keys) {
      if (typeof key !== "string") return false;
      const descriptor = $apply($getOwnPropertyDescriptor, $Object, [value, key]);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          !canonical(descriptor.value, seen, depth + 1)) return false;
    }
    seen.delete(value);
    return true;
  };

  const clone = (value) => $JSON.parse($apply($jsonStringify, $JSON, [value]));
  const mutation = (mutations, kind, nodeId, fields) => {
    if (mutations.length >= MAX_MUTATIONS || typeof nodeId !== "string") {
      throw Object.assign(new Error("mutation_plan_invalid"), { code: "mutation_plan_invalid" });
    }
    mutations.push($Object.freeze($Object.assign({ kind, nodeId }, fields || {})));
  };
  const pageApi = (snapshot, mutations) => {
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, $Object.freeze(clone(node))]));
    return $Object.freeze({
      snapshot: $Object.freeze(clone(snapshot)),
      get(nodeId) { return nodes.get(nodeId) || null; },
      setText(nodeId, value) { mutation(mutations, "set_text", nodeId, { value: $String(value) }); },
      setAttribute(nodeId, name, value) {
        mutation(mutations, "set_attribute", nodeId, { name: $String(name), value: $String(value) });
      },
      removeAttribute(nodeId, name) {
        mutation(mutations, "remove_attribute", nodeId, { name: $String(name) });
      },
      setProperty(nodeId, name, value) {
        mutation(mutations, "set_property", nodeId, { name: $String(name), value });
      },
      setFormValue(nodeId, value) {
        mutation(mutations, "set_form_value", nodeId, { value: $String(value) });
      },
      setChecked(nodeId, value) {
        mutation(mutations, "set_checked", nodeId, { value: value === true });
      },
      focus(nodeId) { mutation(mutations, "focus", nodeId); },
    });
  };

  globalThis.onmessage = async function onBrowserScriptMessage(event) {
    const mutations = [];
    try {
      const input = event.data || {};
      const page = pageApi(input.snapshot || { nodes: [] }, mutations);
      const execute = $Function(
        "args", "page",
        "\"use strict\";return (async()=>{" + $String(input.source || "") + "\n})()",
      );
      const value = await execute(clone(input.args), page);
      if (!canonical(value) || !canonical(mutations)) {
        $postMessage({ ok: false, code: "serialization_failed" });
        return;
      }
      const encoded = $apply($jsonStringify, $JSON, [{ value, mutations }]);
      if ($apply($textEncode, $encoder, [encoded]).byteLength > MAX_RESULT_BYTES) {
        $postMessage({ ok: false, code: "result_too_large" });
        return;
      }
      $postMessage({ ok: true, value: clone(value), mutations: clone(mutations) });
    } catch (error) {
      const code = error && error.code === "mutation_plan_invalid"
        ? "mutation_plan_invalid"
        : "automation_failed";
      $postMessage({ ok: false, code });
    }
  };
})();
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserScriptAuthority.test.ts
```

Expected: PASS for the new Worker tests; existing page-runtime tests may still fail until Task 2 updates their helper.

- [ ] **Step 6: Commit**

```bash
git add native/desktop/psyche-build-tauri/web/control/browser-script-worker-runtime.js \
  __tests__/tauriBrowserScriptAuthority.test.ts
git commit -m "feat: add revocable browser script worker"
```

### Task 2: Capture a bounded snapshot and validate mutation plans

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/control/browser-script-runtime.js`
- Modify: `__tests__/tauriBrowserScriptAuthority.test.ts`

- [ ] **Step 1: Add a page-runtime test harness with a fake Worker**

Add:

```ts
type FakeNode = {
  id?: string;
  tagName: string;
  textContent: string;
  attributes: Map<string, string>;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  hidden?: boolean;
  isConnected: boolean;
  ownerDocument?: unknown;
  children: FakeNode[];
  focus: ReturnType<typeof vi.fn>;
};

function fakeElement(tagName: string, children: FakeNode[] = []): FakeNode {
  return {
    tagName,
    textContent: '',
    attributes: new Map(),
    isConnected: true,
    children,
    focus: vi.fn(),
  };
}

async function runPageRuntime(
  workerMessage: unknown,
  root = fakeElement('HTML'),
): Promise<{ envelope: Record<string, unknown>; terminated: number }> {
  let terminated = 0;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: workerMessage }));
    }
    terminate() { terminated += 1; }
  }
  const document = {
    documentElement: root,
    createTreeWalker: () => {
      const queue = [root];
      return { nextNode: () => queue.shift() ?? null };
    },
  };
  root.ownerDocument = document;
  const context = createContext({
    Blob: class { constructor(public parts: unknown[]) {} },
    Worker: FakeWorker,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: vi.fn() },
    NodeFilter: { SHOW_ELEMENT: 1 },
    TextEncoder,
    performance,
    document,
    setTimeout,
    clearTimeout,
  });
  const input = JSON.stringify({ source: 'return null;', args: null, workerSource: 'trusted' });
  const encoded = await runInContext(`${runtimeSource()}(${input})`, context) as string;
  return { envelope: JSON.parse(encoded), terminated };
}
```

- [ ] **Step 2: Write failing snapshot and validation tests**

Add:

```ts
it('terminates the Worker before applying a valid synchronous mutation plan', async () => {
  const input = fakeElement('INPUT');
  input.value = 'before';
  const root = fakeElement('HTML', [input]);
  const { envelope, terminated } = await runPageRuntime({
    ok: true,
    value: { changed: true },
    mutations: [{ kind: 'set_form_value', nodeId: 'n2', value: 'after' }],
  }, root);

  expect(terminated).toBe(1);
  expect(input.value).toBe('after');
  expect(envelope).toMatchObject({ ok: true, json: '{"changed":true}' });
});

it('rejects executable and stale mutation targets before applying anything', async () => {
  const target = fakeElement('DIV');
  target.textContent = 'before';
  const root = fakeElement('HTML', [target]);

  const executable = await runPageRuntime({
    ok: true,
    value: null,
    mutations: [
      { kind: 'set_text', nodeId: 'n2', value: 'changed' },
      { kind: 'set_attribute', nodeId: 'n2', name: 'onclick', value: 'steal()' },
    ],
  }, root);
  expect(executable.envelope).toEqual({ ok: false, code: 'mutation_not_allowed' });
  expect(target.textContent).toBe('before');

  target.isConnected = false;
  const stale = await runPageRuntime({
    ok: true,
    value: null,
    mutations: [{ kind: 'set_text', nodeId: 'n2', value: 'changed' }],
  }, root);
  expect(stale.envelope).toEqual({ ok: false, code: 'mutation_target_stale' });
});

it('rejects navigation, HTML, executable URL, style, and custom-element sinks', async () => {
  for (const mutation of [
    { kind: 'set_attribute', nodeId: 'n2', name: 'href', value: 'javascript:steal()' },
    { kind: 'set_attribute', nodeId: 'n2', name: 'srcdoc', value: '<script>steal()</script>' },
    { kind: 'set_attribute', nodeId: 'n2', name: 'style', value: 'background:url(https://evil)' },
    { kind: 'set_property', nodeId: 'n2', name: 'innerHTML', value: '<script>steal()</script>' },
  ]) {
    const root = fakeElement('HTML', [fakeElement('DIV')]);
    const result = await runPageRuntime({ ok: true, value: null, mutations: [mutation] }, root);
    expect(result.envelope).toEqual({ ok: false, code: 'mutation_not_allowed' });
  }
});
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserScriptAuthority.test.ts
```

Expected: FAIL because the current runtime executes approved source directly and has no Worker or mutation validator.

- [ ] **Step 4: Replace the page runtime with the trusted orchestrator**

Implement these concrete pieces in `browser-script-runtime.js`:

```js
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
    const attributes = {};
    for (const attribute of Array.from(node.attributes || [])) {
      if (SAFE_ATTRIBUTES.test(attribute.name) && attribute.value.length <= LIMITS.mutationValue) {
        attributes[attribute.name] = attribute.value;
      }
    }
    nodes.push({
      id,
      parentId: current.parentId,
      tagName: node.tagName.toUpperCase(),
      text: String(node.textContent || "").slice(0, LIMITS.nodeText),
      attributes,
      value: SAFE_FORM_TAGS.has(node.tagName.toUpperCase()) ? String(node.value || "").slice(0, LIMITS.mutationValue) : undefined,
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
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > LIMITS.snapshotBytes) {
    throw Object.assign(new Error("snapshot_too_large"), { code: "snapshot_too_large" });
  }
  return { snapshot, liveNodes };
};

const runWorker = async (workerSource, input) => {
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Object.assign(new Error("effect_unknown"), { code: "effect_unknown" })),
        LIMITS.workerTimeoutMs,
      );
      worker.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = () => {
        clearTimeout(timeout);
        reject(Object.assign(new Error("automation_failed"), { code: "automation_failed" }));
      };
      worker.postMessage(input);
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
};
```

Implement `preflightMutation(liveNodes, mutation)` so it:

- rejects unknown keys and kinds;
- rejects missing, disconnected, cross-document, custom-element, `SCRIPT`, `STYLE`, `IFRAME`, `OBJECT`, `EMBED`, and `LINK` targets;
- permits only the seven mutation kinds from the spec;
- permits `SAFE_ATTRIBUTES` but rejects `on*`, `style`, `srcdoc`, `href`, `src`, `action`, and `formaction`;
- permits only `disabled`, `readOnly`, and `hidden` boolean properties;
- permits form values only on `INPUT`, `TEXTAREA`, and `SELECT`;
- permits checked state only on checkbox/radio `INPUT`;
- bounds all strings before returning an apply closure.

Use this completion order:

```js
const { snapshot, liveNodes } = captureSnapshot();
const workerEnvelope = await runWorker(input.workerSource, {
  source: input.source,
  args: input.args,
  snapshot,
});
if (!workerEnvelope || workerEnvelope.ok !== true) {
  return fail(workerEnvelope && workerEnvelope.code || "automation_failed");
}
if (!Array.isArray(workerEnvelope.mutations) ||
    workerEnvelope.mutations.length > LIMITS.mutations) {
  return fail("mutation_plan_invalid");
}
const encodedPlan = stringify(workerEnvelope.mutations);
if (textEncode(encoder, encodedPlan).byteLength > LIMITS.mutationBytes) {
  return fail("mutation_plan_invalid");
}
const apply = workerEnvelope.mutations.map((item) => preflightMutation(liveNodes, item));
for (const operation of apply) operation();
return encodeSuccess(workerEnvelope.value, started);
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserScriptAuthority.test.ts
```

Expected: PASS, including `terminated === 1` before observable mutation completion.

- [ ] **Step 6: Commit**

```bash
git add native/desktop/psyche-build-tauri/web/control/browser-script-runtime.js \
  __tests__/tauriBrowserScriptAuthority.test.ts
git commit -m "fix: revoke browser script authority before mutation"
```

### Task 3: Wire the Worker source and native failure contract

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `__tests__/tauriBrowserScriptAuthority.test.ts`

- [ ] **Step 1: Write failing native contract tests**

Add:

```ts
it('embeds the trusted Worker runtime without exposing it to page source', () => {
  expect(lib).toContain('include_str!("../../web/control/browser-script-worker-runtime.js")');
  expect(lib).toMatch(/"workerSource":\s*include_str!/);
  expect(lib).toContain('"mutation_plan_invalid"');
  expect(lib).toContain('"mutation_target_stale"');
  expect(lib).toContain('"mutation_not_allowed"');
  expect(lib).toContain('"snapshot_too_large"');
});

it('bounds serialized script arguments at the native boundary', () => {
  expect(lib).toContain('MAX_BROWSER_SCRIPT_ARGS_BYTES');
  expect(lib).toMatch(/serde_json::to_vec\(&request\.args\)[\s\S]*args_too_large/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserScriptAuthority.test.ts
```

Expected: FAIL because Rust embeds only `browser-script-runtime.js` and lacks the new error codes/argument bound.

- [ ] **Step 3: Update the native request bridge**

Add:

```rust
const MAX_BROWSER_SCRIPT_ARGS_BYTES: usize = 256 * 1024;
```

Before constructing `input`:

```rust
let argument_bytes =
    serde_json::to_vec(&request.args).map_err(|_| "serialization_failed".to_string())?;
if argument_bytes.len() > MAX_BROWSER_SCRIPT_ARGS_BYTES {
    return Err("args_too_large".to_string());
}
```

Construct the trusted input:

```rust
let input = serde_json::to_string(&serde_json::json!({
    "source": request.source,
    "args": request.args,
    "workerSource": include_str!("../../web/control/browser-script-worker-runtime.js"),
}))
.map_err(|_| "serialization_failed".to_string())?;
```

Extend the envelope error allowlist:

```rust
matches!(
    *code,
    "automation_failed"
        | "effect_unknown"
        | "result_too_large"
        | "serialization_failed"
        | "snapshot_too_large"
        | "mutation_plan_invalid"
        | "mutation_target_stale"
        | "mutation_not_allowed"
)
```

Keep the existing pre/post URL and document-token checks unchanged.

- [ ] **Step 4: Add Rust unit assertions**

Extend the existing browser script tests in `lib.rs`:

```rust
#[test]
fn browser_script_worker_runtime_is_embedded_and_bounded() {
    assert!(include_str!("../../web/control/browser-script-worker-runtime.js")
        .contains("installBrowserScriptWorkerRuntime"));
    assert_eq!(MAX_BROWSER_SCRIPT_ARGS_BYTES, 256 * 1024);
}
```

- [ ] **Step 5: Run JS and Rust tests**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserScriptAuthority.test.ts
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml browser_script --quiet
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriBrowserScriptAuthority.test.ts
git commit -m "fix: bind browser script worker execution natively"
```

### Task 4: Preserve provider error and quarantine semantics

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriBrowserScriptAuthority.test.ts`
- Modify: `__tests__/tauriBrowserSemanticProvider.test.ts`

- [ ] **Step 1: Write failing stable-error tests**

Add:

```ts
it('maps mutation and snapshot failures to sanitized stable errors', () => {
  const normalize = Function(`return (${functionSource(main, 'browserNativeScriptError')});`)();
  for (const code of [
    'args_too_large',
    'snapshot_too_large',
    'mutation_plan_invalid',
    'mutation_target_stale',
    'mutation_not_allowed',
  ]) {
    const error = normalize(Object.assign(new Error(`${code}: secret`), { code }));
    expect(error).toMatchObject({ code, ambiguous: false });
    expect(error.message).toBe(`browser script failed: ${code}`);
    expect(error.message).not.toContain('secret');
  }
});
```

In `tauriBrowserSemanticProvider.test.ts`, add:

```ts
it('quarantines only ambiguous browser script outcomes', async () => {
  // Reuse the existing provider handler harness.
  // `mutation_not_allowed` completes as a deterministic failure.
  // `effect_unknown` invokes `quarantineBrowserAutomation`.
});
```

Implement the test with the existing `handleBrowserProviderEffect` harness by dispatching one rejected `browser_script` invoke for each code and asserting:

```ts
expect(quarantineBrowserAutomation).toHaveBeenCalledTimes(1);
expect(completeBrowserProviderEffect).toHaveBeenCalledTimes(2);
```

- [ ] **Step 2: Run the provider tests and verify they fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserScriptAuthority.test.ts \
  __tests__/tauriBrowserSemanticProvider.test.ts
```

Expected: FAIL because the new codes are not in `browserNativeScriptError`.

- [ ] **Step 3: Extend the sanitized allowlist**

Replace the allowlist in `browserNativeScriptError` with:

```js
var allowed = [
  "args_too_large",
  "backend_unavailable",
  "effect_unknown",
  "mutation_not_allowed",
  "mutation_plan_invalid",
  "mutation_target_stale",
  "result_too_large",
  "script_source_too_large",
  "serialization_failed",
  "snapshot_too_large",
  "target_unavailable",
  "automation_failed",
];
```

Keep `ambiguous: code === "effect_unknown"` and the fixed message
`"browser script failed: " + code`.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserScriptAuthority.test.ts \
  __tests__/tauriBrowserSemanticProvider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/desktop/psyche-build-tauri/web/main.js \
  __tests__/tauriBrowserScriptAuthority.test.ts \
  __tests__/tauriBrowserSemanticProvider.test.ts
git commit -m "fix: surface browser script revocation failures"
```

### Task 5: Document the approved script API

**Files:**
- Modify: `docs/AGENT-SURFACE-CONTROL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the public script environment contract**

Document this example in `docs/AGENT-SURFACE-CONTROL.md`:

```js
const button = page.get("n17");
if (!button) return { changed: false };

page.setText(button.id, "Ready");
page.setAttribute(button.id, "aria-label", "Ready");
page.focus(button.id);

return { changed: true };
```

State explicitly:

- approved source receives `args` and `page`;
- `page.snapshot` and `page.get(nodeId)` are immutable;
- mutations are declarative and synchronous;
- live `window`/`document`, timers, network, listeners, observers, imports,
  nested workers, navigation, HTML sinks, executable URLs, and external
  resource creation are unavailable;
- node IDs expire after the invocation;
- unsupported operations return `mutation_not_allowed`.

- [ ] **Step 2: Add the changelog entry**

Add under the current unreleased section:

```markdown
- Revoked approved browser-script authority at invocation completion by moving
  approved source into a one-shot Worker and applying only validated
  synchronous DOM mutation plans.
```

- [ ] **Step 3: Commit**

```bash
git add docs/AGENT-SURFACE-CONTROL.md CHANGELOG.md
git commit -m "docs: define revocable browser script mutations"
```

### Task 6: Run integrated validation and security review

**Files:**
- Verify all files changed in Tasks 1-5.

- [ ] **Step 1: Rebuild committed desktop bundles**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Expected: build succeeds. `git status --short` must show no unexpected generated changes outside the known control bundle.

- [ ] **Step 2: Run focused browser authority tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserScriptAuthority.test.ts \
  __tests__/tauriBrowserSemanticProvider.test.ts \
  __tests__/tauriBrowserProvider.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run type and Rust validation**

Run:

```bash
pnpm typecheck:tests
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml browser_script --quiet
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
```

Expected: all PASS.

- [ ] **Step 4: Run the full existing test suite**

Run:

```bash
pnpm test
```

Expected: all tests PASS.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff --check
git status --short --branch
git diff --stat origin/main...HEAD
```

Expected: no conflict markers, whitespace errors, untracked artifacts, or unrelated files.

- [ ] **Step 6: Request a dedicated security review**

Use the repository security-review agent against `origin/main...HEAD`.

Expected: no high-confidence finding that approved source can retain callbacks,
reach page globals, inject executable content, navigate, or bypass mutation
validation.

- [ ] **Step 7: Commit generated artifacts if rebuilding changed them**

```bash
git add native/desktop/psyche-build-tauri/web/control.bundle.js
git commit -m "build: refresh browser control bundle"
```

Skip this commit only when `git status --short` shows no generated bundle change.

### Task 7: Push, merge, and remove the worktree

**Files:**
- No new code files.

- [ ] **Step 1: Push the follow-up branch**

```bash
git push -u origin fix/browser-script-revocation
```

Expected: remote branch is created successfully.

- [ ] **Step 2: Open the pull request**

```bash
gh pr create \
  --repo OpenCoven/psyche-build \
  --base main \
  --head fix/browser-script-revocation \
  --title "Revoke approved browser script authority after completion" \
  --body-file - <<'EOF'
## Summary
- execute approved source in a one-shot Worker with no live DOM authority
- apply only bounded, validated synchronous DOM mutation plans
- terminate Worker authority before mutation application and success receipts

## Validation
- focused browser authority/provider/bundle tests
- TypeScript test typecheck
- Rust browser-script tests and formatting
- full existing test suite
EOF
```

- [ ] **Step 3: Wait for required checks and review**

Run:

```bash
gh pr checks --watch --interval 10
```

Expected: every required check succeeds.

- [ ] **Step 4: Squash-merge after review**

Run:

```bash
gh pr merge --squash --delete-branch
```

If branch protection still reports only `REVIEW_REQUIRED` after the user has
explicitly authorized merging, run:

```bash
gh pr merge --admin --squash --delete-branch
```

- [ ] **Step 5: Remove the local worktree and branch**

From the primary repository:

```bash
git fetch --prune
git worktree remove .worktrees/browser-script-revocation
git branch -d fix/browser-script-revocation
git worktree prune
```

Expected: the worktree path, local branch, and remote branch are absent; the
merged commit is reachable from `origin/main`.
