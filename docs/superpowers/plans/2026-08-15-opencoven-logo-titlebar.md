# OpenCoven Logo and Titlebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Psyche desktop marks with the supplied OpenCoven identity and restore one correctly aligned macOS titlebar in stable and dev builds.

**Architecture:** Keep the existing HTML shell and Tauri build channel system. Update the titlebar asset and CSS in place, generate a complete Tauri icon set from one repository-owned OpenCoven source image, and make the generated dev Tauri config explicitly merge the macOS overlay before changing channel identity.

**Tech Stack:** Tauri 2, HTML/CSS, Node.js ESM, TypeScript, Vitest, ImageMagick, pnpm

---

## File Map

- Modify `native/desktop/psyche-build-tauri/web/index.html` for the OpenCoven titlebar asset and fallback.
- Modify `native/desktop/psyche-build-tauri/web/styles.css` for unified 44 px chrome and collision-free titlebar layout.
- Create `native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png` as the repository-owned source mark.
- Replace generated files under `native/desktop/psyche-build-tauri/src-tauri/icons/` with the OpenCoven app icon set.
- Modify `scripts/build-macos-app.mjs` so dev builds preserve the macOS window overlay.
- Modify `scripts/build-macos-app.d.mts` to describe the macOS overlay argument.
- Modify `__tests__/tauriWorkspaceRail.test.ts` for titlebar structure, geometry, fallback, and source asset coverage.
- Modify `__tests__/macosBuildChannels.test.ts` for generated dev config coverage.
- Modify `__tests__/tauriDesktopPlatform.test.ts` for icon-set presence, dimensions, and alpha-channel coverage.

### Task 1: Lock the corrected titlebar contract

**Files:**
- Modify: `__tests__/tauriWorkspaceRail.test.ts:5-20`
- Modify: `__tests__/tauriWorkspaceRail.test.ts:85-110`
- Modify: `__tests__/tauriWorkspaceRail.test.ts:250-275`

- [ ] **Step 1: Replace the old asset fixture with the OpenCoven source fixture**

Replace the two current titlebar-mark reads with:

```ts
const packagedTitlebarMark = readFileSync(
  join(root, 'native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png'),
);
```

Remove `sourceTitlebarMark`; the web asset becomes the single repository-owned
source for both the titlebar and generated application icons.

- [ ] **Step 2: Write the failing titlebar identity assertions**

In `ships the Dia-inspired two-zone native shell and pinned sidebar controls`,
replace the old asset assertion and add the fallback assertion:

```ts
expect(titlebar).toContain('src="./assets/opencoven-mark.png"');
expect(titlebar).toContain('class="titlebar-brand-fallback">O</span>');
expect(titlebar).toContain('id="titlebar-brand-mark"');
expect(titlebar).toMatch(/id="titlebar-brand-mark"[^>]*alt=""/);
expect(titlebar).toContain('class="titlebar-brand-name">Psyche</span>');
```

Replace `ships a byte-identical browser-loadable Psyche titlebar icon asset`
with:

```ts
it('ships a nonempty browser-loadable OpenCoven titlebar source asset', () => {
  expect(packagedTitlebarMark.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(packagedTitlebarMark.length).toBeGreaterThan(10_000);
});
```

- [ ] **Step 3: Replace the boundary-overlap test with the approved geometry**

Replace `keeps the open toggle on the sidebar boundary and clears the
traffic-light gutter when collapsed` with:

```ts
it('keeps the sidebar toggle inside a flex-aligned workspace titlebar', () => {
  expect(ruleBlock(styles, '.titlebar-workspace')).toMatch(/display:\s*flex;/);
  expect(ruleBlock(styles, '.titlebar-workspace')).toMatch(/align-items:\s*center;/);
  expect(ruleBlock(styles, '.titlebar-workspace')).toMatch(
    /padding:\s*0\s+12px\s+0\s+10px;/,
  );
  expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/position:\s*relative;/);
  expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/left:\s*auto;/);
  expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/top:\s*auto;/);
  expect(ruleBlock(styles, '.titlebar-sidebar-toggle')).toMatch(/transform:\s*none;/);
  expect(
    ruleBlock(styles, '.app[data-sidebar="collapsed"] .titlebar-workspace'),
  ).toMatch(
    /padding-left:\s*calc\(var\(--titlebar-pad-l\)\s*-\s*var\(--mini-rail-w\)\s*\+\s*10px\);/,
  );
});
```

Add:

```ts
it('uses one 44px custom titlebar with a compact OpenCoven tile', () => {
  expect(styles).toContain('--titlebar-h: 44px;');
  expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/width:\s*24px;/);
  expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/height:\s*24px;/);
  expect(ruleBlock(styles, '.titlebar-brand-icon')).toMatch(/background:\s*#050505;/);
  expect(ruleBlock(styles, '.titlebar-brand-mark')).toMatch(/object-fit:\s*contain;/);
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts
```

Expected: FAIL because `opencoven-mark.png`, the `O` fallback, 44 px height,
flex workspace alignment, and in-workspace toggle geometry do not exist yet.

### Task 2: Implement the OpenCoven titlebar

**Files:**
- Create: `native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png`
- Modify: `native/desktop/psyche-build-tauri/web/index.html:19-29`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css:65-75`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css:975-1060`
- Modify: `native/desktop/psyche-build-tauri/web/styles.css:3735-3745`
- Test: `__tests__/tauriWorkspaceRail.test.ts`

- [ ] **Step 1: Copy the supplied mark into the desktop package**

Run from the repository root:

```bash
cp ../coven/assets/opencoven/opencoven-1024.png \
  native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png
```

Expected: the destination is a 1024x1024 PNG and no runtime path references
the sibling checkout.

- [ ] **Step 2: Update the titlebar HTML**

Change the fallback and source in `web/index.html`:

```html
<span class="titlebar-brand-icon" aria-hidden="true">
  <span class="titlebar-brand-fallback">O</span>
  <img
    id="titlebar-brand-mark"
    class="titlebar-brand-mark"
    src="./assets/opencoven-mark.png"
    alt=""
  />
</span>
```

Keep the existing CSP-safe `initializeTitlebarBrandMark()` behavior in
`web/main.js`; removing a failed image exposes the `O` fallback without inline
event handlers.

- [ ] **Step 3: Implement unified titlebar geometry**

Set the primary geometry token to:

```css
--titlebar-h: 44px;
```

Delete the later duplicate override:

```css
:root {
  --titlebar-h: 42px;
}
```

Replace the affected titlebar rules with:

```css
.titlebar-workspace {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 10px;
  background: var(--workspace-surface);
}

.titlebar-brand-icon {
  position: relative;
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  overflow: hidden;
  border-radius: 7px;
  background: #050505;
  pointer-events: none;
}

.titlebar-brand-fallback {
  color: var(--text);
  font-size: 10px;
  font-weight: 800;
}

.titlebar-brand-mark {
  position: absolute;
  inset: 3px;
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.titlebar-sidebar-toggle {
  position: relative;
  z-index: 4;
  left: auto;
  top: auto;
  display: grid;
  flex: none;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--workspace-surface);
  color: var(--muted);
  transform: none;
  -webkit-app-region: no-drag;
}

.app[data-sidebar="collapsed"] .titlebar-brand {
  display: none;
}

.app[data-sidebar="collapsed"] .titlebar-workspace {
  padding-left: calc(var(--titlebar-pad-l) - var(--mini-rail-w) + 10px);
}

.app[data-sidebar="collapsed"] .titlebar-sidebar-toggle {
  left: auto;
  transform: none;
}
```

Keep `.titlebar-spacer { flex: 1 1 auto; }`; it now works because
`.titlebar-workspace` is a flex container and pushes `Agent control` right.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the titlebar change**

```bash
git add \
  __tests__/tauriWorkspaceRail.test.ts \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/styles.css \
  native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png
git commit -m "feat: apply OpenCoven desktop titlebar" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Preserve macOS chrome in generated dev builds

**Files:**
- Modify: `__tests__/macosBuildChannels.test.ts:85-105`
- Modify: `__tests__/macosBuildChannels.test.ts:695-740`
- Modify: `__tests__/macosBuildChannels.test.ts:1095-1115`
- Modify: `scripts/build-macos-app.mjs:15-25`
- Modify: `scripts/build-macos-app.mjs:118-135`
- Modify: `scripts/build-macos-app.mjs:345-375`
- Modify: `scripts/build-macos-app.d.mts:55-75`
- Modify: `scripts/build-macos-app.d.mts:275-285`

- [ ] **Step 1: Load the macOS overlay in the test fixture**

Rename the current base fixture to `baseTauriConfig` and add:

```ts
const macosTauriOverlay = JSON.parse(
  readFileSync(
    join(
      repositoryRoot,
      'native/desktop/psyche-build-tauri/src-tauri/tauri.macos.conf.json',
    ),
    'utf8',
  ),
) as Partial<TauriConfig>;
```

- [ ] **Step 2: Write the failing generated-config assertions**

Update the `createDevTauriConfig` success test to call:

```ts
const dev = createDevTauriConfig(production, macosTauriOverlay);
```

Assert:

```ts
expect(dev.productName).toBe('Psyche Build Dev');
expect(dev.identifier).toBe('dev.opencoven.psyche.dev');
expect(dev.app.windows[0]).toMatchObject({
  label: 'main',
  title: 'Psyche Build Dev',
  transparent: true,
  titleBarStyle: 'Overlay',
  hiddenTitle: true,
});
expect(dev.bundle).toMatchObject({
  icon: [
    'icons/32x32.png',
    'icons/128x128.png',
    'icons/128x128@2x.png',
    'icons/icon.icns',
  ],
  macOS: { minimumSystemVersion: '12.0' },
});
expect(production).toEqual(snapshot);
```

Update the missing-main test to pass `macosTauriOverlay`.

Update the `writeDevTauriConfig` expectation:

```ts
expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(
  createDevTauriConfig(baseTauriConfig, macosTauriOverlay),
);
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm vitest --run __tests__/macosBuildChannels.test.ts
```

Expected: FAIL because generated dev config currently starts from the portable
base only and drops `transparent`, `titleBarStyle`, `hiddenTitle`, and ICNS
configuration.

- [ ] **Step 4: Merge the platform overlay before applying dev identity**

Add:

```js
const MACOS_TAURI_CONFIG_RELATIVE_PATH =
  'native/desktop/psyche-build-tauri/src-tauri/tauri.macos.conf.json';
```

Replace `createDevTauriConfig` with:

```js
export function createDevTauriConfig(production, macosOverlay = {}) {
  const devConfig = structuredClone(production);
  const overlay = structuredClone(macosOverlay);
  const baseWindows = devConfig.app?.windows ?? [];
  const overlayWindows = overlay.app?.windows ?? [];
  const mergedWindows = baseWindows.map((baseWindow) => {
    const windowOverlay = overlayWindows.find(
      (candidate) => candidate.label === baseWindow.label,
    );
    return windowOverlay ? { ...baseWindow, ...windowOverlay } : baseWindow;
  });

  for (const overlayWindow of overlayWindows) {
    if (!mergedWindows.some((candidate) => candidate.label === overlayWindow.label)) {
      mergedWindows.push(overlayWindow);
    }
  }

  devConfig.app = {
    ...devConfig.app,
    ...overlay.app,
    windows: mergedWindows,
  };
  devConfig.bundle = {
    ...devConfig.bundle,
    ...overlay.bundle,
  };

  const mainWindow = devConfig.app.windows.find((window) => window.label === 'main');
  if (!mainWindow) {
    throw new Error('Production Tauri config must contain an app.windows entry labeled "main"');
  }

  const devIdentity = channelConfig('dev');
  devConfig.productName = devIdentity.productName;
  devConfig.identifier = devIdentity.bundleIdentifier;
  mainWindow.title = devIdentity.productName;

  return devConfig;
}
```

In `writeDevTauriConfig`, read both files:

```js
const macosPath = path.join(
  absoluteSourceRoot,
  MACOS_TAURI_CONFIG_RELATIVE_PATH,
);
const [production, macosOverlay] = await Promise.all([
  readFile(productionPath, 'utf8').then(JSON.parse),
  readFile(macosPath, 'utf8').then(JSON.parse),
]);
const devConfig = createDevTauriConfig(production, macosOverlay);
```

- [ ] **Step 5: Update the declaration**

Change the declaration to:

```ts
export function createDevTauriConfig(
  production: TauriConfig,
  macosOverlay?: Partial<TauriConfig>,
): TauriConfig;
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest --run \
  __tests__/macosBuildChannels.test.ts \
  __tests__/tauriDesktopPlatform.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the dev config fix**

```bash
git add \
  __tests__/macosBuildChannels.test.ts \
  scripts/build-macos-app.mjs \
  scripts/build-macos-app.d.mts
git commit -m "fix: preserve macOS chrome in dev app builds" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Generate and lock the OpenCoven application icon set

**Files:**
- Modify: `__tests__/tauriDesktopPlatform.test.ts:1-35`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/32x32.png`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/64x64.png`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/128x128.png`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/128x128@2x.png`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/icon.png`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/icon.icns`
- Replace: `native/desktop/psyche-build-tauri/src-tauri/icons/icon.ico`

- [ ] **Step 1: Add a portable PNG metadata helper**

Add below `readText`:

```ts
function pngMetadata(path: string) {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}
```

- [ ] **Step 2: Write the failing icon-set test**

Add under `desktop Tauri layout`:

```ts
it('ships a complete alpha-capable OpenCoven application icon set', () => {
  const icons = join(desktop, 'src-tauri/icons');

  expect(pngMetadata(join(icons, 'icon.png'))).toEqual({
    width: 1024,
    height: 1024,
    colorType: 6,
  });
  expect(pngMetadata(join(icons, '32x32.png'))).toMatchObject({
    width: 32,
    height: 32,
  });
  expect(pngMetadata(join(icons, '128x128.png'))).toMatchObject({
    width: 128,
    height: 128,
  });
  expect(pngMetadata(join(icons, '128x128@2x.png'))).toMatchObject({
    width: 256,
    height: 256,
  });
  expect(readFileSync(join(icons, 'icon.icns')).length).toBeGreaterThan(100_000);
  expect(readFileSync(join(icons, 'icon.ico')).length).toBeGreaterThan(10_000);
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts
```

Expected: FAIL because the current `icon.png` is 512x512 and still uses the
purple Psyche glyph.

- [ ] **Step 4: Generate the rounded OpenCoven source icon**

Verify ImageMagick is available:

```bash
magick -version
```

Generate a transparent 1024 px rounded-square icon with the supplied mark
optically inset:

```bash
magick \
  -size 1024x1024 canvas:none \
  -fill '#050505' \
  -draw 'roundrectangle 32,32 992,992 210,210' \
  \( native/desktop/psyche-build-tauri/web/assets/opencoven-mark.png \
     -trim +repage -resize '690x690>' \) \
  -gravity center \
  -compose over \
  -composite \
  PNG32:native/desktop/psyche-build-tauri/src-tauri/icons/icon.png
```

Expected: `icon.png` is 1024x1024 RGBA with transparent outer corners, a black
rounded field, and the white OpenCoven mark centered inside it.

- [ ] **Step 5: Regenerate the Tauri icon family**

Run:

```bash
pnpm --dir native/desktop/psyche-build-tauri exec tauri icon \
  src-tauri/icons/icon.png
```

Retain the configured PNG, ICO, and ICNS outputs listed in this task. Do not
add mobile or Store-logo outputs that are not referenced by a desktop Tauri
configuration.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriDesktopPlatform.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the application icons**

```bash
git add \
  __tests__/tauriDesktopPlatform.test.ts \
  native/desktop/psyche-build-tauri/src-tauri/icons
git commit -m "feat: replace desktop icons with OpenCoven mark" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Build, relaunch, and visually verify the dev app

**Files:**
- Verify only; no planned source changes

- [ ] **Step 1: Run the complete targeted validation**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriDesktopPlatform.test.ts \
  __tests__/macosBuildChannels.test.ts \
  __tests__/tauriWebBundles.test.ts
pnpm --dir native/desktop/psyche-build-tauri build:web
```

Expected: all tests pass and all web bundles rebuild without errors.

- [ ] **Step 2: Rebuild the installed development app**

Run:

```bash
pnpm app:dev
```

Expected:

```text
Installed Psyche Build Dev at ~/Applications/Psyche Build Dev.app
```

- [ ] **Step 3: Relaunch the rebuilt application**

Gracefully quit the current dev bundle if it is running, then open the newly
installed bundle:

```bash
osascript -e 'tell application id "dev.opencoven.psyche.dev" to quit' 2>/dev/null || true
open "$HOME/Applications/Psyche Build Dev.app"
```

- [ ] **Step 4: Verify the approved visual outcomes**

Confirm in the running app:

1. The native `Psyche Build Dev` title is no longer visible above the custom chrome.
2. The titlebar shows the OpenCoven mark and `Psyche` once.
3. The sidebar toggle sits fully inside the workspace and never overlaps `Agent control`.
4. `Agent control` is right-aligned in both open and collapsed sidebar states.
5. The Dock and application bundle show the OpenCoven icon.

- [ ] **Step 5: Check the final worktree**

Run:

```bash
git --no-pager status --short
git --no-pager log -4 --oneline
```

Expected: only the pre-existing `.beads/interactions.jsonl` modification
remains uncommitted, and the three implementation commits appear above the
design/spec commits.
