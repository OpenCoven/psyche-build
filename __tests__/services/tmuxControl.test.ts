import { describe, expect, it } from 'vitest';
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
  it('builds quoted commands for a real pane id', () => {
    const { tmux, commands } = recordingControl();

    tmux.selectPane('%3');
    tmux.killPane('%7');
    tmux.resizePane('%7', 100, 30);
    tmux.sendKeysHex('%7', Buffer.from([0x61, 0x0d]));

    expect(commands).toEqual([
      "select-pane -t '%3'",
      "kill-pane -t '%7'",
      "resize-pane -t '%7' -x 100 -y 30",
      "send-keys -t '%7' -H 61 0d",
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
