# GPU rendering stress harness contract

**Status:** Contract defined; runtime wiring open  
**Issue:** [OpenCoven/psyche-build#230](https://github.com/OpenCoven/psyche-build/issues/230) (Bead `psyche-z7c.4.4`, P1)  
**Parent slice:** [#229](https://github.com/OpenCoven/psyche-build/issues/229) — runtime graphics diagnostics and stress mode  
**Blocked by (runtime wiring):** [#231](https://github.com/OpenCoven/psyche-build/issues/231) — expose the in-app developer GPU diagnostics surface  
**Design plan:** [GPU ADE slice 4](../superpowers/plans/2026-08-10-gpu-ade-slice-4-diagnostics-stress.md)  
**Machine-checkable contract:** [`src/gpu/stressScenarios.ts`](../../src/gpu/stressScenarios.ts) (schema v1)  
**Related:** [`docs/gpu/VERIFICATION-MATRIX.md`](VERIFICATION-MATRIX.md) — the evidence matrix this harness feeds (issue #232)

This document defines the fixed, debug-authorized rendering stress harness: the
native steady/burst/rewrite fixtures, the deterministic 1/6/12/24-pane
scenarios with their exact warmup / measured / restore-and-context-loss phase
timing, the editor and local-browser adjacency, focus/geometry churn, hidden
panes, minimize/restore, cancellation cleanup, and the cross-platform
diagnostics launcher boundary. It is paired with a pure, machine-checkable
contract module so the scenario order, transitions, and authorization rules
are unit-tested — not folklore.

## Non-negotiable rules

1. **Authorization is both-or-nothing.** A stress run requires an explicit
   debug-build flag AND the startup environment authorization token
   (`PSYCHE_RENDER_DIAGNOSTICS=1`, captured once at process start). Missing
   either is rejected, a production (non-debug) build is rejected even if the
   token is present, and no runtime fallback, prompt, or re-check may relax
   this. This mirrors the native gate exactly: `stress_authorized_for` in
   `native/desktop/psyche-build-tauri/src-tauri/src/runtime_diagnostics.rs`
   authorizes only `debug_build && startup_value == "1"`.
2. **Arbitrary commands are rejected.** The native diagnostics spawn surface
   accepts only the fixed fixture enum — never a command string, executable
   path, or argument list. Command-shaped input fails closed with the typed
   `arbitrary-command-rejected` code; the harness has no mode in which a
   caller-supplied command is executed.
3. **Production stress commands are rejected.** Any stress invocation arriving
   from a production build, a release channel, or an unauthorized environment
   is rejected with a typed rejection code and must leave no partial state.
4. **No CSP or capability expansion.** The harness is data and debug-only
   runtime behavior; it must not require, propose, or produce any
   Content-Security-Policy relaxation or Tauri capability/permission expansion.
   A review that observes a CSP or capability diff versus the release base
   treats any weakening as a blocker.
5. **The harness never claims physical acceleration.** Stress runs exercise
   rendering paths and produce measurements. Acceleration classification is
   owned by the graphics probe and the verification matrix on physical
   hardware; a passing stress run on any machine — including CI runners — is
   never recorded as acceleration evidence.
6. **Protected data stays out.** Scenario reports carry counters, offsets,
   statuses, and scenario/fixture identifiers — never raw prompts, terminal
   content dumps, environment dumps, hostnames, or personal paths.
7. **Determinism.** Scenario order, phase timing, transition offsets, and
   fixture assignment are fixed constants, identical on every platform and
   every run. Randomized or wall-clock-dependent behavior is out of contract.

## Authorization model (`authorizeStressRun()`)

Both inputs are required — `authorizeStressRun({ debugBuild, startupAuthorizationToken })`
returns authorized only when **both** are present and valid:

| Input | Requirement | Rejection code when absent/invalid |
|---|---|---|
| `debugBuild` | Explicit boolean; must be `true` (debug build). Production builds are rejected even with a valid token. | `missing-debug-build` |
| `startupAuthorizationToken` | The exact `PSYCHE_RENDER_DIAGNOSTICS` value captured at startup; must be exactly the string `"1"`. | `missing-startup-authorization` (absent) · `invalid-startup-authorization` (any other value) |

The token is extracted once from the startup environment with
`startupAuthorizationTokenFromEnvironment()` and passed in — it is never read
lazily from `process.env` inside the contract module, so an authorization
decision is always reproducible from its inputs. Values such as `"0"`,
`"true"`, `" 1 "`, or an empty string are invalid, matching the native
`Some("1")` exact-match semantics.

Every other entry point is closed as well:

- `validateScenarioRequest()` accepts only `{ schemaVersion: 1 }` plus a known
  `scenarioId` (`panes-1`, `panes-6`, `panes-12`, `panes-24`), a known
  `paneCount` (`1`, `6`, `12`, `24`), or both in agreement. Unknown fields,
  unknown scenarios, unknown pane counts, conflicting selections, and schema
  drift are rejected with typed codes (`unknown-scenario`,
  `unknown-pane-count`, `unknown-field`, `unsupported-schema-version`,
  `conflicting-scenario-selection`, `malformed-request`).
- `validateFixtureSelection()` accepts only `steady`, `burst`, or `rewrite`.
  Command-shaped strings and objects carrying `command`/`exe`/`executable`/
  `argv`/`args`/`script` fields are rejected with
  `arbitrary-command-rejected`; other unknown names with `unknown-fixture`.

## Native fixtures (closed enum)

Each fixture is a fixed platform-native pattern selected by name; the native
side resolves its own executable/arguments internally, and each fixture emits
sequence numbers and ANSI output until stopped. The three names are the entire
spawn surface:

| Fixture | Behavior |
|---|---|
| `steady` | Constant-rate output at a fixed pace |
| `burst` | Fixed-size output bursts at a fixed duty cycle |
| `rewrite` | Repeated in-place line rewrites of a fixed-width region |

Within a scenario, terminal panes cycle through the enum in declaration order
by zero-based pane index (`assignPaneFixture(i)`): `steady`, `burst`,
`rewrite`, `steady`, ... — so every scenario exercises all three fixtures
deterministically.

## Scenarios and phase timing

Four deterministic scenarios, executed in pane order:

| Scenario | Panes | Total | Phases |
|---|---|---|---|
| `panes-1` | 1 | 45 s | 10 s warmup · 30 s measured · 5 s restore |
| `panes-6` | 6 | 45 s | 10 s warmup · 30 s measured · 5 s restore |
| `panes-12` | 12 | 45 s | 10 s warmup · 30 s measured · 5 s restore |
| `panes-24` | 24 | 45 s | 10 s warmup · 30 s measured · 5 s restore |

Every scenario uses the identical phase plan — the pane count changes the
workload, never the timing:

| Phase | Start | Duration | Content |
|---|---|---|---|
| `warmup` | 0 ms | 10 000 ms | Create all surfaces; no churn yet |
| `measured` | 10 000 ms | 30 000 ms | Focus/geometry churn active; hide, minimize, restore marks fire |
| `restore-context-loss` | 40 000 ms | 5 000 ms | Churn stopped; forced context loss and recovery verification |

## Deterministic phase-transition table

Identical for every scenario (pane count changes the workload, not the
schedule). Offsets are milliseconds from scenario start:

| Offset (`atMs`) | From → To | Event |
|---|---|---|
| 0 | `idle` → `warmup` | `create-surfaces` |
| 10 000 | `warmup` → `measured` | `begin-churn` |
| 15 000 | `measured` | `hide-panes` |
| 30 000 | `measured` | `minimize-window` |
| 35 000 | `measured` | `restore-window` |
| 40 000 | `measured` → `restore-context-loss` | `begin-context-loss` |
| 45 000 | `restore-context-loss` → `idle` | `dispose-all` |

During the measured phase the harness:

- cycles pane focus every 250 ms (`focusIntervalMs: 250`),
- churns deterministic split/sidebar geometry on every animation frame
  (`geometryChurn: 'per-frame'`),
- hides exactly half the panes at 15 s, selecting odd 1-based pane indexes
  (panes 1, 3, 5, …) per `hiddenPaneSelection: 'odd-index'`,
- minimizes the window at 30 s and restores it at 35 s through the validated
  native debug command.

At the restore boundary (40 s) churn stops and the harness triggers a
WebGL context loss (`WEBGL_lose_context` where supported) to exercise the
recovery path; hidden panes stay hidden through recovery and are unhidden
during cleanup.

### Surfaces and adjacency

Every scenario creates, in fixed adjacency order
(`editor-document`, `terminal-panes`, `local-browser-page`):

1. a generated large editor document (generated content only — never user
   documents or other private data),
2. the requested terminal panes (1/6/12/24), each bound to a native fixture by
   the deterministic cycling rule above, and
3. one local diagnostics browser page adjacent to the terminal panes.

### Native fixture-per-pane assignment

Panes cycle the closed fixture enum by zero-based index, so a six-pane
scenario runs `steady`, `burst`, `rewrite`, `steady`, `burst`, `rewrite` —
every scenario exercises all three fixtures in a fixed, repeatable order.

## Cancellation cleanup

A run may be cancelled at any point — during warmup, mid-measured, or during
restore/context-loss. Cleanup is a fixed, ordered plan independent of the
cancellation point (reverse acquisition order), and every step must end in
the `disposed` state:

| Order | Step |
|---|---|
| 1 | `stop-focus-geometry-churn` |
| 2 | `stop-native-fixtures` |
| 3 | `restore-window-state` |
| 4 | `unhide-panes` |
| 5 | `close-local-browser-page` |
| 6 | `dispose-editor-document` |
| 7 | `close-terminal-panes` |

Cleanup states are closed: `pending`, `disposed`, `failed`. A cancelled run
must finish with every step `disposed`; any `pending` step is reported as
`cleanup-incomplete` (a leaked resource), any `failed` step as
`cleanup-failed`, and missing, duplicated, or unknown steps are structural
rejections. `validateCancellationCleanupOutcome()` enforces all of the above.

## Cross-platform diagnostics launcher boundary

The diagnostics mode is launched exclusively through
`scripts/dev-tauri-diagnostics.mjs`, which is the only sanctioned path that
sets `PSYCHE_RENDER_DIAGNOSTICS=1` for a desktop dev session. Its required
boundary behavior (the script itself lands with the runtime-wiring slice; this
contract fixes the boundary):

- **Environment propagation:** the child is spawned with an explicit
  environment — the parent's environment plus `PSYCHE_RENDER_DIAGNOSTICS: '1'`
  — so the startup authorization token is present from the first frame.
- **Cross-platform spawn:** `node:child_process.spawn` with
  `shell: process.platform === 'win32'`, so the launcher behaves identically
  on macOS, Windows, and Linux without shell-specific syntax.
- **Exit and signal propagation:** the launcher exits with the child's exit
  code, and re-raises a child signal to itself (`process.kill(process.pid,
  signal)`) so Ctrl+C and termination signals propagate correctly on each
  platform.
- The launcher takes no free-form arguments; it wraps the fixed desktop dev
  command. It is a debug-development convenience and never ships in release
  builds.

The launcher script, the native `diagnostics_spawn_fixture` command, and the
in-app panel are runtime wiring owned by the dependent diagnostics-surface
slice (#231 chain); this slice ships the contract they must satisfy.

## Deterministic vs. measured

The scenario tables above are deterministic fixtures — the same order, timing,
and transitions on every machine. Frame-time percentiles, throughput, queue
depths, and CPU/RSS readouts are *measurements* collected by the metrics
layer (slice history: `psyche-z7c.4.3`) and judged only against the
verification matrix's targets on physical hardware. Nothing in this contract
converts a successful stress run into an acceleration, performance, or
support claim.

## Open gaps (explicit)

1. **Runtime wiring is not implemented in this slice.** The native spawn
   command, launcher script, and in-app diagnostics surface belong to the
   #231 chain; until they land, the contract here is exercised by unit tests
   only. That dependency chain is an open gap, not a silent assumption.
2. **No physical acceleration claim.** This contract never claims hardware
   acceleration on any platform; acceleration evidence is governed by
   [`docs/gpu/VERIFICATION-MATRIX.md`](VERIFICATION-MATRIX.md) and remains an
   open gap there.
3. **Rust-side mirror not included in this slice.** The native
   `runtime_diagnostics.rs` authorization semantics already exist and are
   mirrored here as constants; the enum-only native spawn command that will
   consume them requires command registration (behavior wiring) and lands with
   the dependent slice — see the working record for the full rationale.
