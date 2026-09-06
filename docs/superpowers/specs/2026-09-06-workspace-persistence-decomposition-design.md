# Workspace persistence and recovery decomposition

**Status:** Design record for [#197](https://github.com/OpenCoven/psyche-build/issues/197) slice 2  
**Date:** 2026-09-06  
**Scope:** `native/desktop/psyche-build-tauri/src-tauri/src/native_workspace.rs`

Slice 2 of the desktop decomposition asks to "separate persisted schema,
migration, save scheduling, atomic publication, restore, corruption
quarantine, and recovery decisions." This record measures where those concerns
actually live before any code moves, so extraction is planned against the
module as it is rather than as it is imagined.

## Why a design record before an extraction

Slice 1 moved the composition root: a 100-line relocation with a mechanically
checkable contract, the 61-command registration. Slice 2 has no equivalent
single artifact. The concerns it names are interleaved across 131 functions,
and picking a seam by intuition risks a refactor that looks like progress
while leaving the stated scope untouched.

The per-slice contract also caps a slice at roughly 800 non-generated changed
lines. The module's production half is 5,450 lines, so slice 2 is necessarily
several extractions, and their order matters.

## Measured shape

`native_workspace.rs` is 8,586 lines: **5,450 production** and **3,136 test**.
The production half holds **131 functions**.

Two line counts appear below and measure different spans. Production is lines
1-5,450, ending where the test module begins. The per-concern table sums
function bodies, which total 5,409 lines; the 41-line difference is the
imports, type definitions, and constants that precede the first function.

Mapping each function to the concern it serves:

| Concern | Functions | Production lines | Share |
|---|---:|---:|---:|
| Recovery decisions | 49 | 2,372 | 44% |
| Atomic publication | 11 | 864 | 16% |
| Filesystem primitives | 20 | 574 | 11% |
| Transaction finishing and verification | 18 | 556 | 10% |
| Restore and backup | 14 | 458 | 8% |
| Save scheduling and locking | 4 | 175 | 3% |
| Path derivation | 7 | 173 | 3% |
| Load | 5 | 159 | 3% |
| Schema and migration | 3 | 78 | 1% |

The five largest functions are `save_workspace_to_inner` (550),
`recover_pending_rollback_state` (155), `open_workspace_lock` (147),
`restore_workspace_backup_in` (145), and `open_directory_component` (130).

## What the measurement says

**Recovery decisions are the concentration, not persistence.** They are 44% of
the module across 49 functions: rollback state, marker handling, forward and
prior-workspace certification, ambiguity resolution, and reassertion. The
module is named for workspace persistence but is mostly a recovery decision
engine.

**Schema and migration are almost absent.** Three functions, 78 lines. Slice 2
names them as concerns to separate, but there is little to separate; the
persisted format is validated rather than migrated. An extraction plan should
not invent structure for a concern the code does not have.

**One function is 10% of the concern it belongs to.** `save_workspace_to_inner`
at 550 lines is atomic publication, transaction finishing, and fault injection
in one body. It is the single largest obstacle to testing publication
independently of recovery.

## Correction: the first order was derived from names, not dependencies

The extraction order below was written from a concern map built by function
naming. A trial extraction of the filesystem primitives failed to compile and
showed that map is not a safe basis for ordering.

**The primitives are not a leaf layer.** `open_temp_file_in` calls
`open_new_workspace_file`, which is workspace-level code, so the dependency
runs in both directions rather than bottom-up. Half the cluster — ten of the twenty
members, including `open_existing_regular_file`, `regular_file_exists`, and
`open_workspace_lock` — also reference `SecureWorkspaceDir`, so the claim that
these are "generic helpers with no workspace semantics" was wrong.

**Two functions were miscategorized entirely.** `publish_opened_workspace_file`
and `publish_opened_restore_candidate` matched the `publish_opened` name
pattern but call verification and fault-injection helpers; they belong to
publication, not primitives.

**The module's real structure is depth, not concern.** Its 137 free functions
(138 definitions; `ensure_workspace_storage_supported` is a `cfg`-gated pair)
form a dependency graph 16 levels deep with **no cycles**:

| Depth | Functions | Lines |
|---:|---:|---:|
| 0 (leaves) | 41 | 663 |
| 1-3 | 34 | 1,094 |
| 4-7 | 30 | 1,274 |
| 8-11 | 15 | 1,164 |
| 12-15 | 17 | 764 |

No cycles means the module is decomposable. Depth means it must be taken
bottom-up, and a concern is not an extractable unit: the 41 depth-0 leaves are
spread across every concern in the module rather than pooling in one.

**The extractable unit is a dependency-closed set**, not a named concern.

## Why the first correction's numbers were also wrong

The counts in the first correction (131 functions, a 14-function set of 408
lines, 43 callers) came from a scan whose regex matched only a bare `fn ` at
column zero. The module also declares seven `pub(crate) fn` entry points, which
the scan could not see. Those seven sit at the top of the graph, so their
absence did not just undercount functions — it deleted every call edge running
out of them, which changed the computed depths and shrank the closure.

The figures in this document now come from a scan that accepts `pub`,
`pub(crate)`, `unsafe`, and `async` prefixes, and they were checked two ways:
by confirming no member of the set calls anything outside it, and by counting
the declaration forms in the file directly (131 bare `fn` + 7 `pub(crate) fn`
= 138 definitions, 137 distinct names).

The lesson is the one the trial extraction already taught, applied to the
measurement rather than the plan: a number derived from a pattern match is a
hypothesis until something independent agrees with it. The first correction was
right that the extractable unit is a dependency-closed set, and right about the
child-module shape and carrying imports. It was wrong about every quantity it
used to argue the point.

## Corrected first step

Two closed sets exist at the bottom of the graph. Neither pulls in anything
beyond itself, verified by computing the transitive closure:

| Option | Functions | Lines | Coupling |
|---|---:|---:|---|
| Syscall and FD layer | 20 | 734 | Ten members need `use super::SecureWorkspaceDir` |
| Type-free subset | 10 | 237 | References no workspace type |

Prefer the 20-function set. It is the larger reduction, and importing one type
from the parent is a smaller cost than leaving ten tightly related functions
behind. Fifty parent functions call into the set, so the parent needs a
matching import list either way.

Its members, all currently private to the module:

| Function | Lines | | Function | Lines |
|---|---:|---|---|---:|
| `open_directory_component` | 128 | | `fstatat_child` | 24 |
| `open_existing_regular_file` | 91 | | `unlink_workspace_path` | 18 |
| `open_workspace_lock` | 79 | | `set_secure_regular_file_permissions` | 17 |
| `workspace_directory_entries` | 76 | | `fstat_fd` | 11 |
| `verify_opened_regular_file` | 56 | | `require_new_regular_file_path` | 10 |
| `open_new_workspace_file` | 55 | | `set_secure_directory_permissions_fd` | 10 |
| `regular_file_exists` | 42 | | `c_path` | 4 |
| `rename_workspace_path_in` | 38 | | `c_name` | 3 |
| `open_directory_path_no_follow_optional` | 34 | | `same_inode` | 3 |
| `hard_link_workspace_path` | 32 | | `stat_is_type` | 3 |

Move it as a **child module** (`native_workspace/secure_fs.rs`, declared from
`native_workspace.rs`) with `pub(super)` visibility rather than a sibling with
`pub(crate)`. Edition 2021 supports that layout, and it keeps all twenty
security primitives visible only to their parent instead of widening them
crate-wide — which the original plan would have done as an unremarked side
effect. All twenty are private `fn` today, so `pub(super)` is available for
every member; none is one of the module's seven `pub(crate)` entry points.

Carry each moved function's `use` statements with it. The trial move relocated
bodies without imports and failed on unresolved `OsStr`, `CString`, and `fs`.

## Proposed extraction order

Each step is independently reviewable and preserves public behavior. Steps 1
and 2 have been measured against the current source. Steps 3 to 6 are still
estimates from the original concern map and must be re-derived from the call
graph before each is started — step 2 shows why: its function count was more
than double the estimate even though its line count was close.

1. **Syscall and FD layer → `native_workspace/secure_fs.rs`** (734 lines, 20
   functions, dependency-closed). **Landed in #366.** The move took 735 lines
   out of the parent and needed only 14 of the 20 to be `pub(super)`; the other
   six turned out to be unreachable from the parent, so the extraction narrowed
   the security surface rather than merely relocating it. This supersedes the
   original "filesystem primitives, ~574 lines, 20 functions" step. That step
   named the same number of functions but a different set of them, one that was
   not dependency-closed and would not compile. See the correction above.

2. **Path derivation → `workspace_paths.rs`** (160 lines, 16 functions,
   dependency-closed, measured after step 1 landed). Pure functions deriving
   temp, lock, rollback, and restore-candidate paths. Nine functions in the
   parent call into the set.

   The original estimate said 7 functions. The closure is 16 because
   `validate_workspace_artifact_paths` pulls in `validate_rollback_candidates`
   and `workspace_rollback_candidate_prefix`, and because the estimate counted
   the `workspace_*_path` family as one item rather than the eleven separate
   three-line functions it is. The line count was close by coincidence, not
   because the set was understood.

3. **Restore and backup → `workspace_restore.rs`** (~458 lines, 14 functions).
   Cohesive and only reachable through recovery entry points.

4. **Split `save_workspace_to_inner`** before moving publication. Separating
   the fault-injection hooks and transaction finishing from the publication
   sequence is a prerequisite for step 5, not an optional cleanup.

5. **Atomic publication → `workspace_publish.rs`** (~864 lines, 11 functions),
   once step 4 has reduced the largest body.

6. **Recovery decisions → `workspace_recovery.rs`** (~2,372 lines, 49
   functions), last and probably as several slices of its own. It is the
   largest surface and the one whose invariants are hardest to preserve, so it
   should move only after the layers beneath it are stable and independently
   tested.

Schema and migration are deliberately not given a step. At 78 lines they
belong with load and validation rather than a module of their own.

## Constraints every step must honour

- **Security surface.** The filesystem primitives are symlink and TOCTOU
  defences. `__tests__/tauriNativeWorkspaceSecurity.test.ts` asserts their
  bodies by reading this file, so it must follow the functions rather than the
  path, exactly as the desktop contract tests were taught to follow the
  composition root in #361.
- **`cfg` gating crosses the module boundary.** Import parent items by name,
  never with `use super::*;`, and gate each import exactly as the parent gates
  the declaration. Step 1 imported the `#[cfg(unix)]` type `PinnedDirectory`
  unconditionally and broke the Windows build with `E0432`. No host check on
  macOS or Linux can catch that class of error, because both satisfy
  `cfg(unix)`; only the Windows leg of CI can. Treat a green host build as
  silent on `cfg` correctness.
- **Visibility widening.** Most of these functions are private to the module.
  Moving them to sibling modules requires `pub(crate)`, which widens their
  reachable surface. That is a real change to a security-sensitive layer and
  should be stated in each PR rather than treated as incidental.
- **Test coupling.** The module's own 3,136 test lines exercise private
  functions directly. Each extraction has to decide whether those tests move
  with the code or the functions stay crate-visible for the existing tests.
- **Blast radius is measured, not predicted.** Slice 1 broke eight assertions
  across six files that pattern-matching failed to identify twice. Every step
  here runs the full suite against a trial move before the change is written.

## What this record does not do

It does not extract anything, and it does not claim slice 2 is underway.
Recording the map so the extraction order is a decision with evidence behind
it, and so a later reader can see why recovery decisions were left until last.
