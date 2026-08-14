import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const lib = readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/src-tauri/src/lib.rs',
  import.meta.url,
), 'utf8');
const main = readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/web/main.js',
  import.meta.url,
), 'utf8');

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let cursor = body; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    if (source[cursor] === '}' && --depth === 0) return source.slice(start, cursor + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function runtimeSource(): string {
  return readFileSync(new URL(
    '../native/desktop/psyche-build-tauri/web/control/browser-script-runtime.js',
    import.meta.url,
  ), 'utf8');
}

function workerRuntimeSource(): string {
  return readFileSync(new URL(
    '../native/desktop/psyche-build-tauri/web/control/browser-script-worker-runtime.js',
    import.meta.url,
  ), 'utf8');
}

async function runIsolated(source: string, args: unknown = null): Promise<Record<string, unknown>> {
  const workerEnvelope = await runWorker(source, args);
  return (await runPageRuntime(workerEnvelope)).envelope;
}

async function runWorker(
  source: string,
  args: unknown = null,
  snapshot: unknown = { nodes: [] },
  options: {
    globals?: Record<string, unknown>;
    setup?: string;
  } = {},
): Promise<Record<string, unknown>> {
  const messages: unknown[] = [];
  const context = createContext({
    ...options.globals,
    TextEncoder,
    performance,
    postMessage(value: unknown) { messages.push(value); },
  });
  if (options.setup) runInContext(options.setup, context);
  runInContext(workerRuntimeSource(), context);
  await runInContext(
    `onmessage({ data: ${JSON.stringify({ source, args, snapshot })} })`,
    context,
  );
  expect(messages).toHaveLength(1);
  return messages[0] as Record<string, unknown>;
}

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
): Promise<{
  envelope: Record<string, unknown>;
  terminated: number;
  workerInput: Record<string, unknown> | null;
}> {
  let terminated = 0;
  let workerInput: Record<string, unknown> | null = null;
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    postMessage(value: Record<string, unknown>) {
      workerInput = value;
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
  const attachDocument = (node: FakeNode) => {
    node.ownerDocument = document;
    node.children.forEach(attachDocument);
  };
  attachDocument(root);
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
  return { envelope: JSON.parse(encoded), terminated, workerInput };
}

describe('native browser script authority', () => {
  it('maps native failures to stable codes without retaining backend details', () => {
    const normalize = Function(`return (${functionSource(main, 'browserNativeScriptError')});`)();
    const error = normalize(Object.assign(
      new Error('automation_failed: result_too_large source-secret result-secret'),
      { code: 'result_too_large' },
    ));

    expect(error).toMatchObject({ code: 'result_too_large', ambiguous: false });
    expect(error.message).toBe('browser script failed: result_too_large');
    expect(error.message).not.toContain('source-secret');
    expect(error.message).not.toContain('result-secret');
  });

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

  it('routes approved scripts through an invocation-scoped WKContentWorld', () => {
    expect(lib).toMatch(/async fn browser_script\(/);
    expect(lib).toContain('WKContentWorld::worldWithName');
    expect(lib).toContain('next_browser_script_execution_world_name');
    expect(lib).toContain('evaluate_browser_script_document_token');
    expect(main).toMatch(/operation\.kind === "script"[\s\S]{0,500}invoke\("browser_script"/);
    expect(main).not.toMatch(/operation\.kind === "script"[\s\S]{0,500}browserAutomationDispatchScript\(effect\)/);
  });

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

  it('captures serialization intrinsics before approved source can replace globals', async () => {
    const envelope = await runIsolated(`
      try {
        Object.defineProperty(Object.prototype, "toJSON", { value() { return "forged"; } });
      } catch (_) {}
      globalThis.JSON = { stringify() { return '"forged"'; } };
      globalThis.Object = { getPrototypeOf() { return null; } };
      globalThis.TextEncoder = class { encode() { return new Uint8Array(); } };
      return { answer: args.value + 1 };
    `, { value: 41 });

    expect(envelope).toMatchObject({ ok: true, json: '{"answer":42}', byteCount: 13 });
  });

  it('does not carry an approved script global into the next invocation realm', async () => {
    const first = await runIsolated('globalThis.__psychePoison = true; return { ok: true };');
    const second = await runIsolated('return { poisoned: globalThis.__psychePoison === true };');

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true, json: '{"poisoned":false}' });
  });

  it('rejects deeply nested results with a stable serialization error', async () => {
    const envelope = await runIsolated(`
      let value = null;
      for (let depth = 0; depth < 128; depth += 1) value = { child: value };
      return value;
    `);

    expect(envelope).toEqual({ ok: false, code: 'serialization_failed' });
  });

  it('removes scheduling, network, import, and nested-worker authority', async () => {
    const envelope = await runWorker(`
      return {
        fetch: typeof fetch,
        xhr: typeof XMLHttpRequest,
        socket: typeof WebSocket,
        socketStream: typeof WebSocketStream,
        webTransport: typeof WebTransport,
        eventSource: typeof EventSource,
        fontFace: typeof FontFace,
        fontFaceSet: typeof FontFaceSet,
        fonts: typeof fonts,
        timer: typeof setTimeout,
        clearTimer: typeof clearTimeout,
        interval: typeof setInterval,
        clearInterval: typeof clearInterval,
        animation: typeof requestAnimationFrame,
        cancelAnimation: typeof cancelAnimationFrame,
        microtask: typeof queueMicrotask,
        importScripts: typeof importScripts,
        worker: typeof Worker,
        sharedWorker: typeof SharedWorker,
        broadcastChannel: typeof BroadcastChannel,
        postMessage: typeof postMessage,
        close: typeof close,
        addEventListener: typeof addEventListener,
        removeEventListener: typeof removeEventListener,
        mutationObserver: typeof MutationObserver,
        resizeObserver: typeof ResizeObserver,
        intersectionObserver: typeof IntersectionObserver,
        indexedDB: typeof indexedDB,
        caches: typeof caches,
        peerConnection: typeof RTCPeerConnection,
        messageChannel: typeof MessageChannel,
        messagePort: typeof MessagePort,
        scheduler: typeof scheduler,
        cookieStore: typeof cookieStore,
        navigator: typeof navigator,
        location: typeof location,
        notification: typeof Notification,
        reportError: typeof reportError,
      };
    `);

    expect(envelope).toEqual({
      ok: true,
      value: {
        fetch: 'undefined',
        xhr: 'undefined',
        socket: 'undefined',
        socketStream: 'undefined',
        webTransport: 'undefined',
        eventSource: 'undefined',
        fontFace: 'undefined',
        fontFaceSet: 'undefined',
        fonts: 'undefined',
        timer: 'undefined',
        clearTimer: 'undefined',
        interval: 'undefined',
        clearInterval: 'undefined',
        animation: 'undefined',
        cancelAnimation: 'undefined',
        microtask: 'undefined',
        importScripts: 'undefined',
        worker: 'undefined',
        sharedWorker: 'undefined',
        broadcastChannel: 'undefined',
        postMessage: 'undefined',
        close: 'undefined',
        addEventListener: 'undefined',
        removeEventListener: 'undefined',
        mutationObserver: 'undefined',
        resizeObserver: 'undefined',
        intersectionObserver: 'undefined',
        indexedDB: 'undefined',
        caches: 'undefined',
        peerConnection: 'undefined',
        messageChannel: 'undefined',
        messagePort: 'undefined',
        scheduler: 'undefined',
        cookieStore: 'undefined',
        navigator: 'undefined',
        location: 'undefined',
        notification: 'undefined',
        reportError: 'undefined',
      },
      mutations: [],
    });
  });

  it('scrubs callable authority from the complete Worker global prototype chain', async () => {
    let inheritedFetchCalls = 0;
    const authorityNames = [
      'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource',
      'FontFace', 'FontFaceSet', 'fonts',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
      'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel',
      'postMessage', 'close', 'addEventListener', 'removeEventListener',
      'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
      'RTCPeerConnection', 'MessageChannel', 'MessagePort', 'scheduler',
      'indexedDB', 'caches', 'cookieStore', 'navigator', 'location',
      'Notification', 'reportError',
    ];
    const envelope = await runWorker(`
      const callable = [];
      let prototype = Object.getPrototypeOf(globalThis);
      while (prototype !== null) {
        for (const name of args.authorityNames) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
          if (descriptor && typeof descriptor.value === "function") {
            callable.push(name);
            if (name === "fetch") descriptor.value("https://example.invalid");
          }
        }
        prototype = Object.getPrototypeOf(prototype);
      }
      return { callable };
    `, { authorityNames }, { nodes: [] }, {
      globals: {
        inheritedAuthority() {},
        inheritedFetch() { inheritedFetchCalls += 1; },
      },
      setup: `
        const workerGlobalPrototype = Object.create(Object.getPrototypeOf(globalThis));
        for (const name of ${JSON.stringify(authorityNames)}) {
          Object.defineProperty(workerGlobalPrototype, name, {
            value: name === "fetch" ? inheritedFetch : inheritedAuthority,
            writable: true,
            configurable: true,
          });
        }
        Object.setPrototypeOf(globalThis, workerGlobalPrototype);
      `,
    });

    expect(envelope).toEqual({ ok: true, value: { callable: [] }, mutations: [] });
    expect(inheritedFetchCalls).toBe(0);
  });

  it('removes Worker font-loading authority before approved source runs', async () => {
    let fontLoadCalls = 0;
    const envelope = await runWorker(`
      return {
        fontFace: typeof FontFace,
        fontFaceSet: typeof FontFaceSet,
        fonts: typeof fonts,
      };
    `, null, { nodes: [] }, {
      globals: {
        FontFace: class {
          load() {
            fontLoadCalls += 1;
            return Promise.resolve(this);
          }
        },
        FontFaceSet: class {},
        fonts: { load() { fontLoadCalls += 1; return Promise.resolve([]); } },
      },
    });

    expect(envelope).toEqual({
      ok: true,
      value: {
        fontFace: 'undefined',
        fontFaceSet: 'undefined',
        fonts: 'undefined',
      },
      mutations: [],
    });
    expect(fontLoadCalls).toBe(0);
  });

  it('rejects direct and comment-obfuscated ImportExpression syntax before execution', async () => {
    const executions: string[] = [];
    const globals = { mark(value: string) { executions.push(value); } };
    const direct = await runWorker(`
      mark("direct");
      return import("data:text/javascript,export default 1");
    `, null, { nodes: [] }, { globals });
    const obfuscated = await runWorker(`
      mark("obfuscated");
      return import /* one */ \n /* two */ ("data:text/javascript,export default 2");
    `, null, { nodes: [] }, { globals });
    const unicodeWhitespace = await runWorker(`
      mark("unicode-whitespace");
      return import\u2003("data:text/javascript,export default 3");
    `, null, { nodes: [] }, { globals });
    const templateExpression = await runWorker(`
      mark("template-expression");
      return \`\${import("data:text/javascript,export default 4")}\`;
    `, null, { nodes: [] }, { globals });
    const divisionObfuscated = await runWorker(`
      try { throw new Error("expected"); } catch {
        (1) / import("data:,export default 5") / 2;
        mark("division-obfuscated");
      }
      return null;
    `, null, { nodes: [] }, { globals });
    const unicodeIdentifier = await runWorker(`
      const π = 1;
      π / await import("data:,export default 6") / 2;
      mark("unicode-identifier");
      return null;
    `, null, { nodes: [] }, { globals });

    expect(direct).toEqual({ ok: false, code: 'automation_failed' });
    expect(obfuscated).toEqual({ ok: false, code: 'automation_failed' });
    expect(unicodeWhitespace).toEqual({ ok: false, code: 'automation_failed' });
    expect(templateExpression).toEqual({ ok: false, code: 'automation_failed' });
    expect(divisionObfuscated).toEqual({ ok: false, code: 'automation_failed' });
    expect(unicodeIdentifier).toEqual({ ok: false, code: 'automation_failed' });
    expect(executions).toEqual([]);
  });

  it('rejects eval and recovered code-generation constructors', async () => {
    const recovered: string[] = [];
    const globals = { mark(value: string) { recovered.push(value); } };
    const evalImport = await runWorker(`
      if (typeof eval === "function") mark("eval");
      return await eval('import("data:text/javascript,export default 1")');
    `, null, { nodes: [] }, { globals });
    const functionImport = await runWorker(`
      if (typeof Function === "function") mark("Function");
      return await Function('return import("data:text/javascript,export default 2")')();
    `, null, { nodes: [] }, { globals });
    const asyncFunctionImport = await runWorker(`
      const AsyncFunction = (async () => {}).constructor;
      if (typeof AsyncFunction === "function") mark("AsyncFunction");
      return await AsyncFunction('return import("data:text/javascript,export default 3")')();
    `, null, { nodes: [] }, { globals });

    expect(evalImport).toEqual({ ok: false, code: 'automation_failed' });
    expect(functionImport).toEqual({ ok: false, code: 'automation_failed' });
    expect(asyncFunctionImport).toEqual({ ok: false, code: 'automation_failed' });
    expect(recovered).toEqual([]);
  });

  it('removes constructor recovery paths from function prototypes', async () => {
    const envelope = await runWorker(`
      return {
        eval: typeof eval,
        publicFunction: typeof Function,
        arrow: typeof (() => {}).constructor,
        async: typeof (async () => {}).constructor,
        generator: typeof (function* () {}).constructor,
        asyncGenerator: typeof (async function* () {}).constructor,
        arrayMethod: typeof [].map.constructor,
        functionPrototype: typeof Object.getPrototypeOf(() => {}).constructor,
        asyncPrototype: typeof Object.getPrototypeOf(async () => {}).constructor,
      };
    `);

    expect(envelope).toEqual({
      ok: true,
      value: {
        eval: 'undefined',
        publicFunction: 'undefined',
        arrow: 'undefined',
        async: 'undefined',
        generator: 'undefined',
        asyncGenerator: 'undefined',
        arrayMethod: 'undefined',
        functionPrototype: 'undefined',
        asyncPrototype: 'undefined',
      },
      mutations: [],
    });
  });

  it('allows inert import text in strings, comments, and template raw text', async () => {
    const envelope = await runWorker(`
      const single = 'import("string")';
      const double = "import('string')";
      const template = \`import("template")\`;
      // import("line-comment")
      /* import("block-comment") */
      return {
        single,
        double,
        template,
      };
    `);

    expect(envelope).toEqual({
      ok: true,
      value: {
        single: 'import("string")',
        double: "import('string')",
        template: 'import("template")',
      },
      mutations: [],
    });
  });

  it('rejects regex literals rather than guessing whether a slash starts a regex', async () => {
    const executions: string[] = [];
    const envelope = await runWorker(`
      mark("executed");
      return /safe/.test("safe");
    `, null, { nodes: [] }, {
      globals: { mark(value: string) { executions.push(value); } },
    });

    expect(envelope).toEqual({ ok: false, code: 'automation_failed' });
    expect(executions).toEqual([]);
  });

  it('exposes immutable snapshot queries and all declarative mutation builders', async () => {
    const envelope = await runWorker(`
      const node = page.get("n1");
      const snapshotIsFrozen = Object.isFrozen(page.snapshot)
        && Object.isFrozen(page.snapshot.nodes)
        && Object.isFrozen(page.snapshot.nodes[0]);
      try { page.snapshot.nodes[0].tagName = "BUTTON"; } catch (_) {}
      page.setText(node.id, args.text);
      page.setAttribute(node.id, "aria-label", "Updated");
      page.removeAttribute(node.id, "title");
      page.setProperty(node.id, "disabled", false);
      page.setFormValue(node.id, "value");
      page.setChecked(node.id, true);
      page.focus(node.id);
      return {
        tag: page.get("n1").tagName,
        missing: page.get("missing"),
        snapshotIsFrozen,
      };
    `, { text: 'Hello' }, {
      nodes: [{
        id: 'n1',
        tagName: 'INPUT',
        text: '',
        attributes: { title: 'Old' },
        value: '',
      }],
    });

    expect(envelope).toEqual({
      ok: true,
      value: { tag: 'INPUT', missing: null, snapshotIsFrozen: true },
      mutations: [
        { kind: 'set_text', nodeId: 'n1', value: 'Hello' },
        { kind: 'set_attribute', nodeId: 'n1', name: 'aria-label', value: 'Updated' },
        { kind: 'remove_attribute', nodeId: 'n1', name: 'title' },
        { kind: 'set_property', nodeId: 'n1', name: 'disabled', value: false },
        { kind: 'set_form_value', nodeId: 'n1', value: 'value' },
        { kind: 'set_checked', nodeId: 'n1', value: true },
        { kind: 'focus', nodeId: 'n1' },
      ],
    });
  });

  it('returns canonical cloned JSON after approved source poisons ambient intrinsics', async () => {
    const envelope = await runWorker(`
      try {
        Object.defineProperty(Object.prototype, "toJSON", {
          value() { return "forged"; },
        });
      } catch (_) {}
      globalThis.JSON = {
        parse() { return "forged"; },
        stringify() { return '"forged"'; },
      };
      globalThis.Object = {
        getPrototypeOf() { return null; },
        getOwnPropertyDescriptor() { return null; },
      };
      globalThis.TextEncoder = class {
        encode() { return new Uint8Array(); }
      };
      page.setProperty("n1", "state", { enabled: true });
      return { answer: args.value + 1, items: [null, "ok", 3] };
    `, { value: 41 }, {
      nodes: [{ id: 'n1', tagName: 'DIV', text: '', attributes: {} }],
    });

    expect(envelope).toEqual({
      ok: true,
      value: { answer: 42, items: [null, 'ok', 3] },
      mutations: [{
        kind: 'set_property',
        nodeId: 'n1',
        name: 'state',
        value: { enabled: true },
      }],
    });
  });

  it('rejects accessors and non-canonical values', async () => {
    const accessor = await runWorker('return { get secret() { return 1; } };');
    const cyclic = await runWorker('const value = {}; value.self = value; return value;');
    const symbol = await runWorker('return { value: Symbol("secret") };');
    const nonFinite = await runWorker('return { value: Infinity };');
    const prototype = await runWorker('return new Date(0);');

    expect(accessor).toEqual({ ok: false, code: 'serialization_failed' });
    expect(cyclic).toEqual({ ok: false, code: 'serialization_failed' });
    expect(symbol).toEqual({ ok: false, code: 'serialization_failed' });
    expect(nonFinite).toEqual({ ok: false, code: 'serialization_failed' });
    expect(prototype).toEqual({ ok: false, code: 'serialization_failed' });
  });

  it('rejects more than 256 mutations', async () => {
    const envelope = await runWorker(`
      for (let index = 0; index < 257; index += 1) page.setText("n1", "x");
      return null;
    `, null, {
      nodes: [{ id: 'n1', tagName: 'DIV', text: '', attributes: {} }],
    });
    const caught = await runWorker(`
      try {
        for (let index = 0; index < 257; index += 1) page.setText("n1", "x");
      } catch (_) {}
      return null;
    `, null, {
      nodes: [{ id: 'n1', tagName: 'DIV', text: '', attributes: {} }],
    });

    expect(envelope).toEqual({ ok: false, code: 'mutation_plan_invalid' });
    expect(caught).toEqual({ ok: false, code: 'mutation_plan_invalid' });
  });

  it('rejects result envelopes larger than 256 KiB', async () => {
    const envelope = await runWorker('return "x".repeat(262144);');

    expect(envelope).toEqual({ ok: false, code: 'result_too_large' });
  });

  it('rejects oversized results after approved source poisons typed-array byteLength', async () => {
    const envelope = await runWorker(`
      const bytes = new TextEncoder().encode("");
      const typedArrayPrototype = Object.getPrototypeOf(Object.getPrototypeOf(bytes));
      Object.defineProperty(typedArrayPrototype, "byteLength", {
        configurable: true,
        get() { return 0; },
      });
      return "x".repeat(262144);
    `);

    expect(envelope).toEqual({ ok: false, code: 'result_too_large' });
  });

  it('does not share poisoned globals between Worker VM invocations', async () => {
    const first = await runWorker(`
      globalThis.__psycheWorkerPoison = true;
      return { installed: globalThis.__psycheWorkerPoison };
    `);
    const second = await runWorker(`
      return { poisoned: globalThis.__psycheWorkerPoison === true };
    `);

    expect(first).toEqual({ ok: true, value: { installed: true }, mutations: [] });
    expect(second).toEqual({ ok: true, value: { poisoned: false }, mutations: [] });
  });

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

  it('redacts executable and embedded element text from Worker snapshots', async () => {
    const script = fakeElement('SCRIPT');
    script.textContent = 'window.inlineSecret = "script-secret";';
    const style = fakeElement('STYLE');
    style.textContent = '.private { background: url("style-secret") }';
    const iframe = fakeElement('IFRAME');
    iframe.textContent = 'embedded-secret';
    const visible = fakeElement('P');
    visible.textContent = 'visible text';
    const root = fakeElement('HTML', [script, style, iframe, visible]);

    const { workerInput } = await runPageRuntime({ ok: true, value: null, mutations: [] }, root);
    const snapshot = workerInput?.snapshot as { nodes: Array<{ tagName: string; text: string }> };

    expect(snapshot.nodes.map(({ tagName, text }) => [tagName, text])).toEqual([
      ['HTML', ''],
      ['SCRIPT', ''],
      ['STYLE', ''],
      ['IFRAME', ''],
      ['P', 'visible text'],
    ]);
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
});
