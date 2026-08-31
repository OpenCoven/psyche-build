# Community surfaces and GitHub community-health status

This is the status record for the community, security, and contributor intake surfaces required by [issue #198](https://github.com/OpenCoven/psyche-build/issues/198). It answers three questions for maintainers and auditors: which surfaces exist and where, what GitHub's community-health measurement currently reports, and how any remaining gap is resolved. It complements [`../CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md), [`SUPPORT.md`](../SUPPORT.md), [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md), and the [contributor repository map](REPOSITORY-MAP.md); it does not replace them.

## Surface inventory

| Surface | File | State |
| --- | --- | --- |
| Security policy | [`SECURITY.md`](../SECURITY.md) | Present: supported versions/platforms, private reporting route, response targets, disclosure, scope priorities, support-vs-security boundary. |
| Private vulnerability reporting | GitHub private advisories | Documented in `SECURITY.md` and linked from `SUPPORT.md`, the issue chooser, and the PR template. If the private form is unavailable, `SECURITY.md` names the verified-private-channel fallback. |
| Ownership | [`.github/CODEOWNERS`](../.github/CODEOWNERS) | Present: default owner plus release/security, control/protocol, bridge, desktop, iOS, generated outputs, Beads, and documentation surfaces. |
| Pull-request template | [`.github/pull_request_template.md`](../.github/pull_request_template.md) | Present: scope, R1–R4 risk class, focused/full validation, generated-output, security/privacy, review-focus, and release-impact checklists. |
| Issue forms | [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) | Present: `bug.yml`, `feature.yml`, `documentation.yml`; blank issues disabled in `config.yml`; security redirect implemented as a private-advisory contact link, not a public form. |
| Support | [`SUPPORT.md`](../SUPPORT.md) | Present: route table, expected evidence, redaction rules, support boundaries, GitHub-vs-private-routing. |
| Conduct | [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Present: expected/unacceptable conduct, scope, private reporting, proportionate enforcement ladder. |
| Contribution guide | [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Present: prerequisites, bootstrap, focused/full gates, generated-output commands, ~800 non-generated line split heuristic, design-escalation triggers, PR evidence packet, merge gates. |
| Architecture map | [`docs/REPOSITORY-MAP.md`](REPOSITORY-MAP.md) | Present: directory taxonomy, authority boundaries, change routing, verification ladder, generated-source ownership. |
| Roadmap | [`docs/ROADMAP.md`](ROADMAP.md) | Present: active roadmap; historical records remain under `docs/superpowers/` classified `reference` by default. |
| Support claims | [`docs/SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md) | Present: the contract for what may be claimed as supported, planned, compile-only, or unavailable. |
| Community-health status | this document | Maintained with the community-surfaces PR set; re-measure after repo-setting changes. |

## Measured GitHub community-health result

Measured 2026-08-30 via `GET /repos/OpenCoven/psyche-build/community/profile`:

- `health_percentage: 87`;
- detected: description, README, MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/pull_request_template.md`;
- `files.issue_template: null` even though `.github/ISSUE_TEMPLATE/` contains three valid YAML issue forms plus `config.yml`.

## Why the percentage is 87 and not 100

GitHub's Community Standards checklist recognizes the repository's YAML issue
forms. The remaining unchecked item is **Repository admins accept content
reports**, a repository moderation setting. The REST response's
`files.issue_template: null` does not describe the forms shown by the checklist
and is not the cause of the missing percentage.

## Resolution

The repository keeps its bounded YAML forms and does not add a legacy Markdown
template merely to influence the score. Enabling content reports is a manual
maintainer action with no public API:

1. Open **Settings → Moderation options → Reported content**.
2. Enable repository content reports for the reviewed audience.
3. Re-run the measurement below and retain the observed result.

Until that setting is reviewed and enabled, the community-health score remains
an explicit #198 closure blocker. This document and PR do not claim that #198
is complete. Reporters remain routed through the three bounded YAML forms and
[`SUPPORT.md`](../SUPPORT.md). Vulnerability reports retain the private security
advisory flow. Blank issues remain disabled via
`.github/ISSUE_TEMPLATE/config.yml`.

## Verification

After this change merges, re-run:

```sh
gh api repos/OpenCoven/psyche-build/community/profile --jq '{health_percentage, files}'
```

GitHub may recompute the profile lazily after the moderation setting changes.
The rest of this contract is verifiable locally at any head:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm vitest --run __tests__/communityHealthContract.test.ts
```

## Non-goals

- No marketing launch or community-percentage vanity target: the percentage is treated as a measurement artifact, and the usable-guidance surfaces remain authoritative.
- No new data-solicitation in any intake template.
- No change to the private security route, `blank_issues_enabled: false`, or the required safety checkboxes in the YAML forms.
