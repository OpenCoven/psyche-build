# Working record — issue 219, mobile merge and PR interactive flow contracts (contract slice)

- Issue: [OpenCoven/psyche-build#219](https://github.com/OpenCoven/psyche-build/issues/219) — `[psyche-i7c.9.3]` Exercise merge and PR interactive workflows on mobile (Bead `psyche-i7c.9.3`, P1, bead status `open`/blocked)
- Branch: `psyche/issue-219-merge-pr-interactive-flows` (worktree `/home/node/trees/issue-219`, based on `origin/main` at `f12b753` — includes `feat(mobile): share guarded remote action state (#274)`, which does not collide with this slice)
- Date: 2026-08-30
- Executor: delegated issue agent (fork pipeline per runbook; upstream writes token-denied)

## Outcome

Shipped the foundational merge/PR interactive-flow contract slice for mobile, without implementing any sheet UI or touching #217/#218 files:

1. `docs/mobile/MERGE-PR-INTERACTIVE-FLOWS.md` — flow contracts: the merge confirm/choice chain (sibling-pane teardown confirmation, merge-start confirmation, uncommitted-changes choices with the existing option ids `commit_automatic`/`commit_ai_editable`/`commit_manual`/`stash_main`/`cancel`, commit-message input, fallback-target confirmation, conflict-resolution navigation handoff) and the PR review flow (title/body summary editing, related-file navigation, generated-summary editing incl. the `aiFailed` warning, final URL messages `Created PR: <url>` / `PR already exists: <url>`); explicit single-use cancel semantics; the host-remains-source-of-truth rule for all validation; terminal-outcome taxonomy; integration notes.
2. `src/mobile/mergePrFlowMachines.ts` — versioned (v1) pure TS state machines: `mergeFlowMachine` and `prReviewFlowMachine` as explicit transition tables (`MERGE_FLOW_TRANSITIONS`, `PR_REVIEW_FLOW_TRANSITIONS`), a shared reducer engine, terminal outcomes exactly `succeeded`/`failed`/`unknown`/`recovery_required` (plus the user-abort exit `cancelled`, not an outcome), single-use cancel (terminal `cancelled` rejects every further event with `session_closed`), typed host-validation-failure terminal states (`host_validation_failed` with `HostValidationFailureReason` calibrated to the existing action-session failure codes), `unknown` outcome reserved for session loss while a continuation is in flight, `auditFlowMachine` structural invariant checker, and pure wiring adapters (`hostStepFromRemoteActionResult`, `hostResultFromRemoteActionResult`, `CONFIRM_PURPOSE_BY_TITLE`) that consume exactly the `RemoteActionResult` shapes mobile clients receive over the bridge and fail closed on unclassifiable results. No I/O, no clock, no content validation (host-side).
3. `__tests__/mergePrFlowMachines.test.ts` — 53 focused tests: structural audit of both tables (terminal closure, exactly one cancel row per cancellable status, no user events while awaiting the host, consequential rows only as explicit user executes from host-opened sheets/review states, gate annotations consistent); destructive-branch walks (sibling→merge, fallback→merge, uncommitted→commit input→retry, PR confirm→review→submit→final URL); negative paths (no confirm sheet → no execution; unconfirmed review submit → `creation_not_confirmed`; unauthorized option/file rejected; unknown events rejected; user events during `awaiting_host` rejected); single-use cancel from every cancellable state with an all-event-types rejection sweep; typed host-validation failures for all six reasons; session-loss outcome derivation (`unknown` in flight vs `recovery_required` idle/sheet); adapter coverage including `serializeActionResult` wire-level integration.

## Scope and boundaries

- Contract slice only. No sheet UI, no rendering, no a11y, no product behavior change — sheet UI integration is the documented gap of this slice (mobile delivery track; #218 owns the native pane action menu and guarded confirmations).
- Dependencies honored: #217 (context schema) and #218 (action catalog) own their files; nothing of theirs was read-modified or depended on at code level. The bead is blocked by #218; this slice is the independently reviewable foundation (host stays source of truth; flows wire to *existing* action results only).
- Files touched: `src/mobile/mergePrFlowMachines.ts`, `__tests__/mergePrFlowMachines.test.ts`, `docs/mobile/MERGE-PR-INTERACTIVE-FLOWS.md`, `docs/working-records/issue-219-merge-pr-interactive-flows.md`. No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json` (no dependency changes), `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, barrel/index files, or generated outputs.
- The module's only import is a type-only import of `RemoteActionResult` from `src/actions/types.ts` (erased at runtime); the test suite additionally imports `serializeActionResult` to prove the wire-level integration. No runtime coupling to action handlers.

## Risk class

**R1** — documentation plus isolated, additive module with focused tests. The machines hold no authority, persist nothing, execute nothing, and infer no runtime state; all validation remains host-side by construction. The future integration (sheet UI driving real merge/PR actions) is R2/R3 and carries its own review and evidence bars.

## Exact commands and results

All commands run from `/home/node/trees/issue-219` (Node v24, pnpm 10.34.5, TypeScript 7.0.2, vitest 4.1.10):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | OK — lockfile respected, "Done in 744ms" |
| `npx pnpm exec vitest --run __tests__/mergePrFlowMachines.test.ts` | OK — `Test Files 1 passed (1)`, `Tests 53 passed (53)` |
| `npx pnpm exec tsc --noEmit` | OK — exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | OK — exit 0, no output |
| `git diff --check` | OK — exit 0, no output |
| `npx pnpm run docs:focus:check` | OK — "Passed 81/81 public documentation source files." |

Iteration notes: (1) the first reducer classified a `user_choice` response on a *confirm* sheet as `option_not_authorized`; a test caught it and the guard-rejection classification was made surface-aware (now `event_not_applicable` unless a choice sheet is actually open), with the same fix pattern applied to review file/submit reasons. (2) The generic engine could not narrow state variants for classification; `FlowStateShape` gained optional `sheet`/`review` fields so the engine reads the open surface without casts. All 53 tests pass after each fix.

## Exact head SHA

- Deliverable content commit (module, tests, contract document; all verification above ran against this tree): `59d310e2735b0ea43014a225877d135b4a8b7b0e`.
- The final pushed branch head adds only this working-record commit on top; the exact head SHA is reported in the PR body and status comment (authored after the last commit — a commit cannot contain its own hash) and is visible via `gh pr view` on the fork.

## Test counts

- New focused suite: 53 tests, 53 passed, 0 failed (`__tests__/mergePrFlowMachines.test.ts`).
- Full repository suite and `agent-check`: **not run here** — see proof gaps.

## Proof gaps

- **No sheet UI integration.** This slice ships contracts and machines only; rendering the sheets, gestures, and a11y are the mobile delivery track's remaining work. No user-path evidence is claimed — unit tests do not prove a user path works.
- **No local iOS/Xcode proof.** No Xcode/iOS tooling on this host; no simulator, device, or TestFlight evidence exists or is claimed.
- **No local tmux; `scripts/agent-bootstrap` and `scripts/agent-check` not run** (runbook: they require tmux, unavailable here).
- **No live-host evidence.** The machines are exercised against serialized action results in tests, not against a live daemon/bridge session; no merge or PR was actually executed from a mobile client.
- **Full repository vitest suite not run locally**; the fork's CI Quality gate runs it on the PR.
- **Beads source not directly queried**; acceptance criteria were transcribed from the generated GitHub mirror body (#219, read 2026-08-30).
- Issue/bead status remains `blocked` (blocked by #218 per the Beads dependency record); this PR delivers the foundational contract slice and does not unblock the parent by itself.

## Rollback notes

- Revert the PR (or the two commits) to remove all four files; no generated artifacts, dependencies, shared configs, or other agents' paths are touched, so rollback is clean and complete.
- The module is additive and unreferenced by product code (type-only import direction: this module imports from `src/actions/types.ts`; nothing imports the module), so deletion cannot affect runtime behavior.

## Security and privacy

- No credentials, tokens, private keys, raw prompts, unrestricted terminal output, private repo contents, environment dumps, private URLs, or unredacted personal paths are included in any file, PR, or comment. Test fixtures use synthetic pane ids, synthetic URLs (`https://github.example/pull/42`), and synthetic file paths.
- The contract fail-closes on unclassifiable host results and on paths/option ids the host did not authorize; the unknown-event rejection tests use bogus synthetic events only.
