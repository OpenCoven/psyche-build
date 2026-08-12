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

function functionSource(name: string) {
  const start = mainJs.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = mainJs.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < mainJs.length; index += 1) {
    if (mainJs[index] === '{') depth += 1;
    if (mainJs[index] === '}') depth -= 1;
    if (depth === 0) return mainJs.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function cssDeclarations(selector: string) {
  const source = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const normalizedSelector = selector.replace(/\s+/g, ' ').trim();
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const declarations = new Map<string, string>();
  let found = false;
  for (const match of source.matchAll(rulePattern)) {
    if (match[1].replace(/\s+/g, ' ').trim() !== normalizedSelector) continue;
    found = true;
    for (const declaration of match[2].split(';').map((item) => item.trim()).filter(Boolean)) {
      const separator = declaration.indexOf(':');
      declarations.set(
        declaration.slice(0, separator).trim(),
        declaration.slice(separator + 1).replace(/\s+/g, ' ').trim(),
      );
    }
  }
  if (found) return declarations;
  throw new Error(`missing CSS rule ${selector}`);
}

function compileFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return Function(...names, `"use strict"; return (${source});`)(...values) as T;
}

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

  it('treats an interrupt as a fresh settle window instead of an immediate badge', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', '> ', 0);
    expect(tracker.observe('a', '✻ Working… (esc to interrupt)', 1_000)).toEqual({
      needsAttention: false, reason: null,
    });

    expect(tracker.interrupt('a')).toEqual({ needsAttention: false, reason: null });

    expect(tracker.observe('a', '> ', 2_000)).toEqual({ needsAttention: false, reason: null });
    expect(tracker.observe('a', '> ', 2_000 + SETTLE - 1)).toEqual({
      needsAttention: false, reason: null,
    });
    expect(tracker.observe('a', '> ', 2_000 + SETTLE)).toEqual({
      needsAttention: true, reason: 'turn',
    });
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

  it('upgrades a settled turn to an explicit question when the terminal rings', () => {
    const tracker = createAttentionTracker();
    tracker.observe('a', 'start', 0);
    tracker.observe('a', 'Finished the task.\n> ', 1_000);
    expect(tracker.observe('a', 'Finished the task.\n> ', 1_000 + SETTLE)).toEqual({
      needsAttention: true, reason: 'turn',
    });

    expect(tracker.bell('a')).toEqual({ needsAttention: true, reason: 'question' });
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

  it('routes terminal input through the attention-aware sender', () => {
    expect(mainJs).toMatch(
      /term\.onData\(function \(data\) \{\s*sendToThread\(thread, data\);\s*\}\);/
    );
    expect(
      mainJs.match(
        /\{ label: "Interrupt", run: function \(\) \{ sendToThread\(thread, "\\x03"\); \} \}/g
      )
    ).toHaveLength(2);
  });

  it('distinguishes interrupts from answers before applying attention state', () => {
    const eligible = { id: 'eligible', trackAttention: true };
    const ineligible = { id: 'ineligible', trackAttention: false };
    const interruptState = { needsAttention: false, reason: 'interrupt' };
    const userInputState = { needsAttention: false, reason: 'answer' };
    const trackerCalls: string[] = [];
    const eligibilityChecks: string[] = [];
    const applied: Array<[typeof eligible, typeof interruptState | typeof userInputState]> = [];
    const noteThreadInput = compileFunction<
      (thread: typeof eligible | null, text: string) => void
    >(functionSource('noteThreadInput'), {
      threadWantsAttentionTracking(thread: typeof eligible) {
        eligibilityChecks.push(thread.id);
        return thread.trackAttention;
      },
      attentionTracker: {
        interrupt(id: string) {
          trackerCalls.push(`interrupt:${id}`);
          return interruptState;
        },
        userInput(id: string) {
          trackerCalls.push(`userInput:${id}`);
          return userInputState;
        },
      },
      applyThreadAttention(
        thread: typeof eligible,
        next: typeof interruptState | typeof userInputState,
      ) {
        applied.push([thread, next]);
      },
    });

    noteThreadInput(eligible, '\x03');
    noteThreadInput(eligible, 'answer');
    noteThreadInput(eligible, '\x03more');
    noteThreadInput(ineligible, '\x03');
    noteThreadInput(null, 'ignored');

    expect(eligibilityChecks).toEqual(['eligible', 'eligible', 'eligible', 'ineligible']);
    expect(trackerCalls).toEqual([
      'interrupt:eligible',
      'userInput:eligible',
      'userInput:eligible',
    ]);
    expect(applied).toEqual([
      [eligible, interruptState],
      [eligible, userInputState],
      [eligible, userInputState],
    ]);
  });

  it('clears attention on the bell and on exit', () => {
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

  it('suppresses and restores branch status glow as attention changes', () => {
    const paneClasses = new Set(['terminal-pane']);
    const branch = {
      classList: { contains: (name: string) => name === 'terminal-pane-branch' },
      dataset: { paneStatus: 'failed' } as Record<string, string>,
      firstElementChild: null as null | {
        classList: {
          contains: (name: string) => boolean;
          toggle: (name: string, enabled: boolean) => void;
        };
        dataset: Record<string, string>;
      },
    };
    const pane = {
      classList: {
        contains: (name: string) => paneClasses.has(name),
        toggle: (name: string, enabled: boolean) => {
          if (enabled) paneClasses.add(name);
          else paneClasses.delete(name);
        },
      },
      dataset: { status: 'failed' },
      parentElement: branch,
    };
    branch.firstElementChild = pane;
    const attention = {
      hidden: true,
      textContent: '',
      title: '',
      setAttribute: () => undefined,
    };
    const syncPaneBranchStatusChrome = compileFunction<(value: typeof branch) => void>(
      functionSource('syncPaneBranchStatusChrome'),
      {},
    );
    const syncThreadAttentionChrome = compileFunction<(
      value: { id: string; needsAttention: boolean; attentionReason: string | null;
        pane: typeof pane; paneAttention: typeof attention },
    ) => void>(functionSource('syncThreadAttentionChrome'), {
      syncPaneBranchStatusChrome,
      PsycheSessions: { attentionLabel: () => 'Waiting for input' },
      terminalArea: { querySelector: () => null },
    });
    const thread: {
      id: string;
      needsAttention: boolean;
      attentionReason: string | null;
      pane: typeof pane;
      paneAttention: typeof attention;
    } = {
      id: 'thread-a',
      needsAttention: true,
      attentionReason: 'question',
      pane,
      paneAttention: attention,
    };

    syncThreadAttentionChrome(thread);
    expect(paneClasses.has('needs-attention')).toBe(true);
    expect('paneStatus' in branch.dataset).toBe(false);

    thread.needsAttention = false;
    thread.attentionReason = null;
    syncThreadAttentionChrome(thread);
    expect(paneClasses.has('needs-attention')).toBe(false);
    expect(branch.dataset.paneStatus).toBe('failed');
  });

  it('states the waiting reason in words, never in colour alone', () => {
    const statusGlowSelector =
      '.terminal-pane-branch:is([data-pane-status="starting"], [data-pane-status="failed"], [data-pane-status="exited"])';
    const rootStatusGlowSelector =
      '.terminal-host > .terminal-pane:is([data-status="starting"], [data-status="failed"], [data-status="exited"]):not(.needs-attention)';

    expect(mainJs).toMatch(/PsycheSessions\.attentionLabel\(thread\.attentionReason\)/);
    expect(stylesCss).toContain('.terminal-pane-attention');
    expect(cssDeclarations('.terminal-pane.needs-attention, .terminal-pane.focused.needs-attention'))
      .toEqual(new Map([
        ['border-color', 'rgba(251, 191, 36, 0.6)'],
        ['box-shadow', '0 0 0 1px rgba(251, 191, 36, 0.28)'],
      ]));
    expect(cssDeclarations(statusGlowSelector).has('box-shadow')).toBe(true);
    expect(cssDeclarations(rootStatusGlowSelector).has('box-shadow')).toBe(true);
    expect(stylesCss).toMatch(/\.minimap-dot\.attention/);
    expect(functionSource('mountTerminal')).toMatch(
      /header\.appendChild\(label\);[\s\S]*header\.appendChild\(attention\);[\s\S]*header\.appendChild\(span\)/,
    );
    // The terminal header needs one track per mounted child once the attention
    // chip joins the row, or the controls wrap when a pane is waiting.
    expect(stylesCss).toMatch(
      /\.terminal-pane-header \{[\s\S]{0,120}grid-template-columns: auto minmax\(0, 1fr\) auto auto auto auto;/
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
    expect(mainJs).toMatch(
      /function hoverFocusBlocked\(\)[\s\S]{0,1200}focused\.closest\("\.xterm"\)[\s\S]{0,160}return true/,
    );
    // Re-checked when the timer fires, not only when the pointer arrived.
    expect(mainJs).toMatch(/hoverFocusTimer = null;[\s\S]{0,300}if \(hoverFocusBlocked\(\)\) return;/);
    expect(mainJs).toMatch(/event\.pointerType && event\.pointerType !== "mouse"/);
  });

  it('does nothing when the pointer is already on the focused pane', () => {
    expect(mainJs).toMatch(/if \(threadId === state\.activeThreadId\) return;/);
    expect(mainJs).toMatch(/terminalHost\.addEventListener\("pointerleave", cancelHoverFocus\)/);
  });
});
