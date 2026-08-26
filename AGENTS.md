# Psyche Build agent guide

This is the root entrypoint for coding agents and human contributors. It routes work to the repository's canonical product, delivery, security, and evidence documents.

Do not use this file as a second roadmap or append incident history to it.

## Mission and boundary

Psyche Build is the OpenCoven coding cockpit: a local-first product for isolated or shared development lanes, tmux/worktree execution, guarded agent control, Git integration, desktop operation, and the planned iOS companion.

Psyche Build owns its product behavior and product-local state. `OpenCoven/psyche` is the target canonical orchestration protocol for durable task, lane, execution, lease, approval, receipt, cancellation, and recovery identity.

Current `psyche.*`, `orch-*`, task, pane, worktree, process, provider, and control records in this repository are not automatically the public Psyche protocol. Treat them as product contracts until a released Psyche profile is pinned and the compatibility canary passes.

## Authority order

Use these sources in order:

1. owning GitHub issue or pull request for live status, blockers, review, and evidence;
2. `docs/ROADMAP.md` for active outcomes and phase gates;
3. `docs/POST-RELEASE-EXECUTION.md` for critical-path sequencing and closure rules;
4. `docs/SUPPORT-MATRIX.md` for support claims;
5. `docs/RELEASE-ACCEPTANCE.md` and `docs/RELEASE.md` for artifact proof;
6. dated specs/plans for historical design intent.

GitHub owns public outcomes. Beads owns internal implementation dependencies. Neither owns runtime identity or proves delivery.

## Start here

1. Read `README.md`.
2. Read `docs/POST-RELEASE-EXECUTION.md` and identify the owning issue.
3. Read the scoped product/security document for the affected surface.
4. For orchestration identity or lifecycle work, read `docs/PSYCHE-CONFORMANCE.md`.
5. Read `CONTRIBUTING.md` and `.beads/README.md`.
6. Run `./scripts/agent-bootstrap`.
7. Run `./scripts/agent-check fast` before editing and after each bounded slice.
8. Run focused tests for the touched contract.
9. Run `./scripts/agent-check full` before requesting review.

## Canonical documents

- Roadmap: `docs/ROADMAP.md`
- Ordered delivery contract: `docs/POST-RELEASE-EXECUTION.md`
- Support claims: `docs/SUPPORT-MATRIX.md`
- Control-plane architecture: `docs/CONTROL-PLANE.md`
- Agent surface authority: `docs/AGENT-SURFACE-CONTROL.md`
- Bridge/daemon security: `docs/BRIDGE-SECURITY.md`
- Release acceptance: `docs/RELEASE-ACCEPTANCE.md`
- Psyche protocol migration: `docs/PSYCHE-CONFORMANCE.md`
- Contribution workflow: `CONTRIBUTING.md`
- Beads internal tracker contract: `.beads/README.md`
- Machine-readable repository contract: `agent/manifest.yaml`

## Path ownership

| Path | Responsibility |
|---|---|
| `src/orchestration/**` | task/lane planning, product-local operation identity, adapters, capability routing |
| `src/control/**` | credentials, scopes, leases, approvals, commands, receipts, journal, server/runtime authority |
| `src/actions/**` | guarded product actions and external effects |
| `src/mcp/**` | agent-facing MCP boundary |
| `src/daemon/**` | daemon/process integration |
| `src/panes/**`, `src/utils/**`, `src/index.ts` | local execution resources, Git/worktree lifecycle, and CLI composition |
| `src/adapters/**` | compatibility and external-system adapters |
| `native/**` | desktop and iOS native shells, secure storage, pairing, distribution |
| `frontend/**`, `src/components/**` | product UI; must project authority rather than invent it |
| `scripts/beads-project-sync/**` | public-tracker synchronization controls |
| `.github/**`, `scripts/release*`, `scripts/smoke*` | CI, release, retained evidence, and publication |
| `.beads/**` | internal implementation graph; use the Beads contract and tooling |

## Risk classes

- **R0:** docs/copy without support or contract claims.
- **R1:** pure UI or logic with no durable/external effect.
- **R2:** local state, persistence, worktrees, tmux, process, or migration behavior.
- **R3:** credentials, network, providers, GitHub, browser, mobile pairing, or user/project data.
- **R4:** identity, authority, lease, approval, receipt, idempotency, ambiguous effects, recovery, release, or deletion.

R2–R4 changes require explicit failure behavior, recovery/rollback, and retained evidence. Do not simplify tests by widening authority.

## Invariants

Never:

- use a Bead, GitHub issue, pane, tmux ID, process, path, branch, worktree, provider session, endpoint, or UI selection as durable protocol identity;
- treat activity, dispatch, a green UI, or successful decoding as terminal success;
- execute a consequential action without current subject/project/resource scope and authority;
- retry an unknown effect without the canonical idempotency/reconciliation rule;
- expose a new host/workspace snapshot before identity and readiness commit atomically;
- infer capability from a control being visible;
- log credentials, raw prompts, unrestricted terminal output, repository contents, full environment dumps, or sensitive paths;
- edit generated files or GitHub mirror bodies instead of their canonical source/generator;
- merge stale source-material PRs merely because they rebase or once passed tests;
- claim iOS/TestFlight/remote support without immutable distributed-build and physical-device evidence.

## Generated files

Generate; do not hand-edit:

- `src/utils/generated-agents-doc.ts` via `pnpm run generate:hooks-docs`;
- `native/ios/Psyche.xcodeproj/**` and `native/ios/PsycheApp/Resources/Info.plist` via XcodeGen;
- release/package outputs via the documented build and pack commands;
- GitHub Project mirror bodies via the managed Beads synchronization path.

Review generated diffs and keep the canonical source in the same PR.

## Change workflow

1. Claim one public outcome and one Bead implementation slice where applicable.
2. Work from current `main` in a dedicated branch/worktree.
3. Record objective, non-goals, current behavior, risk, and acceptance gate.
4. Add focused positive and negative tests first for contract changes.
5. Implement the smallest current-main slice.
6. Run the fast gate and directly affected tests.
7. Run the full gate and any explicit platform/physical-device gate.
8. Inspect generated output and `git diff --check`.
9. Open a focused PR with exact-head evidence, migration, rollback, support impact, and remaining gaps.
10. Update the owning issue and active roadmap only when evidence changes status.

A merged diff is not proof of runtime acceptance. Close an outcome only after its durable evidence is linked.

## Verification

```sh
./scripts/agent-check fast
./scripts/agent-check full
```

Optional gates are explicit:

```sh
PSYCHE_AGENT_CHECK_IOS=1 ./scripts/agent-check full
PSYCHE_AGENT_CHECK_TAURI=1 ./scripts/agent-check full
PSYCHE_AGENT_CHECK_TRACKER=1 ./scripts/agent-check full
```

Do not set a platform flag unless the required platform, tools, credentials, and evidence surface are actually available.

## Psyche protocol work

The migration is incremental:

1. inventory product-local identities and transitions;
2. pin an immutable released Psyche profile;
3. run positive and negative compatibility canaries;
4. introduce protocol IDs alongside local IDs;
5. adapt one lifecycle at a time with reversible persistence reads/writes;
6. remove duplicate local semantics only after equivalence and rollback are proven.

No floating `OpenCoven/psyche@main` dependency. No big-bang rewrite. Do not make future protocol integration an undeclared blocker for the supported macOS release or the current stabilization/iOS critical path.

## Completion evidence

Include:

- owning issue and Bead, if any;
- exact final head SHA;
- files intentionally changed;
- risk class and protected surfaces;
- exact commands/results;
- generated outputs and provenance;
- migration and rollback;
- support and security impact;
- affected protocol producers/consumers;
- unavailable platform or physical-device proof;
- retained artifact/runtime evidence.
