# TUI Image Drop and Coven Interrupt State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Finder image drops insert shell-safe absolute paths into any running native terminal pane, and let Coven return to **Waiting for you** after Ctrl+C settles at its prompt.

**Architecture:** Add a small bundled terminal-input module for pure image filtering, quoting, and coordinate conversion. Keep native Tauri event subscription, DOM hit-testing, pane feedback, and PTY dispatch in the existing macOS web shell, while extending the pure session attention tracker with an explicit interrupt transition.

**Tech Stack:** Tauri 2 window APIs, vanilla JavaScript, xterm.js, CSS, esbuild IIFE bundles, TypeScript declaration files, Vitest.

---

## File map

- Create `native/macos/psyche-build-tauri/web/input/terminal-drop.mjs` for pure image-path and coordinate helpers.
- Create `native/macos/psyche-build-tauri/web/input/terminal-drop.d.mts` for the helper contract used by tests and editors.
- Create `native/macos/psyche-build-tauri/web/input/input-entry.js` as the esbuild entry exposed as `PsycheTerminalInput`.
- Generate and commit `native/macos/psyche-build-tauri/web/input.bundle.js`.
- Modify `native/macos/psyche-build-tauri/package.json` to build the new bundle.
- Modify `native/macos/psyche-build-tauri/web/index.html` to load the new bundle before `main.js`.
- Modify `native/macos/psyche-build-tauri/web/sessions/attention.mjs` and `attention.d.mts` for the interrupt transition.
- Modify `native/macos/psyche-build-tauri/web/main.js` for shared PTY input routing and native drag/drop handling.
- Modify `native/macos/psyche-build-tauri/web/styles.css` for the drop-target overlay.
- Create `__tests__/tauriTerminalImageDrop.test.ts` for helper, controller, and source-contract coverage.
- Modify `__tests__/tauriSessionAttention.test.ts` for interrupt state and Ctrl+C wiring.
- Modify `__tests__/tauriWorkspacePanels.test.ts` and `__tests__/tauriWebBundles.test.ts` for the new committed bundle.
- Modify `docs/SMOKE.md` with manual Finder-drop and Coven-interrupt checks.

### Task 1: Add the pure terminal image-drop module

**Files:**
- Create: `native/macos/psyche-build-tauri/web/input/terminal-drop.mjs`
- Create: `native/macos/psyche-build-tauri/web/input/terminal-drop.d.mts`
- Create: `native/macos/psyche-build-tauri/web/input/input-entry.js`
- Create: `native/macos/psyche-build-tauri/web/input.bundle.js`
- Create: `__tests__/tauriTerminalImageDrop.test.ts`
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/web/index.html`
- Modify: `__tests__/tauriWorkspacePanels.test.ts`
- Modify: `__tests__/tauriWebBundles.test.ts`

- [ ] **Step 1: Write failing helper and bundle-contract tests**

Create `__tests__/tauriTerminalImageDrop.test.ts` with the pure behavior first:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const webRoot = join(repoRoot, 'native/macos/psyche-build-tauri/web');
const inputModule = await import(pathToFileURL(
  join(webRoot, 'input/terminal-drop.mjs'),
).href);

describe('terminal image drop helpers', () => {
  it('filters supported image paths in drop order and shell-quotes them', () => {
    expect(inputModule.buildImageDropInsertion([
      '/tmp/cover image.PNG',
      "/tmp/witch's portrait.jpg",
      '/tmp/notes.md',
      '/tmp/reference.AVIF',
    ])).toEqual({
      accepted: [
        '/tmp/cover image.PNG',
        "/tmp/witch's portrait.jpg",
        '/tmp/reference.AVIF',
      ],
      skipped: ['/tmp/notes.md'],
      text: "'/tmp/cover image.PNG' '/tmp/witch'\\''s portrait.jpg' '/tmp/reference.AVIF'",
    });
  });

  it('supports the approved image extensions case-insensitively', () => {
    for (const extension of [
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif',
      'heic', 'heif', 'tif', 'tiff', 'bmp', 'svg',
    ]) {
      expect(inputModule.isSupportedImagePath(`/tmp/image.${extension}`)).toBe(true);
      expect(inputModule.isSupportedImagePath(`/tmp/image.${extension.toUpperCase()}`)).toBe(true);
    }
    expect(inputModule.isSupportedImagePath('/tmp/image.txt')).toBe(false);
    expect(inputModule.isSupportedImagePath('/tmp/image.png.txt')).toBe(false);
  });

  it('converts Tauri physical coordinates to CSS coordinates', () => {
    expect(inputModule.physicalToCssPosition({ x: 300, y: 180 }, 2)).toEqual({
      x: 150,
      y: 90,
    });
    expect(inputModule.physicalToCssPosition({ x: 1, y: 2 }, 0)).toBeNull();
    expect(inputModule.physicalToCssPosition({ x: Number.NaN, y: 2 }, 2)).toBeNull();
  });
});

describe('terminal input bundle wiring', () => {
  const packageJson = JSON.parse(readFileSync(
    join(repoRoot, 'native/macos/psyche-build-tauri/package.json'),
    'utf8',
  )) as { scripts: Record<string, string> };
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

  it('builds and loads PsycheTerminalInput before the application shell', () => {
    expect(packageJson.scripts['build:web']).toContain(
      'esbuild web/input/input-entry.js --bundle --minify --format=iife ' +
      '--global-name=PsycheTerminalInput --outfile=web/input.bundle.js',
    );
    const inputScript = '<script src="./input.bundle.js" defer></script>';
    const mainScript = '<script src="./main.js" defer></script>';
    expect(indexHtml).toContain(inputScript);
    expect(indexHtml.indexOf(inputScript)).toBeLessThan(indexHtml.indexOf(mainScript));
  });
});
```

Update the existing exact bundle expectations:

```ts
// __tests__/tauriWebBundles.test.ts
expect(steps.map((step) => step.outfile).sort()).toEqual([
  'web/diffs.bundle.js',
  'web/editor.bundle.js',
  'web/input.bundle.js',
  'web/panes.bundle.js',
  'web/sessions.bundle.js',
]);
```

Also update that test file's opening comment to describe all committed web
bundles rather than "the three web bundles."

In `__tests__/tauriWorkspacePanels.test.ts`, extend the expected `build:web`
string with:

```text
&& esbuild web/input/input-entry.js --bundle --minify --format=iife --global-name=PsycheTerminalInput --outfile=web/input.bundle.js
```

and add `input.bundle.js` to the script-order and non-empty bundle assertions.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriTerminalImageDrop.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: FAIL because `web/input/terminal-drop.mjs` and
`web/input.bundle.js` do not exist and the build script does not include the
new entry.

- [ ] **Step 3: Implement the pure helpers and entry point**

Create `native/macos/psyche-build-tauri/web/input/terminal-drop.mjs`:

```js
const IMAGE_EXTENSION_RE =
  /\.(?:png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i;

export function isSupportedImagePath(path) {
  return typeof path === 'string' && IMAGE_EXTENSION_RE.test(path);
}

export function quotePosixPath(path) {
  return "'" + String(path).replace(/'/g, "'\\''") + "'";
}

export function buildImageDropInsertion(paths) {
  const accepted = [];
  const skipped = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (isSupportedImagePath(path)) accepted.push(path);
    else skipped.push(path);
  }
  return {
    accepted,
    skipped,
    text: accepted.map(quotePosixPath).join(' '),
  };
}

export function physicalToCssPosition(position, scaleFactor) {
  const factor = Number(scaleFactor);
  const x = Number(position && position.x);
  const y = Number(position && position.y);
  if (!Number.isFinite(factor) || factor <= 0 ||
      !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x: x / factor, y: y / factor };
}
```

Create `native/macos/psyche-build-tauri/web/input/terminal-drop.d.mts`:

```ts
export interface ImageDropInsertion {
  accepted: string[];
  skipped: string[];
  text: string;
}

export interface Point {
  x: number;
  y: number;
}

export function isSupportedImagePath(path: unknown): boolean;
export function quotePosixPath(path: string): string;
export function buildImageDropInsertion(paths: unknown): ImageDropInsertion;
export function physicalToCssPosition(
  position: Partial<Point> | null | undefined,
  scaleFactor: number,
): Point | null;
```

Create `native/macos/psyche-build-tauri/web/input/input-entry.js`:

```js
export {
  buildImageDropInsertion,
  isSupportedImagePath,
  physicalToCssPosition,
  quotePosixPath,
} from './terminal-drop.mjs';
```

- [ ] **Step 4: Wire and build the committed browser bundle**

Add this command to `build:web` in
`native/macos/psyche-build-tauri/package.json`, after the panes bundle and
before the diffs bundle:

```text
esbuild web/input/input-entry.js --bundle --minify --format=iife --global-name=PsycheTerminalInput --outfile=web/input.bundle.js
```

Load it before `main.js` in
`native/macos/psyche-build-tauri/web/index.html`:

```html
<script src="./input.bundle.js" defer></script>
<script src="./main.js" defer></script>
```

Generate the committed bundle:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: PASS and `web/input.bundle.js` is created.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriTerminalImageDrop.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the helper module**

```bash
git add \
  native/macos/psyche-build-tauri/package.json \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/input \
  native/macos/psyche-build-tauri/web/input.bundle.js \
  __tests__/tauriTerminalImageDrop.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
git commit -m "Add terminal image drop helpers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add an interrupt transition to attention tracking

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/sessions/attention.mjs`
- Modify: `native/macos/psyche-build-tauri/web/sessions/attention.d.mts`
- Modify: `native/macos/psyche-build-tauri/web/sessions.bundle.js`
- Modify: `__tests__/tauriSessionAttention.test.ts`

- [ ] **Step 1: Write the failing interrupt-state test**

Add this case to the `attention tracker` describe block in
`__tests__/tauriSessionAttention.test.ts`:

```ts
it('re-arms after an interrupt and waits for the interrupted prompt to settle', () => {
  const tracker = createAttentionTracker();
  tracker.observe('a', '> ', 0);
  tracker.observe('a', '✻ Working… (esc to interrupt)', 1_000);

  expect(tracker.interrupt('a').needsAttention).toBe(false);

  // The first sample after Ctrl+C starts a fresh settle window even if xterm
  // redraw timing makes it arrive without an intermediate visible frame.
  expect(tracker.observe('a', '> ', 2_000).needsAttention).toBe(false);
  expect(tracker.observe('a', '> ', 2_000 + SETTLE - 1).needsAttention).toBe(false);
  expect(tracker.observe('a', '> ', 2_000 + SETTLE)).toEqual({
    needsAttention: true,
    reason: 'turn',
  });
});
```

- [ ] **Step 2: Run the attention test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriSessionAttention.test.ts
```

Expected: FAIL because `tracker.interrupt` is not defined.

- [ ] **Step 3: Implement the interrupt-pending state**

Add `interruptPending: false` to each tracker entry in
`attention.mjs`.

At the beginning of `observe`, after first-sample initialization and before
the ordinary `text !== entry.tail` branch, add:

```js
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
```

Add the public operation next to `userInput`:

```js
interrupt(id) {
  const entry = entryFor(id);
  entry.needsAttention = false;
  entry.reason = null;
  entry.awaitingAgent = false;
  entry.interruptPending = true;
  return resolve(entry);
},
```

Ensure ordinary user input cancels a pending interrupt:

```js
userInput(id) {
  const entry = entryFor(id);
  entry.needsAttention = false;
  entry.reason = null;
  entry.awaitingAgent = true;
  entry.interruptPending = false;
  return resolve(entry);
},
```

Extend `AttentionTracker` in `attention.d.mts`:

```ts
interrupt(id: string): AttentionState;
```

- [ ] **Step 4: Rebuild the session bundle**

Run:

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
```

Expected: PASS and `web/sessions.bundle.js` changes.

- [ ] **Step 5: Run the attention and bundle tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the interrupt state**

```bash
git add \
  native/macos/psyche-build-tauri/web/sessions/attention.mjs \
  native/macos/psyche-build-tauri/web/sessions/attention.d.mts \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  __tests__/tauriSessionAttention.test.ts
git commit -m "Track Coven interrupts separately from answers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Route Ctrl+C and all terminal text through one PTY input helper

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriSessionAttention.test.ts`

- [ ] **Step 1: Write failing desktop input-routing tests**

Add a local `functionSource` and `compileFunction` helper to
`__tests__/tauriSessionAttention.test.ts` if the file does not already expose
them, then add:

```ts
it('routes Ctrl+C to interrupt state and ordinary text to answer state', () => {
  const transitions: string[] = [];
  const noteThreadInput = compileFunction<
    (thread: { id: string }, text: string) => void
  >(functionSource(mainJs, 'noteThreadInput'), {
    threadWantsAttentionTracking: () => true,
    attentionTracker: {
      interrupt: () => {
        transitions.push('interrupt');
        return { needsAttention: false, reason: null };
      },
      userInput: () => {
        transitions.push('input');
        return { needsAttention: false, reason: null };
      },
    },
    applyThreadAttention: () => {},
  });

  noteThreadInput({ id: 'coven' }, '\x03');
  noteThreadInput({ id: 'coven' }, 'continue');
  expect(transitions).toEqual(['interrupt', 'input']);
});

it('uses the shared PTY writer for xterm typing and menu interrupts', () => {
  expect(mainJs).toMatch(
    /term\.onData\(function \(data\) \{[\s\S]{0,220}sendToThread\(thread, data\)/,
  );
  expect(mainJs).toMatch(
    /label: "Interrupt"[\s\S]{0,120}sendToThread\(thread, "\\x03"\)/,
  );
});
```

Replace the old assertion that requires `noteThreadUserInput(thread)` inside
`term.onData` with an assertion for `sendToThread(thread, data)`.

- [ ] **Step 2: Run the attention suite and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriSessionAttention.test.ts
```

Expected: FAIL because `noteThreadInput` does not exist and xterm still writes
directly through `invoke`.

- [ ] **Step 3: Add the shared attention transition helper**

Replace `noteThreadUserInput` in `main.js` with:

```js
function noteThreadInput(thread, text) {
  if (!thread || !threadWantsAttentionTracking(thread)) return;
  var next = text === "\x03"
    ? attentionTracker.interrupt(thread.id)
    : attentionTracker.userInput(thread.id);
  applyThreadAttention(thread, next);
}
```

- [ ] **Step 4: Make `sendToThread` the single PTY text path**

Replace `sendToThread` with:

```js
function sendToThread(thread, text) {
  if (!thread || thread.kind === "web") return Promise.resolve(false);
  noteThreadInput(thread, text);
  var bytes = Array.from(new TextEncoder().encode(text));
  return invoke("pty_write", {
    threadId: thread.id,
    thread_id: thread.id,
    bytes: bytes,
  }).then(function () {
    return true;
  }).catch(function (err) {
    if (thread.term) {
      thread.term.write("\r\n\x1b[31m[pty_write]\x1b[0m " + err + "\r\n");
    }
    return false;
  });
}
```

Replace the xterm `onData` body with:

```js
term.onData(function (data) {
  sendToThread(thread, data);
});
```

Keep both existing context-menu actions calling:

```js
sendToThread(thread, "\x03");
```

The composer and shell-sigil routes already call `sendToThread`; they now gain
the same attention and PTY error behavior without additional call sites.

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit shared input routing**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriSessionAttention.test.ts
git commit -m "Route Coven interrupts through attention state" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Add native Tauri image-drop targeting and insertion

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriTerminalImageDrop.test.ts`

- [ ] **Step 1: Write failing target-resolution and insertion tests**

Extend `__tests__/tauriTerminalImageDrop.test.ts` with the same
`functionSource` and `compileFunction` helpers used by the other Tauri source
tests, then add:

```ts
const mainJs = readFileSync(join(webRoot, 'main.js'), 'utf8');
const stylesCss = readFileSync(join(webRoot, 'styles.css'), 'utf8');

it('accepts only running started terminal threads', () => {
  const accepts = compileFunction<
    (thread: Record<string, unknown> | null) => boolean
  >(functionSource(mainJs, 'acceptsImageDrop'), {});

  expect(accepts({
    kind: 'coven-chat',
    status: 'running',
    ptyStarted: true,
    closing: false,
    closeStarted: false,
  })).toBe(true);
  expect(accepts({ kind: 'web', status: 'running', ptyStarted: false })).toBe(false);
  expect(accepts({ kind: 'shell', status: 'starting', ptyStarted: false })).toBe(false);
  expect(accepts({ kind: 'shell', status: 'failed', ptyStarted: false })).toBe(false);
  expect(accepts({ kind: 'shell', status: 'exited', ptyStarted: false })).toBe(false);
});

it('resolves the pane beneath physical drag coordinates', () => {
  const pane = {
    dataset: { threadId: 'thread-a' },
    closest: () => pane,
  };
  const thread = {
    id: 'thread-a',
    kind: 'shell',
    status: 'running',
    ptyStarted: true,
    closing: false,
    closeStarted: false,
  };
  const resolveImageDropTarget = compileFunction<
    (position: { x: number; y: number }, scale: number) => typeof thread | null
  >(functionSource(mainJs, 'resolveImageDropTarget'), {
    PsycheTerminalInput: inputModule,
    document: {
      elementFromPoint: (x: number, y: number) => {
        expect([x, y]).toEqual([150, 90]);
        return pane;
      },
    },
    findThread: (id: string) => id === thread.id ? thread : null,
    acceptsImageDrop: (candidate: unknown) => candidate === thread,
  });

  expect(resolveImageDropTarget({ x: 300, y: 180 }, 2)).toBe(thread);
});

it('focuses the target and inserts valid paths without Enter', async () => {
  const writes: string[] = [];
  const notices: string[] = [];
  const thread = { id: 'thread-a' };
  const insertDroppedImages = compileFunction<
    (thread: { id: string }, paths: string[]) => Promise<boolean>
  >(functionSource(mainJs, 'insertDroppedImages'), {
    PsycheTerminalInput: inputModule,
    focusThread: async () => true,
    findThread: () => thread,
    acceptsImageDrop: () => true,
    sendToThread: async (_thread: unknown, text: string) => {
      writes.push(text);
      return true;
    },
    toast: (message: string) => notices.push(message),
    setStatus: (message: string) => notices.push(message),
  });

  await expect(insertDroppedImages(thread, [
    '/tmp/a image.png',
    '/tmp/readme.md',
    '/tmp/b.jpg',
  ])).resolves.toBe(true);
  expect(writes).toEqual(["'/tmp/a image.png' '/tmp/b.jpg'"]);
  expect(writes[0]).not.toContain('\n');
  expect(notices).toContain('Inserted 2 images; skipped 1 unsupported file');
});

it('registers native drop and scale listeners and renders target feedback', () => {
  expect(functionSource(mainJs, 'installTerminalImageDrop')).toContain(
    'currentWindow.onDragDropEvent',
  );
  expect(functionSource(mainJs, 'installTerminalImageDrop')).toContain(
    'currentWindow.onScaleChanged',
  );
  expect(functionSource(mainJs, 'boot')).toContain(
    'await installTerminalImageDrop()',
  );
  expect(stylesCss).toContain('.terminal-pane.image-drop-target');
  expect(stylesCss).toContain('Drop images to insert paths');
});
```

- [ ] **Step 2: Run the image-drop test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriTerminalImageDrop.test.ts
```

Expected: FAIL because the native controller functions and CSS do not exist.

- [ ] **Step 3: Add drop target state and pure DOM resolution**

Near the other main-window state in `main.js`, add:

```js
var imageDropScaleFactor = 1;
var imageDropTarget = null;

function acceptsImageDrop(thread) {
  return !!thread
    && thread.kind !== "web"
    && !thread.closing
    && !thread.closeStarted
    && thread.status === "running"
    && thread.ptyStarted === true;
}

function resolveImageDropTarget(position, scaleFactor) {
  var point = PsycheTerminalInput.physicalToCssPosition(position, scaleFactor);
  if (!point) return null;
  var element = document.elementFromPoint(point.x, point.y);
  var pane = element && element.closest
    ? element.closest(".terminal-pane[data-thread-id]")
    : null;
  if (!pane || !pane.dataset.threadId) return null;
  var thread = findThread(pane.dataset.threadId);
  return acceptsImageDrop(thread) ? thread : null;
}

function clearImageDropTarget() {
  if (imageDropTarget && imageDropTarget.pane) {
    imageDropTarget.pane.classList.remove("image-drop-target");
  }
  imageDropTarget = null;
}

function setImageDropTarget(thread) {
  if (imageDropTarget === thread) return;
  clearImageDropTarget();
  if (!acceptsImageDrop(thread) || !thread.pane) return;
  imageDropTarget = thread;
  thread.pane.classList.add("image-drop-target");
}
```

- [ ] **Step 4: Add insertion and native event routing**

Add:

```js
async function insertDroppedImages(thread, paths) {
  var insertion = PsycheTerminalInput.buildImageDropInsertion(paths);
  if (!insertion.accepted.length) {
    toast("No supported images in this drop");
    return false;
  }
  if (!(await focusThread(thread.id))) {
    setStatus("Could not focus the image drop target", "warn");
    return false;
  }
  thread = findThread(thread.id);
  if (!acceptsImageDrop(thread)) {
    setStatus("Image drop target is no longer running", "warn");
    return false;
  }
  var sent = await sendToThread(thread, insertion.text);
  if (!sent) {
    setStatus("Could not insert dropped image paths", "error");
    return false;
  }
  if (insertion.skipped.length) {
    toast(
      "Inserted " + insertion.accepted.length + " image" +
      (insertion.accepted.length === 1 ? "" : "s") +
      "; skipped " + insertion.skipped.length + " unsupported file" +
      (insertion.skipped.length === 1 ? "" : "s")
    );
  }
  return true;
}

function handleTerminalImageDrop(event) {
  var payload = event && event.payload ? event.payload : {};
  if (payload.type === "leave") {
    clearImageDropTarget();
    return;
  }
  var target = resolveImageDropTarget(payload.position, imageDropScaleFactor);
  setImageDropTarget(target);
  if (payload.type !== "drop") return;
  clearImageDropTarget();
  if (!target) {
    toast("Drop images onto a running terminal pane");
    return;
  }
  insertDroppedImages(target, payload.paths);
}

async function installTerminalImageDrop() {
  if (!currentWindow ||
      typeof currentWindow.scaleFactor !== "function" ||
      typeof currentWindow.onDragDropEvent !== "function") {
    setStatus("image drop unavailable: Tauri window API missing", "warn");
    return false;
  }
  try {
    imageDropScaleFactor = await currentWindow.scaleFactor();
    if (typeof currentWindow.onScaleChanged === "function") {
      await currentWindow.onScaleChanged(function (event) {
        var next = Number(event && event.payload && event.payload.scaleFactor);
        if (Number.isFinite(next) && next > 0) imageDropScaleFactor = next;
        clearImageDropTarget();
      });
    }
    await currentWindow.onDragDropEvent(handleTerminalImageDrop);
    window.addEventListener("blur", clearImageDropTarget);
    return true;
  } catch (error) {
    clearImageDropTarget();
    setStatus("image drop unavailable: " + String(error), "warn");
    return false;
  }
}
```

Call it once near the start of `boot`, after assigning `state.env`:

```js
state.env = env || {};
await installTerminalImageDrop();
```

The app-lifetime listener does not need an unlisten handle because the main
webview owns it until window destruction.

- [ ] **Step 5: Add the drop-target overlay**

Add to `styles.css` near the terminal pane styles:

```css
.terminal-pane {
  position: relative;
}

.terminal-pane.image-drop-target {
  border-color: rgba(var(--rgb-accent), 0.9);
  box-shadow:
    0 0 0 1px rgba(var(--rgb-accent), 0.35),
    inset 0 0 0 999px rgba(var(--rgb-accent), 0.08);
}

.terminal-pane.image-drop-target::after {
  content: "Drop images to insert paths";
  position: absolute;
  z-index: 6;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 7px 11px;
  border: 1px solid rgba(var(--rgb-accent), 0.55);
  border-radius: 7px;
  background: var(--surface-1);
  color: var(--text);
  font-size: 11px;
  font-weight: 600;
  pointer-events: none;
}
```

- [ ] **Step 6: Run focused native-pane tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriTerminalImageDrop.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit native image drop**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriTerminalImageDrop.test.ts
git commit -m "Enable image drops in terminal panes" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Document and verify the complete interaction

**Files:**
- Modify: `docs/SMOKE.md`

- [ ] **Step 1: Add manual smoke coverage**

In the **Native Coven physical panes** list in `docs/SMOKE.md`, add these steps
after focus/input isolation and renumber the remaining steps:

```markdown
6. Type a partial prompt in Coven, drag PNG and JPEG files from Finder onto
   the pane, and confirm quoted absolute paths appear at the cursor without
   submitting the prompt.
7. Drop a mix of image and non-image files and confirm every image path is
   inserted in Finder order while Psyche reports the skipped file count.
8. Start a Coven turn, press Ctrl+C, and confirm the PTY remains running while
   the pane, session rail, and minimap return to **Waiting for you** after the
   prompt settles.
```

Add these expected results:

```markdown
- Finder image drops target only the running terminal pane under the pointer,
  never Web, editor, sidebar, failed, or exited surfaces.
- Image drops insert shell-safe paths only and never synthesize Enter.
- Ctrl+C leaves a healthy Coven PTY running and re-arms the local attention
  state for the returned prompt.
```

- [ ] **Step 2: Run the full focused regression set**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriTerminalImageDrop.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run type checking and rebuild browser assets**

Run:

```bash
pnpm typecheck
pnpm --dir native/macos/psyche-build-tauri build:web
git --no-pager diff --exit-code -- \
  native/macos/psyche-build-tauri/web/editor.bundle.js \
  native/macos/psyche-build-tauri/web/sessions.bundle.js \
  native/macos/psyche-build-tauri/web/panes.bundle.js \
  native/macos/psyche-build-tauri/web/input.bundle.js \
  native/macos/psyche-build-tauri/web/diffs.bundle.js
```

Expected: type checking passes, the web build passes, and the final diff check
shows every committed bundle already matches its source.

- [ ] **Step 4: Commit smoke documentation**

```bash
git add docs/SMOKE.md
git commit -m "Document terminal image drop smoke checks" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 5: Inspect the final change set**

Run:

```bash
git --no-pager status --short
git --no-pager log -5 --oneline --decorate
```

Expected: the worktree is clean and the task produced five implementation
commits after the design and plan commits.
