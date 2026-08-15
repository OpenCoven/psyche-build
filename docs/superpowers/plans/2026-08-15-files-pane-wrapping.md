# Files Pane Wrapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap long source lines in the native Files pane while preserving its existing focus-only accent glow.

**Architecture:** The Files editor is a single CodeMirror `EditorView` constructed by `web/editor/editor-entry.js`. Add CodeMirror's built-in `EditorView.lineWrapping` extension to each recreated state; pane focus styling stays in the existing `.terminal-pane.is-files.focused` CSS and requires no behavioral changes.

**Tech Stack:** JavaScript, CodeMirror 6, esbuild, Tauri native web bundle.

---

## File structure

- Modify: `native/desktop/psyche-build-tauri/web/editor/editor-entry.js` — defines the CodeMirror state used by every Files-pane document.
- Regenerate: `native/desktop/psyche-build-tauri/web/editor.bundle.js` — checked-in browser bundle produced by `pnpm build:web`.
- Create: `__tests__/nativeFileEditor.test.ts` — asserts the editor state enables CodeMirror's wrapping class.
- Do not modify: `native/desktop/psyche-build-tauri/web/styles.css` — it already implements the selected focus-only Files-pane accent border and glow.

### Task 1: Enable native CodeMirror line wrapping

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/editor/editor-entry.js:151-165`
- Regenerate: `native/desktop/psyche-build-tauri/web/editor.bundle.js`
- Create: `__tests__/nativeFileEditor.test.ts`

- [ ] **Step 1: Write the failing editor-state test**

Create `__tests__/nativeFileEditor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { createFileEditorState } from '../native/desktop/psyche-build-tauri/web/editor/editor-entry.js';

describe('native Files editor', () => {
  it('wraps long source lines', () => {
    const state = createFileEditorState({ text: 'x'.repeat(400) });
    const attributes = state.facet(EditorView.contentAttributes);

    expect(attributes.some((attribute) => attribute.class === 'cm-lineWrapping')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify the current state fails**

Run:

```bash
pnpm vitest --run __tests__/nativeFileEditor.test.ts
```

Expected: FAIL because no `cm-lineWrapping` attribute is present before the state extension is added.

- [ ] **Step 3: Add the minimal state extension**

Insert `EditorView.lineWrapping` after the workspace theme in `createFileEditorState`:

```js
extensions: [
  basicSetup,
  syntaxHighlighting(workspaceHighlightStyle),
  workspaceEditorTheme,
  EditorView.lineWrapping,
  extensionForLanguage(languageId),
  // remaining state extensions unchanged
],
```

Do not add CSS soft-wrap rules. CodeMirror must own visual-line layout so cursor motion, selection, gutters, and viewport calculation remain consistent.

- [ ] **Step 4: Run the focused test and build the checked-in native bundle**

Run:

```bash
pnpm vitest --run __tests__/nativeFileEditor.test.ts
```

Working directory: repository root.

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Working directory: repository root.

Expected: the focused test passes; the native bundle build exits `0` and regenerates `web/editor.bundle.js`.

- [ ] **Step 5: Verify both the source contract and focus-only relationship**

Run:

```bash
rg -n "EditorView\.lineWrapping" native/desktop/psyche-build-tauri/web/editor/editor-entry.js
rg -n -A7 "\.terminal-pane\.is-files\.focused" native/desktop/psyche-build-tauri/web/styles.css
git diff --check -- native/desktop/psyche-build-tauri/web/editor/editor-entry.js native/desktop/psyche-build-tauri/web/editor.bundle.js __tests__/nativeFileEditor.test.ts
```

Working directory: repository root.

Expected: the source reports one `EditorView.lineWrapping` entry; CSS reports the existing focused-only Files pane rule with accent border and glow; `git diff --check` exits `0`.

- [ ] **Step 6: Commit the verified implementation**

```bash
git add native/desktop/psyche-build-tauri/web/editor/editor-entry.js \
  native/desktop/psyche-build-tauri/web/editor.bundle.js \
  __tests__/nativeFileEditor.test.ts
git commit -m "fix: wrap lines in files pane"
```

Expected: one focused commit containing only the editor source and generated bundle.
