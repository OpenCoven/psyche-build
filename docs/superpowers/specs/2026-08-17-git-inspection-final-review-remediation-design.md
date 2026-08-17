# Git Inspection Final Review Remediation Design

## Problem

The isolated Git inspection repository currently loses valid configuration and
accepts unbounded reftable metadata:

1. `git_inspection_repository_config` stores every safe key in a `HashMap`.
   Valid multi-valued `remote.<name>.url` and `remote.<name>.fetch` entries are
   collapsed to one value. Git preserves their order and uses the first fetch
   URL, so the isolated repository can report a different remote than the real
   repository.
2. `snapshot_git_reftable` reads `tables.list` without a limit and copies every
   named path without size, aggregate, or link checks. Repository-controlled
   metadata can therefore consume unbounded memory or temporary disk and can
   redirect reads through links or reparse points.

## Decision

### Preserve multi-valued remote configuration

Continue returning `Vec<(String, String)>` from
`git_inspection_repository_config`, but distinguish scalar and multi-valued
keys while collecting trusted local/worktree configuration:

- scalar keys keep current effective last-value behavior;
- `remote.<name>.url` and `remote.<name>.fetch` retain every value in Git's
  emitted order;
- repeated `-c key=value` arguments replay those ordered values into the
  isolated command;
- `config_value` continues returning the first matching value, matching Git's
  first fetch-URL selection.

This preserves the current isolation boundary: no inspection command reads live
repository configuration.

### Bound and validate reftable snapshots

Replace raw `read_to_string` and `std::fs::copy` calls with stable bounded reads
of real files:

- reject a reftable directory, `tables.list`, or table entry that is a symlink,
  reparse point, or non-regular file;
- cap `tables.list` at 1 MiB;
- cap the number of listed tables at 4,096;
- cap each table at 64 MiB;
- cap aggregate table bytes at 256 MiB;
- compare file identity/metadata before and after each read and fail if it
  changes;
- write the validated bytes into the isolated temporary repository.

The limits are intentionally above normal reftable metadata sizes while
preventing memory, file-count, and temporary-disk exhaustion.

## Rejected Alternatives

- Querying live repository config during isolated commands would restore the
  executable include/filter authority this hardening removed.
- Keeping only one remote value is incompatible with Git's documented and
  executable multi-value behavior.
- Disabling reftable inspection would regress supported repositories.
- Copying files after metadata checks would retain a check/open race and still
  follow links on some platforms.

## Validation

Add regressions that prove:

- two `remote.origin.url` values are retained in order and `git_status`
  reports the first URL;
- multiple fetch refspecs survive isolated config replay;
- oversized `tables.list`, excessive table count, oversized individual tables,
  excessive aggregate bytes, and link-like entries fail explicitly;
- a normal reftable repository still supports status, diff, and log.

Run formatting, Git-focused Rust tests, the full locked Rust library suite, and
the existing cross-platform desktop CI matrix.

## Scope

This remediation changes only safe Git config snapshot representation and
reftable metadata copying. It does not expand trusted config keys, execute
repository helpers, change Tauri response types, or alter non-Git filesystem
behavior.
