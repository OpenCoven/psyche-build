# Working record — issue 216, Bonjour discovery → connectable host flow (design + reference logic)

- Issue: [OpenCoven/psyche-build#216](https://github.com/OpenCoven/psyche-build/issues/216) — `[psyche-i7c.11]` Wire Bonjour discovery into a connectable host flow (Bead `psyche-i7c.11`, P1)
- Branch: `psyche/issue-216-bonjour-discovery-flow` (worktree `/home/node/trees/issue-216`, based on `origin/main` at `a4546f4`)
- Date: 2026-08-30
- Executor: delegated issue agent (fork pipeline per runbook; upstream writes token-denied)

## Outcome

Shipped the connectable-host-flow design and platform-neutral reference logic for Bead `psyche-i7c.11`, without touching any Swift runtime code (documented gap; the iOS track owns it):

1. `docs/mobile/BONJOUR-CONNECT-FLOW.md` — the connect flow design: verified current-state gap analysis (Phase 3 shipped `BonjourHostParser`/`BonjourHostDiscovery`/`NetServiceBonjourResolver` with nothing consuming them; `ConnectionManager.connectToStoredHost()` picks `hosts().first`), the end-to-end flow with the resolution state machine (`discovered → resolving → resolved | resolveFailed | disappeared`), the service→`HostEndpoint` resolution strategy (decision: keep the shipped `NetService` resolver over fusing resolution into `NWConnection`, with the rationale), pairing-status integration via `PairedHostStore.pairingStatus` (changed fingerprint ⇒ re-pair, never connectable), the deliberate host-selection rule replacing `hosts().first`, stale/disappeared handling, the exact `ConnectionManager`/`PairedHostStore`/`AppModel` changes as a spec for the Swift owner, the acceptance-criteria mapping, and the TS↔Swift mapping table.
2. `src/mobile/discoveredHostFlow.ts` — versioned (v1) pure reference module: strict record/candidate parsing (unknown fields rejected, typed problems, fails closed), `advanceResolution` (total resolution state machine with typed rejections; `resolveFailed` requires an actionable reason and drops the stale endpoint), `reconcileBrowseBatch` + `expireStaleEntries` (stale/disappeared handling; caller-supplied ticks, no clock), `selectDiscoveredHost` (explicit user selection first; sole connectable host; deterministic `serverID` + endpoint-uniqueness tie-break with alternates; `deliberate-selection-required` instead of any silent pick; conflicting fingerprints and malformed candidates fail closed), `pairingTransition` + exhaustive `PAIRING_TRANSITIONS` table (`requiresRePairing` exits only via confirmed re-pair or forget), and `normalizeCertificateFingerprint`/`resolvePairingStatus` mirroring `PinnedCertificateDelegate.normalizeFingerprint` and `PairedHostStore.pairingStatus`. No I/O, deterministic.
3. `__tests__/discoveredHostFlow.test.ts` — 41 focused tests covering every required focus: deterministic selection with duplicate service names (same identity, different endpoints → `stable-ordering-tie-break` with ordered alternates; same name across identities → deliberate selection required, ordered deterministically), unresolved service cannot become a candidate for connect, disappeared service removed from candidates (batch reconciliation and expiry), exhaustive pairing transitions (every state × event kind checked against the exported table; no untabled combination), unknown fields rejected (record, candidate, nested endpoint/identity/service-key objects), plus fingerprint normalization, resolution totality (state × event), re-pair gating, and an end-to-end browse→resolve→select→pair walk.

## Scope and boundaries

- Files touched: `src/mobile/discoveredHostFlow.ts`, `__tests__/discoveredHostFlow.test.ts`, `docs/mobile/BONJOUR-CONNECT-FLOW.md`, `docs/working-records/issue-216-bonjour-discovery-flow.md`. New files are issue-namespaced; `src/mobile/` and `docs/mobile/` are established by the sibling #209 slice's conventions (`src/mobile/phase10Gate.ts`, `docs/mobile/PHASE-10-RECOVERY-PLAN.md`), and no file here collides with any sibling slice path.
- No edits to `.github/**`, `.beads/**`, `pnpm-lock.yaml`, `package.json` deps, `docs/ROADMAP.md`, `docs/SUPPORT-MATRIX.md`, barrel/index files, or any generated output.
- Not done (owned elsewhere): the Swift implementation of the flow (ConnectionManager/PairedHostStore/discovery consumer/UI changes are specced in the doc, not implemented); `native/ios/**` untouched; no changes to pairing/persistence semantics anywhere.
- No behavior of existing product code changes; the module is additive and referenced by nothing outside its tests and the design document.

## Risk class

**R1** — documentation plus an isolated, additive module with focused tests. The reference module holds no authority, persists nothing, performs no I/O, and infers no runtime state (per AGENTS.md risk table this is ordinary focused review + relevant checks). The Swift implementation that would consume it is R2/R3 and carries its own review/evidence bar, which the design document states explicitly.

## Exact commands and results

All commands run from `/home/node/trees/issue-216` (Node v24, pnpm 10.34.5 via npx):

| Command | Result |
|---|---|
| `npx pnpm install --frozen-lockfile` | OK — `Lockfile is up to date, resolution step is skipped … Done in 837ms` |
| `npx pnpm exec vitest --run __tests__/discoveredHostFlow.test.ts` | OK — `Test Files 1 passed (1)`, `Tests 41 passed (41)` (final run; earlier iterations: 40/41 until the happy-path test was corrected to attach parsed identity before resolving, which the module intentionally requires) |
| `npx pnpm exec tsc --noEmit` | OK — exit 0, no output |
| `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | OK — exit 0, no output (after fixing one test-side literal that strict mode rejected: `state: 'resolving'` needed an explicit `DiscoveredServiceRecord` annotation) |
| `git diff --check` | OK — exit 0, no output |

One implementation-iteration note: the first selection implementation surfaced per-candidate failure reasons from a helper that a `DiscoveredHostCandidate` (always `resolved` by parser construction) could never exercise; the dead helper was removed and rejection reasons now flow from the pairing gate and parser problems, which is where they can actually occur.

## Exact head SHA

- The deliverable commit (module, tests, design doc, working record; all verification above ran against this tree) is the branch head reported in the PR body and status comment — a commit cannot contain its own hash, so the SHA is recorded in the PR body and visible via `gh pr view` on the fork.

## Test counts

- New focused suite: `__tests__/discoveredHostFlow.test.ts` — 41 tests, 41 passed, 0 failed.
- Full repository suite and `agent-check`: **not run here** — see proof gaps.

## Proof gaps

- **No local iOS/Xcode proof.** This host has no Xcode/iOS tooling; no simulator, device, TestFlight, or Bonjour-on-LAN runtime evidence exists or is claimed. `NWBrowser`/`NetService` resolution behavior on a real network is verified nowhere in this slice; the design's resolution strategy is derived from the shipped Swift sources and Apple framework semantics, not from a live run. iOS acceptance proof for #216 belongs to the iOS implementation slice on capable hosts/CI.
- **No local tmux; `scripts/agent-bootstrap` and `scripts/agent-check` not run** (runbook: they require tmux, unavailable on this host).
- **No Rust/toolchain proof.** No Rust or cargo work was touched or run.
- **Full repository vitest suite not run locally**; the fork's CI Quality gate runs the repository suite on this PR, and that run is the recorded evidence for the rest of the tree.
- **Swift-side behavior is unproven.** The `ConnectionManager`/`PairedHostStore`/discovery-consumer changes specified in the design document are not implemented, compiled, or tested here; no claim is made that a discovered host can actually be connected to on a device today. That implementation gap is the point of the issue and remains open on the Beads source.
- **Beads source not directly queried** (Beads CLI availability not guaranteed on this host); scope and acceptance criteria were transcribed from the generated GitHub mirror body of #216 on 2026-08-30, and the canonical post-release outcome note (gh-200 as source of truth for the remaining post-release track) is respected in the design document.

## Rollback notes

- Revert the single deliverable commit (or close the PR) to remove all four files. Nothing generated, no dependencies, no shared configs, and no other agents' paths are touched, so rollback is clean and complete.
- The reference module is unreferenced by product code; deleting it cannot affect runtime behavior.

## Security and privacy

- No credentials, tokens, private keys, certificate material, raw prompts, unrestricted terminal output, private repo contents, environment dumps, private infrastructure URLs, or unredacted personal paths appear in any file, PR, or comment. Fingerprint-shaped test fixtures are synthetic single-hex-repeated strings, and endpoint hosts in fixtures are RFC 1918 example addresses (`192.168.1.x`, `10.0.0.x`) — no real hostnames, tokens, or fingerprints.
- The design document explicitly preserves the security boundaries the flow depends on: TXT is attacker-controlled display input, the certificate fingerprint is pinned and verified at connect time, and only an explicit user-confirmed re-pair (`replace`) can rewrite a pinned fingerprint.
