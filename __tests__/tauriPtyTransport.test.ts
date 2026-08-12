import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createPtyClient,
  disposePtyClient,
  routePtyBatch,
  type PtyDataBatch,
} from '../native/desktop/psyche-build-tauri/web/runtime/pty-client';

type WriteCallback = () => void;

function batch(threadId: string, sequence: number, bytes = [sequence]): PtyDataBatch {
  return {
    threadId,
    sequence,
    bytes,
    byteCount: bytes.length,
  };
}

function fakeTerminal() {
  const writes: Uint8Array[] = [];
  const callbacks: WriteCallback[] = [];
  return {
    writes,
    callbacks,
    term: {
      write(data: Uint8Array, callback: WriteCallback) {
        writes.push(data);
        callbacks.push(callback);
      },
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const source = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const webMain = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);
const webIndex = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/index.html'),
  'utf8',
);

function webFunctionSource(name: string): string {
  const start = webMain.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing web function ${name}`);
  const bodyStart = webMain.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < webMain.length; index += 1) {
    if (webMain[index] === '{') depth += 1;
    if (webMain[index] === '}') depth -= 1;
    if (depth === 0) return webMain.slice(start, index + 1);
  }
  throw new Error(`unterminated web function ${name}`);
}

describe('typed frontend PTY batch client', () => {
  test('accepts only exact ordered batches for its thread and acknowledges after xterm completion', async () => {
    const terminal = fakeTerminal();
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    const client = createPtyClient({
      threadId: 'pane-a',
      term: terminal.term,
      invoke(command, args) {
        invokes.push({ command, args });
        return Promise.resolve();
      },
    });

    expect(client.accept(batch('pane-b', 1))).toBe(false);
    expect(client.accept(batch('pane-a', 2))).toBe(false);
    expect(client.accept(batch('pane-a', 1))).toBe(true);
    expect(client.accept(batch('pane-a', 1))).toBe(false);
    expect(client.accept(batch('pane-a', 3))).toBe(false);
    expect(client.accept(batch('pane-a', 2))).toBe(true);
    expect(client.accept(batch('pane-a', 3))).toBe(false);
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1]]);
    expect(invokes).toEqual([]);

    terminal.callbacks.shift()?.();
    expect(invokes).toEqual([
      {
        command: 'pty_ack',
        args: { threadId: 'pane-a', thread_id: 'pane-a', sequence: 1 },
      },
    ]);
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1]]);
    await flushPromises();
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1], [2]]);

    terminal.callbacks.shift()?.();
    await flushPromises();
    expect(invokes[1]).toEqual({
      command: 'pty_ack',
      args: { threadId: 'pane-a', thread_id: 'pane-a', sequence: 2 },
    });
    disposePtyClient('pane-a');
  });

  test('rejects malformed, oversized, and excess batches without retaining transcript history', () => {
    const terminal = fakeTerminal();
    const client = createPtyClient({
      threadId: 'bounded',
      term: terminal.term,
      invoke: () => Promise.resolve(),
    });

    expect(client.accept(batch('bounded', Number.NaN))).toBe(false);
    expect(client.accept(batch('bounded', 1, [0, 256]))).toBe(false);
    expect(client.accept({ ...batch('bounded', 1, [1]), byteCount: 2 })).toBe(false);
    expect(client.accept(batch('bounded', 1, new Array(65_537).fill(1)))).toBe(false);
    expect(client.accept(batch('bounded', 1, [1]))).toBe(true);
    expect(client.accept(batch('bounded', 2, [2]))).toBe(true);
    expect(client.accept(batch('bounded', 3, [3]))).toBe(false);
    expect(terminal.writes).toHaveLength(1);
    disposePtyClient('bounded');
  });

  test('stalls safely without acknowledgement when xterm write throws', async () => {
    const invokes: string[] = [];
    const client = createPtyClient({
      threadId: 'write-error',
      term: {
        write() {
          throw new Error('xterm failed');
        },
      },
      invoke(command) {
        invokes.push(command);
        return Promise.resolve();
      },
    });

    expect(client.accept(batch('write-error', 1))).toBe(true);
    expect(client.accept(batch('write-error', 2))).toBe(false);
    await flushPromises();
    expect(invokes).toEqual([]);
    disposePtyClient('write-error');
  });

  test('ack failure is handled and leaves queued output stalled without duplicate writes', async () => {
    const terminal = fakeTerminal();
    const client = createPtyClient({
      threadId: 'ack-error',
      term: terminal.term,
      invoke: () => Promise.reject(new Error('ack failed')),
    });

    expect(client.accept(batch('ack-error', 1))).toBe(true);
    expect(client.accept(batch('ack-error', 2))).toBe(true);
    terminal.callbacks.shift()?.();
    await flushPromises();
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1]]);
    expect(client.accept(batch('ack-error', 3))).toBe(false);
    disposePtyClient('ack-error');
  });

  test('handles synchronous ack failure and duplicate write callbacks without escaping or retrying', async () => {
    const terminal = fakeTerminal();
    let ackCalls = 0;
    const client = createPtyClient({
      threadId: 'sync-ack-error',
      term: terminal.term,
      invoke() {
        ackCalls += 1;
        throw new Error('sync ack failure');
      },
    });

    expect(client.accept(batch('sync-ack-error', 1))).toBe(true);
    const complete = terminal.callbacks.shift();
    expect(() => complete?.()).not.toThrow();
    expect(() => complete?.()).not.toThrow();
    await flushPromises();
    expect(ackCalls).toBe(1);
    expect(client.accept(batch('sync-ack-error', 2))).toBe(false);
    disposePtyClient('sync-ack-error');
  });

  test('accepts a replacement batch routed re-entrantly inside the acknowledgement invoke', async () => {
    const terminal = fakeTerminal();
    const acknowledgements: number[] = [];
    let reentrantAccepted = false;
    createPtyClient({
      threadId: 'reentrant-ack',
      term: terminal.term,
      invoke(command, args) {
        if (command === 'pty_ack') {
          acknowledgements.push(args.sequence as number);
          if (args.sequence === 1) {
            reentrantAccepted = routePtyBatch(batch('reentrant-ack', 3, [3]));
          }
        }
        return Promise.resolve();
      },
    });

    expect(routePtyBatch(batch('reentrant-ack', 1, [1]))).toBe(true);
    expect(routePtyBatch(batch('reentrant-ack', 2, [2]))).toBe(true);
    const firstComplete = terminal.callbacks.shift();
    firstComplete?.();
    firstComplete?.();
    expect(reentrantAccepted).toBe(true);
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1]]);
    await flushPromises();
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1], [2]]);
    terminal.callbacks.shift()?.();
    await flushPromises();
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1], [2], [3]]);
    expect(acknowledgements).toEqual([1, 2]);
    disposePtyClient('reentrant-ack');
  });

  test('accepts the next exact batch while acknowledgement response is pending', async () => {
    const terminal = fakeTerminal();
    const firstAck = deferred<unknown>();
    const client = createPtyClient({
      threadId: 'pending-ack',
      term: terminal.term,
      invoke(command, args) {
        if (command === 'pty_ack' && args.sequence === 1) return firstAck.promise;
        return Promise.resolve();
      },
    });

    expect(client.accept(batch('pending-ack', 1, [1]))).toBe(true);
    expect(client.accept(batch('pending-ack', 2, [2]))).toBe(true);
    terminal.callbacks.shift()?.();
    expect(client.accept(batch('pending-ack', 3, [3]))).toBe(true);
    expect(client.accept(batch('pending-ack', 4, [4]))).toBe(false);
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1]]);
    firstAck.resolve(undefined);
    await flushPromises();
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1], [2]]);
    disposePtyClient('pending-ack');
  });

  test('stalls with only bounded queued payloads when ack rejects after replacement acceptance', async () => {
    const terminal = fakeTerminal();
    const firstAck = deferred<unknown>();
    let ackCalls = 0;
    const client = createPtyClient({
      threadId: 'late-ack-error',
      term: terminal.term,
      invoke(command) {
        if (command === 'pty_ack') {
          ackCalls += 1;
          return firstAck.promise;
        }
        return Promise.resolve();
      },
    });

    expect(client.accept(batch('late-ack-error', 1, [1]))).toBe(true);
    expect(client.accept(batch('late-ack-error', 2, [2]))).toBe(true);
    const firstComplete = terminal.callbacks.shift();
    firstComplete?.();
    expect(client.accept(batch('late-ack-error', 3, [3]))).toBe(true);
    expect(client.accept(batch('late-ack-error', 4, [4]))).toBe(false);
    firstComplete?.();
    firstAck.reject(new Error('late rejection'));
    await flushPromises();
    expect(ackCalls).toBe(1);
    expect(terminal.writes.map((value) => Array.from(value))).toEqual([[1]]);
    expect(client.accept(batch('late-ack-error', 4, [4]))).toBe(false);
    disposePtyClient('late-ack-error');
  });

  test('visibility invokes only on effective changes with Tauri dual-key arguments', async () => {
    const terminal = fakeTerminal();
    const invokes: Array<{ command: string; args: Record<string, unknown> }> = [];
    const client = createPtyClient({
      threadId: 'visible',
      term: terminal.term,
      invoke(command, args) {
        invokes.push({ command, args });
        return Promise.resolve();
      },
    });

    expect(client.setVisible(true)).toBe(true);
    await flushPromises();
    expect(client.setVisible(true)).toBe(false);
    expect(client.setVisible(false)).toBe(true);
    expect(client.setVisible(false)).toBe(false);
    await flushPromises();
    expect(client.setVisible(true)).toBe(true);
    await flushPromises();
    expect(invokes).toEqual([
      {
        command: 'pty_set_visibility',
        args: { threadId: 'visible', thread_id: 'visible', visible: true },
      },
      {
        command: 'pty_set_visibility',
        args: { threadId: 'visible', thread_id: 'visible', visible: false },
      },
      {
        command: 'pty_set_visibility',
        args: { threadId: 'visible', thread_id: 'visible', visible: true },
      },
    ]);
    disposePtyClient('visible');
  });

  test('retries the same visibility after synchronous and asynchronous delivery failures', async () => {
    const terminal = fakeTerminal();
    const pending = deferred<unknown>();
    let attempts = 0;
    const client = createPtyClient({
      threadId: 'visibility-retry',
      term: terminal.term,
      invoke() {
        attempts += 1;
        if (attempts === 1) throw new Error('not started');
        if (attempts === 2) return Promise.reject(new Error('still not started'));
        return pending.promise;
      },
    });

    expect(client.setVisible(false)).toBe(true);
    expect(client.setVisible(false)).toBe(true);
    await flushPromises();
    expect(client.setVisible(false)).toBe(true);
    expect(attempts).toBe(3);
    pending.resolve(undefined);
    await flushPromises();
    expect(client.setVisible(false)).toBe(false);
    expect(attempts).toBe(3);
    disposePtyClient('visibility-retry');
  });

  test('serializes overlapping visibility delivery and sends only the latest desired state', async () => {
    const terminal = fakeTerminal();
    const deliveries: Array<{
      visible: boolean;
      pending: ReturnType<typeof deferred<unknown>>;
    }> = [];
    const client = createPtyClient({
      threadId: 'visibility-latest',
      term: terminal.term,
      invoke(_command, args) {
        const pending = deferred<unknown>();
        deliveries.push({ visible: args.visible as boolean, pending });
        return pending.promise;
      },
    });

    expect(client.setVisible(false)).toBe(true);
    expect(client.setVisible(true)).toBe(true);
    expect(client.setVisible(true)).toBe(false);
    expect(deliveries.map((delivery) => delivery.visible)).toEqual([false]);

    deliveries[0].pending.resolve(undefined);
    await flushPromises();
    expect(deliveries.map((delivery) => delivery.visible)).toEqual([false, true]);
    deliveries[1].pending.resolve(undefined);
    await flushPromises();
    expect(client.setVisible(true)).toBe(false);
    expect(deliveries).toHaveLength(2);
    disposePtyClient('visibility-latest');
  });

  test('routes only to the matching client and disposal prevents further acceptance', () => {
    const first = fakeTerminal();
    const second = fakeTerminal();
    createPtyClient({ threadId: 'first', term: first.term, invoke: () => Promise.resolve() });
    createPtyClient({ threadId: 'second', term: second.term, invoke: () => Promise.resolve() });

    expect(routePtyBatch(batch('missing', 1))).toBe(false);
    expect(routePtyBatch(batch('second', 1, [9]))).toBe(true);
    expect(first.writes).toEqual([]);
    expect(second.writes.map((value) => Array.from(value))).toEqual([[9]]);
    expect(disposePtyClient('second')).toBe(true);
    expect(routePtyBatch(batch('second', 2))).toBe(false);
    expect(disposePtyClient('second')).toBe(false);
    disposePtyClient('first');
  });
});

describe('typed frontend PTY batch integration', () => {
  test('loads the runtime before main and routes only the batched event', () => {
    expect(webIndex.indexOf('./runtime.bundle.js')).toBeGreaterThan(-1);
    expect(webIndex.indexOf('./runtime.bundle.js')).toBeLessThan(webIndex.indexOf('./main.js'));
    expect(webMain).toContain('listen("pty:data-batch"');
    expect(webMain).toContain('thread.terminalController.receive(payload)');
    expect(webMain).not.toContain('listen("pty:data"');
    expect(webMain).not.toContain('pendingDataBuffers');
  });

  test('registers, updates visibility, and disposes pane-owned controllers', () => {
    expect(webMain).toContain('PsycheRuntime.createTerminalPaneController({');
    expect(webMain).toContain('thread.terminalController.setVisibility({');
    expect(webMain).toContain('thread.terminalController.dispose();');
  });

  test('resynchronizes effective pane visibility only after PTY start succeeds', () => {
    const spawn = webFunctionSource('spawnPty');
    const running = spawn.indexOf('thread.status = "running";');
    const resync = spawn.indexOf('syncPtyClientVisibility();', running);
    expect(running).toBeGreaterThan(-1);
    expect(resync).toBeGreaterThan(running);
    expect(spawn.indexOf('thread.terminalController.resyncPtyVisibility();', resync)).toBeGreaterThan(resync);
    expect(spawn).toMatch(
      /else\s*\{[\s\S]*thread\.ptyStarted = false;[\s\S]*thread\.terminalController\.stopPtyDelivery\(\);[\s\S]*thread\.status = "failed";/,
    );
  });
});

function commandSource(sourceText: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(
    `#\\[tauri::command\\]\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escapedName}\\s*\\(`,
    'g',
  );
  const match = declaration.exec(sourceText);
  if (match) {
    const commandStart = match.index;
    const nextCommand = sourceText.indexOf('#[tauri::command]', commandStart + match[0].length);
    return sourceText.slice(commandStart, nextCommand === -1 ? sourceText.length : nextCommand);
  }

  throw new Error(`missing Tauri command ${name}`);
}

function rustFunctionSource(sourceText: string, name: string, anchor = 0): string {
  const declaration = new RegExp(`fn\\s+${name}\\s*\\(`, 'g');
  declaration.lastIndex = anchor;
  const match = declaration.exec(sourceText);
  if (!match) throw new Error(`missing Rust function ${name}`);
  const bodyStart = sourceText.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for Rust function ${name}`);
  const bodyEnd = matchingDelimiter(sourceText, bodyStart);
  if (bodyEnd === -1) throw new Error(`unterminated body for Rust function ${name}`);
  return sourceText.slice(match.index, bodyEnd + 1);
}

function implMethodSource(typeName: string, methodName: string): string {
  const implStart = source.indexOf(`impl ${typeName}`);
  if (implStart === -1) throw new Error(`missing impl ${typeName}`);
  const implBodyStart = source.indexOf('{', implStart);
  if (implBodyStart === -1) throw new Error(`missing body for impl ${typeName}`);
  const implBodyEnd = matchingDelimiter(source, implBodyStart);
  if (implBodyEnd === -1) throw new Error(`unterminated body for impl ${typeName}`);
  return rustFunctionSource(source.slice(implStart, implBodyEnd + 1), methodName);
}

function structSource(name: string): string {
  const declaration = new RegExp(`struct\\s+${name}\\b`);
  const match = declaration.exec(source);
  if (!match) throw new Error(`missing Rust struct ${name}`);
  const bodyStart = source.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for Rust struct ${name}`);
  const bodyEnd = matchingDelimiter(source, bodyStart);
  if (bodyEnd === -1) throw new Error(`unterminated body for Rust struct ${name}`);
  return source.slice(match.index, bodyEnd + 1);
}

function matchingDelimiter(sourceText: string, openingIndex: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const opening = sourceText[openingIndex];
  const closing = pairs[opening];
  if (!closing) throw new Error(`unsupported opening delimiter ${opening}`);

  let depth = 0;
  for (let index = openingIndex; index < sourceText.length; index += 1) {
    if (sourceText.startsWith('//', index)) {
      index = sourceText.indexOf('\n', index + 2);
      if (index === -1) return -1;
      continue;
    }
    if (sourceText.startsWith('/*', index)) {
      let commentDepth = 1;
      index += 2;
      while (index < sourceText.length && commentDepth > 0) {
        if (sourceText.startsWith('/*', index)) {
          commentDepth += 1;
          index += 2;
        } else if (sourceText.startsWith('*/', index)) {
          commentDepth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      index -= 1;
      continue;
    }

    const rawString = /^(?:b?r)(#+)?"/.exec(sourceText.slice(index));
    if (rawString) {
      const hashes = rawString[1] ?? '';
      const terminator = `"${hashes}`;
      const stringEnd = sourceText.indexOf(terminator, index + rawString[0].length);
      if (stringEnd === -1) throw new Error('unterminated raw string');
      index = stringEnd + terminator.length - 1;
      continue;
    }
    if (sourceText[index] === '"' || sourceText.startsWith('b"', index)) {
      if (sourceText[index] === 'b') index += 1;
      for (index += 1; index < sourceText.length; index += 1) {
        if (sourceText[index] === '\\') {
          index += 1;
        } else if (sourceText[index] === '"') {
          break;
        }
      }
      continue;
    }
    const charLiteral = /^(?:b)?'(?:\\(?:[nrt0\\'\"]|x[\da-fA-F]{2}|u\{[\da-fA-F_]+\})|[^\\'\r\n])'/.exec(
      sourceText.slice(index),
    );
    if (charLiteral) {
      index += charLiteral[0].length - 1;
      continue;
    }

    if (sourceText[index] === opening) depth += 1;
    if (sourceText[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function blockingClosureRange(command: string): { start: number; end: number } {
  const spawn = command.indexOf('tauri::async_runtime::spawn_blocking');
  if (spawn === -1) throw new Error('missing spawn_blocking call');
  const callStart = command.indexOf('(', spawn);
  if (callStart === -1) throw new Error('missing spawn_blocking call delimiter');
  const callEnd = matchingDelimiter(command, callStart);
  if (callEnd === -1) throw new Error('unterminated spawn_blocking call');

  const closure = command.indexOf('move ||', callStart);
  if (closure === -1 || closure > callEnd) throw new Error('missing spawn_blocking closure');
  const bodyStart = command.indexOf('{', closure);
  if (bodyStart === -1 || bodyStart > callEnd) throw new Error('missing closure body delimiter');
  const bodyEnd = matchingDelimiter(command, bodyStart);
  if (bodyEnd === -1 || bodyEnd > callEnd) {
    throw new Error('unterminated spawn_blocking closure');
  }
  return { start: bodyStart, end: bodyEnd + 1 };
}

function blockingClosureSource(command: string): string {
  const { start, end } = blockingClosureRange(command);
  return command.slice(start, end);
}

function sourceOutsideBlockingClosure(command: string): string {
  const { start, end } = blockingClosureRange(command);
  return command.slice(0, start) + command.slice(end);
}

describe('commandSource helper', () => {
  test('matches the declaration attached to the tauri attribute', () => {
    const fixture = `#[tauri::command]
fn earlier() {
  // Keep this exact declaration text inert: pub async fn later(
}

#[tauri::command]
pub async fn later() -> Result<(), String> {
  Ok(())
}
`;

    const command = commandSource(fixture, 'later');
    expect(command).toMatch(/#\[tauri::command\]\s*pub\s+async\s+fn\s+later\b/);
    expect(command).not.toContain('fn earlier()');
  });
});

describe('Tauri PTY command threading contract', () => {
  test('exposes acknowledgement, visibility, and transport metrics commands', () => {
    const ack = commandSource(source, 'pty_ack');
    const visibility = commandSource(source, 'pty_set_visibility');
    const metrics = commandSource(source, 'pty_transport_metrics');

    expect(ack).toMatch(
      /fn\s+pty_ack\s*\(\s*thread_id:\s*String,\s*sequence:\s*u64\s*\)\s*->\s*Result<AckOutcome,\s*String>/,
    );
    expect(visibility).toMatch(
      /fn\s+pty_set_visibility\s*\(\s*thread_id:\s*String,\s*visible:\s*bool\s*\)\s*->\s*Result<\(\),\s*String>/,
    );
    expect(metrics).toMatch(
      /fn\s+pty_transport_metrics\s*\(\s*thread_id:\s*Option<String>\s*\)\s*->\s*Vec<PtyTransportSnapshot>/,
    );
    expect(source).toMatch(
      /tauri::generate_handler!\s*\[[\s\S]*pty_ack,\s*pty_set_visibility,\s*pty_transport_metrics,[\s\S]*\]/,
    );
  });

  test('emits only batched PTY output events', () => {
    expect(source).toContain('.emit("pty:data-batch", payload)');
    expect(source).not.toMatch(/\.emit\s*\(\s*"pty:data"/);
  });

  test('keeps timed-out generations reserved until cleanup after publishing exit', () => {
    const start = commandSource(source, 'pty_start');
    const exitEmission = start.indexOf('"pty:exit"');
    const timeoutCleanup = start.indexOf('shutdown.finish_terminated_threads');
    const cleanupCompletion = start.indexOf('shutdown.finish_terminated_threads_to_completion');
    const generationFinalization = start.indexOf('PTY_LIFECYCLES.lock().finish_exit');

    expect(exitEmission).toBeGreaterThan(-1);
    expect(timeoutCleanup).toBeGreaterThan(exitEmission);
    expect(cleanupCompletion).toBeGreaterThan(timeoutCleanup);
    expect(generationFinalization).toBeGreaterThan(cleanupCompletion);
  });

  test('acknowledges and changes visibility after releasing the lifecycle guard', () => {
    const ack = commandSource(source, 'pty_ack');
    const visibility = commandSource(source, 'pty_set_visibility');

    for (const [command, operation] of [
      [ack, /pump\.acknowledge\(sequence\)/],
      [visibility, /pump\.set_visibility\(/],
    ] as const) {
      const validation = command.indexOf('validate_pty_thread_id(&thread_id)');
      const lifecycleLookup = command.indexOf('PTY_LIFECYCLES.lock()');
      expect(validation).toBeGreaterThan(-1);
      expect(lifecycleLookup).toBeGreaterThan(validation);
      expect(command.slice(0, validation)).not.toContain('session.pump');
      expect(command).toMatch(
        /let\s+pump\s*=\s*\{[\s\S]*PTY_LIFECYCLES\.lock\(\)[\s\S]*session\.pump\.clone\(\)[\s\S]*\};/,
      );
      const guardEnd = command.indexOf('};');
      expect(guardEnd).toBeGreaterThan(-1);
      expect(command.slice(0, guardEnd)).not.toMatch(operation);
      expect(command.slice(guardEnd + 2)).toMatch(operation);
    }
    expect(source).toMatch(
      /fn\s+validate_pty_thread_id[\s\S]*is_safe_session_id\(thread_id\)[\s\S]*"thread id is unsafe"/,
    );
  });

  test('snapshots pumps after releasing lifecycle state and expose no raw output bytes', () => {
    const metrics = commandSource(source, 'pty_transport_metrics');
    const validation = metrics.indexOf('is_safe_session_id(requested)');
    const lifecycleLookup = metrics.indexOf('PTY_LIFECYCLES.lock()');
    expect(validation).toBeGreaterThan(-1);
    expect(lifecycleLookup).toBeGreaterThan(validation);
    expect(metrics.slice(validation, lifecycleLookup)).toMatch(/return\s+Vec::new\(\)/);
    expect(metrics).toMatch(
      /let\s+active\s*=\s*\{[\s\S]*PTY_LIFECYCLES\.lock\(\)[\s\S]*session\.pump\.clone\(\)[\s\S]*\};/,
    );
    const guardEnd = metrics.indexOf('};');
    expect(guardEnd).toBeGreaterThan(-1);
    expect(metrics.slice(0, guardEnd)).not.toContain('.snapshot()');
    expect(metrics.slice(guardEnd + 2)).toContain('.snapshot()');

    for (const dto of ['PtyTransportSnapshot', 'PtyTransportMetrics']) {
      const definition = structSource(dto);
      expect(definition).not.toMatch(
        /Vec\s*<\s*u8\s*>|Arc\s*<\s*\[\s*u8\s*\]\s*>|\bInstant\b/,
      );
      expect(definition).not.toMatch(/\b(?:data|bytes|output|payload)\s*:/);
    }
  });

  test('starts PTYs in blocking work without moving reader draining off its OS worker', () => {
    const prepare = rustFunctionSource(source, 'prepare_pty_start');
    const install = implMethodSource('PendingPtyStart', 'install');
    const command = commandSource(source, 'pty_start');

    const reserve = prepare.indexOf('PendingPtyStart::reserve(&thread_id)?');
    const openCwd = prepare.indexOf('open_pty_cwd(project_root, cwd)?');
    expect(reserve).toBeGreaterThan(-1);
    expect(openCwd).toBeGreaterThan(reserve);
    expect(install).toContain('PTY_LIFECYCLES');
    expect(install).toContain('.install(&self.token, session)');
    expect(command).toMatch(/#\[tauri::command\]\s*async\s+fn\s+pty_start\b/);
    const validation = command.indexOf('validate_pty_thread_id(&options.thread_id)');
    const reservation = command.indexOf('prepare_pty_start(&options)');
    const blockingStart = command.indexOf('tauri::async_runtime::spawn_blocking');
    expect(validation).toBeGreaterThan(-1);
    expect(reservation).toBeGreaterThan(validation);
    expect(blockingStart).toBeGreaterThan(reservation);
    const blocking = blockingClosureSource(command);
    expect(blocking).toContain('.openpty(');
    expect(blocking).toContain('.spawn_command(');
    expect(blocking).toContain('prepare_pty_reader(');
    expect(blocking).toContain('.take_writer()');
    const installCall = blocking.indexOf('pending_start.install(PtySession');
    expect(installCall).toBeGreaterThan(blocking.indexOf('.openpty('));
    expect(installCall).toBeGreaterThan(blocking.indexOf('.spawn_command('));
    expect(installCall).toBeGreaterThan(blocking.indexOf('prepare_pty_reader('));
    expect(installCall).toBeGreaterThan(blocking.indexOf('.take_writer()'));
    expect(blocking.slice(0, installCall)).not.toContain('PTY_LIFECYCLES.lock()');
    expect(blocking).toMatch(
      /std::thread::spawn\s*\(\s*move\s*\|\|\s*\{[\s\S]*pump_pty_reader\s*\(/,
    );
    const outside = sourceOutsideBlockingClosure(command);
    expect(outside).not.toContain('.openpty(');
    expect(outside).not.toContain('.spawn_command(');
    expect(outside).not.toContain('prepare_pty_reader(');
    expect(outside).not.toContain('.take_writer()');
    expect(outside).not.toContain('pump_pty_reader(');
  });

  test('writes through a pane-owned handle after releasing the lifecycle guard', () => {
    const command = commandSource(source, 'pty_write');

    expect(command).toMatch(/#\[tauri::command\]\s*async\s+fn\s+pty_write\b/);
    expect(command).toMatch(
      /let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*Arc::clone\(&session\.writer\)[\s\S]*drop\(guard\)[\s\S]*tauri::async_runtime::spawn_blocking/,
    );
    const blocking = blockingClosureSource(command);
    expect(blocking).not.toContain('PTY_LIFECYCLES');
    expect(blocking).toMatch(/writer\.lock\(\)[\s\S]*write_all\(&bytes\)[\s\S]*flush\(\)/);
    const outside = sourceOutsideBlockingClosure(command);
    expect(outside).not.toMatch(/writer\s*\.\s*lock\(\)/);
    expect(outside).not.toContain('write_all(&bytes)');
    expect(outside).not.toMatch(/writer\.flush\(\)/);
  });

  test('resizes through a pane-owned handle in blocking work', () => {
    const command = commandSource(source, 'pty_resize');

    expect(command).toMatch(/#\[tauri::command\]\s*async\s+fn\s+pty_resize\b/);
    expect(command).toMatch(
      /let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*Arc::clone\(&session\.master\)[\s\S]*drop\(guard\)[\s\S]*tauri::async_runtime::spawn_blocking/,
    );
    const blocking = blockingClosureSource(command);
    expect(blocking).not.toContain('PTY_LIFECYCLES');
    expect(blocking).toMatch(
      /master\s*\.\s*lock\(\)[\s\S]*\.resize\s*\(\s*PtySize/,
    );
    const outside = sourceOutsideBlockingClosure(command);
    expect(outside).not.toMatch(/master\s*\.\s*lock\(\)/);
    expect(outside).not.toMatch(/\.resize\s*\(\s*PtySize/);
  });

  test('keeps the long-lived PTY reader on a dedicated OS thread', () => {
    const command = commandSource(source, 'pty_start');

    expect(command).toMatch(
      /let\s+data_thread\s*=\s*std::thread::spawn\s*\(\s*move\s*\|\|\s*\{[\s\S]*pump_pty_reader\s*\(/,
    );
  });

  test('keeps PTY control commands async and off the Tauri main thread', () => {
    for (const name of ['pty_start', 'pty_write', 'pty_resize']) {
      const command = commandSource(source, name);
      expect(command).toMatch(/async fn/);
      expect(command).toMatch(/tauri::async_runtime::spawn_blocking/);
    }
  });

  test('extracts only the balanced blocking closure body', () => {
    const fixture = `tauri::async_runtime::spawn_blocking(move || {
      if ready(foo(bar())) { writer.write_all(&bytes)?; }
      let sample = r#"braces { and parentheses ( stay inert"#;
    }).await?;
    writer.write_all(&bytes)?;`;

    const blocking = blockingClosureSource(fixture);
    expect(blocking).toContain('ready(foo(bar()))');
    expect(blocking).toContain('braces { and parentheses ( stay inert');
    expect(blocking.match(/write_all/g)).toHaveLength(1);
    expect(sourceOutsideBlockingClosure(fixture)).toContain('writer.write_all(&bytes)?;');
  });
});
