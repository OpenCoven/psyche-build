# Standalone docs dependencies implementation plan

> Execute inline with executing-plans; obtain independent R4 branch review before protected delivery.

**Goal:** Deliver and close #569 with one docs lockfile and clean contributor/CI installation evidence.

**Architecture:** Remove docs from the root workspace and give the docs application its own workspace boundary, pinned pnpm and matching supply-chain policy. Keep the existing docs lockfile and /docs Dependabot entry. Bootstrap and every docs-building CI/release validation path install that graph separately with frozen resolution and scripts disabled.

**Spec:** User-authorized contributor reliability sprint and GitHub #569 option 1. The user explicitly approved this design. This record is reference material, not a planning store.

## Constraints and review focus

Preserve package versions, integrity, toolchain pins, 1440-minute release age, dependency script restrictions, Dependabot cooldown and security fixes. No deploy settings, credentials, tag or release action. Review nested workspace discovery, docs-only updates against the root lockfile, clean installs, optional native dependencies and every existing docs build consumer.

## Task 1: Isolate resolution

- [ ] Add executable pnpm regressions in `__tests__/docsDependencyIsolation.test.ts`: root graph excludes docs, docs graph contains only docs, and a docs-only manifest/lockfile update leaves root frozen resolution unchanged.
- [ ] Run regressions against unchanged configuration; expect workspace discovery and update isolation failures.
- [ ] Remove the root docs workspace entry, add `docs/pnpm-workspace.yaml`, pin docs packageManager, and regenerate only the root lockfile importer/pruning with the pinned pnpm. Retain dependency versions and integrity; verify graph deltas.
- [ ] Run isolation tests; expect success without network-dependent fixtures.

## Task 2: Install every graph and deliver

- [ ] Update `scripts/agent-bootstrap`, `scripts/agent-check`, docs-building CI/release validation steps, workflow triggers and contributor docs. Root and docs installs remain frozen; docs scripts stay disabled at install time.
- [ ] Run owning workflow/repository contract tests and clean-checkout bootstrap, docs build, fast/full gates; no generated or lockfile drift may remain.
- [ ] Exercise a scoped docs update shape independently of future Dependabot generation. Record actual command outcomes and first failures.
- [ ] Commit, obtain independent R4 review, resolve findings, wait for exact-head terminal required checks, protected merge, verify main, then manually close #569 with evidence and Project Evidence links.

Rollback is a reviewed revert of the complete workspace/install change. Do not partially restore overlapping ownership.
