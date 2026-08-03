import { describe, expect, it } from 'vitest';
import { TmuxControl, tmuxDimensionArg, unescapeTmuxOutput } from '../../src/services/bridge/tmuxControl.js';

describe('TmuxControl pane targets (LAN bridge)', () => {
  function recordingControl() {
    const tmux = new TmuxControl('psyche-test');
    const commands: string[] = [];
    tmux.command = (line: string) => {
      commands.push(line);
    };
    return { tmux, commands };
  }

  it('builds quoted commands for a real pane id', () => {
    const { tmux, commands } = recordingControl();
    tmux.killPane('%7');
    tmux.resizePane('%7', 100, 30);
    tmux.sendKeysHex('%7', Buffer.from([0x61, 0x0d]));
    expect(commands).toEqual([
      "kill-pane -t '%7'",
      "resize-pane -t '%7' -x 100 -y 30",
      "send-keys -t '%7' -H 61 0d",
    ]);
  });

  // Regression: this daemon listens on 0.0.0.0 and advertises itself over
  // Bonjour, and `paneId` comes straight from a paired client's `sendInput`.
  // A newline used to end the control-mode command and start a new one, so a
  // paired device could run `run-shell` — arbitrary code as the user.
  it('refuses pane ids that would inject a second tmux command', () => {
    const { tmux, commands } = recordingControl();
    const injected = "%7'\nrun-shell 'touch /tmp/psyche-pwned'";

    expect(() => tmux.sendKeysHex(injected, Buffer.from('x'))).toThrow(/invalid pane id/);
    expect(() => tmux.killPane(injected)).toThrow(/invalid pane id/);
    expect(() => tmux.resizePane(injected, 80, 24)).toThrow(/invalid pane id/);
    expect(commands).toEqual([]);
  });

  it('rejects a multi-line command assembled by any other route', () => {
    const tmux = new TmuxControl('psyche-test');
    expect(() => tmux.command("kill-pane -t '%7'\nrun-shell 'id'")).toThrow(/single line/);
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

  it('handles UTF-8 surrogate pairs without corruption', () => {
    const out = unescapeTmuxOutput('\u{1f9ea}');
    expect(out).toEqual(Buffer.from('\u{1f9ea}', 'utf8'));
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
