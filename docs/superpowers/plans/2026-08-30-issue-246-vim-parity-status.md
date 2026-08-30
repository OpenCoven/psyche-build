# Issue #246 Status and Decision Record — Post-release cross-platform Vim and keyboard-mode parity

**Date:** 2026-08-30
**Issue:** [OpenCoven/psyche-build#246](https://github.com/OpenCoven/psyche-build/issues/246) (open; created 2026-08-24T15:01:28Z)
**Evidence base:** upstream `main` at `32872639eed9f9f80f361019637fa316da33c12b` (2026-08-30), REST-only inspection, local targeted test run. Facts only; no product claims are made beyond what is cited.

## What exists on main today

- **Shared semantic core (merged).** `packages/vim-core` (`@opencoven/psyche-vim-core` 1.0.0, private workspace package) landed via [#103](https://github.com/OpenCoven/psyche-build/pull/103) "Add a hardened Vim input core" (merged 2026-08-12, `5dd3d8f`) and [#105](https://github.com/OpenCoven/psyche-build/pull/105) "Complete Vim editor composition semantics" (merged 2026-08-12, `dd18cac`), with follow-up fixes `43f38ea` and `9075814` (2026-08-20, replace-restore and bounds). `src/` contains `types`, `normalize`, `chrome-machine`, `editor-machine`, `fixtures`, and a bounded editor substrate (`editor/ex-parser`, `ex-executor`, `motions`, `marks`, `search`, `patterns`, `ranges`, `replay`, `transactions`, `limits`).
- **Versioned fixture contract (partial).** `protocol-fixtures/vim/v1/chrome.json` declares contract version `vim/v1` with 3 chrome traces (`chrome-enter-f6`, `chrome-focus-first`, `chrome-pane-focus-left`). No `editor.json` fixture exists on main.
- **Core test coverage (green locally).** 8 test files (`__tests__/vimContract`, `vimEditorMachine`, `vimEditorEditingContract`, `vimEditorExContract`, `vimEditorSearch`, `vimEditorTransactions`, `vimEditorUnicode`, `vimEditorBounds`) = 293 tests, all passing on 2026-08-30 (vitest 4.1.10, Node v24.16.0, pnpm 10.34.5, `--ignore-scripts` install). Root `pnpm typecheck` passes (exit 0).
- **Desktop package declares but does not consume the core.** `native/desktop/psyche-build-tauri/package.json` lists `@opencoven/psyche-vim-core: workspace:*`, but no file under `native/desktop/psyche-build-tauri/web/` imports it (grep over non-bundle sources, 2026-08-30).
- **Tracker/roadmap state.** `docs/ROADMAP.md` line 178 lists #246 at **P2**. `.beads/interactions.jsonl` records the `psyche-no8`, `psyche-no8.1`–`psyche-no8.5` demotions P1→P2 on 2026-08-28T06:46Z, matching closed reconciliation issue [#237](https://github.com/OpenCoven/psyche-build/issues/237) and closed drift-validation issue [#240](https://github.com/OpenCoven/psyche-build/issues/240) (`scripts/validate-beads-tracker.mjs` exists). The `.beads/issues.jsonl` mirror itself is gitignored; mapping evidence is via `interactions.jsonl` plus #237/#240. Maintainer sequencing comment on #246 (2026-08-30T11:18Z) keeps the train P2 and gates broad rollout on stable input/persistence/action contracts and the first iOS readiness seams (#196/#199/#200).

## What does not exist on main

- **No platform adapter wiring, on any platform.** Grep over non-bundle sources (2026-08-30, `3287263`) finds zero `vim` references in: desktop web (`native/desktop/psyche-build-tauri/web/`), browser frontend (`frontend/src/`), Ink TUI (`src/`), iOS (`native/ios/`), macOS (`native/macos/`). No opt-in setting, no F6 chrome-mode trigger, no chrome indicator exists in any shipped surface. (`F6` matches in bundles are xterm keycode tables, not features.)
- **Slice status against `docs/superpowers/plans/2026-08-12-vim-slice-{1..5}*.md`:**
  - Slice 1 (shared core + desktop reference adapter): **core only**; the desktop reference adapter was planned (`web/vim/vim-entry.ts`) but never landed.
  - Slice 2 (browser/web parity): **not started**.
  - Slice 3 (Ink TUI parity): **not started**.
  - Slice 4 (iOS chrome triggers + semantic routing): **not started**.
  - Slice 5 (conformance gate + acceptance + docs): **not started** — no `docs/VIM.md`, no `scripts/check-vim-conformance.mjs`, no platform manifests, no `editor.json` fixture.

## Verdict against #246 acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| Every `psyche-no8*` mirror maps to this outcome through #237/#240 | **Satisfied (tracker-level)** | P1→P2 demotions recorded 2026-08-28 in `.beads/interactions.jsonl`; #237/#240 closed; ROADMAP.md:178 maps #246 to P2/Input |
| Priorities no longer imply Vim expansion blocks the macOS release or P0 stabilization | **Satisfied** | Same demotion record; ROADMAP.md:178; maintainer comment 2026-08-30 |
| Shared fixture version implemented consistently across each claimed platform | **Not satisfied — no platform currently consumes `vim/v1`** | Only `packages/vim-core` + tests load the fixtures; no adapter on desktop/browser/TUI/iOS |
| Disabled behavior and raw terminal transport remain unchanged | **Vacuously satisfied / untestable at product level** | No chrome mode exists to disable; terminal passthrough is untouched because nothing intercepts it |
| Search, counts, replay, Ex, Unicode, marks, multi-change edits bounded and deterministic | **Satisfied at core level only** | `editor/limits.ts` + 293 green tests incl. bounds/replay/Unicode/Ex suites; not integrated into any surface |
| Accessibility and focus restoration tested per platform | **Not satisfied** | No platform integration, therefore no per-platform tests |
| Physical-keyboard/device proof retained or gap explicit | **Gap — must remain explicit** | No physical-device evidence exists in-repo for this train |
| Each slice merges as a focused current-main PR with exact-head checks and independent review | **Partially** | Slices' core portion merged as #103/#105 (2026-08-12); slices 2–5 have no PRs |

**Overall:** the issue is **not satisfied on main**. The correct characterization is: the shared semantic core and its versioned `vim/v1` chrome fixture are merged and green; every product-facing slice (desktop adapter, web, Ink, iOS, conformance/docs/acceptance) remains unstarted. No cross-platform parity may be claimed today — consistent with the issue's non-goal against claiming parity from shared fixtures alone.

## What remains (critical path)

1. **Slice 1 completion:** desktop reference adapter consuming `@opencoven/psyche-vim-core` behind an opt-in setting with F6 chrome trigger, preserving byte-exact terminal passthrough outside chrome mode; add `protocol-fixtures/vim/v1/editor.json`.
2. **Slice 2:** browser/web parity without touching `/api/keys` or native input transport.
3. **Slice 3:** Ink TUI parity at the top of the existing input-precedence chain.
4. **Slice 4:** iOS hardware/software chrome triggers and semantic action routing preserving PTY input.
5. **Slice 5:** `check:vim-conformance` gate, platform manifests, `docs/VIM.md`, Playwright/Swift fixture conformance, real Vim/Neovim/tmux smoke, accessibility + performance evidence, physical-device evidence or explicit gaps.

Sequencing constraint (maintainer, 2026-08-30): rollout waits on stable input/persistence/action contracts from #196/#199/#200 and the first iOS readiness seam; #246 must not become an implicit prerequisite for those.

## Decision record

- **Decision:** document status only; no code change accompanies this record. The correct next bounded unit of work is the desktop reference adapter (slice 1 completion) against the already-merged `vim/v1` core — it unblocks every later slice and is the only surface where "disabled behavior unchanged" can first be tested rather than assumed.
- **Rationale:** core is green and versioned; adapters are absent; starting at slice 5 gates or re-implementing the core would duplicate merged work.
- **Review basis:** REST evidence on `main` @ `3287263` (2026-08-30), local `pnpm vitest --run __tests__/vim*.test.ts` (293 passed) and `pnpm typecheck` (exit 0) on the same checkout.
