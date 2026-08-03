# Psyche Build v0.0.1 Release Runbook

This runbook publishes one coordinated release from
`.github/workflows/release.yml`:

- macOS app `Psyche Build`, as signed and notarized Apple Silicon and Intel
  DMGs;
- iOS app `Psyche Build`, bundle ID `ai.opencoven.psyche-ios`, marketing
  version/build `0.0.1 (1)`, for internal TestFlight only;
- a curated GitHub Release and a native Homebrew Cask update.

The Node CLI ships in the source tree and npm package archive, but `0.0.1` is
not an npm release. Windows, Linux, Android, external TestFlight, and public App
Store distribution are unavailable in `0.0.1`.

## Apple and GitHub setup

In Apple Developer and App Store Connect, confirm one OpenCoven team and Team
ID owns both the Developer ID and iOS distribution identities. Then create:

- an explicit App ID named `Psyche Build` for `ai.opencoven.psyche-ios`, with
  only capabilities used by the project;
- an App Store Connect iOS record named `Psyche Build`, primary language
  English (U.S.), bundle ID `ai.opencoven.psyche-ios`, SKU `psyche-ios`, and
  access limited to the intended internal team;
- an internal group named `OpenCoven Internal`, with only authorized OpenCoven
  testers and automatic distribution for eligible builds;
- a least-privilege team App Store Connect API key that can upload builds, read
  processing state, and manage internal TestFlight metadata.

Record the truthful export-compliance answer before release. If project
metadata must change as a result, land and verify that change before tagging.

Identify a non-self release reviewer before publication and have them confirm
that they can review this release. The repository's current GitHub plan exposes
required environment reviewers and repository rulesets only after the
repository is public, so create the protected GitHub `release` environment in
the final-audit sequence below, not while the repository is private.

Prepare every credential below for interactive entry after that environment
exists. Each credential is required and belongs only in that environment:

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64 Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Developer ID `.p12` password |
| `APPLE_SIGNING_IDENTITY` | Developer ID identity name or SHA-1 fingerprint |
| `APPLE_ID` | Apple account used by `notarytool` |
| `APPLE_PASSWORD` | App-specific password for `APPLE_ID` |
| `APPLE_DISTRIBUTION_CERTIFICATE` | Base64 Apple Distribution `.p12` |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | Distribution `.p12` password |
| `APP_STORE_CONNECT_KEY_ID` | Team API key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | Team API issuer ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | Complete downloaded `.p8` contents |
| `APPLE_TEAM_ID` | Confirmed team ID shared by both release identities |
| `HOMEBREW_TAP_TOKEN` | Least-privilege token that dispatches `OpenCoven/homebrew-tap` |

Do not stage these values in files or create repository-level fallback secrets.
There is no repository-secret fallback, scheduled no-secret fallback, or
optional secret for this release.

Protect `main` and `v*` tags before tagging. The active tag ruleset must
restrict creation to approved release managers and block tag update/deletion.
The workflow separately requires a verified signed annotated tag whose commit
is on `origin/main`, and every secret-bearing or publishing job waits at the
protected `release` environment.

## Prepare the release commit

Use a clean branch based on `origin/main`:

```sh
pnpm install --frozen-lockfile
pnpm release:version -- 0.0.1
pnpm release:check -- v0.0.1
```

`package.json` is the authoritative version. The version command synchronizes
the native package, Cargo manifest and lockfile, Tauri config, source
`native/ios/project.yml`, and generated Xcode project. XcodeGen owns the
committed Xcode project and `Info.plist`; never hand-edit generated metadata.

Run the full release gate:

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
pnpm ios:project:check
```

Generate and inspect the curated notes sourced from the single `0.0.1`
`CHANGELOG.md` entry. Do not use generated GitHub notes:

```sh
node scripts/release-notes.mjs --github 0.0.1 > /tmp/psyche-v0.0.1-notes.md
node scripts/release-notes.mjs --testflight 0.0.1 > /tmp/psyche-v0.0.1-testflight.txt
```

The generated TestFlight text is input, not the final localization. The client
uses `normalizeTestFlightNotes`: it removes existing `Source commit:` lines,
trims the curated text, and appends exactly one
`Source commit: <40-hex release SHA>` line. It enforces the 4,000 Unicode code
points limit on that final localization after provenance is appended.

## Final audit, visibility, and signed tag

Keep the repository private through the final release-commit, secret audit, and
publication audit.
Scan the full history and the exact `git archive` publication tree with
redacted Gitleaks output, review every finding, confirm there are no GitHub
release artifacts/caches/repository secrets, and confirm the unchanged release
commit. Only after that private audit, make the repository public and enable
secret scanning and push protection. The repository must be public before the
tag; the workflow fails before accessing credentials when it is private.

Once a non-self member of the OpenCoven `Maintainers` team has accepted release
review duty, attach that team with read access and create the protected
`release` environment. The workflow has two valid entry points: a `v*` tag push
and a manual recovery dispatch from `main`. Use selected branch/tag policies for
those exact refs; a protected-branches-only policy rejects the tag-triggered
jobs.

```sh
gh api --method PATCH repos/OpenCoven/psyche-build -f visibility=public
gh api --method PATCH repos/OpenCoven/psyche-build \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'

gh api --method PUT \
  orgs/OpenCoven/teams/maintainers/repos/OpenCoven/psyche-build \
  -f permission=pull

maintainers_team_id="$(gh api orgs/OpenCoven/teams/maintainers --jq .id)"
environment_payload="$(mktemp)"
trap 'rm -f "$environment_payload"' EXIT
jq -n --argjson team_id "$maintainers_team_id" '{
  wait_timer: 0,
  prevent_self_review: true,
  reviewers: [{type: "Team", id: $team_id}],
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true
  }
}' > "$environment_payload"
gh api --method PUT repos/OpenCoven/psyche-build/environments/release --input "$environment_payload"
gh api --method POST \
  repos/OpenCoven/psyche-build/environments/release/deployment-branch-policies \
  -f name=main -f type=branch
gh api --method POST \
  repos/OpenCoven/psyche-build/environments/release/deployment-branch-policies \
  -f name='v*' -f type=tag
```

Protect `main` and `v*` tags now that repository rulesets are available. The
active tag rules must allow only approved release managers to create matching
tags and must block tag update/deletion. Verify `main` protection, the tag
rules, the reviewer team, `prevent_self_review=true`, and both custom deployment
policies before adding credentials.

Use interactive `gh secret set --env release --repo OpenCoven/psyche-build`
input for every value in the table above. Verify the exact names with
`gh secret list --env release`, and require
`gh secret list --repo OpenCoven/psyche-build` to remain empty. Never pass a
secret value on a command line or write it to the worktree.

Resolve the unchanged reviewed commit and create the signed annotated tag:

```sh
test -z "$(git status --porcelain)"
git fetch origin main --tags
release_sha="$(git rev-parse origin/main)"
git checkout --detach "$release_sha"
test "$(git rev-parse HEAD)" = "$release_sha"
test -z "$(git status --porcelain)"
pnpm install --frozen-lockfile
pnpm release:check -- v0.0.1
node scripts/release-notes.mjs --github 0.0.1 > /tmp/psyche-v0.0.1-notes.md
node scripts/release-notes.mjs --testflight 0.0.1 > /tmp/psyche-v0.0.1-testflight.txt
node --input-type=module - "$release_sha" /tmp/psyche-v0.0.1-testflight.txt <<'NODE'
import { readFile } from 'node:fs/promises';
import { normalizeTestFlightNotes } from './scripts/app-store-connect.mjs';

const normalized = normalizeTestFlightNotes(
  await readFile(process.argv[3], 'utf8'),
  process.argv[2],
);
console.log(`Final TestFlight localization: ${[...normalized].length} Unicode code points`);
NODE
git tag -s v0.0.1 "$release_sha" -m "Psyche Build v0.0.1"
git verify-tag v0.0.1
test "$(git rev-list -n 1 v0.0.1)" = "$release_sha"
git push origin v0.0.1
```

Have the configured non-self reviewer approve the pending `release`
deployment once. Do not bypass the environment or start a duplicate run.

## Workflow behavior and recovery

The tag run verifies the exact tag/source SHA, all version surfaces, tests,
generated iOS files, the iOS archive identity/provenance, both macOS artifacts,
and curated notes. It publishes only after the macOS and internal TestFlight
jobs succeed.

For an infrastructure, runner, archive, export, or upload interruption, prove
the failure is transient and manually dispatch the existing immutable tag from
`main`:

```sh
gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1
```

The retry rebuilds the exact tag. Its App Store Connect preflight is
fail-closed:

- Only exit status `2`, caused by an absent exact iOS prerelease version or an
  absent exact build, permits the workflow to validate and upload the freshly
  exported IPA.
- An existing `0.0.1 (1)` is reused without upload only when its identity is
  exact, its processing state is `VALID`, and it has exactly one `en-US`
  beta-build localization containing exactly one line
  `Source commit: <40-hex release SHA>` that matches the immutable tag commit.
- Every other result is fatal: any non-VALID build (including `PROCESSING`,
  `FAILED`, or `INVALID`), a duplicate or malformed identity result, zero or
  multiple localizations for an existing build, or a provenance mismatch. These
  states must never fall through to upload or build 2.

A published GitHub Release is reused only when its three artifacts and curated
notes byte-match the verified output; a draft may have its assets replaced
before it is reverified and published.

App Store Connect processing has a hard 45-minute bound. The
`pnpm release:testflight --` command is workflow-internal: it requires
credentials from the protected GitHub `release` environment and mutates the
`en-US` TestFlight localization. Do not run it locally. Operators recover by
manually dispatching the immutable tag with `gh workflow run Release`, as shown
above. The invocation is included here only to document the workflow's hard
bound:

```sh
pnpm release:testflight -- \
  --bundle-id ai.opencoven.psyche-ios \
  --version 0.0.1 \
  --build-number 1 \
  --locale en-US \
  --notes-file /tmp/psyche-v0.0.1-testflight.txt \
  --release-sha "$release_sha" \
  --timeout-seconds 2700
```

Do not extend that bound. If processing times out, let the run fail, confirm
App Store Connect state, and retry the existing tag. Stop on a FAILED/INVALID
build or identity/provenance mismatch. Do not claim TestFlight availability
until `Psyche Build 0.0.1 (1)` is `Ready to Test` for `OpenCoven Internal` and
an authorized tester can see it.

## Verify the GitHub release

The complete public asset set is exactly:

- `Psyche-Build-v0.0.1-aarch64.dmg`
- `Psyche-Build-v0.0.1-x86_64.dmg`
- `SHA256SUMS`

Verify all three files and both checksums:

```sh
release_dir="$(mktemp -d)"
gh release download v0.0.1 --repo OpenCoven/psyche-build --dir "$release_dir"
(
  cd "$release_dir"
  test "$(find . -maxdepth 1 -type f | wc -l | tr -d ' ')" = 3
  shasum -a 256 -c SHA256SUMS
)
gh release view v0.0.1 --repo OpenCoven/psyche-build \
  --json tagName,isDraft,isPrerelease,isLatest,body,url
```

Require a public/latest/stable release whose body exactly matches the curated
changelog entry. Require both DMG URLs to return HTTP 200 before Homebrew work.

## Homebrew publication and recovery

The application is a Cask, not a Formula. The release workflow dispatches
`OpenCoven/homebrew-tap` only after publication. If notification fails, do not
rebuild or republish the app; manually run the tap's existing updater:

```sh
gh workflow run "Update Psyche Build cask" \
  --repo OpenCoven/homebrew-tap \
  --ref main \
  -f tag=v0.0.1
```

Verify the updater PR's two URLs and hashes against the published assets, then
require tap CI and review before merge. Once the `v0.0.1` release and Cask are
actually available, public macOS installation is:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```
