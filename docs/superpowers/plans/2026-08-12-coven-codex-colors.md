# Coven Purple and Codex Blackish Colors Implementation Plan

> **Superseded for Coven on 2026-08-24:** The saturated Coven values in this
> historical plan no longer describe the active theme. `coven-purple` now uses
> the canonical graphite and restrained-violet tokens from
> `OpenCoven/ui/index.html`. The Codex Blackish steps remain historical evidence
> of that implementation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the historical saturated Coven Purple palette and replace Codex Blackish's stark grayscale tokens with the approved cool-charcoal and cool-silver palette.

**Architecture:** Keep the native desktop CSS custom-property system as the sole theme source. Add exact-value regression assertions to the existing theme-token contract, then change only the `codex-blackish` theme block; the tracked Coven Purple block already matches commit `617d3fd` and will be protected against future drift.

**Tech Stack:** CSS custom properties, TypeScript, Vitest, pnpm, esbuild

---

## File Structure

- Modify `__tests__/tauriThemeTokens.test.ts` to parse individual custom-property values and pin the approved Coven Purple and Codex Blackish palettes.
- Modify `native/desktop/psyche-build-tauri/web/styles.css` to apply the approved Codex Blackish token values. Do not add component-level overrides or change other theme blocks.

### Task 1: Pin and Apply the Approved Theme Tokens

**Files:**
- Modify: `__tests__/tauriThemeTokens.test.ts:29-78`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css:3744-3793`
- Reference: `docs/superpowers/specs/2026-08-12-coven-codex-colors-design.md`

- [ ] **Step 1: Add a custom-property value parser to the theme contract test**

Add this helper immediately after `customProperties`:

```ts
function customProperty(block: string, name: string) {
  const found = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  return found ? found[1].replace(/\s+/g, ' ').trim() : null;
}
```

- [ ] **Step 2: Add exact palette regression tests**

Add these tests inside the existing `describe('theme tokens', ...)` block,
after `declares the same token set in every theme` and before the existing
default-chroma test:

```ts
  it('pins the historical Coven Purple palette', () => {
    const block = themeBlock('coven-purple') ?? '';

    expect({
      rgbAccent: customProperty(block, '--rgb-accent'),
      accent: customProperty(block, '--accent'),
      accentStrong: customProperty(block, '--accent-strong'),
      deep: customProperty(block, '--rgb-deep'),
      surface1: customProperty(block, '--rgb-s1'),
      surface2: customProperty(block, '--rgb-s2'),
      surface3: customProperty(block, '--rgb-s3'),
      terminal: customProperty(block, '--rgb-term'),
      text: customProperty(block, '--text'),
      textSoft: customProperty(block, '--text-soft'),
      muted: customProperty(block, '--muted'),
    }).toEqual({
      rgbAccent: '184, 157, 255',
      accent: '#b89dff',
      accentStrong: '#9d80f0',
      deep: '15, 6, 39',
      surface1: '22, 9, 58',
      surface2: '30, 12, 79',
      surface3: '40, 16, 103',
      terminal: '16, 6, 40',
      text: '#f5f2fb',
      textSoft: '#c8c2d8',
      muted: '#8a8499',
    });
  });

  it('pins the approved Codex Blackish palette', () => {
    const block = themeBlock('codex-blackish') ?? '';

    expect({
      rgbAccent: customProperty(block, '--rgb-accent'),
      accent: customProperty(block, '--accent'),
      accentStrong: customProperty(block, '--accent-strong'),
      deep: customProperty(block, '--rgb-deep'),
      surface1: customProperty(block, '--rgb-s1'),
      surface2: customProperty(block, '--rgb-s2'),
      surface3: customProperty(block, '--rgb-s3'),
      terminal: customProperty(block, '--rgb-term'),
      text: customProperty(block, '--text'),
      textSoft: customProperty(block, '--text-soft'),
      muted: customProperty(block, '--muted'),
    }).toEqual({
      rgbAccent: '196, 202, 214',
      accent: '#c4cad6',
      accentStrong: '#9da6b8',
      deep: '15, 15, 17',
      surface1: '22, 23, 26',
      surface2: '30, 30, 31',
      surface3: '43, 44, 48',
      terminal: '15, 15, 17',
      text: '#f0f1f4',
      textSoft: '#c2c6ce',
      muted: '#858b96',
    });
  });
```

- [ ] **Step 3: Run the targeted test and confirm the Codex regression fails**

Run:

```bash
pnpm exec vitest --run __tests__/tauriThemeTokens.test.ts
```

Expected: the Coven Purple assertion passes because the tracked source already
matches commit `617d3fd`; the Codex Blackish assertion fails, showing the
current `210, 210, 214`, `#d2d2d6`, `10, 10, 11`, and related grayscale values
instead of the approved palette.

- [ ] **Step 4: Replace the Codex Blackish theme block**

Replace the existing `:root[data-theme="codex-blackish"]` block with:

```css
:root[data-theme="codex-blackish"] {
  --rgb-accent: 196, 202, 214;
  --accent: #c4cad6;
  --accent-strong: #9da6b8;
  --rgb-deep: 15, 15, 17;
  --rgb-s1:   22, 23, 26;
  --rgb-s2:   30, 30, 31;
  --rgb-s3:   43, 44, 48;
  --rgb-term: 15, 15, 17;
  --text: #f0f1f4;
  --text-soft: #c2c6ce;
  --muted: #858b96;
}
```

Leave the Coven Purple block unchanged. Its current values are the exact
approved restoration; the new test makes that requirement persistent.

- [ ] **Step 5: Run the targeted theme contract**

Run:

```bash
pnpm exec vitest --run __tests__/tauriThemeTokens.test.ts
```

Expected: all tests in `tauriThemeTokens.test.ts` pass, including theme block
shape, default saturation, historical Coven Purple, and approved Codex
Blackish assertions.

- [ ] **Step 6: Build the native web assets**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Expected: esbuild completes successfully for the editor, sessions, panes,
input, diffs, status, and workspace bundles. The CSS file is loaded directly,
so no generated CSS artifact should be added.

- [ ] **Step 7: Inspect the final scoped diff**

Run:

```bash
git diff --check
git diff -- __tests__/tauriThemeTokens.test.ts native/desktop/psyche-build-tauri/web/styles.css
```

Expected: no whitespace errors; the diff contains only the test helper, two
palette assertions, and the Codex Blackish token replacement. Coven Purple and
all unrelated themes remain unchanged.

- [ ] **Step 8: Commit the implementation**

```bash
git add __tests__/tauriThemeTokens.test.ts native/desktop/psyche-build-tauri/web/styles.css
git commit -m "fix: refine Coven and Codex theme colors" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
