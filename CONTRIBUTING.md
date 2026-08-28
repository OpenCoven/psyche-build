# Contributing to Psyche Build

This project is built while running Psyche Build itself. The goal is a fast, repeatable loop for maintainers and contributors.

Start with [`AGENTS.md`](AGENTS.md) for canonical ownership, risk classes,
protected/generated paths, and completion-evidence requirements.

## Prerequisites

- Node.js 20.10.0+
- The `pnpm` version pinned by `packageManager` in `package.json`
- Corepack 0.31.0 (required for release validation)
- `tmux` 3.0+
- Git 2.20+

Some supported Node.js distributions omit Corepack. Before running the release
validation checklist, install the pinned version when `corepack` is unavailable:

```bash
npm install --global corepack@0.31.0
```

## Local Development (Dogfood Loop)

1. Bootstrap the locked dependency graph and verify the public toolchain contract:

```bash
./scripts/agent-bootstrap
```

The bootstrap derives Node and pnpm requirements from `package.json`, installs
with `--frozen-lockfile`, and fails if the checkout changes. It does not mint
credentials, mutate GitHub or Beads, publish packages, or create releases.

2. Start Psyche Build in local dev mode:

```bash
pnpm dev
```

`pnpm dev` is the standard maintainer entrypoint for this repo. It generates hook docs, compiles TypeScript, then launches Psyche Build from `dist/index.js` with `PSYCHE_DEV=true`.

If tmux setup looks wrong, run:

```bash
pnpm run dev:doctor
node ./psyche doctor --fix
```

`psyche doctor --fix` applies safe tmux repairs, backs up an existing `~/.tmux.conf`, and only edits the psyche-managed block.

## Local macOS App Channels

Build a protected daily-use app from an explicit tested Git ref:

```sh
pnpm app:stable -- <git-ref>
```

The stable command builds the resolved commit in a temporary detached worktree,
runs the full desktop verification gate, smoke-launches the candidate with
temporary local data, and transactionally replaces
`~/Applications/Psyche Build.app` only after every check passes.

Build the current checkout as a separate experimental app:

```sh
pnpm app:dev
```

This fast path accepts a dirty checkout, skips the stable-only full gate and
startup smoke, and replaces only `~/Applications/Psyche Build Dev.app`.
The stable app uses bundle identifier `dev.opencoven.psyche`; the dev app uses
`dev.opencoven.psyche.dev`, keeping preferences, WebView data, caches, and
restored state isolated between channels. Neither command automatically opens
the installed app.

Local commands do not create a signed or notarized public release. These
commands produce local application bundles only; use `docs/RELEASE.md` for the
publication workflow.

## Recommended Daily Workflow

1. Keep one long-lived maintainer checkout for running local Psyche Build (`pnpm dev`).
2. Create feature panes/worktrees from Psyche Build (`n`) for actual changes.
3. Iterate in feature worktree panes and merge from the pane menu (`m`) when possible.
4. Close panes with care when you want to preserve worktrees for later.
5. Reopen closed worktrees with `r` when you need to resume work.

In DEV mode, source switching is available from the pane menu (`[DEV] Use as Source`) or hotkey (`S`):

- Select any worktree pane and run source toggle -> that worktree becomes active source.
- Toggle again on the already-active source pane -> source falls back to project root.
- If the active source worktree is closed/removed, Psyche Build automatically falls back to project root.
- The active source pane is marked with `[source]` in the pane list.

This keeps the dev session stable while still using pane-per-branch isolation.

## Beads Planning and Public Project

Beads is the authoritative planning store. The public GitHub Project is a
one-way sanitized mirror, so update work with `bd` rather than editing mirrored
GitHub issues or Project fields. Unmanaged GitHub issues are not touched.

Common local mirror commands are:

```bash
pnpm beads:project:check
BEADS_PROJECT_TOKEN="$(gh auth token)" pnpm beads:project:e2e
pnpm beads:project:sync
```

The check and GraphQL E2E verifier are read-only. The E2E command runs the real
dry-run path against GitHub, rejects mutations and duplicate payloads, and
enforces the current two-query request ceiling. Applying requires the maintainer-only
`BEADS_PROJECT_TOKEN`; load it from a password manager rather than storing it in
the repository. Create two protected environments restricted to the main branch
(`main`): the `beads-project-sync-automation` environment must have no required
reviewers so scheduled runs remain unattended, while the `beads-project-sync`
environment must have required reviewers so manual runs remain reviewer-gated.
Install the fine-grained token as the environment secret `BEADS_PROJECT_TOKEN`
in both environments, or use a secure equivalent that preserves those
properties. Its complete fine-grained permission contract is repository
**Contents: read and write** (for the atomic commit/branch-ref apply lock),
**Issues: read and write**, and **Metadata: read**, plus organization
**Projects: read and write**.

Local dry-run is read-only and never bootstraps or mutates Beads; a missing
database produces explicit `bd bootstrap --yes` guidance. Actions dry-run
bootstraps an ephemeral runner database from the authoritative Beads remote
without a GitHub token before invoking the same read-only CLI mode.

The synchronizer is bound to the immutable GitHub Project node ID
`PVT_kwDOECXnmc4BhMIA` for
[OpenCoven Project 11](https://github.com/orgs/OpenCoven/projects/11). Existing
Project adoption and repair require that exact identity plus the
repository-bound managed marker or canonical repository link; a duplicate
marker elsewhere is ignored and never authorizes publication. The pinned
public Project's title, README, repository link, fields, and views remain
repairable.

An absent pinned Project fails closed instead of provisioning a replacement.
If the pinned Project is private, dry-run and apply also fail before mutations.
Automatic visibility changes are disabled: a maintainer must manually review
the Project identity and contents, change visibility to public in GitHub, and
rerun a dry-run. Never repoint `projectNodeId` merely because another Project
has the managed marker.

`.github/beads-project-sync.json` also pins the non-empty
`trustedIssueAuthors` allowlist. Managed issue markers are owned only when
GitHub's issue `user.login` matches a configured login case-insensitively;
`author_association` does not grant ownership. Keep `BunsDev` pinned unless a
reviewed ownership migration changes the issue-creation actor. Created issues
are re-read and fail closed on an actor mismatch.

After that gate is satisfied, `.github/workflows/beads-project-sync.yml`
applies automatically at 03:17 UTC with a redundant 09:43 UTC run because
GitHub may delay or drop scheduled events. The sync is idempotent and
lease-serialized, so the backup normally applies zero operations. Use workflow
dispatch with `dry_run` to inspect a plan. `allow_mass_close` is an exception
guard override and should be enabled only after reviewing a dry-run artifact,
including its operation-kind counts and body-free closure candidates.

The synchronizer minimizes GitHub GraphQL pressure within each run. Project
discovery and Project item inventory are read once and reused, while all field
changes for one Project item are sent as one aliased mutation instead of one
request per field. Ambiguous writes deliberately bypass the snapshot and
re-read GitHub before deciding whether a retry is safe.

Every local or Actions apply also acquires the same GitHub-backed apply lock.
The lock is an atomic, expiring repository branch-ref lease, so a local
`pnpm beads:project:sync` fails closed while an Actions apply owns the lease (and
vice versa); dry-runs never acquire it. The persistent
`psyche-beads-project-sync-lock` coordination branch remains on the remote as a
linear audit trail. Release appends a `released` tombstone, and the next apply
acquires immediately by appending a child active lease. Do not delete or
rewrite this coordination ref manually. Unlike the former moving tag, it does
not interfere with `git fetch origin main --tags`. Renewal, release,
reacquisition, and stale takeover commits are children of the exact current
lock commit and update the branch with a non-forced fast-forward. The
30-minute lease is renewed by a bounded heartbeat. After acquisition, apply
discards all cached Project discovery,
item, and field state and revalidates the pinned Project's identity, ownership,
repository link, visibility, title, and README before repair. Lease ownership
is then awaited immediately before every individual REST, GraphQL, or
`gh project` mutation, including each sub-request in compound repairs. Renewal
or ownership proof failure stops the next write. Only the current lease owner
may release it.

During a Beads version or schema migration, designate one sole migrator and
stop other bootstrap/migration-capable processes until the migrated Dolt state
has been pushed. See [`.beads/README.md`](.beads/README.md) for export commands,
token setup, guard thresholds, workflow operation, and Project view notes.

## Bootstrap Behavior

`pnpm dev` generates hook docs before compiling. Hook documentation is generated from source into `src/utils/generated-agents-doc.ts`.

You can run the generator manually:

```bash
pnpm run generate:hooks-docs
```

If this generated file changes only because the date rolled forward, revert it before committing unless the generated content itself changed.

## Pull Request Workflow

1. One pane/worktree per PR branch.
2. Merge through Psyche Build when possible to dogfood merge + cleanup paths.
3. Run focused checks for the affected contract, then the bounded repository gate:

```bash
./scripts/agent-check fast
```

`./scripts/agent-check fast` runs TypeScript validation and the repository
entrypoint contract. Run narrower Vitest, Rust, desktop, or iOS checks first when
the change touches those surfaces.

When you touch startup, onboarding, or the tmux session lifecycle, also run:

```bash
pnpm smoke
```

It builds and starts the real `dist/index.js` in a throwaway repo and `HOME` on
its own tmux server. `pnpm run test` deliberately excludes it — it needs tmux
and a production build, so keeping it out leaves the unit suite fast and
portable. See `docs/SMOKE.md`.

4. For docs/package changes, also verify package contents:

```bash
pnpm smoke:pack
```

5. Before requesting merge, run the full public handoff gate:

```bash
./scripts/agent-check full
```

The full gate covers docs, TypeScript, unit tests, build/package smoke, real
tmux startup smoke, desktop web bundles, and desktop Rust. iOS evidence is an
explicit compatible-Mac gate:

```bash
PSYCHE_AGENT_CHECK_IOS=1 ./scripts/agent-check full
```

An unrequested or unsupported iOS run is named as a skip, never represented as
successful iOS evidence.

6. Open the PR from the feature branch created for that pane and complete the
repository PR template with exact commands, authority impact, rollback, and
remaining uncertainty.

## Maintainer Checklist (Before Release)

Run the same package-metadata-derived bootstrap and complete handoff gate used by
contributors:

```bash
./scripts/agent-bootstrap
./scripts/agent-check full
```

`agent-bootstrap` enforces the exact `packageManager` pin from `package.json`;
do not copy a pnpm version into this document. `pnpm smoke` and
`pnpm smoke:pack` check different things and both run in the full gate: one
proves the built cockpit starts, the other proves the tarball carries what it
should. A package can pack correctly and still fail to launch.

Release publication, signing, notarization, TestFlight, GitHub/Beads mutation,
tagging, and protected-branch changes require explicit maintainer approval and
the relevant protected environment. See `docs/RELEASE.md` for publication.
