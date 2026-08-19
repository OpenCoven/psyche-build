# Status Options Scannability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the footer More menu's tall repeated cards with a compact, accessible telemetry matrix whose readings are explicit and visually dominant.

**Architecture:** Keep the status model, persisted preferences, detail panels, event delegation, and collapsed footer unchanged. Extend the controller's display records with menu-specific copy, render one column header plus compact row controls, and use CSS-only switch and matrix styling so native control semantics remain intact.

**Tech Stack:** Browser-native DOM APIs, JavaScript ES modules, CSS, Vitest, esbuild.

---

## File Map

- Modify `native/desktop/psyche-build-tauri/web/status/status-controller.mjs`:
  menu-specific value formatting and compact matrix DOM.
- Modify `native/desktop/psyche-build-tauri/web/styles.css`:
  matrix columns, ruled rows, reading hierarchy, switches, and order buttons.
- Modify `__tests__/tauriStatusController.test.ts`:
  live menu copy, column structure, switches, metadata, and ordering semantics.
- Modify `__tests__/tauriFooterStatusBar.test.ts`:
  source CSS contracts and updated menu width.
- Regenerate `native/desktop/psyche-build-tauri/web/status.bundle.js` through
  the existing desktop `build:web` script.

### Task 1: Lock the DOM and copy contract

**Files:**
- Modify: `__tests__/tauriStatusController.test.ts`
- Modify: `__tests__/tauriFooterStatusBar.test.ts`

- [ ] **Step 1: Add failing controller assertions**

Extend the existing More-menu test to assert:

```ts
expect(elements.moreMenu.querySelector('.status-more-columns')).toBeTruthy();
expect(hiddenTasksOpen?.querySelector('.status-more-open-value')?.textContent)
  .toBe('2 running · 1 waiting · 1 failed');
expect(hiddenTasksOpen?.parentElement?.dataset.metricKind).toBe('status');
expect(hiddenTasksOpen?.parentElement?.querySelector('.status-more-toggle-label')?.textContent)
  .toBe('Visible');
expect(hiddenTasksOpen?.parentElement?.querySelectorAll('.status-more-move')).toHaveLength(2);
```

Add populated performance, FPS, and activity assertions for `CPU 55% · 512 MB`,
`48 FPS`, and explicit rate units. Preserve the existing unavailable and
`hidden by width` assertions.

- [ ] **Step 2: Add failing CSS contract assertions**

Require a 320px menu, three matrix control columns, border-separated rows,
custom checkbox appearance, reading-only semantic colors, and compact order
buttons:

```ts
expect(section).toMatch(/\.status-more-menu\s*\{[^}]*width:\s*320px;/s);
expect(section).toContain('.status-more-columns');
expect(section).toMatch(/\.status-more-row\s*\{[^}]*grid-template-columns:/s);
expect(section).toMatch(/\.status-more-toggle input\s*\{[^}]*appearance:\s*none;/s);
expect(section).toContain('.status-more-open[data-severity="danger"] .status-more-open-value');
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```bash
pnpm vitest --run __tests__/tauriStatusController.test.ts __tests__/tauriFooterStatusBar.test.ts
```

Expected: failures for the new column, value-copy, switch, and width contracts.

### Task 2: Render the telemetry matrix

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/status/status-controller.mjs`

- [ ] **Step 1: Extend display records with More-menu copy**

Change `metricDisplayValue` to accept an optional `menuText`, then build
explicit menu values without changing `valueText`:

```js
function metricDisplayValue(valueText, menuText = valueText) {
  const text = valueText == null ? null : String(valueText);
  return {
    available: text != null,
    valueText: text,
    menuText: menuText == null ? null : String(menuText),
  };
}
```

Add focused helpers for pluralized agent/shell/task copy and activity rate copy.
Use `formatMemory` for the menu while preserving `shortMemory` in the collapsed
footer.

- [ ] **Step 2: Render one column header**

After the menu title, append `.status-more-columns` with an inner metric/reading
pair plus `Visible` and `Order` labels. Mark it `aria-hidden="true"` because each
interactive control already has an accessible name.

- [ ] **Step 3: Render compact rows**

Set `row.dataset.metricKind` to `telemetry` for performance, FPS, and activity
and `status` otherwise. Render `display.menuText` in the More menu. Keep
native checkboxes and their `aria-label`, change visible helper copy from `Show`
to `Visible`, and render `↑`/`↓` order buttons with the existing full aria labels
plus matching `title` attributes.

- [ ] **Step 4: Run the controller test**

Run:

```bash
pnpm vitest --run __tests__/tauriStatusController.test.ts
```

Expected: all controller tests pass.

### Task 3: Apply the visual hierarchy

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/styles.css`

- [ ] **Step 1: Replace card styling with a ruled matrix**

Set the menu width to 320px, reduce outer gaps, add a four-label column header,
and make each row a three-column grid:

```css
.status-more-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px 54px;
  align-items: center;
  gap: 2px 8px;
  min-height: 42px;
  padding: 5px 8px;
  border-top: 1px solid var(--border);
  background: transparent;
}
```

The open button uses `74px minmax(0, 1fr)` internally so labels and readings
align across every row.

- [ ] **Step 2: Make readings dominant**

Keep labels and header copy muted. Set readings to `var(--text)`, tabular
numerals, and medium weight. Give telemetry readings slightly tighter tracking.
Move warning and danger colors from the entire `.status-more-item` to
`.status-more-open-value`.

- [ ] **Step 3: Style accessible switches and order controls**

Use `appearance: none` on the checkbox with a compact track and pseudo-element
thumb. Preserve `:focus-visible`, `:checked`, and `:disabled` states. Size order
buttons to 24px squares, retain disabled opacity, and expose them on hover/focus
without hiding them from keyboard users.

- [ ] **Step 4: Run focused CSS and controller tests**

Run:

```bash
pnpm vitest --run __tests__/tauriFooterStatusBar.test.ts __tests__/tauriStatusController.test.ts
```

Expected: all tests pass.

### Task 4: Regenerate and verify the shipped UI

**Files:**
- Modify: `native/desktop/psyche-build-tauri/web/status.bundle.js`

- [ ] **Step 1: Rebuild committed web bundles**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Expected: esbuild completes successfully and refreshes the checked-in bundle.

- [ ] **Step 2: Run bundle and focused regression tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriStatusController.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: all selected suites pass with no stale-bundle failure.

- [ ] **Step 3: Run repository checks covering the changed JavaScript**

Run:

```bash
pnpm typecheck
git diff --check
```

Expected: both commands exit zero.

- [ ] **Step 4: Review the final diff**

Confirm the diff changes only the approved spec, plan, source, focused tests,
generated status bundle, and ignored repository goal. Verify collapsed metric
copy, persistence keys, event action names, and detail panel rendering are
unchanged.

## Follow-up Addendum: Canonical Coven Palette

The approved visual outcome also aligns only the
`:root[data-theme="coven-purple"]` tokens in
`native/desktop/psyche-build-tauri/web/styles.css` with the canonical OpenCoven
accent (`#9a71ff`, strong `#8254eb`) and ink surfaces (`#120d18`, `#1b1524`,
`#2a2238`, `#3f3550`). Pin the exact values in
`__tests__/tauriThemeTokens.test.ts` before changing CSS, then update this plan
and the design spec. Do not rebuild or modify generated JavaScript bundles.

Verify with:

```bash
pnpm vitest --run __tests__/tauriThemeTokens.test.ts
pnpm vitest --run \
  __tests__/tauriStatusController.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriWebBundles.test.ts
pnpm typecheck
git diff --check
```
