import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  attentionLabel,
  classifySettledTail,
  createAttentionTracker,
  hasWorkingIndicators,
  looksLikeQuestion,
} from '../native/macos/psyche-build-tauri/web/sessions/attention.mjs';

const webRoot = join(process.cwd(), 'native/macos/psyche-build-tauri/web');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');
const sessionEntry = readFileSync(join(webRoot, 'sessions/session-entry.js'), 'utf8');

const SETTLE = 2200;

describe('agent working indicators', () => {
  it('reads the interrupt hint as work in flight', () => {
    expect(hasWorkingIndicators('✻ Pondering… (12s · esc to interrupt)')).toBe(true);
    expect(hasWorkingIndicators('press esc to cancel')).toBe(true);
  });

  it('reads a spinner glyph next to a progress word as work in flight', () => {
    expect(hasWorkingIndicators('✽ Refactoring...')).toBe(true);
    expect(hasWorkingIndicators('⠹ compiling…')).toBe(true);
    expect(hasWorkingIndicators('Building 42%')).toBe(true);
    expect(hasWorkingIndicators('Running tests 3/9')).toBe(true);
  });

  it('does not read a finished sentence as work in flight', () => {
    expect(hasWorkingIndicators('Fixed the auth module. All tests passed.\n> ')).toBe(false);
    expect(hasWorkingIndicators('')).toBe(false);
    // Past tense on its own is a report, not a spinner: no glyph, no ellipsis.
    expect(hasWorkingIndicators('Reviewed the diff and pushed the branch.')).toBe(false);
  });
});

describe('question detection', () => {
  it('recognises the shapes agents actually ask in', () => {
    expect(looksLikeQuestion('Delete all files? [y/n]')).toBe(true);
    expect(looksLikeQuestion('Continue? (y/N)')).toBe(true);
    expect(looksLikeQuestion('[A]ccept, [R]eject')).toBe(true);
    expect(looksLikeQuestion('❯ 1. Yes\n  2. No')).toBe(true);
    expect(looksLikeQuestion('Press enter to continue')).toBe(true);
    expect(looksLikeQuestion('Do you want to proceed with the migration')).toBe(true);
  });

  it('leaves ordinary output alone', () => {
    expect(looksLikeQuestion('Wrote 3 files.\n> ')).toBe(false);
    expect(looksLikeQuestion('')).toBe(false);
  });

  it('separates an outstanding question from a handed-back turn', () => {
    expect(classifySettledTail('Overwrite config.json? [y/n]')).toBe('question');
    expect(classifySettledTail('Done. Anything else?\n> ')).toBe('turn');
    expect(classifySettledTail('✻ Thinking… (esc to interrupt)')).toBe('working');
  });
});

describe('attention tracker', () => {
  it('never fires on the first sample it sees', () => {
    const tracker = createAttentionTracker();
    // A session adopted at an idle prompt has asked nothing: flagging it here
    // would badge every restored pane at launch.
    expect(tracker.observe('a', '> ', 0).needsAttention).toBe(false);
    expect(tracker.observe('a', '> ', 10_000).needsAttention).toBe(false);
  });

  it('fires once output has settled after real activity', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', '> ', 0);
    tracker.observe('a', 'Applying the patch…', 1_000);
    expect(tracker.observe('a', 'Done. Which branch should I target?\n> ', 2_000)
      .needsAttention).toBe(false);
    // Settled, but not yet long enough to be sure it is not mid-redraw.
    expect(tracker.observe('a', 'Done. Which branch should I target?\n> ', 3_000)
      .needsAttention).toBe(false);
    expect(tracker.observe('a', 'Done. Which branch should I target?\n> ', 2_000 + SETTLE)
      .needsAttention).toBe(true);
  });

  it('reports why, so the pane can say which kind of waiting it is', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', 'start', 0);
    tracker.observe('a', 'Overwrite config.json? [y/n]', 1_000);
    expect(tracker.observe('a', 'Overwrite config.json? [y/n]', 1_000 + SETTLE)).toEqual({
      needsAttention: true, reason: 'question',
    });

    const other = createAttentionTracker();
    other.observe('b', 'start', 0);
    other.observe('b', 'Pushed the branch.\n> ', 1_000);
    expect(other.observe('b', 'Pushed the branch.\n> ', 1_000 + SETTLE)).toEqual({
      needsAttention: true, reason: 'turn',
    });
  });

  it('stays quiet while the agent is visibly working, however long it sits', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', 'start', 0);
    tracker.observe('a', '✻ Crunching… (esc to interrupt)', 1_000);
    expect(tracker.observe('a', '✻ Crunching… (esc to interrupt)', 1_000 + SETTLE * 10)
      .needsAttention).toBe(false);
  });

  it('clears on the keystroke and will not re-fire until the agent speaks', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', 'start', 0);
    tracker.observe('a', 'Which branch?\n> ', 1_000);
    expect(tracker.observe('a', 'Which branch?\n> ', 1_000 + SETTLE).needsAttention).toBe(true);

    expect(tracker.userInput('a').needsAttention).toBe(false);
    // Same unchanged tail, long settled: without the disarm this would come
    // straight back and re-badge the pane the user just answered.
    expect(tracker.observe('a', 'Which branch?\n> ', 1_000 + SETTLE * 4).needsAttention).toBe(false);

    // The agent replies, finishes, and the pane may ask again.
    tracker.observe('a', 'Targeting main. Ready.\n> ', 20_000);
    expect(tracker.observe('a', 'Targeting main. Ready.\n> ', 20_000 + SETTLE)
      .needsAttention).toBe(true);
  });

  it('trusts the bell immediately, but not before the session has done anything', () => {
    const tracker = createAttentionTracker();
    expect(tracker.bell('a').needsAttention).toBe(false);

    tracker.observe('a', 'start', 0);
    expect(tracker.bell('a')).toEqual({ needsAttention: true, reason: 'question' });

    tracker.userInput('a');
    // Disarmed: a bell rung while the agent is still reacting to the answer is
    // not a new question.
    expect(tracker.bell('a').needsAttention).toBe(false);
  });

  it('forgets sessions that are gone', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', 'start', 0);
    tracker.observe('a', 'Which branch?\n> ', 1_000);
    tracker.observe('a', 'Which branch?\n> ', 1_000 + SETTLE);
    tracker.observe('b', 'start', 0);

    tracker.retain(['b']);
    expect(tracker.state('a').needsAttention).toBe(false);
    // Re-adopting 'a' starts from a fresh baseline rather than its old verdict.
    expect(tracker.observe('a', 'Which branch?\n> ', 30_000).needsAttention).toBe(false);
  });

  it('gives every surface the same words for a state', () => {
    expect(attentionLabel('question')).toBe('Needs your answer');
    expect(attentionLabel('turn')).toBe('Waiting for you');
    expect(attentionLabel(null)).toBe('Waiting for you');
  });
});

describe('desktop shell wiring', () => {
  it('exposes the tracker to the shell through the sessions bundle', () => {
    expect(sessionEntry).toMatch(/createAttentionTracker[\s\S]*from '\.\/attention\.mjs'/);
    expect(mainJs).toContain('PsycheSessions.createAttentionTracker()');
  });

  it('samples only panes that can actually be waiting on an answer', () => {
    // A shell prompt sitting at `$` is idle, not waiting — badging it would put
    // a permanent mark on every terminal in the app.
    expect(mainJs).toMatch(
      /function threadWantsAttentionTracking\(thread\)[\s\S]{0,320}\(thread\.kind \|\| "shell"\) !== "shell"/
    );
    expect(mainJs).toMatch(/threadWantsAttentionTracking[\s\S]{0,400}thread\.status !== "exited"/);
    expect(mainJs).toContain('setInterval(sampleThreadAttention, ATTENTION_SAMPLE_MS)');
  });

  it('reads what the terminal shows rather than the bytes that produced it', () => {
    expect(mainJs).toMatch(/function terminalTail\(term, lines\)[\s\S]{0,400}translateToString\(true\)/);
  });

  it('clears attention on the keystroke, the bell and on exit', () => {
    expect(mainJs).toMatch(/term\.onData\(function \(data\) \{[\s\S]{0,300}noteThreadUserInput\(thread\)/);
    expect(mainJs).toMatch(/term\.onBell\(function \(\)[\s\S]{0,200}attentionTracker\.bell\(thread\.id\)/);
    expect(mainJs).toMatch(/thread\.status = "exited";[\s\S]{0,300}clearThreadAttention\(thread\)/);
  });

  it('marks the waiting session on the rail, the pane and the minimap', () => {
    expect(mainJs).toMatch(/thread\.needsAttention \? " needs-attention" : ""/);
    expect(mainJs).toMatch(/session-attention-badge[\s\S]{0,200}>!</);
    expect(mainJs).toContain('classList.toggle("needs-attention", !!thread.needsAttention)');
    expect(mainJs).toMatch(/thread\.needsAttention \? " attention" : ""/);
    // The group-head counts already existed but only ever saw Coven rows; local
    // panes reaching them is the point of all of the above.
    expect(mainJs).toContain('row.needsAttention');
  });

  it('states the waiting reason in words, never in colour alone', () => {
    expect(mainJs).toMatch(/PsycheSessions\.attentionLabel\(thread\.attentionReason\)/);
    expect(stylesCss).toContain('.terminal-pane-attention');
    expect(stylesCss).toMatch(/\.terminal-pane\.needs-attention/);
    expect(stylesCss).toMatch(/\.minimap-dot\.attention/);
    // The header grew a seventh track for the chip; leaving it at six would
    // wrap the close button onto a second row the moment a pane waits.
    expect(stylesCss).toMatch(
      /\.terminal-pane-header \{[\s\S]{0,120}grid-template-columns: auto minmax\(0, 1fr\) auto auto auto auto auto;/
    );
  });
});

describe('hover to focus', () => {
  it('focuses the pane the pointer rests on, after a dwell', () => {
    expect(mainJs).toMatch(/terminalHost\.addEventListener\("pointerover"/);
    expect(mainJs).toMatch(/HOVER_FOCUS_DWELL_MS\s*=\s*\d+/);
    expect(mainJs).toMatch(/hoverFocusTimer = setTimeout\([\s\S]{0,400}focusThread\(threadId\)/);
  });

  it('will not steal a gesture or a keystroke the user meant for something else', () => {
    expect(mainJs).toMatch(/function hoverFocusBlocked\(\)[\s\S]{0,700}is-pane-dragging/);
    expect(mainJs).toMatch(/function hoverFocusBlocked\(\)[\s\S]{0,700}if \(editingContext\) return true/);
    expect(mainJs).toMatch(/function hoverFocusBlocked\(\)[\s\S]{0,900}tagName === "INPUT"/);
    // Re-checked when the timer fires, not only when the pointer arrived.
    expect(mainJs).toMatch(/hoverFocusTimer = null;[\s\S]{0,300}if \(hoverFocusBlocked\(\)\) return;/);
    expect(mainJs).toMatch(/event\.pointerType && event\.pointerType !== "mouse"/);
  });

  it('does nothing when the pointer is already on the focused pane', () => {
    expect(mainJs).toMatch(/if \(threadId === state\.activeThreadId\) return;/);
    expect(mainJs).toMatch(/terminalHost\.addEventListener\("pointerleave", cancelHoverFocus\)/);
  });
});
