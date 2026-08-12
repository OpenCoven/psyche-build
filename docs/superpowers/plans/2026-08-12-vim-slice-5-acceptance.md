# Vim Slice 5: Cross-platform Acceptance and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove all adapters implement one contract version, document the opt-in workflow, and make remaining physical proof gaps explicit.

**Architecture:** A repository gate validates fixture/version parity and runs each available platform suite. User docs and in-product help are generated from one command catalog so mappings cannot drift.

**Tech Stack:** TypeScript, Vitest, Playwright, Rust/Cargo, XCTest/XCUITest, Markdown

**Tracking:** Claim `psyche-no8.5` after `psyche-no8.4` closes.

---

### Task 1: Add cumulative conformance and documentation gates

**Files:** Create `scripts/check-vim-conformance.mjs`, `__tests__/vimConformanceGate.test.ts`, `docs/VIM.md`; modify `package.json`, `README.md`, `docs/SMOKE.md`, and all mode-aware help catalogs.

- [ ] Write a RED gate test that fails on fixture-version mismatch, missing platform manifest, duplicate/unknown command, absent terminal disposition, or docs/help mapping drift.
- [ ] Add platform manifests with exact contract version and supported capability IDs. Implement `pnpm check:vim-conformance` to validate all manifests and generate a stable command table consumed by docs/help.
- [ ] Document enable/disable, F6, terminal guarantees, chrome commands, editor modes/Ex subset, accessibility escape hatch, configuration, platform limitations, and troubleshooting. Do not claim `.vimrc`/plugin compatibility.
- [ ] Run the gate and docs/source contract tests GREEN. Commit: `Document and gate Vim conformance`.

### Task 2: Execute the cumulative acceptance matrix

- [ ] Run shared golden fixtures in TypeScript and Swift and compare normalized JSON output byte-for-byte.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm smoke`, `pnpm smoke:pack`, desktop `build:web`, Rust fmt/check/test, `pnpm ios:project:check`, iOS simulator suites, and `git diff --check`.
- [ ] Run Playwright desktop/web cases with keyboard layouts, IME composition, screen-reader semantics, reduced motion, stale target recovery, paste, mouse reporting, and focus restoration.
- [ ] Capture diagnostics from failed, pending-prefix, macro-limit, and unsupported-action cases; assert reports include only bounded action/context/timing metadata and never raw typed text, paste content, editor text, or terminal bytes.
- [ ] Run real Vim and Neovim in direct xterm, nested tmux, browser terminal, Ink-owned pane, and iOS. Record versions, commands, byte/order results, and unavailable physical platforms in the Bead.
- [ ] Measure key dispatch and editor macro replay; require p95 dispatch under 8 ms for a single action and bounded macro execution without blocking UI frames over 33.4 ms.
- [ ] Obtain final independent spec and cumulative code-quality reviews. Fix/re-run until approved, then close `psyche-no8.5` and parent `psyche-no8` only if all child evidence is present.
- [ ] Use the finishing-development-branch workflow; do not merge or delete worktrees without explicit authorization.
