## Summary

Slice 1 of the capability-negotiated Coven launch adapter (#279): prompt-backed provider launches (Codex, Claude, Copilot, Grok) are now accepted by the Coven daemon over its local `coven.daemon.v1` transport with the composer prompt in the launch request body — never in process argv, never in the persisted launch model — and the agent picker renders only harness capabilities confirmed by the selected Coven executable.

- **`coven_launch_session` (Rust):** `POST /api/v1/sessions` with `{projectRoot, cwd, harness, prompt, title}` after a pinned `coven.daemon.v1` health gate, on the existing bounded local transport (Unix socket / loopback TCP, 2s deadline, byte-capped). Inputs are bounded (prompt ≤ 8192 chars, paths, harness ids `[a-z0-9-]`), the title never defaults to the raw prompt (the daemon would echo it into `coven sessions` titles), and daemon rejections (400/403/404) surface their bounded error message.
- **`coven_launch_capabilities` (Rust):** daemon health at the pinned version plus the selected executable's own `coven adapter list --json` (timeout- and byte-bounded spawn), so capability confirmation comes from the executable itself, not from a hardcoded provider list.
- **Agent picker (web):** options render from the confirmed capability snapshot (15s TTL cache, single flight). Unconfirmed or missing harnesses render `aria-disabled` with an actionable reason *before* prompt submission; a missing/incompatible daemon fails closed with `coven daemon start` / update guidance.
- **Launch flow (web):** on daemon acceptance the pane attaches to the canonical Coven session (`coven attach <session-id>`, the existing `coven-attach` path), and the launch model keeps only the session identity plus an in-memory `sha256` prompt digest. The persisted workspace descriptor (v3) still stores only `launchKind`/`kind`/`covenSessionId` — no prompt, no argv, no digest.
- **Failure semantics:** launch outcomes map to `accepted` / `failed` / `recovery_required`; a rejected launch keeps the composer prompt, reports the daemon's actionable message, and creates no pane.

**Slice boundary:** this slice deliberately does not (yet) add restart/reconnect re-attach of daemon-accepted sessions that never got a pane, stream-mode (`--stream-json-input`) prompt transport, per-session launch receipts beyond the canonical session id, or the #253-gated immutable Psyche protocol profile pin. It is slice 1 of N; those follow.

Refs OpenCoven/psyche-build#279. PR #277 established the `coven run <provider>` direction; this addresses its argv-prompt and capability-negotiation gaps without claiming Psyche conformance (the immutable profile remains gated by #253).

## Issue

Refs OpenCoven/psyche-build#279

## Test plan

- [x] `pnpm vitest --run __tests__/tauriCovenLaunchAdapter.test.ts` (new; 8 tests: pinned `coven.daemon.v1` profile across JS/Rust, prompt-in-body/never-argv contract, prompt bounds on both sides, prompt-free persisted model, launch-state vocabulary, capability gating, defensive snapshot normalization, fail-closed recovery guidance)
- [x] `pnpm vitest --run __tests__/tauriAgentPicker.test.ts __tests__/tauriCovenLaunch.test.ts` (95 tests; registry gains `harness` ids, daemon launch path with body assertion, rejected/unavailable launch behavior, over-long prompt rejection, source-level launch-kind contracts updated)
- [x] `pnpm vitest --run __tests__/tauriCovenSessionNativeContract.test.ts __tests__/tauriDesktopTabs.test.ts __tests__/tauriSessionAttention.test.ts __tests__/agentRepositoryContract.test.ts __tests__/repositoryMapContract.test.ts` (command-registration, permission-TOML, and manifest contracts for the two new commands)
- [x] `pnpm typecheck` (clean; includes `tsconfig.test.json`)
- [x] Rust unit tests for the launch/capability transport (fake daemon servers: exact POST body bytes, 201 record parse, bounded rejection messages, incompatible version, unavailable mapping, allowlist, adapter-list parse and spawn) — **deferred to CI** (no cargo on this host)
- [x] Full `pnpm vitest` suite: parity with the pre-change baseline on this host (the remaining failures are pre-existing environment-dependent suites — macOS channels, detached process groups, socket transports — reproduced identically on pristine `main`)
- [ ] `cargo fmt --check` / `cargo test` / `cargo check` — deferred to CI (no Rust toolchain available locally)
- [ ] `bash ./scripts/agent-check full` — deferred to CI (requires cargo and packaged-artifact smoke)

## Remaining from #279

Restart/reconnect re-attach without prompt replay for daemon-accepted sessions, stream-mode prompt transport, launch receipts beyond the canonical session id, and the #253-gated compatibility canary against a published Coven profile.

> **Vehicle note:** opened in the fork CompleteDotTech/psyche-build as the CI vehicle — this token cannot write to OpenCoven/psyche-build. Re-target upstream once write access is restored. Refs OpenCoven/psyche-build#279.
