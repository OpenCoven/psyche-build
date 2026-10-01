# Tracking work

Psyche Build tracks all planning in **GitHub Issues** and one GitHub Project,
[**Psyche Build** (Project #11)](https://github.com/orgs/OpenCoven/projects/11).
There is no second planning store, no generated mirror and no synchronizer.

Beads was retired as the planning store on 2026-10-01 under
[#473](https://github.com/OpenCoven/psyche-build/issues/473). The working record
[beads-retirement-2026-10](working-records/beads-retirement-2026-10.md) describes
the archive and its digests. Tracker identity is never runtime identity: an
issue, a sub-issue or a Project item is never a familiar, task, lane, run,
action or receipt identity.

## Hierarchy

| Level | GitHub construct | Rule |
|---|---|---|
| Outcome | An issue with the `outcome` label and the **Feature** type | It owns the exit gate, the evidence index, the train, the risk and the priority. It closes only with an evidence comment (see [Closing work](#closing-work)). |
| Work item | A sub-issue of exactly one outcome, with the **Task** or **Bug** type | One reviewable PR slice, or a small set of them. |
| Ordering | `blocked by` / `blocking` issue dependencies | Use them only where order is real. Do not restate the hierarchy as dependencies. |
| Release grouping | A milestone | Milestones group by release. They are not priority. |

## Project fields

| Field | Values | Meaning |
|---|---|---|
| Status | Triage, Backlog, Ready, In Progress, In Review, Blocked, Done | Where the item is now |
| Priority | P0, P1, P2 | As defined in [ROADMAP § Priority definitions](ROADMAP.md#priority-definitions) |
| Train | macOS rollout, Reliability, Release, Governance, iOS, OpenCoven, Docs | The delivery train from the roadmap |
| Risk | R1, R2, R3, R4 | The tier from [AGENTS.md § Risk and review](../AGENTS.md#risk-and-review) |
| Evidence | A link | The evidence comment or manifest that closed the item |

The Project's built-in workflows should add new repository issues and PRs to
the Project in **Triage**, move closed items and merged PRs to **Done**, and
add sub-issues automatically. Only the sub-issue workflow is enabled today; the
others must be enabled in the Project settings UI, which #473 tracks. Until
then, the weekly reconciliation does those steps by hand: it adds new issues
and PRs, sets their Status, and moves closed items to **Done**. The **Triage**
view also lists open items with no Status, so nothing filed through a form is
missed. Auto-archive stays **disabled**: archived items drop
out of the **Needs evidence** view, so an outcome closed without evidence would
silently leave the audit.

## Filing work

- Contributors use the issue forms. They apply `needs-triage`, set the issue
  type and add the issue to the Project.
- Anyone may propose an outcome with the **Outcome proposal** form. It enters
  triage like any other issue, and a maintainer applies the `outcome` label
  only after approving it, so unapproved proposals stay out of the Portfolio view.
- Agents create issues with `gh issue create --project "Psyche Build"`, set
  fields with `gh project item-edit`, and attach sub-issues through the
  sub-issues REST endpoint (`POST /repos/{owner}/{repo}/issues/{number}/sub_issues`).
- Never put credentials, raw prompts, unrestricted terminal output, private
  repository contents or unredacted personal paths in an issue. GitHub keeps
  issue edit history, so sanitize content before its first publication.

## Closing work

- **Outcomes close by hand** with a comment that links retained evidence tied to
  immutable source, and the Evidence field is set in the same change.
  A PR that advances an outcome references it with `Refs #N` and never with a
  closing keyword. A closing keyword in quoted prose can close an outcome
  without evidence, as PR #350 did to #196.
- **Task and bug sub-issues** may close through `Fixes #N` in the PR that
  implements them.
- **Not planned is a scope decision.** Closing as not planned is not a claim
  that the work was implemented. When an outcome closes with open scope, re-home
  that scope to a named successor in the closing comment.

## Weekly reconciliation

The [standing register](ROADMAP.md#standing-roadmap-control) owns weekly and
event-driven reconciliation. Its tracker inputs are the following:

1. Empty the Project's **Triage** view: every item gets a type, a parent
   outcome or the `outcome` label, a Priority, a Train, a Risk and a Status.
2. Confirm that the **Blocked** view is accurate and that the **Needs evidence**
   view (closed outcomes without Evidence) is empty.
3. Reconcile `docs/ROADMAP.md` and `docs/POST-RELEASE-EXECUTION.md` against the
   **Portfolio** view in one protected PR.
4. Record the observation date and source SHA.

## Non-goals

The tracker does not prove that a user path works, does not grant support
status, and does not establish authority. Support claims follow
[SUPPORT-MATRIX.md](SUPPORT-MATRIX.md) and
[RELEASE-ACCEPTANCE.md](RELEASE-ACCEPTANCE.md).
