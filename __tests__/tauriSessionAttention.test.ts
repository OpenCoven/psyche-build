import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  attentionLabel,
  classifySettledTail,
  createAttentionTracker,
  hasWorkingIndicators,
  looksLikeQuestion,
} from '../native/desktop/psyche-build-tauri/web/sessions/attention.mjs';

const webRoot = join(process.cwd(), 'native/desktop/psyche-build-tauri/web');
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');
const sessionEntry = readFileSync(join(webRoot, 'sessions/session-entry.js'), 'utf8');

const SETTLE = 2200;

function functionSource(name: string) {
  const asyncStart = mainJs.indexOf(`async function ${name}(`);
  const syncStart = mainJs.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
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

  it('initialises local threads with sidebar activity fields', () => {
    expect(mainJs).toMatch(
      /function createThread\(opts\)[\s\S]{0,2600}lastOutputAt:\s*0,[\s\S]{0,120}isWorking:\s*false,[\s\S]{0,120}sidebarStatusKey:\s*"busy"/,
    );
  });

  it('timestamps PTY output as soon as a live thread receives bytes', () => {
    expect(mainJs).toMatch(
      /listen\("pty:data", function \(event\) \{[\s\S]{0,260}var thread = findThread\(payload\.thread_id\);[\s\S]{0,120}if \(!isLiveThread\(thread\)\) return;[\s\S]{0,120}thread\.lastOutputAt = Date\.now\(\);/,
    );
  });

  it('samples only panes that can actually be waiting on an answer', () => {
    // A shell prompt sitting at `$` is idle, not waiting — badging it would put
    // a permanent mark on every terminal in the app.
    const source = functionSource('threadWantsAttentionTracking');
    expect(source).toMatch(/\(thread\.kind \|\| "shell"\) !== "shell"/);
    expect(source).toMatch(/thread\.status !== "exited"/);
    expect(source).toMatch(/thread\.status !== "failed"/);
    expect(mainJs).toContain('setInterval(sampleThreadAttention, ATTENTION_SAMPLE_MS)');
  });

  it('excludes failed PTYs from attention tracking', () => {
    const threadWantsAttentionTracking = compileFunction<
      (thread: Record<string, unknown> | null | undefined) => boolean
    >(functionSource('threadWantsAttentionTracking'), {});

    expect(threadWantsAttentionTracking({
      id: 'failed',
      kind: 'coven',
      status: 'failed',
    })).toBe(false);
    expect(threadWantsAttentionTracking({
      id: 'running',
      kind: 'coven',
      status: 'running',
    })).toBe(true);
  });

  it('samples terminal tails once for working state before gating attention', () => {
    expect(functionSource('sampleThreadAttention')).toMatch(
      /var tail = terminalTail\(thread\.term, ATTENTION_TAIL_LINES\);[\s\S]{0,120}thread\.isWorking = PsycheSessions\.sidebarTailIsWorking\(tail\);[\s\S]{0,420}if \(!threadWantsAttentionTracking\(thread\)\) \{/,
    );
  });

  it('returns the clear-attention render verdict so callers can coalesce correctly', () => {
    const source = functionSource('clearThreadAttention');
    expect(source).toMatch(/if \(!thread\) return false;/);
    expect(source).toMatch(
      /return applyThreadAttention\(thread, \{ needsAttention: false, reason: null \}\);/,
    );

    const calls: Array<[Record<string, unknown>, { needsAttention: boolean; reason: string | null }]> = [];
    const clearThreadAttention = compileFunction<
      (thread: Record<string, unknown> | null | undefined) => boolean
    >(source, {
      attentionTracker: { forget: () => undefined },
      applyThreadAttention: (
        thread: Record<string, unknown>,
        next: { needsAttention: boolean; reason: string | null },
      ) => {
        calls.push([thread, next]);
        return true;
      },
    });

    expect(clearThreadAttention(null)).toBe(false);
    const thread = { id: 'thread-1' };
    expect(clearThreadAttention(thread)).toBe(true);
    expect(calls).toEqual([[thread, { needsAttention: false, reason: null }]]);
  });

  it('synchronizes cached sidebar status keys at the start of every sidebar render', () => {
    const renderSource = functionSource('renderSessionList');
    expect(renderSource).toMatch(
      /if \(!sessionListEl\) return;[\s\S]{0,120}if \(editingContext && editingContext\.surface === "sidebar"\) return;[\s\S]{0,120}var now = Date\.now\(\);[\s\S]{0,80}syncLocalSidebarStatusKeys\(now\);[\s\S]{0,320}disarmSessionClose\(\);/,
    );

    const source = functionSource('syncLocalSidebarStatusKeys');
    expect(source).toMatch(
      /thread\.sidebarStatusKey = PsycheSessions\.deriveLocalSidebarStatus\(thread, now\)\.key;/,
    );

    const state = {
      threads: [
        { id: 'one', sidebarStatusKey: 'busy' },
        { id: 'two', sidebarStatusKey: 'active' },
      ],
    };
    const calls: Array<[string, number]> = [];
    const syncLocalSidebarStatusKeys = compileFunction<(now: number) => void>(source, {
      state,
      PsycheSessions: {
        deriveLocalSidebarStatus: (
          thread: { id: string },
          now: number,
        ) => {
          calls.push([thread.id, now]);
          return { key: thread.id === 'one' ? 'idle' : 'exited' };
        },
      },
    });

    syncLocalSidebarStatusKeys(4_242);
    expect(state.threads.map((thread) => thread.sidebarStatusKey)).toEqual(['idle', 'exited']);
    expect(calls).toEqual([
      ['one', 4_242],
      ['two', 4_242],
    ]);
  });

  it('coalesces attention renders without dropping later status-only changes', () => {
    const source = functionSource('sampleThreadAttention');
    expect(source).toContain('var needsFinalRender = false;');
    const statusIndex = source.indexOf('var nextStatus = PsycheSessions.deriveLocalSidebarStatus(thread, now);');
    const attentionIndex = source.indexOf('var attentionChanged = false;');
    expect(statusIndex).toBeGreaterThan(attentionIndex);
    expect(source).toMatch(
      /var attentionChanged = false;[\s\S]{0,520}var nextStatus = PsycheSessions\.deriveLocalSidebarStatus\(thread, now\);[\s\S]{0,200}var statusChanged = false;[\s\S]{0,160}if \(thread\.sidebarStatusKey !== nextStatus\.key\) \{[\s\S]{0,120}thread\.sidebarStatusKey = nextStatus\.key;[\s\S]{0,120}statusChanged = true;/,
    );
    expect(source).toMatch(/if \(attentionChanged\) \{[\s\S]{0,80}needsFinalRender = false;/);
    expect(source).toMatch(
      /else if \(statusChanged\) \{[\s\S]{0,80}needsFinalRender = true;/,
    );
    expect(source).toMatch(
      /attentionTracker\.retain\(tracked\);[\s\S]{0,160}if \(needsFinalRender\) \{[\s\S]{0,80}renderSessionList\(\);[\s\S]{0,80}syncSessionListScroll\(\);/,
    );

    const harness = (
      threads: Array<{
        id: string;
        term: object;
        sidebarStatusKey: string;
        steadyStatusKey: string;
        needsAttention?: boolean;
        attentionReason?: string | null;
      }>,
      attentionById: Map<string, boolean>,
    ) => {
      const renderCalls: string[] = [];
      const syncCalls: string[] = [];
      const retained: string[] = [];
      let renderReason = 'final';
      let syncReason = 'final';
      let renderOffset = 0;
      let syncOffset = 0;
      let retainOffset = 0;
      const state = { threads };
      const deriveKey = (thread: {
        needsAttention?: boolean;
        steadyStatusKey: string;
      }) => (thread.needsAttention ? 'attention' : thread.steadyStatusKey);
      const renderSessionList = () => {
        state.threads.forEach((thread) => {
          thread.sidebarStatusKey = deriveKey(thread);
        });
        renderCalls.push(renderReason);
      };
      const syncSessionListScroll = () => {
        syncCalls.push(syncReason);
      };
      const sampleThreadAttention = compileFunction<() => void>(source, {
        ATTENTION_TAIL_LINES: 14,
        Date: { now: () => 1000 },
        terminalTail: () => '',
        PsycheSessions: {
          sidebarTailIsWorking: () => false,
          deriveLocalSidebarStatus: (thread: { needsAttention?: boolean; steadyStatusKey: string }) => ({
            key: deriveKey(thread),
          }),
        },
        threadWantsAttentionTracking: () => true,
        clearThreadAttention: (
          thread: { id: string; needsAttention?: boolean; attentionReason?: string | null },
        ) => {
          if (!thread.needsAttention) return false;
          thread.needsAttention = false;
          thread.attentionReason = null;
          renderReason = `clear:${thread.id}`;
          syncReason = renderReason;
          renderSessionList();
          syncSessionListScroll();
          renderReason = 'final';
          syncReason = 'final';
          return true;
        },
        applyThreadAttention: (
          thread: { id: string; needsAttention?: boolean; attentionReason?: string | null },
          next: { needsAttention: boolean; reason: string | null },
        ) => {
          var currentReason = thread.attentionReason || null;
          if (!!thread.needsAttention === next.needsAttention && currentReason === next.reason) {
            return false;
          }
          thread.needsAttention = next.needsAttention;
          thread.attentionReason = next.reason;
          renderReason = `attention:${thread.id}`;
          syncReason = renderReason;
          renderSessionList();
          syncSessionListScroll();
          renderReason = 'final';
          syncReason = 'final';
          return true;
        },
        attentionTracker: {
          observe: (id: string) => ({
            needsAttention: attentionById.get(id) || false,
            reason: attentionById.get(id) ? 'turn' : null,
          }),
          retain: (ids: string[]) => retained.push(ids.join(',')),
        },
        state,
        renderSessionList,
        syncSessionListScroll,
      });

      return {
        threads,
        sample() {
          sampleThreadAttention();
          const result = {
            renderCalls: renderCalls.slice(renderOffset),
            syncCalls: syncCalls.slice(syncOffset),
            retained: retained.slice(retainOffset),
          };
          renderOffset = renderCalls.length;
          syncOffset = syncCalls.length;
          retainOffset = retained.length;
          return result;
        },
      };
    };

    const statusBeforeAttention = harness([
      { id: 'one', term: {}, sidebarStatusKey: 'busy', steadyStatusKey: 'idle' },
      { id: 'two', term: {}, sidebarStatusKey: 'busy', steadyStatusKey: 'busy' },
    ], new Map([['one', false], ['two', true]]));

    expect(statusBeforeAttention.sample()).toEqual({
      renderCalls: ['attention:two'],
      syncCalls: ['attention:two'],
      retained: ['one,two'],
    });
    expect(statusBeforeAttention.sample()).toEqual({
      renderCalls: [],
      syncCalls: [],
      retained: ['one,two'],
    });

    const laterStatus = harness([
      { id: 'one', term: {}, sidebarStatusKey: 'busy', steadyStatusKey: 'busy' },
      { id: 'two', term: {}, sidebarStatusKey: 'busy', steadyStatusKey: 'busy' },
    ], new Map([['one', true], ['two', false]]));

    expect(laterStatus.sample()).toEqual({
      renderCalls: ['attention:one'],
      syncCalls: ['attention:one'],
      retained: ['one,two'],
    });
    laterStatus.threads[1].steadyStatusKey = 'idle';
    expect(laterStatus.sample()).toEqual({
      renderCalls: ['final'],
      syncCalls: ['final'],
      retained: ['one,two'],
    });
  });

  it('reads what the terminal shows rather than the bytes that produced it', () => {
    expect(mainJs).toMatch(/function terminalTail\(term, lines\)[\s\S]{0,400}translateToString\(true\)/);
  });

  it('keeps shells out of attention tracking even while sampling their work state', () => {
    expect(functionSource('sampleThreadAttention')).toMatch(
      /thread\.isWorking = PsycheSessions\.sidebarTailIsWorking\(tail\);[\s\S]{0,420}if \(!threadWantsAttentionTracking\(thread\)\) \{[\s\S]{0,160}if \(thread\.needsAttention\) \{[\s\S]{0,120}clearThreadAttention\(thread\)/,
    );
  });

  it('routes terminal input through the attention-aware sender', () => {
    expect(mainJs).toMatch(
      /term\.onData\(function \(data\) \{\s*sendToThread\(thread, data\);\s*\}\);/
    );
    expect(
      mainJs.match(
        /label: "Interrupt", run: function \(\) \{\s*sendToThread\(thread, "\\x03"\);\s*\} \}/g
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
    expect(mainJs).toMatch(
      /function handlePtyExit\(payload\)[\s\S]{0,500}thread\.status = "exited";[\s\S]{0,120}thread\.isWorking = false;[\s\S]{0,300}clearThreadAttention\(thread\)/,
    );
  });

  it('marks dead or failed PTYs as no longer working', () => {
    expect(mainJs).toMatch(/thread\.status = "failed";[\s\S]{0,120}thread\.isWorking = false;/);
  });

  it('marks the waiting session on the rail, the pane and the minimap', () => {
    expect(mainJs).toMatch(/rowModel\.needsAttention \? " needs-attention" : ""/);
    expect(mainJs).toMatch(/attention\.textContent = "!" \+ (?:branchModel|projectModel)\.attentionCount/);
    expect(mainJs).toContain('label.textContent = status.label;');
    expect(mainJs).toContain('classList.toggle("needs-attention", !!thread.needsAttention)');
    expect(mainJs).toMatch(/thread\.needsAttention \? " attention" : ""/);
    // The group-head counts already existed but only ever saw Coven rows; local
    // panes reaching them is the point of all of the above.
    expect(mainJs).toContain('rowModel.needsAttention');
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
