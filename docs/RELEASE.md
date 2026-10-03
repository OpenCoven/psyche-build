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
| `HOMEBREW_TAP_TOKEN` | Fine-grained token limited to `OpenCoven/homebrew-tap` that opens the Cask bump pull request (Contents and Pull requests: read and write) |

Do not stage these values in files or create repository-level fallback secrets.
There is no repository-secret fallback, scheduled no-secret fallback, or
optional secret for this release.

One more secret, `UPDATE_MANIFEST_SIGNING_KEY`, also lives only in the `release`
environment. It is required only once `release/update-manifest-keys.json`
names a current key; see [Update manifest signing](#update-manifest-signing).

Before tagging, also check the Homebrew token:

- [ ] Confirm `HOMEBREW_TAP_TOKEN` has **Pull requests: read and write** (as
  well as **Contents: read and write**) on `OpenCoven/homebrew-tap`. The
  retired `repository_dispatch` needed only Contents write, so an older token
  may lack the pull request permission. If you find the gap after the
  release, fix the token and re-run the `homebrew-tap-pr` job;
  `homebrew-tap-pr.mjs open` is safe to re-run.

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

## Project-config rollback floor

A rollback reinstalls an older release over projects and state the newer build
already wrote. The oldest release you may roll back to is the rollback floor.
`release/rollback-floor.json` pins it, together with every persisted-format
version that release can read. CI runs `pnpm release:rollback-floor` in the
Quality job. The check fails when any pinned constant differs from its floor
value, and it fails closed when the floor file is missing or malformed.

The current floor is `v0.0.2`. Each value below is what `v0.0.2` reads
(`git show v0.0.2:<source>`):

| Constant | Source | Floor | What `v0.0.2` does with a newer version |
|---|---|---|---|
| `PROJECT_CONFIG_SCHEMA_VERSION` | `src/services/ProjectPaneConfig.ts` | 1 | Predates the #464 gate, so it reads the file anyway and can overwrite fields it does not understand. |
| `RECOVERY_MARKER_VERSION` | `src/services/WorktreeRecoveryMarker.ts` | 5 | Rejects the marker. Listing throws and cleanup is blocked, which strands recovery. |
| `PANE_SLUG_RECORD_VERSION` | `src/services/PaneSlugRegistry.ts` | 1 | Treats the slug-ownership record as invalid. |
| `PSYCHE_TMUX_CONFIG_VERSION` | `src/utils/tmuxManagedConfig.ts` | 1 | Replaces the managed tmux block with its own version-1 block. |
| `RITUAL_VERSION` | `src/utils/rituals.ts` | 1 | Drops the ritual: `normalizeRitual` returns null. |
| `PANE_LAYOUT_VERSION` | `src/layout/PaneLayoutTree.ts` | 1 | Ignores the saved layout. `v0.0.2` used a literal `1`. |

To raise the floor for one constant, so a later release can bump it:

1. Ship a release that reads the newer version of that format, or refuses it
   safely (for the project config, refuses it with `config_newer_schema`),
   without bumping the constant. Publish it and confirm it as the supported
   rollback target.
2. In a dedicated pull request, edit `release/rollback-floor.json`: set
   `release` to that tag and update `reason`. Keep every value in
   `persistedFormatVersions` at what that release reads.
3. Only in a later pull request, bump the constant and its
   `persistedFormatVersions` entry together. This is safe only because the
   new floor reads or refuses the newer file instead of breaking on it. For
   the project config, that release must give the operator a pre-launch path:
   restore the `config-schema-snapshots` copy written on the first superseding
   write, or quarantine the project.

A new persisted format with a version constant goes into both `PINNED_FORMATS`
in `scripts/release-rollback-floor.mjs` and the floor file in the same change.

Treat a floor change as R4: it changes what a rollback can recover. Never edit
the floor file only to make CI pass.

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
protection. The ruleset owns the pull-request requirement and review-thread
resolution and carries **no bypass actor**. Classic protection continues to own
the two strict GitHub Actions checks, administrator enforcement, linear history,
conversation resolution, and the force-push/deletion prohibitions. Classic
`bypass_pull_request_allowances` must not be configured for `BunsDev`: that
classic allowance can bypass the pull-request requirement and permit a direct
push.

OpenCoven has a single member, so an approving review can never be obtained:
GitHub does not allow an author to approve their own pull request. A standing
`required_approving_review_count` of 1 therefore forced an administrative
bypass on every merge, which recorded ordinary work as an override and made the
bypass — not the review — the operative policy. The requirement is set to 0 and
the bypass actor removed, so merges are legitimate rather than overrides.
Restore an approval requirement when the organization gains a second member who
can review.

First resolve and pin the named actor. The recorded GitHub user ID for
`BunsDev` is `68980965`; stop if the live identity differs. The repository
currently enables merge commits, squash merges, and rebase merges, so those are
the only methods allowed by the ruleset. Re-read the repository settings before
applying this procedure and update both the payload and this documentation if
an enabled method changes. Classic linear-history enforcement still prevents a
merge commit from landing on `main`, while squash and rebase remain usable.

The ruleset payload no longer names an actor, so nothing interpolates the owner
ID. The identity preflight below remains as an operator guard: it stops the
procedure when the account running it is not the expected owner, before any
policy mutation.

```sh
expected_bunsdev_id=68980965
bunsdev_id="$(gh api users/BunsDev --jq .id)"
if test "$bunsdev_id" != "$expected_bunsdev_id"; then
  echo "ERROR: BunsDev actor ID mismatch; expected $expected_bunsdev_id, got $bunsdev_id" >&2
  exit 1
fi

gh api repos/OpenCoven/psyche-build \
  --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'

main_ruleset_payload="$(jq -cn '{
  name: "Main pull request governance",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
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
      dismiss_stale_reviews_on_push: false,
      dismissal_restriction: {enabled: false, allowed_actors: []},
      require_code_owner_review: false,
      require_extra_approval_for_unattributed_changes: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
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
  jq -e '
    .name == "Main pull request governance" and
    .target == "branch" and
    .enforcement == "active" and
    .conditions.ref_name.include == ["refs/heads/main"] and
    .conditions.ref_name.exclude == [] and
    .bypass_actors == [] and
    (.rules | length == 1) and
    .rules[0].type == "pull_request" and
    .rules[0].parameters.allowed_merge_methods == ["merge", "squash", "rebase"] and
    .rules[0].parameters.dismiss_stale_reviews_on_push == false and
    .rules[0].parameters.dismissal_restriction == {
      enabled: false,
      allowed_actors: []
    } and
    .rules[0].parameters.require_code_owner_review == false and
    .rules[0].parameters.require_extra_approval_for_unattributed_changes == false and
    .rules[0].parameters.require_last_push_approval == false and
    .rules[0].parameters.required_approving_review_count == 0 and
    .rules[0].parameters.required_review_thread_resolution == true
  ' >/dev/null
```

Only after that ruleset verification succeeds, replace the complete classic
branch-protection document. Setting `required_pull_request_reviews` to `null`
explicitly removes the classic review requirement so it cannot layer an
approval gate over the bypass-free ruleset. Preserve every other protection;
the GitHub Actions integration pin is preserved on each required check:

```sh
jq -n '{
  required_status_checks: {
    strict: true,
    checks: [
      {context: "TypeScript and Rust", app_id: 15368},
      {context: "iOS", app_id: 15368}
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
    ([.required_status_checks.checks[] | {context, app_id}] == [
      {context: "TypeScript and Rust", app_id: 15368},
      {context: "iOS", app_id: 15368}
    ]) and
    (.enforce_admins.enabled == true) and
    (has("required_pull_request_reviews") | not) and
    (.required_linear_history.enabled == true) and
    (.required_conversation_resolution.enabled == true) and
    (.allow_force_pushes.enabled == false) and
    (.allow_deletions.enabled == false)
  ' >/dev/null

verified_main_ruleset="$(gh api "repos/OpenCoven/psyche-build/rulesets/$main_ruleset_id")"
printf '%s\n' "$verified_main_ruleset" |
  jq -e '.bypass_actors == []' >/dev/null

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

Direct pushes to `main` remain platform-blocked by the pull-request
requirement; force pushes and deletions are also prohibited. GitHub cannot
create an author self-approval review, and OpenCoven has one member, so no
approving review is obtainable — the ruleset requires none and grants no
bypass. What still gates every merge is the exact-head required checks,
administrator enforcement, linear history, and resolved review threads.
Independent or automated review remains preferred: resolve every review thread
on its merits rather than clearing it to unblock a merge. Before merging,
verify that the exact-head required checks are terminal and successful and that
conversations are resolved, and retain that evidence with the exact SHA in the
PR. Restore an approval requirement when a second member can review.

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
- Merge through a pull request. The ruleset carries no bypass actor, so an
  urgent change still uses the ordinary protected path; an administrative merge
  is permitted only when a required check is itself broken, and the incident
  must not add a standing bypass actor, team, app, administrator, or user.
- Record the merge override, its reason, the exact SHA, and the resulting merge
  in the incident/change record.
- Retain sanitized before/after settings, exact-head check evidence,
  conversation-resolution evidence, the merge audit records, and the incident
  result.
- Complete a post-event review covering the change, override, outcome, and any
  follow-up. Restore any incident-specific policy change and leave the ruleset
  with no standing bypass actor or mode.

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

## Release candidate builds

`.github/workflows/release-candidate.yml` builds signed and notarized macOS
DMGs from one exact `main` commit without publishing anything. Use it to freeze
a release candidate before the signed tag exists.

A candidate embeds the final stable version already committed on `main`. The
workflow requires every version surface to agree (`pnpm release:coherence`) and
to equal the requested version (`pnpm release:check`). It never adds a
prerelease suffix. The candidate identity, `rc-` followed by the first 12
hexadecimal characters of the commit SHA, appears only in artifact names and in
build provenance. The accepted commit therefore passes the later tag run's
version checks unchanged.

Dispatch it from `main` with the exact commit and the final version:

```sh
candidate_sha="$(git rev-parse origin/main)"
gh workflow run "Release candidate" --repo OpenCoven/psyche-build --ref main \
  -f sha="$candidate_sha" -f version=<MAJOR.MINOR.PATCH>
```

The workflow refuses:

- a dispatch from any ref other than `main`;
- a SHA that is not 40 lowercase hexadecimal characters, does not name a
  commit, or is not equal to or an ancestor of `origin/main`;
- a version that is not stable `MAJOR.MINOR.PATCH`, disagrees with the
  committed version surfaces, or already has a `v` tag. Each build job checks
  for the tag again after environment approval and before reading any
  credential, and a failed tag lookup also refuses.

`verify` runs the same shared TypeScript, protocol, package, Rust, and Tauri
gates as the tag run. It does not run iOS verification; the tag run still does.
The two `build-macos` jobs wait at the protected `release` environment, whose
existing `main` deployment policy covers this dispatch. They read only the six
Developer ID and notarization secrets that the tag run's macOS jobs use. There
is no new secret and no repository-level fallback, and the iOS distribution,
App Store Connect, and Homebrew secrets are never referenced. The dependency,
credential, signing, notarization, Gatekeeper, and cleanup steps are copies of
`release.yml`'s, and `__tests__/releaseCandidateWorkflow.test.ts` fails if they
diverge.

The `provenance` job checks both DMGs against their per-architecture build
records. It then writes `SHA256SUMS` and `release-candidate-provenance.json`,
which records the candidate SHA and identity, the embedded version, the
workflow ref, run ID and attempt, each DMG's digest and size, and the runner
image and toolchain versions. It contains no secret values. Both files and the
two DMGs are uploaded as the workflow artifact `psyche-build-rc-<id>`, retained
for 30 days. The intermediate per-architecture artifacts are retained for 7
days.

The workflow has only `contents: read`. It never creates a tag, a GitHub
Release, a TestFlight upload, or a Homebrew notification. Download the
candidate before it expires and keep it with the acceptance evidence:

```sh
gh run download <run-id> --repo OpenCoven/psyche-build \
  --name psyche-build-rc-<id> --dir <evidence-dir>
(cd <evidence-dir> && shasum -a 256 -c SHA256SUMS)
```

After acceptance, the tag run rebuilds and re-notarizes the DMGs from the same
commit. The published DMGs are new builds, not the candidate's bytes, so match
them to the candidate by commit and version rather than by digest.

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
curated notes, protected-environment approval, and a verified Homebrew Cask pull request.
Desktop-only publication does not upload or claim TestFlight availability.
The shared protocol/schema validation in the root test, typecheck, and build
gate remains mandatory in both modes. Only iOS-specific XcodeGen setup,
simulator availability, generated-project checking, Core/app/UI verification,
distribution credentials, archive, and upload work is skipped.

For either manual mode, retain the workflow run URL, exact release SHA, the
resolved `desktop_only` output, and the `verify`, both `build-macos`,
`upload-ios`, `publish`, and `homebrew-tap-pr` job results. For desktop-only
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

A published GitHub Release is reused only when its exact asset set (three
artifacts, or five once update manifest signing is active) and curated notes
byte-match the verified output; a draft may have its assets replaced
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

Once update manifest signing is active, the set is exactly those three plus
`update-manifest.json` and `update-manifest.json.sig`, and the file count
below is `5`.

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

## Update manifest signing

Each release can publish a signed `update-manifest.json`. A later desktop
release reads it to tell the user that a newer version exists. The app only
notifies: it never downloads or installs anything, and the Homebrew Cask is
unchanged. The design is
[the update channel record](superpowers/specs/2026-10-01-update-channel-design.md).

### Format

`scripts/update-manifest.mjs` builds, signs and verifies the manifest with
Node's built-in Ed25519. It needs no third-party tool.

- **`update-manifest.json`** holds `schema` (`1`), `version`, `tag`,
  `source_sha` (the 40-character release commit), `artifacts.aarch64` and
  `artifacts.x86_64` (each a DMG `file` name and its `sha256`, identical to
  `SHA256SUMS`), `published_at` and `expires_at`. `published_at` is the signed
  release tag's tagger time, so a retried run reproduces the same bytes.
  `expires_at` is 30 days later, the maximum the tooling accepts.
- **Canonical bytes.** The file is canonical JSON: keys sorted, no
  insignificant whitespace, strings escaped as `JSON.stringify` escapes them,
  integers only, UTF-8 without a byte-order mark, and exactly one trailing LF.
  The signature covers exactly the file bytes. A verifier rejects any file
  that does not re-serialize to identical bytes.
- **`update-manifest.json.sig`** is a canonical JSON envelope:
  `{"algorithm":"ed25519","key_id":"<16 hex>","schema":1,"signature":"<base64>"}`
  plus a trailing LF. `signature` is the padded base64 of the 64-byte Ed25519
  signature over the manifest bytes.
- **Key id.** The lowercase hex of the first 8 bytes of SHA-256 over the raw
  32-byte public key. A verifier picks the current or next key by this id.
- **`release/update-manifest-keys.json`** is
  `{"schema":1,"current":{"keyId","publicKey"}|null,"next":...|null}`, where
  `publicKey` is the base64 raw public key. Only public keys are committed.

`verify` checks the signature before it parses the manifest, and fails with
exactly one bounded reason: `keys_malformed`, `no_trusted_keys`,
`signature_malformed`, `unknown_key_id`, `signature_invalid`,
`manifest_malformed`, `manifest_not_canonical`, `manifest_not_yet_valid`,
`manifest_expired` or `manifest_mismatch`.

### Differences from the design record

The [design record](superpowers/specs/2026-10-01-update-channel-design.md)
proposed minisign, a `update-manifest.json.minisig` signature and a
password-protected key. Following the owner's 2026-10-03 decision, the
implementation differs in three ways. The dated record is left as it was.

- **Signer.** Node's built-in Ed25519 replaces minisign, so the release job
  needs no third-party tool.
- **Signature asset.** The signature is the `update-manifest.json.sig` JSON
  envelope described above, not a `.minisig` file.
- **Key custody.** The private key is an unencrypted PKCS#8 PEM, held only as
  the `UPDATE_MANIFEST_SIGNING_KEY` secret in the protected `release`
  environment, plus the owner's offline recovery copy. There is no key
  password. Protection comes from the environment's reviewers and from the
  secret being scoped to the single sign step.

The desktop verifier must fetch exactly these two release assets:
`update-manifest.json` and `update-manifest.json.sig`. It must accept only the
`ed25519` algorithm and the key ids in its embedded current and next slots.

### Activation and fail-closed rules

The `publish` job reads `release/update-manifest-keys.json` after it writes
`SHA256SUMS`:

- **`current` is `null` (the checked-in default).** The job writes a notice
  annotation, publishes no manifest, and publishes exactly the two DMGs and
  `SHA256SUMS`, as before. No secret is needed.
- **`current` names a key.** The job builds the manifest, signs it in a step
  that alone receives `UPDATE_MANIFEST_SIGNING_KEY`, verifies the result
  against the keys file, the tag, the release commit and `SHA256SUMS`, and
  publishes exactly five assets. A missing secret, a secret that is not the
  current key, a failed verification, or a malformed keys file stops the job
  before the release is created or changed.

Manual recovery runs the workflow from `main` against the requested tag's
source. A tag with no `release/update-manifest-keys.json`, such as `v0.0.1` or
`v0.0.2`, predates this feature. The job treats it as a legacy tag: it posts a
notice and publishes the three-asset set. The keys file and the script were
added together, so every later tag has the keys file and cannot silently drop
signing. If such a tag lacks `scripts/update-manifest.mjs`, the job uses the
workflow revision's copy, and fails if it cannot read that copy.

Before building, the job checks that the local tag object is the exact signed
object the `verify` job checked against GitHub. It reads the tagger date only
from that object.

Time limits follow from using the tagger date as `published_at`:

- **Tagger clock skew.** Verifiers allow 5 minutes of clock difference. If the
  tagger's clock ran more than 5 minutes fast, the build refuses with
  `published_at_in_future`; a manifest that got past it would fail
  self-verification with `manifest_not_yet_valid`. Fix the clock and create a
  new tag. Never move an existing one.
- **Early tags.** The 30-day window starts when the tag is created, not when it
  is pushed or published. A tag created 10 days before its release run leaves
  about 20 days before the manifest expires. Create the tag just before
  pushing it.
- **Late retries.** A retry more than 30 days after the tag fails closed,
  because its manifest would already be expired. Re-signing an existing
  release is not implemented.

### Provision the key (owner only)

Run these steps yourself, on a trusted machine. CI never generates keys, and no
key should ever pass through an issue, pull request, chat or log.

1. From a clean checkout of `main`, create the key pair outside every Git
   checkout:

   ```sh
   mkdir -p ~/.psyche-build-keys
   chmod 700 ~/.psyche-build-keys
   node scripts/generate-update-signing-key.mjs \
     --out ~/.psyche-build-keys/update-manifest-signing-key.pem
   ```

   The script writes the private PKCS#8 PEM with mode `0600`, refuses to
   overwrite a file or write inside a Git working tree, and never prints the
   private key. It prints the public `{ "keyId", "publicKey" }` entry and the
   key id.
2. Upload the private key as the environment secret. `gh` reads it from
   standard input, so the value never appears on a command line:

   ```sh
   gh secret set UPDATE_MANIFEST_SIGNING_KEY \
     --repo OpenCoven/psyche-build --env release \
     < ~/.psyche-build-keys/update-manifest-signing-key.pem
   gh secret list --repo OpenCoven/psyche-build --env release
   ```

   Confirm that the list shows `UPDATE_MANIFEST_SIGNING_KEY`. Never create a
   repository-level copy.
3. Store the recovery copy offline, for example in the owner's password
   manager or on an encrypted volume. Then delete the plaintext file.
4. Open a pull request that sets `current` in
   `release/update-manifest-keys.json` to the printed entry. Merge it only
   after step 2. From the next release on, the manifest is required.

### Rotate with the next slot

1. Generate a new key pair as in step 1, under a new file name. Commit its
   entry as `next`, and leave `current` and the secret unchanged. Releases
   still sign with the current key. Desktop builds made from then on trust
   both keys.
2. Once the installed apps that matter trust the new key, open one pull request
   that moves the new entry to `current` and sets `next` to `null` (or to a
   further key). When it merges, replace `UPDATE_MANIFEST_SIGNING_KEY` with the
   new private key, using step 2. A release that runs between the merge and the
   secret update fails closed with `signing_key_not_current`. Re-run it after
   the update.
3. Move the old private key's recovery copy to retired storage, or destroy it.

### Revoke a key

If a private key is exposed, remove its entry from both slots at once:

- If `next` holds an uncompromised key, promote it to `current` and replace the
  secret with that key.
- Otherwise set `current` to `null`, and delete the secret:
  `gh secret delete UPDATE_MANIFEST_SIGNING_KEY --repo OpenCoven/psyche-build --env release`.
  Releases then publish without a manifest until a new key is provisioned.

Installed apps keep trusting the keys they shipped with. Until they update,
an attacker holding the exposed key can sign a misleading manifest. Because
the app only notifies, the worst outcomes are a false or suppressed update
notice. Homebrew and the DMG checksums still guard what gets installed.

### Desktop update check

The macOS app checks the manifest itself and only ever notifies. It never
downloads a DMG, runs an installer or restarts. The code is
`native/desktop/psyche-build-tauri/src-tauri/src/update_manifest.rs` (the
verifier) and `update_check.rs` (fetching, state and commands).

**Inert until a key exists.** The app embeds
`release/update-manifest-keys.json` at build time. While `current` is `null`,
as it is today, the app makes no network request and constructs no HTTP
client, and the state is `disabled`. A build trusts exactly the keys it was
built with, so provisioning a key activates checks only in releases built
after that pull request merges. Checks are also `disabled` on Windows and
Linux, where no update is published, and in the acceptance profile.

**What a check does.** Shortly after launch, and then at most once every 24
hours, the app fetches the two assets of the latest release over HTTPS:

- `https://github.com/OpenCoven/psyche-build/releases/latest/download/update-manifest.json`
- `https://github.com/OpenCoven/psyche-build/releases/latest/download/update-manifest.json.sig`

Each response is capped at 64 KiB, with a 10-second connect timeout and a
20-second total timeout. The verifier follows `scripts/update-manifest.mjs`
byte for byte. It checks the signature over the raw bytes before parsing,
then canonical re-serialization, then the schema and the tag, then the
validity window with 300 seconds of clock skew. Finally it requires a version
strictly newer than the running app. After a failed check, the next check
waits twice as long, up to a week. A failed check does not withdraw an update
this session already verified, or forget its dismissal, until that manifest
expires; `last_outcome` still records the failure.

Each running app instance keeps its own schedule and checks independently.
Two instances can check close together and both write `update-check.json`;
the atomic rename means the last writer wins, with no torn file.

Every check ends in exactly one state, and nothing else happens:

| State | Meaning |
|---|---|
| `disabled` | No current key in this build, unsupported platform, or acceptance profile. No request was made. |
| `off` | The user turned update checks off. |
| `unavailable` | The app data directory could not be resolved. Nothing is stored, and no check runs. |
| `idle` / `checking` | No check has finished in this session yet, or one is running. |
| `unreachable` | Network failure, timeout, or a non-success HTTP status. |
| `oversize` | An asset was larger than 64 KiB. |
| `invalid_signature` | The `.sig` envelope is malformed, or the signature does not verify. |
| `unknown_key` | The envelope names a key that is not in this build's current or next slot. |
| `non_canonical` | The signed bytes are not canonical JSON. |
| `malformed` | The manifest fails the schema, for example the tag differs from `v<version>`. |
| `not_yet_valid` / `expired` | Outside `published_at` minus 300 seconds to `expires_at`. |
| `not_newer` | Verified, but not newer than the running version. |
| `available` | Verified and newer. The app may show the notice. |

**Cross-implementation vectors.** `pnpm generate:update-manifest-vectors`
signs about 45 cases with the Node reference and records the reference's
outcome for each in
`native/desktop/psyche-build-tauri/src-tauri/test-fixtures/update-manifest/vectors.json`.
The Rust tests require the same outcome for every case except two
intentional differences, each marked `rust_expect` in the file. Rust uses
`verify_strict`, which refuses a small-order key that OpenSSL accepts. Rust
also caps JSON nesting at 32 levels, so it reports a deeper signed document
as `manifest_malformed` where Node reports `manifest_not_canonical`. Both
differences only make Rust stricter on inputs that no honest signer
produces. A vitest test fails
when the checked-in file differs from a fresh run. The vector keys are
derived from public labels, so anyone can recompute them. The generator and
the test both refuse to run if `release/update-manifest-keys.json` trusts one
of them.

**App-scoped state.** `update-check.json` in the app data directory
(`~/Library/Application Support/dev.opencoven.psyche`) holds `checks_enabled`,
`last_check`, `last_outcome`, `skipped_version`, `last_seen_version` and the
failure count. It is written through a temporary file and an atomic rename,
and it is read field by field: an unreadable or oversized file loads as
defaults, and one invalid or unknown field never discards the others, so a
checks-off setting survives a downgrade. A file without a `schema` (or with
`1`) loads as version 1. A file whose `schema` is newer was written by a later
release: it is read, but never rewritten, so downgrading cannot destroy it.
In that case, `update_status` reports `storage: "newer_schema"` and
preference changes are refused. Check results stay in memory only. Project configs are
never touched. On the first launch of a new version, the app records it as
`last_seen_version`. When that is a move to a strictly newer version, it
reports the previous value as `upgraded_from`; a downgrade reports nothing.
Reconciling open project configs through the #464 gate is not implemented.

**Commands.** Only the `main` webview may call `update_status`,
`update_skip_version` (only for the version on offer), `update_dismiss`
(lasts for this session) and `update_set_checks_enabled`. The
`main-update-check` capability grants them. A command that changes a saved
preference returns a bounded error when the save fails, for example
`update preference not saved: PermissionDenied`. The in-memory choice is then
left unchanged, so the UI never reports a choice that was not saved. Failed
saves of background check results are only logged.

## Homebrew publication and recovery

The application is a Cask, not a Formula. After publication, the release
workflow's `homebrew-tap-pr` job proposes the Cask bump as a pull request on
`OpenCoven/homebrew-tap` and then verifies it by reading the tap back:

1. It downloads `SHA256SUMS` from the published (non-draft) release and
   requires exactly the two DMG entries for the release version.
2. `scripts/render-homebrew-cask.mjs` renders the new Cask from the tap's
   current `Casks/psyche-build.rb`, changing only the `version` line and the
   `sha256 arm:`/`intel:` stanza. It refuses a downgrade, a rewrite of an
   already-published version with different checksums, and a Cask whose
   `arch` or `url` stanza no longer matches the published asset names.
3. `scripts/homebrew-tap-pr.mjs open` uses `HOMEBREW_TAP_TOKEN` through the
   GitHub REST API only (no clone, no `git push`, no credential in a URL) to
   create branch `psyche-build-<version>`, commit the rendered Cask, and open
   the pull request. A re-run reuses the branch, commit, and open pull
   request. It stops instead of overwriting a branch that holds some other
   Cask, and it will not reopen a pull request a maintainer closed. If the
   tap's `main` already carries the release, it opens nothing.
4. `scripts/homebrew-tap-pr.mjs verify` re-reads the tap with the run's
   read-only token and fails unless the pull request targets `main` from that
   branch, changes only `Casks/psyche-build.rb`, touches only the version and
   checksum lines, and carries exactly the `SHA256SUMS` version and digests at
   its head commit.

The job never merges. Tap CI (`brew style`, `brew audit`, native install
smoke tests) and a maintainer merge the pull request; the Cask is not public
until they do.

`HOMEBREW_TAP_TOKEN` must be a fine-grained personal access token (or
equivalent GitHub App token) whose repository access is only
`OpenCoven/homebrew-tap`, with **Contents: read and write** (create the branch
and commit) and **Pull requests: read and write** (find and open the pull
request). Metadata read is implied. It needs no Actions, Workflows,
Administration, or other repository permission, and the workflow only exposes
it to the single step that opens the pull request. A pull request opened with
this token, unlike one opened with a tap workflow's own `GITHUB_TOKEN`,
triggers tap CI. If the job fails because the token lacks a permission,
correct the token and re-run the job: `open` reuses whatever branch, commit, or
pull request an earlier attempt left behind, so re-running it is safe.

The release workflow no longer sends the `psyche-build-release`
`repository_dispatch`. The tap's *Update Psyche Build cask* workflow still
triggers every 6 hours, and on that dispatch event if anything sends it. Each
run renders the Cask, force-pushes `automation/psyche-build-vX.Y.Z`, and then
fails at `gh pr create`, because the tap does not permit GitHub Actions to
create pull requests. Those failures are noise beside this job's
`psyche-build-X.Y.Z` pull request. They do not affect it, and they stop once
the bump merges. Fixing them takes a separate change in the tap: remove the
schedule and `repository_dispatch` triggers for psyche-build, or skip the run
when an open `psyche-build-*` pull request already exists.

If the job fails, do not rebuild or republish the app. Read the error, fix
the named condition (for example, delete a stale `psyche-build-<version>`
branch), and re-run the failed `homebrew-tap-pr` job; it is idempotent.
Re-running an older release's job after a newer Cask has merged fails by
design: the renderer refuses to downgrade the Cask. To render the Cask by
hand, run:

```sh
gh api repos/OpenCoven/homebrew-tap/contents/Casks/psyche-build.rb \
  --jq .content | base64 -d > psyche-build.rb
TAG=vX.Y.Z  # the published release being proposed
gh release download "$TAG" --repo OpenCoven/psyche-build --pattern SHA256SUMS
node scripts/render-homebrew-cask.mjs --cask psyche-build.rb --sums SHA256SUMS --version "$TAG"
```

Verify the pull request's version and both hashes against the published
`SHA256SUMS`, then require tap CI and review before merge. Once the `v0.0.1`
release and Cask are actually available, public macOS installation is:

```sh
brew install --cask opencoven/tap/psyche-build
open -a "Psyche Build"
```
