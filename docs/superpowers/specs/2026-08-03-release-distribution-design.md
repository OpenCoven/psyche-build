# Psyche Build Release Distribution Design

## Goal

Ship the first public Psyche Build macOS release as `v0.1.0`, with one
authoritative version, signed and notarized Apple Silicon and Intel DMGs,
checksums, a GitHub Release, and native installation through the existing
OpenCoven Homebrew tap.

## Release identity

The root `package.json` version is authoritative. A release preparation script
sets that version in the native package, Cargo manifest, and Tauri config. A
separate fail-closed check verifies that all four values match the requested
`vMAJOR.MINOR.PATCH` tag before any artifact is built or published.

The first public version is `0.1.0`. Existing `v0.0.x` tags remain historical
source markers; they are not treated as public binary releases.

## macOS artifacts

The release workflow builds on native GitHub-hosted macOS runners:

- Apple Silicon on `macos-15`, producing an `aarch64` DMG.
- Intel on `macos-15-intel`, producing an `x86_64` DMG.

Both jobs build the exact release tag, import the Developer ID certificate,
sign and notarize through Tauri, and then require `codesign`, `spctl`, and
`stapler` verification to pass. Artifacts are renamed to stable public names:

- `Psyche-Build-v0.1.0-aarch64.dmg`
- `Psyche-Build-v0.1.0-x86_64.dmg`

A publish job downloads both verified artifacts, generates `SHA256SUMS`, and
creates the GitHub Release only after the complete set is present. The workflow
never offers an unsigned or partially uploaded recovery mode.

## Signing and publication authority

The repository must receive the existing OpenCoven Apple release credentials
under the same secret names used by Coven Cave:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

`HOMEBREW_TAP_TOKEN` is optional. With it, the release workflow immediately
dispatches a cask update. Without it, a scheduled tap workflow provides a
no-secrets fallback.

Apple and Homebrew credentials live only in an approval-protected `release`
Environment. An active `v*` tag ruleset restricts release-tag creation and
blocks updates and deletion. The workflow accepts only signed tags whose
commit is already on `origin/main`, then passes that verified commit SHA to
every build and publication job. Rust is fixed by the repository
`rust-toolchain.toml` and explicit workflow inputs so a retry cannot silently
change compilers.

Publishing is tag-authoritative. The tag must already exist on `origin`, point
at the commit being built, and match every configured version. Missing secrets,
missing artifacts, failed notarization, or checksum disagreement stops the
release.

Publication and Homebrew notification are independently retryable. A rerun may
reuse an existing public release only after downloading all three assets,
matching them byte-for-byte to the verified build output, and validating
`SHA256SUMS`.

## Homebrew distribution

Psyche Build is a GUI application, so it ships as a Homebrew Cask in
`OpenCoven/homebrew-tap`, not as a Formula. The cask selects the correct DMG by
architecture and installs `Psyche Build.app`:

```sh
brew install --cask opencoven/tap/psyche-build
```

The tap updater reads the latest stable GitHub Release, requires both DMGs and
their entries in `SHA256SUMS`, renders `Casks/psyche-build.rb`, and validates it
with `brew style`, `brew audit --cask --online`, and native install smoke tests.
It must not create or update the cask while the release is incomplete.

The Node CLI remains a separate distribution surface. Publishing it to npm is
allowed after the same version and package smoke gates pass, but a Homebrew
Formula is intentionally deferred until Psyche ships a standalone CLI binary
that does not require a separate Node installation.

## Verification and rollout

Before the tag is pushed:

1. Version and workflow contract tests pass.
2. The full TypeScript/Vitest and Rust suites pass.
3. Type checking, production builds, formatting, and package smoke checks pass.
4. An unsigned local DMG build proves packaging; CI alone performs signing and
   notarization.

After publication:

1. Both release assets and `SHA256SUMS` are downloadable.
2. GitHub identifies `v0.1.0` as the latest stable release.
3. The cask renders with the published checksums.
4. `brew install`, `brew upgrade`, `brew uninstall`, and direct app launch pass
   on Apple Silicon and Intel.

The release is complete only after those public-surface checks succeed.
