# Working record — issue 214: product and architecture documentation

- **Issue:** [OpenCoven/psyche-build#214](https://github.com/OpenCoven/psyche-build/issues/214) — `[psyche-i7c.10.5] Update product and architecture documentation` (Beads mirror `psyche-i7c.10.5`, P1, blocked by #211; canonical outcome [#200](https://github.com/OpenCoven/psyche-build/issues/200), epic [#208](https://github.com/OpenCoven/psyche-build/issues/208))
- **Branch:** `psyche/issue-214-product-arch-docs` (based on `origin/main` at `a4546f4`)
- **Date:** 2026-08-28 (work performed against `main` at `a4546f4`)
- **Risk class:** **R1** — documentation-only slice: no code, schema, protocol, security, or release behavior changed.
- **Status:** delivered as an R1 docs slice while the issue's blocking dependency (#211 stale-UX reconciliation) remains open; docs are honest about implemented vs. planned and must be reconciled again when #209–#215 land.

## Outcome

1. **`docs/MOBILE-ARCHITECTURE.md` (new)** — the Now-first mobile information architecture and architecture contract the issue asks for:
   - cross-project Now inbox model (Needs You / Running / Recent ranking rules);
   - one/two-pane adaptive workspace with bounded attached terminal streams (client cap 2, host cap 4);
   - protocol-v2/v3 typed control envelopes over the paired TLS/Bonjour bridge (negotiation, envelope shapes, encodings, binary frame format);
   - one canonical workspace snapshot published to a Swift `WorkspaceStore` (sequence gating, connection generations, reconciliation);
   - certificate-pinned self-signed transport (SHA-256 leaf pin, serverID identity, Keychain storage, pairing budget);
   - project-boundary scoping of every mobile operation (published-pane/target checks, realpath containment for file inspection, strict field validation);
   - offline state visibly stale, recovery/lifecycle behavior;
   - explicit demo-only vs production boundary (`-uiFixture` fixture root never constructs a transport or Keychain store);
   - an implementation-status table separating implemented-on-`main` from tracked-open work in #209/#210/#211/#216/#217, under the #208 epic and #200 outcome.
2. **`docs/PRODUCT-SPEC.md`** — one narrow additive section, `## Mobile companion (Now-first)`, inserted between the existing *Bridge rules* and *Optional integration boundary* sections. It summarizes the Now-first IA, the planned-internal-beta status, and links `MOBILE-ARCHITECTURE.md`. **No existing line was rewritten, moved, or deleted.**
3. Acceptance criterion "No obsolete three-column mobile flow remains": verified below — the current product/architecture docs contain no three-column mobile flow. Three-column phrasing appears only under `docs/superpowers/` (dated design history, not current contracts), which this slice intentionally does not rewrite.

## Scope and boundaries

- Documentation-only. No source files, tests, fixtures, workflows, or generated outputs touched.
- Files touched: `docs/MOBILE-ARCHITECTURE.md` (new), `docs/PRODUCT-SPEC.md` (additive-only), this working record. Nothing else.
- Concurrent-agent ownership respected: no edits to `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, `docs/README.md`, `src/**`, or sibling agents' doc namespaces (`docs/gpu/`, `docs/vim/`, `docs/a11y/`, `docs/mobile/`, `docs/perf/`, `docs/review/`). `docs/README.md` indexing of the new document is deliberately left to the maintainer to avoid a multi-agent collision on that file.
- Accuracy rule followed: every numeric limit and security guarantee in the new document was read out of the proving source file on `main` (`src/services/bridge/*.ts`, `src/workspace/snapshot.ts`, `native/ios/PsycheCore/**`, `native/ios/PsycheApp/**`) and the pre-existing contracts (`docs/BRIDGE-SECURITY.md`, `docs/SUPPORT-MATRIX.md`). Planned behavior (workspace cache, stale-restore UX, discovery-driven connect, full guarded lifecycle flows, acceptance gates) is attributed to its owning open issue, never described as shipped.

## Exact commands and results

Run from `/home/node/trees/issue-214` on branch `psyche/issue-214-product-arch-docs`:

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | exit 0 — `Done in 1s using pnpm v10.34.5` |
| `npx pnpm exec tsc --noEmit` | exit 0 — no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0 — no output |
| `git diff --check` | exit 0 — clean |
| `git diff --numstat docs/PRODUCT-SPEC.md` | `17  0  docs/PRODUCT-SPEC.md` — additive-only (0 deletions) |
| `grep -rniE "three.?column" docs/PRODUCT-SPEC.md docs/MOBILE-ARCHITECTURE.md` | exit 1 — no match (no obsolete three-column mobile flow in current product/architecture docs) |
| `grep -rniE "three.column" docs/ -l` (excluding `docs/superpowers/`) | no current-contract matches; matches exist only under dated `docs/superpowers/` design history, which is out of scope |

- **Vitest:** not run — no test files were added or changed (runbook: vitest only for new/changed tests). Docs-only slice; no behavior to pin.
- **Baseline:** typechecks were clean before the change on this branch (the change touches only Markdown; both `tsc` runs and `git diff --check` pass identically with the change applied).

## Commits and head

- Docs commit (architecture document + product-spec section): `5ad6d3ae48f0a2db8f1eb3f5741a547f097204b7` — `docs(mobile): Now-first mobile architecture and product-spec IA section (#214)`, 2 files changed, 365 insertions(+).
- This working record is committed on top as the final head commit of the branch; the PR body and status comment record the exact final head SHA (a Markdown file cannot contain its own commit's SHA). The certified tree is `5ad6d3a` plus this record file only.

## Test counts

- 0 tests added, 0 changed, 0 run (docs-only R1 slice; `tsc` typechecks above are the automated verification applicable here).

## Proof gaps

- **No runtime/iOS evidence exists or is claimed.** This host has no tmux, Xcode/iOS tooling, or Rust toolchain (per runbook), so no simulator, physical-device, pairing, or live paired-host acceptance was run. iOS acceptance is owned by [#209](https://github.com/OpenCoven/psyche-build/issues/209)/[#200](https://github.com/OpenCoven/psyche-build/issues/200).
- CI on the fork PR provides quality checks only; iOS jobs are change-classified and may be skipped. Skipped checks are not iOS proof.
- Documentation states implemented-vs-planned, not support: the iOS application remains **Planned internal beta pending #200** per `docs/SUPPORT-MATRIX.md`; no TestFlight availability is claimed anywhere in this slice.
- Cross-launch workspace cache (#210), restored-as-stale UX (#211), discovery-driven connect (#216), guarded merge/PR/cleanup mobile flows (#217) are **not implemented on `main`**; the new document marks each as tracked-open. When #209–#215 land, this documentation must be reconciled again.

## Rollback

- Pure additive documentation. Revert the branch's commits (`git revert 5ad6d3a` for the docs commit, plus the working-record commit) or close the PR without merging; `main` is unaffected until merge. No generated outputs, schemas, or persisted formats are involved, so no data migration or regeneration is required.
