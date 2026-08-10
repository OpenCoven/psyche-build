# Terminal and Agent Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Command-T create a plain terminal pane everywhere and make Command-P open a five-option agent picker with Coven Code selected by default.

**Architecture:** Keep the existing Tauri-owned PTY and pane-tree lifecycle as the only process path. Add a fixed agent launch registry and a small accessible picker controller to the unbundled native web client, route main-webview and embedded-browser shortcuts into shared launch helpers, and preserve automatic Coven startup as a separate flow.

**Tech Stack:** Tauri 2, Rust, plain browser JavaScript/HTML/CSS, xterm.js, Vitest, pnpm.

---

## File map

- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Own the fixed agent registry, terminal helper, agent launch helper, picker
    state/controller, shortcut routing, failure messaging, and click-surface
    wiring.
- Modify `native/macos/psyche-build-tauri/web/index.html`
  - Add accessible picker markup and update new-pane menu labels.
- Modify `native/macos/psyche-build-tauri/web/styles.css`
  - Add picker overlay, listbox, selected-option, and responsive styles.
- Modify `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
  - Change the embedded browser Command-T bridge from a browser-tab event to a
    terminal-pane event.
- Modify `__tests__/tauriDesktopTabs.test.ts`
  - Replace the contextual Command-T contract with the global terminal contract.
- Modify `__tests__/tauriPhysicalPanes.test.ts`
  - Replace contextual Coven-spawn tests with guarded shell-pane tests and keep
    automatic Coven startup assertions.
- Create `__tests__/tauriAgentPicker.test.ts`
  - Cover registry order and mapping, worktree launch descriptors, picker
    keyboard behavior, accessibility markup, wiring, and visible labels.

Implementation should start in a clean worktree based on commit `0315e67`.
There are unrelated attention-indicator edits in the current checkout's
`web/main.js` and session bundle; do not overwrite or accidentally commit them.

### Task 1: Lock the global Command-T contract

**Files:**
- Modify: `__tests__/tauriDesktopTabs.test.ts:13-63`
- Modify: `__tests__/tauriPhysicalPanes.test.ts:570-616`
- Modify: `native/macos/psyche-build-tauri/web/main.js:5144-5147,5341-5370`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs:632-638`

- [ ] **Step 1: Replace the contextual shortcut tests with global terminal tests**

In `__tests__/tauriDesktopTabs.test.ts`, replace the first test and the
embedded-browser shortcut test with:

```ts
it('routes Command+T to a plain terminal pane regardless of focused surface', () => {
  expect(mainJs).toMatch(/async function\s+createTerminalPane\(\)/);
  expect(mainJs).toMatch(
    /async function\s+createTerminalPane\(\)[\s\S]*await showTerminalView\(\)[\s\S]*spawnShellThread\(\)/,
  );
  expect(mainJs).toMatch(
    /String\(e\.key\)\.toLowerCase\(\) === "t"[\s\S]*await createTerminalPane\(\)/,
  );
  expect(mainJs).not.toMatch(/function\s+createContextualTab\(\)/);
  expect(mainJs).not.toMatch(
    /String\(e\.key\)\.toLowerCase\(\) === "t"[\s\S]{0,200}openBlankBrowserTab\(\)/,
  );
});

it('lets embedded browser webviews request a terminal pane with Command+T', () => {
  expect(tauriLib).toMatch(/browser:shortcut-terminal-pane/);
  expect(tauriLib).toMatch(/event\.key\.toLowerCase\(\)\s*===\s*"t"/);
  expect(tauriLib).not.toMatch(/browser:shortcut-new-tab/);
  expect(mainJs).toMatch(
    /listen\(\s*"browser:shortcut-terminal-pane"[\s\S]*createTerminalPane\(\)/,
  );
});
```

In `__tests__/tauriPhysicalPanes.test.ts`, replace
`guards contextual terminal creation behind dirty-file navigation` with:

```ts
it('guards Command-T shell creation behind dirty-file navigation', async () => {
  const terminalHost = { hidden: true };
  let spawned = 0;
  const createTerminalPane = compileFunction<() => Promise<Record<string, unknown> | null>>(
    functionSource('createTerminalPane'),
    {
      showTerminalView: async () => {
        terminalHost.hidden = false;
        return true;
      },
      spawnShellThread: () => {
        expect(terminalHost.hidden).toBe(false);
        spawned += 1;
        return { kind: 'shell' };
      },
    },
  );

  await expect(createTerminalPane()).resolves.toEqual({ kind: 'shell' });
  expect(spawned).toBe(1);

  const canceledCreate = compileFunction<() => Promise<null>>(
    functionSource('createTerminalPane'),
    {
      showTerminalView: async () => false,
      spawnShellThread: () => {
        spawned += 1;
        return { kind: 'shell' };
      },
    },
  );
  await expect(canceledCreate()).resolves.toBeNull();
  expect(spawned).toBe(1);
});
```

- [ ] **Step 2: Run the shortcut tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopTabs.test.ts __tests__/tauriPhysicalPanes.test.ts
```

Expected: FAIL because `createTerminalPane` and
`browser:shortcut-terminal-pane` do not exist and `createContextualTab` still
routes browser focus to `openBlankBrowserTab`.

- [ ] **Step 3: Add the shared terminal helper and route Command-T through it**

In `native/macos/psyche-build-tauri/web/main.js`, replace
`createContextualTab` with:

```js
async function createTerminalPane() {
  if (!(await showTerminalView())) return null;
  return spawnShellThread();
}
```

Change the main shortcut branch to:

```js
// Command-T always creates a plain terminal pane.
if (String(e.key).toLowerCase() === "t") {
  e.preventDefault();
  await createTerminalPane();
  return;
}
```

Change `runNewShellCommand` to share the same path:

```js
async function runNewShellCommand() {
  return createTerminalPane();
}
```

Do not change `runNewThreadCommand`, `ensureProjectCoven`,
`setActiveProject`, `openProjectPicker`, or `boot`; those remain the automatic
and explicit Coven Code paths.

- [ ] **Step 4: Route embedded-browser Command-T to the terminal helper**

In `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`, change the injected
event name:

```rust
emit("browser:shortcut-terminal-pane", {{ label: browserLabel, url: location.href }});
```

In `native/macos/psyche-build-tauri/web/main.js`, replace the old listener:

```js
listen("browser:shortcut-terminal-pane", function () {
  createTerminalPane();
}).catch(function () {});
```

Do not call `markActiveSurface("browser")`; terminal creation and focus should
move through the existing terminal pane path.

- [ ] **Step 5: Run the shortcut tests and verify they pass**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopTabs.test.ts __tests__/tauriPhysicalPanes.test.ts
```

Expected: both files PASS.

- [ ] **Step 6: Commit the shortcut routing**

```bash
git add __tests__/tauriDesktopTabs.test.ts __tests__/tauriPhysicalPanes.test.ts \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "Route Command-T to terminal panes" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add the agent registry and launch path

**Files:**
- Create: `__tests__/tauriAgentPicker.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1174-1285,5990-6080`

- [ ] **Step 1: Create registry and launch-descriptor tests**

Create `__tests__/tauriAgentPicker.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const mainJs = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const indexHtml = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/index.html'),
  'utf8',
);
const stylesCss = readFileSync(
  join(repoRoot, 'native/macos/psyche-build-tauri/web/styles.css'),
  'utf8',
);

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

describe('Tauri agent picker', () => {
  it('offers the fixed launch registry in product order', () => {
    const agentLaunchOptions = compileFunction<() => Array<Record<string, unknown>>>(
      functionSource('agentLaunchOptions'),
      {},
    );
    expect(agentLaunchOptions()).toEqual([
      {
        id: 'coven-code',
        label: 'Coven Code',
        command: null,
        args: ['chat'],
        kind: 'coven-chat',
      },
      {
        id: 'copilot',
        label: 'Copilot CLI',
        command: 'copilot',
        args: [],
        kind: 'agent-copilot',
      },
      {
        id: 'codex',
        label: 'Codex CLI',
        command: 'codex',
        args: [],
        kind: 'agent-codex',
      },
      {
        id: 'anthropic',
        label: 'Anthropic CLI',
        command: 'claude',
        args: [],
        kind: 'agent-anthropic',
      },
      {
        id: 'grok-build',
        label: 'Grok Build',
        command: 'grok',
        args: [],
        kind: 'agent-grok-build',
      },
    ]);
  });

  it('launches an agent in the selected worktree', async () => {
    const project = { id: 'project', root: '/repo' };
    const created: Array<Record<string, unknown>> = [];
    const spawnAgentThread = compileFunction<(
      agentId: string,
      project?: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo/worktree' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [{
          id: 'codex',
          label: 'Codex CLI',
          command: 'codex',
          args: [],
          kind: 'agent-codex',
        }],
        state: { env: { coven_path: '/usr/local/bin/coven' } },
        setStatus: () => undefined,
        createThread: (options: Record<string, unknown>) => {
          created.push(options);
          return options;
        },
      },
    );

    await expect(spawnAgentThread('codex')).resolves.toMatchObject({
      name: 'Codex CLI',
      kind: 'agent-codex',
      command: 'codex',
      args: [],
      cwd: '/repo/worktree',
      worktreePath: '/repo/worktree',
    });
    expect(created).toHaveLength(1);
  });

  it('resolves Coven Code through the discovered Coven executable', async () => {
    const project = { id: 'project', root: '/repo' };
    const spawnAgentThread = compileFunction<(
      agentId: string,
    ) => Promise<Record<string, unknown> | null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => project,
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [{
          id: 'coven-code',
          label: 'Coven Code',
          command: null,
          args: ['chat'],
          kind: 'coven-chat',
        }],
        state: { env: { coven_path: '/opt/homebrew/bin/coven' } },
        setStatus: () => undefined,
        createThread: (options: Record<string, unknown>) => options,
      },
    );

    await expect(spawnAgentThread('coven-code')).resolves.toMatchObject({
      command: '/opt/homebrew/bin/coven',
      args: ['chat'],
      launchKind: 'coven-chat',
    });
  });

  it('does not fall back when Coven Code is unavailable', async () => {
    const statuses: Array<[string, string]> = [];
    const spawnAgentThread = compileFunction<(
      agentId: string,
    ) => Promise<null>>(
      functionSource('spawnAgentThread'),
      {
        activeProject: () => ({ id: 'project', root: '/repo' }),
        selectedWorktree: () => ({ path: '/repo' }),
        showTerminalView: async () => true,
        agentLaunchOptions: () => [{
          id: 'coven-code',
          label: 'Coven Code',
          command: null,
          args: ['chat'],
          kind: 'coven-chat',
        }],
        state: { env: {} },
        setStatus: (message: string, level: string) => statuses.push([message, level]),
        createThread: () => {
          throw new Error('must not create a fallback thread');
        },
      },
    );

    await expect(spawnAgentThread('coven-code')).resolves.toBeNull();
    expect(statuses).toEqual([[
      'Coven CLI not found — install @opencoven/cli and restart Psyche',
      'error',
    ]]);
  });

  it('names the selected CLI when PTY startup fails', () => {
    expect(functionSource('spawnPty')).toMatch(
      /setStatus\(thread\.name \+ " failed to start: " \+ msg, "error"\)/,
    );
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: FAIL because `agentLaunchOptions` and `spawnAgentThread` do not exist.

- [ ] **Step 3: Add the fixed registry**

Near the thread launch helpers in
`native/macos/psyche-build-tauri/web/main.js`, add:

```js
function agentLaunchOptions() {
  return [
    {
      id: "coven-code",
      label: "Coven Code",
      command: null,
      args: ["chat"],
      kind: "coven-chat",
    },
    {
      id: "copilot",
      label: "Copilot CLI",
      command: "copilot",
      args: [],
      kind: "agent-copilot",
    },
    {
      id: "codex",
      label: "Codex CLI",
      command: "codex",
      args: [],
      kind: "agent-codex",
    },
    {
      id: "anthropic",
      label: "Anthropic CLI",
      command: "claude",
      args: [],
      kind: "agent-anthropic",
    },
    {
      id: "grok-build",
      label: "Grok Build",
      command: "grok",
      args: [],
      kind: "agent-grok-build",
    },
  ];
}
```

Keep this function free of DOM and Tauri dependencies so the test can execute
it directly.

- [ ] **Step 4: Add the agent launch helper**

Add:

```js
async function spawnAgentThread(agentId, project) {
  project = project || activeProject();
  if (!project || !project.root) {
    setStatus("Open a project before starting an agent", "warn");
    return null;
  }
  var worktree = selectedWorktree(project);
  if (!worktree || !worktree.path) {
    setStatus("Select an available worktree before starting an agent", "warn");
    return null;
  }
  var entry = agentLaunchOptions().find(function (option) {
    return option.id === agentId;
  });
  if (!entry) {
    setStatus("Unknown agent: " + agentId, "error");
    return null;
  }
  var command = entry.command;
  if (entry.id === "coven-code") {
    command = state.env && state.env.coven_path;
    if (!command) {
      setStatus("Coven CLI not found — install @opencoven/cli and restart Psyche", "error");
      return null;
    }
  }
  if (!(await showTerminalView())) return null;
  return createThread({
    project: project,
    worktreePath: worktree.path,
    name: entry.label,
    kind: entry.kind,
    command: command,
    args: entry.args.slice(),
    launchKind: entry.kind,
    projectRoot: project.root,
    cwd: worktree.path,
  });
}
```

This intentionally does not call `spawnCovenThread`: manual picker launches
must use the selected registry entry, while automatic project startup keeps its
existing idempotent Coven logic.

- [ ] **Step 5: Make PTY launch failures name the selected CLI**

In the non-`already running` failure branch of `spawnPty`, replace the generic
active-thread status:

```js
if (state.activeThreadId === thread.id) {
  setStatus(thread.name + " failed to start: " + msg, "error");
}
```

Keep the existing terminal output:

```js
thread.term.write("\r\n\x1b[31m[pty_start error]\x1b[0m " + msg + "\r\n");
```

This preserves the failed pane and retry action while making the selected CLI
visible in status chrome.

- [ ] **Step 6: Run the registry tests and verify they pass**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts __tests__/tauriPhysicalPanes.test.ts
```

Expected: both files PASS.

- [ ] **Step 7: Commit the registry and launch path**

```bash
git add __tests__/tauriAgentPicker.test.ts \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "Add native agent launch registry" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Build the accessible Command-P picker

**Files:**
- Modify: `__tests__/tauriAgentPicker.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/index.html:371-380`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:3401-3450`
- Modify: `native/macos/psyche-build-tauri/web/main.js:600-620,5341-5375`

- [ ] **Step 1: Add picker markup, styling, and keyboard-contract tests**

Append these tests inside the existing `describe` block in
`__tests__/tauriAgentPicker.test.ts`:

```ts
it('renders an accessible picker shell', () => {
  expect(indexHtml).toMatch(/id="agent-picker-overlay"[^>]*hidden/);
  expect(indexHtml).toMatch(
    /id="agent-picker"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="agent-picker-title"/,
  );
  expect(indexHtml).toMatch(
    /id="agent-picker-list"[^>]*role="listbox"[^>]*tabindex="0"/,
  );
  expect(stylesCss).toMatch(/\.agent-picker-overlay\[hidden\]\s*\{\s*display:\s*none;/);
  expect(stylesCss).toMatch(/\.agent-picker-option\.is-selected/);
});

it('wraps picker keyboard selection through all five agents', () => {
  const nextAgentPickerIndex = compileFunction<(
    current: number,
    delta: number,
    count: number,
  ) => number>(
    functionSource('nextAgentPickerIndex'),
    {},
  );
  expect(nextAgentPickerIndex(0, -1, 5)).toBe(4);
  expect(nextAgentPickerIndex(4, 1, 5)).toBe(0);
  expect(nextAgentPickerIndex(2, 1, 5)).toBe(3);
});

it('opens Command-P on Coven Code and supports keyboard selection', () => {
  expect(functionSource('openAgentPicker')).toMatch(
    /agentPickerIndex = 0[\s\S]*renderAgentPicker\(\)[\s\S]*agentPickerListEl\.focus\(\)/,
  );
  expect(mainJs).toMatch(
    /String\(e\.key\)\.toLowerCase\(\) === "p"[\s\S]*openAgentPicker\(\)/,
  );
  expect(mainJs).toMatch(
    /agentPickerListEl\.addEventListener\("keydown"[\s\S]*"ArrowDown"[\s\S]*"ArrowUp"[\s\S]*"Enter"[\s\S]*"Escape"/,
  );
  expect(functionSource('launchSelectedAgent')).toMatch(
    /spawnAgentThread\(entry\.id\)/,
  );
});

it('does not persist or restore the last selected agent', () => {
  expect(mainJs).not.toMatch(/localStorage\.[gs]etItem\([^)]*agent/i);
  expect(functionSource('openAgentPicker')).toMatch(/agentPickerIndex = 0/);
});
```

- [ ] **Step 2: Run the picker tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: FAIL because the picker markup, styles, and controller functions do
not exist.

- [ ] **Step 3: Add the picker markup**

In `native/macos/psyche-build-tauri/web/index.html`, place this after the help
overlay and before the app's closing `</div>`:

```html
<div class="agent-picker-overlay" id="agent-picker-overlay" hidden>
  <section
    class="agent-picker"
    id="agent-picker"
    role="dialog"
    aria-modal="true"
    aria-labelledby="agent-picker-title"
  >
    <div class="agent-picker-head">
      <span class="agent-picker-title" id="agent-picker-title">Choose agent</span>
      <span class="agent-picker-hint">enter to launch · esc to close</span>
    </div>
    <div
      class="agent-picker-list"
      id="agent-picker-list"
      role="listbox"
      tabindex="0"
      aria-label="Coding agents"
    ></div>
  </section>
</div>
```

- [ ] **Step 4: Add picker styles**

In `native/macos/psyche-build-tauri/web/styles.css`, after the keyboard overlay
styles, add:

```css
.agent-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px;
  background: rgba(5, 5, 8, 0.62);
  animation: menu-rise 140ms ease-out;
}
.agent-picker-overlay[hidden] { display: none; }
.agent-picker {
  width: min(440px, 100%);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  padding: 14px;
  background: rgba(var(--rgb-s1), calc(var(--bg-opacity) * 0.99));
  box-shadow: 0 40px 100px rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(30px);
  -webkit-backdrop-filter: blur(30px);
}
.agent-picker-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 6px 12px;
}
.agent-picker-title { font-size: 15px; font-weight: 700; }
.agent-picker-hint { color: var(--muted); font-size: 11px; }
.agent-picker-list {
  display: grid;
  gap: 4px;
  outline: none;
}
.agent-picker-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-soft);
  background: transparent;
  font: inherit;
  text-align: left;
}
.agent-picker-option:hover,
.agent-picker-option.is-selected {
  border-color: var(--border-strong);
  color: var(--text);
  background: var(--surface-3);
}
.agent-picker-option-command {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
}
@media (prefers-reduced-motion: reduce) {
  .agent-picker-overlay { animation: none; }
}
```

- [ ] **Step 5: Add picker DOM references and controller state**

With the other DOM refs in `native/macos/psyche-build-tauri/web/main.js`, add:

```js
var agentPickerOverlayEl = document.getElementById("agent-picker-overlay");
var agentPickerListEl = document.getElementById("agent-picker-list");
var agentPickerIndex = 0;
var agentPickerPreviousFocus = null;
```

Add these controller functions near the shortcut section:

```js
function nextAgentPickerIndex(current, delta, count) {
  if (!count) return 0;
  return (current + delta + count) % count;
}

function agentPickerOpen() {
  return !!agentPickerOverlayEl && !agentPickerOverlayEl.hidden;
}

function renderAgentPicker() {
  if (!agentPickerListEl) return;
  var options = agentLaunchOptions();
  agentPickerListEl.innerHTML = "";
  options.forEach(function (entry, index) {
    var option = document.createElement("button");
    option.type = "button";
    option.id = "agent-picker-option-" + entry.id;
    option.className = "agent-picker-option" +
      (index === agentPickerIndex ? " is-selected" : "");
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", index === agentPickerIndex ? "true" : "false");
    option.innerHTML =
      '<span>' + escapeHtml(entry.label) + "</span>" +
      '<span class="agent-picker-option-command">' +
        escapeHtml(entry.id === "coven-code" ? "coven chat" : entry.command) +
      "</span>";
    option.addEventListener("pointermove", function () {
      if (agentPickerIndex === index) return;
      agentPickerIndex = index;
      renderAgentPicker();
    });
    option.addEventListener("click", function () {
      agentPickerIndex = index;
      launchSelectedAgent();
    });
    agentPickerListEl.appendChild(option);
  });
  var active = options[agentPickerIndex];
  if (active) {
    agentPickerListEl.setAttribute(
      "aria-activedescendant",
      "agent-picker-option-" + active.id
    );
  }
}

function openAgentPicker() {
  if (!agentPickerOverlayEl || !agentPickerListEl) return false;
  if (!agentPickerOpen()) agentPickerPreviousFocus = document.activeElement;
  setHelpOpen(false);
  closeNewPaneMenu();
  closeScopeMenu();
  agentPickerIndex = 0;
  renderAgentPicker();
  agentPickerOverlayEl.hidden = false;
  agentPickerListEl.focus();
  return true;
}

function closeAgentPicker() {
  if (!agentPickerOverlayEl) return;
  agentPickerOverlayEl.hidden = true;
  var previous = agentPickerPreviousFocus;
  agentPickerPreviousFocus = null;
  if (previous && typeof previous.focus === "function") previous.focus();
}

async function launchSelectedAgent() {
  var entry = agentLaunchOptions()[agentPickerIndex];
  if (!entry) return null;
  closeAgentPicker();
  return spawnAgentThread(entry.id);
}
```

- [ ] **Step 6: Wire picker keyboard, outside-click, and Command-P behavior**

Add:

```js
if (agentPickerListEl) {
  agentPickerListEl.addEventListener("keydown", function (event) {
    var count = agentLaunchOptions().length;
    if (event.key === "ArrowDown") {
      agentPickerIndex = nextAgentPickerIndex(agentPickerIndex, 1, count);
      renderAgentPicker();
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      agentPickerIndex = nextAgentPickerIndex(agentPickerIndex, -1, count);
      renderAgentPicker();
      event.preventDefault();
    } else if (event.key === "Home") {
      agentPickerIndex = 0;
      renderAgentPicker();
      event.preventDefault();
    } else if (event.key === "End") {
      agentPickerIndex = Math.max(0, count - 1);
      renderAgentPicker();
      event.preventDefault();
    } else if (event.key === "Enter") {
      event.preventDefault();
      launchSelectedAgent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeAgentPicker();
    }
  });
}

if (agentPickerOverlayEl) {
  agentPickerOverlayEl.addEventListener("pointerdown", function (event) {
    if (event.target === agentPickerOverlayEl) closeAgentPicker();
  });
}
```

In the global shortcut listener, before Command-O, add:

```js
if (String(e.key).toLowerCase() === "p") {
  e.preventDefault();
  openAgentPicker();
  return;
}
```

If Command-P is pressed while the picker is open, `openAgentPicker` resets the
selection to Coven Code and focuses the list as required.

- [ ] **Step 7: Run the picker tests and verify they pass**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the picker**

```bash
git add __tests__/tauriAgentPicker.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "Add Command-P agent picker" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Align menus, empty state, and help text

**Files:**
- Modify: `__tests__/tauriAgentPicker.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/index.html:48-84`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3630-3668,5470-5540`

- [ ] **Step 1: Add click-surface and help-text tests**

Append inside the picker test suite:

```ts
it('labels terminal and agent launch surfaces with their distinct shortcuts', () => {
  expect(indexHtml).toMatch(
    /id="new-pane-term"[\s\S]*Shell — login shell[\s\S]*class="new-pane-key">⌘T</,
  );
  expect(indexHtml).toMatch(
    /id="new-pane-agent"[\s\S]*Agent — choose CLI[\s\S]*class="new-pane-key">⌘P</,
  );
  expect(mainJs).toMatch(
    /data-empty-action="term"[\s\S]*Terminal[\s\S]*class="key">⌘T</,
  );
  expect(mainJs).toMatch(
    /data-empty-action="agent"[\s\S]*Agent[\s\S]*class="key">⌘P</,
  );
  expect(mainJs).toContain('["New terminal pane", "⌘T"]');
  expect(mainJs).toContain('["Choose an agent", "⌘P"]');
  expect(mainJs).not.toContain('["New agent pane (coven chat)", "⌘T"]');
  expect(mainJs).not.toContain('["New browser tab", "focus Web, then ⌘T"]');
});

it('routes every Agent click surface through the picker', () => {
  expect(mainJs).toMatch(
    /onMenuClick\("new-pane-agent", function \(\) \{[\s\S]*openAgentPicker\(\)/,
  );
  expect(functionSource('renderTerminalEmptyState')).toMatch(
    /action === "agent"\) openAgentPicker\(\)/,
  );
  expect(functionSource('toggleNewPaneMenu')).toMatch(
    /if \(!newPaneMenuEl\) \{ createTerminalPane\(\); return; \}/,
  );
});

it('keeps automatic project startup on Coven Code', () => {
  expect(functionSource('setActiveProject')).toMatch(/ensureProjectCoven\(project\)/);
  expect(functionSource('openProjectPicker')).toMatch(/ensureProjectCoven\(project\)/);
  expect(functionSource('boot')).toMatch(/ensureProjectCoven\(project\)/);
});
```

- [ ] **Step 2: Run the tests and verify the label assertions fail**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts
```

Expected: FAIL because the old menu and help labels still assign Command-T to
Coven chat.

- [ ] **Step 3: Update the new-pane menu**

In `native/macos/psyche-build-tauri/web/index.html`, change the two entries:

```html
<button id="new-pane-term" class="new-pane-item" type="button" role="menuitem">
  <span class="new-pane-glyph mono">❯_</span>Shell — login shell<span class="new-pane-key">⌘T</span>
</button>
<button id="new-pane-agent" class="new-pane-item" type="button" role="menuitem">
  <span class="new-pane-glyph">✳</span>Agent — choose CLI<span class="new-pane-key">⌘P</span>
</button>
```

- [ ] **Step 4: Update menu and empty-state actions**

In `native/macos/psyche-build-tauri/web/main.js`, change the no-menu fallback:

```js
if (!newPaneMenuEl) { createTerminalPane(); return; }
```

Change menu handlers:

```js
onMenuClick("new-pane-term", async function () {
  var thread = await createTerminalPane();
  if (thread) toast("Terminal pane opened");
});
onMenuClick("new-pane-agent", function () {
  openAgentPicker();
});
```

Change the empty-state markup:

```js
'<button type="button" class="canvas-empty-action" data-empty-action="term">' +
  '<span class="glyph mono">❯_</span>Terminal<span class="key">⌘T</span></button>' +
'<button type="button" class="canvas-empty-action" data-empty-action="agent">' +
  '<span class="glyph">✳</span>Agent<span class="key">⌘P</span></button>' +
```

Change its click routing:

```js
if (action === "term") createTerminalPane();
else if (action === "agent") openAgentPicker();
else openBlankBrowserTab();
```

Retain the existing no-project branch that opens the project picker before any
pane action.

- [ ] **Step 5: Update the help overlay**

Replace the old shell/agent/browser shortcut rows with:

```js
["New terminal pane", "⌘T"],
["Choose an agent", "⌘P"],
["New browser tab", "Web pane +"],
```

Keep the remaining help rows unchanged.

- [ ] **Step 6: Run the aligned-surface tests**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriPhysicalPanes.test.ts
```

Expected: all three files PASS.

- [ ] **Step 7: Commit the aligned launch surfaces**

```bash
git add __tests__/tauriAgentPicker.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js
git commit -m "Align terminal and agent launch surfaces" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Validate native web and Rust boundaries

**Files:**
- Modify only if validation exposes a defect in the files already listed.

- [ ] **Step 1: Run the focused shortcut and pane tests**

Run:

```bash
pnpm vitest --run __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: all tests PASS, including automatic Coven startup and explicit
`/new-thread` regression coverage.

- [ ] **Step 2: Build the native web assets**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
```

Expected: esbuild completes successfully for the editor, sessions, and panes
bundles. `main.js` remains unbundled and is loaded directly by `index.html`.

- [ ] **Step 3: Compile the Tauri Rust library tests**

Run:

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --lib
```

Expected: Rust compilation succeeds and all library tests PASS.

- [ ] **Step 4: Inspect the final diff for forbidden regressions**

Run:

```bash
git --no-pager diff --check
git --no-pager grep -n "browser:shortcut-new-tab" -- \
  native/macos/psyche-build-tauri __tests__ || true
git --no-pager grep -n "createContextualTab" -- \
  native/macos/psyche-build-tauri __tests__ || true
```

Expected: `git diff --check` prints nothing, and both grep commands print
nothing.

- [ ] **Step 5: Commit any validation-only corrections**

If the prior steps required corrections in already-scoped files:

```bash
git add __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriDesktopTabs.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "Harden terminal and agent shortcuts" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

If no correction was needed, do not create an empty commit.
