# Psyche Build agent guide

This file applies to the entire repository. A more specific `AGENTS.md` may narrow these rules for its subtree. Human instructions and repository policy take precedence over this guide.

## Repository role

Psyche Build is OpenCoven's coding cockpit and product client. It owns user-facing cockpit behavior and product-local composition around projects, panes, terminals, tmux sessions, worktrees, branches, optional provider integrations, and platform clients.

Psyche Build does **not** own the durable OpenCoven identity or orchestration protocol:

- [`OpenCoven/psyche`](https://github.com/OpenCoven/psyche) owns canonical familiar, task, lane, run, lease, approval, action, receipt, recovery, and compatibility semantics.
- The Coven daemon owns process and PTY execution, project-boundary enforcement, and authoritative runtime events.
- Psyche Build consumes those contracts through versioned adapters. It must not direct-read Psyche's database, duplicate canonical protocol state, or infer authority/completion from a UI selection, tmux pane, process, path, worktree, branch, provider session, or GitHub issue.
- Issue [#253](https://github.com/OpenCoven/psyche-build/issues/253) owns the future immutable Psyche profile pin and compatibility canary. Until that lands, do not claim Psyche protocol conformance.

## Planning and evidence contract

| Surface | Owns | Must not become |
|---|---|---|
| GitHub outcome issues, milestones, and Project #11 | Public outcomes, owners, priority, train, risk, acceptance gates, and externally legible status | A runtime identity model or proof that a user path works |
| GitHub sub-issues and issue dependencies | Implementation tasks under an outcome and their real ordering | Familiar, task, run, lane, action, or receipt identity |
| Pull requests | Reviewable implementation slices and exact-head proof | Evidence that an entire user path works merely because unit tests pass |
| Specs and plans | Design intent, decisions, and historical reasoning | Executable backlog or proof that behavior shipped |
| Acceptance records | Runtime observations tied to immutable source and artifacts | Unbounded logs, screenshots without provenance, or maintainer memory |

GitHub Issues and the Psyche Build Project (#11) are the only planning store; there is no generated mirror. Follow [Tracking work](docs/TRACKER.md): outcomes close by hand with an evidence comment, and a PR references an outcome with `Refs #N`, never a closing keyword. Beads was retired under [#473](https://github.com/OpenCoven/psyche-build/issues/473); do not run `bd` against this repository.

## Canonical routing

Read only the documents needed for the change, but start here rather than reconstructing policy from historical plans:

- [Post-release execution](docs/POST-RELEASE-EXECUTION.md) — current sequencing, concurrency, merge, and closure gates.
- [Roadmap](docs/ROADMAP.md) — current outcome and support-policy snapshot.
- [Support matrix](docs/SUPPORT-MATRIX.md) — what is supported, planned, compile-only, or unavailable.
- [Control plane](docs/CONTROL-PLANE.md) — authority, actions, approvals, and receipts.
- [Agent surface control](docs/AGENT-SURFACE-CONTROL.md) — bounded agent-facing control surfaces.
- [Bridge security](docs/BRIDGE-SECURITY.md) — authentication, scope, transport, and failure boundaries.
- [Release acceptance](docs/RELEASE-ACCEPTANCE.md) — evidence required for release and support claims.
- [Contributing](CONTRIBUTING.md) — contributor workflow and platform prerequisites.
- [Tracking work](docs/TRACKER.md) — issues, sub-issues, Project fields, and closure rules.

Dated files under `docs/superpowers/` are design history unless the current roadmap explicitly marks one active.

## Deterministic entrypoints

From a clean checkout:

```bash
bash ./scripts/agent-bootstrap
bash ./scripts/agent-check fast
```

Before handoff, run the full repository source gate when the host can satisfy it:

```bash
bash ./scripts/agent-check full
```

The full gate does not pretend iOS proof exists. Set `PSYCHE_AGENT_CHECK_IOS=1` only on a compatible macOS host with the repository-pinned Xcode, simulator, and XcodeGen available. Physical-device and distribution claims always require their separate acceptance evidence.

## Risk and review

- **R1 — documentation or isolated tests:** ordinary focused review and relevant checks.
- **R2 — product behavior:** focused behavior tests, owning-surface checks, accessibility where applicable, and user-path evidence.
- **R3 — authority, security, protocol, persistence, recovery, or consequential actions:** threat/failure-boundary review, compatibility evidence, negative tests, and independent review before merge.
- **R4 — release, repository governance, credentials, generated-source ownership, or cross-repository identity:** explicit design/owner approval, exact-head required checks, durable acceptance evidence, rollback, and independent security/quality review.

Treat these as R3/R4 unless a narrower current contract proves otherwise:

- `src/control/**`, `src/services/bridge/**`, and `protocol-fixtures/**`;
- `native/desktop/psyche-build-tauri/src-tauri/**` and `native/ios/**`;
- `.github/workflows/**`, `.github/actions/**`, release scripts, signing/notarization/TestFlight paths, and package/toolchain pins;
- Project #11 configuration, tracker automation, and bulk GitHub issue mutations;
- authentication, capability leases, approvals, receipts, revocation, idempotency, persistence, cleanup, recovery, and migrations.

Never weaken project scope, authority, confirmation, receipt, revocation, idempotency, work preservation, or recovery behavior to make a test pass.

## Generated outputs

Edit generators and source inputs, not generated artifacts:

| Generated output | Canonical command |
|---|---|
| `src/utils/generated-agents-doc.ts` | `pnpm generate:hooks-docs` |
| `native/desktop/psyche-build-tauri/web/*.bundle.js` | `pnpm --dir native/desktop/psyche-build-tauri build:web` |
| `native/ios/Psyche.xcodeproj/**` and generated iOS `Info.plist` | `pnpm ios:project:generate` (verify with `pnpm ios:project:check`) |
| `dist/**` and built frontend output | `pnpm build` |

Generated changes must be reproducible, reviewed with their source change, and left clean after the documented check. Do not edit checked-in bundles by hand.

## Change discipline

1. Start from current `main` in one branch/worktree per outcome; do not push directly to protected `main`.
2. Inspect the current implementation and tests before changing behavior.
3. Preserve public commands, schemas, persisted formats, errors, and security boundaries unless an approved design explicitly changes them.
4. Add or identify failing focused tests before a behavior change, then run the owning surface and the applicable repository gate.
5. Keep one PR independently reviewable. Split unrelated product, architecture, tracker, and documentation work.
6. Record exact commands, exact head SHA, observed results, proof gaps, and rollback. Test counts do not substitute for production-path evidence.
7. Resolve every current review finding and wait for terminal required checks before merge.

Pushing branches, opening or merging PRs, applying GitHub issue or Project mutations, publishing packages/releases, changing repository settings, and using signing/distribution credentials are external side effects. Perform only the side effects explicitly authorized for the task.

## Protected data

Never put credentials, tokens, private keys, certificate or signing material, raw prompts, unrestricted terminal output, private repository contents, complete environment dumps, private infrastructure URLs, or unredacted personal paths in issues, pull requests, logs, fixtures, screenshots, or retained evidence. Prefer bounded enumerated state, sanitized identifiers, digests, and explicit omission/redaction manifests. Fail closed when a field cannot be shown safe.