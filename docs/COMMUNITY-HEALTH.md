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

The community-profile score credits only **legacy Markdown** issue templates (`ISSUE_TEMPLATE.md` or `.github/ISSUE_TEMPLATE/*.md`). YAML issue **forms** are valid, supported intake surfaces, but GitHub's detector does not count them, and the REST field `files.issue_template` reports `null` for both cases. Cross-repository comparison measured on 2026-08-30 through the same REST endpoint:

| Repository | Public intake | Health |
| --- | --- | --- |
| OpenCoven/psyche-build | YAML forms only | 87 |
| vitejs/vite | YAML forms only | 87 |
| prettier/prettier | YAML forms only | 87 |
| grafana/grafana | YAML forms only | 87 |
| microsoft/vscode | Markdown templates | 100 |
| nodejs/node | Markdown templates | 100 |
| facebook/react | Markdown templates | 100 |
| kubernetes/kubernetes | Markdown templates | 100 |

Every repository above reports `files.issue_template: null`; the field does not track forms. The percentage difference tracks the presence of a Markdown template, not the presence or quality of intake surfaces.

## Resolution

Two acceptance paths exist in issue #198: reach 100 percent, or prove each remaining omission is a GitHub detection limitation and resolve it another way. Both are recorded here.

1. **Proven detection limitation.** The missing 13 percent is the issue-template detector described above; the repository's YAML forms are present, valid, and enforced by `__tests__/communityHealthContract.test.ts`.
2. **Resolution:** `.github/ISSUE_TEMPLATE/other.md` was added as a redirect-only legacy Markdown template — the one intake surface the detector credits. It solicits no information: it exists to route reporters to the three YAML forms, [`SUPPORT.md`](../SUPPORT.md), and the private security advisory flow. Blank issues remain disabled via `.github/ISSUE_TEMPLATE/config.yml`.

Tradeoff, for the maintainer's record: a legacy Markdown template accepts free-form text without the YAML forms' required safety checkboxes. The chosen mitigation is that the template contains routing instructions only and asks for no evidence, tokens, logs, or paths; the GitHub API has always allowed unstructured issue creation, so the checkbox enforcement boundary is unchanged. The alternative — leaving intake forms-only and accepting 87 percent under the documented-limitation clause — was evaluated and remains available by deleting `.github/ISSUE_TEMPLATE/other.md` alone.

## Verification

After this change merges, re-run:

```sh
gh api repos/OpenCoven/psyche-build/community/profile --jq '{health_percentage, files}'
```

GitHub recomputes the profile lazily; the score may not update immediately at merge time. The rest of this contract is verifiable locally at any head:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm vitest --run __tests__/communityHealthContract.test.ts
```

## Non-goals

- No marketing launch or community-percentage vanity target: the percentage is treated as a measurement artifact, and the usable-guidance surfaces remain authoritative.
- No new data-solicitation in any intake template.
- No change to the private security route, `blank_issues_enabled: false`, or the required safety checkboxes in the YAML forms.
