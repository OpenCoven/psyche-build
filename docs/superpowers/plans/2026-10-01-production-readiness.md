# Production readiness plan — macOS desktop

**Status:** Proposed; awaiting owner approval (@BunsDev)  
**Observed:** 2026-10-01 against `main` `c32dae7414ad9d5d4ee37bac0c9302c24bf1e6c1`  
**Companion plan:** [Retire Beads; manage work in GitHub Issues and Projects](./2026-10-01-retire-beads-github-projects.md)

This record is classified `reference` under the
[dated-record policy](../README.md) until the owner approves it and an owning
GitHub outcome promotes it to `active`. Nothing here changes a support claim.
The [support matrix](../../SUPPORT-MATRIX.md) and the owning issues keep that
authority.

## 1. State of the report

The status report is spread across five control documents:

- [ROADMAP.md](../../ROADMAP.md)
- [POST-RELEASE-EXECUTION.md](../../POST-RELEASE-EXECUTION.md)
- [RELEASE-ACCEPTANCE.md](../../RELEASE-ACCEPTANCE.md)
- [SUPPORT-MATRIX.md](../../SUPPORT-MATRIX.md)
- [TRACKER-INTEGRITY.md](../../TRACKER-INTEGRITY.md)

The two most recent PRs, #470 and #471, merged on 2026-09-17 to reconcile those
documents. On 2026-10-01 the documents and the live tracker disagreed in these
ways.

### 1.1 Drift between the report and live state

| # | The report says | Live state on 2026-10-01 | Consequence |
|---|---|---|---|
| D1 | #196 is the open P0 stabilization outcome. It is the first step of the critical path. | #196 is **closed as completed** (2026-09-16 22:00Z). No closing evidence comment was added. The last comment is dated 2026-09-14. | The repository's own [closure rule](../../RELEASE-ACCEPTANCE.md#closure-decisions) requires a manifest proving ordinary and failure paths. That manifest (#239) is still open with `terminal_state: incomplete`. Either the closure lacks evidence, or the report is stale. |
| D2 | #199 stays open for application restart, upgrade across two installed builds, the remaining support-bundle collectors, and UI. | #199 is **closed as completed** (2026-09-16 18:42Z). No closing evidence comment was added. | The residual gaps listed in POST-RELEASE-EXECUTION §"Active follow-through" now have no owning issue. |
| D3 | #246 is a deferred P2 input train. | #246 is **closed as not planned** (2026-09-16), with a decision comment. | Six generated Vim mirrors (#222–#227) are still open under a parent that is not planned. Four of them are `status:blocked`. |
| D4 | The Homebrew Cask still selects `v0.0.1`. | Tap commit `2247c1d5` (2026-09-26, homebrew-tap #4) moved the Cask to **`0.0.2`**. | A fresh Cask install is now `v0.0.2`. #239 is still pinned to `v0.0.1` source `57c6c71b`, so its evidence would describe an artifact users no longer receive. |
| D5 | Last reconciled 2026-09-14. Cadence is weekly. | 17 days have passed with no reconciliation. | The standing register defines an overdue review as control drift. |
| D6 | `.github/beads-project-sync.json` names three canonical targets: gh-199, gh-200 and gh-246. | Two of the three are closed. The README of Project #11 is a generated snapshot dated 2026-09-11 that still lists #199 and #246 as active. | Active Beads still map to closed outcomes. The public board shows a portfolio that no longer exists. |
| D7 | The hand-written outcomes (#200, #201, #239, #241, #242, #253, #279, #280, #435) are the public truth. | None of them are on Project #11. Project #11 holds exactly the 14 generated mirrors. | No single view shows every open gate. |

### 1.2 What is genuinely delivered

The following is verified and is not in question:

- **Releases.** `v0.0.1` (2026-08-23) and `v0.0.2` (2026-08-31) are signed and notarized, published as Apple Silicon and Intel DMGs with `SHA256SUMS`, and installed through the Homebrew Cask.
- **Branch protection on `main`.** Administrators are enforced. Exact-head required checks, linear history and conversation resolution are required. No bypass actors exist. Zero approvals are required (#31, PR #351).
- **Recovery harness.** Eleven default scenarios, plus the opt-in `pnpm recovery:restart` and the `upgrade-recovery` source scenario (PRs #354–#359, #461, #463, #465, #468).
- **Versioned project config.** A read gate, a named migration registry and pre-migration snapshots (PR #464). Recovery files are quarantined instead of throwing (PR #460).
- **Support bundle.** Schema (PR #278), CLI and persistence (PR #462), and collectors for provenance, identity, recovery, pane lifecycle and updater state (PR #467).
- **Contributor and community floor** (#198/#244).
- **CI.** Green on `c32dae74`. No PRs are open. Nothing has merged since 2026-09-17. The only scheduled activity is the twice-daily Beads Project sync.

### 1.3 Gaps that block a "production" claim

These items were left open when #196 and #199 closed:

1. **Operator-observed acceptance of the shipped app.** This is #239 and is still open: first run, lifecycle, persistence and restart, Git and cleanup, provider isolation, and the failure table in RELEASE-ACCEPTANCE §"Failure-oriented acceptance". Source harness coverage is explicitly not this evidence.
2. **Upgrade and rollback across two real installed builds.** The source scenario exists. No installed upgrade from `v0.0.1` to `v0.0.2`, or from `v0.0.2` to the next candidate, has been observed.
3. **Crash during a transition, and restart with live agent panes.** These are not observed. The restart scenario does not cover the packaged app.
4. **An agent CLI that fails at launch inside a live shell.** There is no product classification for it.
5. **Interruption during a Git mutation, and automatic crash reconciliation.** Both are open.
6. **The remaining support-bundle collectors** (provider, graphics, receipt, terminal) **and any UI.** Branch `feat/support-bundle-provider-collector` holds an unmerged `wip: checkpoint` commit.
7. **Update mechanism.** The desktop app has no `updater` configuration in `tauri.conf.json`. The CLI `AutoUpdater` shells out to the package manager and asks for a restart. There is no staged update, signed update manifest, rollback or post-upgrade reconciliation. Cask bumps go through manual tap PRs.
8. **Supply-chain and security scanning.** No CodeQL, Dependabot or dependency-review workflow exists in `.github/`.
9. **Independent review.** Zero approvals are required, and the R3/R4 independent-review rule depends on reviewer availability.
10. **Tracker truth.** D1–D7 above, plus the cost of running Beads (see the companion plan).

## 2. Definition of production-ready

Psyche Build is **production-ready** when a named, immutable macOS release
meets every row below. Each row must link retained evidence from its owning
GitHub issue, as the [release-claim rules](../../SUPPORT-MATRIX.md#release-claim-rules)
require.

| Gate | Exit criterion | Evidence |
|---|---|---|
| G1 Install | A clean user installs through the Cask and through a direct DMG. Identity, version, architecture and provenance are verified. | Exact-artifact record (SHA-256, codesign, Gatekeeper, notarization) |
| G2 Ordinary lifecycle | Every #239 lifecycle checklist item is observed on the packaged app. | Sanitized #239 manifest with `terminal_state: complete` |
| G3 Failure paths | Every row of the failure-oriented acceptance table ends `succeeded`, `failed` (actionable), or `recovery_required`. None ends silently unknown. | Manifest rows plus retained harness reports |
| G4 Upgrade and rollback | The candidate is installed over the previous public release (`v0.0.2`). State is preserved or quarantined. Rollback to `v0.0.2` is observed. | Two-build upgrade record |
| G5 Update path | Users learn about and receive a new version through a signed, verified channel. Failures are explicit. | Updater acceptance record |
| G6 Diagnostics | `psyche support-bundle` is reachable from the app UI. All collectors named in [SUPPORT-BUNDLE-V1](../../SUPPORT-BUNDLE-V1.md) are wired or explicitly omitted. Redaction is verified on a real bundle. | Redaction manifest from a packaged run |
| G7 Security | CodeQL (JS/TS, Rust, Swift where feasible), Dependabot and dependency review are on, with no open critical or high alerts. The bridge threat model has been reviewed. Secrets are rotated and repository-level fallbacks are absent. | Security tab state, review record |
| G8 Governance | At least one independent reviewer is available for R3/R4 changes, and one required approval is restored on `main`. | Ruleset evidence |
| G9 Tracker truth | Every open outcome is on the GitHub Project, with priority, train, risk and status set. The control docs agree with live issue state. Beads is retired. | Weekly reconciliation entry |
| G10 Support | SUPPORT.md routes users. Known issues are published. A triage SLA is stated and met for four consecutive weeks. | Project insights or triage log |

Out of scope for this claim, as separate trains that stay deferred:

- iOS (#200, #241, #242, #280, #435)
- OpenCoven convergence (#201, #253, #279)
- Windows and Linux applications
- Vim parity (#246 is not planned)

## 3. Phased plan

Phases run in order. Within a phase, the workstreams may run in parallel. Each
work item becomes one GitHub issue under the outcome named in §4. Each PR stays
independently reviewable, as required by [AGENTS.md](../../../AGENTS.md#change-discipline).

### Phase 0 — Tracker truth and decisions (week 1)

| Item | Work | Risk |
|---|---|---|
| 0.1 | **Owner decision on D1 and D2.** Either reopen #196 and #199, or keep them closed and re-home every residual gap from §1.3 into new outcomes (see §4). Record the decision as a comment on #196 and #199. **Recommended:** keep them closed, record why, and create the outcomes in §4. The original outcomes are pinned to `v0.0.1` evidence, and production readiness should be proven against the next release. | R1 |
| 0.2 | Re-scope #239 from `v0.0.1` source to the production candidate artifact (§3 Phase 4), or close it as superseded with a link to the new acceptance outcome. Either way, the 15 existing evidence digests stay as history. | R1 |
| 0.3 | Close the Vim mirrors #222–#227 as not planned, following #246. Before the Beads cutover, do this through the Beads source. After the cutover, do it directly. | R1 |
| 0.4 | Re-home the GPU mirrors #228, #229 and #232 from closed #199 to the diagnostics outcome, or close them as not planned. | R1 |
| 0.5 | Execute the [Beads retirement plan](./2026-10-01-retire-beads-github-projects.md), phases M0–M4. From that point the GitHub Project is the only planning surface. | R4 |
| 0.6 | One reconciliation PR for ROADMAP, POST-RELEASE-EXECUTION, RELEASE-ACCEPTANCE and SUPPORT-MATRIX, fixing D1–D6 (Cask on `0.0.2`, #196/#199/#246 closed, new outcomes). | R1 |
| 0.7 | Land or discard `feat/support-bundle-provider-collector`. A WIP checkpoint must not become an untracked liability. | R2 |

**Exit:** the board and the documents agree, every §1.3 gap has an owning open issue, and no generated mirror is open.

### Phase 1 — Security and governance baseline (weeks 1–2, parallel with Phase 2)

| Item | Work | Risk |
|---|---|---|
| 1.1 | Add `.github/dependabot.yml` for npm/pnpm, Cargo, GitHub Actions and Swift Package Manager, with grouped weekly updates. | R4 |
| 1.2 | Add a CodeQL workflow for `javascript-typescript` and `rust`, and Swift if the macOS runner budget allows. Run it on PRs and weekly. Triage the first-run alerts into issues. | R4 |
| 1.3 | Add `actions/dependency-review-action` on PRs. Fail on high or critical, and on denied licenses. | R4 |
| 1.4 | Enable secret scanning and push protection. Record the evidence of settings state as names only, no values. | R4 (external) |
| 1.5 | Pin third-party actions to commit SHAs where they are not already pinned. Add an `actions` Dependabot ecosystem to keep the pins fresh. | R4 |
| 1.6 | Review the bridge threat model against [BRIDGE-SECURITY.md](../../BRIDGE-SECURITY.md) and [CONTROL-PLANE.md](../../CONTROL-PLANE.md). Record findings as issues. | R3 |
| 1.7 | Recruit or designate an independent reviewer, then restore one required approval on `main`. Until then, record each R3/R4 merge's review substitute explicitly in the PR. | R4 |

### Phase 2 — Close the recovery and diagnostics gaps (weeks 1–4)

| Item | Work | Risk |
|---|---|---|
| 2.1 | **Agent launch failure classification.** When an agent CLI fails at launch inside a live shell, the product reports a bounded state with a next action. Add a harness scenario for it. | R2 |
| 2.2 | **Git-mutation interruption.** Extend the `interrupted-git-mutation` scenario to cover an interruption *during* the mutation. Define automatic crash reconciliation, or an explicit `recovery_required` state. | R3 |
| 2.3 | **Crash mid-transition and restart with live agent panes.** Extend `recovery:restart` to cover a kill during a persisted transition and live agent panes. Keep it opt-in if it needs tmux and a display. | R3 |
| 2.4 | **Unwritable or full state storage.** Prove the app never reports a successful persist when it failed, and never discards prior state. | R3 |
| 2.5 | **Support-bundle collectors.** Wire the provider, graphics, receipt and terminal collectors, each under the v1 bounds and redaction. Mark any that cannot be made safe as `omitted`, with a reason. | R3 |
| 2.6 | **Support-bundle UI.** Add a Help → "Create support bundle" action. It shows the redaction summary and reveals the `0600` file. It never auto-uploads. | R2 |

### Phase 3 — Update and distribution pipeline (weeks 2–5)

| Item | Work | Risk |
|---|---|---|
| 3.1 | **Design decision: the in-app update channel.** The options are (a) Tauri updater with signed update manifests from GitHub Releases, or (b) detect the update and defer to `brew upgrade` or a DMG. Either way: a signed manifest, verified before use, plus explicit failure, plus no silent restart. | R4 (design) |
| 3.2 | Implement the chosen channel, adding staged update, post-upgrade reconciliation through the versioned config gate (PR #464), and a rollback note in the release notes. | R4 |
| 3.3 | Automate the Cask bump from the release workflow, as a PR to `homebrew-tap` rather than a direct push. Verify the bump by reading the tap, not by the notification job succeeding. | R4 |
| 3.4 | Add a version-coherence check to CI. `package.json`, `tauri.conf.json`, the native bundle, the update manifest and the tag must agree. | R2 |
| 3.5 | Run an uninstall, reinstall and zap observation for the candidate. User repositories, worktrees and branches must survive. | R2 |

### Phase 4 — Release candidate and operator acceptance (weeks 5–7)

| Item | Work | Risk |
|---|---|---|
| 4.1 | **Freeze `v0.1.0-rc.1`** on one exact `main` SHA, following the [release-candidate invariants](../../RELEASE-ACCEPTANCE.md#release-candidate-invariants-for-future-releases). Build the artifacts with the release workflow, but do not tag them as a public release yet. | R4 |
| 4.2 | **Execute G1–G3** with the [operator runbook](../../OPERATOR-ACCEPTANCE-SLICE.md) on the RC artifacts, on a clean user account, on both architectures if hardware allows (otherwise record the gap). Produce one sanitized manifest. | R3 |
| 4.3 | **Execute G4.** Install `v0.0.2` from the Cask, use it, upgrade to the RC, verify, then roll back to `v0.0.2` and verify again. | R3 |
| 4.4 | **Execute G5 and G6** on the packaged RC. | R3 |
| 4.5 | **Fix loop.** Each failure becomes a P0 issue that names the failed acceptance case. The fix lands, a new RC is cut, and only the affected cases are re-run, plus a smoke run of everything else. | R2–R3 |

### Phase 5 — Production release (week 8)

| Item | Work | Risk |
|---|---|---|
| 5.1 | Create the signed annotated tag `v0.1.0` on the accepted RC SHA, publish through the protected release workflow, and bump the Cask. | R4 |
| 5.2 | Update SUPPORT-MATRIX, ROADMAP and RELEASE-ACCEPTANCE with the `v0.1.0` evidence. The macOS row stays **Supported**, now backed by operator acceptance. | R1 |
| 5.3 | Publish release notes that list known issues, deferrals, and the upgrade and rollback instructions. | R1 |
| 5.4 | Start the G10 triage SLA clock: first response within 3 business days for bugs, and same-day acknowledgement for security reports per SECURITY.md. | R1 |

### Phase 6 — Steady state (ongoing)

- Weekly reconciliation on the GitHub Project, as defined in the companion plan. It replaces the Beads sync and the drift validator.
- Each release repeats G1–G5 against its own artifacts.
- iOS, OpenCoven and input trains resume only through an explicit owner prioritization comment, and never as an implicit macOS prerequisite.

## 4. Proposed GitHub structure for this plan

Proposed milestone: **`v0.1.0 — macOS production`**. Close the stale `v0.0.1 macOS`
milestone after 0.2. Rename `Post-v0.0.1 hardening` to **`iOS internal beta`**.
It holds only paused iOS work.

| Proposed outcome issue (Epic type) | Priority | Train | Children (Phase.item) |
|---|---:|---|---|
| Production acceptance of the macOS release candidate (successor to #239) | P0 | macOS rollout | 0.2, 4.1–4.5 |
| Close observed recovery gaps (successor to the residual scope of #199) | P0 | Reliability | 2.1–2.4 |
| Support bundle production surface | P1 | Reliability | 0.7, 2.5, 2.6, GPU #228/#229/#232 if kept |
| Signed update channel and release automation | P0 | Release | 3.1–3.5 |
| Security and supply-chain baseline | P0 | Governance | 1.1–1.6 |
| Independent review capacity | P1 | Governance | 1.7 |
| Retire Beads; GitHub Issues and Projects are the tracker | P0 | Governance | Companion plan M0–M7 |
| Release `v0.1.0` | P0 | Release | 5.1–5.4 |

Do not create these issues until the owner approves this plan. Creating issues
is an external side effect.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Single maintainer acts as author, reviewer and operator | Item 1.7. Until then, state the review substitute explicitly on every R3/R4 PR. Never claim independent review that did not happen. |
| Acceptance hardware is limited (Intel Mac, clean account) | Record each missing architecture or context as a named gap in the manifest. Never extrapolate from the other architecture. |
| The update-channel design stalls | 3.1 is time-boxed to one week. The fallback is option (b), which detects and defers to the Cask. |
| Concurrent agent sessions race on the shared checkout | Work in one worktree per outcome, as the global rules require. |
| The tracker migration goes wrong mid-flight | The companion plan keeps the Beads data and refs until M7 verification passes, and has an explicit rollback. |

## 6. Rollback

This plan changes no product behavior by itself. Each implementing PR carries
its own rollback. Before Phase 5, abandoning the plan leaves `v0.0.2` as the
supported public release, with no change to user state.
