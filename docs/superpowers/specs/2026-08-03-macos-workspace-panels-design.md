# macOS Workspace Panels

## Goal

Finish the existing native macOS workspace-panel patch as a read-only inspection
surface for the selected Psyche project without creating a second source of
truth or expanding into merge/review actions.

## Scope

The left sidebar remains the project/session switcher. The right rail exposes
Browser, Files, Diffs, and Git panels. Files may be previewed in the existing
main tab strip. Diffs and Git history are informational only.

This slice does not add editing, staging, committing, merging, branch deletion,
worktree cleanup, or remote mutations. Existing Psyche flows remain authoritative
for all lifecycle actions.

## Security Boundary

Every filesystem command receives both the selected project root and the target
path. The Rust backend canonicalizes both and rejects targets outside the root,
including symlink escapes. Git file arguments must be relative paths without
parent traversal. The untracked-file diff fallback uses the same canonical
containment check before reading content.

When a selected project is nested inside a larger Git repository, status and
diff pathspecs are limited to that project directory and returned paths are
relative to the selected root. Files elsewhere in the parent repository never
appear in the panel.

The selected root remains explicit because Psyche supports non-Git projects.
Git commands operate only with that root as their working directory and never
invoke mutating subcommands.

## Error Handling

Backend failures return concise errors. Panels render those errors in place and
leave terminals, projects, and working trees unchanged. Binary and oversized
files retain the existing bounded-preview behavior.

## Verification

- Rust unit tests exercise nested paths, parent traversal, sibling-prefix paths,
  and symlink escape rejection.
- Vitest source-contract coverage pins the root argument and read-only command
  registrations used by the no-bundler Tauri frontend.
- Existing TypeScript tests, Rust formatting/checks/tests, production builds,
  and a packaged Tauri build must pass before the branch is commit-ready.
- The native package pins a local Tauri 2 CLI so builds never depend on a
  developer's globally installed Cargo plugin.
