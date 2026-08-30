# Working record — issue 210, bounded protected workspace cache

- Issue: [OpenCoven/psyche-build#210](https://github.com/OpenCoven/psyche-build/issues/210) — `[psyche-i7c.10.1]` Implement bounded protected workspace cache (Bead `psyche-i7c.10.1`, P1)
- Parent: `psyche-i7c.10` — Phase 10: recovery, persistence, accessibility, and acceptance ([#209](https://github.com/OpenCoven/psyche-build/issues/209)); canonical outcome gh-200
- Branch: `psyche/issue-210-bounded-workspace-cache` (worktree `/home/node/trees/issue-210`, based on `origin/main` at `a4546f4`)
- Date: 2026-08-30
- Executor: delegated issue agent (fork pipeline per runbook; upstream writes token-denied)

## Outcome

Shipped the platform-neutral bounded protected workspace cache — contract document plus versioned v1 reference implementation, without touching Swift/iOS integration (that belongs to the mobile family; see boundaries):

1. `docs/mobile/WORKSPACE-CACHE-CONTRACT.md` — the storage contract: Application-Support-style storage model and adapter contract (write-temp-then-promote), the two distinct auth axes behind "complete-until-first-auth" (device-unlock file protection via `NSFileProtectionCompleteUntilFirstUserAuthentication`, and bridge-session auth for the presentation guard), host-identity keying with refusal semantics (other-host state never restores), the bounds table (128 KiB authoritative record budget; field caps), explicit-failure/never-truncation rules, data-minimization exclusions (credentials/full source/transcripts/paths), the closed v1 schema, typed error and restore-result tables, determinism, and the verification matrix separating what is proven here from platform-owned XCTest gaps.
2. `src/mobile/workspaceCache.ts` — pure, deterministic, platform-neutral v1 module: `CachedWorkspaceState` schema and strict validator (closed schema — unknown fields rejected; referential integrity enforced; credential-shaped free text rejected fail-closed), host-key derivation/validation (exact-match keying; documented rationale for not hashing), storage-key namespacing, atomic save over an injected `WorkspaceCacheStorageAdapter` (validate → stamp → serialize → byte-budget check → writeTemp → promote; every failure leaves the prior record byte-identical), fail-closed restore (`empty` / `refused-other-host` / `unusable` / `restored`, payloads never exposed for foreign or invalid records, no implicit deletion), complete-until-first-auth protection envelope (`protected-inert` until the caller's `authAccepted` attestation; `presentableAsLive`/`inputEnabled`/`mutationsAllowed` are literal-typed `false` in every mode), typed errors with structured problems, a pure in-memory reference adapter, and an identity-bound store facade.
3. `__tests__/workspaceCache.test.ts` — 79 table-driven and adversarial tests (counts below).

## Scope and boundaries

- **No Swift/XCTest integration.** The platform-native cache implementation (real Application Support files, `NSFileProtectionCompleteUntilFirstUserAuthentication` attributes, crash-atomic renames) belongs to the mobile family's platform layers; this slice delivers the platform-neutral contract and reference implementation over an injected adapter. The file-protection and real-filesystem proof is a documented gap (below), as the issue itself allows ("tested where possible").
- **No stale/live reconciliation.** #211 (`psyche-i7c.10.2`) owns presenting restored state as stale, reconciliation, and re-enablement. Coordination per the phase plan: #211 consumes these exact filenames and entry points (`src/mobile/workspaceCache.ts`, `createWorkspaceCacheStore`/`restoreWorkspaceCache`, the protection envelope in the contract, section 6). This module never reconciles and never marks restored state live.
- Files touched: `src/mobile/workspaceCache.ts`, `__tests__/workspaceCache.test.ts`, `docs/mobile/WORKSPACE-CACHE-CONTRACT.md`, `docs/working-records/issue-210-bounded-workspace-cache.md`. The `src/mobile/`, `docs/mobile/`, and `docs/working-records/` directories are new on this branch (main at `a4546f4` does not have them; the #209 sibling branch adds different files there).
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json` deps, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, barrel files, or generated outputs. No product/runtime code paths changed; the module is additive and currently unreferenced by product code.
- Constants chosen and documented in the contract (128 KiB record budget; 8 projects / 24 panes / 24 drafts; 2,048 draft code units). Changing them later is a contract revision, not a silent tuning.

## Risk class

**R3** — persistence/recovery semantics (per AGENTS.md and the Phase 10 plan's per-child risk note for #210): host keying, protection, and write atomicity are authority-adjacent. Mitigations in this slice: fail-closed validation (closed schema, unknown-field rejection, credential-shape backstop, strict UTF-8, oversize rejection before any I/O), atomicity modeled in the module over the adapter contract with negative tests for both failure points, refusal of foreign-host state before any payload exposure, no implicit deletion, and literal-typed never-live/never-mutable protection flags. Threat/failure-boundary review is tabled in the contract (section 2); independent review happens at PR review and at #215's phase review gate, per the phase plan.

## Exact commands and results

All commands run from `/home/node/trees/issue-210` (Node v24.16.0, pnpm 10.34.5, vitest 4.1.10):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | OK — exit 0 ("Lockfile is up to date, resolution step is skipped") |
| `npx pnpm exec vitest --run __tests__/workspaceCache.test.ts` | OK — `Test Files 1 passed (1)`, `Tests 79 passed (79)` |
| `npx pnpm exec tsc --noEmit` | OK — exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | OK — exit 0, no output |
| `git diff --check` | OK — exit 0, no output |

Iteration notes (both fixed before final verification, both caught by this suite):

1. Validation rejections first mapped to a generic `invalid-state` error code; the suite surfaced that oversize/bounds rejections were not individually typed, so the error code now mirrors the first validation problem's code 1:1 with all problems attached.
2. Two test-construction bugs (a wrong expected path index `panes[1]` vs `panes[2]`, and a failure-injection flag enabled before the baseline save it was meant not to affect) were corrected; no production-code weakening was involved.

## Exact head SHA

- Deliverable content commit (module, tests, contract, and all verification above ran against this tree): reported in the PR body and status comment, authored after the final commit (a commit cannot contain its own hash) and visible via `gh pr view` on the fork. Branch base: `origin/main` at `a4546f4`.

## Test counts

- New focused suite: **79 tests, 79 passed, 0 failed** (`__tests__/workspaceCache.test.ts`).
- Full repository vitest suite: **not run locally** (runbook scope is focused verification; the fork's CI Quality job runs `pnpm test` on the PR — see proof gaps).

## Proof gaps

- **No iOS/XCTest proof.** This host has no Xcode/iOS tooling. File-protection attributes (`NSFileProtectionCompleteUntilFirstUserAuthentication` on record and temp files), real Application Support placement, and crash-atomicity of the real rename are platform-owned and untested here; they are explicit requirements in the contract (sections 3, 4, 12) and remain open acceptance items for the mobile family's XCTest targets. The issue's "where possible" is satisfied by adapter-contract tests over the reference adapter, not by real-filesystem proof.
- **No local tmux; `scripts/agent-bootstrap` and `scripts/agent-check` not run** (runbook: they require tmux, unavailable on this host).
- **No Rust/toolchain proof.** No PsycheCore or cargo work touched.
- **Full repository vitest suite not run locally**; the fork's CI Quality gate runs `pnpm test` on this PR, and its result is monitored before ready-marking.
- **No runtime/user-path evidence.** This slice is a contract + reference implementation with no product wiring; user-path proof arrives when the mobile family integrates it (#211 onward, #213 acceptance matrix).
- **Beads source not directly queried** (Beads CLI availability not guaranteed on this host); acceptance criteria were taken from the generated GitHub mirror body of #210 (read 2026-08-30) and the Phase 10 plan's verbatim-faithful transcription.
- **No paired-host scenario** — that is #213's deliverable.

## Rollback notes

- Revert the single deliverable commit (or close/revert the PR) to remove all four files; no generated artifacts, dependencies, shared configs, or other agents' paths are touched, so rollback is clean and complete.
- The module is additive and unreferenced by product code; deleting it cannot affect runtime behavior. There is no persisted-format migration concern: v1 records are only ever written by this module, and `discardWorkspaceCache` or plain file removal removes all state.

## Security and privacy

- No credentials, tokens, private keys, raw prompts, unrestricted terminal output, private repo contents, environment dumps, private URLs, or unredacted personal paths are included in any file, PR, or comment. Test fixtures use synthetic ids (`project-alpha`, `pane-1`, `01234567-89ab-…`); the credential-shaped strings in tests are deliberately fake, short, and non-functional.
- The module itself fail-closes on protected data: closed schema, credential-shape backstop on free-text fields, no path/source/transcript fields in the schema, strict UTF-8 decode, refusal of foreign-host payloads before description, and explicit oversize rejection instead of truncation (contract, sections 2, 7, 8).
