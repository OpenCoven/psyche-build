# Mobile acceptance matrix (psyche-i7c.10.4)

**Status:** Definition and thresholds contract — **execution pending**; issue blocked
**Issue:** [OpenCoven/psyche-build#213](https://github.com/OpenCoven/psyche-build/issues/213) (`psyche-i7c.10.4`, P1)
**Parent:** [#209](https://github.com/OpenCoven/psyche-build/issues/209) — Phase 10: recovery, persistence, accessibility, and acceptance
**Canonical outcome:** [gh-200](https://github.com/OpenCoven/psyche-build/issues/200) — iOS companion delivery train
**Blocked by:** [#210](https://github.com/OpenCoven/psyche-build/issues/210) (bounded protected workspace cache), [#211](https://github.com/OpenCoven/psyche-build/issues/211) (stale-state reconciliation), [#212](https://github.com/OpenCoven/psyche-build/issues/212) (accessibility/motion semantics)
**Machine-checkable thresholds:** [`src/perf/acceptanceThresholds.ts`](../../src/perf/acceptanceThresholds.ts) (v1 — this document is the readable companion, not the source of truth)
**Production constants pinned at:** `main` commit `a4546f4`

This document defines the performance and full acceptance matrix for the mobile
cockpit: what is measured, what gates a run, and what may be documented as an
environment-only baseline instead of run. Nothing here claims a measurement that
has not happened: live iPhone/iPad measurement is impossible on the Linux
authoring host and remains an explicit, tracked gap until #213 execution
evidence lands.

## 1. Matrix areas and thresholds (v1)

`src/perf/acceptanceThresholds.ts` is the machine-checkable contract; the tables
below mirror it for review. Threshold classes:

- **production-mirror** — the value mirrors a constant that already ships in
  production code (source file cited). These are not proposals.
- **proposal** — a proposal default with an explicit rationale, pending #213
  execution evidence. Proposals gate nothing until evidence upgrades them.
- **to be measured** — no defensible number exists yet (`value: null`); the
  owning issue must pin it from measured evidence. Never invented silently.

### 1.1 Workspace serialization and event application

| Threshold id | Unit | Direction | Value | Warn | Class | Provenance |
|---|---|---|---|---|---|---|
| `snapshotSerializationMs` | ms | max | 100 | 80 | proposal | 100 ms instantaneous-response budget for the host control loop |
| `eventApplicationMs` | ms | max | 16 | 13 | proposal | one 60 Hz frame (~16.7 ms) so application never delays the next Core Animation commit |
| `snapshotEncodedBytes` | bytes | max | — | — | to be measured | owner #213; no production bound exists at `a4546f4` |

### 1.2 Event-stream and transport bounds

| Threshold id | Unit | Direction | Value | Warn | Class | Provenance |
|---|---|---|---|---|---|---|
| `paneOutputRingBytes` | bytes | max | 262144 | 209715 | production-mirror | `src/services/bridge/PaneOutputBuffer.ts` `DEFAULT_CAP` (256 KiB) |
| `clientFrameBytes` | bytes | max | 1048576 | 838860 | production-mirror | `src/services/bridge/WSSListener.ts` `MAX_CLIENT_FRAME_BYTES` (1 MiB) |
| `filePreviewBytes` | bytes | max | 200000 | 160000 | production-mirror | `src/utils/fileBrowser.ts` `MAX_PREVIEW_BYTES` |
| `controlStreamsPerConnection` | count | max | 4 | — | production-mirror | `src/services/bridge/BridgeDaemon.ts` `MAX_CONTROL_STREAMS_PER_CONNECTION` |
| `rememberedSpawns` | count | max | 128 | 102 | production-mirror | `src/services/bridge/MobileControlGateway.ts` `MAX_REMEMBERED_SPAWNS` |
| `pendingRemoteActions` | count | max | 64 | 51 | production-mirror | `RemoteActionSessions` `maxPending` in `src/services/bridge/MobileControlGateway.ts` |
| `remoteActionSessionTtlMs` | ms | max | 300000 | 240000 | production-mirror | `RemoteActionSessions` `ttlMs` (5 min) in `src/services/bridge/MobileControlGateway.ts` |
| `pairingAttempts` | count | max | 5 | — | production-mirror | `src/services/bridge/PairingFlow.ts` `PAIR_MAX_ATTEMPTS` |

### 1.3 Memory and session caps

| Threshold id | Unit | Direction | Value | Warn | Class | Provenance |
|---|---|---|---|---|---|---|
| `deviceResidentMemoryBytes` | bytes | max | — | — | to be measured | owner #213; requires on-device footprint profiling |
| `workspaceCacheBytes` | bytes | max | — | — | to be measured | owner #210; the bounded protected workspace cache owns its size limit |
| `cachedDrafts` | count | max | — | — | to be measured | owner #210; draft count/length bounds are #210 deliverables |

### 1.4 Navigation responsiveness

| Threshold id | Unit | Direction | Value | Warn | Class | Provenance |
|---|---|---|---|---|---|---|
| `navigationInputToPaintMs` | ms | max | 100 | 80 | proposal | 100 ms instantaneous-feedback budget for Now → split → pane switch → back |
| `reconnectToReadyMs` | ms | max | 2000 | 1600 | proposal | same-LAN reconnect must read as transitional against #211 stale/offline state |

Boundary semantics (both directions): an observation exactly at the limit is
**within** (matching the production bounded buffers' `<= maxBytes` behavior);
only strictly beyond the limit is a **breach**; the warn band sits strictly
between the warn boundary and the limit. Evaluating an observation against a
"to be measured" threshold throws instead of silently passing.

## 2. Automated gate list

A #213 execution run is complete when every gate below is terminal and green,
except the explicitly documented environment-only baselines (§3) and the live
scenario dependency (§4).

| # | Gate | Command (shape) | Where it runs | Notes |
|---|---|---|---|---|
| 1 | TypeScript unit suites | `npx pnpm exec vitest --run` | any host / Linux CI | Includes the threshold contract tests (`__tests__/mobileAcceptanceThresholds.test.ts`) |
| 2 | TypeScript strict typecheck | `npx pnpm exec tsc --noEmit` and `npx pnpm exec tsc -p tsconfig.test.json --noEmit` | any host / Linux CI | Source and test trees |
| 3 | Xcode project generation check | `pnpm ios:project:check` (XcodeGen regenerate + `git diff --exit-code` on the generated project and `Info.plist`) | macOS CI runner | Also satisfies the parent Phase 10 "project-generation" gate; requires the repo-pinned XcodeGen toolchain |
| 4 | PsycheCore suite | `xcodebuild test` over `native/ios/PsycheCore` (Swift package tests) | macOS CI runner, iOS simulator | Protocol/state/store coverage incl. snapshot and event application |
| 5 | iPhone suite | `xcodebuild test -destination '<iPhone simulator>'` over `native/ios/PsycheApp` | macOS CI runner, iPhone simulator | Unit + UI test targets |
| 6 | iPad suite | `xcodebuild test -destination '<iPad simulator>'` over `native/ios/PsycheApp` | macOS CI runner, iPad simulator | Layout/idiom coverage |
| 7 | One paired-host live scenario | §4 scripted run | physical device + same-LAN host | **When feasible**; otherwise the concrete unavailable dependency is documented per §4.3 |

Gate 1–2 status on the Linux authoring host: runnable locally (see the working
record for exact commands and results). Gates 3–6 require macOS/Xcode and are
not runnable on this host; they run in CI (skipped/changed-classified jobs count
as not-run, not as pass). Gate 7 additionally requires hardware that neither
this host nor standard CI provides.

## 3. Environment-only baselines (documented, not run)

These thresholds cannot be measured on the Linux authoring host or in ordinary
CI, so until #213 hardware execution they are recorded as baselines-without-
evidence rather than run gates. Each entry states what substitutes for a run.

| Baseline | Why it cannot run here | Accepted substitute evidence |
|---|---|---|
| `deviceResidentMemoryBytes` (device memory cap) | Footprint profiling needs Instruments on real hardware | A pinned `null` in the contract + "to be measured"; #213 execution records the measured footprint and pins the cap |
| `snapshotEncodedBytes` (largest observed snapshot) | Requires a live host connection with realistic workspace data | Contract pins `null`; #213 execution records the largest observed encoded payload |
| `workspaceCacheBytes`, `cachedDrafts` | Owned by #210, whose implementation does not exist at `a4546f4` | #210 pins the numbers; this matrix then adopts them (version bump, with citation) |
| `navigationInputToPaintMs`, `reconnectToReadyMs` | Signpost/transaction measurement needs a physical device build | Proposal values stand as documented defaults; §4 run records measured values |
| ProMotion/frame-cadence behavior | Per `docs/HIGH_REFRESH.md`, iOS cadence is a system capability, not a guarantee | Referenced, not re-measured: the desktop high-refresh document owns the platform boundary |

A baseline may be **documented instead of run** only when the working record
names the exact unavailable dependency and the matrix status log (§5) carries
the gap forward. Silent conversion of a "to be measured" threshold into a
number is a contract violation (the validator rejects it by construction:
non-null values cannot carry `status: 'to-be-measured'`).

## 4. Live paired-host scenario

### 4.1 Definition

One end-to-end scenario on a physical iPhone (and, when available, iPad) paired
over the same LAN to an authorized Psyche Build host running a reviewed build:

1. **Pair** — discover/pair the host; pairing succeeds within `pairingAttempts`
   (5) and the paired host identity is persisted before any workspace state is
   applied (Phase 1 readiness contract).
2. **Now** — the initial workspace snapshot restores the authoritative Now
   view; `snapshotSerializationMs` and `snapshotApplyMs`/`eventApplicationMs`
   within budget; only the paired host's state is shown.
3. **Split** — split into a two-pane layout; `controlStreamsPerConnection` (4)
   is never exceeded while both terminals stream.
4. **Input** — type into a terminal pane; input reaches the pane and output
   replays within the stream bounds (`paneOutputRingBytes` replay window, no
   gap markers during live streaming).
5. **File/diff** — open a file and a diff through mobile inspection; payloads
   stay within `filePreviewBytes`; oversized files truncate explicitly.
6. **Action** — execute one protected mobile action; the effect carries an
   authoritative receipt, respects `pendingRemoteActions`/`remoteActionSessionTtlMs`,
   and idempotent replay does not double-apply.
7. **Reconnect** — interrupt the transport (Wi-Fi blip or app background) and
   reconnect; ready state returns within `reconnectToReadyMs` (proposal) and
   stale/offline state is visibly transitional per #211, never masquerading as
   live state.

Pass criteria per step: the step completes and every threshold the step
references evaluates `within` (or `warn` with an explicit note); any `breach`
fails the scenario run.

### 4.2 Recording an execution

A run records: exact commands, head SHA, device model + OS version, host
version/SHA, network mode, per-step observations with units, evaluated
classifications (`evaluateObservation` output), and any warn/breach notes —
without secrets, raw transcripts, or unredacted personal paths (protected-data
rule). Evidence without provenance is discarded, per
`docs/RELEASE-ACCEPTANCE.md`.

### 4.3 Unavailable dependency — concrete record

The live scenario is **not executable** in the current environment. The
concrete unavailable dependency, to be recorded verbatim in the working record
and in the §5 status log until it is satisfied:

> Live paired-host scenario not run: requires (a) a physical iPhone/iPad with
> an authorized reviewed install build (gh-200 Phases 1–6 deliverables, incl.
> production ritual executor registration), and (b) a same-LAN authorized host
> with pairing credentials — neither exists on the Linux authoring host, which
> has no Xcode/iOS tooling, and neither is provided by CI runners. The
> simulator suites (gates 4–6) do not substitute for this run.

When the dependency is satisfied, #213 execution replaces this record with the
§4.2 evidence and updates the status log. Until then the issue remains blocked
by #210/#211/#212 and the scenario remains the open gap in the matrix.

## 5. Status log

| Date | Entry | Evidence |
|---|---|---|
| 2026-08-30 | Matrix and v1 thresholds contract defined (`src/perf/acceptanceThresholds.ts` + this document); no measurements claimed; production-mirror values pinned to constants at `a4546f4`; live scenario dependency documented per §4.3 | Working record `docs/working-records/issue-213-perf-acceptance-matrix.md`; fork PR CI (TypeScript gates) |

## 6. Change control

- Threshold changes require a version bump in
  `src/perf/acceptanceThresholds.ts` (`THRESHOLD_SET_VERSION`), a rationale
  citing the measurement or issue that justifies the change, and an update to
  the status log. `validateThresholdSet` enforces the shape so edits cannot
  silently drop provenance, warn bands, or owners.
- Production constants move first, mirrors follow: if a mirrored constant
  changes in code, updating the mirror in the same PR is required, with the
  rationale citing the new source.
- This document never overrides `docs/SUPPORT-MATRIX.md` availability claims:
  iOS remains **Planned internal beta pending #200**; nothing here constitutes
  device or distribution evidence.
