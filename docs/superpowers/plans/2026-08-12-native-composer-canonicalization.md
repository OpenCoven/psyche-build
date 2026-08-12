# Native Composer DOM Canonicalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the orphan duplicate native composer controls while preserving the voice-call UI inside the canonical composer.

**Architecture:** Move the unique call button and call bar into the existing `#composer`, delete the repeated mic/send/menu/palette block, and protect the DOM ownership contract with focused HTML source tests. No CSS or JavaScript behavior changes are needed.

**Tech Stack:** Static HTML, Vitest source-contract tests, native esbuild web bundle.

---

### Task 1: Canonicalize the composer DOM

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html:408-575`
- Test: `__tests__/tauriWorkspacePanels.test.ts`
- Test: `__tests__/tauriFooterStatusBar.test.ts`

- [ ] **Step 1: Write the failing uniqueness and containment test**

Add this helper near the existing source constants in
`tauriWorkspacePanels.test.ts`:

```ts
function idCount(id: string): number {
  return indexHtml.match(new RegExp(`id="${id}"`, 'g'))?.length ?? 0;
}
```

Add this test inside the native workspace-panel suite:

```ts
it('owns every composer and call control in one canonical footer', () => {
  const ids = [
    'composer',
    'composer-mic',
    'composer-call',
    'composer-send',
    'scope-menu',
    'scope-desc-pane',
    'scope-desc-project',
    'scope-desc-agents',
    'call-bar',
    'call-target',
    'call-note',
    'call-timer',
    'call-mute',
    'call-end',
    'palette',
  ];
  ids.forEach((id) => expect(idCount(id), id).toBe(1));

  const composerStart = indexHtml.indexOf('<footer class="composer" id="composer">');
  const composerEnd = indexHtml.indexOf('</footer>', composerStart);
  expect(composerStart).toBeGreaterThan(-1);
  expect(composerEnd).toBeGreaterThan(composerStart);
  const composer = indexHtml.slice(composerStart, composerEnd);
  for (const id of ['composer-mic', 'composer-call', 'composer-send', 'scope-menu', 'call-bar', 'palette']) {
    expect(composer, id).toContain(`id="${id}"`);
  }
});
```

Strengthen the footer-shell test in `tauriFooterStatusBar.test.ts` with:

```ts
expect(indexHtml.match(/<footer class="composer" id="composer">/g)).toHaveLength(1);
expect(indexHtml.match(/<\/footer>/g)).toHaveLength(1);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriFooterStatusBar.test.ts
```

Expected: uniqueness assertions fail because mic, send, scope menu,
descriptions, and palette occur twice; call controls are outside the canonical
composer.

- [ ] **Step 3: Move call controls into the canonical composer**

Insert the existing `composer-call` button immediately after the canonical
`composer-mic` button, preserving its markup exactly:

```html
<button id="composer-call" class="composer-btn composer-call-btn" type="button"
        title="Start a voice call with the focused agent" aria-label="Start a voice call">
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.9c.5-.5 1.3-.5 1.8 0l.9.9c.5.5.5 1.2.1 1.7l-.5.7a.7.7 0 0 0 0 .9 12 12 0 0 0 2.6 2.6c.3.2.6.2.9 0l.7-.5c.5-.4 1.2-.4 1.7.1l.9.9c.5.5.5 1.3 0 1.8l-.6.6c-.5.5-1.2.7-1.9.4-2-.8-3.8-2-5.3-3.5S3.3 7.1 2.5 5.1c-.3-.7-.1-1.4.4-1.9z" fill="currentColor"/></svg>
</button>
```

Insert the existing call bar immediately before the canonical palette:

```html
<div class="call-bar" id="call-bar" role="status" aria-live="polite" hidden>
  <span class="call-dot" aria-hidden="true"></span>
  <span class="call-title">Voice call — <span class="call-target" id="call-target"></span></span>
  <span class="call-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
  <span class="call-note" id="call-note"></span>
  <span class="call-spacer"></span>
  <span class="call-timer mono" id="call-timer">0:00</span>
  <button id="call-mute" class="call-btn" type="button">Mute</button>
  <button id="call-end" class="call-btn call-end" type="button">End call</button>
</div>
```

- [ ] **Step 4: Delete the orphan block**

Delete the second block beginning with the `composer-mic` after
`#status-more-menu` and ending with the second `palette`, including its orphan
`</footer>`. Leave `status-live` and `status-alert` as direct children of
`#footer-stack` after `#status-more-menu`.

- [ ] **Step 5: Run focused and static verification**

```bash
pnpm vitest --run __tests__/tauriWorkspacePanels.test.ts __tests__/tauriFooterStatusBar.test.ts
pnpm --filter psyche-build-tauri run build:web
pnpm typecheck
git diff --check
```

Expected: focused tests, web build, typecheck, and whitespace check all pass.

- [ ] **Step 6: Commit**

```bash
git add native/macos/psyche-build-tauri/web/index.html \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriFooterStatusBar.test.ts
git diff --cached --check
git commit -m "fix(macos): canonicalize composer controls"
```
