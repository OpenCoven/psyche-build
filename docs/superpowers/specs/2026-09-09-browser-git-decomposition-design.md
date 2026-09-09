# Browser and Git control: boundary inventory

#197 slice 4. Written before any extraction, on the pattern slices 2 and 3
established: measure first, because the concern map's estimates have been
wrong more often than right, and a dependency closure gives size rather than
membership.

## Measured surface

`lib.rs` is 13,272 lines, of which 7,047 are production. Two capabilities
account for most of what remains.

| | Commands | Closure | Closure lines |
|---|---:|---:|---:|
| Browser | 15 | 56 fns | 1,853 |
| Git | 4 | 35 fns | 868 |

Counting types and `impl` blocks by name match adds roughly 2,400 and 2,100
lines respectively, but that match is crude — it catches
`RECENT_PTY_SNAPSHOTS` under "Snapshot" — so treat those as an upper bound to
be re-derived by reading, not as a measurement.

`browser_focus.rs` already exists at 782 lines and owns focus authority only.

## The two closures do not overlap

Zero functions are shared between them. Browser has **no member with three or
more callers outside its closure**; Git has two, `canonical_project_root` and
`resolve_project_path`, which are project-path helpers rather than Git.

This is the cleanest separation #197 has produced. Slices 2 and 3 both spent
their effort untangling closures that reached into lower layers; here the
question is not what to exclude but which capability to move first.

## What slice 3 left for this one

`linked_worktree_roots`, `verified_worktree_root` and `git_command` were
measured into three separate slice-3 steps and excluded from all of them,
because worktree identity is this slice's concern and has callers beyond PTY.
`pty_cwd` currently reaches back into the crate root for the first two. Moving
Git gives them a home and turns that reach into an ordinary module import.

## The safety net is again the larger half

Slice 3 ended with this recorded: a whole-file surface is a path coupling
wearing a different hat. Slice 4 inherits it at greater scale.

**Three test files read `lib.rs` by hardcoded path** and assert browser
behaviour: `tauriBrowserScriptAuthority`, `tauriBrowserFocusAuthority`,
`tauriBrowserCrossPlatformNavigation`.

**Nine more assert against `readDesktopCommandSurface()`**, which returns
`lib.rs` plus whichever file holds `tauri::generate_handler!`. The heaviest
are `tauriDesktopTabs` (31 whole-file assertions), `tauriWorkspacePanels`
(27) and `tauriBrowserLifecycle` (17).

`tauriBrowserLifecycle` is 8,104 lines but only seventeen of its assertions
read the surface; the rest is fixture data. The retargeting is therefore
bounded at roughly eighty assertions, which is large but not open-ended.

## Proposed order

Sizes must be re-derived by reading bodies before each step.

1. **Git control → `git_control.rs`.** The smaller capability, only two shared
   helpers, and it collects the worktree functions three slice-3 steps
   deliberately left behind. Doing it first removes `pty_cwd`'s reach into the
   crate root.
2. **Browser providers.** Larger, and probably more than one module:
   navigation, script and action approval, and semantic snapshots are
   separable concerns that happen to share a prefix. Decide by reading, not by
   the `browser_` name.

Whether `browser_focus.rs` should absorb any of step 2 is deliberately left
open. It owns focus authority today, and widening it to "everything browser"
would undo a boundary that already exists.

## What this record does not do

It does not authorise an extraction. It records what is there, what the two
closures do and do not share, and which safety net has to move with the code.
