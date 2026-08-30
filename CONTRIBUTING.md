# Contributing to Psyche Build

Psyche Build is OpenCoven's local-first coding cockpit. Contributions should be small enough to understand, explicit about authority and compatibility, reproducible from a clean checkout, and honest about what their evidence proves.

Start with [AGENTS.md](AGENTS.md) and the [repository map](docs/REPOSITORY-MAP.md). Those documents route work to the current architecture, support, security, release, and Psyche-compatibility authorities.

## Public contributor loop

### 1. Prerequisites

The repository derives its exact package-manager contract from `package.json`. You need:

- Node.js satisfying `package.json#engines.node`;
- the exact pnpm version in `package.json#packageManager`;
- Git;
- tmux for the full source smoke path;
- Rust/Cargo for the full desktop gate;
- macOS with the pinned Xcode/XcodeGen toolchain only when validating the iOS surface.

Do not rely on maintainer-global configuration, credentials, private repositories, or ambient tokens for ordinary bootstrap and validation.

### 2. Bootstrap from a clean checkout

Use the repository-owned interface rather than reconstructing toolchain commands from CI:

```bash
bash ./scripts/agent-bootstrap
```

Bootstrap installs the locked dependency graph and must leave repository state unchanged. If it cannot satisfy the pinned environment without mutating the checkout, it fails instead of silently repairing source state.

### 3. Choose the smallest owning surface

Before editing, identify the canonical owner in `docs/REPOSITORY-MAP.md` and the relevant scoped authority document. In particular:

- product/UI/process state is not durable Psyche identity;
- guarded actions must preserve capability, approval, receipt, revocation, idempotency, persistence, and recovery boundaries;
- Beads owns generated mirror source state; generated GitHub mirror bodies are not durable edit targets;
- generated source must be changed through its named generator;
- support and release claims require the evidence named by `docs/SUPPORT-MATRIX.md` and `docs/RELEASE-ACCEPTANCE.md`.

For Beads-specific operation, migration, synchronization, and credential boundaries, use [`.beads/README.md`](.beads/README.md). Maintainer-only tracker credentials are not part of the public contributor loop.

### 4. Run focused proof while iterating

Run the smallest relevant test or build for the surface you changed. Examples include:

```bash
pnpm vitest --run __tests__/agentRepositoryContract.test.ts
pnpm vitest --run __tests__/repositoryMapContract.test.ts
pnpm typecheck
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

For generated surfaces, use the canonical generator/check rather than hand-editing output:

```bash
pnpm generate:hooks-docs
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm ios:project:generate
pnpm ios:project:check
pnpm build
```

The iOS project check is meaningful only on the compatible macOS/Xcode host described in `AGENTS.md`; an unrun platform gate is **not** a pass.

### 5. Run the repository handoff gate

For a bounded TypeScript/docs/repository-contract iteration:

```bash
bash ./scripts/agent-check fast
```

Before handing off a change that affects runtime behavior, architecture, generated desktop output, packaging, persistence, authority, recovery, or another high-risk surface, run:

```bash
bash ./scripts/agent-check full
```

The full gate covers the unit/contract suite, docs checks/build, typecheck, source smoke, packaged-artifact smoke, deterministic desktop web generation, Rust formatting/tests/checks, and exact worktree cleanliness. iOS remains an explicit opt-in platform gate; physical-device, signing, TestFlight, and distribution evidence are governed separately by release acceptance.

## Beads planning and public Project

Beads is the authoritative planning store. The public GitHub Project is a
one-way sanitized mirror, so update work with `bd` rather than editing mirrored
GitHub issues or Project fields. Unmanaged GitHub issues are not touched.

Common local mirror commands are:

```bash
pnpm beads:project:check
export BEADS_PROJECT_TOKEN="<load from your password manager>"
pnpm beads:project:e2e
pnpm beads:project:sync
```

The check and GraphQL E2E verifier are read-only. The E2E command runs the real
dry-run path against GitHub, rejects mutations and duplicate payloads, and
enforces bounded per-operation pagination and retry ceilings. Applying requires
the maintainer-only `BEADS_PROJECT_TOKEN`; load it from a password manager rather
than storing it in the repository. Create two protected environments restricted
to the main branch (`main`): the `beads-project-sync-automation` environment
must have no required reviewers so scheduled runs remain unattended, while the
`beads-project-sync` environment must have required reviewers so manual runs
remain reviewer-gated. Install the fine-grained token as the environment secret
`BEADS_PROJECT_TOKEN` in both environments, or use a secure equivalent that
preserves those properties. Its complete fine-grained permission contract is
repository **Contents: read and write** (for the atomic commit/branch-ref apply
lock), **Issues: read and write**, and **Metadata: read**, plus organization
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

`.github/beads-project-sync.json` also pins the non-empty `trustedIssueAuthors`
allowlist. Managed issue markers are owned only when GitHub's issue `user.login`
matches a configured login case-insensitively; `author_association` does not
grant ownership. Keep `BunsDev` pinned unless a reviewed ownership migration
changes the issue-creation actor. Created issues are re-read and fail closed on
an actor mismatch.

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
lock commit and update the branch with a non-forced fast-forward. The 30-minute
lease is renewed by a bounded heartbeat. After acquisition, apply discards all
cached Project discovery, item, and field state and revalidates the pinned
Project's identity, ownership, repository link, visibility, title, and README
before repair. Lease ownership is then awaited immediately before every
individual REST, GraphQL, or `gh project` mutation, including each sub-request
in compound repairs. Renewal or ownership proof failure stops the next write.
Only the current lease owner may release it.

During a Beads version or schema migration, designate one sole migrator and
stop other bootstrap/migration-capable processes until the migrated Dolt state
has been pushed. See [`.beads/README.md`](.beads/README.md) for export commands,
token setup, guard thresholds, workflow operation, and Project view notes.

## Pull-request scope

Use one branch/worktree for one reviewable outcome. A PR should have one primary behavior or contract change and a rollback story that remains understandable without reading unrelated work.

As a **split heuristic**, prefer keeping a PR below approximately **800 non-generated changed lines**. This is not a mechanical limit: generated artifacts, fixtures, migrations, or a tightly coupled mechanical move may legitimately exceed it. When substantially exceeding the heuristic, explain in the PR why splitting would make the change less safe, less testable, or break an atomic compatibility boundary.

Do not combine broad visual redesign, architecture extraction, schema migration, and behavior changes merely because they touch the same large entry point. The active decomposition contract is issue #197.

## When a design record is required

A maintainer may require a focused design/ADR **before implementation** when a change:

- creates or changes a public/protocol schema or persisted format;
- changes identity, capability, lease, approval, receipt, revocation, or recovery semantics;
- changes cross-repository canonical ownership;
- changes a release/security boundary or migration strategy;
- introduces a new external side effect, credential, network trust, or authority path;
- cannot be safely explained within the normal PR scope heuristic.

The design requirement exists to protect compatibility and authority boundaries, not to make small local changes bureaucratic.

## PR evidence packet

Every substantive PR should make the following inspectable in its description:

- **Objective and acceptance criteria** — what becomes true when merged.
- **Non-goals** — adjacent behavior deliberately not changed.
- **Files/surfaces intentionally touched** — especially generated or R3/R4 surfaces.
- **Canonical contracts consulted** — architecture, support, security, protocol, or release authority.
- **Focused verification** — exact commands and outcomes.
- **Full-gate status** — run, not applicable with reason, or blocked with explicit evidence.
- **Authority/security impact** — whether capability, approval, data, credentials, network, or external effects change.
- **Migration and rollback** — when persisted/public behavior changes.
- **Generated artifacts and provenance** — generator command and parity result.
- **Cross-repository canaries** — when a producer/consumer contract changes.
- **Remaining uncertainty** — anything not proven by the supplied evidence.

Use [`.github/pull_request_template.md`](.github/pull_request_template.md) as the executable checklist.

## Merge gate

A change is not merge-ready merely because its local tests pass. Before merge:

- required exact-head GitHub checks must succeed;
- unresolved current review threads/findings must be resolved or explicitly superseded by new evidence;
- generated outputs must match canonical inputs;
- required support/security/release evidence must be present for any claim being made;
- no protected data may appear in the PR, logs, fixtures, screenshots, or issue discussion.

Colleague availability is not an implementation dependency when repository policy allows an authorized owner path, but bypassing a person must never be treated as bypassing required checks or evidence.

## Evidence is claim-scoped

Test counts, source presence, successful hosted compilation, simulator success, documentation, or a merged PR do **not** by themselves prove a production user path, physical-device support, release availability, persistence safety, or protocol conformance.

Use:

- `docs/SUPPORT-MATRIX.md` for what may be claimed as supported;
- `docs/RELEASE-ACCEPTANCE.md` for immutable publication/user-path proof;
- `docs/TRACKER-INTEGRITY.md` for generated mirror reconciliation;
- `docs/PSYCHE-COMPATIBILITY-MAP.md` for the current Build/Psyche boundary;
- `docs/CONTRIBUTOR-SAFETY.md` for public-data and generated-source rules.

## Security and support

Do not publish tokens, passwords, private keys, signing material, raw private prompts, unrestricted terminal history, private repository contents, private service URLs, or unredacted personal paths.

- Security vulnerabilities: follow [SECURITY.md](SECURITY.md) and use GitHub's private vulnerability-reporting route.
- Ordinary support: follow [SUPPORT.md](SUPPORT.md).
- Product status and active priorities: use [docs/ROADMAP.md](docs/ROADMAP.md).
- Historical design context: use [`docs/superpowers/README.md`](docs/superpowers/README.md); dated records are not an executable backlog.

## Local macOS app channels

Build a protected daily-use app from an explicit tested Git ref:

```bash
pnpm app:stable -- <git-ref>
```

The stable command builds the resolved commit in a temporary detached worktree,
runs the full desktop verification gate, smoke-launches the candidate with
temporary local data, and transactionally replaces
`~/Applications/Psyche Build.app` only after every check passes.

Build the current checkout as a separate experimental app:

```bash
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
