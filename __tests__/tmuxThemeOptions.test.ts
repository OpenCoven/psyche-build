import { describe, expect, it } from 'vitest';
import { buildTmuxSessionThemeOptions } from '../src/utils/tmuxThemeOptions.js';

describe('tmux theme options', () => {
  it('themes the tmux chrome from the active psyche theme', () => {
    expect(buildTmuxSessionThemeOptions('orange')).toEqual([
      ['window-style', 'fg=default,bg=default'],
      ['window-active-style', 'fg=default,bg=default'],
      ['pane-border-style', 'fg=colour240'],
      ['pane-active-border-style', 'fg=colour141'],
      ['status-style', 'fg=colour141,bg=colour236'],
    ]);
  });
});
