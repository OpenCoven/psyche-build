# Issue #195 roadmap control-state verification record

**Date:** 2026-08-30
**Scope:** Verification-only status/decision record for
[OpenCoven/psyche-build#195](https://github.com/OpenCoven/psyche-build/issues/195)
("Maintain the authoritative Psyche Build roadmap and post-release control
state"). No behavior, support claim, or tracker state is changed by this file.
**Classification:** `reference` under
[docs/superpowers/README.md](../README.md). Live status authority remains the
owning issue, [docs/ROADMAP.md](../../ROADMAP.md), and open PR #282.

**Method:** Read-only REST verification (`gh api`, `gh pr checks`) on
2026-08-30 ~15:26Z against upstream `main` at
`32872639eed9f9f80f361019637fa316da33c12b` plus a local checkout of that head.
No GraphQL. The verifying token (`CompleteDotTech`) has no upstream write
access; branch-protection reads return HTTP 403, so protection state relies on
maintainer evidence linked below.

## What exists on main today (2026-08-30)

- Head `32872639eed9f9f80f361019637fa316da33c12b` ("fix: slim desktop command
  composer (#302)"). Since the issue's 2026-08-24 reconciliation base
  (`e8ce010`), main has absorbed the v0.0.2 release-prep train
  (merge `a4546f4`, "release/v0.0.2"), the contributor-readiness wave
  (#269–#273, #270/#271/#272/#273 landed), the frozen Psyche compatibility map
  (#262), and the desktop/mobile contract slices merged as PRs #274–#302.
- Release truth: `v0.0.1` macOS remains the latest supported public release
  (source `57c6c71bd5264fde960b062e95de278c8438c94f`, protected run
  [32629730508](https://github.com/OpenCoven/psyche-build/actions/runs/32629730508),
  published 2026-08-23). Repository metadata is `0.0.2`
  (`package.json`, `CHANGELOG.md` entry `## [0.0.2] - 2026-08-28`), and the
  2026-08-30 reconciliation (issue comment by @BunsDev at 11:01:55Z; PR #282
  body) records `0.0.2` as an **unreleased candidate**, not a publication
  event.
- Canonical control docs on main: `docs/ROADMAP.md` (last reconciled
  2026-08-28), `docs/POST-RELEASE-EXECUTION.md`, `docs/SUPPORT-MATRIX.md`
  (macOS **Supported**, npm **Unavailable**, iOS **Planned**), and
  `docs/superpowers/README.md` (blanket `reference` classification of all
  dated records, dated 2026-08-28).
- The `releaseDocs.test.ts` contract that the issue body flagged as stale
  (expecting #203 to remain open) no longer exists: line 470 now asserts the
  #194/#203 closed-state wording, and `docs/superpowers/plans/**` and
  `docs/superpowers/specs/**` are excluded from the active-documentation scan
  entirely.

## Issue/PR state observed on 2026-08-30 (REST)

Closed since the 2026-08-24 snapshot: #202, #203, #204, #234, #235 (2026-08-23);
#238 (2026-08-25, delivered by PR
[#245](https://github.com/OpenCoven/psyche-build/pull/245), merge commit
`5f4b7b05579e98cd283cb2d1c43a48d49330b4b5`, confirmed in main history);
PR #236 closed as superseded (2026-08-25); #240 (2026-08-28); #244
(2026-08-28); #237 (2026-08-29); #31 (2026-08-30). Source-material PRs
#190, #192, #193, #254, and #262 were closed 2026-08-28 and are retained as
source material by the roadmap disposition table.

Still open (12 outcomes): #196, #197, #198, #199, #200, #201, #239, #241,
#242, #243, #246, #253. Open PRs at verification: 32, including the canonical
reconciliation PR
[#282](https://github.com/OpenCoven/psyche-build/pull/282)
(`docs/reconcile-portfolio-2026-08-30`, non-draft), #278 (support bundle v1
contract) and #281 (stress harness) — both changes-requested per the 2026-08-30
addendum — #277/#264 design/draft iOS material, and the `agent/issue-*` draft
PRs #309–#312 from parallel sweeps (#199, #253, #198, #197).

CI facts on the verified head: `main` at `3287263` has 13 check-runs — 12
success/skipped and one failure, **"Sync public Beads Project"**. PR #282 is
currently red ("Clean checkout contributor loop", "Quality", and
"TypeScript and Rust" failing, runs 33316690127/33316690139), so the
in-flight reconciliation does not yet pass canonical current-head CI.

## Verdict against the issue's close criteria

| # | Close criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | #31 governance enforcement complete | **Not met (evidenced gap)** | #31 was closed 2026-08-30, but PR #282 records that live branch protection still reports required checks with `enforcement_level: non_admins` — the standing admin bypass is uncorrected. Independent verification with this token is impossible (branch-protection GET → HTTP 403). |
| 2 | #237 Beads/mirror reconciliation and repeatable drift checks | **Met** | #237 closed completed 2026-08-29; #263 merged the bounded source↔mirror validator; #240 (drift validation) closed 2026-08-28; per the 2026-08-29 comment, zero open generated issues carry `priority:P0`. |
| 3 | #236 public documentation reconciliation merged and current | **Met via successor vehicle, currency in flight** | PR #236 was closed as superseded by merged PR #245 (`5f4b7b05`, 2026-08-25). Docs current through the 2026-08-28 `docs/ROADMAP.md` reconciliation; PR #282 is the open controlled change reconciling to 2026-08-30 live state (v0.0.2 as unreleased candidate, #31 correction). |
| 4 | Every active outcome and open PR maps to exactly one train/owner/gate | **Met structurally** | `docs/ROADMAP.md` portfolio table (2026-08-28) covers all 12 open outcomes with priority/train/close condition; #282 refreshes dispositions (#281/#278 changes-requested, #277 under #279, #264 under #280). |
| 5 | Every historical plan classified active/implemented/superseded/reference | **Met** | `docs/superpowers/README.md` classifies every file under `docs/superpowers/plans/**` and `specs/**` as `reference` as of 2026-08-28; #273 completed the classification policy. |
| 6 | Successor roadmap-control mechanism explicit | **Met structurally** | `docs/ROADMAP.md` + `docs/POST-RELEASE-EXECUTION.md` + #195 as portfolio control with explicit maintenance rules ("Update #195 in the same controlled state transition"); the mechanism is being exercised by PR #282. |

**Overall verdict:** #195 is **substantially satisfied but not closeable**.
Five of six close criteria are met by delivered, evidenced work on main; the
remaining gap is criterion 1 — #31's live enforcement is contradicted by the
`non_admins` protection finding recorded in PR #282, and the reconciliation
PR that repairs the snapshot is itself not yet green.

## What remains and critical path

1. **Land PR #282** (the 2026-08-30 portfolio reconciliation). It is the
   roadmap-state transition #195's maintenance rules require, and it currently
   fails required checks ("Clean checkout contributor loop", "Quality",
   "TypeScript and Rust").
2. **Prove #31 enforcement for real**: first apply of the protection policy,
   sanitized policy evidence, and direct-push rejection proof, replacing the
   `non_admins` finding; until then ROADMAP wording must not claim #31
   delivered.
3. **#196/#239** remain the active P0 stabilization gate (both open).
4. Downstream trains per roadmap: #199/#243 (PRs #281/#278),
   #200 via #241→#242 (design PR #277, draft #264), #197 (PR #312), #198
   evidence (PR #311), #253 (PR #310), #246, #201.
5. Watch item: the "Sync public Beads Project" check failure on main head
   `3287263` — tracker-sync health signal owned by the #237/#240 successor
   contract.

## Limitations of this verification

- Branch protection could not be read directly (HTTP 403 for this fine-grained
  PAT); the `non_admins` finding is taken from PR #282's maintainer evidence
  and issue commentary, not independently verified.
- PR-check conclusions for #282 were read via `gh pr checks` (REST) at
  ~15:30Z on 2026-08-30; conclusions may have advanced since.
- This record adds no support claim, closure, or priority change; it documents
  state only. #195 should remain open until criterion 1 carries durable,
  sanitized enforcement evidence and the reconciliation lands.
