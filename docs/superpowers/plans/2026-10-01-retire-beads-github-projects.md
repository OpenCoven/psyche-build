# Retire Beads; manage work in GitHub Issues and Projects

**Status:** Proposed; awaiting owner approval (@BunsDev). This is an R4 change: governance, generated-source ownership and managed GitHub mutations.  
**Observed:** 2026-10-01 against `main` `c32dae7414ad9d5d4ee37bac0c9302c24bf1e6c1`  
**Companion plan:** [Production readiness](./2026-10-01-production-readiness.md)

This record is classified `reference` under the [dated-record policy](../README.md)
until an owning GitHub outcome promotes it. Every step that changes GitHub,
secrets, environments or remote refs is an external side effect. Each needs its
own explicit authorization when it runs.

## 1. Why retire Beads

Beads is the authoritative planning store. GitHub Project #11 is a one-way,
generated mirror of it. Running that pair has cost more than it has returned.

- **Two incidents in one month.** The first was a schema migration from an off-pin CLI that broke every scheduled sync for three days and left a bounded three-write audit gap (#342). The second was 24 duplicate mirror pairs that needed a manifest-driven recovery (#420).
- **A standing hazard in PR prose.** A closing keyword before a mirror number changes the tracker outside the synchronizer. This happened with #230 and PR #346, and it reopened #196 after PR #350.
- **A fleet rule nobody can enforce locally.** Every clone must run Beads CLI 1.2.2. This machine already has **1.3.0** installed through Homebrew, and one command from it can re-migrate the shared Dolt schema.
- **About 31k lines of synchronizer, validator and test code** (~17.6k in `scripts/beads-project-sync/`, plus ~13.5k of dedicated tests) to keep the mirror honest.
- **A mirror that has already drifted from the portfolio.** Two of the three canonical targets (#199, #246) are closed. The Project README is a 2026-09-11 snapshot. None of the nine hand-written outcomes are on the board.
- **It solves a problem GitHub now covers natively.** Sub-issues, `blocked by` / `blocking` dependencies, org issue types and Project fields together cover what Beads was used for here: task hierarchy, dependency ordering, priority and status.

## 2. Inventory on 2026-10-01

| Surface | State |
|---|---|
| Beads | 111 Beads. Of those, 14 are active and all 14 have a GitHub mirror. About 84 are closed and were never mirrored. The audit trail is ~1,362 `events` rows plus `.beads/interactions.jsonl` (114 rows). |
| Mirrors | 51 issues carry `<!-- psyche-bead-sync:v1 bead-id=… -->`. Of those, 14 are open, 13 closed as completed, and 24 closed as not planned (the #420 aliases). |
| Open mirrors | #208, #209, #213, #215, #216 (iOS family); #222–#227 (Vim family); #228, #229, #232 (GPU family) |
| Open hand-written outcomes | #200, #201, #239, #241, #242, #253, #279, #280, #435. None of them are on Project #11. |
| Project #11 | Titled "Psyche Build: Goals & Implementation". It has synchronizer-owned fields (`Bead ID`, `Bead Type`, `Parent Goal`, `Source Updated`), plus Status and Priority. It has generated views and a generated README. Built-in workflows: only "Auto-add sub-issues" is enabled. |
| Org issue types | Task, Bug and Feature are enabled. No Epic type exists. |
| Labels | `bead`, `bead:epic`, `bead:feature`, `bead:task`, `priority:P0`–`P4`, `status:blocked` |
| Automation | `.github/workflows/beads-project-sync.yml` runs at 03:17 and 09:43 UTC, plus manual dispatch. It uses the `BEADS_PROJECT_TOKEN` secret and the `beads-project-sync-automation` and `beads-project-sync` environments. |
| Repository code | `scripts/beads-project-sync/**`, `scripts/sync-beads-project.mjs`, `scripts/validate-beads-tracker.mjs`, `scripts/verify-beads-graphql-e2e.mjs`, `tsconfig.beads-project-sync.json`, `vitest.beads-render.config.ts`, and `.github/beads-project-sync.json` |
| Tests | Dedicated: `__tests__/beadsProject{Cli,Github,GraphqlE2e,Model,Outcomes,Reconcile,Recovery,Render}.test.ts`, `__tests__/trackerDriftValidation.test.ts`, and `__tests__/fixtures/beads-project-sync/**`. Contract tests that reference Beads: `agentRepositoryContract`, `ciWorkflow`, `postReleaseExecutionDocs`, `repositoryMapContract`, `communityHealthContract`, `psycheCompatibilityMap`, `resumeBranches` |
| Product code | `src/utils/resumeBranches.ts` hides the `psyche-beads-project-sync-lock` branch from branch discovery. |
| Wiring | `package.json` (`typecheck` chains `typecheck:beads-project-sync`; `beads:project:*` scripts; the `test` script excludes the render suite), `.github/CODEOWNERS` (`/.beads/`, `/scripts/beads-project-sync/`), `agent/manifest.yaml` (Beads authority, a canonical doc entry, protected paths) |
| Docs | Policy appears in `AGENTS.md`, `CONTRIBUTING.md`, `docs/TRACKER-INTEGRITY.md`, `docs/ROADMAP.md`, `docs/POST-RELEASE-EXECUTION.md`, `docs/REPOSITORY-MAP.md`, `.github/pull_request_template.md` and `README.md`. Incidental mentions appear in about 10 other current docs. Dated `docs/superpowers/**` records are history and stay untouched. |
| Remote refs | `refs/dolt/data`, `refs/heads/__dolt_remote_info__`, `refs/heads/psyche-beads-project-sync-lock`, `refs/heads/feature/beads-duplicate-reconciliation-420` |
| Local residue | Untracked `.beads.gate.lock` at the repository root; `git config beads.role`. The Beads git hooks in `.beads/hooks/` are **not** installed (`core.hooksPath` is the default). |

## 3. Target operating model

GitHub is the only tracker. There is no generator, no mirror and no second
store.

### 3.1 Hierarchy

| Level | GitHub construct | Issue type | Rule |
|---|---|---|---|
| Outcome | Parent issue | **Feature**, with an `outcome` label. Ask an org owner to add an **Epic** type if a distinct type is wanted. | Owns the exit gate, the evidence index, the train and the priority. It closes only with an evidence comment (§3.5). |
| Work item | Sub-issue of exactly one outcome | **Task** or **Bug** | One reviewable PR slice, or a small set of them. |
| Ordering | `blocked by` / `blocking` issue dependencies | — | Replaces Beads dependencies. Use it only where order is real, not to restate the hierarchy. |
| Release grouping | Milestone | — | Milestones group work by release. They are not priority. |

### 3.2 Project #11 (the single portfolio board)

Rename it **"Psyche Build"** and give it a hand-written README. The README covers:
the board's purpose, field meanings, the weekly cadence, and links to ROADMAP and
`docs/TRACKER.md`.

| Field | Type | Values | Replaces |
|---|---|---|---|
| Status | Single select | Triage, Backlog, Ready, In Progress, In Review, Blocked, Done | The generated Status |
| Priority | Single select | P0, P1, P2 | `priority:P*` labels and the Beads priority. P3 and P4 are unused by the roadmap; drop them. |
| Train | Single select | macOS rollout, Reliability, Release, Governance, iOS, OpenCoven, Docs | The roadmap "Train" column, which lived only in docs |
| Risk | Single select | R1, R2, R3, R4 | The AGENTS.md risk tier, previously never recorded on items |
| Evidence | Text | A URL to the evidence comment or manifest | The "owning issue links evidence" rule, made visible |
| Milestone, Assignees, Parent issue, Sub-issue progress, Linked PRs | Built-in | — | `Parent Goal`, `Bead ID`, `Bead Type` and `Source Updated` are deleted. |

**Views:**

1. **Portfolio**: a table of outcomes only (`label:outcome`), grouped by Train, sorted by Priority.
2. **Board**: a board by Status, excluding Done.
3. **Current milestone**: a table filtered to the active release milestone.
4. **Blocked**: `status:Blocked` or `is:blocked`.
5. **Triage**: Status = Triage. This is the weekly intake queue.
6. **Needs evidence**: closed outcomes with an empty Evidence field. This view should always be empty.

**Built-in workflows:** enable these in the Project → Workflows UI. They are not
all reachable through the API.

- *Auto-add to project*: repository `OpenCoven/psyche-build`, filter `is:issue,pr is:open`
- *Item added to project* → Status = Triage
- *Item closed* → Done
- *Pull request merged* → Done
- *Item reopened* → In Progress
- *Auto-archive items*: `is:closed updated:<@today-30d`
- Keep *Auto-add sub-issues* enabled.

### 3.3 Labels

- **Delete** after M3: `bead`, `bead:epic`, `bead:feature`, `bead:task`, `priority:P0`–`P4`, `status:blocked`. The Project fields and dependencies replace them.
- **Add:**
  - `outcome`
  - `needs-triage`, applied by the issue forms
  - `area:desktop`, `area:tui`, `area:ios`, `area:release`, `area:recovery`, `area:security`, `area:docs`, `area:tracker`
- **Keep:** the GitHub defaults that are in use (`bug`, `documentation`, `good first issue`, `help wanted`, `duplicate`, `invalid`, `wontfix`, `question`). Decide whether the tool tags `aardvark` and `codex` are still wanted.

### 3.4 Intake

- The existing forms (`bug.yml`, `feature.yml`, `documentation.yml`) gain `labels: [needs-triage]`, a `type:` key (Bug, Feature or Task), and `projects: ["OpenCoven/11"]`. Verify both keys against the current issue-forms syntax when implementing.
- **Add `outcome.yml`, for maintainers only.** It has these fields: outcome, exit gate, evidence required, train, risk, priority, owner, and out of scope. It applies the `outcome` label.
- **Agents create issues with `gh issue create --project "Psyche Build"`,** then set fields with `gh project item-edit`. They attach a sub-issue with `gh api` (`POST /repos/{owner}/{repo}/issues/{n}/sub_issues`) and a dependency with the issue-dependencies API.

### 3.5 Closure and evidence rule

This rule carries forward the part of the Beads era that worked.

- **Outcome issues** close only by hand, with a closing comment that links retained evidence tied to immutable source. The same change sets the Evidence field. A PR that touches an outcome uses `Refs #N`, never a closing keyword. This prevents a repeat of PR #350's keyword closure of #196, and of the 2026-09-16 closures without an evidence comment.
- **Task and bug issues** may close through `Fixes #N` in the implementing PR.

### 3.6 Cadence

The weekly reconciliation in [ROADMAP § Standing roadmap control](../../ROADMAP.md#standing-roadmap-control) stays. Its inputs change from "scheduled sync report plus drift validator" to:

1. empty the Triage view;
2. confirm that the Needs evidence and Blocked views are accurate;
3. reconcile ROADMAP and POST-RELEASE-EXECUTION against the Portfolio view in one protected PR;
4. record the observation date and source SHA.

An optional read-only `scripts/tracker-audit.mjs` (built on `gh`, with no mutations) can report:

- open issues that are not on the Project;
- outcomes with no Priority, Train or Risk;
- closed outcomes without Evidence;
- sub-issues whose parent is closed.

It stays local. It needs no new secret and no scheduled job.

## 4. Migration phases

Run the phases in order. M0 through M4 involve no repository code change, so
Beads stays fully recoverable until M5 merges.

### M0 — Decide and freeze (day 0)

1. The owner approves this plan.
2. Create the outcome issue "Retire Beads; GitHub Issues and Projects are the tracker" (P0, Governance, R4).
3. Announce a **Beads write freeze**: no `bd` writes from any clone or agent after the freeze time T0, recorded on the outcome issue. Add a temporary note at the top of `.beads/README.md` in the M5 PR, or comment on the outcome before it.
4. Confirm that no other session is mid-`bd` operation. Run `ps -ef | grep -E ' bd |claude --'` on every machine that holds a clone.

### M1 — Archive (day 0–1)

The archive is the only copy of the ~84 never-mirrored Beads and of the audit
journal. Build it without risking the schema.

1. **In a fresh, disposable clone,** not the shared checkout or any existing worktree, install the **pinned Beads CLI 1.2.2** by checksum, exactly as `.github/workflows/beads-project-sync.yml` does. Never run the Homebrew 1.3.0 `bd` against this database.
2. `bd --readonly export` writes the full JSONL. Also export the Dolt `events` table and copy `.beads/interactions.jsonl`.
3. Record the SHA-256 of each file, the Dolt commit hash and the count (111).
4. Store the raw archive **privately**: an org-private repository, or an owner-held encrypted location. The raw export can hold unsanitized descriptions, so it must never go in a public issue, PR or release.
5. Commit a public **sanitized summary** at `docs/working-records/beads-retirement-2026-10.md` with:
   - counts by status and type;
   - the archive digests;
   - the Dolt commit;
   - the never-mirrored count;
   - the private archive location by name only;
   - a statement that the four remote refs are retained until M7.

**Verify:** re-import the archive into a scratch Beads database with 1.2.2, and confirm the count and a sample of IDs match.

### M2 — Stop the writer (day 1)

1. Run a final `workflow_dispatch` of Beads Project Sync with `dry_run: true`. Retain the plan output (it should show zero operations) and run `node scripts/validate-beads-tracker.mjs` (it should report zero findings). These are the last Beads-era evidence, recorded on the outcome issue.
2. Disable the scheduled workflow: `gh workflow disable beads-project-sync.yml`. This is an external side effect. **It must happen before any manual edit to a mirror**, or the next 03:17 or 09:43 UTC run reverts the edit.
3. **Verify:** `gh workflow view beads-project-sync.yml` shows `disabled_manually`, and no run starts at the next scheduled time.

### M3 — Triage and adopt the 14 open mirrors (days 1–3)

Triage before adopting, so stale work is not imported. Proposed dispositions:

| Mirrors | Proposed disposition |
|---|---|
| #222–#227 (Vim family) | **Close as not planned.** Each gets a comment linking #246's 2026-09-16 decision. |
| #228, #229, #232 (GPU family, parent #199 closed) | Re-parent under the "Support bundle production surface" outcome as sub-issues, **or** close #228 and #229 as not planned and keep #232 (the verification matrix) as a Task. This is the owner's decision. |
| #208, #209, #213, #215, #216 (iOS family) | Re-parent under #200 as sub-issues. Keep them open in the paused iOS train with Priority P1 and Train iOS. |

For every mirror that stays open, make one edit:

1. Replace the body with the human-maintained content. Keep `Goal`, `Description`, `Acceptance criteria`, `Implementation notes` and `Dependencies`. Remove the `<!-- psyche-bead-sync:v1 … -->` marker and render-hash lines, the `## Bead`, `## Labels` and `## Source metadata` sections, and the `## Authority notice`. Add one line: `Legacy Bead ID: psyche-…`, which preserves traceability to the archive.
2. Remove the `[psyche-…]` prefix from the title.
3. Remove all `bead*`, `priority:*` and `status:blocked` labels. Set the Issue type, plus the Project fields Priority, Train, Risk and Status.
4. Recreate the real ordering with `blocked by` dependencies. Attach each one to its parent outcome as a sub-issue.

Do this for at most 14 issues with reviewed `gh` commands, or with a one-shot
script that defaults to dry-run and is run once. Retain the before and after
issue bodies in the private archive.

**Leave the 37 closed mirrors untouched.** Their markers are historical, and
editing them would only add edit history.

### M4 — Reshape Project #11 (days 2–4)

1. Add the open hand-written outcomes: #200, #201, #239, #241, #242, #253, #279, #280 and #435. Add the new outcomes from the [production-readiness plan](./2026-10-01-production-readiness.md#4-proposed-github-structure-for-this-plan) once they are approved.
2. Create the fields Train, Risk and Evidence. Change Status to the §3.2 values. Trim Priority to P0–P2. Back-fill every item.
3. Delete the fields `Bead ID`, `Bead Type`, `Parent Goal` and `Source Updated`.
4. Replace the generated views with the §3.2 views. Delete the stray default view, "View 1".
5. Rewrite the README by hand, and rename the Project to "Psyche Build".
6. Enable the §3.2 built-in workflows.
7. Delete the labels listed in §3.3 and create the new ones. Do this only after M3 has removed them from every open issue.
8. **Verify:**
   - `gh project item-list 11 --owner OpenCoven` contains every open issue in the repository;
   - every outcome has Priority, Train, Risk and Status set;
   - a throwaway test issue auto-adds into Triage, then closes into Done, then gets deleted.

### M5 — Policy and documentation flip (one R4 PR)

This PR makes GitHub authoritative in the repository's own contracts.

| File | Change |
|---|---|
| `docs/TRACKER.md` (new) | The §3 operating model. It becomes the canonical tracker contract. |
| `docs/TRACKER-INTEGRITY.md` | Replace it with a short tombstone that points to `docs/TRACKER.md`, the M1 working record and §3.6. Keep the file one release cycle for inbound links, then delete it. |
| `AGENTS.md` | Planning table: the Beads row becomes "GitHub Projects + sub-issues". Delete "Beads is source-of-truth for generated mirror issues…". Change the canonical-routing link from `.beads/README.md` to `docs/TRACKER.md`. In the R3/R4 list, swap `.beads/**` for "Project #11 configuration and tracker automation". |
| `CONTRIBUTING.md` | Replace "Beads planning and public Project" (token, environments, sole migrator) with intake, triage and closure rules. Update the roadmap-control procedure. |
| `docs/ROADMAP.md`, `docs/POST-RELEASE-EXECUTION.md` | The authority tables replace Beads with sub-issues. The control-evidence paragraphs that cite the sync and validator stay as dated history, under a "Beads era (to 2026-10)" note. Standing control inputs follow §3.6. |
| `docs/REPOSITORY-MAP.md`, `README.md`, `.github/pull_request_template.md` | Remove the Beads references. The PR template asks for `Refs #outcome` and lists the closure rule. |
| `agent/manifest.yaml` | Remove `authoritative_for_generated_mirrors`, the `.beads/README.md` canonical doc entry, the `.beads/**` and `scripts/beads-project-sync/**` protected paths, and the Beads `never` rule. Add `docs/TRACKER.md`. |
| `.github/ISSUE_TEMPLATE/*` | Apply the §3.4 changes and add `outcome.yml`. |
| Contract tests | Update `agentRepositoryContract`, `postReleaseExecutionDocs`, `repositoryMapContract`, `communityHealthContract` and `psycheCompatibilityMap` to assert the new docs. |
| `CHANGELOG.md` | One entry: "Planning moved from Beads to GitHub Issues and Projects." |

Run `bash ./scripts/agent-check full` and record the exact-head checks. Do not
use closing keywords before mirror numbers in this PR, as a final courtesy to
the rule being retired.

### M6 — Remove the code (one R4 PR, after M5 merges)

Delete:

- `.github/workflows/beads-project-sync.yml`
- `.github/beads-project-sync.json`
- `scripts/beads-project-sync/**`, `scripts/sync-beads-project.mjs`, `scripts/validate-beads-tracker.mjs` and `scripts/verify-beads-graphql-e2e.mjs`
- `tsconfig.beads-project-sync.json` and `vitest.beads-render.config.ts`
- the eight `beadsProject*.test.ts` files, `trackerDriftValidation.test.ts` and `__tests__/fixtures/beads-project-sync/**`
- `.beads/` in full. The M1 archive and working record are the history.

Edit:

- `package.json`: remove `typecheck:beads-project-sync` from the `typecheck` chain, remove the `beads:project:*` scripts, and remove the render-suite exclusion and its second vitest run from `test`.
- `ciWorkflow.test.ts`: remove the Beads workflow contract (from `:284`).
- `.github/CODEOWNERS`: remove the two Beads lines.

**Keep** the lock-branch exclusion in `src/utils/resumeBranches.ts` until M7
deletes that ref. Run `bash ./scripts/agent-check full`. The test count and
`typecheck` time will both drop. Record both as expected.

### M7 — External cleanup and verification (≥14 days after M6)

Each item is a separate, explicitly authorized side effect:

1. Delete the `BEADS_PROJECT_TOKEN` secret and **revoke the underlying token** at its issuer.
2. Delete the `beads-project-sync-automation` and `beads-project-sync` environments.
3. After the M1 archive re-import has been verified and the 14-day hold has passed, delete the remote refs `refs/dolt/data`, `refs/heads/__dolt_remote_info__`, `refs/heads/psyche-beads-project-sync-lock` and `refs/heads/feature/beads-duplicate-reconciliation-420`.
4. Follow-up PR: remove the lock-branch exclusion and its test from `resumeBranches`.
5. Local hygiene, which belongs to the owner: delete `.beads.gate.lock` and `git config --unset beads.role`, and uninstall or unpin the Homebrew `bd` if nothing else uses it.
6. **Final verification:**
   - `git grep -il beads -- ':!docs/superpowers' ':!docs/working-records' ':!CHANGELOG.md'` returns only the `TRACKER-INTEGRITY.md` tombstone;
   - `gh workflow list` shows no Beads workflow;
   - the Project audit from §3.6 is clean;
   - close the retirement outcome with an evidence comment that links the M1–M7 records.

## 5. Rollback

| Point | Rollback |
|---|---|
| Before M5 merges | Re-enable the workflow (`gh workflow enable beads-project-sync.yml`). Beads data, code and token are intact. The next sync restores any adopted mirror bodies and labels; that is acceptable, because GitHub was not yet authoritative. |
| After M5, before M7 | Revert the M5 and M6 PRs and re-enable the workflow. The refs and secret still exist. Issues adopted in M3 will be overwritten by the sync. Accept that, or re-apply their edits through `bd`. |
| After M7 | Not cheap. Re-create a Beads database from the M1 archive with CLI 1.2.2, re-provision a token and environments, and restore the code from git history. The 14-day hold before M7 exists so this path is never needed. |

## 6. Risks and controls

| Risk | Control |
|---|---|
| An off-pin `bd` (1.3.0 is installed) migrates the schema during the archive | Archive only from a disposable clone with a checksum-verified 1.2.2. Never run `bd` in the shared checkout. |
| The sync reverts manual edits | M2 disables the workflow before M3. Verify the disabled state before editing. |
| Never-mirrored Beads hold the only copy of design or dependency context | The M1 archive is verified by re-import. Active work is already fully mirrored, and only closed Beads are unmirrored. |
| Raw export leaks private text | Store the raw archive privately. Only a sanitized summary is public. The protected-data rules in AGENTS.md apply. |
| An outcome is closed without evidence again (as #196/#199 were on 2026-09-16) | The §3.5 closure rule, the Evidence field and the Needs-evidence view make the gap visible weekly. |
| A single maintainer reviews their own R4 change | State the review substitute explicitly on the M5 and M6 PRs (for example, an independent agent review plus the owner). Do not claim independent human review that did not happen. |
| Concurrent agent sessions write Beads during the freeze | The M0 freeze announcement plus the M0.4 process check. Agents read the AGENTS.md change in M5. |

## 7. Effort

| Phase | Effort | Side effects |
|---|---|---|
| M0–M2 | ~0.5 day | Outcome issue, workflow disable |
| M3–M4 | ~1 day | 14 issue edits, Project reshape, labels |
| M5 | ~1 day, plus review | PR |
| M6 | ~0.5 day, plus review | PR |
| M7 | ~1 hour, after the hold | Secret, environments, refs |
