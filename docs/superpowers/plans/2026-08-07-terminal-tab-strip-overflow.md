# Terminal Tab Strip Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the native macOS terminal tab strip from scrolling vertically while preserving horizontal tab scrolling and existing geometry.

**Architecture:** Keep the fix inside the native web surface that owns terminal-tab layout. Extend the existing source-contract test first, then add one explicit overflow-axis declaration to the terminal tab strip.

**Tech Stack:** CSS, TypeScript, Vitest, pnpm

---

### Task 1: Constrain terminal tab overflow to the horizontal axis

**Files:**
- Modify: `__tests__/tauriDesktopTabs.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/styles.css`

- [ ] **Step 1: Write the failing regression test**

Add this test inside the existing `describe('Tauri desktop tab shortcuts', ...)` block in `__tests__/tauriDesktopTabs.test.ts`:

```ts
it('keeps terminal tabs horizontally scrollable without vertical overflow', () => {
  expect(stylesCss).toMatch(
    /\.tab-strip\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?overflow-y:\s*hidden;/
  );
});
```

- [ ] **Step 2: Run the focused test and verify the regression fails**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopTabs.test.ts
```

Expected: FAIL in `keeps terminal tabs horizontally scrollable without vertical overflow` because `.tab-strip` does not explicitly declare `overflow-y: hidden`.

- [ ] **Step 3: Implement the minimal CSS fix**

Update the primary `.tab-strip` rule in `native/macos/psyche-build-tauri/web/styles.css`:

```css
.tab-strip {
  display: flex;
  align-items: stretch;
  background: rgba(var(--rgb-s1), calc(var(--bg-opacity) * 0.78));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  padding: 0 6px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
```

- [ ] **Step 4: Run focused and repository verification**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopTabs.test.ts
pnpm typecheck
pnpm build
```

Expected: all commands exit successfully with the focused test passing and no typecheck or build errors.

- [ ] **Step 5: Commit only the scoped fix**

Run:

```bash
git add __tests__/tauriDesktopTabs.test.ts native/macos/psyche-build-tauri/web/styles.css
git diff --cached --check
git commit -m "fix: prevent vertical terminal tab scrolling"
```

Expected: the commit contains only the regression test and CSS declaration; pre-existing package and lockfile changes remain uncommitted.
