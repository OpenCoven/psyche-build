import { describe, expect, it } from 'vitest';
import {
  assertSingleTmuxCommandLine,
  assertTmuxPaneId,
  isTmuxPaneId,
  quoteTmuxArgument,
} from '../../src/utils/tmuxTarget.js';

describe('isTmuxPaneId', () => {
  it('accepts the `#{pane_id}` format psyche actually stores', () => {
    expect(isTmuxPaneId('%0')).toBe(true);
    expect(isTmuxPaneId('%3')).toBe(true);
    expect(isTmuxPaneId('%1234567')).toBe(true);
  });

  it('rejects other tmux target syntaxes, which never reach us from config', () => {
    expect(isTmuxPaneId('session:1.2')).toBe(false);
    expect(isTmuxPaneId('{last}')).toBe(false);
    expect(isTmuxPaneId('top-left')).toBe(false);
    expect(isTmuxPaneId('%')).toBe(false);
    expect(isTmuxPaneId('%3a')).toBe(false);
    expect(isTmuxPaneId('3')).toBe(false);
  });

  it('rejects non-strings rather than coercing them', () => {
    expect(isTmuxPaneId(undefined)).toBe(false);
    expect(isTmuxPaneId(null)).toBe(false);
    expect(isTmuxPaneId(3)).toBe(false);
    expect(isTmuxPaneId({ toString: () => '%3' })).toBe(false);
  });

  it('rejects a pane id carrying an injected tmux command', () => {
    expect(isTmuxPaneId("%3'\nrun-shell 'id'")).toBe(false);
    expect(isTmuxPaneId('%3\nkill-server')).toBe(false);
  });
});

describe('assertTmuxPaneId', () => {
  it('returns the value when it is a pane id', () => {
    expect(assertTmuxPaneId('%12')).toBe('%12');
  });

  it('throws a labelled error otherwise', () => {
    expect(() => assertTmuxPaneId('%3\nkill-server')).toThrow(/invalid pane id/);
    expect(() => assertTmuxPaneId('nope', 'target')).toThrow(/invalid target/);
  });
});

describe('quoteTmuxArgument', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(quoteTmuxArgument('plain')).toBe("'plain'");
    expect(quoteTmuxArgument("a'b")).toBe("'a'\\''b'");
  });

  it('refuses control characters instead of quoting them', () => {
    // Quoting alone protects the argument boundary; only rejection protects
    // the *command* boundary of tmux control mode.
    expect(() => quoteTmuxArgument('a\nb')).toThrow(/control characters/);
    expect(() => quoteTmuxArgument('a\rb')).toThrow(/control characters/);
    expect(() => quoteTmuxArgument('a\0b')).toThrow(/control characters/);
    expect(() => quoteTmuxArgument('a\x7fb')).toThrow(/control characters/);
    expect(() => quoteTmuxArgument('a\x1b[31m')).toThrow(/control characters/);
  });

  it('allows spaces and shell metacharacters, which quoting does handle', () => {
    expect(quoteTmuxArgument('psyche build-a1b2')).toBe("'psyche build-a1b2'");
    expect(quoteTmuxArgument('a;b|c$d')).toBe("'a;b|c$d'");
  });
});

describe('assertSingleTmuxCommandLine', () => {
  it('passes a single-line command through', () => {
    expect(assertSingleTmuxCommandLine("kill-pane -t '%3'")).toBe("kill-pane -t '%3'");
  });

  it('rejects a command that spans lines', () => {
    expect(() => assertSingleTmuxCommandLine("kill-pane -t '%3'\nrun-shell 'id'"))
      .toThrow(/single line/);
    expect(() => assertSingleTmuxCommandLine("kill-pane\r\nrun-shell 'id'"))
      .toThrow(/single line/);
  });
});
