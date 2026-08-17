# Windows Git Inspection Path Design

## Problem

The hardened desktop Git inspection path passes canonical project roots to Git
subprocesses. On Windows, Rust canonicalization can produce verbatim paths such
as `\\?\C:\...`. The current Windows CI failures show that inspections created
through `git_status` and `git_diff` no longer preserve the repository's
effective line-ending behavior: clean fixtures appear dirty, diff sizes change,
and context-only assertions collapse into whole-file diffs.

Filesystem containment still requires canonical paths. The repair must not
weaken project-root validation or restore access to repository-controlled Git
helpers.

## Decision

Keep canonical `PathBuf` values for containment, identity, and direct filesystem
operations. Before a canonical root is supplied to a Git subprocess, convert a
Windows verbatim disk path into the ordinary drive-qualified form Git for
Windows expects. Other Windows path forms and all non-Windows paths remain
unchanged.

The conversion belongs at the Git subprocess boundary so every metadata and
isolated inspection command receives compatible working-directory, worktree,
index, and object paths. Callers continue to canonicalize roots before reaching
that boundary.

## Rejected Alternatives

- Test-only Git configuration isolation would make CI green without fixing the
  production path used by Tauri commands.
- Reading `.git/config` directly would duplicate Git's include, worktree,
  precedence, and path-resolution behavior and could diverge from the effective
  configuration Git actually uses.
- Removing canonicalization would weaken existing path-containment guarantees.

## Behavior

1. `canonical_project_root` continues returning the canonical filesystem path.
2. The Git command factory derives subprocess-compatible paths for the working
   directory and Git environment values.
3. On Windows, only `\\?\X:\...` disk paths are converted to `X:\...`.
4. UNC and non-verbatim paths are preserved unless a tested Git-compatible
   conversion is explicitly defined.
5. Git inspection continues clearing command-scope config and isolating system,
   global, repository, attributes, refs, objects, and filter helpers exactly as
   before.

## Validation

Add a Windows-focused regression that creates a repository with local
`core.autocrlf=false`, invokes the public `git_status` and `git_diff` paths that
canonicalize the root, and verifies that:

- a committed LF file remains clean after an identical LF rewrite;
- a one-line edit remains a one-line diff rather than a whole-file conversion;
- the regression also passes on non-Windows platforms.

Run the existing Git inspection tests and the full desktop Rust library suite.
The Windows desktop CI job is the authoritative cross-platform confirmation.

## Scope

This change is limited to Git subprocess path preparation and its regression
coverage. It does not change inspection authorization, repository snapshot
contents, filter policy, Tauri API shapes, or non-Git filesystem operations.
