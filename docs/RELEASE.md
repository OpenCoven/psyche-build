# Psyche Build v0.0.1 Release Runbook

**Status:** macOS `v0.0.1` published 2026-08-23; retained as the reproducible
release procedure and basis for subsequent release trains.

`.github/workflows/release.yml` supports an explicitly selected desktop-only
publication or a coordinated macOS/iOS release:

- macOS app `Psyche Build`, as signed and notarized Apple Silicon and Intel
  DMGs;
- iOS app `Psyche Build`, bundle ID `ai.opencoven.psyche-ios`, marketing
  version/build `0.0.1 (1)`, for internal TestFlight only;
- a curated GitHub Release and a native Homebrew Cask update.

The public `v0.0.1` macOS release used the verified desktop-only path, so iOS
distribution was skipped. This repository still does not claim a live
TestFlight build.

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

Protect `main` and `v*` tags before tagging. Two separate active tag rulesets
must restrict creation to approved release managers and block tag
update/deletion without giving those managers an immutability bypass.
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

MANIFEST=native/desktop/psyche-build-tauri/src-tauri/Cargo.toml
cargo fmt --manifest-path "$MANIFEST" --check
cargo test --manifest-path "$MANIFEST" --locked
cargo check --manifest-path "$MANIFEST" --locked
pnpm --dir native/desktop/psyche-build-tauri build:web
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

Protect `main` by layering an active branch ruleset over classic branch
protection. The ruleset owns the pull-request and review requirement and gives
only `BunsDev` a PR-only bypass. Classic protection continues to own the two
strict GitHub Actions checks, administrator enforcement, linear history,
conversation resolution, and the force-push/deletion prohibitions. Classic
`bypass_pull_request_allowances` must not be configured for `BunsDev`: that
classic allowance can bypass the pull-request requirement and permit a direct
push.

First resolve and pin the named actor. The recorded GitHub user ID for
`BunsDev` is `68980965`; stop if the live identity differs. The repository
currently enables merge commits, squash merges, and rebase merges, so those are
the only methods allowed by the ruleset. Re-read the repository settings before
applying this procedure and update both the payload and this documentation if
an enabled method changes. Classic linear-history enforcement still prevents a
merge commit from landing on `main`, while squash and rebase remain usable.

```sh
expected_bunsdev_id=68980965
bunsdev_id="$(gh api users/BunsDev --jq .id)"
if test "$bunsdev_id" != "$expected_bunsdev_id"; then
  echo "ERROR: BunsDev actor ID mismatch; expected $expected_bunsdev_id, got $bunsdev_id" >&2
  exit 1
fi

gh api repos/OpenCoven/psyche-build \
  --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'

main_ruleset_payload="$(jq -cn --argjson bunsdev_id "$bunsdev_id" '{
  name: "Main pull request governance",
  target: "branch",
  enforcement: "active",
  bypass_actors: [{actor_id: $bunsdev_id, actor_type: "User", bypass_mode: "pull_request"}],
  conditions: {
    ref_name: {
      include: ["refs/heads/main"],
      exclude: []
    }
  },
  rules: [{
    type: "pull_request",
    parameters: {
      allowed_merge_methods: ["merge", "squash", "rebase"],
      dismiss_stale_reviews_on_push: true,
      dismissal_restriction: {enabled: false, allowed_actors: []},
      require_code_owner_review: false,
      require_last_push_approval: true,
      required_approving_review_count: 1,
      required_review_thread_resolution: true
    }
  }]
}')"

main_ruleset_matches="$(
  gh api --paginate 'repos/OpenCoven/psyche-build/rulesets?includes_parents=false' \
    --jq '.[] | select(.name == "Main pull request governance" and .target == "branch") | .id'
)"
main_ruleset_match_count="$(printf '%s\n' "$main_ruleset_matches" | sed '/^$/d' | wc -l | tr -d ' ')"
test "$main_ruleset_match_count" -le 1

if test "$main_ruleset_match_count" -eq 0; then
  main_ruleset_id="$(
    printf '%s\n' "$main_ruleset_payload" |
      gh api --method POST repos/OpenCoven/psyche-build/rulesets --input - --jq .id
  )"
else
  main_ruleset_id="$main_ruleset_matches"
  printf '%s\n' "$main_ruleset_payload" |
    gh api --method PATCH "repos/OpenCoven/psyche-build/rulesets/$main_ruleset_id" --input - >/dev/null
fi

verified_main_ruleset="$(gh api "repos/OpenCoven/psyche-build/rulesets/$main_ruleset_id")"
printf '%s\n' "$verified_main_ruleset" |
  jq -e --argjson bunsdev_id "$bunsdev_id" '
    .name == "Main pull request governance" and
    .target == "branch" and
    .enforcement == "active" and
    .conditions.ref_name.include == ["refs/heads/main"] and
    .conditions.ref_name.exclude == [] and
    .bypass_actors == [{
      actor_id: $bunsdev_id,
      actor_type: "User",
      bypass_mode: "pull_request"
    }] and
    (.rules | length == 1) and
    .rules[0].type == "pull_request" and
    .rules[0].parameters.allowed_merge_methods == ["merge", "squash", "rebase"] and
    .rules[0].parameters.dismiss_stale_reviews_on_push == true and
    .rules[0].parameters.dismissal_restriction == {
      enabled: false,
      allowed_actors: []
    } and
    .rules[0].parameters.require_code_owner_review == false and
    .rules[0].parameters.require_last_push_approval == true and
    .rules[0].parameters.required_approving_review_count == 1 and
    .rules[0].parameters.required_review_thread_resolution == true
  ' >/dev/null
```

Only after that ruleset verification succeeds, replace the complete classic
branch-protection document. Setting `required_pull_request_reviews` to `null`
explicitly removes the classic review requirement so it cannot layer a second
approval gate over the PR-only ruleset bypass. Preserve every other protection:

```sh
jq -n '{
  required_status_checks: {
    strict: true,
    checks: [
      {context: "TypeScript and Rust"},
      {context: "iOS"}
    ]
  },
  enforce_admins: true,
  required_pull_request_reviews: null,
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: true,
  lock_branch: false,
  allow_fork_syncing: false
}' | gh api --method PUT repos/OpenCoven/psyche-build/branches/main/protection --input -
```

Verify the effective rules, the classic protection split, and the exact
ruleset actor/mode. Then perform the direct-push rejection probe only after the
actor preflight below. The GitHub CLI identity must be `BunsDev`. For an SSH
push URL, the non-mutating SSH greeting also verifies the Git credential actor.
For an HTTPS push URL, `gh auth status` and `gh api user` do not prove the Git
HTTP actor because Git may use a different credential helper. Do not inspect
credential-helper output or print credential material. Record the rejection
actor from GitHub output or an API audit if either identifies it; otherwise
record that the Git HTTP actor was not independently attributable and do not
describe the result as a `BunsDev`-specific rejection.

`git commit-tree` creates an unreferenced empty probe commit without changing
the worktree. Run this block in Bash: it retains at most 16 KiB of push stderr
and records the push exit code separately. A successful push is a critical
failure. A nonzero exit is conclusive only when GitHub reports `GH006` or
`GH013` and a required-pull-request violation; network, authentication,
credential, transport, and other failures are inconclusive and must abort
closure.

```bash
gh auth status --active --hostname github.com
active_gh_login="$(gh api user --jq .login)"
if test "$active_gh_login" != "BunsDev"; then
  echo "ERROR: active GitHub CLI actor is not BunsDev" >&2
  exit 1
fi

origin_push_url="$(git remote get-url --push origin)"
case "$origin_push_url" in
  git@github.com:*|ssh://git@github.com/*)
    ssh_actor_output="$(
      ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes \
        -T git@github.com 2>&1 || true
    )"
    if ! printf '%s\n' "$ssh_actor_output" | grep -Fq 'Hi BunsDev!'; then
      echo "INCONCLUSIVE: SSH Git credential actor is not BunsDev or could not be verified" >&2
      exit 1
    fi
    ;;
  https://github.com/*)
    echo "NOTICE: Git HTTP actor cannot be verified without credential-helper interaction; do not overclaim attribution" >&2
    ;;
  *)
    echo "INCONCLUSIVE: unsupported origin push URL for safe Git actor preflight" >&2
    exit 1
    ;;
esac

gh api repos/OpenCoven/psyche-build/rules/branches/main |
  jq -e 'any(.[]; .type == "pull_request")' >/dev/null

gh api repos/OpenCoven/psyche-build/branches/main/protection |
  jq -e '
    (.required_status_checks.strict == true) and
    ([.required_status_checks.checks[].context] == ["TypeScript and Rust", "iOS"]) and
    (.enforce_admins.enabled == true) and
    (has("required_pull_request_reviews") | not) and
    (.required_linear_history.enabled == true) and
    (.required_conversation_resolution.enabled == true) and
    (.allow_force_pushes.enabled == false) and
    (.allow_deletions.enabled == false)
  ' >/dev/null

verified_main_ruleset="$(gh api "repos/OpenCoven/psyche-build/rulesets/$main_ruleset_id")"
printf '%s\n' "$verified_main_ruleset" |
  jq -e --argjson bunsdev_id "$bunsdev_id" '
    .bypass_actors == [{
      actor_id: $bunsdev_id,
      actor_type: "User",
      bypass_mode: "pull_request"
    }]
  ' >/dev/null

git fetch origin main
probe_sha="$(
  printf 'Verify BunsDev direct pushes remain blocked\n' |
    git commit-tree "$(git rev-parse origin/main^{tree})" -p "$(git rev-parse origin/main)"
)"

probe_stderr_file="$(git rev-parse --git-path direct-push-probe.stderr)"
trap 'rm -f "$probe_stderr_file"' EXIT HUP INT TERM
set +e
GIT_TERMINAL_PROMPT=0 \
GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=30 -o StrictHostKeyChecking=yes' \
  git push origin "$probe_sha:refs/heads/main" 2>&1 >/dev/null |
  tail -c 16384 >"$probe_stderr_file"
probe_status="${PIPESTATUS[0]}"
set -e
probe_stderr="$(cat "$probe_stderr_file")"
rm -f "$probe_stderr_file"
trap - EXIT HUP INT TERM

if test "$probe_status" -eq 0; then
  printf '%s\n' "$probe_stderr" >&2
  echo "ERROR: direct-push rejection probe unexpectedly updated main" >&2
  exit 1
fi

if ! printf '%s\n' "$probe_stderr" | grep -Eq 'GH(006|013)' ||
   ! printf '%s\n' "$probe_stderr" |
     grep -Eiq 'Changes must be made through a pull request|required pull request'; then
  printf '%s\n' "$probe_stderr" >&2
  echo "INCONCLUSIVE: network, authentication, credential, transport, or other failure did not prove the pull-request policy" >&2
  exit 1
fi

printf '%s\n' "$probe_stderr"
```

The `pull_request` bypass mode keeps direct pushes platform-blocked for
`BunsDev`; force pushes and deletions are also prohibited. All other actors
must obtain the required approval. GitHub cannot create an author
self-approval review. Independent review remains preferred, but it is not
required for a `BunsDev` owner-authored administrative PR when no independent
reviewer is available. In that case, `BunsDev` uses the explicit PR-only bypass
for an admin merge, not a direct push or a claimed self-approval. Before that
admin merge, verify that the exact-head required checks are terminal and
successful and verify resolved conversations. Keep the recorded override reason
and exact SHA in the PR or linked incident/change record, and retain audit
evidence for the checks, conversation state, merge override, and resulting
merge.

## Emergency change procedure for #31

Normal protected-branch and protected-tag paths remain mandatory. If an urgent
production correction cannot wait for the normal path, use this exact
incident-scoped procedure:

- Open an incident issue before changing policy and identify the affected
  production behavior and the incident/change reason.
- Record the exact SHA and bounded change that the incident permits; any
  additional change requires a new recorded decision.
- Confirm the required exact-head checks are terminal and successful and all
  conversations are resolved before using the merge override.
- Use only the existing PR-only `BunsDev` bypass through a pull request and an
  explicit admin merge. The incident must not add another standing bypass actor,
  team, app, administrator, or user, and it permits no new actor or bypass mode.
- Record the merge override, its reason, the exact SHA, and the resulting merge
  in the incident/change record.
- Retain sanitized before/after settings, exact-head check evidence,
  conversation-resolution evidence, the merge audit records, and the incident
  result.
- Complete a post-event review covering the change, override, outcome, and any
  follow-up. Restore any incident-specific policy change; retain the existing
  PR-only `BunsDev` bypass without adding or changing an actor or mode.

An emergency is not authority to weaken the normal release environment,
immutable-tag ruleset, administrator enforcement, direct-push rejection,
required checks, or conversation resolution.

## Release tag rulesets

Protect `main` and `v*` tags now that repository rulesets are available. A
ruleset bypass applies to every rule in that ruleset, so use two separate active
tag rulesets: one lets the `Maintainers` team create a release tag, and the
other has no bypass actors and makes matching tags immutable.

```sh
jq -n --argjson team_id "$maintainers_team_id" '{
  name: "Release tag creation",
  target: "tag",
  enforcement: "active",
  bypass_actors: [{actor_id: $team_id, actor_type: "Team", bypass_mode: "always"}],
  conditions: {ref_name: {include: ["refs/tags/v*"], exclude: []}},
  rules: [{type: "creation"}]
}' | gh api --method POST repos/OpenCoven/psyche-build/rulesets --input -

jq -n '{
  name: "Immutable release tags",
  target: "tag",
  enforcement: "active",
  bypass_actors: [],
  conditions: {ref_name: {include: ["refs/tags/v*"], exclude: []}},
  rules: [{type: "update"}, {type: "deletion"}]
}' | gh api --method POST repos/OpenCoven/psyche-build/rulesets --input -
```

Verify `main` protection, both active tag rulesets and their exact bypass
actors, the reviewer team, `prevent_self_review=true`, and both custom
deployment policies before adding credentials.

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
gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=false
```

Tag pushes always run the coordinated macOS and internal TestFlight release.
When TestFlight credentials or Apple distribution infrastructure are not ready,
an operator may manually publish only the desktop artifacts from the same
existing immutable tag:

```sh
gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=true
```

Desktop-only publication still requires `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD`, `APPLE_TEAM_ID`, and `HOMEBREW_TAP_TOKEN` in the protected
`release` environment. It does not require `APPLE_DISTRIBUTION_CERTIFICATE`,
`APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD`, `APP_STORE_CONNECT_KEY_ID`,
`APP_STORE_CONNECT_ISSUER_ID`, or `APP_STORE_CONNECT_PRIVATE_KEY`. It still
requires the signed annotated tag, both signed and notarized DMGs, checksums,
curated notes, protected-environment approval, and Homebrew notification.
Desktop-only publication does not upload or claim TestFlight availability.
The shared protocol/schema validation in the root test, typecheck, and build
gate remains mandatory in both modes. Only iOS-specific XcodeGen setup,
simulator availability, generated-project checking, Core/app/UI verification,
distribution credentials, archive, and upload work is skipped.

For either manual mode, retain the workflow run URL, exact release SHA, the
resolved `desktop_only` output, and the `verify`, both `build-macos`,
`upload-ios`, `publish`, and `notify-homebrew` job results. For desktop-only
publication, the expected `upload-ios` result is `skipped`; for a coordinated
release it must be `success`. A failed/cancelled shared verification or macOS
build is not acceptable evidence and must not reach publication.

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
