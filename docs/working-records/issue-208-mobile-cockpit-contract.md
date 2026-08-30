# Working record — issue-208-mobile-cockpit-contract

- Issue: [OpenCoven/psyche-build#208](https://github.com/OpenCoven/psyche-build/issues/208) — `[psyche-i7c] Mobile multiproject and multipane cockpit` (Beads `psyche-i7c`, P1 epic, `in_progress`)
- Branch: `psyche/issue-208-mobile-cockpit-contract` (fork: `CompleteDotTech/psyche-build`)
- Deliverable commit: `17980247aaa753bb7df0c14e785fa2e66678336e` (branch head at verification time; the working record below is added in the immediately following commit on the same branch — the PR head SHA at review time is the authoritative exact head)
- Date: 2026-08-30
- Status: complete (contract/charter slice)

## Outcome

Delivered the epic charter and the Now-inbox ranking/snapshot schema seam for Bead `psyche-i7c` (#208):

1. **`docs/mobile/COCKPIT-EPIC-CHARTER.md`** — epic charter: objective (universal iPhone/iPad cockpit opening into a cross-project Now inbox, adaptive one/two-pane terminal workspaces, complete pane lifecycle via paired host), four architecture invariants (protocol-v3 typed control envelopes over the paired TLS/Bonjour bridge; one canonical multiproject workspace snapshot to the Swift `WorkspaceStore`; at most two attached terminal streams; reuse existing host file/action/lifecycle logic), constraints (protocol-v2 compatibility, self-signed certificate pinning, published-workspace-resource scope, visibly stale offline state, iPhone + iPad validation, baseline discipline, no Psyche conformance claims), success-criteria mapping to phases (open mirrors #209/#210–#215, #217/#218–#221, #216; phases 1–8 closed history with Beads authoritative), and canonical outcome gh-200.
2. **`src/mobile/nowInboxRanking.ts`** — versioned v1 pure TS module (`NOW_INBOX_RANKING_VERSION = 1`):
   - typed projection `projectNowInboxEntries()` of the canonical `ReadonlyWorkspaceSnapshot` (type-only import from `src/workspace/snapshot.ts` — zero runtime coupling) plus `nowInboxBucketOf()`;
   - `rankNowInbox()` — deterministic ranking (Needs You → Running → Recent; recency desc within bucket with unknown timestamps last; project id → worktree path → pane id code-unit tie-breakers), bounded by `NOW_INBOX_ENTRY_LIMIT` (256) with clamped `limit` option, pre-truncation `bucketCounts`, and `truncated` flag;
   - `validateWorkspaceSnapshot()` — strict fail-closed validator: unknown fields rejected (even when `undefined`), required fields/types/enums enforced, canonical Z-form ISO-8601 `lastActivity` enforced, bounded arrays/strings (`MAX_WORKSPACE_PROJECTS`/`MAX_WORKTREES_PER_PROJECT`/`MAX_PANES_PER_CONTAINER`/`MAX_WORKSPACE_PANES_TOTAL`/`WORKSPACE_STRING_LIMITS`) checked before enumeration.
3. **`__tests__/nowInboxRanking.test.ts`** — 25 tests: bucket assignment, projection, ordering, determinism (equal input → deep-equal output incl. array-order permutation), bounds/truncation/limit-clamping/malformed-limit rejection, and validator accept/reject cases (including the canonical `WORKSPACE_SNAPSHOT_FIXTURE`).

## Scope and boundaries

- **In scope (additive only):** the three files above. No existing file was modified; `git status` shows only the new files.
- **Not done (owned by others):** No Now-inbox UI, pairing, Bonjour wiring (#216), terminal-stream attach/detach, lifecycle actions (#217/#218–#221), workspace cache (#210), stale/live reconciliation (#211), a11y (#212), performance/matrix (#213), docs updates (#214), or review/handoff (#215). Phase 10's plan/gate module (`src/mobile/phase10Gate.ts`) exists on the #209 branch, not here — no file collision.
- **Not done:** changes to `.github/**`, `.beads/**`, generated outputs, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, `index.ts`/barrels, or any existing source file.
- **Deliberate seam decision:** the module imports the canonical snapshot types from `src/workspace/snapshot.ts` via `import type` (erased at runtime — the module stays I/O-free) rather than duplicating the snapshot shape; `NOW_INBOX_RUNNING_STATUSES` mirrors the host's private `isRunning()` list with a provenance comment, because `snapshot.ts` intentionally stays free of mobile-side dependencies.
- **Known limitations of the validator (by design):** shape/type/bounds only — it does not reject duplicate pane ids or semantically inconsistent snapshots, because the canonical snapshot builder owns identity semantics; the ranking is insensitive to duplicates.

## Risk class

- [ ] R1 — documentation or isolated tests
- [x] **R1/R2 boundary — closest fit: R1.** Additive, pure, I/O-free contract module + tests + a charter document. No product behavior, protocol, security, or authority surface changes; no consumer code was modified. Bridge/protocol surfaces were read for terminology only.
- [ ] R2 / [ ] R3 / [ ] R4 — not applicable to this slice.

## Exact commands and observed results

Run from `/home/node/trees/issue-208` (branch `psyche/issue-208-mobile-cockpit-contract`, base `origin/main` @ `a4546f4`):

| Command | Observed result |
|---|---|
| `npx pnpm install --frozen-lockfile` | `Done in 470ms using pnpm v10.34.5` (exit 0) |
| `npx pnpm exec vitest --run __tests__/nowInboxRanking.test.ts` | `Tests 25 passed (25)` — first green after fixes; intermediate failures were test-authoring defects (missing brace, wrong fixture-project id expectations) and one real module bug: the total-pane-count accumulator was scoped inside the per-project loop (fixed by hoisting; covered by the new bound test) |
| `npx pnpm exec vitest --run __tests__/nowInboxRanking.test.ts __tests__/bridge/mobileControlGateway.test.ts __tests__/bridge/mobileControlProtocol.test.ts` | `Test Files 3 passed (3)`, `Tests 77 passed (77)` (adjacent suites unaffected by the additive module) |
| `npx pnpm exec tsc --noEmit` | exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | exit 0, no output |
| `git diff --check` | clean (exit 0) |

Known-baseline note: per the epic's implementation notes, the full Vitest suite has three pre-existing unrelated environment failures (pnpm version drift; two releaseWorkflow checks assuming BSD stat). Not reproduced here because per the runbook `scripts/agent-check`/bootstrap are not run on this host; not fixed here (out of slice).

## Test counts

- New tests: 25 passed, 0 failed (`__tests__/nowInboxRanking.test.ts`).
- Adjacent suites run with the new file: 77 passed, 0 failed across 3 files.

## Proof gaps

- **No iOS/Swift proof on this host:** no Xcode/iOS tooling, no simulator, no `native/ios` build or PsycheCore test run. The Swift `WorkspaceStore` consumes the same canonical snapshot; the equivalence of this TypeScript contract with the Swift side is a design claim from the shared canonical shape, not runtime-verified here.
- **No tmux, no Rust/cargo, no sudo** on this host: no tmux behavior, Rust, or paired-host live-path evidence; not applicable to this pure-TS slice.
- **Full repository source gate not run** (`scripts/agent-check` requires tmux); verification is the targeted commands above. CI on the fork supplies Linux runner evidence.
- **The ranking is not yet consumed by any UI or bridge code.** Wiring into the Swift `WorkspaceStore`/Now inbox UI belongs to the phase children; this slice ships the contract + tests only.
- **CI evidence:** recorded in the PR thread (fork Quality + change-classified checks) once terminal; not pre-claimable here.

## Rollback notes

- The slice is three new files; rollback = revert the single deliverable commit `17980247aaa753bb7df0c14e785fa2e66678336e` (plus this record's commit). No generated outputs, lockfiles, dependencies, workflows, or existing sources are touched, so a straight revert restores the prior tree exactly.
- No migrations, persisted formats, or wire messages changed; nothing to backfill.

## Security and privacy

- No credentials, tokens, certificate material, raw prompts, unrestricted terminal output, private repo contents, environment dumps, private URLs, or unredacted personal paths appear in any deliverable. Fixtures use synthetic ids/paths (`/repo`, `%3`).
- The validator fails closed on unknown fields and oversized payloads, consistent with the repo's bounded-state discipline.
