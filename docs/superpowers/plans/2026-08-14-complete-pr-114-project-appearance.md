# Complete PR #114 and Project Header Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and merge PR #114 by resolving its review and CI failures, removing the desktop `CURRENT` project badge, and adding locally persisted per-project accent and glyph customization.

**Architecture:** Keep remote-action scope unchanged: PsycheCore owns the reducer/store and PsycheApp owns reusable sheet presentation without app launch wiring. Add a pure project-appearance module to the desktop sessions bundle, while `main.js` owns local storage and DOM interaction. Project headers consume resolved appearance data through CSS variables, and the existing context-menu surface opens a keyboard-accessible non-modal customization popover.

**Tech Stack:** Swift 6, SwiftUI, XCTest, JavaScript ES modules, TypeScript/Vitest, Tauri webview HTML/CSS, esbuild, pnpm, GitHub CLI.

---

## File Structure

### New files

- `native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs`
  - Pure palette, glyph, path-normalization, hashing, parsing, resolution, and immutable update logic.
- `native/desktop/psyche-build-tauri/web/sessions/project-appearance.d.mts`
  - Type declarations for the pure appearance model.
- `__tests__/tauriProjectAppearance.test.ts`
  - Focused tests for normalization, deterministic defaults, validation, overrides, and reset behavior.

### Modified files

- `native/desktop/psyche-build-tauri/web/sessions/session-entry.js`
  - Re-export project-appearance APIs into `window.PsycheSessions`.
- `native/desktop/psyche-build-tauri/web/sessions.bundle.js`
  - Regenerated tracked sessions bundle.
- `native/desktop/psyche-build-tauri/web/main.js`
  - Load/save local appearance overrides, render accent/glyph hooks, remove `CURRENT`, open the project context menu, and manage the appearance popover.
- `native/desktop/psyche-build-tauri/web/styles.css`
  - Full-width project bands, active/inactive accent treatment, glyph styling, and appearance popover styling.
- `__tests__/tauriCovenSessionSiderail.test.ts`
  - Extend the fake DOM and sidebar harness for appearance, context-menu, persistence, and keyboard tests.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift`
  - Add the testable editable-field disabled-state helper.
- `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift`
  - Disable input and PR-summary fields while submitting.
- `native/ios/PsycheApp/UnitTests/ActionSheetPresentationTests.swift`
  - Verify editable fields follow submission state.
- `native/ios/PsycheCore/Tests/PsycheCoreTests/ControlMessagesTests.swift`
  - Use the documented 0–100 progress scale.
- `__tests__/reopenWorktreePopup.test.tsx`
  - Replace a fixed asynchronous sleep with a condition-based wait.
- `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift`
  - Give the known CI-only terminal replay assertion enough time under simulator load.

### PR metadata

- PR #114 title and description
  - Describe reusable native sheet support accurately, state that launch wiring is out of scope, and include the desktop project-header customization.
- PR #114 review threads
  - Reply where clarification is useful, then resolve all addressed threads.

---

### Task 1: Synchronize the PR Branch With `main`

**Files:**
- Potential merge resolution: `native/ios/Psyche.xcodeproj/project.pbxproj`
- Potential merge resolution: `docs/superpowers/specs/2026-08-12-swift-remote-action-reducer-sheet-design.md`
- Potential merge resolution: `docs/superpowers/plans/2026-08-12-swift-remote-action-reducer-sheet.md`

- [ ] **Step 1: Confirm the dedicated worktree is clean**

Run:

```bash
git -C .worktrees/swift-remote-action-sheet status --short --branch
```

Expected: branch `feat/swift-remote-action-sheet`; only this newly committed plan may be ahead of the remote, with no unstaged files.

- [ ] **Step 2: Fetch and merge current `main` without rewriting the published branch**

Run:

```bash
git -C .worktrees/swift-remote-action-sheet fetch origin
git -C .worktrees/swift-remote-action-sheet merge --no-edit origin/main
```

Expected: a merge commit, or explicit conflicts to resolve. Do not rebase or force-push the shared PR branch.

- [ ] **Step 3: Resolve generated Xcode project conflicts deterministically**

If `native/ios/Psyche.xcodeproj/project.pbxproj` conflicts, run:

```bash
git -C .worktrees/swift-remote-action-sheet checkout --theirs native/ios/Psyche.xcodeproj/project.pbxproj
pnpm --dir .worktrees/swift-remote-action-sheet ios:project:generate
git -C .worktrees/swift-remote-action-sheet add native/ios/Psyche.xcodeproj/project.pbxproj
```

Expected: XcodeGen recreates entries for both current `main` and the remote-action files because `project.yml` includes the source and test directories.

- [ ] **Step 4: Resolve documentation conflicts by preserving the implemented behavior**

For either remote-action design/plan conflict, keep the branch statements that:

```markdown
- Progress is always dismissable because the protocol has no continuation/update channel.
- Input and PR-review failures preserve attempted text for recovery.
- Launch-menu and PsycheApp presentation wiring are outside this PR.
```

Also retain unrelated additions from `origin/main`, then stage the resolved documents:

```bash
git -C .worktrees/swift-remote-action-sheet add \
  docs/superpowers/specs/2026-08-12-swift-remote-action-reducer-sheet-design.md \
  docs/superpowers/plans/2026-08-12-swift-remote-action-reducer-sheet.md
git -C .worktrees/swift-remote-action-sheet commit --no-edit
```

Expected: the merge completes with no unmerged paths.

- [ ] **Step 5: Verify the merge result still contains the PR implementation**

Run:

```bash
test -f .worktrees/swift-remote-action-sheet/native/ios/PsycheCore/Sources/PsycheCore/State/RemoteActionStore.swift
test -f .worktrees/swift-remote-action-sheet/native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift
git -C .worktrees/swift-remote-action-sheet status --short --branch
```

Expected: both files exist and the worktree has no unmerged or unstaged files.

---

### Task 2: Stabilize the Two Existing CI Failures

**Files:**
- Modify: `__tests__/reopenWorktreePopup.test.tsx:1-8,283-289`
- Modify: `native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift:82-95`

- [ ] **Step 1: Reproduce the asynchronous branch-render race**

Run from the PR worktree:

```bash
cd .worktrees/swift-remote-action-sheet
for run in 1 2 3 4 5; do
  pnpm vitest --run __tests__/reopenWorktreePopup.test.tsx || exit 1
done
```

Expected before the fix: the test may intermittently fail because `sleep(50)` can expire before React/Ink commits the remote branch render.

- [ ] **Step 2: Replace the fixed sleep with a condition-based wait**

Change the failing test to wait for both the loader call and rendered branch:

```tsx
    await vi.waitFor(() => {
      expect(loadRemoteBranches).toHaveBeenCalledWith('/repo-selected', []);
      expect(stripAnsi(lastFrame() ?? '')).toContain('remote-only');
    });

    const output = stripAnsi(lastFrame() ?? '');
    expect(output).toContain('Remote');
```

Remove the previous `await sleep(50)` and duplicate loader/`remote-only` assertions. Keep the `sleep()` helper because other interaction tests still use it.

- [ ] **Step 3: Run the branch popup test repeatedly**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
for run in 1 2 3 4 5; do
  pnpm vitest --run __tests__/reopenWorktreePopup.test.tsx || exit 1
done
```

Expected: all five runs pass.

- [ ] **Step 4: Increase only the terminal replay assertion timeout**

Change the output assertion in `testOpeningAPaneRendersItsTerminalOutput()` to:

```swift
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS[c] %@", "Waiting for review input")
            ).firstMatch.waitForExistence(timeout: 20),
            "Fixture terminal output did not become accessible before the simulator timeout"
        )
```

Keep the terminal container existence timeout at 10 seconds. This targets the CI failure, where the pane existed but fixture output accessibility arrived after the second 10-second wait.

- [ ] **Step 5: Run the targeted UI test**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-ui \
  -only-testing:PsycheAppUITests/PsycheAppUITests/testOpeningAPaneRendersItsTerminalOutput
```

Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 6: Commit the CI stabilization**

```bash
git -C .worktrees/swift-remote-action-sheet add \
  __tests__/reopenWorktreePopup.test.tsx \
  native/ios/PsycheApp/Tests/PsycheAppUITests/PsycheAppUITests.swift
git -C .worktrees/swift-remote-action-sheet commit -m "test: stabilize PR blocking checks" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one test-only commit.

---

### Task 3: Apply the Native Review Fixes

**Files:**
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift`
- Modify: `native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift:75-112,145-158`
- Modify: `native/ios/PsycheApp/UnitTests/ActionSheetPresentationTests.swift`
- Modify: `native/ios/PsycheCore/Tests/PsycheCoreTests/ControlMessagesTests.swift:294-376`

- [ ] **Step 1: Write the failing submission-state helper test**

Add to `ActionSheetPresentationTests`:

```swift
    func testEditableFieldsDisableOnlyWhileSubmitting() {
        XCTAssertFalse(ActionSheetPresentation.editingDisabled(isSubmitting: false))
        XCTAssertTrue(ActionSheetPresentation.editingDisabled(isSubmitting: true))
    }
```

- [ ] **Step 2: Run the focused app unit test and verify it fails**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-app \
  -only-testing:PsycheAppTests/ActionSheetPresentationTests/testEditableFieldsDisableOnlyWhileSubmitting
```

Expected: compile failure because `editingDisabled(isSubmitting:)` does not exist.

- [ ] **Step 3: Add the minimal presentation helper**

Add inside `enum ActionSheetPresentation`:

```swift
    static func editingDisabled(isSubmitting: Bool) -> Bool {
        isSubmitting
    }
```

- [ ] **Step 4: Apply the helper to both editable fields**

Update the input field:

```swift
                TextField(
                    input.placeholder ?? "Response",
                    text: $draft,
                    axis: .vertical
                )
                .lineLimit(ActionSheetPresentation.inputLineRange(input.maxVisibleLines))
                .disabled(ActionSheetPresentation.editingDisabled(
                    isSubmitting: store.isSubmitting
                ))
```

Update the PR-summary field:

```swift
            TextField("Summary", text: $draft, axis: .vertical)
                .lineLimit(1...12)
                .disabled(ActionSheetPresentation.editingDisabled(
                    isSubmitting: store.isSubmitting
                ))
```

- [ ] **Step 5: Correct the progress fixture and every matching assertion**

In `testConstructedActionResultPreservesEveryPresentationField()`, replace all three `0.75` values with `75.0`:

```swift
            progress: 75.0,
```

```swift
        XCTAssertEqual(result.progress, 75.0)
```

```swift
        XCTAssertEqual(
            try XCTUnwrap(encodedResult["progress"] as? NSNumber).doubleValue,
            75.0
        )
```

- [ ] **Step 6: Run the focused native tests**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-core \
  -only-testing:PsycheCoreTests/ControlMessagesTests/testConstructedActionResultPreservesEveryPresentationField

xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-app \
  -only-testing:PsycheAppTests/ActionSheetPresentationTests
```

Expected: both commands end with `** TEST SUCCEEDED **`.

- [ ] **Step 7: Commit the review fixes**

```bash
git -C .worktrees/swift-remote-action-sheet add \
  native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetPresentation.swift \
  native/ios/PsycheApp/Sources/PsycheApp/Views/ActionSheetView.swift \
  native/ios/PsycheApp/UnitTests/ActionSheetPresentationTests.swift \
  native/ios/PsycheCore/Tests/PsycheCoreTests/ControlMessagesTests.swift
git -C .worktrees/swift-remote-action-sheet commit -m "fix: address remote action sheet review" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one native review-fix commit.

---

### Task 4: Build the Pure Project Appearance Model

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs`
- Create: `native/desktop/psyche-build-tauri/web/sessions/project-appearance.d.mts`
- Create: `__tests__/tauriProjectAppearance.test.ts`
- Modify: `native/desktop/psyche-build-tauri/web/sessions/session-entry.js`
- Modify generated: `native/desktop/psyche-build-tauri/web/sessions.bundle.js`

- [ ] **Step 1: Write the failing pure-model tests**

Create `__tests__/tauriProjectAppearance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  parseProjectAppearances,
  normalizeProjectAppearanceKey,
  resolveProjectAppearance,
  updateProjectAppearance,
} from '../native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs';

describe('desktop project appearance model', () => {
  it.each([
    ['/repo/project/', '/repo/project'],
    ['C:\\Users\\Buns\\project\\', 'c:/Users/Buns/project'],
    ['/', '/'],
    ['C:\\', 'c:/'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeProjectAppearanceKey(input)).toBe(expected);
  });

  it('resolves a stable automatic accent and no automatic glyph', () => {
    const first = resolveProjectAppearance(
      { root: '/repo/project', name: 'Project' },
      {},
    );
    const second = resolveProjectAppearance(
      { root: '/repo/project/', name: 'Renamed' },
      {},
    );

    expect(second.accent).toEqual(first.accent);
    expect(first.glyph).toBeNull();
    expect(first.customized).toBe(false);
  });

  it('accepts accent-only, glyph-only, and complete overrides', () => {
    const key = '/repo/project';

    expect(resolveProjectAppearance(
      { root: key, name: 'Project' },
      { [key]: { accent: 'violet' } },
    )).toMatchObject({ accent: { id: 'violet' }, glyph: null, customized: true });

    expect(resolveProjectAppearance(
      { root: key, name: 'Project' },
      { [key]: { glyph: 'spark' } },
    )).toMatchObject({ glyph: { id: 'spark' }, customized: true });

    expect(resolveProjectAppearance(
      { root: key, name: 'Project' },
      { [key]: { accent: 'teal', glyph: 'terminal' } },
    )).toMatchObject({
      accent: { id: 'teal' },
      glyph: { id: 'terminal' },
      customized: true,
    });
  });

  it('ignores malformed JSON and unsupported preset ids', () => {
    expect(parseProjectAppearances('{')).toEqual({});
    expect(parseProjectAppearances(JSON.stringify({
      '/repo/project': { accent: 'url(javascript:bad)', glyph: '<script>' },
    }))).toEqual({});
  });

  it('updates immutably, clears individual fields, and resets the entry', () => {
    const original = { '/repo/project': { accent: 'ruby', glyph: 'spark' } };
    const withoutGlyph = updateProjectAppearance(
      original,
      '/repo/project',
      { glyph: null },
    );
    const reset = updateProjectAppearance(withoutGlyph, '/repo/project', null);

    expect(original['/repo/project']).toEqual({ accent: 'ruby', glyph: 'spark' });
    expect(withoutGlyph).toEqual({ '/repo/project': { accent: 'ruby' } });
    expect(reset).toEqual({});
  });
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm vitest --run __tests__/tauriProjectAppearance.test.ts
```

Expected: module-not-found failure for `project-appearance.mjs`.

- [ ] **Step 3: Implement the complete pure model**

Create `project-appearance.mjs`:

```js
export const PROJECT_ACCENTS = Object.freeze([
  Object.freeze({ id: 'ruby', label: 'Ruby', rgb: '239 86 100' }),
  Object.freeze({ id: 'amber', label: 'Amber', rgb: '232 166 67' }),
  Object.freeze({ id: 'lime', label: 'Lime', rgb: '137 201 92' }),
  Object.freeze({ id: 'teal', label: 'Teal', rgb: '64 190 159' }),
  Object.freeze({ id: 'cyan', label: 'Cyan', rgb: '65 185 218' }),
  Object.freeze({ id: 'blue', label: 'Blue', rgb: '86 139 235' }),
  Object.freeze({ id: 'violet', label: 'Violet', rgb: '145 111 235' }),
  Object.freeze({ id: 'magenta', label: 'Magenta', rgb: '215 91 180' }),
]);

export const PROJECT_GLYPHS = Object.freeze([
  Object.freeze({ id: 'spark', label: 'Spark', value: '✦' }),
  Object.freeze({ id: 'diamond', label: 'Diamond', value: '◆' }),
  Object.freeze({ id: 'command', label: 'Command', value: '⌘' }),
  Object.freeze({ id: 'branch', label: 'Branch', value: '⑂' }),
  Object.freeze({ id: 'terminal', label: 'Terminal', value: '>_' }),
  Object.freeze({ id: 'moon', label: 'Moon', value: '☾' }),
  Object.freeze({ id: 'bolt', label: 'Bolt', value: 'ϟ' }),
  Object.freeze({ id: 'circle', label: 'Circle', value: '◉' }),
]);

const accentsById = new Map(PROJECT_ACCENTS.map((accent) => [accent.id, accent]));
const glyphsById = new Map(PROJECT_GLYPHS.map((glyph) => [glyph.id, glyph]));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function normalizeProjectAppearanceKey(root, fallback = '') {
  let value = typeof root === 'string' && root.trim()
    ? root.trim()
    : String(fallback || '').trim();
  if (!value) return '';
  value = value.replaceAll('\\', '/');
  if (/^[A-Z]:\//.test(value)) {
    value = value[0].toLowerCase() + value.slice(1);
  }
  if (value !== '/' && !/^[a-z]:\/$/i.test(value)) {
    value = value.replace(/\/+$/, '');
  }
  return value;
}

export function stableProjectAppearanceHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function sanitizeProjectAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const sanitized = {};
  if (typeof value.accent === 'string' && accentsById.has(value.accent)) {
    sanitized.accent = value.accent;
  }
  if (typeof value.glyph === 'string' && glyphsById.has(value.glyph)) {
    sanitized.glyph = value.glyph;
  }
  return sanitized;
}

export function parseProjectAppearances(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([rawKey, value]) => {
      const key = normalizeProjectAppearanceKey(rawKey);
      const appearance = sanitizeProjectAppearance(value);
      return key && Object.keys(appearance).length ? [[key, appearance]] : [];
    }));
  } catch {
    return {};
  }
}

export function resolveProjectAppearance(project, appearances = {}) {
  const key = normalizeProjectAppearanceKey(project?.root, project?.name);
  const automaticAccent = PROJECT_ACCENTS[
    stableProjectAppearanceHash(key) % PROJECT_ACCENTS.length
  ];
  const stored = sanitizeProjectAppearance(appearances[key]);
  return Object.freeze({
    key,
    accent: accentsById.get(stored.accent) ?? automaticAccent,
    glyph: glyphsById.get(stored.glyph) ?? null,
    customized: Boolean(stored.accent || stored.glyph),
    override: Object.freeze(stored),
  });
}

export function updateProjectAppearance(appearances, rawKey, patch) {
  const key = normalizeProjectAppearanceKey(rawKey);
  if (!key) return { ...appearances };
  const nextAppearances = { ...appearances };
  if (patch === null) {
    delete nextAppearances[key];
    return nextAppearances;
  }

  const next = { ...sanitizeProjectAppearance(appearances[key]) };
  if (hasOwn(patch, 'accent')) {
    if (patch.accent === null) delete next.accent;
    else if (accentsById.has(patch.accent)) next.accent = patch.accent;
  }
  if (hasOwn(patch, 'glyph')) {
    if (patch.glyph === null) delete next.glyph;
    else if (glyphsById.has(patch.glyph)) next.glyph = patch.glyph;
  }

  if (Object.keys(next).length) nextAppearances[key] = next;
  else delete nextAppearances[key];
  return nextAppearances;
}
```

- [ ] **Step 4: Add matching declarations**

Create `project-appearance.d.mts`:

```ts
export interface ProjectAccent {
  readonly id: string;
  readonly label: string;
  readonly rgb: string;
}

export interface ProjectGlyph {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ProjectAppearanceOverride {
  readonly accent?: string;
  readonly glyph?: string;
}

export interface ResolvedProjectAppearance {
  readonly key: string;
  readonly accent: ProjectAccent;
  readonly glyph: ProjectGlyph | null;
  readonly customized: boolean;
  readonly override: Readonly<ProjectAppearanceOverride>;
}

export const PROJECT_ACCENTS: readonly ProjectAccent[];
export const PROJECT_GLYPHS: readonly ProjectGlyph[];

export function normalizeProjectAppearanceKey(root?: string, fallback?: string): string;
export function stableProjectAppearanceHash(value: string): number;
export function sanitizeProjectAppearance(value: unknown): ProjectAppearanceOverride;
export function parseProjectAppearances(raw: string): Record<string, ProjectAppearanceOverride>;
export function resolveProjectAppearance(
  project: { root?: string; name?: string },
  appearances?: Record<string, ProjectAppearanceOverride>,
): ResolvedProjectAppearance;
export function updateProjectAppearance(
  appearances: Record<string, ProjectAppearanceOverride>,
  key: string,
  patch: ProjectAppearanceOverride | { accent?: string | null; glyph?: string | null } | null,
): Record<string, ProjectAppearanceOverride>;
```

- [ ] **Step 5: Export the model from the sessions bundle**

Append to `session-entry.js`:

```js
export {
  normalizeProjectAppearanceKey,
  parseProjectAppearances,
  PROJECT_ACCENTS,
  PROJECT_GLYPHS,
  resolveProjectAppearance,
  sanitizeProjectAppearance,
  stableProjectAppearanceHash,
  updateProjectAppearance,
} from './project-appearance.mjs';
```

- [ ] **Step 6: Run tests, build the bundle, and rerun tests**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm vitest --run __tests__/tauriProjectAppearance.test.ts
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm vitest --run __tests__/tauriProjectAppearance.test.ts __tests__/tauriWebBundles.test.ts
```

Expected: all tests pass and `sessions.bundle.js` is regenerated.

- [ ] **Step 7: Commit the pure model**

```bash
git -C .worktrees/swift-remote-action-sheet add \
  __tests__/tauriProjectAppearance.test.ts \
  native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs \
  native/desktop/psyche-build-tauri/web/sessions/project-appearance.d.mts \
  native/desktop/psyche-build-tauri/web/sessions/session-entry.js \
  native/desktop/psyche-build-tauri/web/sessions.bundle.js
git -C .worktrees/swift-remote-action-sheet commit -m "feat: add project appearance model" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one model/bundle commit.

---

### Task 5: Render Distinct Project Header Bands and Remove `CURRENT`

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:730-865,5886-5955,6235-6275`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`

- [ ] **Step 1: Extend the fake element with CSS custom-property support**

Extend the test-side `PsycheSessions` assembly with the new pure model:

```ts
  ...(await import(pathToFileURL(join(
    repoRoot,
    'native/desktop/psyche-build-tauri/web/sessions/project-appearance.mjs',
  )).href)),
```

Add to `FakeElement`:

```ts
  readonly styleValues = new Map<string, string>();
  readonly style = {
    left: '',
    top: '',
    setProperty: (name: string, value: string) => {
      this.styleValues.set(name, value);
    },
    getPropertyValue: (name: string) => this.styleValues.get(name) ?? '',
  };
```

- [ ] **Step 2: Add failing renderer assertions**

In the primary project-rail test, add:

```ts
    const project = renderer.sessionListEl.querySelector('.session-project');
    const projectHead = renderer.sessionListEl.querySelector('.session-project-head');

    expect(project?.classList.contains('is-current')).toBe(true);
    expect(project?.dataset.projectAccent).toMatch(
      /^(ruby|amber|lime|teal|cyan|blue|violet|magenta)$/,
    );
    expect(projectHead?.style.getPropertyValue('--project-accent-rgb'))
      .toMatch(/^\d+ \d+ \d+$/);
    expect(renderer.sessionListEl.querySelector('.session-current-badge')).toBeNull();
    expect(projectHead?.textContent).not.toContain('CURRENT');
    expect(renderer.sessionListEl.querySelector('.session-project-glyph')).toBeNull();
```

Add a second test that seeds:

```ts
projectAppearances: {
  '/repo/psyche-build': { accent: 'violet', glyph: 'spark' },
},
```

and expects:

```ts
    expect(project?.dataset.projectAccent).toBe('violet');
    expect(project?.dataset.projectAppearance).toBe('custom');
    expect(projectHead?.style.getPropertyValue('--project-accent-rgb')).toBe('145 111 235');
    const glyph = renderer.sessionListEl.querySelector('.session-project-glyph');
    expect(glyph?.textContent).toBe('✦');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
```

Update `createRenderer()` options and harness state to accept:

```ts
  projectAppearances?: Record<string, { accent?: string; glyph?: string }>;
  storageSetError?: Error;
```

and define:

```ts
  let projectAppearances = options.projectAppearances ?? {};
  const localStorage = {
    getItem: vi.fn(() => JSON.stringify(projectAppearances)),
    setItem: vi.fn(() => {
      if (options.storageSetError) throw options.storageSetError;
    }),
  };
```

Include `saveProjectAppearances` and `applyProjectAppearance` in the evaluated
source list, inject `localStorage`, and expose both `applyProjectAppearance` and
the mutable appearance map through the returned harness.

Add a storage-failure test:

```ts
  it('keeps the in-memory appearance and reports local storage failures', () => {
    const renderer = createRenderer({
      storageSetError: new Error('quota exceeded'),
    });

    expect(renderer.applyProjectAppearance(
      renderer.state.projects[0],
      { accent: 'violet' },
    )).toBe(true);

    expect(renderer.setStatus).toHaveBeenCalledWith(
      'project appearance save failed: Error: quota exceeded',
      'error',
    );
    expect(renderer.projectAppearances()).toEqual({
      '/alpha': { accent: 'violet' },
    });
    expect(renderer.sessionListEl.querySelector('.session-project')
      ?.dataset.projectAccent).toBe('violet');
  });
```

- [ ] **Step 3: Run the sidebar test and verify it fails**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: failures because `CURRENT` still renders and appearance hooks are absent.

- [ ] **Step 4: Add local appearance loading and persistence**

Near the existing settings keys in `main.js`, add:

```js
  var PROJECT_APPEARANCES_KEY = "psyche.tauri.project-appearances.v1";
  var projectAppearances = loadProjectAppearances();

  function loadProjectAppearances() {
    try {
      return PsycheSessions.parseProjectAppearances(
        localStorage.getItem(PROJECT_APPEARANCES_KEY) || "{}"
      );
    } catch (_) {
      return {};
    }
  }

  function saveProjectAppearances() {
    try {
      localStorage.setItem(
        PROJECT_APPEARANCES_KEY,
        JSON.stringify(projectAppearances)
      );
      return true;
    } catch (error) {
      setStatus("project appearance save failed: " + String(error), "error");
      return false;
    }
  }

  function applyProjectAppearance(project, patch) {
    var key = PsycheSessions.normalizeProjectAppearanceKey(
      project && project.root,
      project && project.name
    );
    if (!project || !project.root || !key) return false;
    projectAppearances = PsycheSessions.updateProjectAppearance(
      projectAppearances,
      key,
      patch
    );
    saveProjectAppearances();
    renderSessionList();
    restoreSessionTreeFocus(sessionTreeFocusKey);
    return true;
  }
```

The load catch is intentionally render-safe. The save catch is not silent; it reports through the existing status surface while preserving the in-memory selection.

- [ ] **Step 5: Render resolved appearance and remove the badge**

In `createProjectGroup()`, immediately after creating `head`, add:

```js
    var appearance = options.appearance;
    if (appearance) {
      group.dataset.projectAccent = appearance.accent.id;
      group.dataset.projectAppearance = appearance.customized ? "custom" : "automatic";
      head.style.setProperty("--project-accent-rgb", appearance.accent.rgb);
    }
```

Create the optional glyph before the title without appending it yet:

```js
    var glyph = null;
    if (appearance && appearance.glyph) {
      glyph = document.createElement("span");
      glyph.className = "session-project-glyph";
      glyph.textContent = appearance.glyph.value;
      glyph.setAttribute("aria-hidden", "true");
    }
```

Delete the complete block that creates `session-current-badge` and appends `CURRENT`.

Replace the final project-header append order with:

```js
    head.appendChild(disclosure);
    if (glyph) head.appendChild(glyph);
    head.appendChild(title);
    head.appendChild(count);
```

In `renderSessionList()`, resolve appearance before calling `createProjectGroup()`:

```js
      var projectAppearance = PsycheSessions.resolveProjectAppearance(
        project,
        projectAppearances
      );
      var projectParts = createProjectGroup(projectModel, {
        current: project.id === state.activeProjectId,
        tabindex: "-1",
        appearance: projectAppearance,
      });
```

Update the sidebar test harness to include real `PsycheSessions.resolveProjectAppearance()` and the seeded `projectAppearances` variable on the evaluated render path.

- [ ] **Step 6: Add the full-width header treatment**

Append dedicated rules after the existing sidebar design passes in `styles.css`:

```css
.session-project-head {
  min-height: 34px;
  margin: 0 2px;
  padding: 6px 8px;
  border: 1px solid rgb(var(--project-accent-rgb) / 0.16);
  border-radius: 9px;
  background:
    linear-gradient(
      105deg,
      rgb(var(--project-accent-rgb) / 0.14),
      rgb(var(--project-accent-rgb) / 0.06)
    ),
    rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.94));
  color: color-mix(in srgb, rgb(var(--project-accent-rgb)) 52%, var(--text-soft));
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.035);
}

.session-project.is-current > .session-project-head {
  border-color: rgb(var(--project-accent-rgb) / 0.42);
  background:
    linear-gradient(
      105deg,
      rgb(var(--project-accent-rgb) / 0.30),
      rgb(var(--project-accent-rgb) / 0.12)
    ),
    rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.94));
  color: color-mix(in srgb, rgb(var(--project-accent-rgb)) 28%, var(--text));
  box-shadow:
    0 5px 14px rgba(0, 0, 0, 0.16),
    inset 0 1px rgba(255, 255, 255, 0.06);
}

.session-project-head:hover {
  color: var(--text);
  box-shadow:
    inset 0 0 0 999px rgba(255, 255, 255, 0.045),
    inset 0 1px rgba(255, 255, 255, 0.05);
}

.session-project:focus-visible > .session-project-head {
  outline: 2px solid rgb(var(--project-accent-rgb) / 0.88);
  outline-offset: -2px;
}

.session-project-glyph {
  flex: 0 0 auto;
  width: 16px;
  color: rgb(var(--project-accent-rgb));
  font-size: 13px;
  line-height: 1;
  text-align: center;
  text-transform: none;
}

.session-project-name {
  min-width: 0;
  overflow: hidden;
  color: inherit;
  font-weight: 750;
  text-overflow: ellipsis;
}
```

- [ ] **Step 7: Run the focused desktop tests**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm vitest --run \
  __tests__/tauriProjectAppearance.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: both files pass.

- [ ] **Step 8: Commit header rendering and persistence**

```bash
git -C .worktrees/swift-remote-action-sheet add \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/styles.css \
  __tests__/tauriCovenSessionSiderail.test.ts
git -C .worktrees/swift-remote-action-sheet commit -m "feat: style desktop project headers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one desktop header/persistence commit.

---

### Task 6: Add Project Appearance Context Menu and Popover

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/main.js:4437-4495,6039-6090,6240-6300`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`

- [ ] **Step 1: Extend keyboard event support in the fake DOM**

Change `FakeEvent` and `emit()` so tests can express Shift+F10:

```ts
class FakeEvent {
  target: FakeElement;
  key: string;
  shiftKey: boolean;
  clientX = 0;
  clientY = 0;
  propagationStopped = false;
  defaultPrevented = false;

  constructor(target: FakeElement, key = '', shiftKey = false) {
    this.target = target;
    this.key = key;
    this.shiftKey = shiftKey;
  }
  // Existing methods remain unchanged.
}
```

```ts
  async emit(
    name: string,
    options: { target?: FakeElement; key?: string; shiftKey?: boolean } = {},
  ) {
    const event = new FakeEvent(
      options.target ?? this,
      options.key,
      options.shiftKey ?? false,
    );
    for (const listener of this.listeners.get(name) ?? []) {
      await listener(event);
    }
    return event;
  }
```

Add a stable rectangle to `FakeElement`:

```ts
  getBoundingClientRect() {
    return {
      left: 20,
      top: 20,
      right: 220,
      bottom: 54,
      width: 200,
      height: 34,
    };
  }
```

- [ ] **Step 2: Write failing context-menu tests**

Add a renderer spy:

```ts
  const openProjectAppearancePopover = vi.fn();
```

Inject it into the evaluated render harness and expose it in the returned renderer.

Add tests:

```ts
  it('opens project appearance customization from the project context menu', async () => {
    const renderer = createRenderer();
    renderer.render();

    const project = renderer.sessionListEl.querySelector('.session-project');
    const head = renderer.sessionListEl.querySelector('.session-project-head');
    await head?.emit('contextmenu');

    expect(renderer.openSessionContextMenu).toHaveBeenCalledOnce();
    const [, actions, anchor] = renderer.openSessionContextMenu.mock.calls[0];
    expect(actions.map((action: { label: string }) => action.label))
      .toContain('Customize appearance');
    expect(anchor).toBe(project);

    actions.find((action: { label: string }) =>
      action.label === 'Customize appearance').run();
    expect(renderer.openProjectAppearancePopover)
      .toHaveBeenCalledWith(expect.objectContaining({ root: '/alpha' }), project);
  });

  it.each([
    ['ContextMenu', false],
    ['F10', true],
  ])('opens the project context menu with %s', (key, shiftKey) => {
    const renderer = createRenderer();
    renderer.render();
    const project = renderer.sessionListEl.querySelector('.session-project')!;
    project.focus();
    const event = new FakeEvent(project, key, shiftKey);

    renderer.handleTreeKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(renderer.openSessionContextMenu).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 3: Run the sidebar test and verify it fails**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: context-menu and keyboard assertions fail.

- [ ] **Step 4: Make the generic context menu anchor-aware**

Change the signature and positioning in `openSessionContextMenu()`:

```js
  function openSessionContextMenu(event, actions, anchor) {
    event.preventDefault();
    event.stopPropagation();
    closeSessionContextMenu();
    var menu = document.createElement("div");
    menu.className = "session-context-menu";
    menu.setAttribute("role", "menu");
    var anchorRect = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : null;
    var eventX = Number(event.clientX);
    var eventY = Number(event.clientY);
    menu.style.left = Math.max(
      8,
      eventX > 0 ? eventX : anchorRect ? anchorRect.left + 12 : 8
    ) + "px";
    menu.style.top = Math.max(
      8,
      eventY > 0 ? eventY : anchorRect ? anchorRect.bottom : 8
    ) + "px";
    // Keep the existing action creation, viewport clamping, and focus logic.
  }
```

Existing two-argument callers continue to use pointer coordinates.

- [ ] **Step 5: Add project context actions**

Add:

```js
  function projectAppearanceContextActions(project, anchor) {
    return [{
      label: "Customize appearance",
      run: function () {
        openProjectAppearancePopover(project, anchor);
      },
    }];
  }

  function openProjectContextMenu(event, project, anchor) {
    openSessionContextMenu(
      event,
      projectAppearanceContextActions(project, anchor),
      anchor
    );
  }
```

In `createProjectGroup()`, set:

```js
    group.dataset.projectId = projectModel.project.id;
```

In `renderSessionList()`, add:

```js
      projectParts.head.addEventListener("contextmenu", function (event) {
        openProjectContextMenu(event, project, projectParts.group);
      });
```

In `handleSessionTreeKeydown()`, before arrow handling, add:

```js
    var opensContextMenu = event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey);
    if (opensContextMenu && item.dataset.treeItem === "project") {
      var project = findProject(item.dataset.projectId);
      if (!project) return;
      event.preventDefault();
      event.stopPropagation();
      openProjectContextMenu(event, project, item);
      return;
    }
```

- [ ] **Step 6: Implement the non-modal appearance popover**

Add one global popover reference and close helper beside the context-menu state:

```js
  var projectAppearancePopover = null;

  function closeProjectAppearancePopover(options) {
    var current = projectAppearancePopover;
    if (!current) return;
    projectAppearancePopover = null;
    if (current.element.parentNode) current.element.parentNode.removeChild(current.element);
    if (!options || options.restoreFocus !== false) {
      restoreSessionTreeFocus(current.treeKey);
    }
  }
```

Implement `openProjectAppearancePopover(project, anchor)` with staged selections:

```js
  function openProjectAppearancePopover(project, anchor) {
    closeProjectAppearancePopover({ restoreFocus: false });
    var appearance = PsycheSessions.resolveProjectAppearance(
      project,
      projectAppearances
    );
    var draftAccent = appearance.override.accent || null;
    var draftGlyph = appearance.override.glyph || null;
    var panel = document.createElement("div");
    panel.className = "project-appearance-popover";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Customize " + project.name + " appearance");

    var heading = document.createElement("div");
    heading.className = "project-appearance-title";
    heading.textContent = project.name;
    panel.appendChild(heading);

    var accentLabel = document.createElement("div");
    accentLabel.className = "project-appearance-label";
    accentLabel.textContent = draftAccent
      ? "Accent"
      : "Accent · Automatic " + appearance.accent.label;
    panel.appendChild(accentLabel);

    var accentGrid = document.createElement("div");
    accentGrid.className = "project-appearance-grid accent-grid";
    accentGrid.setAttribute("role", "group");
    accentGrid.setAttribute("aria-label", "Project accent");
    PsycheSessions.PROJECT_ACCENTS.forEach(function (accent) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "project-appearance-swatch";
      button.title = accent.label;
      button.setAttribute("aria-label", accent.label);
      button.setAttribute("aria-pressed", accent.id === draftAccent ? "true" : "false");
      button.style.setProperty("--project-accent-rgb", accent.rgb);
      button.addEventListener("click", function () {
        draftAccent = accent.id;
        Array.prototype.forEach.call(accentGrid.children, function (candidate) {
          candidate.setAttribute(
            "aria-pressed",
            candidate === button ? "true" : "false"
          );
        });
      });
      accentGrid.appendChild(button);
    });
    panel.appendChild(accentGrid);

    var glyphLabel = document.createElement("div");
    glyphLabel.className = "project-appearance-label";
    glyphLabel.textContent = "Glyph";
    panel.appendChild(glyphLabel);

    var glyphGrid = document.createElement("div");
    glyphGrid.className = "project-appearance-grid glyph-grid";
    glyphGrid.setAttribute("role", "group");
    glyphGrid.setAttribute("aria-label", "Project glyph");
    [{ id: null, label: "No glyph", value: "—" }]
      .concat(PsycheSessions.PROJECT_GLYPHS)
      .forEach(function (glyph) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "project-appearance-glyph";
        button.textContent = glyph.value;
        button.title = glyph.label;
        button.setAttribute("aria-label", glyph.label);
        button.setAttribute("aria-pressed", glyph.id === draftGlyph ? "true" : "false");
        button.addEventListener("click", function () {
          draftGlyph = glyph.id;
          Array.prototype.forEach.call(glyphGrid.children, function (candidate) {
            candidate.setAttribute(
              "aria-pressed",
              candidate === button ? "true" : "false"
            );
          });
        });
        glyphGrid.appendChild(button);
      });
    panel.appendChild(glyphGrid);

    var actions = document.createElement("div");
    actions.className = "project-appearance-actions";
    var reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset to automatic";
    reset.addEventListener("click", function () {
      closeProjectAppearancePopover({ restoreFocus: false });
      applyProjectAppearance(project, null);
    });
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeProjectAppearancePopover);
    var apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    apply.textContent = "Apply";
    apply.addEventListener("click", function () {
      closeProjectAppearancePopover({ restoreFocus: false });
      applyProjectAppearance(project, {
        accent: draftAccent,
        glyph: draftGlyph,
      });
    });
    actions.appendChild(reset);
    actions.appendChild(cancel);
    actions.appendChild(apply);
    panel.appendChild(actions);

    document.body.appendChild(panel);
    var rect = anchor.getBoundingClientRect();
    var panelRect = panel.getBoundingClientRect();
    panel.style.left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - panelRect.width - 8)
    ) + "px";
    panel.style.top = Math.max(
      8,
      Math.min(rect.bottom + 6, window.innerHeight - panelRect.height - 8)
    ) + "px";
    projectAppearancePopover = {
      element: panel,
      treeKey: anchor.dataset.treeKey || "",
    };
    var selected = panel.querySelector('[aria-pressed="true"]');
    var first = selected || panel.querySelector("button");
    if (first) first.focus();
  }
```

If the existing fake DOM does not support attribute selectors, do not weaken production semantics. In the fake harness, test context-menu dispatch and model updates; verify the popover source contract with direct `mainJs` string assertions for `role`, `aria-pressed`, `Reset to automatic`, and `No glyph`.

Add the exact source-contract assertions:

```ts
  it('keeps the appearance popover constrained to curated accessible controls', () => {
    expect(mainJs).toContain('panel.setAttribute("role", "dialog")');
    expect(mainJs).toContain('button.setAttribute("aria-pressed"');
    expect(mainJs).toContain('reset.textContent = "Reset to automatic"');
    expect(mainJs).toContain('{ id: null, label: "No glyph", value: "—" }');
    expect(mainJs).not.toContain('input.type = "color"');
  });
```

- [ ] **Step 7: Close the popover consistently**

Extend the existing global handlers:

```js
  document.addEventListener("pointerdown", function (event) {
    if (sessionContextMenu && !sessionContextMenu.contains(event.target)) {
      closeSessionContextMenu();
    }
    if (projectAppearancePopover &&
        !projectAppearancePopover.element.contains(event.target)) {
      closeProjectAppearancePopover();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeSessionContextMenu();
      closeProjectAppearancePopover();
    }
  });
```

At the start of `renderSessionList()`, after the editing guard, add:

```js
    closeProjectAppearancePopover({ restoreFocus: false });
```

- [ ] **Step 8: Style the popover**

Append:

```css
.project-appearance-popover {
  position: fixed;
  z-index: 10001;
  width: min(292px, calc(100vw - 16px));
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 96%, transparent);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(20px);
}

.project-appearance-title {
  margin-bottom: 10px;
  color: var(--text);
  font-size: 12px;
  font-weight: 750;
}

.project-appearance-label {
  margin: 10px 0 6px;
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.project-appearance-grid {
  display: grid;
  gap: 6px;
}

.project-appearance-grid.accent-grid {
  grid-template-columns: repeat(8, 1fr);
}

.project-appearance-grid.glyph-grid {
  grid-template-columns: repeat(5, 1fr);
}

.project-appearance-swatch,
.project-appearance-glyph {
  min-width: 0;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--text-soft);
}

.project-appearance-swatch {
  background: rgb(var(--project-accent-rgb) / 0.78);
}

.project-appearance-swatch[aria-pressed="true"],
.project-appearance-glyph[aria-pressed="true"] {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--accent-line);
  color: var(--text);
}

.project-appearance-actions {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.project-appearance-actions button {
  min-width: 0;
  padding: 6px 8px;
}

.project-appearance-actions button:first-child {
  margin-right: auto;
}
```

- [ ] **Step 9: Run focused desktop tests and build**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm vitest --run \
  __tests__/tauriProjectAppearance.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWebBundles.test.ts
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Expected: all tests and the web build pass.

- [ ] **Step 10: Commit customization interaction**

```bash
git -C .worktrees/swift-remote-action-sheet add \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/styles.css \
  __tests__/tauriCovenSessionSiderail.test.ts
git -C .worktrees/swift-remote-action-sheet commit -m "feat: customize project header appearance" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one interaction/styling commit.

---

### Task 7: Complete Validation, Update PR Metadata, and Merge

**Files:**
- Regenerate/check: `native/desktop/psyche-build-tauri/web/sessions.bundle.js`
- Regenerate/check: `native/ios/Psyche.xcodeproj/project.pbxproj`
- Update remotely: PR #114 title, body, review threads, and merge state

- [ ] **Step 1: Run deterministic generated-file checks**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm ios:project:check
git diff --check
git status --short
```

Expected: no uncommitted generated changes. If `sessions.bundle.js` changes,
create a focused generated-artifact commit:

```bash
git add native/desktop/psyche-build-tauri/web/sessions.bundle.js
git commit -m "build: refresh desktop session bundle" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 2: Run the complete TypeScript/Rust CI command locally**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
MANIFEST="native/desktop/psyche-build-tauri/src-tauri/Cargo.toml"
cargo fmt --manifest-path "$MANIFEST" --check
cargo test --manifest-path "$MANIFEST" --locked
cargo check --manifest-path "$MANIFEST" --locked
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Expected: every command exits 0.

- [ ] **Step 3: Run the complete iOS CI command locally**

Run:

```bash
cd .worktrees/swift-remote-action-sheet
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheCore \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-core-full
xcodebuild build \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-app-build
xcodebuild test \
  -project native/ios/Psyche.xcodeproj \
  -scheme PsycheApp \
  -destination 'platform=iOS Simulator,OS=26.2,name=iPhone 16 Pro' \
  -derivedDataPath .derived-data/pr-114-app-full
```

Expected: all three commands succeed.

- [ ] **Step 4: Review the final branch diff**

Run:

```bash
git -C .worktrees/swift-remote-action-sheet diff --check origin/main...HEAD
git -C .worktrees/swift-remote-action-sheet status --short --branch
git -C .worktrees/swift-remote-action-sheet log --oneline origin/main..HEAD
```

Expected: clean worktree and only intentional PR commits.

- [ ] **Step 5: Update PR title and description accurately**

Run:

```bash
gh api repos/OpenCoven/psyche-build/pulls/114 \
  --method PATCH \
  --raw-field title='Add Swift remote actions and project header customization' \
  --raw-field body=$'## Summary\n- add typed Swift reduction and workflow state for mobile action sessions\n- add reusable scoped confirm, choice, input, PR review, progress, navigation, and terminal sheet components\n- keep PsycheApp action-launch and sheet-presentation wiring explicitly outside this PR\n- remove the desktop CURRENT badge and add deterministic, locally customizable project accents and glyphs\n- enforce session, concurrency, dismissal, submission, persistence, and visible failure invariants with focused tests\n\n## Test Plan\n- [x] `pnpm ios:project:check`\n- [x] full TypeScript/Vitest, typecheck, build, package smoke, Rust format/test/check, and desktop web bundle checks\n- [x] full `PsycheCore` simulator tests\n- [x] `PsycheApp` build, unit tests, and UI tests\n- [x] project appearance model and desktop sidebar integration tests'
```

Expected: PR title/body update succeeds and no longer claims the sheet is presented by PsycheApp.

- [ ] **Step 6: Push the completed branch**

Run:

```bash
git -C .worktrees/swift-remote-action-sheet push origin feat/swift-remote-action-sheet
```

Expected: all new commits appear on PR #114.

- [ ] **Step 7: Reply to and resolve addressed review threads**

Reply to and resolve each unresolved thread after the fixes are pushed:

```bash
threads_json="$(gh api graphql \
  -f owner='OpenCoven' \
  -f repo='psyche-build' \
  -F number=114 \
  -f query='
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id
          isResolved
          comments(first:20){nodes{id body path line}}
        }
      }
    }
  }
}')"

printf '%s' "$threads_json" |
  jq -r '
    .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false)
    | .id
  ' |
  while IFS= read -r thread_id; do
    gh api graphql \
      -f id="$thread_id" \
      -f body='Addressed in the latest push: the requested code change is implemented, or the approved reusable-sheet scope is now explicit in the PR description.' \
      -f query='
        mutation($id:ID!,$body:String!){
          addPullRequestReviewThreadReply(
            input:{pullRequestReviewThreadId:$id,body:$body}
          ){comment{id}}
        }'
    gh api graphql \
      -f id="$thread_id" \
      -f query='
        mutation($id:ID!){
          resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}
        }'
  done
```

Expected: every actionable thread reports `isResolved: true`. Do not run this
step until every requested change or scope clarification is present on the
pushed branch.

- [ ] **Step 8: Watch required checks**

Run:

```bash
gh pr checks 114 --repo OpenCoven/psyche-build --watch --interval 20
```

Expected: TypeScript and Rust, all desktop runtime jobs, iOS, and Vercel pass.

If a check fails, inspect that exact job rather than rerunning blindly:

```bash
failed_url="$(
  gh pr checks 114 --repo OpenCoven/psyche-build --json bucket,link \
    --jq '.[] | select(.bucket == "fail") | .link' |
    head -1
)"
run_id="$(printf '%s' "$failed_url" | sed -E 's#^.*/runs/([0-9]+)/job/([0-9]+).*$#\1#')"
job_id="$(printf '%s' "$failed_url" | sed -E 's#^.*/runs/([0-9]+)/job/([0-9]+).*$#\2#')"
gh run view "$run_id" --job "$job_id" --log-failed \
  --repo OpenCoven/psyche-build
```

Use the IDs from the failing check URL, fix the root cause in a new focused commit, push, and repeat the watch command.

- [ ] **Step 9: Obtain required approval**

Run:

```bash
gh pr view 114 --repo OpenCoven/psyche-build \
  --json reviewDecision,reviews,mergeStateStatus
```

Expected before merge: `reviewDecision` is `APPROVED` and the merge state is clean. If approval is still required, request review from the repository’s normal reviewer through the PR UI or configured reviewer assignment; do not bypass branch protection.

- [ ] **Step 10: Merge PR #114**

Run:

```bash
gh pr merge 114 --repo OpenCoven/psyche-build --merge
```

Expected: GitHub reports PR #114 merged.

- [ ] **Step 11: Confirm persistent completion**

Run:

```bash
gh pr view 114 --repo OpenCoven/psyche-build \
  --json state,mergedAt,mergeCommit,url
```

Expected: `state` is `MERGED`, `mergedAt` is non-null, and `mergeCommit` is present.
