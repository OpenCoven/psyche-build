# Contributor safety and evidence contract

This document complements [`CONTRIBUTING.md`](../CONTRIBUTING.md), the current [`ROADMAP.md`](ROADMAP.md), [`SUPPORT-MATRIX.md`](SUPPORT-MATRIX.md), and [`RELEASE-ACCEPTANCE.md`](RELEASE-ACCEPTANCE.md). It applies to code, documentation, issues, pull requests, tests, fixtures, screenshots, release records, and automation.

## Protect credentials and private data

Never commit, paste, attach, log, screenshot, or retain:

- credentials, access tokens, passwords, private keys, certificates, provisioning profiles, or signing material;
- raw prompts, private conversations, or unrestricted terminal/command history;
- private repository contents or proprietary source;
- complete environment dumps;
- private service URLs, internal hostnames, account identifiers, or infrastructure topology;
- unredacted home-directory, customer, device, or personal paths.

Use synthetic fixtures and consistent placeholders. Reduce evidence to the smallest relevant window, describe omissions, and retain a digest or immutable identifier when provenance matters. Revoke and rotate any secret that may have entered Git history, CI output, an issue, a PR, an artifact, or a screenshot; deleting the visible occurrence is not sufficient.

Suspected vulnerabilities belong in the private route defined by [`SECURITY.md`](../SECURITY.md), never a public issue or PR.

## Edit canonical sources, not generated outputs

Generated files are review evidence, not authoring surfaces. Change the generator or source input, run the canonical command, and verify that a second run is clean.

| Output | Canonical command | Rule |
|---|---|---|
| `src/utils/generated-agents-doc.ts` | `pnpm generate:hooks-docs` | Change hook metadata/source, not the generated module. |
| `native/desktop/psyche-build-tauri/web/*.bundle.js` | `pnpm --dir native/desktop/psyche-build-tauri build:web` | Review source and deterministic bundle changes together. |
| `native/ios/Psyche.xcodeproj/**` and generated iOS `Info.plist` | `pnpm ios:project:generate`; verify with `pnpm ios:project:check` | Change `project.yml` or canonical inputs, not generated Xcode files. |
| `dist/**` and built frontend output | `pnpm build` | Do not treat build output as the source of behavior. |
| Generated Beads mirror issue bodies | supported Beads source-first synchronizer | Repair Beads first; do not hand-edit managed mirror prose. |

Check the owning package scripts and workflow before adding a second command for the same outcome. Package-manager and toolchain pins come from `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `rust-toolchain.toml`.

## Match tests to the claim

Use the narrowest deterministic test that owns the behavior, then expand only as the risk requires:

1. focused unit/contract test;
2. owning package or surface suite;
3. repository typecheck/build/smoke gate;
4. platform simulator or packaged-artifact gate;
5. physical-device, signing, distribution, restart/recovery, or production-path acceptance where the claim requires it.

Do not convert a unit-test count into a user-path claim. Do not convert source presence into platform support. Do not convert hosted compilation or a simulator build into physical-device availability. Record exact commands, exact head SHA, observed results, environment constraints, skipped paths, and remaining proof gaps.

For authority, security, protocol, persistence, or recovery changes, include negative cases: out-of-scope project/path, stale lease, denied/revoked capability, replay/duplicate action, unavailable runtime, partial failure, restart, and work-preservation behavior as applicable.

## Preserve consequential-action boundaries

A UI gesture, process, tmux pane, provider session, worktree, branch, Bead, or GitHub issue is not canonical authorization or identity. Changes must preserve project scope, actor/subject identity, approval, idempotency, receipt, revocation, cleanup, persistence, and recovery contracts.

Psyche Build is the product client/coding cockpit. It must not direct-read Psyche's database or duplicate canonical Psyche familiar, task, lane, run, lease, action, receipt, or recovery state. The Coven daemon remains authoritative for process/PTY execution, project-boundary enforcement, and runtime events.

## Pull-request evidence

Every PR should make these reviewable:

- one linked outcome and explicit non-goals;
- risk class and protected surfaces touched;
- focused tests plus the applicable repository/platform gates;
- generated-source provenance and a clean second generation;
- compatibility/migration and rollback/recovery implications;
- exact-head required-check status;
- support, roadmap, or release-acceptance changes when claims change;
- unresolved uncertainty or evidence that still requires a maintainer/platform host.

A checkbox is an author assertion, not proof. CODEOWNERS review, protected branch checks, and retained acceptance evidence remain authoritative.