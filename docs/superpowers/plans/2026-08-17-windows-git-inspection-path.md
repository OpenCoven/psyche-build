# Windows Git Inspection Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve canonical filesystem validation while giving Git for Windows a non-verbatim working directory so local line-ending configuration remains effective during isolated inspections.

**Architecture:** Add one platform-aware path adapter at the Git subprocess boundary. All callers keep canonicalizing roots; `git_command` alone converts `\\?\X:\...` disk paths to `X:\...` before setting `current_dir`, leaving UNC, ordinary Windows, and non-Windows paths unchanged.

**Tech Stack:** Rust standard library, Git CLI, Cargo tests, GitHub Actions Windows runner.

---

## File Structure

- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
  - Add the Git subprocess path adapter beside `git_command`.
  - Route every Git subprocess working directory through the adapter.
  - Add focused path-shape and public `git_status`/`git_diff` regressions.
- Existing design: `docs/superpowers/specs/2026-08-17-windows-git-inspection-path-design.md`

### Task 1: Add the Windows Path Regression

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:4990-5030`
- Test: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:8400-8900`

- [ ] **Step 1: Write the failing path-shape test**

Add this test in `workspace_panel_tests` near the other Git environment helpers:

```rust
#[cfg(windows)]
#[test]
fn git_subprocess_root_removes_only_verbatim_disk_prefixes() {
    assert_eq!(
        git_subprocess_root(Path::new(r"\\?\C:\workspace\project")).as_ref(),
        Path::new(r"C:\workspace\project")
    );
    assert_eq!(
        git_subprocess_root(Path::new(r"\\?\UNC\server\share\project")).as_ref(),
        Path::new(r"\\?\UNC\server\share\project")
    );
    assert_eq!(
        git_subprocess_root(Path::new(r"C:\workspace\project")).as_ref(),
        Path::new(r"C:\workspace\project")
    );
}
```

- [ ] **Step 2: Write the failing public-path regression**

Add a cross-platform test beside
`git_status_and_diff_preserve_effective_global_crlf_normalization`:

```rust
#[test]
fn git_status_and_diff_preserve_local_line_endings_after_root_canonicalization() {
    let tree = TempTree::new("git-canonical-root-line-endings");
    run_test_git(&tree.root, &["init", "-q"]);
    run_test_git(&tree.root, &["config", "user.name", "Psyche Tests"]);
    run_test_git(
        &tree.root,
        &["config", "user.email", "psyche-tests@example.invalid"],
    );
    run_test_git(&tree.root, &["config", "core.autocrlf", "false"]);
    std::fs::write(tree.root.join("tracked.txt"), b"first\nsecond\nthird\n").unwrap();
    run_test_git(&tree.root, &["add", "tracked.txt"]);
    run_test_git(&tree.root, &["commit", "-qm", "baseline"]);

    std::fs::write(tree.root.join("tracked.txt"), b"first\nsecond\nthird\n").unwrap();
    let status = git_status(path_text(&tree.root).to_string()).unwrap();
    assert!(
        status.files.is_empty(),
        "canonicalized inspection must preserve local core.autocrlf=false: {:?}",
        status.files
    );

    std::fs::write(tree.root.join("tracked.txt"), b"first\nchanged\nthird\n").unwrap();
    let diff = git_diff(
        path_text(&tree.root).to_string(),
        Some("tracked.txt".to_string()),
        Some(false),
        Some(0),
    )
    .unwrap();
    assert!(diff.text.contains("-second"));
    assert!(diff.text.contains("+changed"));
    assert!(!diff.text.contains("-first"));
    assert!(!diff.text.contains("+first"));
    assert!(!diff.text.contains("-third"));
    assert!(!diff.text.contains("+third"));
}
```

- [ ] **Step 3: Run the focused regression before implementation**

Run:

```bash
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-pr151-cargo" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib \
  workspace_panel_tests::git_status_and_diff_preserve_local_line_endings_after_root_canonicalization
```

Expected on macOS/Linux: PASS, confirming the regression is platform-specific.

Run the branch in Windows CI before the implementation if an authoritative red
state is needed. Expected on Windows: FAIL because `git_command` receives the
verbatim canonical path.

- [ ] **Step 4: Commit the regression**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "test: cover canonical Windows Git inspection roots" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Normalize Only the Git Subprocess Working Directory

**Files:**
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:1-20`
- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:4990-5030`

- [ ] **Step 1: Add the path adapter**

Import `Cow` with the existing standard-library imports:

```rust
use std::borrow::Cow;
```

Add this helper immediately before `git_command`:

```rust
fn git_subprocess_root(root: &Path) -> Cow<'_, Path> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        const VERBATIM_PREFIX: [u16; 4] = [
            b'\\' as u16,
            b'\\' as u16,
            b'?' as u16,
            b'\\' as u16,
        ];
        let encoded = root.as_os_str().encode_wide().collect::<Vec<_>>();
        let is_verbatim_disk = encoded.starts_with(&VERBATIM_PREFIX)
            && encoded.get(4).is_some_and(|unit| (*unit as u8).is_ascii_alphabetic())
            && encoded.get(5) == Some(&(b':' as u16))
            && encoded.get(6) == Some(&(b'\\' as u16));
        if is_verbatim_disk {
            return Cow::Owned(PathBuf::from(OsString::from_wide(&encoded[4..])));
        }
    }

    Cow::Borrowed(root)
}
```

This preserves Unicode because the conversion operates on Windows wide
characters rather than a lossy UTF-8 string.

- [ ] **Step 2: Route `git_command` through the adapter**

Replace:

```rust
let mut command = std::process::Command::new("git");
command.current_dir(root);
```

with:

```rust
let mut command = std::process::Command::new("git");
command.current_dir(git_subprocess_root(Path::new(root)).as_ref());
```

Do not change `canonical_project_root`, repository snapshot paths, containment
checks, or the environment/config isolation logic.

- [ ] **Step 3: Run formatting and focused Git tests**

Run:

```bash
cargo fmt --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml --check
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-pr151-cargo" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib workspace_panel_tests::git_
```

Expected: formatting passes and all Git-focused tests pass.

- [ ] **Step 4: Run the full Rust library suite**

Run:

```bash
CARGO_TARGET_DIR="${TMPDIR:-/tmp}/psyche-pr151-cargo" \
  cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  --locked --lib
```

Expected: all tests pass. If the unrelated
`pane_metrics::tests::runner_uses_explicit_path_for_shebang_interpreter`
two-second timeout recurs, rerun that single test once and record it separately
from the Git inspection result.

- [ ] **Step 5: Commit the implementation**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "fix: normalize Windows Git inspection roots" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Integrate and Complete the Pull Requests

**Files:**
- Verify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
- Verify: `src/control/runtime.ts`
- Verify: `__tests__/controlRuntime.test.ts`

- [ ] **Step 1: Rebase #151 onto current `origin/main`**

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease origin fix/git-inspection-filter-hardening
```

Expected: rebase completes without changing the scoped Git inspection behavior.

- [ ] **Step 2: Verify #151 CI and review state**

Run:

```bash
gh pr checks 151 --watch
```

Expected: TypeScript/Rust, macOS, Windows, Ubuntu, iOS, and required deployment
checks complete successfully.

Resolve the required-only-filter review thread only after confirming the current
head still contains both `required` driver discovery and
`git_diff_neutralizes_repository_required_only_filter`.

- [ ] **Step 3: Merge #151**

```bash
gh pr merge 151 --merge --delete-branch=false
```

Expected: PR #151 is merged into `main`.

- [ ] **Step 4: Rebase #152 onto the updated `origin/main`**

```bash
git fetch origin
git rebase origin/main
git push --force-with-lease origin fix/task-scoped-retained-receipts
```

Expected: the receipt-retention commits replay cleanly after #151.

- [ ] **Step 5: Revalidate and merge #152**

Run:

```bash
pnpm exec vitest --run __tests__/controlRuntime.test.ts
pnpm --filter @opencoven/psyche-vim-core typecheck
pnpm exec tsc --noEmit
pnpm run typecheck:tests
gh pr checks 152 --watch
gh pr merge 152 --merge --delete-branch=false
```

Expected: 86 control runtime tests pass, all typechecks pass, required CI is
green, and PR #152 merges into `main`.

- [ ] **Step 6: Confirm repository completion**

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/psyche-build pull --ff-only
gh pr list --state open --limit 20
git -C /Users/buns/Documents/GitHub/OpenCoven/psyche-build status --short --branch
```

Expected: local `main` matches `origin/main`, no intended PR remains open, and
the main worktree is clean.
