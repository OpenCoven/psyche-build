# Psyche Build agent guide

This file is the root router for people and coding agents changing this
repository. A more specific `AGENTS.md` takes precedence for files below it.

## Canonical role

Psyche Build owns the local coding cockpit: visible lanes, tmux panes, Git
worktrees, product UI, bounded provider adapters, explicit integration actions,
and the evidence a maintainer uses to inspect or hand off work.

Psyche Build does **not** own the OpenCoven trust stack:

- `familiar-contract` owns portable familiar identity.
- `coven-threads` owns protected-surface authorization decisions.
- `psyche` owns canonical task, lane, lease, approval, receipt, and recovery
  protocol semantics.
- `coven` owns daemon authority, persistence, session lifecycle, and runtime
  execution.

Repository-local task, pane, process, worktree, Bead, or UI identifiers must not
be promoted into durable OpenCoven protocol identity. Until
[issue #253](https://github.com/OpenCoven/psyche-build/issues/253) lands an
immutable Psyche consumer profile and compatibility canary, describe existing
integration as repository-local behavior, not Psyche protocol conformance.

## Start here

From a clean checkout:

```bash
./scripts/agent-bootstrap
./scripts/agent-check fast
```

Before requesting merge:

```bash
./scripts/agent-check full
```

The full check deliberately does not claim iOS validation unless it is requested
on a compatible Mac:

```bash
PSYCHE_AGENT_CHECK_IOS=1 ./scripts/agent-check full
```

The bootstrap command installs only locked dependencies. It does not mint
credentials, modify GitHub, publish packages, create releases, or mutate Beads.

## Source-of-truth routing

Read only the documents relevant to the change:

- Product behavior and scope: `docs/PRODUCT-SPEC.md`
- Control authority and receipts: `docs/CONTROL-PLANE.md`
- MCP/task binding and exposed surfaces: `docs/AGENT-SURFACE-CONTROL.md`
- Bridge threat model: `docs/BRIDGE-SECURITY.md`
- Optional providers and Coven boundary: `docs/INTEGRATIONS.md`
- Smoke behavior: `docs/SMOKE.md`
- Release gates and support claims: `docs/RELEASE-ACCEPTANCE.md`,
  `docs/RELEASE.md`, and `docs/SUPPORT-MATRIX.md`
- Current execution order: `docs/POST-RELEASE-EXECUTION.md`
- Public roadmap policy: `docs/ROADMAP.md`
- Beads source and public mirror operation: `.beads/README.md`
- Contributor workflow: `CONTRIBUTING.md`
- Machine-readable repository contract: `agent/manifest.yaml`

Do not copy temporary incident guidance into this root file. Put dated,
expiring operational notes in scoped documentation or an issue.

## Planning and work isolation

GitHub issues and milestones own public outcomes, acceptance gates, and
externally legible status. Beads owns managed implementation tasks, dependency
ordering, and execution detail. The GitHub Project and generated managed issue
bodies are one-way sanitized mirrors of Beads; update their source with `bd`,
not by editing generated mirrors. Unmanaged GitHub issues remain ordinary
GitHub outcomes. Neither tracker grants runtime identity or authority.

Use one branch and one worktree per PR. Do not reuse another lane's worktree,
rewrite a shared branch, or remove a worktree that may contain uncommitted work.
Keep unrelated changes out of the diff.

## Risk and authority

Treat changes according to their highest affected class:

- **R0** — documentation, examples, copy.
- **R1** — pure code with no external state.
- **R2** — local mutable state, migrations, recovery, or cleanup.
- **R3** — network access, credentials, user data, GitHub/Beads writes, or
  provider integrations.
- **R4** — identity, authorization, control state, persistence, release,
  publication, destructive cleanup, or protected CI policy.

R3/R4 changes require an explicit authority analysis, failure behavior,
recovery/rollback evidence, and maintainer review. Never infer authority from a
prompt, task title, caller-supplied identifier, process ID, tmux pane, worktree,
Bead, or UI selection.

## Protected surfaces

Review these as R4 unless a narrower scoped guide says otherwise:

- `src/control/**`
- `src/services/bridge/**`
- `native/desktop/psyche-build-tauri/src-tauri/**`
- `native/ios/**`
- `.github/workflows/release.yml`
- `.github/workflows/beads-project-sync.yml`
- `scripts/app-store-connect.mjs`
- `scripts/build-macos-app.mjs`
- `scripts/beads-project-sync/**`
- `.beads/**`
- release, signing, credential, approval, receipt, recovery, and destructive
  cleanup code anywhere in the tree

Never commit secrets, task tokens, raw prompts, private repository contents,
complete environment dumps, user home paths, terminal transcripts, or unsanitized
Beads exports. Use deterministic fixtures with synthetic values.

## Generated paths

Do not hand-edit generated outputs:

- `src/utils/generated-agents-doc.ts` — run `pnpm generate:hooks-docs`
- `protocol-fixtures/**` — run `pnpm fixtures:generate`
- `native/ios/Psyche.xcodeproj/**` and
  `native/ios/PsycheApp/Resources/Info.plist` — run
  `pnpm ios:project:generate`
- `native/desktop/psyche-build-tauri/web/*.bundle.js` — run
  `pnpm --dir native/desktop/psyche-build-tauri build:web`

If generation changes only volatile metadata rather than source-derived
behavior, revert the generated churn and explain it in the evidence packet.

## Verification selection

`./scripts/agent-check fast` is the standard bounded gate for iteration. Run
focused tests for the affected contract before the fast gate.

`./scripts/agent-check full` is the clean handoff gate. It covers docs,
TypeScript, unit tests, build/package smoke, real tmux startup smoke, desktop web
bundles, and desktop Rust formatting/tests/checks. iOS remains an explicit
platform gate and fails rather than silently skipping when requested on an
unsupported host.

Release publication, notarization, TestFlight, Homebrew, live GitHub/Beads
mutation, and credential-backed provider tests are external side effects. Do
not execute them without explicit maintainer approval and the relevant protected
environment.

## Completion evidence

Every agent-authored PR must state:

1. Objective, acceptance criteria, and non-goals.
2. Files intentionally touched.
3. Canonical contracts consulted.
4. Exact commands and results.
5. Authority, privacy, and security impact.
6. Migration and rollback or why neither applies.
7. Generated artifacts and provenance.
8. Remaining uncertainty, unsupported platform checks, and follow-up issues.

A test count is not a substitute for proving the affected contract. Do not
close an issue solely because documentation or tests exist; link evidence for
every acceptance criterion and leave unresolved gates explicit.
