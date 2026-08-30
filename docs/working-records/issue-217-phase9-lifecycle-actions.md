# Working record — issue 217, Phase 9 lifecycle plan (planning/contract slice)

- Issue: [OpenCoven/psyche-build#217](https://github.com/OpenCoven/psyche-build/issues/217) — `[psyche-i7c.9]` Phase 9: full lifecycle merge, PR, stop, close, and cleanup (Bead `psyche-i7c.9`)
- Branch: `psyche/issue-217-phase9-lifecycle-actions` (worktree `/home/node/trees/issue-217`, based on `origin/main` at `a4546f4`)
- Date: 2026-08-30
- Executor: delegated issue agent (fork pipeline per runbook; upstream writes token-denied)

## Outcome

Shipped the Phase 9 planning/contract slice, without implementing any child deliverable (#218–#221 own those):

1. `docs/mobile/PHASE-9-LIFECYCLE-PLAN.md` — execution plan: deliverable breakdown for #218–#221 with the closed `psyche-i7c.9.1` scoped-context claim (released stale after its branch was externally removed, per #218's note) re-landed at parent level; per-child acceptance criteria drawn verbatim-faithful from the Bead mirror bodies (read 2026-08-30); Beads `Blocked by` integration order (#218 → #219 → #218+#219 → #220 → #221); a reuse contract naming the exact host seams children must reuse rather than re-implement (`mergeAction` validation + issue handlers, sibling handling via `removePaneIdentitiesFromConfig`, merge-target fallbacks, `pr_review` review data, `closeAction` cleanup choices, stop = `kill_only`-semantics teardown retaining worktree/branch, single-use remote action sessions); parent acceptance criteria mapped to owning children; risk-class notes per AGENTS.md; evidence expectations; explicit non-goals.
2. `src/mobile/lifecycleActionContext.ts` — versioned (v1) scoped action-context contract: `LifecycleActionContext` (canonical selected project, exact pane identity incl. tmux server generation, worktree/branch identity, action id, host authority reference, consequence, capture instant), `validateActionContext()` (strict fail-closed validator: unknown fields rejected at every level, required identities present, worktree required exactly for `merge`/`create_pr`, bounded absolute canonical paths without traversal, conservative git-branch shape, tmux target-safe session names, tmux `$N` session-id form, credential-shaped and raw-command-shaped content rejected as `unsafe-content`, never throws), `consequenceSummary()` (stable `host · project · pane · worktree · branch · consequence` line, `null` instead of a partial string — implements the parent criterion "Destructive actions name host/project/pane/worktree/branch/consequence"), `DESTRUCTIVE_LIFECYCLE_ACTION_IDS` (`merge`, `stop`, `close`), and `isLifecycleActionContextStale()` (5-minute window aligned with the gateway's remote action-session TTL; future/unparseable capture instants fail closed as stale).
3. `__tests__/lifecycleActionContext.test.ts` — 40 focused tests: acceptance for complete and worktree-less contexts; strict-schema rejections (non-objects fail closed without throwing, wrong version, unknown action id, unknown fields top-level/nested/server-identity); missing-identity rejections (host, project root, relative root, tmux server generation, `%N` pane-id form, server pid, authority reference, authority kind, consequence, capturedAt); worktree-required behavior for `merge`/`create_pr` vs worktree-less `stop`; fail-closed content policy (GitHub-token shape, JWT host name, PEM private key, labeled secret, `rm -rf`, `tmux kill-pane`, `$(…)`, `&&`, shell metacharacters in identity fields, path traversal, non-conservative branch names); `consequenceSummary` completeness/ordering/shell-pane `none attached`/bare-id fallback/null-on-incomplete; destructive classification; staleness (fresh, aged-out, future, unparseable, max-age constant).

## Scope and boundaries

- Planning/contract only. No child implementation (#218 menu/confirmations, #219 merge/PR flows, #220 fixtures/regressions, #221 review) is attempted here; no host action semantics were touched — `src/actions/**`, `src/services/**`, and `src/utils/**` are unchanged.
- Files touched: `src/mobile/lifecycleActionContext.ts`, `__tests__/lifecycleActionContext.test.ts`, `docs/mobile/PHASE-9-LIFECYCLE-PLAN.md`, `docs/working-records/issue-217-phase9-lifecycle-actions.md`. No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json` deps, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, `index.ts`/barrel files, or generated outputs. New paths are namespaced by issue and collide with no sibling slice (`src/mobile/` holds only this file; the #209 slice's `phase10Gate.ts` is a distinct file on its own branch).
- No runtime/product behavior changed; no authority, confirmation, receipt, revocation, idempotency, work-preservation, persistence, or recovery behavior weakened (the module executes nothing and grants nothing — the authority reference is display/scoping metadata only).

## Risk class

**R1** — documentation plus isolated, additive module with focused tests. The context module is a pure record model: it holds no authority, persists nothing, executes nothing, and infers no runtime state. The child deliverables it governs are R2/R3 (consequential-action UX and flows) and carry their own review and evidence bars (see the plan document).

## Exact commands and results

All commands run from `/home/node/trees/issue-217` (Node v24, pnpm 10.34.5):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | OK — "Lockfile is up to date, resolution step is skipped … Done in 750ms" |
| `npx pnpm exec vitest --run __tests__/lifecycleActionContext.test.ts` | OK — `Test Files 1 passed (1)`, `Tests 40 passed (40)` |
| `npx pnpm exec tsc --noEmit` | OK — exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | OK — exit 0, no output |
| `git diff --check` | OK — exit 0, no output |

One iteration note: the first validator policy rejected the real tmux session-id form (`$2`) under the bare-`$` identifier ban; the failing acceptance tests exposed it, and `pane.tmuxServer.sessionId` now uses a dedicated tmux `$N` format rule while bare `$` remains rejected in every other field (40/40 after the fix).

## Exact head SHA

- Deliverable content commit (module, tests, plan document, and all verification above ran against this tree): `9b95fbc50e3bef8b787e460f65c1f4cdf1561f15`.
- The final pushed branch head adds only this working-record commit on top; the exact head SHA is reported in the PR body and status comment (a commit cannot contain its own hash) and is visible via `gh pr view` on the fork.

## Test counts

- New focused suite: 40 tests, 40 passed, 0 failed (`__tests__/lifecycleActionContext.test.ts`).
- Full repository suite and `agent-check`: **not run here** — see proof gaps.

## Proof gaps

- **No local tmux; `scripts/agent-bootstrap` and `scripts/agent-check` not run** (runbook: they require tmux, unavailable on this host). No live merge/PR/stop/cleanup action was executed anywhere — none of this slice executes actions.
- **No local iOS/Xcode proof.** No simulator, device, or TestFlight evidence exists or is claimed; UI/fixture proof belongs to #218/#220 on capable hosts/CI.
- **Full repository vitest suite not run locally** (the runbook scope is focused verification; the fork's CI runs the repository Quality gate on the PR).
- **Beads source not directly queried** (Beads CLI availability not guaranteed on this host); acceptance criteria and dependency edges were transcribed from the generated GitHub mirror bodies (#217, #218–#221) on 2026-08-30 and marked verbatim-faithful rather than verbatim-verbatim for that reason.
- **`psyche-i7c.9.1` history**: the Beads mirror records it as closed history with the stale-claim note quoted from #218; the claim that no source change landed from that branch is taken from that note, not independently verified.

## Rollback notes

- Revert the single deliverable commit (or close the PR) to remove all four files; no generated artifacts, dependencies, shared configs, or other agents' paths are touched, so rollback is clean and complete.
- The context module is additive and unreferenced by product code; deleting it cannot affect runtime behavior.

## Security and privacy

- No credentials, tokens, private keys, raw prompts, unrestricted terminal output, private repo contents, environment dumps, private URLs, or unredacted personal paths are included in any file, PR, or comment. All fixture identifiers, paths, and branch names are synthetic (`/opt/psyche-build`, `build-host-1`, `psyche/feat-x`); secret- and command-shaped strings appear only as validator-negative fixtures.
- The module fail-closes on credential- or command-shaped content by design, and the plan requires children to keep host authority as the sole source of truth (the authority reference never grants anything).
