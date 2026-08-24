# Beads in Psyche Build

Beads is the authoritative issue and planning store for this repository. The
public GitHub Project is a one-way, sanitized mirror for readers who do not use
the Beads CLI.

Do not edit mirrored issue titles, bodies, fields, relationships, or state in
GitHub and expect those changes to persist. The next sync restores Beads state.
Make planning changes with `bd`; the sync never imports GitHub changes into
Beads and leaves unmanaged GitHub issues alone.

GitHub preserves issue body edit history, and the sync cannot purge individual
revisions. Sanitize content before its first publication. If sensitive material
is published accidentally, remediation requires explicit approval to delete and
recreate the issue, or assistance from GitHub Support. Keep sensitive details
and affected issue identifiers out of public updates.

Psyche Build currently standardizes automation on Beads CLI **1.2.2**.

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
commit/tag-ref apply lock), **Issues: read and write**, and **Metadata: read**,
plus organization **Projects: read and write**. Create two protected
environments restricted to the main branch (`main`):

- The `beads-project-sync-automation` environment has no required reviewers, so
  the daily schedule remains unattended.
- The `beads-project-sync` environment has required reviewers, so every manual
  `workflow_dispatch` run is reviewer-gated.

Install the fine-grained token as the environment secret
`BEADS_PROJECT_TOKEN` in both environments (or use a secure equivalent that
preserves unattended scheduled runs and reviewer-gated manual runs). Scheduled
sync must remain disabled until both environment secrets and their protection
rules are set.

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

For a new repository with no pinned identity, any explicit bootstrap flow must
create a fresh Project and return its node ID for a maintainer to review and
commit before future synchronization. It must never adopt an existing marked
private Project.

`.github/workflows/beads-project-sync.yml` applies the mirror every day at
03:17 UTC. Maintainers can also use **Actions → Beads Project Sync → Run
workflow**:

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

Project view names, layouts, and filters are automated. GitHub does not expose
all view grouping and sorting controls through the API used here, so a
maintainer may configure preferred grouping/sorting once in the Project UI
after provisioning; sync preserves those manual display settings.

Learn more about Beads at
[github.com/gastownhall/beads](https://github.com/gastownhall/beads).
