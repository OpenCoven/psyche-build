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
repository with repository **Issues: read and write** and organization
**Projects: read and write** permissions (plus the implicit metadata read
permission). Create two protected environments restricted to the main branch
(`main`):

- The `beads-project-sync-automation` environment has no required reviewers, so
  the daily schedule remains unattended.
- The `beads-project-sync` environment has required reviewers, so every manual
  `workflow_dispatch` run is reviewer-gated.

Install the fine-grained token as the environment secret
`BEADS_PROJECT_TOKEN` in both environments (or use a secure equivalent that
preserves unattended scheduled runs and reviewer-gated manual runs). Scheduled
sync must remain disabled until both environment secrets and their protection
rules are set.

### Required one-time bootstrap gate

The sync workflow intentionally does not provision GitHub Project
infrastructure. Task 8 must run the following maintainer bootstrap successfully:

```bash
export BEADS_PROJECT_TOKEN="<load from your password manager>"
node scripts/sync-beads-project.mjs --apply --provision
```

`.github/workflows/beads-project-sync.yml` must not be merged or enabled until
that one-time bootstrap succeeds and the marked public Project is verified.
Keep its schedule disabled until then; a normal workflow apply fails safely
when no marked Project exists.

After the bootstrap gate is satisfied,
`.github/workflows/beads-project-sync.yml` applies the mirror every day at
03:17 UTC. Maintainers can also use **Actions → Beads Project Sync → Run
workflow**:

- `dry_run: true` selects a read-only plan; the default applies.
- `allow_mass_close: true` overrides only the close-count guard.
- Scheduled runs always apply and never enable the override.

Every run uploads a sanitized `summary.json` and `diagnostics.log`, including
failed runs. The summary reports counts by operation kind and body-free closure
candidates with Bead ID, issue number, and public issue title when available.

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
