import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

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
  const context = createContext({ TextEncoder, performance });
  const encoded = JSON.stringify({ source, args });
  const result = await runInContext(`${runtimeSource()}(${encoded})`, context) as string;
  return JSON.parse(result) as Record<string, unknown>;
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

  it('routes approved scripts through an invocation-scoped WKContentWorld', () => {
    expect(lib).toMatch(/async fn browser_script\(/);
    expect(lib).toContain('WKContentWorld::worldWithName');
    expect(lib).toContain('next_browser_script_execution_world_name');
    expect(lib).toContain('evaluate_browser_script_document_token');
    expect(main).toMatch(/operation\.kind === "script"[\s\S]{0,500}invoke\("browser_script"/);
    expect(main).not.toMatch(/operation\.kind === "script"[\s\S]{0,500}browserAutomationDispatchScript\(effect\)/);
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
        eventSource: typeof EventSource,
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
      };
    `);

    expect(envelope).toEqual({
      ok: true,
      value: {
        fetch: 'undefined',
        xhr: 'undefined',
        socket: 'undefined',
        eventSource: 'undefined',
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
      },
      mutations: [],
    });
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
});
