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

## What was done

All five steps landed. `lib.rs` went from 16,387 lines to 13,268, and five
modules now hold what came out.

| Step | Module | Lines | PR |
|---|---|---:|---|
| 1 | *(contracts follow functions)* | — | #386 |
| 2 | `pty_process` | 1,570 | #387 |
| 3 | `pty_reader` | 491 | #390 |
| 4 | `pty_lifecycle` | 507 | #391 |
| 5a | `pty_cwd` | 290 | #392 |
| 5b | `pty_launch` | 487 | this |

Step 5 was scoped as one thing and turned out to be two. "Start and attach"
spanned nine separate regions of `lib.rs` and interleaved with the git
worktree helpers that belong to slice 4, so working-directory resolution went
first as a contiguous, self-contained half and the commands followed.

Three things this record did not anticipate, each worth carrying into slices
4 and 5:

**A module cannot share a name with a Tauri command it defines.** `app.rs`
globs the crate root to build `generate_handler!`, so `mod pty_start` and
`fn pty_start` collide there. The module is `pty_launch` for that reason, and
the command name — which is IPC contract — was never a candidate to change.

**A command in a submodule must be `pub(crate)`.** `#[tauri::command]`
generates a macro with the function's own visibility, so a private command in
a submodule leaves `generate_handler!` unable to find it. That in turn meant
teaching two contract helpers that a command signature may carry visibility.

**The safety net cost more than the extractions.** Step 1 was written to stop
a moved function reading as a deleted one, and it worked, but nine further
contract files still asserted against a whole-file surface. Every step after
the first spent as much effort retargeting assertions as moving code. The
lesson is not that the assertions were wrong — they describe real sequences
that now legitimately span files — but that a whole-file surface is a path
coupling wearing a different hat.

## Order as proposed

Sizes were from the original measurement and were re-derived by reading bodies
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
   `PtyStartResult`, and the start/attach helpers. Split in two on contact:
   `pty_cwd` for working-directory resolution, `pty_launch` for reservation,
   launch validation and the commands.

`native_launch_command` was measured into this slice and left out of it. Its
only caller is `native_sessions`, so it belongs to that capability; it is a
candidate for a later move rather than an omission.

Metrics and visibility types are deliberately unscheduled. `PtyTransportMetrics`
and friends may belong with `pty_transport.rs` rather than with lifecycle, and
that question should be answered by reading them rather than by this document.

## What this record does not do

It does not authorise an extraction. It records what is there, what the closure
over-reports, and which safety net has to be repaired before any of it moves.
