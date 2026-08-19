# Project Browser URL Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route terminal URL clicks into the source project/worktree's dedicated browser pane while keeping browser failures out of CLI and agent output.

**Architecture:** Capture the owning thread in terminal link registration and pass its stable project/worktree identity into an explicit project-browser navigation helper. Reuse the existing browser pane and active tab lifecycle, but validate context at every async boundary and report failures through desktop status rather than PTY writes.

**Tech Stack:** Vanilla JavaScript desktop web runtime, xterm link providers, Tauri browser commands, Vitest source-extraction harnesses.

---

### Task 1: Route terminal links with source thread context

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:2739-2815`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:3385-3415`
- Test: `__tests__/tauriBrowserLifecycle.test.ts`

- [ ] **Step 1: Add failing source-context link tests**

Add a focused extraction harness for `openTerminalLink` and
`registerTerminalLinkHandling`:

```ts
it('routes a left-clicked terminal URL with the owning thread context', async () => {
  const calls: unknown[] = [];
  const thread = {
    id: 'agent-a',
    projectId: 'project-a',
    worktreePath: '/repo-a/.worktrees/agent-a',
  };
  const openTerminalLink = compileFunction<
    (thread: typeof thread, url: string, event?: { button?: number; type?: string }) => Promise<boolean>
  >(functionSource(mainJs, 'openTerminalLink'), {
    normaliseUrl: (value: string) => value,
    openUrl: async () => {
      throw new Error('system browser should not open');
    },
    navigateProjectBrowserLink: async (source: unknown, url: string) => {
      calls.push([source, url]);
      return true;
    },
  });

  await expect(openTerminalLink(thread, 'https://example.test/docs', { button: 0 }))
    .resolves.toBe(true);
  expect(calls).toEqual([[thread, 'https://example.test/docs']]);
});

it('preserves right-click external-open behavior', async () => {
  const external: string[] = [];
  const thread = {
    id: 'shell-a',
    projectId: 'project-a',
    worktreePath: '/repo-a',
  };
  const openTerminalLink = compileFunction<
    (thread: typeof thread, url: string, event?: { button?: number; type?: string }) => Promise<boolean>
  >(functionSource(mainJs, 'openTerminalLink'), {
    normaliseUrl: (value: string) => value,
    openUrl: async (url: string) => {
      external.push(url);
    },
    navigateProjectBrowserLink: async () => {
      throw new Error('project browser should not navigate');
    },
  });

  await expect(openTerminalLink(thread, 'https://example.test', { type: 'contextmenu' }))
    .resolves.toBe(true);
  expect(external).toEqual(['https://example.test']);
});
```

Add a source assertion proving `mountTerminal` passes the owning `thread`:

```ts
expect(mainJs).toContain(
  'registerLinks: function (term, container) {' +
  ' return registerTerminalLinkHandling(thread, term, container);' +
  ' }',
);
```

- [ ] **Step 2: Run the focused test and verify context is missing**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts --exclude '**/.claude/**'
```

Expected: the new tests fail because terminal link handling has no thread
parameter and calls context-free `navigateBrowser`.

- [ ] **Step 3: Make link registration thread-aware**

Change the link helpers to accept the owning thread:

```js
function createTerminalLink(thread, url, x, y) {
  return {
    text: url,
    range: {
      start: { x: x, y: y },
      end: { x: x + url.length - 1, y: y },
    },
    activate: function (event) {
      openTerminalLink(thread, url, event).catch(function (error) {
        setStatus("link open failed: " + boundedBrowserError(error), "error");
      });
    },
  };
}

function terminalLinksForLine(thread, text, y) {
  // Existing URL scan remains unchanged.
  links.push(createTerminalLink(thread, url, match.index + 1, y));
}

async function openTerminalLink(thread, url, event) {
  var normalised = normaliseUrl(url);
  if (!normalised) return false;
  var external = event && (event.button === 2 || event.type === "contextmenu");
  if (external) {
    if (!openUrl) return false;
    await openUrl(normalised);
    return true;
  }
  return navigateProjectBrowserLink(thread, normalised);
}
```

Update `terminalUrlAtEvent` and `registerTerminalLinkHandling` to pass the
thread through every link creation path:

```js
function registerTerminalLinkHandling(thread, term, container) {
  // ...
  callback(terminalLinksForLine(thread, terminalLineText(term, y), y));
}
```

Capture the thread in `mountTerminal`:

```js
registerLinks: function (term, container) {
  return registerTerminalLinkHandling(thread, term, container);
},
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts --exclude '**/.claude/**'
```

Expected: source-context and external-open tests pass.

- [ ] **Step 5: Commit thread-aware link handling**

```bash
git add native/desktop/psyche-build-tauri/web/main.js __tests__/tauriBrowserLifecycle.test.ts
git commit -m "fix: route terminal links with pane context"
```

### Task 2: Navigate the owning project's active browser tab

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:2001-2010`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:2367-2415`
- Modify: `native/desktop/psyche-build-tauri/web/main.js:10904-11190`
- Test: `__tests__/tauriBrowserLifecycle.test.ts`
- Test: `__tests__/tauriCovenLaunch.test.ts`

- [ ] **Step 1: Add failing project/worktree routing tests**

Add a helper harness around `navigateProjectBrowserLink`:

```ts
it('activates the source project and reuses its dedicated browser active tab', async () => {
  const sourceThread = {
    id: 'agent-b',
    projectId: 'project-b',
    worktreePath: '/repo-b/.worktrees/agent-b',
  };
  const browserPane = {
    id: 'web-b',
    kind: 'web',
    projectId: 'project-b',
    worktreePath: sourceThread.worktreePath,
  };
  const calls: string[] = [];
  const navigateProjectBrowserLink = compileFunction<
    (thread: typeof sourceThread, url: string) => Promise<boolean>
  >(functionSource(mainJs, 'navigateProjectBrowserLink'), {
    findThread: (id: string) => id === sourceThread.id ? sourceThread : null,
    focusThread: async (id: string, options: unknown) => {
      calls.push(`focus:${id}:${JSON.stringify(options)}`);
      return true;
    },
    findProject: (id: string) => id === 'project-b' ? { id, root: '/repo-b' } : null,
    activeProject: () => ({ id: 'project-b', root: '/repo-b' }),
    activeWorkspaceRoot: () => sourceThread.worktreePath,
    findBrowserPane: () => browserPane,
    browserPaneIsClosing: () => false,
    navigateBrowserForContext: async (url: string, context: unknown) => {
      calls.push(`navigate:${url}:${JSON.stringify(context)}`);
      return true;
    },
  });

  await expect(
    navigateProjectBrowserLink(sourceThread, 'https://example.test/docs'),
  ).resolves.toBe(true);
  expect(calls[0]).toContain('focus:agent-b');
  expect(calls[1]).toContain('https://example.test/docs');
  expect(calls[1]).toContain('"projectId":"project-b"');
  expect(calls[1]).toContain(sourceThread.worktreePath);
});
```

Add stale-context cases:

```ts
it.each([
  ['missing source thread', () => null],
  ['replaced source thread', () => ({ ...sourceThread, id: 'replacement' })],
])('cancels safely for %s', async (_label, findThread) => {
  // Compile with findThread and assert false plus zero navigation calls.
});
```

Add a browser lifecycle test proving active-tab reuse:

```ts
it('reuses the project browser active tab for terminal link navigation', async () => {
  const activeTab = browserTabFixture({ id: 'tab-b', url: 'about:blank' });
  const harness = browserNavigationHarness({
    projectId: 'project-b',
    worktreePath: '/repo-b/.worktrees/agent-b',
    tabs: [activeTab],
    activeTabId: activeTab.id,
  });

  await expect(
    harness.navigateForContext('https://example.test/docs'),
  ).resolves.toBe(true);

  expect(harness.tabs()).toHaveLength(1);
  expect(harness.navigateCalls()).toEqual([
    expect.objectContaining({ tabId: activeTab.id }),
  ]);
});
```

- [ ] **Step 2: Run tests and verify navigation still depends on global active state**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  --exclude '**/.claude/**'
```

Expected: new project/worktree and active-tab tests fail.

- [ ] **Step 3: Add explicit project-browser routing**

Implement a thread entrypoint:

```js
async function navigateProjectBrowserLink(sourceThread, normalisedUrl) {
  if (!sourceThread || findThread(sourceThread.id) !== sourceThread) return false;
  var project = findProject(sourceThread.projectId);
  if (!project) return false;
  if (!(await focusThread(sourceThread.id, { focusTerminal: false }))) return false;
  if (findThread(sourceThread.id) !== sourceThread ||
      activeProject() !== project ||
      activeWorkspaceRoot(project) !== sourceThread.worktreePath) return false;

  return navigateBrowserForContext(normalisedUrl, {
    project: project,
    projectId: project.id,
    worktreePath: sourceThread.worktreePath,
    sourceThread: sourceThread,
    errorSurface: "status",
  });
}
```

Extract the current navigation body into `navigateBrowserForContext` and make
the existing function a wrapper:

```js
async function navigateBrowser(rawUrl, opts) {
  opts = opts || {};
  var project = activeProject();
  if (!project) return false;
  return navigateBrowserForContext(rawUrl, {
    project: project,
    projectId: project.id,
    worktreePath: activeWorkspaceRoot(project) || project.root,
    tabId: opts.tabId,
    replace: opts.replace,
    preserveHistory: opts.preserveHistory,
    fromHistory: opts.fromHistory,
    historyIndex: opts.historyIndex,
    errorSurface: "status",
  });
}
```

Inside `navigateBrowserForContext`:

- normalize before creating a browser pane or tab;
- use only `context.project`, `context.projectId`, and
  `context.worktreePath`;
- find/create the browser pane for that exact pair;
- reuse `browser.activeTabId`;
- preserve the existing request-current identity checks.

Extend `createBrowserPane` only as needed to accept an exact worktree:

```js
async function createBrowserPane(project, options) {
  options = options || {};
  var worktreePath = options.worktreePath || activeWorkspaceRoot(project);
  // Existing lifecycle remains unchanged.
}
```

- [ ] **Step 4: Run project browser routing tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  --exclude '**/.claude/**'
```

Expected: the source project's browser pane is selected and its active tab is
reused without creating a duplicate.

- [ ] **Step 5: Commit explicit browser context routing**

```bash
git add native/desktop/psyche-build-tauri/web/main.js __tests__/tauriBrowserLifecycle.test.ts __tests__/tauriCovenLaunch.test.ts
git commit -m "fix: navigate URLs in the project browser"
```

### Task 3: Keep browser navigation failures out of terminals

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:11016-11190`
- Test: `__tests__/tauriBrowserLifecycle.test.ts`

- [ ] **Step 1: Replace the terminal-write regression expectation**

Update the native-failure test so it requires a desktop status error and no
terminal write:

```ts
it('reports native navigation failure without writing into the active terminal', async () => {
  const writes: string[] = [];
  const statuses: Array<[string, string]> = [];
  const harness = navigationFailureHarness({
    writeToActive: (value: string) => writes.push(value),
    setStatus: (message: string, level: string) => {
      statuses.push([message, level]);
    },
    invoke: async () => {
      throw new Error('native unavailable');
    },
  });

  await expect(harness.navigate('https://example.test')).resolves.toBe(false);
  expect(writes).toEqual([]);
  expect(statuses).toEqual([
    ['browser navigation failed: Error: native unavailable', 'error'],
  ]);
});
```

Add a link-activation promise test:

```ts
it('catches terminal link navigation rejection', async () => {
  const statuses: string[] = [];
  const link = createLinkHarness({
    navigateProjectBrowserLink: async () => {
      throw new Error('ipc disconnected');
    },
    setStatus: (message: string) => statuses.push(message),
  });

  link.activate({ button: 0 });
  await flushPromises();

  expect(statuses).toEqual([
    'link open failed: Error: ipc disconnected',
  ]);
});
```

- [ ] **Step 2: Run the browser lifecycle test and verify the old PTY write**

Run:

```bash
pnpm vitest --run __tests__/tauriBrowserLifecycle.test.ts --exclude '**/.claude/**'
```

Expected: the test fails because `navigateBrowser` calls `writeToActive`.

- [ ] **Step 3: Add bounded browser error reporting**

Add a small formatter:

```js
function boundedBrowserError(error) {
  var value = error instanceof Error ? error.message : String(error);
  value = value.replace(/[\r\n\t]+/g, " ").trim();
  return value.length > 240 ? value.slice(0, 237) + "..." : value;
}
```

Replace the native navigation catch terminal write:

```js
setStatus(
  "browser navigation failed: " + boundedBrowserError(error),
  "error"
);
return false;
```

Keep tab snapshot restoration and lifecycle cleanup unchanged.

- [ ] **Step 4: Run focused error and link tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  --exclude '**/.claude/**'
```

Expected: failures are reported through status, terminal writes remain empty,
and link activation owns all promise rejections.

- [ ] **Step 5: Commit browser error isolation**

```bash
git add native/desktop/psyche-build-tauri/web/main.js __tests__/tauriBrowserLifecycle.test.ts
git commit -m "fix: keep browser errors out of terminals"
```

### Task 4: Validate desktop browser integration

**Files:**
- Verify: `native/desktop/psyche-build-tauri/web/main.js`
- Verify: `__tests__/tauriBrowserLifecycle.test.ts`
- Verify: `__tests__/tauriCovenLaunch.test.ts`
- Verify: `__tests__/tauriWorkspacePanels.test.ts`

- [ ] **Step 1: Run all directly affected tests**

```bash
pnpm vitest --run \
  __tests__/tauriBrowserLifecycle.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  --exclude '**/.claude/**'
```

Expected: all selected tests pass with zero failures.

- [ ] **Step 2: Run non-generating type checks**

```bash
pnpm --filter @opencoven/psyche-vim-core typecheck
pnpm exec tsc --noEmit
pnpm run typecheck:tests
```

Expected: all commands exit successfully without modifying tracked generated
files.

- [ ] **Step 3: Check JavaScript syntax and exact diff**

```bash
node --check native/desktop/psyche-build-tauri/web/main.js
git diff --check origin/main...HEAD
git status --short
```

Expected: syntax and whitespace checks pass; status contains only the design,
plan, URL-routing implementation, and tests.

- [ ] **Step 4: Commit any test-only integration adjustments**

If Step 1 required directly related harness updates, commit them:

```bash
git add __tests__/tauriBrowserLifecycle.test.ts __tests__/tauriCovenLaunch.test.ts __tests__/tauriWorkspacePanels.test.ts __tests__/tauriPhysicalPanes.test.ts
git commit -m "test: cover project browser URL routing"
```

If no files changed, skip this commit.

- [ ] **Step 5: Push, open the PR, and require green CI**

```bash
git push -u origin fix/project-browser-url-routing
gh pr create \
  --repo OpenCoven/psyche-build \
  --base main \
  --head fix/project-browser-url-routing \
  --title "Open terminal URLs in the project browser" \
  --body-file /tmp/project-browser-url-routing-pr.md
```

Wait for all required checks, resolve every actionable review thread, and
rebase-merge only when the PR remains current and mergeable.
