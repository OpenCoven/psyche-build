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

## Proposed extraction order

Each step is independently reviewable, preserves public behavior, and stays
inside the slice cap.

1. **Filesystem primitives → `secure_fs.rs`** (~574 lines, 20 functions).
   Generic FD-safety helpers with no workspace semantics: directory and file
   opening that refuses symlinks, permission tightening, temp-file creation.
   Lowest risk and unblocks independent testing of the layer every other
   concern sits on.

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
