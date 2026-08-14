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

async function runIsolated(source: string, args: unknown = null): Promise<Record<string, unknown>> {
  const context = createContext({ TextEncoder, performance });
  const encoded = JSON.stringify({ source, args });
  const result = await runInContext(`${runtimeSource()}(${encoded})`, context) as string;
  return JSON.parse(result) as Record<string, unknown>;
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
});
