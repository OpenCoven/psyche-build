# Psyche Build Release Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Psyche Build `v0.1.0` as signed and notarized Intel and Apple Silicon DMGs, then distribute it through the existing OpenCoven Homebrew tap.

**Architecture:** The root package version is authoritative and a tested Node script synchronizes and validates every native manifest. A fail-closed GitHub Actions workflow builds the exact tag on native macOS runners, verifies Gatekeeper/notarization, and publishes both DMGs plus checksums. The existing Homebrew tap consumes only complete releases and renders an architecture-aware Cask.

**Tech Stack:** Node.js 24, pnpm 10, Vitest, Tauri 2, Rust, GitHub Actions, Apple codesign/notarytool, Homebrew Cask.

---

### Task 1: Establish one release version

**Files:**
- Create: `scripts/release-version.mjs`
- Create: `__tests__/releaseVersion.test.ts`
- Modify: `package.json`
- Modify: `native/macos/psyche-build-tauri/package.json`
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.toml`
- Modify: `native/macos/psyche-build-tauri/src-tauri/Cargo.lock`
- Modify: `native/macos/psyche-build-tauri/src-tauri/tauri.conf.json`

- [ ] **Step 1: Write failing synchronization tests**

Test temporary fixture manifests and require the release helper to reject malformed tags, report every mismatched manifest, and update all version locations to `0.1.0` without changing unrelated content.

```ts
expect(() => assertReleaseVersion(root, 'v0.1.0')).toThrow(/Cargo.toml.*0.0.7/);
await setReleaseVersion(root, '0.1.0');
expect(readReleaseVersions(root)).toEqual({
  packageJson: '0.1.0',
  nativePackageJson: '0.1.0',
  cargoToml: '0.1.0',
  cargoLock: '0.1.0',
  tauriConfig: '0.1.0',
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest --run __tests__/releaseVersion.test.ts`

Expected: FAIL because `scripts/release-version.mjs` does not exist.

- [ ] **Step 3: Implement the version helper**

Export `normalizeReleaseTag`, `readReleaseVersions`, `assertReleaseVersion`, and `setReleaseVersion`. The CLI accepts exactly one of:

```sh
node scripts/release-version.mjs --set 0.1.0
node scripts/release-version.mjs --check v0.1.0
```

Only stable `MAJOR.MINOR.PATCH` versions are accepted. `--check` exits nonzero and names every mismatched file; `--set` rewrites JSON with its existing indentation and only the package entry for `psyche-build-tauri` in Cargo files.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest --run __tests__/releaseVersion.test.ts`

Expected: all release-version tests pass.

- [ ] **Step 5: Set and verify `0.1.0`**

```sh
node scripts/release-version.mjs --set 0.1.0
node scripts/release-version.mjs --check v0.1.0
cargo metadata --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --locked --no-deps --format-version 1
```

Expected: every manifest reports `0.1.0`; Cargo metadata succeeds with the checked-in lockfile.

### Task 2: Add a fail-closed macOS release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `__tests__/releaseWorkflow.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing workflow contract test**

Read the workflow as text and require:

```ts
expect(workflow).toContain('macos-15-intel');
expect(workflow).toContain('macos-15');
expect(workflow).toContain('APPLE_CERTIFICATE');
expect(workflow).toContain('APPLE_SIGNING_IDENTITY');
expect(workflow).toContain('APPLE_ID');
expect(workflow).toContain('APPLE_PASSWORD');
expect(workflow).toContain('APPLE_TEAM_ID');
expect(workflow).toContain('spctl --assess');
expect(workflow).toContain('xcrun stapler validate');
expect(workflow).toContain('SHA256SUMS');
expect(workflow).toContain('Psyche-Build-v${RELEASE_VERSION}-${ARCH}.dmg');
expect(workflow).not.toMatch(/continue-on-error:\s*true/);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest --run __tests__/releaseWorkflow.test.ts`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Implement verification and build jobs**

Create a `v*` tag and manual-dispatch workflow which checks out the exact tag, installs pinned Node/pnpm/Rust toolchains, runs `pnpm release:check -- "$RELEASE_TAG"`, and completes the full TypeScript and Rust verification gate before building.

Use this native matrix:

```yaml
include:
  - runner: macos-15
    target: aarch64-apple-darwin
    arch: aarch64
  - runner: macos-15-intel
    target: x86_64-apple-darwin
    arch: x86_64
```

The build job imports the base64 `.p12` into an ephemeral keychain, runs the Tauri build with the Apple notarization environment, mounts the resulting DMG, and requires `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate` before uploading the renamed DMG.

- [ ] **Step 4: Implement atomic publication**

The publish job downloads both build artifacts, verifies there are exactly two architecture-specific DMGs, produces `SHA256SUMS`, and runs:

```sh
gh release create "$RELEASE_TAG" \
  --verify-tag \
  --title "Psyche Build $RELEASE_TAG" \
  --generate-notes \
  artifacts/*.dmg artifacts/SHA256SUMS
```

After publication, dispatch `psyche-build-release` to `OpenCoven/homebrew-tap` only when `HOMEBREW_TAP_TOKEN` is available.

- [ ] **Step 5: Verify GREEN and workflow syntax**

```sh
pnpm vitest --run __tests__/releaseWorkflow.test.ts
node scripts/release-version.mjs --check v0.1.0
git diff --check
```

Expected: contract tests and release checks pass with no whitespace errors.

### Task 3: Document and locally prove the release candidate

**Files:**
- Create: `docs/RELEASE.md`
- Modify: `README.md`

- [ ] **Step 1: Document the exact operator contract**

Document the six required Apple secrets, optional `HOMEBREW_TAP_TOKEN`, signed-tag command, manual recovery dispatch, artifact names, and post-release verification commands. State explicitly that an unsigned local build is not publishable.

- [ ] **Step 2: Add user-facing installation guidance**

Add the future stable command to README:

```sh
brew install --cask opencoven/tap/psyche-build
```

Keep source-development instructions separate so the command is not presented as live until the Cask is published.

- [ ] **Step 3: Run full candidate verification**

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --locked
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm --dir native/macos/psyche-build-tauri exec tauri build --bundles app,dmg
```

Expected: all tests/checks/builds pass and the local `0.1.0` app plus DMG exist. No claim about signing or notarization is made locally.

### Task 4: Integrate the Psyche Build release branch

**Files:** none beyond Tasks 1-3.

- [ ] **Step 1: Review the complete diff**

Run `git diff --check`, inspect every workflow permission and secret reference, and confirm no unrelated worktree files are present.

- [ ] **Step 2: Commit and publish a PR**

Commit only after Task 3 verification, push `feat/release-distribution-v1`, open a PR against `main`, wait for checks, address all actionable review feedback, and squash-merge only when the PR is green.

- [ ] **Step 3: Configure signing authority**

Copy the existing OpenCoven Apple release credentials into the Psyche Build repository under the documented names and set `HOMEBREW_TAP_TOKEN` if immediate Cask updates are desired. Secret values are never printed or copied through logs.

### Task 5: Publish `v0.1.0`

**Files:** Git tag and GitHub Release state only.

- [ ] **Step 1: Re-verify `main`**

On the merged commit, run the complete Task 3 verification gate and `node scripts/release-version.mjs --check v0.1.0`.

- [ ] **Step 2: Create and push a signed tag**

```sh
git tag -s v0.1.0 -m "Psyche Build v0.1.0"
git push origin v0.1.0
```

- [ ] **Step 3: Verify public artifacts**

Require the release workflow to succeed, download both DMGs and `SHA256SUMS`, run `shasum -a 256 -c SHA256SUMS`, and confirm GitHub reports `v0.1.0` as the latest stable release.

### Task 6: Add native Homebrew Cask support

**Repository:** `OpenCoven/homebrew-tap`

**Files:**
- Create: `Casks/psyche-build.rb`
- Create: `scripts/update-psyche-build-cask.sh`
- Create: `.github/workflows/update-psyche-build-cask.yml`
- Modify: `README.md`

- [ ] **Step 1: Write a fail-closed updater derived from the Coven Cave pattern**

Resolve only stable `vMAJOR.MINOR.PATCH` releases, fetch `SHA256SUMS`, require both `Psyche-Build-vTAG-aarch64.dmg` and `Psyche-Build-vTAG-x86_64.dmg`, verify both URLs are downloadable, and render an architecture-aware Cask installing `Psyche Build.app`.

- [ ] **Step 2: Add dispatch, schedule, and manual workflow triggers**

Handle `psyche-build-release`, run every six hours as a fallback, and support a manually supplied tag. Before committing any generated Cask, require:

```sh
brew style Casks/psyche-build.rb
brew audit --cask --online opencoven/tap/psyche-build
```

- [ ] **Step 3: Verify native installation on both architectures**

On Apple Silicon and Intel runners, require:

```sh
brew install --cask opencoven/tap/psyche-build
test -d "/Applications/Psyche Build.app"
brew uninstall --cask opencoven/tap/psyche-build
```

- [ ] **Step 4: Review, merge, and verify the public command**

Open a Homebrew tap PR, wait for style/audit/install checks, squash-merge, then verify `brew install --cask opencoven/tap/psyche-build` from a clean tap checkout.

### Task 7: Final public-surface audit

**Files:** none.

- [ ] **Step 1: Verify release and tap state live**

Confirm the release is stable and complete, the Cask version/checksums match it, and both architecture downloads return HTTP 200.

- [ ] **Step 2: Verify upgrade and uninstall behavior**

Run install, reinstall/upgrade, launch, uninstall, and `--zap` checks without leaving stale application state.

- [ ] **Step 3: Report remaining distribution gaps**

Report npm publication separately. Do not claim npm CLI availability until `npm view psyche-build version` returns the intended public version.
