# Pane, PTY and process lifecycle: boundary inventory

#197 slice 3. Written before any extraction, for the reason slice 2 established:
the concern map's estimates were wrong three times out of five, and a
dependency closure gives the right size but not the right membership.

## Measured surface

`lib.rs` is 16,387 lines, of which 9,309 are production and 7,078 are five
inline test modules. It holds 43 Tauri commands, 243 free functions, 41 `impl`
blocks and 100 type declarations.

The pane/PTY/process concern inside it:

| | Count | Lines |
|---|---:|---:|
| Tauri commands | 12 | 178 |
| Free functions (closure of those commands) | 55 | 1,029 |
| `impl` blocks for PTY types | 11 | 722 |
| Type, enum and struct declarations | 33 | — |
| Inline `pty_runtime_tests` | — | 1,757 |

So roughly **1,750 lines of production code** plus its types, against a 9,309
line production file.

The commands themselves are 178 lines across twelve — thin wrappers. The
subsystem is in the helpers and the `impl` blocks, which is why counting
commands would have understated it by an order of magnitude.

`pty_transport.rs` already exists and owns a different thing: the output pump,
batching, backpressure and acknowledgement. Nothing in this inventory overlaps
it.

## What the closure drags in, and should not take

Four functions totalling 120 lines — `git_command`, `parse_git_worktrees`,
`linked_worktree_roots`, `validate_opened_pty_cwd` — enter the closure because
PTY working-directory validation checks git worktree identity. They belong to
slice 4. `git_command` alone has five callers outside this set.

This is the fourth time in #197 that a closure has pulled in a lower or
adjacent layer. Treat the closure as the scope of the reading, not the
membership of the slice.

## The blocker is the safety net, not the code

Slice 2 hit this once and fixed it in #364 before extracting anything. Slice 3
hits it much harder, and the fix has to land first.

**Nine test files read `lib.rs` by hardcoded path:**

`tauriPtyCallerSecurity`, `tauriCovenSessionLifecycle`,
`tauriCovenSessionNativeContract`, `tauriPaneSessionMetricsNativeContract`,
`tauriMetricsNativeContract`, `tauriDesktopPlatform`, `tauriBrowserFocusAuthority`,
`tauriBrowserScriptAuthority`, `tauriBrowserCrossPlatformNavigation`.

`tauriPtyCallerSecurity` is the clearest case. It slices the body of
`ensure_trusted_pty_caller` out of `lib.rs` and asserts the guard rejects
untrusted webviews. Move that function and the test fails with *function not
found* — reporting a missing function where the real risk is an unguarded one.
A test that cannot tell those apart is not a safety net.

**Thirteen more use `readDesktopCommandSurface()`**, which is better but still
does a flat `readdirSync` and returns only `lib.rs` plus whichever file holds
`tauri::generate_handler!`. A body moved to a sibling module leaves its view
too.

Both need to follow functions rather than paths, as
`nativeWorkspaceSurface.ts` was taught to in #364. That is the first PR of this
slice, and it is testable on its own: reintroduce the flat scan and the
assertions must fail.

## Proposed order

Sizes are from the measurement above and must be re-derived by reading bodies
before each step, not taken from this table.

1. **Teach the PTY and pane contracts to follow functions.** No production
   change. Prove it by reintroducing the path coupling and watching the
   assertions fail.
2. **Process termination and identity** — `PtyProcessTerminator` (125),
   `PtyProcessIdentity`, `PtyTerminationOutcome`, `UnixPtyIdentity` (58),
   `UnixPtyControl`, `WindowsProcessTreeKiller`, `PtySpawnTerminationGuard`.
   This is the slice's "stale identity detection" and "stop/close" clause and
   is the most self-contained group.
3. **Readers and exit shutdown** — `UnixPtyReader`, `WindowsPtyReader`,
   `PtyReaderCancellation` (75), `PtyExitShutdown` (133).
4. **Lifecycle registry** — `PtyLifecycleRegistry` (234) and its states,
   entries, errors and outcomes. Largest single `impl` in the subsystem.
5. **Start and attach** — `PendingPtyStart`, `PtyAttachOptions`, `OpenedPtyCwd`,
   `PtyStartResult`, and the start/attach helpers.

Metrics and visibility types are deliberately unscheduled. `PtyTransportMetrics`
and friends may belong with `pty_transport.rs` rather than with lifecycle, and
that question should be answered by reading them rather than by this document.

## What this record does not do

It does not authorise an extraction. It records what is there, what the closure
over-reports, and which safety net has to be repaired before any of it moves.
