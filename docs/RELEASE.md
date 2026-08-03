# Psyche Build Release Runbook

This runbook publishes the macOS application. A local `.app` or `.dmg` proves
packaging only; public artifacts must be signed, notarized, verified by
Gatekeeper, and produced by `.github/workflows/release.yml`.

## One-time setup

The repository must be public before publication. Homebrew cannot download
release assets from a private GitHub repository. The release workflow checks
`github.event.repository.private` and exits before using signing credentials
when this requirement is not met.

Configure these repository secrets using the existing OpenCoven Apple release
credentials:

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used to export the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Developer ID identity name or SHA-1 fingerprint |
| `APPLE_ID` | Apple Developer account used by `notarytool` |
| `APPLE_PASSWORD` | App-specific password for `APPLE_ID` |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `HOMEBREW_TAP_TOKEN` | Optional token allowed to dispatch `OpenCoven/homebrew-tap` |

The first six values are mandatory and the workflow fails closed when any is
missing. `HOMEBREW_TAP_TOKEN` only makes the Cask update immediate; the tap's
scheduled workflow is the no-secrets fallback.

The pnpm workspace declaration must also be present on the release commit so a
fresh `pnpm install --frozen-lockfile` installs the native CodeMirror and Tauri
dependencies.

## Prepare a release

Use a clean branch based on `origin/main`:

```sh
pnpm install --frozen-lockfile
pnpm release:version -- 0.1.0
pnpm release:check -- v0.1.0
```

`package.json` is the authoritative version. The version command synchronizes
the native package, Cargo manifest and lockfile, and Tauri config. Commit all
five version changes together.

Run the complete release gate:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack

MANIFEST=native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo fmt --manifest-path "$MANIFEST" --check
cargo test --manifest-path "$MANIFEST" --locked
cargo check --manifest-path "$MANIFEST" --locked
pnpm --dir native/macos/psyche-build-tauri build:web
```

For a local packaging smoke test:

```sh
pnpm --dir native/macos/psyche-build-tauri exec tauri build --bundles app,dmg
```

Do not upload that local artifact. Unless the local machine has explicitly
configured Developer ID and notary credentials, it is not the CI-verified
release artifact.

## Publish

After the release preparation PR is merged and the merged commit passes the
same gate, create a signed tag:

```sh
git switch main
git pull --ff-only origin main
pnpm release:check -- v0.1.0
git tag -s v0.1.0 -m "Psyche Build v0.1.0"
git push origin v0.1.0
```

The workflow builds on native Apple Silicon and Intel runners and publishes
only this complete set:

- `Psyche-Build-v0.1.0-aarch64.dmg`
- `Psyche-Build-v0.1.0-x86_64.dmg`
- `SHA256SUMS`

The GitHub Release remains a draft until both architecture jobs pass
`codesign`, Gatekeeper, and stapler validation and all three files have been
uploaded.

If a draft release needs a retry after an infrastructure failure, dispatch the
workflow from `main` against the existing tag:

```sh
gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.1.0
```

The retry may replace assets on an existing draft. It refuses to overwrite a
published release.

## Verify the public release

```sh
release_dir="$(mktemp -d)"
gh release download v0.1.0 \
  --repo OpenCoven/psyche-build \
  --dir "$release_dir"
(
  cd "$release_dir"
  shasum -a 256 -c SHA256SUMS
)
gh release view v0.1.0 \
  --repo OpenCoven/psyche-build \
  --json tagName,isDraft,isPrerelease,url
```

Require `isDraft: false`, `isPrerelease: false`, both checksum validations,
and HTTP 200 responses for both DMGs before updating Homebrew.

## Homebrew

The application is a Cask, not a Formula:

```sh
brew install --cask opencoven/tap/psyche-build
brew upgrade --cask opencoven/tap/psyche-build
brew uninstall --cask opencoven/tap/psyche-build
```

The tap updater consumes `SHA256SUMS` and refuses to render or update the Cask
unless both architecture-specific DMGs are downloadable.

## npm status

The Node CLI is a separate release surface. Do not advertise it as published
until this command returns the intended version:

```sh
npm view psyche-build version
```

A Homebrew Formula remains out of scope until the CLI ships as a standalone
binary without a separate Node installation.
