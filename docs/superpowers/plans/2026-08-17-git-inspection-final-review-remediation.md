# Git Inspection Final Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve valid multi-valued remote configuration and make reftable snapshots bounded, stable, and link-safe.

**Architecture:** Keep the existing isolated Git repository design. Split safe config collection into scalar last-wins values and ordered multi-values, and replace raw reftable copies with a bounded byte-reader plus explicit snapshot limits.

**Tech Stack:** Rust standard library, Git CLI, Cargo tests, GitHub Actions desktop matrix.

---

## File Structure

- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
  - Preserve ordered `remote.*.url` and `remote.*.fetch` values.
  - Add bounded stable metadata-file reads.
  - Add configurable reftable snapshot limits and regressions.
- Existing design:
  `docs/superpowers/specs/2026-08-17-git-inspection-final-review-remediation-design.md`

### Task 1: Preserve Ordered Remote Multi-Values

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:5923-5965`
- Test: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:10120-10280`

- [ ] **Step 1: Write the failing config-order regression**

Add a test beside `git_status_preserves_branch_upstream_and_remote_metadata`:

```rust
#[test]
fn git_inspection_preserves_ordered_remote_urls_and_fetch_refspecs() {
    let tree = TempTree::new("git-remote-multivalue");
    run_test_git(&tree.root, &["init", "-q"]);
    run_test_git(
        &tree.root,
        &["config", "--add", "remote.origin.url", "https://first.invalid/repo.git"],
    );
    run_test_git(
        &tree.root,
        &["config", "--add", "remote.origin.url", "https://second.invalid/repo.git"],
    );
    run_test_git(
        &tree.root,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    run_test_git(
        &tree.root,
        &[
            "config",
            "--add",
            "remote.origin.fetch",
            "+refs/heads/release:refs/remotes/origin/release",
        ],
    );

    let config = git_inspection_repository_config(path_text(&tree.root)).unwrap();
    let urls = config
        .iter()
        .filter(|(key, _)| key == "remote.origin.url")
        .map(|(_, value)| value.as_str())
        .collect::<Vec<_>>();
    let fetch = config
        .iter()
        .filter(|(key, _)| key == "remote.origin.fetch")
        .map(|(_, value)| value.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        urls,
        vec![
            "https://first.invalid/repo.git",
            "https://second.invalid/repo.git",
        ]
    );
    assert_eq!(
        fetch,
        vec![
            "+refs/heads/main:refs/remotes/origin/main",
            "+refs/heads/release:refs/remotes/origin/release",
        ]
    );

    let status = git_status(path_text(&tree.root).to_string()).unwrap();
    assert_eq!(
        status.remote_url.as_deref(),
        Some("https://first.invalid/repo.git")
    );
}
```

- [ ] **Step 2: Run the regression and verify the current failure**

Run:

```bash
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib \
  workspace_panel_tests::git_inspection_preserves_ordered_remote_urls_and_fetch_refspecs
```

Expected: FAIL because each duplicate key is collapsed to one value.

- [ ] **Step 3: Add scalar/multi-value classification**

Add this helper before `git_inspection_repository_config`:

```rust
fn git_inspection_config_is_multi_valued(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.starts_with("remote.") && (key.ends_with(".url") || key.ends_with(".fetch"))
}
```

Change the function to collect values as:

```rust
let mut scalar_values = HashMap::new();
let mut multi_values = Vec::new();
```

For every parsed record:

```rust
let key = std::str::from_utf8(&record[..separator])
    .map_err(|_| "git config query returned invalid UTF-8 keys".to_string())?
    .to_ascii_lowercase();
let value = std::str::from_utf8(&record[separator + 1..])
    .map_err(|_| format!("git config {key} returned invalid UTF-8"))?
    .to_string();
if git_inspection_config_is_multi_valued(&key) {
    multi_values.push((key, value));
} else {
    scalar_values.insert(key, value);
}
```

Merge line-ending values into `scalar_values`, then return scalar and
multi-valued entries without reordering the duplicate values:

```rust
for (key, value) in git_inspection_line_ending_config(root)? {
    scalar_values.insert(key, value);
}
let mut values = scalar_values.into_iter().collect::<Vec<_>>();
values.extend(multi_values);
Ok(values)
```

- [ ] **Step 4: Run focused and Git config tests**

Run:

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib workspace_panel_tests::git_inspection_preserves_ordered_remote_urls_and_fetch_refspecs
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib workspace_panel_tests::git_status_
```

Expected: all commands pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "fix: preserve Git remote config values" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Bound and Validate Reftable Snapshots

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:5536-5790`
- Test: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:10680-10920`

- [ ] **Step 1: Add test-sized snapshot limits**

Add production constants and an internal limits type beside the existing Git
metadata limits:

```rust
const MAX_GIT_REFTABLE_LIST_BYTES: u64 = 1024 * 1024;
const MAX_GIT_REFTABLE_TABLES: usize = 4096;
const MAX_GIT_REFTABLE_TABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GIT_REFTABLE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
struct GitReftableSnapshotLimits {
    list_bytes: u64,
    tables: usize,
    table_bytes: u64,
    total_bytes: u64,
}

const GIT_REFTABLE_SNAPSHOT_LIMITS: GitReftableSnapshotLimits =
    GitReftableSnapshotLimits {
        list_bytes: MAX_GIT_REFTABLE_LIST_BYTES,
        tables: MAX_GIT_REFTABLE_TABLES,
        table_bytes: MAX_GIT_REFTABLE_TABLE_BYTES,
        total_bytes: MAX_GIT_REFTABLE_TOTAL_BYTES,
    };
```

- [ ] **Step 2: Write failing bounded-snapshot regressions**

Add tests that call `snapshot_git_reftable_with_limits` directly with small
limits:

```rust
#[test]
fn git_reftable_snapshot_enforces_list_table_count_and_byte_limits() {
    let tree = TempTree::new("git-reftable-limits");
    let source = tree.root.join("source");
    let destination = tree.root.join("destination");
    std::fs::create_dir_all(&source).unwrap();
    let limits = GitReftableSnapshotLimits {
        list_bytes: 32,
        tables: 2,
        table_bytes: 8,
        total_bytes: 12,
    };

    std::fs::write(source.join("tables.list"), "one.ref\ntwo.ref\nthree.ref\n").unwrap();
    assert!(snapshot_git_reftable_with_limits(&source, &destination, limits)
        .unwrap_err()
        .contains("too many tables"));

    std::fs::write(source.join("tables.list"), "one.ref\n").unwrap();
    std::fs::write(source.join("one.ref"), b"123456789").unwrap();
    assert!(snapshot_git_reftable_with_limits(&source, &destination, limits)
        .unwrap_err()
        .contains("table one.ref is too large"));

    std::fs::write(source.join("tables.list"), "one.ref\ntwo.ref\n").unwrap();
    std::fs::write(source.join("one.ref"), b"12345678").unwrap();
    std::fs::write(source.join("two.ref"), b"12345678").unwrap();
    assert!(snapshot_git_reftable_with_limits(&source, &destination, limits)
        .unwrap_err()
        .contains("aggregate size"));

    std::fs::write(source.join("tables.list"), "x".repeat(33)).unwrap();
    assert!(snapshot_git_reftable_with_limits(&source, &destination, limits)
        .unwrap_err()
        .contains("table list is too large"));
}
```

Add a valid snapshot and link rejection test:

```rust
#[test]
fn git_reftable_snapshot_copies_only_regular_bounded_files() {
    let tree = TempTree::new("git-reftable-regular-files");
    let source = tree.root.join("source");
    let destination = tree.root.join("destination");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("tables.list"), "one.ref\n").unwrap();
    std::fs::write(source.join("one.ref"), b"table").unwrap();
    let limits = GitReftableSnapshotLimits {
        list_bytes: 32,
        tables: 2,
        table_bytes: 8,
        total_bytes: 12,
    };

    snapshot_git_reftable_with_limits(&source, &destination, limits).unwrap();
    assert_eq!(std::fs::read(destination.join("one.ref")).unwrap(), b"table");
    assert_eq!(
        std::fs::read_to_string(destination.join("tables.list")).unwrap(),
        "one.ref\n"
    );

    let linked = tree.root.join("linked.ref");
    std::fs::write(&linked, b"linked").unwrap();
    std::fs::remove_dir_all(&destination).unwrap();
    std::fs::remove_file(source.join("one.ref")).unwrap();
    if !create_test_symlink(TestSymlinkKind::File, &linked, &source.join("one.ref")) {
        return;
    }
    assert!(snapshot_git_reftable_with_limits(&source, &destination, limits)
        .unwrap_err()
        .contains("not a regular file"));
}
```

- [ ] **Step 3: Run the new tests and verify failure**

Run:

```bash
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib workspace_panel_tests::git_reftable_snapshot_
```

Expected: FAIL because the bounded helper does not exist.

- [ ] **Step 4: Add a stable bounded regular-file reader**

Add a helper with this contract:

```rust
fn read_bounded_git_metadata_file(
    path: &Path,
    label: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String>
```

Implementation requirements:

```rust
let before = std::fs::symlink_metadata(path)
    .map_err(|error| format!("inspect {label}: {error}"))?;
if metadata_is_link_like(&before) || !before.is_file() {
    return Err(format!("{label} is not a regular file"));
}
if before.len() > max_bytes {
    return Err(format!("{label} is too large"));
}
```

Open the final component without following links:

```rust
let mut options = std::fs::OpenOptions::new();
options.read(true);
#[cfg(unix)]
{
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
}
#[cfg(windows)]
{
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}
let mut file = options
    .open(path)
    .map_err(|error| format!("open {label}: {error}"))?;
```

Read at most `max_bytes + 1`, reject overflow, and compare stable identity:

- Unix: compare `file_state(&file)` before and after the read.
- Windows: compare `volume_serial_number`, `file_index`, `file_attributes`,
  `file_size`, and `last_write_time` from handle metadata; reject reparse
  attributes.
- Other targets: compare length and modification time from handle metadata.
- Re-run `symlink_metadata(path)` after reading and reject link-like,
  non-regular, length-changed, or modification-time-changed paths.

- [ ] **Step 5: Implement bounded reftable snapshotting**

Replace the raw function with:

```rust
fn snapshot_git_reftable_with_limits(
    source: &Path,
    destination: &Path,
    limits: GitReftableSnapshotLimits,
) -> Result<(), String> {
    let directory = std::fs::symlink_metadata(source)
        .map_err(|error| format!("inspect Git reftable directory: {error}"))?;
    if metadata_is_link_like(&directory) || !directory.is_dir() {
        return Err("Git reftable directory is not a real directory".to_string());
    }

    let list_bytes = read_bounded_git_metadata_file(
        &source.join("tables.list"),
        "Git reftable table list",
        limits.list_bytes,
    )?;
    let tables = std::str::from_utf8(&list_bytes)
        .map_err(|_| "Git reftable table list is not UTF-8".to_string())?;
    let names = tables
        .lines()
        .filter(|table| !table.is_empty())
        .collect::<Vec<_>>();
    if names.len() > limits.tables {
        return Err("Git reftable table list contains too many tables".to_string());
    }

    let mut snapshots = Vec::with_capacity(names.len());
    let mut total_bytes = 0_u64;
    for table in names {
        if Path::new(table).file_name().and_then(OsStr::to_str) != Some(table) {
            return Err("Git reftable table list contains an invalid path".to_string());
        }
        let bytes = read_bounded_git_metadata_file(
            &source.join(table),
            &format!("Git reftable table {table}"),
            limits.table_bytes,
        )?;
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "Git reftable aggregate size overflowed".to_string())?;
        if total_bytes > limits.total_bytes {
            return Err("Git reftable aggregate size is too large".to_string());
        }
        snapshots.push((table.to_string(), bytes));
    }

    std::fs::create_dir_all(destination)
        .map_err(|error| format!("create isolated Git reftable directory: {error}"))?;
    for (table, bytes) in snapshots {
        std::fs::write(destination.join(&table), bytes)
            .map_err(|error| format!("snapshot Git reftable table {table}: {error}"))?;
    }
    std::fs::write(destination.join("tables.list"), list_bytes)
        .map_err(|error| format!("snapshot Git reftable table list: {error}"))
}

fn snapshot_git_reftable(source: &Path, destination: &Path) -> Result<(), String> {
    snapshot_git_reftable_with_limits(source, destination, GIT_REFTABLE_SNAPSHOT_LIMITS)
}
```

After all reads, re-check that `source` remains a real directory before
publishing destination bytes.

- [ ] **Step 6: Run focused reftable and Git tests**

Run:

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib workspace_panel_tests::git_reftable_snapshot_
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib workspace_panel_tests::git_
```

Expected: all commands pass.

- [ ] **Step 7: Commit Task 2**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "fix: bound Git reftable snapshots" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Validate and Merge the Follow-Up

**Files:**
- Verify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Verify: `docs/superpowers/specs/2026-08-17-git-inspection-final-review-remediation-design.md`

- [ ] **Step 1: Run the full locked Rust library suite**

```bash
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-final-git-review" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib
```

Expected: all tests pass. If only the known
`pane_metrics::tests::runner_uses_explicit_path_for_shebang_interpreter`
two-second timeout occurs, rerun that test once and report it separately.

- [ ] **Step 2: Push and open the pull request**

```bash
git push -u origin fix/git-inspection-final-review
gh pr create \
  --base main \
  --head fix/git-inspection-final-review \
  --title "Complete Git inspection snapshot hardening" \
  --body "## Summary
- preserve ordered multi-valued remote URL and fetch configuration
- bound and validate reftable metadata snapshots
- add deterministic regression coverage

## Validation
- cargo fmt --check
- Git-focused Rust tests
- full locked Rust library suite"
```

- [ ] **Step 3: Require cross-platform CI and review completion**

```bash
gh pr checks --watch --interval 20
```

Expected: TypeScript/Rust, macOS, Windows, Ubuntu, iOS, and Vercel checks pass.
Resolve only conversations proven fixed on the current head.

- [ ] **Step 4: Merge and update main**

```bash
gh pr merge --merge --delete-branch=false
git -C /Users/buns/Documents/GitHub/OpenCoven/psyche-build pull --ff-only
gh pr list --state open --limit 20
```

Try the normal merge first. Use `--admin` only if every check is green, no
review thread remains, the PR is mergeable, and the sole blocker is the
repository's self-review rule.
