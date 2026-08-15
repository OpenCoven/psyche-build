# Documentation History Cleanup Design

**Date:** 2026-08-12  
**Status:** Approved for implementation planning

## Purpose

Keep the checked-out documentation authoritative and easy to navigate without
erasing the repository's design and release history.

Psyche Build currently mixes active manuals and technical contracts with
completed implementation plans, superseded design specs, one-time release
instructions, migration guidance, roadmap language, and demo-era mobile claims.
Readers cannot reliably tell which files describe the current product.

The cleanup will remove obsolete material from `HEAD` and replace the in-tree
archive with one commit-based historical index.

## Chosen approach

Use a surgical prune with a full history manifest.

- Preserve current user guidance, contributor guidance, active architecture and
  security contracts, smoke checks, and release history.
- Delete documentation that is useful only as historical context.
- Correct or remove stale claims embedded in documents that remain.
- Add `docs/HISTORY.md` as the only index for removed documentation.
- Do not create `docs/archive/` or retain duplicate historical copies in the
  current tree.

This approach keeps the existing documentation structure where it is still
useful while making every surviving page an intentional current source.

## Historical scope

The following categories leave the current documentation tree:

1. Completed or superseded files under `docs/superpowers/plans/`.
2. Completed or superseded files under `docs/superpowers/specs/`, including
   this design after its implementation work is complete.
3. One-time `v0.0.1` release and TestFlight runbook material.
4. The `comux` to Psyche Build migration guide.
5. Outdated product-spec and future/near-term roadmap claims.
6. Demo-first iOS, mobile pairing, and remote-control claims that do not match
   current behavior.

The implementation audit may identify additional files or sections within
these six approved categories. Material outside those categories is out of
scope. Every additional removal must state why it is no longer authoritative
and add the former location to the history manifest.

## Documentation architecture after cleanup

The current tree will contain four clear classes of documentation:

### User guidance

Installation, setup, workflows, shortcuts, configuration, troubleshooting, and
other behavior users can perform with the current product.

### Contributor and operator guidance

Development setup, supported build and test commands, smoke checks, and active
release procedures. A release-specific runbook remains only when it still
describes the next supported release process rather than a completed event.

### Active technical contracts

Security boundaries, control-plane architecture, protocol behavior, and other
documents that define invariants implemented by the current code.

### Release history

`CHANGELOG.md` remains the chronological release record. It is not presented as
current operational guidance. Valid historical release facts remain. A claim
that was inaccurate even for its release remains visible with a concise
correction note and a matching history-index entry; the cleanup does not delete
or relocate release entries.

`README.md` and `docs/README.md` will link to `docs/HISTORY.md` and explain that
historical plans and specs intentionally live in Git history rather than in
`HEAD`.

## Commit-based history index

`docs/HISTORY.md` will be a static, human-readable manifest.

### Archive baseline

The page will record the full 40-character SHA of the final commit immediately
before the cleanup changes. This baseline is the last complete tree containing
all material intentionally removed by the cleanup.

### Deleted-file manifest

Every deleted documentation file gets exactly one row with:

- category;
- former repository path;
- last content commit SHA;
- last content commit date;
- last content commit subject;
- immutable GitHub blob URL pinned to a commit where the file exists.

The plans and specs manifest will list every file individually rather than only
grouping them by milestone.

### Retired sections from surviving files

Historical text removed from files that remain gets a separate entry with:

- source file;
- retired topic or section;
- reason it is no longer current;
- immutable pre-cleanup GitHub link.

### Recovery instructions

The page will document:

```sh
git show <commit>:<former-path>
```

It will also explain that immutable GitHub URLs are the preferred browser view
and branch-based links are intentionally not used for historical material.

## Audit rules

Every surviving document must be classified as user guidance, contributor or
operator guidance, active technical contract, or release history.

The audit will compare documentation claims with current code, configuration,
and supported distribution surfaces. It will specifically check:

- installation and package availability;
- platform and application support;
- mobile pairing and remote-control behavior;
- commands, keyboard shortcuts, and UI names;
- release instructions and version-specific assumptions;
- architecture and protocol ownership;
- roadmap, "future", "near-term", and demo language;
- references to deleted files or old product names.

Speculative roadmap language will be removed rather than converted into a
current product promise.

Useful operational detail remains when it describes current behavior and is
not duplicated by a clearer authoritative page.

## Affected surfaces

The cleanup must cover all documentation entry points and packaging references,
including:

- `README.md`;
- `docs/README.md`;
- `CHANGELOG.md` where historical accuracy requires an annotation;
- current Markdown manuals under `docs/`;
- the documentation site's content and navigation;
- `native/*/README.md`;
- `CONTRIBUTING.md`;
- `package.json` shipped-file entries;
- links and references in scripts or configuration.

Product code is out of scope. A documentation validation failure caused by
product code must be reported rather than fixed as part of this cleanup.

## Validation

The implementation is complete only when:

1. The existing documentation site build succeeds.
2. Existing repository link and reference searches find no live inbound links
   to deleted paths outside `docs/HISTORY.md`.
3. Package dry-run output contains the intended current documentation and no
   deleted historical files.
4. Every deleted documentation path has exactly one manifest entry.
5. Every manifest entry contains a valid 40-character SHA and immutable GitHub
   URL.
6. Each pinned URL identifies a commit where the former path exists.
7. Searches for the selected stale categories find only intentional historical
   mentions in `CHANGELOG.md` or `docs/HISTORY.md`.
8. Unrelated product behavior and source files remain unchanged.

## Commit strategy

The implementation plan should keep the history baseline reproducible:

1. Complete and commit the implementation plan while all historical files
   still exist.
2. Record that commit as the archive baseline.
3. Generate the full manifest from the baseline and per-file Git history.
4. Apply the documentation cleanup without unrelated changes.
5. Commit the cleanup so its parent remains the documented complete baseline.

If validation requires a follow-up commit, the archive baseline remains the
recorded pre-cleanup commit.

## Non-goals

- Maintaining a browsable duplicate archive in `HEAD`.
- Rewriting old plans so they appear current.
- Deleting valid changelog history merely because it is old.
- Redesigning the documentation site's visual presentation.
- Changing product behavior to make stale documentation true.
