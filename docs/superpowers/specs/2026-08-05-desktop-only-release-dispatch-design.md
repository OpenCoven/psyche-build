# Desktop-Only Release Dispatch Design

## Goal

Allow an operator to publish the macOS desktop application and Homebrew Cask
without requiring the iOS/TestFlight credentials, while preserving the
coordinated macOS+iOS behavior for tag-triggered production releases.

## Scope

The existing `Release` workflow gains a manual `desktop_only` boolean input.
The default is `false`.

- A `v*` tag push always runs the existing coordinated release.
- A manual dispatch with `desktop_only=false` rebuilds the existing coordinated
  release from an immutable tag.
- A manual dispatch with `desktop_only=true` verifies the same immutable tag,
  builds both signed and notarized macOS DMGs, publishes the curated GitHub
  Release, and notifies the Homebrew tap.
- Desktop-only mode does not run the iOS upload job and does not require Apple
  Distribution or App Store Connect credentials.

This patch does not weaken macOS signing, notarization, checksum, release-note,
tag, source-SHA, protected-environment, or Homebrew requirements.

## Workflow Design

The verification job exposes a `desktop_only` output derived exclusively from
the manual-dispatch input. Tag pushes resolve it to `false`.

The iOS upload job receives:

```yaml
if: needs.verify.outputs.desktop_only != 'true'
```

The publish job continues to depend on `verify`, `build-macos`, and
`upload-ios`, but uses `if: always()` and rejects every dependency state except:

- `verify` succeeded;
- `build-macos` succeeded;
- `upload-ios` succeeded for coordinated releases; or
- `upload-ios` was skipped for an explicitly verified desktop-only release.

This keeps dependency routing fail-closed. A failed or cancelled iOS job can
never be interpreted as desktop-only.

The Homebrew notification remains downstream of successful publication and is
unchanged.

## Release Metadata

Desktop-only and coordinated runs publish the same stable `v0.0.1` GitHub
Release contract:

- `Psyche-Build-v0.0.1-aarch64.dmg`
- `Psyche-Build-v0.0.1-x86_64.dmg`
- `SHA256SUMS`
- curated changelog notes

The GitHub Release does not claim TestFlight availability. TestFlight status is
verified separately only during coordinated runs.

## Error Handling

- `desktop_only` is accepted only from `workflow_dispatch`.
- Tag-triggered runs cannot opt out of iOS.
- Publish fails if the iOS result is `failure`, `cancelled`, or an unexpected
  `skipped` state.
- macOS signing/notarization and Homebrew credentials remain mandatory.
- Manual recovery still requires an existing signed annotated tag whose commit
  is on `origin/main`.

## Testing

Workflow contract tests will require:

- the `desktop_only` manual input with a false default;
- the verify-job output and tag-push fail-closed behavior;
- iOS skipping only for verified desktop-only dispatches;
- publish acceptance of exactly `success` or authorized `skipped` for iOS;
- rejection of failed/cancelled iOS results;
- unchanged macOS signing, artifact, notes, and Homebrew contracts.

The release runbook will document the desktop-only recovery command and list
the reduced credential set without changing the coordinated release
instructions.
