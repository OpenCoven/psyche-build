import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { TmuxControl, tmuxDimensionArg, unescapeTmuxOutput } from '../../src/services/tmuxControl.js';

/**
 * TmuxControl is shared by both transports — the LAN bridge in
 * src/services/bridge/ and the loopback daemon in src/daemon/. It used to be
 * two copies with two test files, which is how the surrogate-pair fix below
 * ended up in one copy and not the other.
 */

function recordingControl() {
  const tmux = new TmuxControl('psyche-test');
  const commands: string[] = [];
  tmux.command = (line: string) => {
    commands.push(line);
  };
  return { tmux, commands };
}

describe('TmuxControl pane commands', () => {
  it('builds quoted fire-and-forget commands for a real pane id', () => {
    const { tmux, commands } = recordingControl();

    tmux.selectPane('%3');
    tmux.resizePane('%7', 100, 30);

    expect(commands).toEqual([
      "select-pane -t '%3'",
      "resize-pane -t '%7' -x 100 -y 30",
    ]);
  });

  // Regression: tmux control mode reads one command per line, so a newline in
  // a pane id ends the intended command and starts a new one. tmux exposes
  // `run-shell`, so that was arbitrary code execution as the user — reachable
  // from a paired device's `sendInput` on the LAN bridge, and from the
  // daemon's pane ops on loopback.
  const INJECTIONS = [
    "%3'\nrun-shell 'touch /tmp/psyche-pwned'",
    '%3\nkill-server',
    '%3\r\nrun-shell "id"',
    'session:1.2',
    '',
  ];

  for (const paneId of INJECTIONS) {
    it(`refuses to build any tmux command for ${JSON.stringify(paneId)}`, () => {
      const { tmux, commands } = recordingControl();

      expect(() => tmux.selectPane(paneId)).toThrow(/invalid pane id/);
      expect(() => tmux.killPane(paneId)).toThrow(/invalid pane id/);
      expect(() => tmux.sendKeysHex(paneId, Buffer.from('x'))).toThrow(/invalid pane id/);
      expect(() => tmux.resizePane(paneId, 80, 24)).toThrow(/invalid pane id/);
      expect(commands).toEqual([]);
    });
  }

  it('validates the pane id before the empty-payload shortcut in sendKeysHex', () => {
    // An empty buffer returns early; the guard must still have run, or a
    // caller could probe which ids are accepted without sending anything.
    const { tmux } = recordingControl();
    expect(() => tmux.sendKeysHex('%3\nkill-server', Buffer.alloc(0))).toThrow(/invalid pane id/);
  });

  it('rejects a multi-line command even if a caller bypasses the argument guards', () => {
    const tmux = new TmuxControl('psyche-test');
    expect(() => tmux.command("kill-pane -t '%3'\nrun-shell 'id'")).toThrow(/single line/);
  });
});

describe('unescapeTmuxOutput', () => {
  it('passes plain ASCII through', () => {
    expect(unescapeTmuxOutput('hello world').toString('utf8')).toBe('hello world');
  });

  it('decodes 3-digit octal escapes (control bytes)', () => {
    // \033 = ESC (0x1b), \012 = LF (0x0a)
    const out = unescapeTmuxOutput('\\033[31mred\\012');
    expect(out).toEqual(Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x72, 0x65, 0x64, 0x0a]));
  });

  it('decodes high-byte octal escapes', () => {
    // \377 = 0xff
    expect(unescapeTmuxOutput('\\377')).toEqual(Buffer.from([0xff]));
  });

  it('decodes a literal backslash (\\\\)', () => {
    expect(unescapeTmuxOutput('\\\\')).toEqual(Buffer.from([0x5c]));
  });

  it('handles UTF-8 multi-byte characters without corruption', () => {
    // "é" is 0xc3 0xa9 in UTF-8
    const out = unescapeTmuxOutput('é');
    expect(out).toEqual(Buffer.from([0xc3, 0xa9]));
  });

  // Regression, and the reason the two copies were merged: the daemon's copy
  // walked the string by UTF-16 code unit, so each half of a surrogate pair
  // was encoded on its own and every astral-plane character reached the
  // client as two U+FFFD replacements. Only the bridge copy was ever fixed.
  it('handles UTF-8 surrogate pairs without corruption', () => {
    const out = unescapeTmuxOutput('\u{1f9ea}');
    expect(out).toEqual(Buffer.from('\u{1f9ea}', 'utf8'));
  });

  it('keeps surrogate pairs intact when mixed with other content', () => {
    const input = 'a\u{1f52e}b\u{1f9ea}c';
    expect(unescapeTmuxOutput(input)).toEqual(Buffer.from(input, 'utf8'));
  });

  it('mixes escapes and literals', () => {
    // `\033]0;title\007` — OSC set-title sequence
    const out = unescapeTmuxOutput('\\033]0;psyche\\007');
    expect(out.toString('utf8')).toBe('\x1b]0;psyche\x07');
  });
});

describe('tmuxDimensionArg', () => {
  it('accepts finite dimensions and truncates fractional values', () => {
    expect(tmuxDimensionArg(80, 'cols')).toBe(80);
    expect(tmuxDimensionArg(24.9, 'rows')).toBe(24);
  });

  it('rejects non-numeric dimensions before they reach tmux command strings', () => {
    expect(() => tmuxDimensionArg('80', 'cols')).toThrow('cols must be a finite number');
    expect(() => tmuxDimensionArg(Number.NaN, 'rows')).toThrow('rows must be a finite number');
  });

  it('rejects dimensions outside tmux bounds', () => {
    expect(() => tmuxDimensionArg(0, 'cols')).toThrow('cols out of range');
    expect(() => tmuxDimensionArg(65536, 'rows')).toThrow('rows out of range');
  });
});

// Drain the microtask + timer queues so serialized executeCommand transactions
// advance to the next command before assertions.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fake tmux control subprocess: records the commands written to stdin and lets
 * a test drive the %begin/%end/%error acknowledgement blocks (and a disconnect)
 * that TmuxControl correlates against outstanding transactions.
 */
function createFakeControlProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & EventEmitter;

  const commands: string[] = [];
  let nextNumber = 0;

  (proc as unknown as { stdout: unknown }).stdout = stdout;
  (proc as unknown as { stderr: unknown }).stderr = stderr;
  (proc as unknown as { stdin: unknown }).stdin = {
    write(chunk: string, cb?: (error?: Error | null) => void) {
      commands.push(chunk.replace(/\n$/, ''));
      if (cb) cb();
      return true;
    },
    end() {},
  };
  (proc as unknown as { kill: () => void }).kill = () => {};

  const emit = (line: string) => stdout.emit('data', `${line}\n`);

  return {
    process: proc as ChildProcessWithoutNullStreams,
    commands: () => commands.slice(),
    /** Emit the unsolicited acknowledgement block tmux sends for the attach. */
    attach() {
      const number = String(nextNumber++);
      emit(`%begin 0 ${number} 0`);
      emit(`%end 0 ${number} 0`);
    },
    acknowledgeNext(lines: readonly string[] = []) {
      const number = String(nextNumber++);
      emit(`%begin 0 ${number} 0`);
      for (const line of lines) emit(line);
      emit(`%end 0 ${number} 0`);
    },
    errorNext() {
      const number = String(nextNumber++);
      emit(`%begin 0 ${number} 0`);
      emit(`%error 0 ${number} 0`);
    },
    disconnect() {
      proc.emit('exit', 0);
    },
  };
}

/**
 * Start a TmuxControl backed by a fake control process, then emit the initial
 * attach acknowledgement block exactly as `tmux -C attach-session` does.
 */
function startControl() {
  const fake = createFakeControlProcess();
  const tmux = new TmuxControl('psyche-test', { spawnControl: () => fake.process });
  tmux.start();
  fake.attach();
  return { fake, tmux };
}

describe('TmuxControl acknowledged submission', () => {
  it('captures bounded command output from its acknowledgement block', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.executeCommandWithOutput("display-message -p -t '%3' '#{pane_width} #{pane_height}'");
    await tick();
    fake.acknowledgeNext(['120 40']);

    await expect(pending).resolves.toEqual(['120 40']);
  });

  it('sendKeysHex acknowledges exact UTF-8 bytes sent as hex', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.sendKeysHex('%3', Buffer.from('hi 🧪', 'utf8'));
    await tick();
    expect(fake.commands()).toEqual([
      "send-keys -t '%3' -H 68 69 20 f0 9f a7 aa",
    ]);
    fake.acknowledgeNext();

    await expect(pending).resolves.toBeUndefined();
  });

  it('marks sendKeysHex ambiguous when the connection drops after dispatch', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.sendKeysHex('%3', Buffer.from('x', 'utf8'));
    await tick();
    expect(fake.commands()).toEqual(["send-keys -t '%3' -H 78"]);
    fake.disconnect();

    await expect(pending).rejects.toMatchObject({ ambiguous: true });
  });

  it('acknowledges killPane through the public pane seam', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.killPane('%3');
    await tick();
    expect(fake.commands()).toEqual(["kill-pane -t '%3'"]);
    fake.acknowledgeNext();

    await expect(pending).resolves.toBeUndefined();
  });

  it('waits for tmux acknowledgement of text and Enter', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.sendPrompt('%3', 'continue 🧪', 'text-and-enter');
    await tick();
    // "continue " = 63 6f 6e 74 69 6e 75 65 20, 🧪 (U+1F9EA) = f0 9f a7 aa
    expect(fake.commands()).toEqual([
      "send-keys -t '%3' -H 63 6f 6e 74 69 6e 75 65 20 f0 9f a7 aa",
    ]);

    fake.acknowledgeNext();
    await tick();
    expect(fake.commands()).toEqual([
      "send-keys -t '%3' -H 63 6f 6e 74 69 6e 75 65 20 f0 9f a7 aa",
      "send-keys -t '%3' Enter",
    ]);

    fake.acknowledgeNext();
    await expect(pending).resolves.toBeUndefined();
  });

  it('omits Enter for text-only submit mode', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.sendPrompt('%3', 'hi', 'text');
    await tick();
    fake.acknowledgeNext();
    await expect(pending).resolves.toBeUndefined();
    expect(fake.commands()).toEqual(["send-keys -t '%3' -H 68 69"]);
  });

  it.each(['before-text-ack', 'between-text-and-enter', 'after-enter-write'])(
    'marks a disconnect %s as ambiguous so the prompt is never replayed',
    async (point) => {
      const { fake, tmux } = startControl();

      const pending = tmux.sendPrompt('%3', 'continue', 'text-and-enter');
      await tick();
      if (point !== 'before-text-ack') {
        fake.acknowledgeNext();
        await tick();
      }
      fake.disconnect();
      await expect(pending).rejects.toMatchObject({ ambiguous: true });
    },
  );

  it('rejects with a non-ambiguous error when tmux reports %error', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.executeCommand("select-pane -t '%3'");
    await tick();
    fake.errorNext();

    await expect(pending).rejects.toThrow(/tmux command failed/);
    await pending.catch((error: unknown) => {
      expect((error as { ambiguous?: boolean }).ambiguous).toBeUndefined();
    });
  });

  it('resolves executeCommand only after the matching %end', async () => {
    const { fake, tmux } = startControl();

    let settled = false;
    const pending = tmux.executeCommand("select-pane -t '%3'").then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    fake.acknowledgeNext();
    await pending;
    expect(settled).toBe(true);
  });

  it('ignores the initial attach acknowledgement so the first command still correlates', async () => {
    // startControl already emitted the attach block; a command issued afterward
    // must resolve on its OWN block, not the leftover attach block.
    const { fake, tmux } = startControl();

    let settled = false;
    const pending = tmux.executeCommand("select-pane -t '%3'").then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    fake.acknowledgeNext();
    await pending;
    expect(settled).toBe(true);
  });

  it('serializes commands so each acknowledgement resolves its own transaction', async () => {
    const { fake, tmux } = startControl();

    const first = tmux.executeCommand("select-pane -t '%3'");
    const second = tmux.executeCommand("kill-pane -t '%7'");
    await tick();
    // The second command is not written until the first is acknowledged.
    expect(fake.commands()).toEqual(["select-pane -t '%3'"]);

    fake.acknowledgeNext();
    await first;
    await tick();
    expect(fake.commands()).toEqual(["select-pane -t '%3'", "kill-pane -t '%7'"]);

    fake.acknowledgeNext();
    await expect(second).resolves.toBeUndefined();
  });

  it('does not let a fire-and-forget command resolve a pending acknowledged transaction', async () => {
    const { fake, tmux } = startControl();

    const pending = tmux.executeCommand("send-keys -t '%3' -H 61");
    // A fire-and-forget mutation races onto the same control connection before
    // the acknowledged command's own write lands.
    tmux.selectPane('%9');
    await tick();
    expect(fake.commands().slice().sort()).toEqual(
      ["select-pane -t '%9'", "send-keys -t '%3' -H 61"].sort(),
    );

    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // tmux acknowledges the fire-and-forget block first: it must be discarded,
    // never used to resolve the acknowledged transaction.
    fake.acknowledgeNext();
    await tick();
    expect(settled).toBe(false);

    // The acknowledged transaction resolves only on its own block.
    fake.acknowledgeNext();
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects every outstanding transaction as ambiguous on disconnect', async () => {
    const { fake, tmux } = startControl();

    const first = tmux.executeCommand("select-pane -t '%3'");
    await tick();
    fake.disconnect();
    await expect(first).rejects.toMatchObject({ ambiguous: true });
  });
});
