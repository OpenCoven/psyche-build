# App-Origin Session Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS session rail show only local runtime threads created inside Psyche, with no daemon-discovered rows or Attach behavior.

**Architecture:** Keep `state.threads` as the sole macOS rail input and pass no remote rows into the existing shared worktree grouping model. Remove Coven discovery, polling, remote rendering, and attachment code only from the macOS web UI while retaining the bounded native adapter and shared protocol/model code.

**Tech Stack:** Tauri 2, vanilla JavaScript, TypeScript/Vitest, CSS, esbuild, Rust/Cargo

---

## File map

- Modify `native/macos/psyche-build-tauri/web/main.js`: remove remote discovery and Attach behavior; render the rail exclusively from local threads.
- Modify `native/macos/psyche-build-tauri/web/styles.css`: remove presentation rules that only served daemon-discovered rows.
- Regenerate `native/macos/psyche-build-tauri/web/sessions.bundle.js`: keep the checked-in bundle synchronized with its source build.
- Modify `__tests__/tauriCovenSessionSiderail.test.ts`: replace remote-row expectations with app-origin ownership regressions while retaining local row interaction coverage.
- Modify `__tests__/tauriCovenSessionLifecycle.test.ts`: replace discovery/Attach lifecycle tests with a static boundary contract proving the UI no longer exposes those paths and the native adapter remains available.

### Task 1: Make the rail a local-thread-only projection

**Files:**
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:415-650`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1310-1744`

- [ ] **Step 1: Replace remote rendering expectations with the failing ownership regression**

Replace the remote-focused cases at the start of `describe('Tauri Coven session project rail', ...)` with these cases. Keep the existing local rename, hide, context-menu, worktree selection, and keyboard tests below them.

```ts
describe('Tauri app-origin session project rail', () => {
  it('renders only app-origin threads, including an existing attachment thread', () => {
    const renderer = createRenderer({
      projects: [
        { id: 'alpha', name: 'Alpha', root: '/alpha' },
        { id: 'beta', name: 'Beta', root: '/beta' },
      ],
      threads: [
        { id: 'local', projectId: 'alpha', name: 'Local shell', status: 'running' },
        {
          id: 'attached', projectId: 'alpha', name: 'Existing attachment',
          kind: 'coven', status: 'running', covenSessionId: 'remote-alpha',
        },
      ],
      sessions: [
        { id: 'remote-alpha', projectRoot: '/alpha', title: 'Daemon Alpha', status: 'running' },
        { id: 'remote-beta', projectRoot: '/beta', title: 'Daemon Beta', status: 'waiting' },
      ],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelectorAll('.session-group')).toHaveLength(2);
    expect(renderer.sessionListEl.querySelectorAll('.session-row').map((row) => row.dataset.threadId))
      .toEqual(['local', 'attached']);
    expect(textOf(renderer.sessionListEl.querySelectorAll('.session-subsection-label')))
      .toEqual(['Psyche']);
    expect(renderer.sessionListEl.querySelector('.session-coven-row')).toBeNull();
    expect(renderer.sessionListEl.textContent).not.toContain('Daemon Alpha');
    expect(renderer.sessionListEl.textContent).not.toContain('Daemon Beta');
  });

  it('does not change empty-project presentation for daemon-only sessions', () => {
    const renderer = createRenderer({
      sessions: [{ id: 'remote', projectRoot: '/alpha', title: 'Remote', status: 'running' }],
    });

    renderer.render();

    expect(renderer.sessionListEl.querySelectorAll('.session-group')).toHaveLength(1);
    expect(renderer.sessionListEl.querySelector('.session-coven-row')).toBeNull();
    expect(renderer.sessionListEl.textContent).not.toContain('Remote');
    expect(renderer.sessionListEl.querySelector('.session-worktree-empty')?.textContent)
      .toBe('No panes — select and press ⌘T');
    expect(renderer.openCovenSession).not.toHaveBeenCalled();
  });

  it('searches local thread fields without matching daemon metadata', () => {
    const renderer = createRenderer({
      threads: [{ id: 'local', projectId: 'alpha', name: 'Review locally', status: 'running' }],
      sessions: [{
        id: 'remote-id', projectRoot: '/alpha', title: 'Ship release',
        harness: 'coven-code', status: 'waiting',
      }],
    });

    renderer.setFilter('ship');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-group')).toBeNull();
    expect(renderer.sessionListEl.querySelector('.session-empty')?.textContent)
      .toBe('No sessions match “ship”');

    renderer.setFilter('review');
    renderer.render();
    expect(renderer.sessionListEl.querySelector('.session-row')?.dataset.threadId).toBe('local');
  });
```

- [ ] **Step 2: Run the ownership tests and verify the red state**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: FAIL because daemon-discovered sessions still create `.session-coven-row` elements, labels, search matches, and alternate empty-state copy.

- [ ] **Step 3: Remove remote data from `renderSessionList`**

Delete `covenInlineState` and `covenToneClass`. In `renderSessionList`, replace remote collection and the three-argument model call with:

```js
      var railModel = PsycheSessions.buildProjectRailModel(
        project, localRows, [], currentSearchQuery
      );
      var visibleWorktrees = railModel.worktrees.filter(function (entry) {
        return entry.matches || entry.rows.length > 0;
      });
```

Keep the existing unresolved local `projectRows` block. Change the empty project guard to:

```js
      if (visibleWorktrees.length === 0) return;
```

Inside each worktree, replace the source partitions with the local-only projection:

```js
        var threads = entry.rows.map(function (row) { return row.value; });
```

Delete all of the following render branches:

- the `covenSessions` variable
- the `Coven` subsection label
- the `covenSessions.forEach(...)` remote row block
- `showInlineState` and the trailing inline discovery state block

Keep the local subsection and local row code unchanged. Simplify the worktree empty copy to:

```js
          noPanes.textContent = worktree.missing
            ? "Unavailable"
            : "No panes — select and press ⌘T";
```

- [ ] **Step 4: Run the focused rail tests and verify green**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS with no `.session-coven-row` or remote-only project expectations remaining.

- [ ] **Step 5: Commit the local-only rail behavior**

```bash
git add __tests__/tauriCovenSessionSiderail.test.ts native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "fix: show only app-origin sessions in macOS rail"
```

### Task 2: Remove the macOS discovery and Attach lifecycle

**Files:**
- Modify: `__tests__/tauriCovenSessionLifecycle.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js:78-182`
- Modify: `native/macos/psyche-build-tauri/web/main.js:767-799`
- Modify: `native/macos/psyche-build-tauri/web/main.js:1828-1863`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3718-3730`
- Modify: `native/macos/psyche-build-tauri/web/main.js:3870-3882`

- [ ] **Step 1: Replace the obsolete lifecycle suite with a failing UI boundary contract**

Replace `__tests__/tauriCovenSessionLifecycle.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const mainJs = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/main.js'),
  'utf8',
);
const nativeLib = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/src-tauri/src/lib.rs'),
  'utf8',
);
const sessionModel = readFileSync(
  join(root, 'native/macos/psyche-build-tauri/web/sessions/session-model.mjs'),
  'utf8',
);

function functionSource(source: string, name: string) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const syncStart = source.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? syncStart : asyncStart;
  if (start === -1) throw new Error(`missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

describe('native app-origin session boundary', () => {
  it('does not discover or attach daemon sessions from the web UI', () => {
    expect(mainJs).not.toContain('invoke("coven_sessions"');
    expect(mainJs).not.toMatch(/function\s+refreshCovenSessions\s*\(/);
    expect(mainJs).not.toMatch(/function\s+startCovenPolling\s*\(/);
    expect(mainJs).not.toMatch(/function\s+openCovenSession\s*\(/);
    expect(mainJs).not.toContain('args: ["attach"');
    expect(mainJs).not.toContain('label: isActive ? "Focus attachment" : "Attach"');
  });

  it('keeps existing local attachment identity in the runtime thread model', () => {
    expect(functionSource(mainJs, 'createThread')).toContain(
      'covenSessionId: opts.covenSessionId || null',
    );
  });

  it('saves on hide without starting background Coven work', () => {
    const visibilitySource = functionSource(mainJs, 'handleVisibilityChange');
    expect(visibilitySource).toContain('saveWorkspaceNow()');
    expect(visibilitySource).not.toContain('Coven');
    expect(visibilitySource).not.toContain('Polling');
  });

  it('retains the native adapter and shared discovery model outside the UI', () => {
    expect(nativeLib).toMatch(/\n\s*coven_sessions,/);
    expect(sessionModel).toMatch(/export function createCovenDiscoveryState\(/);
  });
});
```

- [ ] **Step 2: Run the boundary contract and verify the red state**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: FAIL because the web UI still defines polling, invokes `coven_sessions`, exposes `openCovenSession`, and builds `coven attach` commands.

- [ ] **Step 3: Remove the unused UI lifecycle and call sites**

In `main.js`:

1. Delete `covenDiscovery`, `covenPollTimer`, `COVEN_POLL_MS`, `refreshCovenSessions`, `invalidateCovenDiscovery`, `requestCovenRefresh`, `stopCovenPolling`, `startCovenPolling`, and `completeCovenBoot`.
2. Delete `openCovenSession` while keeping `createThread` and its `covenSessionId` field intact for restored app-created threads.
3. Remove `invalidateCovenDiscovery()` from `removeProject`.
4. Remove `requestCovenRefresh()` after project removal and project creation.
5. Remove the refresh call after worktree refresh.
6. Remove `isBootstrapping`, whose only remaining purpose was discovery suppression.
7. Replace `completeCovenBoot()` at the end of `boot` with no extra call; boot already performs the required initial render and persistence.
8. Reduce visibility handling to local workspace persistence:

```js
  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") saveWorkspaceNow();
  }
```

- [ ] **Step 4: Run lifecycle and rail tests and verify green**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS. The UI boundary suite proves Attach is absent while the native adapter remains registered.

- [ ] **Step 5: Commit the lifecycle removal**

```bash
git add __tests__/tauriCovenSessionLifecycle.test.ts native/macos/psyche-build-tauri/web/main.js
git diff --cached --check
git commit -m "refactor: remove implicit Coven attach lifecycle"
```

### Task 3: Remove dead remote-row styling and regenerate assets

**Files:**
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts:820-860`
- Modify: `native/macos/psyche-build-tauri/web/styles.css:375-433`
- Regenerate: `native/macos/psyche-build-tauri/web/sessions.bundle.js`

- [ ] **Step 1: Write the failing dead-surface style contract**

Replace the remote styling case with:

```ts
  it('ships only local-row session presentation', () => {
    expect(styles).toMatch(/\.session-subsection-label\s*\{[^}]*text-transform:\s*uppercase;[^}]*letter-spacing:/s);
    expect(styles).toMatch(/\.session-row-wrap\s*\{[^}]*position:\s*relative;/s);
    expect(styles).toMatch(/\.session-row\.inline-edit-hidden\s*\{[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.session-row-wrap\s*>\s*\.inline-edit\s*\{[^}]*position:\s*absolute;/s);
    expect(styles).toMatch(/\.session-row-wrap:focus-within\s+\.session-close/);
    expect(styles).toMatch(/\.session-close:focus-visible\s*\{[^}]*opacity:\s*1;[^}]*outline:/s);
    expect(styles).not.toMatch(/session-coven|coven-tone|session-inline-state/);

    const rendererSource = extractFunctionSource(mainJs, 'renderSessionList');
    expect(rendererSource).toContain('PsycheSessions.buildProjectRailModel');
    expect(rendererSource).not.toContain('covenDiscovery');
    expect(rendererSource).not.toContain('openCovenSession');
    expect(rendererSource).not.toContain('statusPresentation');
  });
```

- [ ] **Step 2: Run the style contract and verify the red state**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: FAIL because `.session-coven-*`, `.coven-tone-*`, and `.session-inline-state` rules still exist.

- [ ] **Step 3: Delete styles used only by removed remote rows**

Delete these CSS rules from `styles.css`:

- `.session-coven-meta`
- `.session-inline-state`
- every `.session-coven-row.coven-tone-*` rule
- `.session-coven-row.coven-starting .session-dot`

Change reduced motion from:

```css
@media (prefers-reduced-motion: reduce) {
  .session-row.starting .session-dot,
  .session-coven-row.coven-starting .session-dot { animation: none; }
}
```

to:

```css
@media (prefers-reduced-motion: reduce) {
  .session-row.starting .session-dot { animation: none; }
}
```

- [ ] **Step 4: Regenerate the checked-in web bundle**

Run:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: esbuild reports successful `editor.bundle.js` and `sessions.bundle.js` builds. Only a deterministic bundle diff related to source inputs may remain.

- [ ] **Step 5: Run focused tests and verify green**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit style and generated-asset cleanup**

```bash
git add \
  __tests__/tauriCovenSessionSiderail.test.ts \
  native/macos/psyche-build-tauri/web/styles.css \
  native/macos/psyche-build-tauri/web/sessions.bundle.js
git diff --cached --check
git commit -m "style: remove remote session rail presentation"
```

### Task 4: Verify, rebuild, and launch the simplified app

**Files:**
- Verify all files changed in Tasks 1-3

- [ ] **Step 1: Run the complete JavaScript and TypeScript gates**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
```

Expected: all test files pass except the repository's intentional skips; typecheck, production build, and package dry run exit zero.

- [ ] **Step 2: Verify generated protocol fixtures remain unchanged**

Run:

```bash
pnpm fixtures:generate
git diff --exit-code -- protocol-fixtures
```

Expected: exit zero with no protocol fixture diff because this is a macOS UI-only simplification.

- [ ] **Step 3: Run Rust gates for the retained native adapter**

Run from `native/macos/psyche-build-tauri/src-tauri`:

```bash
cargo fmt --check
cargo test
cargo check
```

Expected: all Rust tests pass and both formatting and compilation checks exit zero.

- [ ] **Step 4: Build the macOS application and DMG**

Run from `native/macos/psyche-build-tauri`:

```bash
pnpm build:web
pnpm exec tauri build --bundles app,dmg
```

Expected artifacts:

```text
src-tauri/target/release/bundle/macos/Psyche Build.app
src-tauri/target/release/bundle/dmg/Psyche Build_0.0.1_aarch64.dmg
```

- [ ] **Step 5: Launch the exact rebuilt app and verify its process**

Run from `native/macos/psyche-build-tauri`:

```bash
open -n 'src-tauri/target/release/bundle/macos/Psyche Build.app'
sleep 4
pgrep -fl '/Psyche Build.app/Contents/MacOS/psyche-build-tauri'
```

Expected: `pgrep` prints the process whose executable is inside the newly built bundle.

- [ ] **Step 6: Confirm the branch is clean**

```bash
git status --short
git log -5 --oneline
```

Expected: no uncommitted files and the design, plan, plus three implementation commits at the branch tip.
