import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const transportSource = readFileSync(
  resolve(process.cwd(), 'native/desktop/psyche-build-tauri/src-tauri/src/pty_transport.rs'),
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

  test('defines PTY flow-control commands with the native transport contracts', () => {
    const ack = commandSource(source, 'pty_ack');
    const visibility = commandSource(source, 'pty_set_visibility');
    const metrics = commandSource(source, 'pty_transport_metrics');

    expect(ack).toMatch(
      /#\[tauri::command\]\s*fn\s+pty_ack\s*\(\s*thread_id:\s*String,\s*sequence:\s*u64\s*\)\s*->\s*Result<AckOutcome,\s*String>/,
    );
    expect(visibility).toMatch(
      /#\[tauri::command\]\s*fn\s+pty_set_visibility\s*\(\s*thread_id:\s*String,\s*visible:\s*bool\s*\)\s*->\s*Result<\(\),\s*String>/,
    );
    expect(metrics).toMatch(
      /#\[tauri::command\]\s*fn\s+pty_transport_metrics\s*\(\s*thread_id:\s*Option<String>\s*\)\s*->\s*Vec<PtyTransportSnapshot>/,
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
    const cleanupCompletion = start.indexOf('shutdown.finish_terminated_threads_to_completion');
    const generationFinalization = start.indexOf('PTY_LIFECYCLES.lock().finish_exit');

    expect(exitEmission).toBeGreaterThan(-1);
    expect(timeoutCleanup).toBeGreaterThan(exitEmission);
    expect(cleanupCompletion).toBeGreaterThan(timeoutCleanup);
    expect(generationFinalization).toBeGreaterThan(cleanupCompletion);
  });

  test('reserves PTY start state before resolving cwd and installs the session before reader drain begins', () => {
    const prepare = rustFunctionSource(source, 'prepare_pty_start');
    const install = implMethodSource(source, 'PendingPtyStart', 'install');
    const command = commandSource(source, 'pty_start');

    const reserve = prepare.indexOf('PendingPtyStart::reserve(&thread_id)?');
    const openCwd = prepare.indexOf('open_pty_cwd(project_root, cwd)?');
    expect(reserve).toBeGreaterThan(-1);
    expect(openCwd).toBeGreaterThan(reserve);
    expect(install).toContain('PTY_LIFECYCLES');
    expect(install).toContain('.install(&self.token, session)');
    expect(command).toMatch(/#\[tauri::command\]\s*fn\s+pty_start\b/);

    const openPty = command.indexOf('.openpty(');
    const spawnCommand = command.indexOf('.spawn_command(');
    const prepareReader = command.indexOf('prepare_pty_reader(');
    const takeWriter = command.indexOf('.take_writer()');
    const installCall = command.indexOf('pending_start.install(PtySession');
    const dataThread = command.indexOf('let data_thread = std::thread::spawn');

    expect(openPty).toBeGreaterThan(-1);
    expect(spawnCommand).toBeGreaterThan(openPty);
    expect(prepareReader).toBeGreaterThan(spawnCommand);
    expect(takeWriter).toBeGreaterThan(prepareReader);
    expect(installCall).toBeGreaterThan(takeWriter);
    expect(dataThread).toBeGreaterThan(installCall);
    expect(command).toMatch(
      /let\s+data_thread\s*=\s*std::thread::spawn\s*\(\s*move\s*\|\|\s*\{[\s\S]*pump_pty_reader\s*\(/,
    );
  });

  test('writes through a pane-owned handle after releasing the lifecycle guard', () => {
    const command = commandSource(source, 'pty_write');

    expect(command).toMatch(/#\[tauri::command\]\s*fn\s+pty_write\b/);
    expect(command).toMatch(
      /let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*Arc::clone\(&session\.writer\)[\s\S]*drop\(guard\)[\s\S]*writer\.lock\(\)[\s\S]*write_all\(&bytes\)[\s\S]*flush\(\)/,
    );
    const guardEnd = command.indexOf('drop(guard);');
    expect(guardEnd).toBeGreaterThan(-1);
    expect(command.slice(0, guardEnd)).not.toMatch(/writer\s*\.\s*lock\(\)|write_all\(&bytes\)|flush\(\)/);
  });

  test('resizes through a pane-owned handle after releasing the lifecycle guard', () => {
    const command = commandSource(source, 'pty_resize');

    expect(command).toMatch(/#\[tauri::command\]\s*fn\s+pty_resize\b/);
    expect(command).toMatch(
      /let\s+guard\s*=\s*PTY_LIFECYCLES\.lock\(\);[\s\S]*Arc::clone\(&session\.master\)[\s\S]*drop\(guard\)[\s\S]*master\s*\.\s*lock\(\)[\s\S]*\.resize\s*\(\s*PtySize/,
    );
    const guardEnd = command.indexOf('drop(guard);');
    expect(guardEnd).toBeGreaterThan(-1);
    expect(command.slice(0, guardEnd)).not.toMatch(/master\s*\.\s*lock\(\)|\.resize\s*\(\s*PtySize/);
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
