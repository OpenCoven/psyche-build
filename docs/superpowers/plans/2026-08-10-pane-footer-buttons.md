# Physical Pane Footer Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixed, interactive metadata rail to every physical canvas pane and populate the current Coven agent path with an exact session ID plus trustworthy local session totals.

**Architecture:** Keep pane rendering in the existing unbundled Tauri web client, but move footer ordering and responsive-collapse rules into a small pure pane module. Generate the Coven engine session UUID before launch, pass it through `coven code --session-id`, and add one scoped Rust command that runs the local engine's machine-readable stats command for that exact session. The UI polls only visible agent panes, rejects stale generations, and renders unreported model/context fields honestly until a provider exposes them.

**Tech Stack:** Tauri 2, Rust, plain browser JavaScript/CSS, xterm.js, Vitest, pnpm, `@tauri-apps/plugin-clipboard-manager`, `@tauri-apps/plugin-opener`.

---

## Scope boundary

This plan ships the complete footer UI and real metrics for the agent path the
macOS app currently launches: Coven Code. It also establishes the normalized
provider contract used by later adapters.

Copilot, Codex, Claude, and Grok telemetry are not added here because the
current checkout does not launch those agents yet. Their structured telemetry
depends on the separate terminal/agent-launch plan and, for Copilot/Codex/Grok,
on ACP or app-server process ownership rather than the current interactive PTY
contract. Implement those adapters only after
`docs/superpowers/plans/2026-08-10-terminal-agent-shortcuts.md`; do not add
unused provider parsers to this change.

## File map

- Create `native/macos/psyche-build-tauri/web/panes/pane-footer.mjs`
  - Own footer item normalization, value formatting, pane-width tiers, and
    stale-response guards.
- Create `native/macos/psyche-build-tauri/web/panes/pane-footer.d.mts`
  - Document the browser module's normalized footer and metrics contracts.
- Modify `native/macos/psyche-build-tauri/web/panes/pane-entry.js`
  - Export the footer helpers through the existing `PsychePanes` bundle.
- Create `__tests__/tauriPaneFooter.test.ts`
  - Unit-test the pure footer model and contract-test pane mounting/actions.
- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Mount and synchronize the rail, wire copy/reveal/popover actions, generate
    Coven session IDs, poll visible agent panes, and reject stale results.
- Modify `native/macos/psyche-build-tauri/web/styles.css`
  - Add the fixed third pane row, physical button styling, responsive tiers,
    overflow menu, and usage popover.
- Modify `native/macos/psyche-build-tauri/package.json`
  - Add the clipboard-manager JavaScript plugin.
- Modify `native/macos/psyche-build-tauri/src-tauri/Cargo.toml`
  - Add the clipboard-manager Rust plugin.
- Modify `native/macos/psyche-build-tauri/src-tauri/capabilities/default.json`
  - Allow clipboard writes and item reveal.
- Create `native/macos/psyche-build-tauri/src-tauri/src/pane_metrics.rs`
  - Parse and load exact Coven session totals from `coven code stats ... --json`.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
  - Register the metrics module/command, initialize clipboard support, and
    validate the exact session-ID Coven launch.
- Modify `__tests__/tauriCovenLaunch.test.ts`
  - Lock the app-generated session ID and new `coven code --session-id` launch.
- Modify `__tests__/tauriWorkspacePanels.test.ts`
  - Lock plugin registration, command registration, and browser-body bounds.
- Regenerate `native/macos/psyche-build-tauri/web/panes.bundle.js`
  - Include the new footer helpers in the checked-in browser bundle.
- Modify `pnpm-lock.yaml`
  - Record the clipboard-manager dependency.

### Task 1: Build the pure footer model

**Files:**
- Create: `native/macos/psyche-build-tauri/web/panes/pane-footer.mjs`
- Create: `native/macos/psyche-build-tauri/web/panes/pane-footer.d.mts`
- Modify: `native/macos/psyche-build-tauri/web/panes/pane-entry.js`
- Create: `__tests__/tauriPaneFooter.test.ts`

- [ ] **Step 1: Write failing footer-model tests**

Create `__tests__/tauriPaneFooter.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const footerModule = await import(pathToFileURL(join(
  repoRoot,
  'native/macos/psyche-build-tauri/web/panes/pane-footer.mjs',
)).href);

const {
  FOOTER_TIERS,
  footerItems,
  footerTier,
  formatContext,
  formatSpend,
  hiddenFooterKeys,
  shouldApplyMetricsResponse,
} = footerModule;

describe('pane footer model', () => {
  it('uses only core controls for terminal and Web panes', () => {
    const base = {
      branch: 'feat/footer',
      worktreeLabel: 'footer-pane',
      worktreePath: '/repo/.worktrees/footer-pane',
      paneId: 'thread-1',
    };
    expect(footerItems({ ...base, kind: 'shell' }).map((item: { key: string }) => item.key))
      .toEqual(['branch', 'worktree', 'pane']);
    expect(footerItems({ ...base, kind: 'web' }).map((item: { key: string }) => item.key))
      .toEqual(['branch', 'worktree', 'pane']);
  });

  it('orders agent controls branch, worktree, model, session, context, spend', () => {
    const items = footerItems({
      kind: 'coven-chat',
      branch: 'feat/footer',
      worktreeLabel: 'footer-pane',
      worktreePath: '/repo/.worktrees/footer-pane',
      paneId: 'thread-1',
      metrics: {
        phase: 'ready',
        provider: 'coven',
        sessionId: 'session-1',
        model: null,
        contextUsed: null,
        contextLimit: null,
        spendUsd: 0.375,
        updatedAt: '2026-08-10T20:00:00Z',
        stale: false,
        error: null,
      },
    });
    expect(items.map((item: { key: string }) => item.key)).toEqual([
      'branch', 'worktree', 'model', 'session', 'context', 'spend',
    ]);
    expect(items.find((item: { key: string }) => item.key === 'model').value).toBe('—');
    expect(items.find((item: { key: string }) => item.key === 'context').value).toBe('—');
    expect(items.find((item: { key: string }) => item.key === 'spend').value).toBe('$0.38');
  });

  it('uses deterministic pane-width tiers', () => {
    expect(footerTier(760)).toBe(FOOTER_TIERS.FULL);
    expect(footerTier(650)).toBe(FOOTER_TIERS.NO_SESSION);
    expect(footerTier(570)).toBe(FOOTER_TIERS.NO_SPEND);
    expect(footerTier(490)).toBe(FOOTER_TIERS.NO_CONTEXT);
    expect(footerTier(410)).toBe(FOOTER_TIERS.CORE);
    expect(footerTier(280)).toBe(FOOTER_TIERS.COMPACT);
  });

  it('moves only collapsed controls into overflow', () => {
    expect(hiddenFooterKeys(FOOTER_TIERS.FULL, true)).toEqual([]);
    expect(hiddenFooterKeys(FOOTER_TIERS.NO_SESSION, true)).toEqual(['session']);
    expect(hiddenFooterKeys(FOOTER_TIERS.NO_SPEND, true)).toEqual(['session', 'spend']);
    expect(hiddenFooterKeys(FOOTER_TIERS.NO_CONTEXT, true))
      .toEqual(['session', 'spend', 'context']);
    expect(hiddenFooterKeys(FOOTER_TIERS.CORE, true))
      .toEqual(['session', 'spend', 'context', 'model']);
    expect(hiddenFooterKeys(FOOTER_TIERS.COMPACT, false)).toEqual(['pane']);
  });

  it('formats only real context and spend values', () => {
    expect(formatContext(42_000, 100_000)).toBe('42%');
    expect(formatContext(null, 100_000)).toBe('—');
    expect(formatContext(42_000, null)).toBe('—');
    expect(formatSpend(0)).toBe('$0.00');
    expect(formatSpend(1.256)).toBe('$1.26');
    expect(formatSpend(null)).toBe('—');
  });

  it('rejects metrics from an old generation or session binding', () => {
    const thread = {
      id: 'thread-1',
      metricsGeneration: 4,
      launch: { covenSessionId: 'session-new' },
    };
    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-1', generation: 4, sessionId: 'session-new',
    })).toBe(true);
    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-1', generation: 3, sessionId: 'session-new',
    })).toBe(false);
    expect(shouldApplyMetricsResponse(thread, {
      threadId: 'thread-1', generation: 4, sessionId: 'session-old',
    })).toBe(false);
  });
});

const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);

describe('pane footer integration contract', () => {
  it('mounts one footer in terminal and Web panes', () => {
    expect(mainJs).toMatch(/function createPaneFooter\(thread\)/);
    expect(mainJs).toMatch(/function mountTerminal\(thread\)[\s\S]*createPaneFooter\(thread\)/);
    expect(mainJs).toMatch(/function mountBrowserPane\(thread\)[\s\S]*createPaneFooter\(thread\)/);
  });

  it('uses a fixed third pane row without wrapping', () => {
    expect(stylesCss).toMatch(
      /\.terminal-pane\s*\{[\s\S]*grid-template-rows:\s*var\(--pane-head-h\)\s+minmax\(0,\s*1fr\)\s+27px/,
    );
    expect(stylesCss).toMatch(/\.terminal-pane-footer\s*\{[\s\S]*flex-wrap:\s*nowrap/);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneFooter.test.ts
```

Expected: FAIL because `pane-footer.mjs` and the integration functions do not
exist.

- [ ] **Step 3: Implement the pure footer model**

Create `native/macos/psyche-build-tauri/web/panes/pane-footer.mjs`:

```js
export const FOOTER_TIERS = Object.freeze({
  FULL: 'full',
  NO_SESSION: 'no-session',
  NO_SPEND: 'no-spend',
  NO_CONTEXT: 'no-context',
  CORE: 'core',
  COMPACT: 'compact',
});

export function isAgentPaneKind(kind) {
  return kind !== 'shell' && kind !== 'web';
}

export function footerTier(width) {
  if (width >= 720) return FOOTER_TIERS.FULL;
  if (width >= 620) return FOOTER_TIERS.NO_SESSION;
  if (width >= 540) return FOOTER_TIERS.NO_SPEND;
  if (width >= 460) return FOOTER_TIERS.NO_CONTEXT;
  if (width >= 380) return FOOTER_TIERS.CORE;
  return FOOTER_TIERS.COMPACT;
}

export function hiddenFooterKeys(tier, isAgent) {
  if (!isAgent) return tier === FOOTER_TIERS.COMPACT ? ['pane'] : [];
  if (tier === FOOTER_TIERS.NO_SESSION) return ['session'];
  if (tier === FOOTER_TIERS.NO_SPEND) return ['session', 'spend'];
  if (tier === FOOTER_TIERS.NO_CONTEXT) return ['session', 'spend', 'context'];
  if (tier === FOOTER_TIERS.CORE || tier === FOOTER_TIERS.COMPACT) {
    return ['session', 'spend', 'context', 'model'];
  }
  return [];
}

export function formatContext(used, limit) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return '—';
  return `${Math.max(0, Math.min(100, Math.round((used / limit) * 100)))}%`;
}

export function formatSpend(value) {
  return Number.isFinite(value) && value >= 0 ? `$${value.toFixed(2)}` : '—';
}

function metricValue(metrics, key, formatter) {
  if (!metrics || metrics.phase === 'idle' || metrics.phase === 'loading') return '…';
  return formatter(metrics[key]);
}

export function footerItems(state) {
  const core = [
    {
      key: 'branch',
      label: 'Branch',
      value: state.branch || 'detached',
      fullValue: state.branch || 'detached',
      action: 'copy',
    },
    {
      key: 'worktree',
      label: 'Worktree',
      value: state.worktreeLabel || state.worktreePath || 'worktree',
      fullValue: state.worktreePath || '',
      action: 'reveal',
    },
  ];

  if (!isAgentPaneKind(state.kind)) {
    return core.concat([{
      key: 'pane',
      label: 'Pane ID',
      value: state.paneId,
      fullValue: state.paneId,
      action: 'copy',
    }]);
  }

  const metrics = state.metrics;
  return core.concat([
    {
      key: 'model',
      label: 'Model',
      value: metricValue(metrics, 'model', (value) => value || '—'),
      fullValue: metrics?.model || '',
      action: metrics?.canSwitchModel ? 'switch-model' : 'usage',
    },
    {
      key: 'session',
      label: 'Session ID',
      value: metricValue(metrics, 'sessionId', (value) => value ? value.slice(0, 8) : '—'),
      fullValue: metrics?.sessionId || '',
      action: 'copy',
    },
    {
      key: 'context',
      label: 'Context',
      value: metrics?.phase === 'loading'
        ? '…'
        : formatContext(metrics?.contextUsed, metrics?.contextLimit),
      fullValue: Number.isFinite(metrics?.contextUsed) && Number.isFinite(metrics?.contextLimit)
        ? `${metrics.contextUsed} / ${metrics.contextLimit} tokens`
        : '',
      action: 'usage',
    },
    {
      key: 'spend',
      label: 'Spend',
      value: metrics?.phase === 'loading' ? '…' : formatSpend(metrics?.spendUsd),
      fullValue: Number.isFinite(metrics?.spendUsd)
        ? `$${metrics.spendUsd.toFixed(4)}`
        : '',
      action: 'usage',
    },
  ]);
}

export function shouldApplyMetricsResponse(thread, response) {
  return Boolean(thread && response)
    && thread.id === response.threadId
    && thread.metricsGeneration === response.generation
    && thread.launch?.covenSessionId === response.sessionId;
}
```

Create `native/macos/psyche-build-tauri/web/panes/pane-footer.d.mts`:

```ts
export interface PaneMetricsState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  provider: string;
  sessionId: string | null;
  model: string | null;
  contextUsed: number | null;
  contextLimit: number | null;
  spendUsd: number | null;
  cumulativeInputTokens?: number | null;
  cumulativeOutputTokens?: number | null;
  updatedAt: string | null;
  stale: boolean;
  error: string | null;
  canSwitchModel?: boolean;
}

export interface PaneFooterInput {
  kind: string;
  branch: string | null;
  worktreeLabel: string;
  worktreePath: string;
  paneId: string;
  metrics?: PaneMetricsState | null;
}

export interface PaneFooterItem {
  key: string;
  label: string;
  value: string;
  fullValue: string;
  action: 'copy' | 'reveal' | 'usage' | 'switch-model';
}

export const FOOTER_TIERS: Readonly<Record<string, string>>;
export function isAgentPaneKind(kind: string): boolean;
export function footerTier(width: number): string;
export function hiddenFooterKeys(tier: string, isAgent: boolean): string[];
export function formatContext(used: number | null, limit: number | null): string;
export function formatSpend(value: number | null): string;
export function footerItems(state: PaneFooterInput): PaneFooterItem[];
export function shouldApplyMetricsResponse(
  thread: {
    id: string;
    metricsGeneration: number;
    launch?: { covenSessionId?: string | null };
  },
  response: { threadId: string; generation: number; sessionId: string },
): boolean;
```

Append these exports to
`native/macos/psyche-build-tauri/web/panes/pane-entry.js`:

```js
export {
  FOOTER_TIERS,
  footerItems,
  footerTier,
  formatContext,
  formatSpend,
  hiddenFooterKeys,
  isAgentPaneKind,
  shouldApplyMetricsResponse,
} from "./pane-footer.mjs";
```

- [ ] **Step 4: Run the pure tests**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneFooter.test.ts
```

Expected: the model tests PASS and the integration-contract tests still FAIL
because pane mounting and CSS are not implemented.

- [ ] **Step 5: Commit the model**

```bash
git add \
  __tests__/tauriPaneFooter.test.ts \
  native/macos/psyche-build-tauri/web/panes/pane-footer.mjs \
  native/macos/psyche-build-tauri/web/panes/pane-footer.d.mts \
  native/macos/psyche-build-tauri/web/panes/pane-entry.js
git commit -m "feat: add pane footer model"
```

### Task 2: Add native copy and reveal actions

**Files:**
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.toml`
- Modify: `native/macos/psyche-build-tauri/src-tauri/capabilities/default.json`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriPaneFooter.test.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add failing native-action contract tests**

Append to `__tests__/tauriPaneFooter.test.ts`:

```ts
const tauriPackage = JSON.parse(readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/package.json'),
  'utf8',
)) as { dependencies: Record<string, string> };
const cargoToml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/Cargo.toml'),
  'utf8',
);
const capability = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/capabilities/default.json'),
  'utf8',
);
const tauriLib = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);

describe('pane footer native actions', () => {
  it('registers clipboard writes and Finder reveal', () => {
    expect(tauriPackage.dependencies['@tauri-apps/plugin-clipboard-manager']).toMatch(/^2\./);
    expect(cargoToml).toMatch(/tauri-plugin-clipboard-manager\s*=\s*"2"/);
    expect(tauriLib).toMatch(/tauri_plugin_clipboard_manager::init\(\)/);
    expect(capability).toContain('clipboard-manager:allow-write-text');
    expect(capability).toContain('opener:allow-reveal-item-in-dir');
    expect(mainJs).toContain('clipboardManager.writeText');
    expect(mainJs).toContain('opener.revealItemInDir');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneFooter.test.ts
```

Expected: FAIL on missing clipboard dependency, plugin registration,
permissions, and JavaScript methods.

- [ ] **Step 3: Install the official Tauri clipboard plugin**

Run:

```bash
pnpm --filter psyche-build-tauri add @tauri-apps/plugin-clipboard-manager@^2
```

Expected: `native/macos/psyche-build-tauri/package.json` and `pnpm-lock.yaml`
change.

Add to `native/macos/psyche-build-tauri/src-tauri/Cargo.toml`:

```toml
tauri-plugin-clipboard-manager = "2"
```

In `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`, initialize it beside
the existing plugins:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_clipboard_manager::init())
```

Add these permissions to
`native/macos/psyche-build-tauri/src-tauri/capabilities/default.json`:

```json
"opener:allow-reveal-item-in-dir",
"clipboard-manager:allow-write-text"
```

- [ ] **Step 4: Add explicit JavaScript action helpers**

Near the existing Tauri globals in
`native/macos/psyche-build-tauri/web/main.js`, add:

```js
var opener = window.__TAURI__.opener || null;
var clipboardManager = window.__TAURI__.clipboardManager || null;
```

Add these helpers after `toast`:

```js
async function copyPaneFooterValue(label, value) {
  if (!value) {
    toast(label + " is not reported");
    return false;
  }
  if (!clipboardManager || typeof clipboardManager.writeText !== "function") {
    setStatus("Clipboard support is unavailable", "error");
    return false;
  }
  try {
    await clipboardManager.writeText(value);
    toast(label + " copied");
    return true;
  } catch (error) {
    setStatus("Copy failed: " + String(error), "error");
    return false;
  }
}

async function revealPaneWorktree(path) {
  if (!path) {
    setStatus("Worktree path is unavailable", "error");
    return false;
  }
  if (!opener || typeof opener.revealItemInDir !== "function") {
    setStatus("Finder reveal is unavailable", "error");
    return false;
  }
  try {
    await opener.revealItemInDir(path);
    return true;
  } catch (error) {
    setStatus("Reveal failed: " + String(error), "error");
    return false;
  }
}
```

- [ ] **Step 5: Run the native-action contract tests**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneFooter.test.ts
```

Expected: native-action tests PASS; pane-mounting tests still FAIL.

- [ ] **Step 6: Commit native actions**

```bash
git add \
  __tests__/tauriPaneFooter.test.ts \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/src-tauri/Cargo.toml \
  native/macos/psyche-build-tauri/src-tauri/capabilities/default.json \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/web/main.js \
  pnpm-lock.yaml
git commit -m "feat: add pane footer desktop actions"
```

### Task 3: Mount the physical footer rail

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriPaneFooter.test.ts`
- Modify: `__tests__/tauriPhysicalPanes.test.ts`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Add failing pane-mount and browser-bounds assertions**

Append to the integration block in `__tests__/tauriPaneFooter.test.ts`:

```ts
it('raises the minimum pane height by the footer height', () => {
  expect(mainJs).toMatch(/PANE_MINIMUMS\s*=\s*\{\s*width:\s*200,\s*height:\s*137/);
  expect(stylesCss).toContain('--pane-foot-h: 27px');
});

it('routes footer controls through one action dispatcher', () => {
  expect(mainJs).toMatch(/function runPaneFooterAction\(thread,\s*item\)/);
  expect(mainJs).toMatch(/item\.action === "copy"/);
  expect(mainJs).toMatch(/item\.action === "reveal"/);
  expect(mainJs).toMatch(/item\.action === "usage"/);
});
```

In the Web canvas pane block of
`__tests__/tauriWorkspacePanels.test.ts`, add:

```ts
it('keeps native browser bounds scoped to the body above the footer', () => {
  expect(mainJs).toMatch(/thread\.browserBody = body/);
  expect(mainJs).toMatch(/function visibleBrowserBounds\(\)[\s\S]*thread\.browserBody/);
  expect(stylesCss).toMatch(/\.terminal-pane\.is-web \.terminal-pane-body/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: FAIL because the footer DOM, third grid row, and new minimum height do
not exist.

- [ ] **Step 3: Add footer state and action helpers**

Add after `threadLaneLabel` in `web/main.js`:

```js
function threadWorktree(thread) {
  var project = thread && findProject(thread.projectId);
  var worktrees = (project && project.worktrees) || [];
  return worktrees.find(function (worktree) {
    return worktree.path === thread.worktreePath;
  }) || {
    path: (thread && thread.worktreePath) || "",
    branch: null,
  };
}

function paneFooterState(thread) {
  var worktree = threadWorktree(thread);
  var isAgent = PsychePanes.isAgentPaneKind(thread.kind);
  var fallbackMetrics = isAgent ? {
    phase: "ready",
    provider: thread.launch && thread.launch.metricsProvider || "agent",
    sessionId: thread.launch && thread.launch.covenSessionId || null,
    model: null,
    contextUsed: null,
    contextLimit: null,
    cumulativeInputTokens: null,
    cumulativeOutputTokens: null,
    spendUsd: null,
    costKind: "unknown",
    updatedAt: null,
    stale: false,
    error: "Session metrics are not reported by this harness",
    canSwitchModel: false,
  } : null;
  return {
    kind: thread.kind || "shell",
    branch: worktree.branch || null,
    worktreeLabel: worktree.branch || shortenRoot(worktree.path),
    worktreePath: worktree.path,
    paneId: thread.id,
    metrics: thread.metrics || fallbackMetrics,
  };
}

function runPaneFooterAction(thread, item) {
  if (item.action === "copy") {
    return copyPaneFooterValue(item.label, item.fullValue);
  }
  if (item.action === "reveal") {
    return revealPaneWorktree(item.fullValue);
  }
  if (item.action === "usage") {
    openPaneUsagePopover(thread);
    return Promise.resolve(true);
  }
  if (item.action === "switch-model") {
    openPaneUsagePopover(thread);
    return Promise.resolve(true);
  }
  return Promise.resolve(false);
}
```

Add the footer renderer:

```js
function createPaneFooter(thread) {
  var footer = document.createElement("footer");
  footer.className = "terminal-pane-footer";
  footer.dataset.tier = PsychePanes.footerTier(720);
  footer.setAttribute("aria-label", thread.name + " pane details");

  var items = document.createElement("div");
  items.className = "terminal-pane-footer-items";
  footer.appendChild(items);

  var overflow = document.createElement("button");
  overflow.type = "button";
  overflow.className = "terminal-pane-footer-overflow";
  overflow.textContent = "•••";
  overflow.title = "More pane details";
  overflow.setAttribute("aria-label", "More pane details");
  overflow.setAttribute("aria-haspopup", "menu");
  overflow.addEventListener("click", function (event) {
    event.stopPropagation();
    openPaneFooterOverflow(thread, overflow);
  });
  footer.appendChild(overflow);

  footer.addEventListener("pointerdown", function (event) {
    event.stopPropagation();
    if (state.activeThreadId !== thread.id) focusThread(thread.id);
  });

  thread.paneFooter = footer;
  thread.paneFooterItems = items;
  thread.paneFooterOverflow = overflow;
  return footer;
}

function syncPaneFooter(thread) {
  if (!thread || !thread.paneFooterItems) return;
  var footerItems = PsychePanes.footerItems(paneFooterState(thread));
  thread.paneFooterItems.replaceChildren();
  footerItems.forEach(function (item) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "terminal-pane-footer-btn item-" + item.key;
    button.dataset.footerKey = item.key;
    button.title = item.fullValue
      ? item.label + ": " + item.fullValue
      : item.label + ": not reported";
    button.setAttribute("aria-label", button.title);
    button.textContent = item.value;
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      runPaneFooterAction(thread, item);
    });
    thread.paneFooterItems.appendChild(button);
  });
}
```

When mounting terminal and Web panes, append footer after body:

```js
var footer = createPaneFooter(thread);
pane.appendChild(header);
pane.appendChild(body);
pane.appendChild(footer);
```

Store and disconnect one `ResizeObserver` per pane:

```js
if (typeof ResizeObserver === "function") {
  thread.paneFooterResize = new ResizeObserver(function (entries) {
    var width = entries[0] ? entries[0].contentRect.width : pane.clientWidth;
    footer.dataset.tier = PsychePanes.footerTier(width);
  });
  thread.paneFooterResize.observe(pane);
}
```

Call `syncPaneFooter(thread)` from `syncThreadPaneMetadata`. In
`detachThreadPane`, disconnect `thread.paneFooterResize` before removing the
pane.

- [ ] **Step 4: Add fixed footer styles**

In `web/styles.css`, add:

```css
:root {
  --pane-foot-h: 27px;
}

.terminal-pane {
  grid-template-rows:
    var(--pane-head-h)
    minmax(0, 1fr)
    var(--pane-foot-h);
}

.terminal-pane-footer {
  display: flex;
  flex-wrap: nowrap;
  min-width: 0;
  min-height: var(--pane-foot-h);
  overflow: hidden;
  border-top: 1px solid var(--border);
  background: rgba(var(--rgb-s2), calc(var(--bg-opacity) * 0.62));
  container-type: inline-size;
}

.terminal-pane-footer-items {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.terminal-pane-footer-btn,
.terminal-pane-footer-overflow {
  min-width: 0;
  height: 100%;
  padding: 0 7px;
  overflow: hidden;
  border: 0;
  border-right: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-pane-footer-btn:hover,
.terminal-pane-footer-overflow:hover,
.terminal-pane-footer-btn:focus-visible,
.terminal-pane-footer-overflow:focus-visible {
  background: var(--surface-3);
  color: var(--text);
}

.terminal-pane-footer-btn:active,
.terminal-pane-footer-overflow:active {
  background: var(--accent-soft);
  color: var(--accent);
}

.terminal-pane-footer-btn.item-branch,
.terminal-pane-footer-btn.item-worktree {
  flex: 1 1 120px;
}

.terminal-pane-footer-btn.item-model,
.terminal-pane-footer-btn.item-session,
.terminal-pane-footer-btn.item-context,
.terminal-pane-footer-btn.item-spend,
.terminal-pane-footer-btn.item-pane {
  flex: 0 1 auto;
}

.terminal-pane-footer-overflow {
  display: none;
  flex: 0 0 28px;
  border-right: 0;
  padding: 0;
}

.terminal-pane-footer[data-tier="no-session"] .item-session,
.terminal-pane-footer[data-tier="no-spend"] .item-session,
.terminal-pane-footer[data-tier="no-context"] .item-session,
.terminal-pane-footer[data-tier="core"] .item-session,
.terminal-pane-footer[data-tier="compact"] .item-session,
.terminal-pane-footer[data-tier="no-spend"] .item-spend,
.terminal-pane-footer[data-tier="no-context"] .item-spend,
.terminal-pane-footer[data-tier="core"] .item-spend,
.terminal-pane-footer[data-tier="compact"] .item-spend,
.terminal-pane-footer[data-tier="no-context"] .item-context,
.terminal-pane-footer[data-tier="core"] .item-context,
.terminal-pane-footer[data-tier="compact"] .item-context,
.terminal-pane-footer[data-tier="core"] .item-model,
.terminal-pane-footer[data-tier="compact"] .item-model {
  display: none;
}

.terminal-pane-footer:not([data-tier="full"]) .terminal-pane-footer-overflow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.terminal-pane-footer[data-tier="compact"] .item-pane {
  display: none;
}
```

Change the JavaScript minimum:

```js
var PANE_MINIMUMS = { width: 200, height: 137, separator: 6 };
```

- [ ] **Step 5: Run the pane tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the physical rail**

```bash
git add \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat: mount physical pane footers"
```

### Task 4: Give every Coven pane an exact engine session ID

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `__tests__/tauriPaneFooter.test.ts`

- [ ] **Step 1: Replace the old Coven launch expectations**

In `__tests__/tauriCovenLaunch.test.ts`, replace expectations that require
`args: ["chat"]` and `covenSessionId: null` with:

```ts
expect(source).toMatch(/function makeCovenSessionId\(\)/);
expect(source).toMatch(/crypto\.randomUUID\(\)/);
expect(source).toMatch(
  /function covenChatLaunch\(project,\s*worktreePath\)[\s\S]*args:\s*\["code",\s*"--session-id",\s*sessionId\]/,
);
expect(source).toMatch(/covenSessionId:\s*sessionId/);
expect(libRs).toMatch(
  /Some\(\[verb,\s*session_flag,\s*session_id\]\)[\s\S]*verb == "code"[\s\S]*session_flag == "--session-id"/,
);
```

Update every Coven-chat fixture in that test file, not only the first launch
test. Use one stable safe UUID in fixtures:

```ts
const covenSessionId = '00000000-0000-4000-8000-000000000001';
const covenChatLaunch = {
  command: '/bin/coven',
  args: ['code', '--session-id', covenSessionId],
  env: {},
  projectRoot: '/repo',
  cwd: '/repo',
  launchKind: 'coven-chat',
  covenSessionId,
};
```

Replace all 25 `args: ['chat']` / `covenSessionId: null` Coven-chat fixtures
with the same shape. Keep `coven-attach` fixtures unchanged.

Append to `__tests__/tauriPaneFooter.test.ts`:

```ts
it('uses the launch-owned Coven session ID in agent footer state', () => {
  expect(mainJs).toMatch(
    /covenSessionId:\s*sessionId[\s\S]*metricsGeneration:\s*0/,
  );
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriPaneFooter.test.ts
```

Expected: FAIL because Coven still launches as `coven chat` without an exact
engine session ID.

- [ ] **Step 3: Generate and pass the UUID**

Add in `web/main.js` near `makeThreadId`:

```js
function makeCovenSessionId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  var bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = Array.prototype.map.call(bytes, function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
    "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
```

Replace `covenChatLaunch` with:

```js
function covenChatLaunch(project, worktreePath) {
  var worktree = worktreePath ? { path: worktreePath } : selectedWorktree(project);
  var sessionId = makeCovenSessionId();
  return {
    command: state.env.coven_path,
    args: ["code", "--session-id", sessionId],
    env: {},
    projectRoot: project.root,
    cwd: worktree.path,
    kind: "coven-chat",
    launchKind: "coven-chat",
    covenSessionId: sessionId,
    metricsProvider: "coven",
  };
}
```

Carry the display-only metrics provider through `createThread` without sending
it to `pty_start`. Add it to the fallback `sourceLaunch` and normalized
`launch` objects:

```js
metricsProvider: opts.metricsProvider || null,
```

```js
metricsProvider: sourceLaunch.metricsProvider || opts.metricsProvider || null,
```

When `openCovenSession` creates an attached thread, pass the discovered harness:

```js
metricsProvider: session.harness || "coven",
```

Initialize metrics fields in the thread object:

```js
metricsGeneration: 0,
metrics: null,
metricsRefreshTimer: 0,
```

- [ ] **Step 4: Tighten Rust launch validation**

In `validate_coven_launch_with`, replace the `coven-chat` branch with:

```rust
"coven-chat" => {
    let session_id = options
        .coven_session_id
        .as_deref()
        .ok_or_else(|| "coven-chat requires a session id".to_string())?;
    if !is_safe_session_id(session_id) {
        return Err("coven-chat session id is unsafe".to_string());
    }
    match options.args.as_deref() {
        Some([verb, session_flag, argument])
            if verb == "code"
                && session_flag == "--session-id"
                && argument == session_id =>
        {
            Ok(())
        }
        _ => Err(
            "coven-chat requires exactly 'code --session-id <validated-id>'".to_string(),
        ),
    }
}
```

Keep the existing `coven-attach` validation unchanged.

Update the Rust launch-validation tests in `lib.rs`:

```rust
#[test]
fn accepts_exact_native_coven_chat_and_attach_launches() {
    let coven = "/canonical/bin/coven";
    let session = "00000000-0000-4000-8000-000000000001";
    let chat = launch_options(
        Some("coven-chat"),
        Some(session),
        Some(coven),
        Some(&["code", "--session-id", session]),
    );
    let attach = launch_options(
        Some("coven-attach"),
        Some("release:fix_01.a-b"),
        Some(coven),
        Some(&["attach", "release:fix_01.a-b"]),
    );

    assert_eq!(validate_coven_launch_with(&chat, Some(coven)), Ok(()));
    assert_eq!(validate_coven_launch_with(&attach, Some(coven)), Ok(()));
}
```

Use these malformed Coven-chat cases in
`rejects_malformed_or_unresolved_native_coven_launches`:

```rust
launch_options(Some("coven-chat"), None, Some(coven), None),
launch_options(
    Some("coven-chat"),
    Some("safe"),
    Some(coven),
    Some(&["code", "--session-id", "other"]),
),
launch_options(
    Some("coven-chat"),
    Some("../unsafe"),
    Some(coven),
    Some(&["code", "--session-id", "../unsafe"]),
),
launch_options(
    Some("coven-chat"),
    Some("safe"),
    Some("/wrong/coven"),
    Some(&["code", "--session-id", "safe"]),
),
```

For the unresolved executable assertion, use:

```rust
let chat = launch_options(
    Some("coven-chat"),
    Some("safe"),
    Some(coven),
    Some(&["code", "--session-id", "safe"]),
);
assert!(validate_coven_launch_with(&chat, None).is_err());
```

- [ ] **Step 5: Run launch tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriPaneFooter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit exact session binding**

```bash
git add \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "feat: bind Coven panes to exact sessions"
```

### Task 5: Add the scoped Coven metrics command

**Files:**
- Create: `native/macos/psyche-build-tauri/src-tauri/src/pane_metrics.rs`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Add failing Rust command contracts**

In `__tests__/tauriWorkspacePanels.test.ts`, add:

```ts
it('registers a scoped pane-session metrics command', () => {
  expect(tauriLib).toContain('mod pane_metrics;');
  expect(tauriLib).toMatch(
    /fn pane_session_metrics\([\s\S]*project_root:\s*String[\s\S]*cwd:\s*String[\s\S]*session_id:\s*String/,
  );
  expect(tauriLib).toMatch(/\n\s*pane_session_metrics,/);
  expect(tauriLib).toMatch(/open_pty_cwd\(&project_root,\s*&cwd\)/);
  expect(tauriLib).toMatch(/is_safe_session_id\(&session_id\)/);
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts
```

Expected: FAIL because the module and command do not exist.

- [ ] **Step 3: Create the parser and command runner**

Create `native/macos/psyche-build-tauri/src-tauri/src/pane_metrics.rs`:

```rust
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

const MAX_STATS_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct CovenStatsOutput {
    sessions: Vec<CovenStatsSession>,
}

#[derive(Debug, Deserialize)]
struct CovenStatsSession {
    session_id: String,
    project_dir: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    cost_usd: f64,
    last_ts: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneSessionMetrics {
    pub provider: String,
    pub session_id: String,
    pub model: Option<String>,
    pub context_used: Option<u64>,
    pub context_limit: Option<u64>,
    pub cumulative_input_tokens: u64,
    pub cumulative_output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub spend_usd: Option<f64>,
    pub cost_kind: String,
    pub updated_at: Option<String>,
}

fn normalize_coven_stats(
    raw: &[u8],
    cwd: &Path,
    session_id: &str,
) -> Result<PaneSessionMetrics, String> {
    if raw.len() > MAX_STATS_BYTES {
        return Err("Coven stats response exceeded 2 MiB".to_string());
    }
    let parsed: CovenStatsOutput =
        serde_json::from_slice(raw).map_err(|_| "Coven stats returned invalid JSON".to_string())?;
    let cwd = cwd.to_string_lossy();
    let session = parsed
        .sessions
        .into_iter()
        .find(|session| session.session_id == session_id && session.project_dir == cwd)
        .ok_or_else(|| "Coven session metrics are not available yet".to_string())?;
    let spend_usd = session.cost_usd.is_finite().then_some(session.cost_usd);
    Ok(PaneSessionMetrics {
        provider: "coven".to_string(),
        session_id: session.session_id,
        model: None,
        context_used: None,
        context_limit: None,
        cumulative_input_tokens: session.input_tokens,
        cumulative_output_tokens: session.output_tokens,
        cache_creation_tokens: session.cache_creation_tokens,
        cache_read_tokens: session.cache_read_tokens,
        spend_usd,
        cost_kind: if spend_usd.is_some() {
            "local-estimate".to_string()
        } else {
            "unknown".to_string()
        },
        updated_at: session.last_ts,
    })
}

pub(crate) fn load_coven_metrics(
    coven_binary: &Path,
    cwd: &Path,
    session_id: &str,
) -> Result<PaneSessionMetrics, String> {
    let output = Command::new(coven_binary)
        .args(["code", "stats", "session", session_id, "--json"])
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("failed to run Coven stats: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "Coven stats exited nonzero".to_string()
        } else {
            message
        });
    }
    normalize_coven_stats(&output.stdout, cwd, session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_the_exact_session_only() {
        let raw = br#"{
          "sessions": [
            {
              "session_id": "other",
              "project_dir": "/repo",
              "input_tokens": 1,
              "output_tokens": 2,
              "cache_creation_tokens": 3,
              "cache_read_tokens": 4,
              "cost_usd": 0.01,
              "last_ts": "2026-08-10T19:00:00Z"
            },
            {
              "session_id": "wanted",
              "project_dir": "/repo",
              "input_tokens": 100,
              "output_tokens": 20,
              "cache_creation_tokens": 5,
              "cache_read_tokens": 40,
              "cost_usd": 0.375,
              "last_ts": "2026-08-10T20:00:00Z"
            }
          ]
        }"#;
        let metrics = normalize_coven_stats(raw, Path::new("/repo"), "wanted").unwrap();
        assert_eq!(metrics.session_id, "wanted");
        assert_eq!(metrics.cumulative_input_tokens, 100);
        assert_eq!(metrics.cumulative_output_tokens, 20);
        assert_eq!(metrics.spend_usd, Some(0.375));
        assert_eq!(metrics.cost_kind, "local-estimate");
        assert_eq!(metrics.model, None);
        assert_eq!(metrics.context_used, None);
    }

    #[test]
    fn rejects_wrong_projects_malformed_json_and_oversized_output() {
        let wrong = br#"{"sessions":[{
          "session_id":"wanted","project_dir":"/other",
          "input_tokens":0,"output_tokens":0,
          "cache_creation_tokens":0,"cache_read_tokens":0,
          "cost_usd":0.0,"last_ts":null
        }]}"#;
        assert!(normalize_coven_stats(wrong, Path::new("/repo"), "wanted").is_err());
        assert!(normalize_coven_stats(b"{", Path::new("/repo"), "wanted").is_err());
        assert!(
            normalize_coven_stats(
                &vec![b' '; MAX_STATS_BYTES + 1],
                Path::new("/repo"),
                "wanted",
            )
            .is_err()
        );
    }
}
```

- [ ] **Step 4: Register a scoped Tauri command**

At the top of `lib.rs` add:

```rust
mod pane_metrics;
use pane_metrics::PaneSessionMetrics;
```

Add the command beside the PTY commands:

```rust
#[tauri::command]
fn pane_session_metrics(
    project_root: String,
    cwd: String,
    session_id: String,
) -> Result<PaneSessionMetrics, String> {
    if !is_safe_session_id(&session_id) {
        return Err("session id is unsafe".to_string());
    }
    let resolved_cwd = open_pty_cwd(&project_root, &cwd)?;
    let coven = which_on_path("coven").ok_or_else(|| "Coven executable not found".to_string())?;
    pane_metrics::load_coven_metrics(&coven, &resolved_cwd.canonical_path, &session_id)
}
```

Register it in `tauri::generate_handler!`:

```rust
pane_session_metrics,
```

- [ ] **Step 5: Run Rust and contract tests**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts
pnpm --filter psyche-build-tauri exec cargo test pane_metrics --manifest-path src-tauri/Cargo.toml
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the metrics command**

```bash
git add \
  __tests__/tauriWorkspacePanels.test.ts \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs \
  native/macos/psyche-build-tauri/src-tauri/src/pane_metrics.rs
git commit -m "feat: load Coven pane metrics"
```

### Task 6: Poll visible agent panes and render usage details

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriPaneFooter.test.ts`

- [ ] **Step 1: Add failing polling and stale-state tests**

Append to `__tests__/tauriPaneFooter.test.ts`:

```ts
describe('pane metrics refresh contract', () => {
  it('polls visible agent panes only', () => {
    expect(mainJs).toMatch(/function threadWantsMetrics\(thread\)/);
    expect(mainJs).toMatch(
      /function threadWantsMetrics\(thread\)[\s\S]*thread\.launch\.launchKind === "coven-chat"[\s\S]*canvasThreadIds\(\)\.indexOf\(thread\.id\)/,
    );
    expect(mainJs).toMatch(/setInterval\(refreshVisiblePaneMetrics,\s*15000\)/);
  });

  it('debounces refresh after PTY output and rejects stale responses', () => {
    expect(mainJs).toMatch(/schedulePaneMetricsRefresh\(thread,\s*1200\)/);
    expect(mainJs).toMatch(/PsychePanes\.shouldApplyMetricsResponse\(thread,\s*response\)/);
  });

  it('shows exact values and unreported fields in the usage popover', () => {
    expect(mainJs).toMatch(/function openPaneUsagePopover\(thread\)/);
    expect(mainJs).toContain('Not reported by Coven');
    expect(mainJs).toContain('Local estimate');
    expect(stylesCss).toContain('.pane-usage-popover');
  });
});
```

- [ ] **Step 2: Run the footer test and verify failure**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneFooter.test.ts
```

Expected: FAIL because metrics polling and popovers do not exist.

- [ ] **Step 3: Add metrics refresh state**

Add near the pane constants:

```js
var PANE_METRICS_POLL_MS = 15000;
var paneMetricsPollTimer = 0;
```

Add:

```js
function threadWantsMetrics(thread) {
  return Boolean(thread)
    && !thread.hidden
    && thread.status !== "exited"
    && thread.launch
    && thread.launch.launchKind === "coven-chat"
    && canvasThreadIds().indexOf(thread.id) !== -1
    && thread.launch.covenSessionId;
}

function metricsErrorState(thread, error) {
  var previous = thread.metrics;
  return {
    phase: "error",
    provider: previous && previous.provider || "coven",
    sessionId: thread.launch.covenSessionId,
    model: previous && previous.model || null,
    contextUsed: previous && previous.contextUsed || null,
    contextLimit: previous && previous.contextLimit || null,
    cumulativeInputTokens: previous && previous.cumulativeInputTokens || null,
    cumulativeOutputTokens: previous && previous.cumulativeOutputTokens || null,
    spendUsd: previous && previous.spendUsd,
    costKind: previous && previous.costKind || "unknown",
    updatedAt: previous && previous.updatedAt || null,
    stale: Boolean(previous && previous.phase === "ready"),
    error: String(error),
    canSwitchModel: false,
  };
}

async function refreshPaneMetrics(thread) {
  if (!threadWantsMetrics(thread)) return false;
  thread.metricsGeneration += 1;
  var generation = thread.metricsGeneration;
  var sessionId = thread.launch.covenSessionId;
  if (!thread.metrics || thread.metrics.phase === "idle") {
    thread.metrics = {
      phase: "loading",
      provider: "coven",
      sessionId: sessionId,
      model: null,
      contextUsed: null,
      contextLimit: null,
      spendUsd: null,
      updatedAt: null,
      stale: false,
      error: null,
      canSwitchModel: false,
    };
    syncPaneFooter(thread);
  }
  try {
    var metrics = await invoke("pane_session_metrics", {
      projectRoot: thread.launch.projectRoot,
      project_root: thread.launch.projectRoot,
      cwd: thread.worktreePath,
      sessionId: sessionId,
      session_id: sessionId,
    });
    var response = {
      threadId: thread.id,
      generation: generation,
      sessionId: metrics.sessionId,
    };
    if (!PsychePanes.shouldApplyMetricsResponse(thread, response)) return false;
    thread.metrics = {
      phase: "ready",
      provider: metrics.provider,
      sessionId: metrics.sessionId,
      model: metrics.model,
      contextUsed: metrics.contextUsed,
      contextLimit: metrics.contextLimit,
      cumulativeInputTokens: metrics.cumulativeInputTokens,
      cumulativeOutputTokens: metrics.cumulativeOutputTokens,
      spendUsd: metrics.spendUsd,
      costKind: metrics.costKind,
      updatedAt: metrics.updatedAt,
      stale: false,
      error: null,
      canSwitchModel: false,
    };
    syncPaneFooter(thread);
    return true;
  } catch (error) {
    if (thread.metricsGeneration !== generation) return false;
    thread.metrics = metricsErrorState(thread, error);
    syncPaneFooter(thread);
    return false;
  }
}

function schedulePaneMetricsRefresh(thread, delay) {
  if (!threadWantsMetrics(thread)) return;
  if (thread.metricsRefreshTimer) clearTimeout(thread.metricsRefreshTimer);
  thread.metricsRefreshTimer = setTimeout(function () {
    thread.metricsRefreshTimer = 0;
    refreshPaneMetrics(thread);
  }, delay);
}

function refreshVisiblePaneMetrics() {
  state.threads.forEach(function (thread) {
    if (threadWantsMetrics(thread)) refreshPaneMetrics(thread);
  });
}
```

After handling PTY bytes, add:

```js
schedulePaneMetricsRefresh(thread, 1200);
```

Start polling in `boot` after existing polling starts:

```js
if (paneMetricsPollTimer) clearInterval(paneMetricsPollTimer);
paneMetricsPollTimer = setInterval(refreshVisiblePaneMetrics, PANE_METRICS_POLL_MS);
refreshVisiblePaneMetrics();
```

Clear `thread.metricsRefreshTimer` when closing a thread.

- [ ] **Step 4: Add usage and overflow popovers**

Add:

```js
function closePaneFooterPopovers() {
  document.querySelectorAll(".pane-footer-popover").forEach(function (popover) {
    popover.remove();
  });
}

function paneUsageRow(label, value) {
  var row = document.createElement("div");
  row.className = "pane-usage-row";
  var key = document.createElement("span");
  key.textContent = label;
  var detail = document.createElement("strong");
  detail.textContent = value;
  row.appendChild(key);
  row.appendChild(detail);
  return row;
}

function positionPaneFooterPopover(popover, anchor) {
  document.body.appendChild(popover);
  var rect = anchor.getBoundingClientRect();
  var width = Math.min(320, window.innerWidth - 16);
  popover.style.width = width + "px";
  popover.style.left = Math.max(8, Math.min(
    window.innerWidth - width - 8,
    rect.right - width
  )) + "px";
  popover.style.top = Math.max(8, rect.top - popover.offsetHeight - 6) + "px";
}

function openPaneUsagePopover(thread) {
  closePaneFooterPopovers();
  var metrics = paneFooterState(thread).metrics || {};
  var provider = metrics.provider || "agent";
  var notReported = "Not reported by " + provider;
  var popover = document.createElement("div");
  popover.className = "pane-footer-popover pane-usage-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", thread.name + " session usage");
  popover.appendChild(paneUsageRow("Provider", provider));
  popover.appendChild(paneUsageRow("Model", metrics.model || notReported));
  popover.appendChild(paneUsageRow("Session", metrics.sessionId || "Not available"));
  popover.appendChild(paneUsageRow(
    "Context",
    Number.isFinite(metrics.contextUsed) && Number.isFinite(metrics.contextLimit)
      ? metrics.contextUsed + " / " + metrics.contextLimit + " tokens"
      : notReported
  ));
  popover.appendChild(paneUsageRow(
    "Input tokens",
    Number.isFinite(metrics.cumulativeInputTokens)
      ? String(metrics.cumulativeInputTokens)
      : "Not available"
  ));
  popover.appendChild(paneUsageRow(
    "Output tokens",
    Number.isFinite(metrics.cumulativeOutputTokens)
      ? String(metrics.cumulativeOutputTokens)
      : "Not available"
  ));
  popover.appendChild(paneUsageRow(
    "Spend",
    Number.isFinite(metrics.spendUsd)
      ? "$" + metrics.spendUsd.toFixed(4) + " · Local estimate"
      : notReported
  ));
  popover.appendChild(paneUsageRow(
    "Updated",
    metrics.updatedAt || (metrics.phase === "loading" ? "Loading…" : "Not available")
  ));
  if (metrics.stale) popover.appendChild(paneUsageRow("State", "Stale"));
  if (metrics.error) popover.appendChild(paneUsageRow("Error", metrics.error));
  positionPaneFooterPopover(popover, thread.paneFooter);
}

function openPaneFooterOverflow(thread, anchor) {
  closePaneFooterPopovers();
  var popover = document.createElement("div");
  popover.className = "pane-footer-popover pane-footer-menu";
  popover.setAttribute("role", "menu");
  var state = paneFooterState(thread);
  var hiddenKeys = PsychePanes.hiddenFooterKeys(
    thread.paneFooter.dataset.tier,
    PsychePanes.isAgentPaneKind(thread.kind)
  );
  var items = PsychePanes.footerItems(state).filter(function (item) {
    return hiddenKeys.indexOf(item.key) !== -1;
  });
  items.forEach(function (item) {
    var button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label + "  " + item.value;
    button.title = item.fullValue || item.label + ": not reported";
    button.addEventListener("click", function () {
      closePaneFooterPopovers();
      runPaneFooterAction(thread, item);
    });
    popover.appendChild(button);
  });
  positionPaneFooterPopover(popover, anchor);
}

document.addEventListener("pointerdown", function (event) {
  if (!event.target.closest(".pane-footer-popover, .terminal-pane-footer")) {
    closePaneFooterPopovers();
  }
});
```

Add styles:

```css
.pane-footer-popover {
  position: fixed;
  z-index: 150;
  padding: 7px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: rgba(var(--rgb-s1), 0.98);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.42);
  color: var(--text-soft);
}

.pane-usage-popover {
  display: grid;
  gap: 2px;
}

.pane-usage-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 10px;
  padding: 4px 5px;
  font-size: 11px;
}

.pane-usage-row span {
  color: var(--muted);
}

.pane-usage-row strong {
  overflow-wrap: anywhere;
  color: var(--text);
  font-family: var(--font-mono);
  font-weight: 500;
}

.pane-footer-menu {
  display: grid;
  gap: 2px;
}

.pane-footer-menu button {
  min-height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-soft);
  text-align: left;
}

.pane-footer-menu button:hover,
.pane-footer-menu button:focus-visible {
  background: var(--surface-3);
  color: var(--text);
}
```

- [ ] **Step 5: Run footer tests**

Run:

```bash
pnpm vitest --run __tests__/tauriPaneFooter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit metrics UI**

```bash
git add \
  __tests__/tauriPaneFooter.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css
git commit -m "feat: show live pane session usage"
```

### Task 7: Regenerate bundles and run the full gate

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/panes.bundle.js`
- Modify: any directly related test file only if the existing contract requires
  an intentional update.

- [ ] **Step 1: Regenerate the checked-in web bundles**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
```

Expected: PASS and `web/panes.bundle.js` includes `footerItems`,
`footerTier`, and `shouldApplyMetricsResponse`.

- [ ] **Step 2: Run focused JavaScript tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run Rust tests**

Run:

```bash
pnpm --filter psyche-build-tauri exec cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: PASS.

- [ ] **Step 4: Run repository typechecking**

Run:

```bash
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run the native web build again as the final artifact check**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
git --no-pager diff --check
```

Expected: both commands PASS.

- [ ] **Step 6: Commit generated artifacts**

```bash
git add \
  native/macos/psyche-build-tauri/web/panes.bundle.js \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/src-tauri \
  native/macos/psyche-build-tauri/package.json \
  pnpm-lock.yaml \
  __tests__
git commit -m "test: verify pane footer controls"
```
