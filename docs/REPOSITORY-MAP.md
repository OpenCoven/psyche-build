# Psyche Build repository map

This is the contributor-facing map of the current repository. It answers two questions before a change begins: **where does this behavior live?** and **which authority and verification contract owns it?**

Start with [`../AGENTS.md`](../AGENTS.md) for repository-wide agent rules and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the development workflow. This map does not replace the owning architecture documents; it routes contributors to them.

## Authority boundary

Psyche Build is the coding cockpit and product client. Its local project, pane, terminal, tmux, worktree, branch, provider-session, UI, Beads, and GitHub identifiers are references, not durable OpenCoven protocol identity.

- [`src/control/`](../src/control/) is the current in-repository control authority for guarded product actions. See [Control-plane architecture](CONTROL-PLANE.md) and [Agent surface control](AGENT-SURFACE-CONTROL.md).
- [`src/daemon/`](../src/daemon/) adapts product requests to daemon/runtime effects. The daemon effect boundary must not be bypassed from UI or transport code. See [Control-plane architecture](CONTROL-PLANE.md) and [Bridge security](BRIDGE-SECURITY.md).
- `OpenCoven/psyche` is the target canonical protocol owner for durable task/lane/execution/lease/approval/receipt/recovery semantics. Psyche Build does not claim that conformance until a released profile is pinned and canaried. See [Psyche compatibility map](PSYCHE-COMPATIBILITY-MAP.md).
- Beads and GitHub own planning/public outcome state only. They are never runtime task, lane, action, receipt, or familiar identity. See [Tracker integrity](TRACKER-INTEGRITY.md) and [`.beads/README.md`](../.beads/README.md).

## Top-level map

| Path | Primary responsibility | Read before changing | Typical verification |
| --- | --- | --- | --- |
| `src/` | Node/TypeScript CLI, TUI/product composition, control client, daemon adapters, panes, integrations, hooks, services | `AGENTS.md`, `CONTROL-PLANE.md`, owning tests | focused Vitest, `pnpm typecheck`, `pnpm test` |
| `src/control/` | leases, approvals, policy, journaling, idempotency, guarded actions, recovery-facing control contracts | `CONTROL-PLANE.md`, `AGENT-SURFACE-CONTROL.md`, `PSYCHE-COMPATIBILITY-MAP.md` | focused control tests + full TypeScript gate; treat as R3 |
| `src/daemon/` | daemon transport/adaptation and the concrete mutation-effect boundary | `CONTROL-PLANE.md`, `BRIDGE-SECURITY.md` | daemon/control-adapter tests + typecheck; treat mutation paths as R3 |
| `src/services/bridge/` | bridge/session transport and security-sensitive integration surfaces | `BRIDGE-SECURITY.md` | focused bridge/security tests; treat as R3 |
| `native/desktop/` | desktop application surfaces, including the Tauri desktop implementation | `SUPPORT-MATRIX.md`, `RELEASE-ACCEPTANCE.md` | owning web/Rust/Tauri checks; release-sensitive paths are R4 |
| `native/ios/` | internal iOS companion source and generated Xcode project | `SUPPORT-MATRIX.md`, `RELEASE-ACCEPTANCE.md` | `pnpm ios:project:check` plus owning Core/app/UI checks on a compatible macOS host; R4 |
| `native/macos/` | macOS-native support code outside the desktop Tauri tree | owning source/tests and support contract | owning native checks; do not infer release acceptance from compile success |
| `protocol-fixtures/` | checked-in protocol fixtures used by product compatibility tests | `PSYCHE-COMPATIBILITY-MAP.md`, generator source | `pnpm fixtures:generate` and no generated drift; R3/R4 when compatibility changes |
| `scripts/` | repository automation, builds, release tooling, tracker synchronization and validators | script-specific docs, `AGENTS.md` | focused script tests plus the owning end-to-end/dry-run contract |
| `.github/` | CI, release workflows, issue/PR intake, CODEOWNERS, Beads Project configuration | `SECURITY.md`, `CONTRIBUTOR-SAFETY.md`, `RELEASE.md` | syntax/contract tests and live settings evidence where applicable; R4 |
| `.beads/` | authoritative implementation-planning state and migration guidance for generated mirrors | `.beads/README.md`, `TRACKER-INTEGRITY.md` | supported Beads export/sync/validator; source-first repair only; R4 |
| `docs/` | current product, architecture, support, release and contributor contracts plus the public docs application | `docs/README.md` authority order | `pnpm docs:focus:check`, `pnpm --dir docs build` |
| `__tests__/` | repository behavior, contract, security, workflow and regression evidence | `__tests__/README.md` | run the narrowest owning test first, then the repository gate |
| `agent/` | machine-readable repository/agent contract | `AGENTS.md` | `__tests__/agentRepositoryContract.test.ts` plus agent fast/full checks |

## `src/` orientation

The TypeScript tree is intentionally split by responsibility rather than by one global application layer. The current tree includes:

- `actions/` — product actions and action composition;
- `adapters/` — integration/adaptation boundaries;
- `components/`, `layout/`, `panes/` — TUI/product presentation and pane composition;
- `control/` — guarded authority, policy, leases, approvals, journaling and related control contracts;
- `daemon/` — daemon-facing transport and concrete mutation adaptation;
- `github/` — GitHub-facing product integration;
- `hooks/` — hook behavior and generated hook documentation inputs;
- `mcp/` — MCP-facing integration code;
- `orchestration/` — current product-local orchestration/composition; do not promote its local identifiers to canonical Psyche identity;
- `protocol/` — inert design-stage contract types for the future Psyche convergence (issue #201); design record under `docs/superpowers/specs/`; product code must not import them (boundary-tested);
- `services/` — service/integration implementation, including security-sensitive bridge surfaces;
- `utils/` and other support modules — shared product utilities and generated outputs where documented.

Large composition files such as `src/index.ts` and `src/PsycheApp.tsx` are entry/composition surfaces, not permission to put every new behavior there. Prefer the owning module and preserve the authority boundary.

## Change routing

Use the smallest row that owns the consequence:

| If the change affects… | Start in… | Required boundary check |
| --- | --- | --- |
| rendering, navigation, pane presentation | `src/components/`, `src/layout/`, `src/panes/` | UI state must not imply authority or durable identity |
| pane/process mutations or guarded actions | `src/control/` + `src/daemon/` | every mutation still crosses the canonical control authority/effect boundary |
| capability scope, approval, receipt, idempotency, revocation, recovery | `src/control/` | preserve exact actor/task/target/revision/digest binding and fail-closed behavior |
| bridge/session connectivity | `src/services/bridge/` and daemon adapters | preserve authentication, project scope, transport and reconnect failure boundaries |
| Psyche protocol adoption | adapter seam identified by `PSYCHE-COMPATIBILITY-MAP.md` | no guessed wire contract, floating dependency, or local identity substitution |
| Beads/GitHub tracker state | `.beads/` and `scripts/beads-project-sync/` | change Beads first; generated GitHub mirrors are not writable source state |
| macOS release/signing/notarization | release workflows/scripts + desktop native surface | exact source/artifact evidence and protected credential path; R4 |
| iOS project/application behavior | `native/ios/` | generated project provenance plus platform-specific acceptance; R4 |
| public support/status claims | `docs/SUPPORT-MATRIX.md`, owning issue | distinguish source/build evidence from distributed/accepted support |

## Verification ladder

Verification should grow with risk rather than defaulting every edit to the slowest possible suite.

1. **Focused proof:** run the owning test/file or generator check for the changed behavior.
2. **Type/contract proof:** run `pnpm typecheck` for TypeScript/test-contract changes.
3. **Repository proof:** run `pnpm test`; for agent-driven work, `bash scripts/agent-check fast` is the bounded handoff gate.
4. **Build/smoke proof:** use `bash scripts/agent-check full`, `pnpm build`, `pnpm smoke`, `pnpm smoke:pack`, native checks, or docs build when the touched surface requires them.
5. **Platform/live acceptance:** required for claims involving signed/notarized macOS artifacts, physical iOS devices, TestFlight, repository settings, protected environments, or production synchronization. Unit tests cannot substitute for this layer.

See [`../AGENTS.md`](../AGENTS.md) for R1–R4 review classes. Security/authority/protocol/persistence/recovery paths are R3; release, repository governance, credentials, generated-source ownership, and cross-repository identity are R4.

## Generated-source boundaries

Do not hand-edit outputs that have canonical generators:

- `src/utils/generated-agents-doc.ts` → `pnpm generate:hooks-docs`
- `native/desktop/psyche-build-tauri/web/*.bundle.js` → `pnpm --dir native/desktop/psyche-build-tauri build:web`
- `native/ios/Psyche.xcodeproj/**` and generated iOS `Info.plist` → `pnpm ios:project:generate` / `pnpm ios:project:check`
- `dist/**` → `pnpm build`
- generated Beads mirror issue bodies → source change in Beads followed by the supported synchronizer

A generated diff is evidence only when its source change and regeneration command are reviewable together.

## First contribution path

For a new contributor or autonomous coding agent:

```bash
bash scripts/agent-bootstrap
bash scripts/agent-check fast
```

Then identify one owning outcome, read only the relevant architecture/support documents from the tables above, make one bounded change, run its focused test, and finish with the applicable repository gate. Use `SUPPORT.md` for routing questions and `SECURITY.md` for vulnerabilities; do not place credentials, raw prompts, private repository contents, unrestricted terminal output, or unredacted local paths in public evidence.
