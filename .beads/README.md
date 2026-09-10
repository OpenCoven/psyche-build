# Beads in Psyche Build

Beads is the authoritative issue and planning store for this repository. The
public GitHub Project is a one-way, sanitized mirror for readers who do not use
the Beads CLI.

`external_ref` is the canonical public outcome/maintenance-bucket field. Every
active Bead must resolve through it to exactly one valid configured target in
`.github/beads-project-sync.json`, and the Bead priority must match the roadmap
priority for that target.

Generated GitHub bodies remain one-way mirrors and are never the source of
repair. Do not edit mirrored issue titles, bodies, fields, relationships, or
state in GitHub and expect those changes to persist. The next sync restores
Beads state. Make planning changes with `bd`; the sync never imports GitHub
changes into Beads and leaves unmanaged GitHub issues alone.

GitHub preserves issue body edit history, and the sync cannot purge individual
revisions. Sanitize content before its first publication. If sensitive material
is published accidentally, remediation requires explicit approval to delete and
recreate the issue, or assistance from GitHub Support. Keep sensitive details
and affected issue identifiers out of public updates.

Psyche Build currently standardizes automation on Beads CLI **1.2.2**.

## Never use closing keywords for a generated mirror

Use plain issue references when a PR title, body, or commit message mentions a
generated mirror. Never place any GitHub-supported closing keyword—including
`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, or
`resolved`—before a generated mirror reference: merging the PR would change the
mirror outside the synchronizer and outside the authoritative Bead. Publish the
reviewed Beads source, then let the protected sync reconcile the mirror.

This is easy to trigger while *describing* mirror state. Narrating that a
scheduled apply will close a mirror, with the keyword immediately before the
number, is an executable closing directive rather than a description.

Do not try to defuse a closing keyword by inserting a word such as `the` or
`issue` between it and the number. Whether GitHub's parser tolerates that
filler is an undocumented detail that can change, and a rule that depends on it
is not a rule. Keep closing keywords away from mirror references entirely
(`#NNN` stands for the mirror's number):

- put the reference first — "`#NNN` is closed by the scheduled apply";
- use a neutral verb — "the scheduled apply reconciles `#NNN`", "the
  synchronizer publishes the Bead's state to `#NNN`", "mirror `#NNN` then
  reflects the source";
- or write the bare reference — "`#NNN`".

Observed on 2026-09-04: mirror #230 was closed by GitHub when
[PR #346](https://github.com/OpenCoven/psyche-build/pull/346) merged carrying
such a phrase in its body, minutes before the synchronizer would have published
the same state from the corrected Bead. The end state was the intended one, but
the mirror had been changed by GitHub automation rather than by the supported
source-first path ([#342](https://github.com/OpenCoven/psyche-build/issues/342)).

A mirror closed this way is not repaired by reopening it by hand. Correct the
Bead if it is wrong, then let the synchronizer publish the true state.

## Beads CLI fleet rule

Every checkout, worktree, container, and automation runner that touches this
repository's Beads database must run the pinned Beads CLI above. The Dolt
schema replicates with the data: a single `bd` command from a different
release can migrate the shared schema, and `bd dolt push` then publishes that
migration to every other clone and to the scheduled Project sync.

The accidental, untested Beads v1.2.0/v1.2.1 release migrates a v53 database
to schema v65 on any command. Between 2026-08-30 and 2026-09-02 one checkout
running v1.2.1 pushed such a migration, and every scheduled Project sync
failed inside `bd --readonly export` with `schema version mismatch` until the
schema cursor was rolled back per the upstream
[recovery guide](https://github.com/gastownhall/beads/blob/v1.2.2/docs/RECOVERY-1.2.1.md)
and the versioned `events` audit table was re-tracked ([#342](https://github.com/OpenCoven/psyche-build/issues/342)).
The re-tracked table restores the 1,361 rows in the last versioned snapshot.
Three known writes made after `events` became ignored retain their Dolt commits
and final source state, but their clone-local event rows are unavailable; treat
that as a bounded three-write audit gap, not an uninterrupted journal.

Before running `bd` on a clone that has been idle, confirm `bd version`
reports the pinned release. If `bd` reports a schema version mismatch, do not
set `BD_IGNORE_SCHEMA_SKEW`; stop and coordinate a source-first recovery from
the sole migrator. The synchronizer reports this class as a bounded
`Beads schema version skew` diagnostic rather than raw `bd` output.

## Daily Beads commands

```bash
bd create "Describe the work"
bd list
bd show <issue-id>
bd update <issue-id> --claim
bd update <issue-id> --status done
bd dolt pull
bd dolt push
```

## Review before `bd dolt push`

Treat Beads mutations and their Dolt publication as a reviewed two-repository
change:

1. Perform mutations with sandbox mode and no auto-push.
2. Review the generated interactions and the local Dolt diff.
3. Merge the Git PR containing the tracked audit/config/code that describes and
   validates the same state transition.
4. Publish the exact reviewed Dolt commit with `bd dolt push`.
5. Run the protected sync and retain its sanitized apply or zero-operation
   evidence.

Do not publish a different Dolt state after the Git review, and do not use a
generated GitHub body to reconstruct or repair Beads.

The PR in step 3 names a generated mirror, so keep GitHub closing keywords away
from that reference; see
[Never use closing keywords for a generated mirror](#never-use-closing-keywords-for-a-generated-mirror).

## Sole migrator rule

Only one designated maintainer checkout or automation process may migrate the
Beads schema. Before changing Beads versions or running a migration, stop other
bootstrap/migration-capable jobs, complete and push the migration from the sole
migrator, then let every other checkout pull the resulting Dolt state. Never
run competing migrations from separate clones or worktrees.

The Project sync workflow is serialized with the `beads-project-sync`
concurrency group. Source loading always tries a read-only export first. Apply
mode runs `bd bootstrap --yes` only when that export reports a missing or
uninitialized database, so coordinate any recovery or migration-capable run
with the workflow.

## Local Project export, check, and apply

Raw Beads exports can contain non-public fields. Keep them outside the
repository and delete them when finished:

```bash
mkdir -p "$HOME/.local/state/psyche-build"
export BEADS_EXPORT="$HOME/.local/state/psyche-build/issues.jsonl"
bd --readonly export -o "$BEADS_EXPORT"
```

Check the live Beads database with no GitHub writes:

```bash
pnpm beads:project:check
```

Local dry-run source loading is read-only and never bootstraps or mutates
Beads. If the local database is missing, the command stops with instructions
to run `bd bootstrap --yes` explicitly.

Remote issue discovery follows GitHub's next-page links even when a page is
short, retaining the cursor within the configured repository. Non-array
responses, invalid or repeated continuation links, and inventories exceeding
1,000 pages fail closed rather than becoming an empty or partial mirror plan.
Duplicate Bead markers stop reconciliation except for the exact owner-approved
incident #420 manifest in `scripts/beads-project-sync/recovery.mjs`. This
inventory safeguard does not authorize manual mirror retirement or choose a
duplicate survivor.

### Incident #420 duplicate recovery

The source-owned manifest pins 24 Bead identities, their original survivor
issue numbers, and the newer aliases. It is not a general oldest/newest-wins
policy. Both issue creators must be the pinned trusted actor; repository,
markers, survivor membership, and authoritative source membership must match.
Missing survivors, unknown duplicates, mismatches, and forged retirement
markers fail closed. Known Beads cannot be recreated from an empty/partial
remote inventory, so an offline first-run plan is not recovery evidence.

The ordinary synchronizer repairs canonical bodies, Project items, parents,
and blockers using the original issue numbers, then reconciles aliases through
`closeIssue` operations carrying `survivorIssueNumber`. The generator appends
an exact retirement notice to the existing alias body and marks only the alias
closed as not planned; it preserves the issue and its history. It detaches the
alias's outgoing parent/blocker relationships and archives its Project item.
Unmanaged issues are not rewritten. Retirement does not complete or cancel an
active Bead or change Beads source.

Each individual recovery write and retry revalidates the owned lease and
issue identity. Canonical recovery operations also re-read the pinned pair
before each write. Archive requests re-read the alias's Project item identity.
A crash after marking, closing, detaching, or archiving is resumable through
the same command. Inventories retain aliases for unfinished cleanup but never
promote them to canonical mirrors; completed retirement plans no further work.

The normal mass-close guard still applies, including alias retirement.
Summaries expose alias/survivor numbers, outgoing relationship targets, and
whether the alias's Project item needs archiving, without copying bodies.
For this 24-pair incident, an ordinary dry-run is expected to refuse the
close-count bound while still emitting the reviewable plan. Only after
reviewing that exact plan may a maintainer run a second dry-run with
`--allow-mass-close`, then authorize protected application with the same
override. Scheduled runs never enable it. Do not dispatch an apply or approve
an environment as part of code review.

After independently reviewed source merges, use the protected workflow on
`main`: first `dry_run=true, allow_mass_close=false`, then review the summary;
use `dry_run=true, allow_mass_close=true` for the approved complete plan; only
then use `dry_run=false, allow_mass_close=true` for protected application.
Retain sanitized exact-head apply evidence, a subsequent zero-operation sync,
and a passing tracker-drift report before claiming incident recovery. The
initiating cause remains unestablished; #425 fixed the independently reproduced
pagination defect, not proof of the incident's initiating cause.

Before application, rollback is a source revert. After any partial application,
keep this manifest/reader support and resume the reviewed synchronizer; do not
remove retirement recognition, reopen aliases, or edit generated bodies by
hand. A different survivor policy requires a separately reviewed migration.

With `BEADS_PROJECT_TOKEN` exported, the check compares against the current
Project. Without it, the command produces a first-run plan without contacting
GitHub. A saved export can be checked explicitly:

```bash
node scripts/sync-beads-project.mjs --dry-run --inventory-file "$BEADS_EXPORT"
```

Applying is a maintainer operation:

```bash
export BEADS_PROJECT_TOKEN="<load from your password manager>"
pnpm beads:project:sync
```

Never store the token in the repository, Beads configuration, command history,
or an artifact.

## Token and workflow configuration

`BEADS_PROJECT_TOKEN` remains a manual fine-grained token setup; the workflow
does not create or rotate it. Scope it to the `OpenCoven/psyche-build`
repository with repository **Contents: read and write** (for the atomic
commit/branch-ref apply lock), **Issues: read and write**, and **Metadata: read**,
plus organization **Projects: read and write**. Create two protected
environments restricted to the main branch (`main`):

- The `beads-project-sync-automation` environment has no required reviewers, so
  the staggered unattended schedules can recover when GitHub drops a scheduled
  event.
- The `beads-project-sync` environment has required reviewers, so every manual
  `workflow_dispatch` run is reviewer-gated.

Install the fine-grained token as the environment secret
`BEADS_PROJECT_TOKEN` in both environments (or use a secure equivalent that
preserves unattended scheduled runs and reviewer-gated manual runs). Scheduled
sync must remain disabled until both environment secrets and their protection
rules are set.

Apply mode uses the persistent remote coordination branch
`psyche-beads-project-sync-lock`. Release appends a `released` tombstone instead
of deleting the branch, so its linear commit history remains an audit trail and
the next apply can acquire immediately by appending a child active lease.
Renewal, release, reacquisition, and stale takeover commits fast-forward from
the exact current lock commit. Do not delete or rewrite this coordination ref.
The branch is excluded from Psyche's product-branch discovery and does not
affect `git fetch origin main --tags`.

### Immutable Project binding and visibility safety

The mirror is bound to
[OpenCoven Project 11](https://github.com/orgs/OpenCoven/projects/11) by its
immutable Project node ID, `PVT_kwDOECXnmc4BhMIA`, in
`.github/beads-project-sync.json`. The synchronizer requires that exact ID plus
the repository-bound README marker or the canonical repository link. A
matching marker on another Project never authorizes adoption, repair, or
publication.

Do not change `projectNodeId` to recover from a missing or renamed Project.
First verify the Project's identity and repository ownership. Title, README,
repository link, fields, and views remain repairable on the pinned public
Project, but an absent pinned Project fails closed instead of provisioning a
replacement. This repository does not support unpinned CLI provisioning.

If the pinned Project is private, every dry-run, apply, and provision attempt
fails before acquiring the apply lock or making a Project mutation. Automatic
visibility changes are intentionally disabled. A maintainer must manually
review the Project at the URL above, confirm its node ID and contents, change
its visibility to public in GitHub, and then rerun a dry-run. Do not use a
different marked Project as a substitute.

Managed issue marker ownership is pinned separately by
`trustedIssueAuthors` in `.github/beads-project-sync.json`. Logins are matched
case-insensitively against GitHub's issue `user.login`; the mutable
`author_association` value is informational and never authorizes a marker.
The allowlist must remain non-empty. Every newly created mirror issue is
re-read and rejected if its actor is not pinned.

For a new repository with no pinned identity, any explicit bootstrap flow must
create a fresh Project and return its node ID for a maintainer to review and
commit before future synchronization. It must never adopt an existing marked
private Project.

`.github/workflows/beads-project-sync.yml` applies the mirror at 03:17 UTC and
runs a redundant 09:43 UTC apply because GitHub may delay or drop scheduled
events. The synchronizer is idempotent and lease-serialized, so the backup run
is normally a zero-operation verification. Maintainers can also use
**Actions → Beads Project Sync → Run workflow**:

- `dry_run: true` makes Actions dry-run bootstrap an ephemeral runner database
  from the authoritative Beads remote, without a GitHub token, before selecting
  the read-only plan. The ephemeral database is discarded with the runner;
  local dry-run remains read-only and never bootstraps Beads. The default
  applies.
- `allow_mass_close: true` overrides only the close-count guard.
- Scheduled runs always apply and never enable the override.

Every run uploads a sanitized `summary.json` and `diagnostics.log`, including
failed runs. The summary reports counts by operation kind and body-free closure
candidates with Bead ID, issue number, and public issue title when available.

The generated Project README stays within GitHub's 10,000-Unicode-code-point
limit. Required snapshot, field-guide, sync, and authority sections take
priority; the remaining budget includes as many sorted closed-history entries
as fit, with long titles bounded and an exact omission count when truncated.

The guard normally refuses to close more than the greater of five managed
issues or 25% of currently open managed issues. Run a dry-run first and inspect
its artifact before manually enabling `allow_mass_close`; a refused run still
publishes the same reviewable summary.

Apply and provision runs acquire the GitHub-backed lease before repairing the
Project. After acquisition they discard all cached Project discovery, item, and
field state, then re-read the pinned ID, ownership marker or repository link,
visibility, title, and README. Every individual REST, GraphQL, and `gh project`
mutation revalidates lease ownership immediately before sending, including
each request inside compound Project, view, field, and relationship repairs.
Dry-runs take no lease and perform no writes.

Project view names, layouts, and filters are automated. GitHub does not expose
all view grouping and sorting controls through the API used here, so a
maintainer may configure preferred grouping/sorting once in the Project UI
after provisioning; sync preserves those manual display settings.

Learn more about Beads at
[github.com/gastownhall/beads](https://github.com/gastownhall/beads).
