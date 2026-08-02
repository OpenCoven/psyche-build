import { describe, expect, it } from 'vitest';
import { TmuxControl, tmuxDimensionArg, unescapeTmuxOutput } from '../../src/daemon/tmuxControl.js';
import { encodeBinaryFrame, decodeBinaryFrame } from '../../src/daemon/protocol.js';

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

  it('mixes escapes and literals', () => {
    // `\033]0;title\007` — OSC set-title sequence
    const out = unescapeTmuxOutput('\\033]0;psyche\\007');
    expect(out.toString('utf8')).toBe('\x1b]0;psyche\x07');
  });
});

describe('binary frame codec', () => {
  it('round-trips a streamId + payload', () => {
    const payload = Buffer.from('hello pane output');
    const encoded = encodeBinaryFrame('abc123', payload);
    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.streamId).toBe('abc123');
    expect(decoded.payload).toEqual(payload);
  });

  it('handles an empty payload', () => {
    const encoded = encodeBinaryFrame('xyz', Buffer.alloc(0));
    const decoded = decodeBinaryFrame(encoded);
    expect(decoded.streamId).toBe('xyz');
    expect(decoded.payload.length).toBe(0);
  });

  it('throws on a streamId longer than 255 bytes', () => {
    const longId = 'x'.repeat(256);
    expect(() => encodeBinaryFrame(longId, Buffer.alloc(0))).toThrow();
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

describe('TmuxControl pane commands', () => {
  it('selects a pane using a quoted tmux target', () => {
    const tmux = new TmuxControl('psyche-test');
    const commands: string[] = [];
    tmux.command = (line: string) => {
      commands.push(line);
    };

    tmux.selectPane("%3'bad");

    expect(commands).toEqual(["select-pane -t '%3'\\''bad'"]);
  });
});
