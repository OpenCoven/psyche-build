# GPU ADE Slice 1: Cross-Platform Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Psyche Build Tauri ADE build and run as a desktop application on macOS, Windows, and Linux without expanding release distribution.

**Architecture:** Move the active Tauri application to a platform-neutral desktop path, split platform behavior behind one Rust interface, and use Tauri's automatically merged platform configuration files for macOS-only presentation. Preserve the existing command surface and security policy while returning typed unavailable results for Unix-only integrations on Windows.

**Tech Stack:** Tauri 2.11, Rust 1.95, portable-pty, WebView/Wry, esbuild, Vitest, GitHub Actions.

---

Start in a clean worktree based on freshly fetched `origin/main`. Verify that approved design commit `c9d5d55` is an ancestor before implementation. Re-inventory the canonical checkout and do not copy or stage unrelated work into the implementation worktree.

## File map

- Move `native/macos/psyche-build-tauri/` to `native/desktop/psyche-build-tauri/` — platform-neutral desktop application.
- Modify `package.json`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, scripts, tests, and docs that name the old path.
- Create `native/desktop/psyche-build-tauri/src-tauri/tauri.macos.conf.json` — transparent overlay and macOS bundle settings.
- Create `native/desktop/psyche-build-tauri/src-tauri/tauri.windows.conf.json` — opaque WebView2 window settings.
- Create `native/desktop/psyche-build-tauri/src-tauri/tauri.linux.conf.json` — opaque WebKitGTK window settings.
- Create `native/desktop/psyche-build-tauri/src-tauri/src/platform/mod.rs` — shared runtime interface.
- Create `platform/macos.rs`, `platform/linux.rs`, and `platform/windows.rs` — target-specific shell, PATH, cwd, engine, and effects behavior.
- Create `__tests__/tauriDesktopPlatform.test.ts` — path/config/security/build contracts.
- Modify existing `__tests__/tauri*.test.ts` files — use the new desktop root.

### Task 1: Move the desktop application without changing behavior

**Files:**
- Create: `__tests__/tauriDesktopPlatform.test.ts`
- Move: `native/macos/psyche-build-tauri` → `native/desktop/psyche-build-tauri`
- Modify: `package.json`, `pnpm-workspace.yaml`, `.gitignore`, scripts, docs, `.github/workflows/release.yml`, and `__tests__/**/*.test.ts`

- [ ] **Step 1: Write the failing path contract**

Create `__tests__/tauriDesktopPlatform.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const desktop = join(root, 'native/desktop/psyche-build-tauri');

describe('desktop Tauri layout', () => {
  it('owns the active app from the platform-neutral desktop path', () => {
    expect(existsSync(desktop)).toBe(true);
    expect(existsSync(join(root, 'native/macos/psyche-build-tauri'))).toBe(false);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
      .toContain('native/desktop/psyche-build-tauri');
  });

  it('does not leave executable references to the old path', () => {
    for (const file of ['package.json', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain('native/macos/psyche-build-tauri');
    }
  });

  it('never opts out of GPU acceleration or software fallback', () => {
    const configText = ['tauri.conf.json', 'tauri.macos.conf.json',
      'tauri.windows.conf.json', 'tauri.linux.conf.json']
      .filter((name) => existsSync(join(desktop, 'src-tauri', name)))
      .map((name) => readFileSync(join(desktop, 'src-tauri', name), 'utf8'))
      .concat([
        readFileSync(join(desktop, 'src-tauri/src/lib.rs'), 'utf8'),
        readFileSync(join(desktop, 'package.json'), 'utf8'),
        readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      ])
      .join('\n');
    expect(configText).not.toMatch(
      /disable-gpu|disable-software-rasterizer|LIBGL_ALWAYS_SOFTWARE/i,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts`

Expected: FAIL because `native/desktop/psyche-build-tauri` does not exist.

- [ ] **Step 3: Move the application and update literal paths mechanically**

Run `git mv native/macos/psyche-build-tauri native/desktop/psyche-build-tauri`. Replace the exact old path in tracked source, tests, workflows, scripts, and docs. Do not change `native/macos/comux-tauri` or `native/ios`.

- [ ] **Step 4: Regenerate the existing web bundles from the new path**

Run: `pnpm --dir native/desktop/psyche-build-tauri build:web`

Expected: `editor.bundle.js`, `sessions.bundle.js`, `panes.bundle.js`, and `diffs.bundle.js` rebuild successfully.

- [ ] **Step 5: Verify GREEN and path completeness**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts __tests__/tauriWebBundles.test.ts __tests__/tauriPackageScripts.test.ts
rg -n 'native/macos/psyche-build-tauri' --glob '!docs/superpowers/**' .
```

Expected: tests PASS and `rg` returns no executable/runtime references.

- [ ] **Step 6: Commit the mechanical move**

```bash
git add package.json pnpm-workspace.yaml .gitignore .github scripts docs __tests__ native/desktop
git commit -m "Move Tauri app to desktop runtime"
```

### Task 2: Split portable and platform-specific Tauri configuration

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json`
- Create: `tauri.macos.conf.json`, `tauri.windows.conf.json`, `tauri.linux.conf.json`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/Cargo.toml`
- Test: `__tests__/tauriDesktopPlatform.test.ts`

- [ ] **Step 1: Add failing configuration and CSP assertions**

Append tests which parse all four config files and assert:

```ts
it('keeps portable opaque defaults and macOS presentation in its overlay', () => {
  const base = json('tauri.conf.json');
  const mac = json('tauri.macos.conf.json');
  const win = json('tauri.windows.conf.json');
  const linux = json('tauri.linux.conf.json');
  expect(base.app.windows[0]).toMatchObject({ transparent: false, decorations: true });
  expect(base.app).not.toHaveProperty('macOSPrivateApi');
  expect(mac.app.windows[0]).toMatchObject({ transparent: true, titleBarStyle: 'Overlay' });
  expect(mac.app.macOSPrivateApi).toBe(true);
  expect(win.app.windows[0].transparent).toBe(false);
  expect(linux.app.windows[0].transparent).toBe(false);
  for (const config of [base, mac, win, linux]) {
    const csp = config.app?.security?.csp;
    if (!csp) continue;
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  }
});
```

Define `json(name)` once at file scope using `JSON.parse(readFileSync(join(desktop, 'src-tauri', name), 'utf8'))`.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts`

Expected: FAIL because the overlays are absent and the base remains transparent/macOS-specific.

- [ ] **Step 3: Create the portable base and overlays**

Keep the current CSP byte-for-byte in the base. Set the base window to `transparent: false`, remove `titleBarStyle`, `hiddenTitle`, and `macOSPrivateApi`, and use platform-neutral PNG icons. Put only macOS presentation and `bundle.macOS` settings in `tauri.macos.conf.json`. Explicitly keep Windows/Linux opaque in their overlays.

Move `window-vibrancy` and macOS-only Tauri features under:

```toml
[dependencies]
tauri = { version = "2", features = ["unstable"] }

[target.'cfg(target_os = "macos")'.dependencies]
window-vibrancy = "0.6"
```

- [ ] **Step 4: Generate platform development icons**

Run the pinned CLI from the desktop package against the existing `icons/icon.png` and retain only the necessary PNG/ICO/ICNS outputs:

```bash
pnpm --dir native/desktop/psyche-build-tauri exec tauri icon \
  src-tauri/icons/icon.png
```

- [ ] **Step 5: Verify configuration GREEN**

Run:

```bash
pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts __tests__/tauriDesktopTabs.test.ts
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Expected: PASS with no CSP relaxation.

- [ ] **Step 6: Commit portable configuration**

```bash
git add native/desktop/psyche-build-tauri/src-tauri __tests__/tauriDesktopPlatform.test.ts
git commit -m "Add portable Tauri platform configuration"
```

### Task 3: Introduce the shared Rust platform interface

**Files:**
- Create: `native/desktop/psyche-build-tauri/src-tauri/src/platform/{mod,macos,linux,windows}.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/coven_sessions.rs`

- [ ] **Step 1: Write failing Rust platform tests**

In `platform/mod.rs`, add tests for the pure selection helpers:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_info_omits_an_unavailable_webview_version() {
        let info = RuntimePlatformInfo::from_parts("linux", "x86_64", "WebKitGTK", None);
        assert_eq!(info.webview_engine, "WebKitGTK");
        assert_eq!(info.webview_version, None);
    }

    #[test]
    fn environment_paths_round_trip_with_platform_separators() {
        let input = std::env::join_paths([std::path::Path::new("one"), std::path::Path::new("two")]).unwrap();
        assert_eq!(split_and_deduplicate_paths(&input).len(), 2);
    }
}
```

- [ ] **Step 2: Run and verify RED**

Run: `cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml platform::tests --locked`

Expected: compile failure because `RuntimePlatformInfo` and the platform module do not exist.

- [ ] **Step 3: Implement the shared interface and target modules**

Expose these stable contracts from `platform/mod.rs`:

```rust
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct RuntimePlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub webview_engine: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webview_version: Option<String>,
}

impl RuntimePlatformInfo {
    fn from_parts(
        os: &'static str,
        arch: &'static str,
        webview_engine: &'static str,
        webview_version: Option<String>,
    ) -> Self {
        Self { os, arch, webview_engine, webview_version }
    }
}

pub fn runtime_info() -> RuntimePlatformInfo;
pub fn default_shell() -> (String, Vec<String>);
pub fn augmented_path() -> std::ffi::OsString;
pub fn configure_window(app: &tauri::App) -> Result<(), String>;
```

Use `tauri::webview_version().ok()` for the version. Return fixed engine identities by target: `WKWebView`, `WebView2`, and `WebKitGTK`. Keep values absent when unavailable.

Move Unix stable-cwd helpers behind `cfg(unix)` and implement the Windows canonical containment check without file-descriptor APIs. Change `app_environment` and `pty_start` to use `platform::default_shell()` and `platform::augmented_path()`.

In `coven_sessions.rs`, make the existing Unix socket collector return its current response on Unix. On Windows, return a typed unavailable response with `status: "unavailable"` and `reason: "local Coven Unix socket transport is unsupported on Windows"`.

- [ ] **Step 4: Verify Rust GREEN on the host**

Run:

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Expected: all commands exit 0.

- [ ] **Step 5: Cross-check Windows compilation before CI**

Run `rustup target add x86_64-pc-windows-msvc` on Windows and then:

```powershell
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Expected: exit 0 without Unix import errors.

- [ ] **Step 6: Commit the platform boundary**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src
git commit -m "Add cross-platform desktop runtime boundary"
```

### Task 4: Add three-platform desktop CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/SMOKE.md`
- Test: `__tests__/tauriDesktopPlatform.test.ts`

- [ ] **Step 1: Add a failing workflow contract**

Assert the parsed CI text contains `macos-15`, `windows-2025`, `ubuntu-24.04`, `libwebkit2gtk-4.1-dev`, and the new Cargo manifest path.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts`

Expected: FAIL because CI is macOS-only.

- [ ] **Step 3: Add the desktop matrix**

Create a `desktop-runtime` matrix job. Install the official Tauri Linux prerequisites only when `runner.os == 'Linux'`. Use PowerShell-safe commands on Windows or specify `shell: bash` only where Git for Windows provides it. Run locked install, `build:web`, Rust fmt/test/check, and the focused platform tests. Keep the full TypeScript/package and iOS jobs unchanged.

- [ ] **Step 4: Document local launch commands**

In `docs/SMOKE.md`, document `pnpm dev:tauri` on each OS and the Windows Coven transport limitation. Do not describe Windows/Linux artifacts as released.

- [ ] **Step 5: Run slice verification**

```bash
pnpm vitest --run __tests__/tauriDesktopPlatform.test.ts __tests__/tauriWebBundles.test.ts __tests__/tauriPackageScripts.test.ts __tests__/tauriDesktopTabs.test.ts
pnpm --dir native/desktop/psyche-build-tauri build:web
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

Expected: all exit 0. After push, require all three matrix entries to reach terminal success before calling Slice 1 verified.

- [ ] **Step 6: Commit CI and docs**

```bash
git add .github/workflows/ci.yml docs/SMOKE.md __tests__/tauriDesktopPlatform.test.ts
git commit -m "Verify desktop runtime across platforms"
```
