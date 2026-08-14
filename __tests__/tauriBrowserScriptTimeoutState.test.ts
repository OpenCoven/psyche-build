import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL(
  '../native/desktop/psyche-build-tauri/web/main.js', import.meta.url), 'utf8');

function functionSource(source: string, name: string) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  if (!match || match.index === undefined) throw new Error(`missing function ${name}`);
  const start = source.indexOf('{', match.index);
  let depth = 0; let quote: string | null = null; let line = false; let block = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (line) { if (char === '\n') line = false; continue; }
    if (block) { if (char === '*' && next === '/') { block = false; index += 1; } continue; }
    if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = null; continue; }
    if (char === '/' && next === '/') { line = true; index += 1; continue; }
    if (char === '/' && next === '*') { block = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const createState = Function(`"use strict"; return (${functionSource(
  main, 'createBrowserScriptTimeoutState')});`)() as (options: Record<string, unknown>) => any;

const identity = {
  projectRoot: '/project', requestId: 'request-1', actionId: 'action-1',
  invocationId: 'request-1', tabId: 'tab-1', generation: 7, documentToken: 'token-1',
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe('browser script timeout state', () => {
  it('buffers a completed callback until the exact unknown receipt is fixed', async () => {
    const finished: unknown[] = []; const released: unknown[] = []; let notified = 0; let unknown = 0;
    const state = createState({ limit: 4, ttlMs: 60_000,
      setTimeout: () => 1, clearTimeout: () => {}, notify: () => { notified += 1; return Promise.resolve(); },
      unknown: () => { unknown += 1; return Promise.resolve(); },
      release: (entry: unknown) => { released.push(entry); },
      finish: (_entry: unknown, terminal: unknown) => { finished.push(terminal); },
    });
    expect(state.register(identity)).toBe(true);
    expect(state.terminal(identity, { reason: 'completed' })).toBe(true);
    await settle();
    expect(finished).toEqual([]);
    expect(released).toEqual([]);
    expect(notified).toBe(0);
    expect(state.unknownPending(identity, 3)).toBe(true);
    await settle();
    expect(released).toHaveLength(1);
    expect(unknown).toBe(1);
    expect(state.size()).toBe(0);
  });

  it('buffers a replacement until unknown receipt and suppresses late success', async () => {
    const finished: unknown[] = []; let notified = 0; let unknown = 0;
    const state = createState({ limit: 4, ttlMs: 60_000,
      setTimeout: () => 1, clearTimeout: () => {}, notify: () => { notified += 1; return Promise.resolve(); },
      unknown: () => { unknown += 1; return Promise.resolve(); },
      finish: (_entry: unknown, terminal: unknown) => { finished.push(terminal); },
    });
    expect(state.register(identity)).toBe(true);
    expect(state.terminalTab(identity.tabId, identity.generation, { reason: 'document_replaced' })).toBe(true);
    expect(state.complete(identity)).toBe(false);
    expect(state.timedOut(identity)).toBe(false);
    await settle();
    expect(finished).toEqual([]);
    expect(state.unknownPending(identity, 0)).toBe(true);
    await settle();
    expect(finished).toEqual([{ reason: 'document_replaced', durationMs: 0 }]);
    expect(notified).toBe(0);
    expect(unknown).toBe(1);
    expect(state.size()).toBe(0);
  });

  it('measures replacement duration from the correlated native start event', async () => {
    const finished: any[] = []; let now = 100;
    const state = createState({ limit: 4, ttlMs: 60_000, now: () => now,
      setTimeout: () => 1, clearTimeout: () => {}, notify: () => Promise.resolve(), unknown: () => Promise.resolve(),
      finish: (_entry: unknown, terminal: unknown) => { finished.push(terminal); },
    });
    expect(state.register(identity)).toBe(true);
    expect(state.started(identity)).toBe(true);
    now = 117;
    expect(state.terminal(identity, { reason: 'document_replaced' })).toBe(true);
    expect(state.unknownPending(identity, 17)).toBe(true);
    await settle();
    expect(finished).toEqual([{ reason: 'document_replaced', durationMs: 17 }]);
  });

  for (const timing of ['during', 'after'] as const) {
    it(`releases the exact fence only after timeout ACK and ${timing}-ACK terminal`, async () => {
      const ack = deferred(); const finished: unknown[] = []; let notified = 0;
      const state = createState({ limit: 4, ttlMs: 60_000,
        setTimeout: () => 1, clearTimeout: () => {}, notify: () => { notified += 1; return ack.promise; },
        finish: (_entry: unknown, terminal: unknown) => { finished.push(terminal); },
      });
      expect(state.register(identity)).toBe(true);
      expect(state.timedOut(identity)).toBe(true);
      if (timing === 'during') state.terminal(identity, { reason: 'destroyed' });
      if (timing === 'during') {
        expect(finished).toEqual([]);
        expect(state.size()).toBe(1);
      }
      ack.resolve(); await settle();
      if (timing === 'after') {
        expect(finished).toEqual([]);
        expect(state.size()).toBe(1);
        state.terminal(identity, { reason: 'destroyed' }); await settle();
      }
      expect(finished).toHaveLength(1);
      expect(notified).toBe(timing === 'after' ? 1 : 0);
      expect(state.size()).toBe(0);
    });
  }

  it('lets an exact terminal buffered during timeout notification win after the ACK', async () => {
    const ack = deferred(); const finished: unknown[] = []; let notified = 0;
    const state = createState({ limit: 4, ttlMs: 60_000,
      setTimeout: () => 1, clearTimeout: () => {}, notify: () => { notified += 1; return ack.promise; },
      finish: (_entry: unknown, terminal: unknown) => { finished.push(terminal); },
    });
    expect(state.register(identity)).toBe(true);
    expect(state.timedOut(identity)).toBe(true);
    await Promise.resolve();
    expect(notified).toBe(1);
    expect(state.terminal(identity, { reason: 'document_replaced' })).toBe(true);
    expect(finished).toEqual([]);
    ack.resolve(); await settle();
    expect(finished).toEqual([{ reason: 'document_replaced', durationMs: 0 }]);
    expect(state.size()).toBe(0);
  });

  it('retains post-submission ambiguity through a lost provider ACK until the exact terminal', async () => {
    const finished: unknown[] = []; let unknown = 0;
    const state = createState({ limit: 4, ttlMs: 60_000,
      setTimeout: () => 1, clearTimeout: () => {}, notify: () => Promise.resolve(),
      unknown: (_entry: unknown, durationMs: number) => {
        unknown += 1; expect(durationMs).toBe(17); return Promise.reject(new Error('ACK lost'));
      },
      release: (entry: unknown) => { finished.push(entry); },
      finish: (_entry: unknown, terminal: unknown) => { finished.push(terminal); },
    });
    expect(state.register(identity)).toBe(true);
    expect(state.unknownPending(identity, 17)).toBe(true);
    await settle();
    expect(unknown).toBe(1);
    expect(state.size()).toBe(1);
    expect(state.complete(identity)).toBe(false);
    expect(state.terminal(identity, { reason: 'completed' })).toBe(true);
    await settle();
    expect(finished).toHaveLength(1);
    expect(state.size()).toBe(0);
    expect(state.terminal(identity, { reason: 'completed' })).toBe(false);
  });

  for (const reason of ['completed', 'document_replaced'] as const) for (const order of ['terminal-first', 'unknown-first'] as const) {
    it(`fixes one unknown receipt before exact ${reason} release when ${order}`, async () => {
      const unknownAck = deferred(); const released: unknown[] = []; let unknown = 0; let timedOut = 0;
      const state = createState({ limit: 4, ttlMs: 60_000,
        setTimeout: () => 1, clearTimeout: () => {},
        notify: () => { timedOut += 1; return Promise.resolve(); },
        unknown: () => { unknown += 1; return unknownAck.promise; },
        release: (entry: unknown) => { released.push(entry); },
        finish: (_entry: unknown, terminal: unknown) => { released.push(terminal); },
      });
      expect(state.register(identity)).toBe(true);
      if (order === 'terminal-first') expect(state.terminal(identity, { reason })).toBe(true);
      expect(state.unknownPending(identity, 3)).toBe(true);
      if (order === 'unknown-first') expect(state.terminal(identity, { reason })).toBe(true);
      await Promise.resolve();
      expect(unknown).toBe(1);
      expect(timedOut).toBe(0);
      expect(released).toEqual([]);
      expect(state.size()).toBe(1);
      unknownAck.resolve(); await settle();
      expect(released).toHaveLength(1);
      expect(state.size()).toBe(0);
    });
  }

  for (const reason of ['document_replaced', 'destroyed'] as const) for (const order of ['terminal-first', 'unknown-first'] as const) {
    it(`confirms one ordinary unknown before exact ${reason} release when ${order}`, async () => {
      const ack = deferred(); const confirmed: any[] = []; const finished: unknown[] = []; let timedOut = 0;
      const state = createState({ limit: 4, ttlMs: 60_000,
        setTimeout: () => 1, clearTimeout: () => {},
        notify: () => { timedOut += 1; return Promise.resolve(); },
        confirmUnknown: (_entry: unknown, completion: unknown) => { confirmed.push(completion); return ack.promise; },
        release: () => { finished.push('release'); }, finish: () => { finished.push('finish'); },
      });
      expect(state.register(identity)).toBe(true);
      if (order === 'terminal-first') expect(state.terminal(identity, { reason, durationMs: 17 })).toBe(true);
      expect(state.completeUnknown(identity, { durationMs: 17, message: 'replacement confirmed' })).toBe(true);
      if (order === 'unknown-first') expect(state.terminal(identity, { reason, durationMs: 17 })).toBe(true);
      await Promise.resolve();
      expect(confirmed).toEqual([{ durationMs: 17, message: 'replacement confirmed' }]);
      expect(timedOut).toBe(0);
      expect(finished).toEqual([]);
      expect(state.size()).toBe(1);
      ack.resolve(); await settle();
      expect(finished).toEqual([]);
      expect(state.size()).toBe(0);
    });
  }

  it('suppresses late success behind a buffered replacement without rewriting its outcome', async () => {
    let confirmed = 0;
    const state = createState({ limit: 4, ttlMs: 60_000,
      setTimeout: () => 1, clearTimeout: () => {}, notify: () => Promise.resolve(),
      confirmUnknown: () => { confirmed += 1; return Promise.resolve(); }, finish: () => Promise.resolve(),
    });
    expect(state.register(identity)).toBe(true);
    expect(state.terminal(identity, { reason: 'document_replaced', durationMs: 4 })).toBe(true);
    expect(state.complete(identity)).toBe(false);
    await settle();
    expect(confirmed).toBe(0);
    expect(state.size()).toBe(1);
  });

  it('retains a failed ordinary unknown ACK only until its bounded timer and leaves another tab usable', async () => {
    const timers: Array<() => void> = [];
    const state = createState({ limit: 4, ttlMs: 60_000,
      setTimeout: (callback: () => void, ms: number) => {
        expect(ms).toBe(60_000); timers.push(callback); return timers.length;
      }, clearTimeout: () => {},
      notify: () => Promise.resolve(), confirmUnknown: () => Promise.reject(new Error('provider disconnected')),
      finish: () => Promise.resolve(),
    });
    const other = { ...identity, requestId: 'request-2', invocationId: 'request-2', tabId: 'tab-2' };
    expect(state.register(identity)).toBe(true);
    expect(state.register(other)).toBe(true);
    expect(state.terminal(identity, { reason: 'destroyed', durationMs: 9 })).toBe(true);
    expect(state.completeUnknown(identity, { durationMs: 9, message: 'destroyed' })).toBe(true);
    await settle();
    expect(state.size()).toBe(2);
    expect(state.complete(other)).toBe(true);
    expect(state.size()).toBe(1);
    timers.at(-1)!();
    expect(state.size()).toBe(0);
  });

  it('caps exact entries, rejects overwrites, expires them, and clears lifecycle scopes', () => {
    const timers: Array<() => void> = []; const cleared: unknown[] = [];
    const state = createState({ limit: 2, ttlMs: 60_000,
      setTimeout: (callback: () => void, ms: number) => { expect(ms).toBeLessThanOrEqual(60_000); timers.push(callback); return timers.length; },
      clearTimeout: (timer: unknown) => { cleared.push(timer); }, notify: () => Promise.resolve(), finish: () => Promise.resolve(),
    });
    const second = { ...identity, requestId: 'request-2', invocationId: 'request-2', generation: 8 };
    const third = { ...identity, requestId: 'request-3', invocationId: 'request-3', tabId: 'tab-2' };
    expect(state.register(identity)).toBe(true);
    expect(state.register(identity)).toBe(false);
    expect(state.register(second)).toBe(true);
    expect(state.register(third)).toBe(false);
    state.clearProject('/project');
    expect(state.size()).toBe(0);
    expect(cleared).toHaveLength(2);
    expect(state.register(third)).toBe(true);
    state.clearTab('tab-2');
    expect(state.size()).toBe(0);
    expect(state.register(identity)).toBe(true);
    timers.at(-1)!();
    expect(state.size()).toBe(0);
  });

  it('does not let another request or reconnect generation consume a terminal', async () => {
    const finished: unknown[] = [];
    const state = createState({ limit: 4, ttlMs: 60_000, setTimeout: () => 1, clearTimeout: () => {},
      notify: () => Promise.resolve(), finish: (entry: unknown) => { finished.push(entry); },
    });
    expect(state.register(identity)).toBe(true);
    expect(state.timedOut(identity)).toBe(true); await settle();
    expect(state.terminal({ ...identity, requestId: 'other', invocationId: 'other' }, 'old')).toBe(false);
    expect(state.terminal({ ...identity, generation: 8 }, 'old generation')).toBe(false);
    expect(state.terminal({ ...identity, documentToken: 'prior-document' }, 'old document')).toBe(false);
    expect(finished).toEqual([]);
    expect(state.terminal(identity, { reason: 'destroyed' })).toBe(true); await settle();
    expect(finished).toHaveLength(1);
  });

  it('includes documentToken in native terminal event identity', () => {
    expect(main).toMatch(/browser:script-terminal[\s\S]*documentToken:\s*payload\.documentToken/);
    expect(main).toMatch(/browser:script-unknown-pending[\s\S]*documentToken:\s*payload\.documentToken/);
  });

  it('reports native replacement ambiguity as an unknown terminal', () => {
    const handler = functionSource(main, 'handleBrowserProviderEffect');
    const ordinaryUnknown = handler.indexOf('code === "effect_unknown"');
    const exactCompletion = handler.indexOf('browserScriptTimeoutState.completeUnknown(scriptIdentity', ordinaryUnknown);
    const genericCompletion = handler.indexOf('browserScriptTimeoutState.complete(scriptIdentity)', ordinaryUnknown);
    expect(ordinaryUnknown).toBeGreaterThan(-1);
    expect(exactCompletion).toBeGreaterThan(ordinaryUnknown);
    expect(exactCompletion).toBeLessThan(genericCompletion);
    expect(main).toMatch(/confirmUnknown:[\s\S]*status:\s*"unknown"[\s\S]*code:\s*"effect_unknown"/);
  });

  it('retains a fence for explicit native timeout or post-submission ambiguity', () => {
    expect(main).toMatch(/code === "action_timeout" && error && error\.pending === true/);
    expect(main).toMatch(/code === "unknown_pending" && error && error\.pending === true/);
    expect(main).toMatch(/runtimeError\.pending = result\.pending === true/);
  });

  it('does not publish script success after replacement terminalization', () => {
    expect(main.match(/if \(scriptIdentity && !browserScriptTimeoutState\.complete\(scriptIdentity\)\) return/g))
      .toHaveLength(2);
  });

  it('wires cleanup to provider replacement, disconnect, project stop, and tab destruction', () => {
    expect(main).toMatch(/function resetBrowserControlProvider[\s\S]*clearProject\(projectRoot\)/);
    expect(main).toMatch(/control:provider-disconnected[\s\S]*clearProject\(payload\.projectRoot\)/);
    expect(main).toMatch(/control_provider_stop[\s\S]*resetBrowserControlProvider\(project\.root\)/);
    expect(main).toMatch(/function closeBrowserTab[\s\S]*clearTab\(tab\.id\)/);
    expect(main).toMatch(/function closeBrowserPane[\s\S]*clearTab\(tab\.id\)/);
    expect(main).toMatch(/payload\.phase === "started"[\s\S]*terminalTab/);
    const closeTab = functionSource(main, 'closeBrowserTab');
    expect(closeTab.indexOf('terminalTab(tab.id')).toBeGreaterThan(closeTab.indexOf('browser_destroy'));
    expect(closeTab.indexOf('terminalTab(tab.id')).toBeLessThan(closeTab.indexOf('removeBrowserResource'));
    const closePane = functionSource(main, 'closeBrowserPane');
    const terminalizeDestroyed = closePane.lastIndexOf('terminalizeConfirmedDestroyedBrowserScripts(destroyed)');
    expect(terminalizeDestroyed).toBeGreaterThan(closePane.indexOf('browser_destroy_many'));
    expect(terminalizeDestroyed).toBeLessThan(closePane.indexOf('recoverAffectedLiveTabs(destroyed'));
    expect(closePane).toContain('terminalTab(savedTab.id, savedTab.controlGeneration');
  });
});
