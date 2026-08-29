# Contributing to Psyche Build

Psyche Build is OpenCoven's local-first coding cockpit. Contributions should be small enough to understand, explicit about authority and compatibility, reproducible from a clean checkout, and honest about what their evidence proves.

Start with [AGENTS.md](AGENTS.md) and the [repository map](docs/REPOSITORY-MAP.md). Those documents route work to the current architecture, support, security, release, and Psyche-compatibility authorities.

## Public contributor loop

### 1. Prerequisites

The repository derives its exact package-manager contract from `package.json`. You need:

- Node.js satisfying `package.json#engines.node`;
- the exact pnpm version in `package.json#packageManager`;
- Git;
- tmux for the full source smoke path;
- Rust/Cargo for the full desktop gate;
- macOS with the pinned Xcode/XcodeGen toolchain only when validating the iOS surface.

Do not rely on maintainer-global configuration, credentials, private repositories, or ambient tokens for ordinary bootstrap and validation.

### 2. Bootstrap from a clean checkout

Use the repository-owned interface rather than reconstructing toolchain commands from CI:

```bash
bash ./scripts/agent-bootstrap
```

Bootstrap installs the locked dependency graph and must leave repository state unchanged. If it cannot satisfy the pinned environment without mutating the checkout, it fails instead of silently repairing source state.

### 3. Choose the smallest owning surface

Before editing, identify the canonical owner in `docs/REPOSITORY-MAP.md` and the relevant scoped authority document. In particular:

- product/UI/process state is not durable Psyche identity;
- guarded actions must preserve capability, approval, receipt, revocation, idempotency, persistence, and recovery boundaries;
- Beads owns generated mirror source state; generated GitHub mirror bodies are not durable edit targets;
- generated source must be changed through its named generator;
- support and release claims require the evidence named by `docs/SUPPORT-MATRIX.md` and `docs/RELEASE-ACCEPTANCE.md`.

For Beads-specific operation, migration, synchronization, and credential boundaries, use [`.beads/README.md`](.beads/README.md). Maintainer-only tracker credentials are not part of the public contributor loop.

### 4. Run focused proof while iterating

Run the smallest relevant test or build for the surface you changed. Examples include:

```bash
pnpm vitest --run __tests__/agentRepositoryContract.test.ts
pnpm vitest --run __tests__/repositoryMapContract.test.ts
pnpm typecheck
cargo check --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --locked
```

For generated surfaces, use the canonical generator/check rather than hand-editing output:

```bash
pnpm generate:hooks-docs
pnpm --dir native/desktop/psyche-build-tauri build:web
pnpm ios:project:generate
pnpm ios:project:check
pnpm build
```

The iOS project check is meaningful only on the compatible macOS/Xcode host described in `AGENTS.md`; an unrun platform gate is **not** a pass.

### 5. Run the repository handoff gate

For a bounded TypeScript/docs/repository-contract iteration:

```bash
bash ./scripts/agent-check fast
```

Before handing off a change that affects runtime behavior, architecture, generated desktop output, packaging, persistence, authority, recovery, or another high-risk surface, run:

```bash
bash ./scripts/agent-check full
```

The full gate covers the unit/contract suite, docs checks/build, typecheck, source smoke, packaged-artifact smoke, deterministic desktop web generation, Rust formatting/tests/checks, and exact worktree cleanliness. iOS remains an explicit opt-in platform gate; physical-device, signing, TestFlight, and distribution evidence are governed separately by release acceptance.

## Pull-request scope

Use one branch/worktree for one reviewable outcome. A PR should have one primary behavior or contract change and a rollback story that remains understandable without reading unrelated work.

As a **split heuristic**, prefer keeping a PR below approximately **800 non-generated changed lines**. This is not a mechanical limit: generated artifacts, fixtures, migrations, or a tightly coupled mechanical move may legitimately exceed it. When substantially exceeding the heuristic, explain in the PR why splitting would make the change less safe, less testable, or break an atomic compatibility boundary.

Do not combine broad visual redesign, architecture extraction, schema migration, and behavior changes merely because they touch the same large entry point. The active decomposition contract is issue #197.

## When a design record is required

A maintainer may require a focused design/ADR **before implementation** when a change:

- creates or changes a public/protocol schema or persisted format;
- changes identity, capability, lease, approval, receipt, revocation, or recovery semantics;
- changes cross-repository canonical ownership;
- changes a release/security boundary or migration strategy;
- introduces a new external side effect, credential, network trust, or authority path;
- cannot be safely explained within the normal PR scope heuristic.

The design requirement exists to protect compatibility and authority boundaries, not to make small local changes bureaucratic.

## PR evidence packet

Every substantive PR should make the following inspectable in its description:

- **Objective and acceptance criteria** — what becomes true when merged.
- **Non-goals** — adjacent behavior deliberately not changed.
- **Files/surfaces intentionally touched** — especially generated or R3/R4 surfaces.
- **Canonical contracts consulted** — architecture, support, security, protocol, or release authority.
- **Focused verification** — exact commands and outcomes.
- **Full-gate status** — run, not applicable with reason, or blocked with explicit evidence.
- **Authority/security impact** — whether capability, approval, data, credentials, network, or external effects change.
- **Migration and rollback** — when persisted/public behavior changes.
- **Generated artifacts and provenance** — generator command and parity result.
- **Cross-repository canaries** — when a producer/consumer contract changes.
- **Remaining uncertainty** — anything not proven by the supplied evidence.

Use [`.github/pull_request_template.md`](.github/pull_request_template.md) as the executable checklist.

## Merge gate

A change is not merge-ready merely because its local tests pass. Before merge:

- required exact-head GitHub checks must succeed;
- unresolved current review threads/findings must be resolved or explicitly superseded by new evidence;
- generated outputs must match canonical inputs;
- required support/security/release evidence must be present for any claim being made;
- no protected data may appear in the PR, logs, fixtures, screenshots, or issue discussion.

Colleague availability is not an implementation dependency when repository policy allows an authorized owner path, but bypassing a person must never be treated as bypassing required checks or evidence.

## Evidence is claim-scoped

Test counts, source presence, successful hosted compilation, simulator success, documentation, or a merged PR do **not** by themselves prove a production user path, physical-device support, release availability, persistence safety, or protocol conformance.

Use:

- `docs/SUPPORT-MATRIX.md` for what may be claimed as supported;
- `docs/RELEASE-ACCEPTANCE.md` for immutable publication/user-path proof;
- `docs/TRACKER-INTEGRITY.md` for generated mirror reconciliation;
- `docs/PSYCHE-COMPATIBILITY-MAP.md` for the current Build/Psyche boundary;
- `docs/CONTRIBUTOR-SAFETY.md` for public-data and generated-source rules.

## Security and support

Do not publish tokens, passwords, private keys, signing material, raw private prompts, unrestricted terminal history, private repository contents, private service URLs, or unredacted personal paths.

- Security vulnerabilities: follow [SECURITY.md](SECURITY.md) and use GitHub's private vulnerability-reporting route.
- Ordinary support: follow [SUPPORT.md](SUPPORT.md).
- Product status and active priorities: use [docs/ROADMAP.md](docs/ROADMAP.md).
- Historical design context: use [`docs/superpowers/README.md`](docs/superpowers/README.md); dated records are not an executable backlog.

## Local application channels

For a protected daily-use macOS build from an explicit tested Git ref:

```bash
pnpm app:stable -- <git-ref>
```

For an experimental local build from the current checkout:

```bash
pnpm app:dev
```

Neither command creates a signed/notarized public release. Publication is governed by [docs/RELEASE.md](docs/RELEASE.md) and requires the corresponding protected release evidence.
