/**
 * "This session is waiting on you."
 *
 * A pane the user has to answer is the one thing in the app they must not miss,
 * and until now the desktop shell had no way to know: only daemon-reported
 * Coven sessions carried a `waiting` status, so local agent panes -- the ones
 * people actually sit in front of -- never lit anything up.
 *
 * There is no LLM here on purpose. The TUI can afford a round trip per settled
 * pane; a UI indicator cannot, and a wrong answer that arrives two seconds late
 * is worse than a plain one that arrives now. So this reads the same signals
 * the TUI's deterministic layer reads (`src/utils/paneAttentionHeuristics.ts`):
 * an agent that is working says so, and one that has gone quiet with no
 * working indicator has handed the turn back.
 *
 * The whole module is pure and time-injected -- `observe` takes `now` -- so the
 * state machine is testable without timers.
 */

/** Words agents spin next to a glyph while they are busy. */
const PROGRESS_WORDS = [
  'working', 'thinking', 'planning', 'pondering', 'crunching', 'analyzing',
  'building', 'testing', 'running', 'searching', 'reviewing', 'understanding',
  'loading', 'processing', 'writing', 'reading', 'editing', 'patching',
  'generating', 'reasoning', 'compiling', 'indexing', 'summarizing',
  'executing', 'refactoring', 'fixing', 'checking', 'scanning',
];

const SPINNER_GLYPH = '[⠁-⣿◐◓◑◒◴◷◶◵●○◦•·⋯⋮✦✧✶✻✽⏳⌛]';

const INTERRUPT_HINT = /\besc\s+to\s+(interrupt|cancel|stop|abort)\b/i;
const SPINNER_LINE = new RegExp(
  `^${SPINNER_GLYPH}\\s*(?:${PROGRESS_WORDS.join('|')})(?:\\b|\\.\\.\\.|…|\\s)`, 'i',
);
const PROGRESS_SUFFIX = new RegExp(
  `\\b(?:${PROGRESS_WORDS.join('|')})\\b.*(?:\\.\\.\\.|…|\\d{1,3}%|/\\d+)`, 'i',
);

/**
 * An explicit choice put to the user. Matching one of these is what separates
 * "answer this" from the softer "your turn", so they stay narrow: a bracketed
 * key set, a numbered menu, or a question with a yes/no pair attached.
 */
const QUESTION_PATTERNS = [
  /\[(?:y\/n|y\/N|Y\/n|yes\/no)\]/i,
  /\((?:y\/n|y\/N|Y\/n|yes\/no)\)/i,
  /\[[A-Za-z]\][A-Za-z]*(?:[,/]|\s+or\s+)\s*\[[A-Za-z]\]/,
  /^\s*(?:❯|>|\*)?\s*\d+[.)]\s+\S/m,
  /\bpress\s+(?:enter|any key|\[[^\]]+\])/i,
  /\bdo you want to\b/i,
  /\bwould you like\b/i,
  /\b(?:continue|proceed|overwrite|approve|confirm)\?/i,
  /\bwaiting for (?:your )?(?:input|response|approval|confirmation)\b/i,
];

/** Lines from the tail that are worth reasoning about at all. */
function meaningfulLines(text, limit) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-limit);
}

/**
 * True when the tail shows an agent mid-turn. Deliberately generous: a false
 * "still working" costs a late badge, a false "your turn" costs a badge on a
 * pane nobody needs to look at -- and a rail of those teaches people to ignore
 * the rail, which is the only failure this feature cannot survive.
 */
export function hasWorkingIndicators(text) {
  const lines = meaningfulLines(text, 10);
  if (lines.length === 0) return false;
  if (INTERRUPT_HINT.test(lines.join('\n'))) return true;
  return lines.some((line) => SPINNER_LINE.test(line) || PROGRESS_SUFFIX.test(line));
}

/** True when the tail puts a specific question to the user. */
export function looksLikeQuestion(text) {
  const tail = meaningfulLines(text, 12).join('\n');
  if (!tail) return false;
  return QUESTION_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * What a settled tail is asking for. `question` and `turn` both need the user;
 * they are separated only so the pane chip can say which, since "answer this"
 * and "carry on when you like" deserve different urgency.
 */
export function classifySettledTail(text) {
  if (hasWorkingIndicators(text)) return 'working';
  if (looksLikeQuestion(text)) return 'question';
  return 'turn';
}

export const DEFAULT_SETTLE_MS = 2200;

/**
 * Tracks one sampled terminal tail per session and decides when it has settled
 * into "waiting on the user".
 *
 * Three rules, each earning its place:
 *
 * 1. *Changed output clears attention.* Anything the agent prints means the
 *    turn is still its own.
 * 2. *Attention needs prior activity.* A session restored at an idle prompt has
 *    not asked the user anything -- flagging it on the first sample would put a
 *    badge on every pane at launch and mean nothing.
 * 3. *User input disarms until the agent speaks again.* Typing is the answer;
 *    the badge must not come straight back while the agent is still reacting.
 */
export function createAttentionTracker(options) {
  const settleMs = Number(options?.settleMs) > 0 ? Number(options.settleMs) : DEFAULT_SETTLE_MS;
  const sessions = new Map();

  function entryFor(id) {
    let entry = sessions.get(id);
    if (!entry) {
      entry = {
        tail: null,
        changedAt: 0,
        sawActivity: false,
        awaitingAgent: false,
        interruptPending: false,
        needsAttention: false,
        reason: null,
      };
      sessions.set(id, entry);
    }
    return entry;
  }

  function resolve(entry) {
    return entry.needsAttention ? { needsAttention: true, reason: entry.reason } : NOT_WAITING;
  }

  return {
    /**
     * Feed the current terminal tail. Returns the session's attention state so
     * callers can diff it against what they last rendered.
     */
    observe(id, tail, now) {
      const entry = entryFor(id);
      const text = typeof tail === 'string' ? tail : '';
      const at = Number.isFinite(now) ? now : 0;

      if (entry.tail === null) {
        // First sample is the baseline, never a verdict: whatever is on screen
        // at adoption predates us and says nothing about whose turn it is.
        entry.tail = text;
        entry.changedAt = at;
        return resolve(entry);
      }

      if (entry.interruptPending) {
        entry.tail = text;
        entry.changedAt = at;
        entry.sawActivity = true;
        entry.awaitingAgent = false;
        entry.interruptPending = false;
        entry.needsAttention = false;
        entry.reason = null;
        return resolve(entry);
      }

      if (text !== entry.tail) {
        entry.tail = text;
        entry.changedAt = at;
        entry.sawActivity = true;
        entry.awaitingAgent = false;
        entry.needsAttention = false;
        entry.reason = null;
        return resolve(entry);
      }

      if (entry.needsAttention) return resolve(entry);
      if (!entry.sawActivity || entry.awaitingAgent) return resolve(entry);
      if (at - entry.changedAt < settleMs) return resolve(entry);

      const verdict = classifySettledTail(text);
      if (verdict === 'working') return resolve(entry);

      entry.needsAttention = true;
      entry.reason = verdict;
      return resolve(entry);
    },

    /**
     * The terminal rang the bell. Agents ring it precisely when they want the
     * user back, so it is trusted immediately rather than waiting to settle --
     * but only once the session has been seen doing something, so a bell from a
     * restored scrollback cannot fire.
     */
    bell(id) {
      const entry = entryFor(id);
      if (entry.tail === null || entry.awaitingAgent) return resolve(entry);
      entry.sawActivity = true;
      entry.interruptPending = false;
      entry.needsAttention = true;
      entry.reason = 'question';
      return resolve(entry);
    },

    /** The user typed into this session: their answer is the acknowledgement. */
    userInput(id) {
      const entry = entryFor(id);
      entry.needsAttention = false;
      entry.reason = null;
      entry.awaitingAgent = true;
      entry.interruptPending = false;
      return resolve(entry);
    },

    interrupt(id) {
      const entry = entryFor(id);
      entry.needsAttention = false;
      entry.reason = null;
      entry.awaitingAgent = false;
      entry.interruptPending = true;
      return resolve(entry);
    },

    /** Clear attention without disarming, e.g. when a session exits. */
    clear(id) {
      const entry = sessions.get(id);
      if (!entry) return NOT_WAITING;
      entry.needsAttention = false;
      entry.reason = null;
      entry.interruptPending = false;
      return NOT_WAITING;
    },

    state(id) {
      const entry = sessions.get(id);
      return entry ? resolve(entry) : NOT_WAITING;
    },

    forget(id) {
      sessions.delete(id);
    },

    /** Drop everything not in `ids`, so closed sessions cannot leak. */
    retain(ids) {
      const keep = new Set(Array.isArray(ids) ? ids : []);
      for (const id of [...sessions.keys()]) {
        if (!keep.has(id)) sessions.delete(id);
      }
    },
  };
}

const NOT_WAITING = Object.freeze({ needsAttention: false, reason: null });

/** The words the UI puts on an attention state. One source, four surfaces. */
export function attentionLabel(reason) {
  return reason === 'question' ? 'Needs your answer' : 'Waiting for you';
}
