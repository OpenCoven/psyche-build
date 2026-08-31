import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createPtyClient,
  disposePtyClient,
  routePtyBatch,
  type PtyDataBatch,
} from '../native/desktop/psyche-build-tauri/web/runtime/pty-client';

const source = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const transportSource = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/pty_transport.rs'),
  'utf8',
);
const frontendTransportSource = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/runtime/pty-client.ts'),
  'utf8',
);
const mainSource = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/web/main.js'),
  'utf8',
);

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
  const declaration = new RegExp(`(?:pub\\s+)?fn\\s+${name}\\s*\\(`, 'g');
  declaration.lastIndex = anchor;
  const match = declaration.exec(sourceText);
  if (!match) throw new Error(`missing Rust function ${name}`);
  const bodyStart = sourceText.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for Rust function ${name}`);
  const bodyEnd = matchingDelimiter(sourceText, bodyStart);
  if (bodyEnd === -1) throw new Error(`unterminated body for Rust function ${name}`);
  return sourceText.slice(match.index, bodyEnd + 1);
}

function implMethodSource(sourceText: string, typeName: string, methodName: string): string {
  const declaration = new RegExp(`impl\\s+${typeName}\\b`);
  const match = declaration.exec(sourceText);
  const implStart = match?.index ?? -1;
  if (implStart === -1) throw new Error(`missing impl ${typeName}`);
  const implBodyStart = sourceText.indexOf('{', implStart);
  if (implBodyStart === -1) throw new Error(`missing body for impl ${typeName}`);
  const implBodyEnd = matchingDelimiter(sourceText, implBodyStart);
  if (implBodyEnd === -1) throw new Error(`unterminated body for impl ${typeName}`);
  return rustFunctionSource(sourceText.slice(implStart, implBodyEnd + 1), methodName);
}

function structSource(sourceText: string, name: string): string {
  const declaration = new RegExp(`struct\\s+${name}\\b`);
  const match = declaration.exec(sourceText);
  if (!match) throw new Error(`missing Rust struct ${name}`);
  const bodyStart = sourceText.indexOf('{', match.index + match[0].length);
  if (bodyStart === -1) throw new Error(`missing body for Rust struct ${name}`);
  const bodyEnd = matchingDelimiter(sourceText, bodyStart);
  if (bodyEnd === -1) throw new Error(`unterminated body for Rust struct ${name}`);
  return sourceText.slice(match.index, bodyEnd + 1);
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
  test('emits only batched PTY output events', () => {
    expect(source).toContain('.emit("pty:data-batch", payload)');
    expect(source).not.toMatch(/\.emit\s*\(\s*"pty:data"/);
  });

  test('carries the native session generation through the PTY event fence', () => {
    const startResult = structSource(source, 'PtyStartResult');
    const register = rustFunctionSource(source, 'register_pty_client');

    expect(startResult).toContain('generation: u64');
    expect(register).toContain(
      'OutputPump::new_with_generation(thread_id.clone(), generation)',
    );
    expect(transportSource).toContain('pub generation: u64');
    expect(frontendTransportSource).toContain('function nativeBatchDisposition');
    expect(frontendTransportSource).toContain('acknowledgementArgs(state.threadId, sequence, acknowledgement.nativeGeneration)');
    expect(mainSource).toContain(
      'ptyStartResult && Number.isSafeInteger(ptyStartResult.generation)',
    );
    expect(mainSource).toContain('markPtyExited(payload.generation)');
    expect(mainSource).toContain('pty_current_generation');
    expect(mainSource).toContain('if (exitAccepted === false) return false;');
  });

  test('defines PTY flow-control commands with the native transport contracts', () => {
    const ack = commandSource(source, 'pty_ack');
    const visibility = commandSource(source, 'pty_set_visibility');
    const metrics = commandSource(source, 'pty_transport_metrics');

    expect(ack).toMatch(
      /#\[tauri::command\]\s*fn\s+pty_ack\s*\(\s*webview:\s*tauri::Webview,\s*thread_id:\s*String,\s*sequence:\s*u64,\s*generation:\s*Option<u64>,?\s*\)\s*->\s*Result<AckOutcome,\s*String>/,
    );
    expect(visibility).toMatch(
      /#\[tauri::command\]\s*fn\s+pty_set_visibility\s*\(\s*webview:\s*tauri::Webview,\s*thread_id:\s*String,\s*visible:\s*bool,\s*generation:\s*Option<u64>,?\s*\)\s*->\s*Result<\(\),\s*String>/,
    );
    expect(metrics).toMatch(
      /#\[tauri::command\]\s*fn\s+pty_transport_metrics\s*\(\s*webview:\s*tauri::Webview,\s*thread_id:\s*Option<String>,?\s*\)\s*->\s*Result<Vec<PtyTransportSnapshot>,\s*String>/,
    );
  });

  test('registers PTY flow-control commands with the Tauri invoke handler', () => {
    expect(source).toMatch(
      /tauri::generate_handler!\[[\s\S]*pty_write,[\s\S]*pty_resize,[\s\S]*pty_ack,[\s\S]*pty_set_visibility,[\s\S]*pty_stop,[\s\S]*pty_list,[\s\S]*pty_transport_metrics,[\s\S]*\]/,
    );
  });

  test('keeps timed-out generations reserved until cleanup after publishing exit', () => {
    const start = commandSource(source, 'pty_start');
    const exitEmission = start.indexOf('"pty:exit"');
    const timeoutCleanup = start.indexOf('shutdown.finish_terminated_threads');
    const cleanupCompletion = start.indexOf(
      'shutdown.finish_terminated_threads(EXIT_TERMINATION_CLEANUP_TIMEOUT)',
      timeoutCleanup + 1,
    );
    const generationFinalization = start.indexOf('finish_pty_lifecycle(&shutdown)');

    expect(exitEmission).toBeGreaterThan(-1);
    expect(timeoutCleanup).toBeGreaterThan(exitEmission);
    expect(cleanupCompletion).toBeGreaterThan(timeoutCleanup);
    expect(generationFinalization).toBeGreaterThan(cleanupCompletion);
  });

  test('reserves PTY start state before resolving cwd and installs the session before reader drain begins', () => {
    const prepare = rustFunctionSource(source, 'prepare_pty_start');
    const install = implMethodSource(source, 'PendingPtyStart', 'install');
    const command = commandSource(source, 'pty_start');
    const blockingEntry = rustFunctionSource(source, 'pty_start_blocking');
    const blocking = rustFunctionSource(source, 'pty_start_blocking_with_launch');
    const register = rustFunctionSource(source, 'register_pty_client');

    const reserve = prepare.indexOf('PendingPtyStart::reserve(&thread_id)?');
    const openCwd = prepare.indexOf('open_pty_cwd(project_root, cwd)?');
    expect(reserve).toBeGreaterThan(-1);
    expect(openCwd).toBeGreaterThan(reserve);
    expect(install).toContain('PTY_LIFECYCLES');
    expect(install).toContain('.install(&self.token, session)');
    expect(command).toMatch(/#\[tauri::command\]\s*async\s+fn\s+pty_start\b/);
    expect(command).toMatch(/tauri::async_runtime::spawn_blocking\s*\([\s\S]*pty_start_blocking\s*\(/);
    expect(blockingEntry).toContain('pty_start_blocking_with_launch(app, options, None)');

    const openPty = blocking.indexOf('.openpty(');
    const spawnCommand = blocking.indexOf('.spawn_command(');
    const prepareReader = register.indexOf('prepare_pty_reader(');
    const takeWriter = register.indexOf('.take_writer()');
    const installCall = register.indexOf('pending_start.install(PtySession');
    const dataThread = register.indexOf('let data_thread = std::thread::spawn');

    expect(openPty).toBeGreaterThan(-1);
    expect(spawnCommand).toBeGreaterThan(openPty);
    expect(prepareReader).toBeGreaterThan(-1);
    expect(takeWriter).toBeGreaterThan(prepareReader);
    expect(installCall).toBeGreaterThan(takeWriter);
    expect(dataThread).toBeGreaterThan(installCall);
    expect(register).toMatch(
      /let\s+data_thread\s*=\s*std::thread::spawn\s*\(\s*move\s*\|\|\s*\{[\s\S]*pump_pty_reader\s*\(/,
    );
  });

  test('writes through a pane-owned handle after releasing the lifecycle guard', () => {
    const command = commandSource(source, 'pty_write');
    const operation = rustFunctionSource(source, 'pty_write_operation');
    const blocking = rustFunctionSource(source, 'pty_write_blocking');

    expect(command).toMatch(/#\[tauri::command\]\s*async\s+fn\s+pty_write\b/);
    expect(command).toMatch(
      /pty_write_operation\(&thread_id,\s*generation\)[\s\S]*operation_admission[\s\S]*\.try_acquire_owned\(\)[\s\S]*operation_lane\.lock_owned\(\)\.await[\s\S]*tauri::async_runtime::spawn_blocking\s*\([\s\S]*pty_write_blocking\s*\(/,
    );
    expect(operation).toMatch(
      /let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*Arc::clone\(&session\.writer\)[\s\S]*Arc::clone\(&session\.operation_lane\)[\s\S]*drop\(guard\)/,
    );
    expect(blocking).toMatch(/writer\.lock\(\)[\s\S]*write_all\(&bytes\)[\s\S]*flush\(\)/);
    const guardEnd = operation.indexOf('drop(guard);');
    expect(guardEnd).toBeGreaterThan(-1);
    expect(operation.slice(0, guardEnd)).not.toMatch(/writer\s*\.\s*lock\(\)|write_all\(&bytes\)|flush\(\)/);
  });

  test('resizes through a pane-owned handle after releasing the lifecycle guard', () => {
    const command = commandSource(source, 'pty_resize');
    const operation = rustFunctionSource(source, 'pty_resize_operation');
    const blocking = rustFunctionSource(source, 'pty_resize_blocking');

    expect(command).toMatch(/#\[tauri::command\]\s*async\s+fn\s+pty_resize\b/);
    expect(command).toMatch(
      /pty_resize_operation\(&thread_id,\s*generation\)[\s\S]*operation_admission[\s\S]*\.try_acquire_owned\(\)[\s\S]*operation_lane\.lock_owned\(\)\.await[\s\S]*tauri::async_runtime::spawn_blocking\s*\([\s\S]*pty_resize_blocking\s*\(/,
    );
    expect(operation).toMatch(
      /let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*Arc::clone\(&session\.master\)[\s\S]*Arc::clone\(&session\.operation_lane\)[\s\S]*drop\(guard\)/,
    );
    expect(blocking).toMatch(/master\s*\.\s*lock\(\)[\s\S]*\.resize\s*\(\s*PtySize/);
    const guardEnd = operation.indexOf('drop(guard);');
    expect(guardEnd).toBeGreaterThan(-1);
    expect(operation.slice(0, guardEnd)).not.toMatch(/master\s*\.\s*lock\(\)|\.resize\s*\(\s*PtySize/);
  });

  test('requires native generations for PTY flow-control commands', () => {
    expect(source).toContain('fn pty_current_generation(');
    expect(source).toContain('live_with_generation(thread_id, expected_generation)');
    expect(source).toContain('pty_ack_inner(thread_id, sequence, generation)');
    expect(source).toContain('pty_set_visibility_inner(thread_id, visible, generation)');
  });
});

describe('native PTY transport module contract', () => {
  test('exposes acknowledgement, visibility, and snapshot APIs', () => {
    const ack = implMethodSource(transportSource, 'OutputPump', 'acknowledge');
    const visibility = implMethodSource(transportSource, 'OutputPump', 'set_visibility');
    const snapshot = implMethodSource(transportSource, 'OutputPump', 'snapshot');

    expect(ack).toMatch(
      /fn\s+acknowledge\s*\(\s*&self,\s*sequence:\s*u64\s*\)\s*->\s*Result<AckOutcome,\s*AckError>/,
    );
    expect(visibility).toMatch(
      /fn\s+set_visibility\s*\(\s*&self,\s*visibility:\s*PaneVisibility\s*\)\s*->\s*bool/,
    );
    expect(snapshot).toMatch(
      /fn\s+snapshot\s*\(\s*&self\s*\)\s*->\s*OutputPumpSnapshot/,
    );
  });

  test('acknowledges and changes visibility after releasing the transport guard', () => {
    const ack = implMethodSource(transportSource, 'OutputPump', 'acknowledge');
    const visibility = implMethodSource(transportSource, 'OutputPump', 'set_visibility');

    expect(ack).toMatch(
      /let\s+mut\s+guard\s*=\s*lock_unpoisoned\(&self\.shared\.state\);[\s\S]*guard\.state\.acknowledge\(sequence,\s*acknowledged_at\)\?[\s\S]*drop\(guard\);[\s\S]*self\.shared\.wake\.notify_all\(\);/,
    );
    const ackGuardEnd = ack.indexOf('drop(guard);');
    expect(ackGuardEnd).toBeGreaterThan(-1);
    expect(ack.slice(0, ackGuardEnd)).not.toContain('self.shared.wake.notify_all()');

    expect(visibility).toMatch(
      /let\s+mut\s+guard\s*=\s*lock_unpoisoned\(&self\.shared\.state\);[\s\S]*guard\.metrics\.visibility_transition_count[\s\S]*drop\(guard\);[\s\S]*self\.shared\.wake\.notify_all\(\);/,
    );
    const visibilityGuardEnd = visibility.indexOf('drop(guard);');
    expect(visibilityGuardEnd).toBeGreaterThan(-1);
    expect(visibility.slice(0, visibilityGuardEnd)).not.toContain('self.shared.wake.notify_all()');
  });

  test('snapshots transport state as metadata only', () => {
    const snapshot = implMethodSource(transportSource, 'OutputPump', 'snapshot');
    expect(snapshot).toContain('OutputPumpSnapshot {');
    expect(snapshot).toContain('metrics: OutputPumpMetrics {');

    for (const dto of ['OutputPumpSnapshot', 'OutputPumpMetrics']) {
      const definition = structSource(transportSource, dto);
      expect(definition).not.toMatch(/Vec\s*<\s*u8\s*>|Arc\s*<\s*\[\s*u8\s*\]\s*>|\bInstant\b/);
      expect(definition).not.toMatch(/\b(?:data|payload)\s*:/);
    }
  });
});

function batch(
  threadId: string,
  sequence: number,
  bytes: number[] = [sequence],
  overrides: Partial<PtyDataBatch> = {},
): PtyDataBatch {
  return {
    threadId,
    sequence,
    bytes,
    byteCount: bytes.length,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

const runtimeThreadIds = new Set<string>();

afterEach(() => {
  runtimeThreadIds.forEach((threadId) => disposePtyClient(threadId));
  runtimeThreadIds.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('typed frontend PTY batch consumer', () => {
  test('normalizes batch bytes with one owned allocation', () => {
    const normalize = frontendTransportSource.slice(
      frontendTransportSource.indexOf('function normalizeBatchBytes'),
      frontendTransportSource.indexOf('\n}', frontendTransportSource.indexOf('function normalizeBatchBytes')) + 2,
    );

    expect(normalize).toContain('Uint8Array.from(batch.bytes).subarray(0, count)');
    expect(normalize).not.toContain('batch.bytes.slice(');
  });

  test('accepts only the exact next sequence for the owning thread', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => undefined);
    runtimeThreadIds.add('thread-a');
    createPtyClient({
      threadId: 'thread-a',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-a', 1, [1, 2]))).toBe(true);
    expect(routePtyBatch(batch('other-thread', 2, [9]))).toBe(false);
    expect(routePtyBatch(batch('thread-a', 3, [3]))).toBe(false);
    expect(routePtyBatch(batch('thread-a', 2, [4]))).toBe(true);
    expect(routePtyBatch(batch('thread-a', 2, [5]))).toBe(false);

    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([1, 2]);

    writes[0].callback();
    await flushAsyncWork();

    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([4]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, 'pty_ack', {
      threadId: 'thread-a',
      thread_id: 'thread-a',
      sequence: 1,
    });
  });

  test('keeps at most one xterm write active and bounds pending delivery to native two-in-flight', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    runtimeThreadIds.add('thread-b');
    createPtyClient({
      threadId: 'thread-b',
      invoke: vi.fn(async () => undefined),
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-b', 1, [1]))).toBe(true);
    expect(routePtyBatch(batch('thread-b', 2, [2]))).toBe(true);
    expect(routePtyBatch(batch('thread-b', 3, [3]))).toBe(false);
    expect(writes).toHaveLength(1);

    writes[0].callback();
    await flushAsyncWork();

    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);
    expect(routePtyBatch(batch('thread-b', 3, [3]))).toBe(true);
    expect(writes).toHaveLength(2);
  });

  test('acknowledges only from the xterm write completion callback', async () => {
    const writes: Array<{ callback: () => void }> = [];
    const invoke = vi.fn(async () => undefined);
    runtimeThreadIds.add('thread-c');
    createPtyClient({
      threadId: 'thread-c',
      invoke,
      write(_bytes, callback) {
        writes.push({ callback });
      },
    });

    expect(routePtyBatch(batch('thread-c', 1, [7]))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('pty_ack', {
      threadId: 'thread-c',
      thread_id: 'thread-c',
      sequence: 1,
    });
  });

  test('scopes acknowledgements to the active native PTY generation', async () => {
    const writes: Array<{ callback: () => void }> = [];
    const invoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => undefined);
    const threadId = 'thread-c-native-ack-generation';
    runtimeThreadIds.add(threadId);
    const client = createPtyClient({
      threadId,
      invoke,
      write(_bytes, callback) {
        writes.push({ callback });
      },
    });

    await expect(client.markPtyStarted(undefined, 41)).resolves.toBe(true);
    expect(routePtyBatch(batch(threadId, 1, [1], { generation: 41 }))).toBe(true);
    writes[0].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId,
          thread_id: threadId,
          sequence: 1,
          generation: 41,
        },
      ],
    ]);
  });

  test('retains two replacement payloads while the current acknowledgement is unresolved', async () => {
    const firstAcknowledgement = deferred<undefined>();
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      (command: string, args: Record<string, unknown>) =>
        command === 'pty_ack' && args.sequence === 1
          ? firstAcknowledgement.promise
          : Promise.resolve(undefined),
    );
    runtimeThreadIds.add('thread-c-ack-payload-race');
    createPtyClient({
      threadId: 'thread-c-ack-payload-race',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-c-ack-payload-race', 1, [1]))).toBe(true);
    writes[0].callback();
    await flushAsyncWork();

    expect(routePtyBatch(batch('thread-c-ack-payload-race', 2, [2]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-ack-payload-race', 3, [3]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-ack-payload-race', 4, [4]))).toBe(false);
    expect(writes).toHaveLength(1);

    firstAcknowledgement.resolve(undefined);
    await flushAsyncWork();

    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);

    writes[1].callback();
    await flushAsyncWork();

    expect(writes).toHaveLength(3);
    expect(Array.from(writes[2].bytes)).toEqual([3]);
    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-ack-payload-race',
          thread_id: 'thread-c-ack-payload-race',
          sequence: 1,
        },
      ],
      [
        'pty_ack',
        {
          threadId: 'thread-c-ack-payload-race',
          thread_id: 'thread-c-ack-payload-race',
          sequence: 2,
        },
      ],
    ]);
  });

  test.each(['restore', 'adopt'] as const)(
    'does not duplicate an acknowledgement in flight during start %s',
    async (settlement) => {
      const firstAcknowledgement = deferred<undefined>();
      const writes: Array<{ callback: () => void }> = [];
      const invoke = vi.fn(
        (command: string) =>
          command === 'pty_ack'
            ? firstAcknowledgement.promise
            : Promise.resolve(undefined),
      );
      const threadId = `thread-c-ack-${settlement}`;
      runtimeThreadIds.add(threadId);
      const client = createPtyClient({
        threadId,
        invoke,
        write(_bytes, callback) {
          writes.push({ callback });
        },
      });

      expect(routePtyBatch(batch(threadId, 1, [1]))).toBe(true);
      writes[0].callback();
      await flushAsyncWork();

      const startAttempt = client.prepareForPtyStart();
      if (settlement === 'restore') {
        client.restoreAfterFailedPtyStart(startAttempt);
      } else {
        await client.adoptRunningPty(startAttempt);
      }

      expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(1);

      firstAcknowledgement.resolve(undefined);
      await flushAsyncWork();

      expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(1);
    },
  );

  test('keeps one acknowledgement current while a replacement start is provisional', async () => {
    const firstAcknowledgement = deferred<undefined>();
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      (command: string) =>
        command === 'pty_ack'
          ? firstAcknowledgement.promise
          : Promise.resolve(undefined),
    );
    runtimeThreadIds.add('thread-c-ack-provisional');
    const client = createPtyClient({
      threadId: 'thread-c-ack-provisional',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-c-ack-provisional', 1, [1]))).toBe(true);
    writes[0].callback();
    await flushAsyncWork();

    const startAttempt = client.prepareForPtyStart();
    expect(routePtyBatch(batch('thread-c-ack-provisional', 1, [2]))).toBe(true);
    expect(writes).toHaveLength(1);

    await client.markPtyStarted(startAttempt);

    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);
    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(1);

    firstAcknowledgement.resolve(undefined);
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toHaveLength(1);
  });

  test('retries the current acknowledgement before writing later batches', async () => {
    vi.useFakeTimers();
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('ack failed once'))
      .mockResolvedValue(undefined);
    runtimeThreadIds.add('thread-c-ack-retry');
    createPtyClient({
      threadId: 'thread-c-ack-retry',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-c-ack-retry', 1, [1]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-ack-retry', 2, [2]))).toBe(true);
    expect(writes).toHaveLength(1);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, 'pty_ack', {
      threadId: 'thread-c-ack-retry',
      thread_id: 'thread-c-ack-retry',
      sequence: 1,
    });
    expect(writes).toHaveLength(1);

    await vi.runOnlyPendingTimersAsync();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, 'pty_ack', {
      threadId: 'thread-c-ack-retry',
      thread_id: 'thread-c-ack-retry',
      sequence: 1,
    });
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);

    writes[1].callback();
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(3, 'pty_ack', {
      threadId: 'thread-c-ack-retry',
      thread_id: 'thread-c-ack-retry',
      sequence: 2,
    });
  });

  test('retains two new-generation batches behind an old physical write', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    runtimeThreadIds.add('thread-c-generation');
    const client = createPtyClient({
      threadId: 'thread-c-generation',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-c-generation', 1, [1]))).toBe(true);

    const startAttempt = client.prepareForPtyStart();

    expect(routePtyBatch(batch('thread-c-generation', 1, [2]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-generation', 2, [3]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-generation', 3, [4]))).toBe(false);
    expect(writes).toHaveLength(1);

    await client.markPtyStarted(startAttempt);
    writes[0].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);

    writes[1].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-generation',
          thread_id: 'thread-c-generation',
          sequence: 1,
        },
      ],
    ]);
    expect(writes).toHaveLength(3);
    expect(Array.from(writes[2].bytes)).toEqual([3]);

    writes[2].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-generation',
          thread_id: 'thread-c-generation',
          sequence: 1,
        },
      ],
      [
        'pty_ack',
        {
          threadId: 'thread-c-generation',
          thread_id: 'thread-c-generation',
          sequence: 2,
        },
      ],
    ]);
  });

  test('rejects old native output after a thread id is reused', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    const threadId = 'thread-c-native-generation-fence';
    runtimeThreadIds.add(threadId);
    const client = createPtyClient({
      threadId,
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    await expect(client.markPtyStarted(undefined, 41)).resolves.toBe(true);
    expect(routePtyBatch(batch(threadId, 1, [1], { generation: 41 }))).toBe(true);
    writes[0].callback();
    await flushAsyncWork();
    client.markPtyExited(41);

    const startAttempt = client.prepareForPtyStart();
    expect(routePtyBatch(batch(threadId, 1, [9], { generation: 41 }))).toBe(false);
    expect(routePtyBatch(batch(threadId, 1, [2], { generation: 42 }))).toBe(true);

    await expect(client.markPtyStarted(startAttempt, 42)).resolves.toBe(true);
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[0].bytes)).toEqual([1]);
    expect(Array.from(writes[1].bytes)).toEqual([2]);
    expect(routePtyBatch(batch(threadId, 2, [3], { generation: 41 }))).toBe(false);
    expect(routePtyBatch(batch(threadId, 2, [4], { generation: 42 }))).toBe(true);
  });

  test('bounds provisional native output to the exact announced generation', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    const threadId = 'thread-c-native-generation-quarantine';
    runtimeThreadIds.add(threadId);
    const client = createPtyClient({
      threadId,
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    await expect(client.markPtyStarted(undefined, 51)).resolves.toBe(true);
    client.markPtyExited(51);
    const startAttempt = client.prepareForPtyStart();

    expect(routePtyBatch(batch(threadId, 1, [5], { generation: 51 }))).toBe(false);
    expect(routePtyBatch(batch(threadId, 1, [6], { generation: 52 }))).toBe(true);
    expect(routePtyBatch(batch(threadId, 2, [7], { generation: 53 }))).toBe(true);

    await expect(client.markPtyStarted(startAttempt, 52)).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([6]);
    expect(routePtyBatch(batch(threadId, 2, [8], { generation: 52 }))).toBe(true);
  });

  test('retires the old write callback before a successful start can acknowledge the new pump', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    runtimeThreadIds.add('thread-c-success-stale-callback');
    const client = createPtyClient({
      threadId: 'thread-c-success-stale-callback',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-c-success-stale-callback', 1, [1]))).toBe(true);
    const startAttempt = client.prepareForPtyStart();
    await client.markPtyStarted(startAttempt);

    expect(routePtyBatch(batch('thread-c-success-stale-callback', 1, [2]))).toBe(true);
    expect(writes).toHaveLength(1);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);

    writes[1].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-success-stale-callback',
          thread_id: 'thread-c-success-stale-callback',
          sequence: 1,
        },
      ],
    ]);
  });

  test('quarantines an ambiguous batch until an already-running PTY is adopted', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    runtimeThreadIds.add('thread-c-adopt-quarantine');
    const client = createPtyClient({
      threadId: 'thread-c-adopt-quarantine',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    const startAttempt = client.prepareForPtyStart();
    expect(routePtyBatch(batch('thread-c-adopt-quarantine', 1, [11]))).toBe(true);
    expect(writes).toEqual([]);
    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([]);

    await client.adoptRunningPty(startAttempt);

    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([11]);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-adopt-quarantine',
          thread_id: 'thread-c-adopt-quarantine',
          sequence: 1,
        },
      ],
    ]);
    expect(routePtyBatch(batch('thread-c-adopt-quarantine', 2, [12]))).toBe(true);
    expect(writes).toHaveLength(2);
  });

  test('ignores adoption from a start attempt superseded by a newer attempt', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    runtimeThreadIds.add('thread-c-stale-adoption');
    const client = createPtyClient({
      threadId: 'thread-c-stale-adoption',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    const staleAttempt = client.prepareForPtyStart();
    const currentAttempt = client.prepareForPtyStart();
    expect(routePtyBatch(batch('thread-c-stale-adoption', 1, [41]))).toBe(true);

    await expect(client.adoptRunningPty(staleAttempt)).resolves.toBe(false);

    expect(invoke).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(routePtyBatch(batch('thread-c-stale-adoption', 1, [99]))).toBe(false);
    expect(routePtyBatch(batch('thread-c-stale-adoption', 2, [42]))).toBe(true);

    await expect(client.markPtyStarted(currentAttempt)).resolves.toBe(true);

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_set_visibility')).toEqual([
      [
        'pty_set_visibility',
        {
          threadId: 'thread-c-stale-adoption',
          thread_id: 'thread-c-stale-adoption',
          visible: true,
        },
      ],
    ]);
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([41]);

    writes[0].callback();
    await flushAsyncWork();
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([42]);
  });

  test('feeds at most two ambiguous batches to a successfully started PTY in order', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    runtimeThreadIds.add('thread-c-success-quarantine');
    const client = createPtyClient({
      threadId: 'thread-c-success-quarantine',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    const startAttempt = client.prepareForPtyStart();
    expect(routePtyBatch(batch('thread-c-success-quarantine', 1, [21]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-success-quarantine', 1, [99]))).toBe(false);
    expect(routePtyBatch(batch('thread-c-success-quarantine', 3, [99]))).toBe(false);
    expect(routePtyBatch(batch('thread-c-success-quarantine', 2, [22]))).toBe(true);
    expect(routePtyBatch(batch('thread-c-success-quarantine', 3, [23]))).toBe(false);
    expect(writes).toEqual([]);
    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([]);

    await client.markPtyStarted(startAttempt);

    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([21]);

    writes[0].callback();
    await flushAsyncWork();

    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([22]);
    writes[1].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-success-quarantine',
          thread_id: 'thread-c-success-quarantine',
          sequence: 1,
        },
      ],
      [
        'pty_ack',
        {
          threadId: 'thread-c-success-quarantine',
          thread_id: 'thread-c-success-quarantine',
          sequence: 2,
        },
      ],
    ]);
    expect(routePtyBatch(batch('thread-c-success-quarantine', 3, [23]))).toBe(true);
    expect(writes).toHaveLength(3);
  });

  test('drops an unresolved quarantine when another start reset supersedes it', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(async () => undefined);
    runtimeThreadIds.add('thread-c-reset-quarantine');
    const client = createPtyClient({
      threadId: 'thread-c-reset-quarantine',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    client.prepareForPtyStart();
    expect(routePtyBatch(batch('thread-c-reset-quarantine', 1, [31]))).toBe(true);
    expect(writes).toEqual([]);

    const replacementAttempt = client.prepareForPtyStart();
    await client.markPtyStarted(replacementAttempt);

    expect(writes).toEqual([]);
    expect(routePtyBatch(batch('thread-c-reset-quarantine', 1, [32]))).toBe(true);
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([32]);
  });

  test('cancels stale acknowledgement retries across PTY generation reset', async () => {
    vi.useFakeTimers();
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi
      .fn(async (_command: string, _args: Record<string, unknown>) => undefined)
      .mockRejectedValueOnce(new Error('stale ack failed'))
      .mockResolvedValue(undefined);
    runtimeThreadIds.add('thread-c-generation-ack');
    const client = createPtyClient({
      threadId: 'thread-c-generation-ack',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-c-generation-ack', 1, [1]))).toBe(true);
    writes[0].callback();
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledTimes(1);

    const startAttempt = client.prepareForPtyStart();
    expect(routePtyBatch(batch('thread-c-generation-ack', 1, [2]))).toBe(true);
    expect(writes).toHaveLength(1);

    await vi.runOnlyPendingTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(1);

    await client.markPtyStarted(startAttempt);
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);

    writes[1].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-generation-ack',
          thread_id: 'thread-c-generation-ack',
          sequence: 1,
        },
      ],
      [
        'pty_ack',
        {
          threadId: 'thread-c-generation-ack',
          thread_id: 'thread-c-generation-ack',
          sequence: 1,
        },
      ],
    ]);
  });

  test('reserves a sequence before xterm write can synchronously reenter routing', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    let nestedResult: boolean | undefined;
    runtimeThreadIds.add('thread-c-reentrant-write');
    createPtyClient({
      threadId: 'thread-c-reentrant-write',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
        nestedResult = routePtyBatch(batch('thread-c-reentrant-write', 1, [99]));
      },
    });

    expect(routePtyBatch(batch('thread-c-reentrant-write', 1, [51]))).toBe(true);
    expect(nestedResult).toBe(false);
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([51]);

    writes[0].callback();
    await flushAsyncWork();

    expect(writes).toHaveLength(1);
    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-c-reentrant-write',
          thread_id: 'thread-c-reentrant-write',
          sequence: 1,
        },
      ],
    ]);
  });

  test('rolls back an unsuperseded sequence reservation when xterm write throws', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    let writeAttempts = 0;
    let nestedResult: boolean | undefined;
    runtimeThreadIds.add('thread-d-reservation-rollback');
    const client = createPtyClient({
      threadId: 'thread-d-reservation-rollback',
      invoke,
      write(bytes, callback) {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          nestedResult = routePtyBatch(
            batch('thread-d-reservation-rollback', 1, [99]),
          );
          throw new Error('write failed');
        }
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-d-reservation-rollback', 1, [61]))).toBe(false);
    expect(nestedResult).toBe(false);
    expect(invoke).not.toHaveBeenCalled();

    const recoveryAttempt = client.prepareForPtyStart();
    client.restoreAfterFailedPtyStart(recoveryAttempt);

    expect(routePtyBatch(batch('thread-d-reservation-rollback', 1, [62]))).toBe(true);
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0].bytes)).toEqual([62]);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([
      [
        'pty_ack',
        {
          threadId: 'thread-d-reservation-rollback',
          thread_id: 'thread-d-reservation-rollback',
          sequence: 1,
        },
      ],
    ]);
  });

  test('does not acknowledge when xterm write throws', async () => {
    const invoke = vi.fn(async () => undefined);
    runtimeThreadIds.add('thread-d');
    createPtyClient({
      threadId: 'thread-d',
      invoke,
      write() {
        throw new Error('write failed');
      },
    });

    expect(routePtyBatch(batch('thread-d', 1, [8]))).toBe(false);
    await flushAsyncWork();
    expect(invoke).not.toHaveBeenCalled();
  });

  test('retries same-value visibility sync after a failed invoke and deduplicates after success', async () => {
    const invoke = vi
      .fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('visibility sync failed'))
      .mockResolvedValueOnce(undefined);
    runtimeThreadIds.add('thread-e');
    const client = createPtyClient({
      threadId: 'thread-e',
      invoke,
      write() {},
      visible: true,
    });

    await client.markPtyStarted();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenNthCalledWith(1, 'pty_set_visibility', {
      threadId: 'thread-e',
      thread_id: 'thread-e',
      visible: true,
    });

    await expect(client.setVisible(false)).rejects.toThrow('visibility sync failed');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, 'pty_set_visibility', {
      threadId: 'thread-e',
      thread_id: 'thread-e',
      visible: false,
    });

    await expect(client.setVisible(false)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(3, 'pty_set_visibility', {
      threadId: 'thread-e',
      thread_id: 'thread-e',
      visible: false,
    });

    await expect(client.setVisible(false)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test('serializes visibility sync while applying the latest desired state', async () => {
    const firstSync = deferred<undefined>();
    const invoke = vi
      .fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => firstSync.promise)
      .mockResolvedValueOnce(undefined);
    runtimeThreadIds.add('thread-e-in-flight');
    const client = createPtyClient({
      threadId: 'thread-e-in-flight',
      invoke,
      write() {},
      visible: true,
    });

    await client.markPtyStarted();

    const hide = client.setVisible(false);
    const show = client.setVisible(true);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, 'pty_set_visibility', {
      threadId: 'thread-e-in-flight',
      thread_id: 'thread-e-in-flight',
      visible: false,
    });

    firstSync.resolve(undefined);
    await Promise.all([hide, show]);

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(3, 'pty_set_visibility', {
      threadId: 'thread-e-in-flight',
      thread_id: 'thread-e-in-flight',
      visible: true,
    });

    await expect(client.setVisible(true)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test('restarts queued latest visibility after an in-flight rejection without busy retrying', async () => {
    const firstHide = deferred<undefined>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const invoke = vi
      .fn(async () => undefined)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => firstHide.promise)
      .mockResolvedValueOnce(undefined);
    runtimeThreadIds.add('thread-e-restart');
    const client = createPtyClient({
      threadId: 'thread-e-restart',
      invoke,
      write() {},
      visible: true,
    });

    try {
      await client.markPtyStarted();

      const hide = client.setVisible(false);
      const show = client.setVisible(true).catch((error) => error);
      const finalHide = client.setVisible(false).catch((error) => error);

      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenNthCalledWith(2, 'pty_set_visibility', {
        threadId: 'thread-e-restart',
        thread_id: 'thread-e-restart',
        visible: false,
      });

      firstHide.reject(new Error('visibility sync failed'));

      await expect(hide).rejects.toThrow('visibility sync failed');
      await expect(show).resolves.toBeInstanceOf(Error);
      await expect(finalHide).resolves.toBeInstanceOf(Error);
      await flushAsyncWork();

      expect(invoke).toHaveBeenCalledTimes(3);
      expect(invoke).toHaveBeenNthCalledWith(3, 'pty_set_visibility', {
        threadId: 'thread-e-restart',
        thread_id: 'thread-e-restart',
        visible: false,
      });

      await flushAsyncWork();
      await expect(client.setVisible(false)).resolves.toBe(false);
      expect(invoke).toHaveBeenCalledTimes(3);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('stops retries, queued writes, and visibility after PTY exit and reopens on start', async () => {
    vi.useFakeTimers();
    const retryAcknowledgement = deferred<undefined>();
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    let acknowledgementCalls = 0;
    const invoke = vi.fn((command: string) => {
      if (command !== 'pty_ack') return Promise.resolve(undefined);
      acknowledgementCalls += 1;
      if (acknowledgementCalls === 1) {
        return Promise.reject(new Error('ack failed once'));
      }
      return retryAcknowledgement.promise;
    });
    runtimeThreadIds.add('thread-f-exit');
    const client = createPtyClient({
      threadId: 'thread-f-exit',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    await client.markPtyStarted();
    expect(routePtyBatch(batch('thread-f-exit', 1, [1]))).toBe(true);
    expect(routePtyBatch(batch('thread-f-exit', 2, [2]))).toBe(true);
    writes[0].callback();
    await flushAsyncWork();
    await vi.runOnlyPendingTimersAsync();

    expect(acknowledgementCalls).toBe(2);
    expect(writes).toHaveLength(1);

    client.markPtyExited();
    expect(routePtyBatch(batch('thread-f-exit', 3, [3]))).toBe(false);
    const visibilityCallsAtExit = invoke.mock.calls.filter(
      ([command]) => command === 'pty_set_visibility',
    ).length;
    await expect(client.setVisible(false)).resolves.toBe(false);
    expect(
      invoke.mock.calls.filter(([command]) => command === 'pty_set_visibility'),
    ).toHaveLength(visibilityCallsAtExit);

    retryAcknowledgement.reject(new Error('late retry failure'));
    await flushAsyncWork();
    await vi.runOnlyPendingTimersAsync();

    expect(acknowledgementCalls).toBe(2);
    expect(writes).toHaveLength(1);

    const startAttempt = client.prepareForPtyStart();
    await expect(client.markPtyStarted(startAttempt)).resolves.toBe(true);
    expect(routePtyBatch(batch('thread-f-exit', 1, [9]))).toBe(true);
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([9]);
  });

  test('releases an exited physical write gate without acknowledging its stale callback', async () => {
    const writes: Array<{ bytes: Uint8Array; callback: () => void }> = [];
    const invoke = vi.fn(
      async (_command: string, _args: Record<string, unknown>) => undefined,
    );
    runtimeThreadIds.add('thread-f-exit-write');
    const client = createPtyClient({
      threadId: 'thread-f-exit-write',
      invoke,
      write(bytes, callback) {
        writes.push({ bytes, callback });
      },
    });

    expect(routePtyBatch(batch('thread-f-exit-write', 1, [1]))).toBe(true);
    client.markPtyExited();

    const startAttempt = client.prepareForPtyStart();
    await client.markPtyStarted(startAttempt);
    expect(routePtyBatch(batch('thread-f-exit-write', 1, [2]))).toBe(true);
    expect(writes).toHaveLength(1);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke.mock.calls.filter(([command]) => command === 'pty_ack')).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(Array.from(writes[1].bytes)).toEqual([2]);
  });

  test('disposal removes pane routing and suppresses later acknowledgements from stale callbacks', async () => {
    const writes: Array<{ callback: () => void }> = [];
    const invoke = vi.fn(async () => undefined);
    runtimeThreadIds.add('thread-f');
    createPtyClient({
      threadId: 'thread-f',
      invoke,
      write(_bytes, callback) {
        writes.push({ callback });
      },
    });

    expect(routePtyBatch(batch('thread-f', 1, [1]))).toBe(true);
    expect(disposePtyClient('thread-f')).toBe(true);
    expect(routePtyBatch(batch('thread-f', 2, [2]))).toBe(false);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke).not.toHaveBeenCalled();
  });

  test('disposal cancels stale acknowledgement retries', async () => {
    vi.useFakeTimers();
    const writes: Array<{ callback: () => void }> = [];
    const invoke = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('ack failed once'))
      .mockResolvedValue(undefined);
    runtimeThreadIds.add('thread-f-ack-retry');
    createPtyClient({
      threadId: 'thread-f-ack-retry',
      invoke,
      write(_bytes, callback) {
        writes.push({ callback });
      },
    });

    expect(routePtyBatch(batch('thread-f-ack-retry', 1, [1]))).toBe(true);

    writes[0].callback();
    await flushAsyncWork();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(disposePtyClient('thread-f-ack-retry')).toBe(true);

    await vi.runOnlyPendingTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
