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
runs in both directions rather than bottom-up. Three of the cluster —
`open_existing_regular_file`, `regular_file_exists`, and
`require_new_regular_file_path` — also take `SecureWorkspaceDir`, so the claim
that these are "generic helpers with no workspace semantics" was wrong.

**Two functions were miscategorized entirely.** `publish_opened_workspace_file`
and `publish_opened_restore_candidate` matched the `publish_opened` name
pattern but call verification and fault-injection helpers; they belong to
publication, not primitives.

**The module's real structure is depth, not concern.** Its 131 free functions
form a dependency graph 16 levels deep with **no cycles**:

| Depth | Functions | Lines |
|---:|---:|---:|
| 0 (leaves) | 38 | 733 |
| 1-3 | 34 | 1,234 |
| 4-7 | 30 | 1,305 |
| 8-11 | 15 | 1,202 |
| 12-15 | 14 | 935 |

No cycles means the module is decomposable. Depth means it must be taken
bottom-up, and a concern is not an extractable unit: depth-0 leaves are spread
across recovery (10 functions), paths (5), primitives (8), and restore (5).

**The extractable unit is a dependency-closed set**, not a named concern.

## Corrected first step

Two closed sets exist at the bottom of the graph. Neither pulls in anything
beyond itself, verified by computing the transitive closure:

| Option | Functions | Lines | Coupling |
|---|---:|---:|---|
| Syscall and FD layer | 14 | 408 | Needs `use super::SecureWorkspaceDir` for three members |
| Type-free subset | 11 | 262 | References no workspace type |

Prefer the 14-function set. It is the larger reduction, and importing one type
from the parent is a smaller cost than leaving three tightly related functions
behind. Forty-three parent functions call into the set, so the parent needs a
matching import list either way.

Move it as a **child module** (`native_workspace/secure_fs.rs`, declared from
`native_workspace.rs`) with `pub(super)` visibility rather than a sibling with
`pub(crate)`. Edition 2021 supports that layout, and it keeps sixteen security
primitives visible only to their parent instead of widening them crate-wide —
which the original plan would have done as an unremarked side effect.

Carry each moved function's `use` statements with it. The trial move relocated
bodies without imports and failed on unresolved `OsStr`, `CString`, and `fs`.

## Proposed extraction order

Each step is independently reviewable, preserves public behavior, and stays
inside the slice cap.

1. **Syscall and FD layer → `native_workspace/secure_fs.rs`** (408 lines, 14
   functions, dependency-closed). Superseded the original "filesystem
   primitives, ~574 lines, 20 functions" step, which was not closed and would
   not compile. See the correction above.

2. **Path derivation → `workspace_paths.rs`** (~173 lines, 7 functions).
   Pure functions deriving temp, lock, rollback, and restore-candidate paths.
   No I/O, so it is a mechanical move.

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
