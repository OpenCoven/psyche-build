# Psyche-owned Active Coven Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show only active Coven daemon sessions that Psyche Build itself initiated, while keeping native chat and attach in physical Tauri panes and leaving local Agents/Shells behavior unchanged.

**Architecture:** Psyche marks only native `coven chat` launches with `COVEN_SESSION_SOURCE=psyche-build`. Coven Code converts only that exact value into the durable daemon label `source:psyche-build`. Coven validates and persists external-session labels. Psyche normalizes labels at its Rust boundary, then filters daemon rows by exact provenance plus the active statuses `starting`, `running`, and `waiting` before grouping or search.

**Tech Stack:** Rust, serde/serde_json, Coven daemon HTTP API, Coven Code Rust workspace, Tauri 2, JavaScript ES modules, TypeScript declarations, Vitest, pnpm.

---

## Preconditions and delivery boundaries

- Work in three isolated worktrees because the canonical `coven` and `coven-code` checkouts contain unrelated user changes.
- Do not edit, stage, stash, or clean the canonical dependency checkouts.
- Do not push branches, open PRs, merge, release, or install new binaries without Val's explicit publication approval.
- Preserve the existing Psyche branch and worktree:
  `/Users/buns/Documents/GitHub/OpenCoven/psyche-build/.worktrees/native-coven-attach` on `feat/native-coven-attach`.
- Use GitHub REST through `gh api` for later publication checks; do not use GraphQL.
- Commit only after the task's focused verification passes. Keep one squashable commit per repository task.
- Delivery order is Coven, then Coven Code, then Psyche Build. Psyche's filter intentionally fails closed until compatible dependency versions are installed.

### Task 1: Create clean dependency worktrees

**Files:** None; worktree setup only.

- [ ] Record the user-owned dirty state without changing it.

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven status --short
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code status --short
```

Expected: `coven` includes `.gitignore` and `specs/psyche/O2_CONTRACT_DESIGN.md`; `coven-code` includes the existing headless-contract changes. If the live set differs, preserve the live set and note it.

- [ ] Fetch and create isolated worktrees from the current remote default branch.

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven worktree add -b feat/psyche-external-session-labels /Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code worktree add -b feat/psyche-session-source /Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source origin/main
```

- [ ] Verify both new worktrees are clean and point at their intended branches.

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels status --short --branch
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source status --short --branch
```

Expected: branch headers only, with no changed paths.

### Task 2: Add bounded external-session labels to Coven

**Working directory:** `/Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels`

**Files:**

- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels/crates/coven-cli/src/api.rs`
- Verify existing storage contract: `/Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels/crates/coven-cli/src/store.rs`

- [ ] Add failing API tests beside the existing external registration tests.

Cover these exact cases:

```rust
#[test]
fn register_external_session_persists_labels_and_returns_them() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let body = json!({
        "id": "psyche-session",
        "projectRoot": temp.path().to_string_lossy(),
        "harness": "coven-code",
        "title": "Psyche session",
        "labels": ["source:psyche-build", "ui.native"]
    }).to_string();

    let response = handle_request_with_body(
        "POST", "/api/v1/sessions/external", temp.path(), None, Some(&body),
    )?;
    assert_eq!(response.status, 201, "body: {}", response.body);
    let record: serde_json::Value = serde_json::from_str(&response.body)?;
    assert_eq!(record["labels"], json!(["source:psyche-build", "ui.native"]));

    let conn = store::open_store(&store_path(temp.path()))?;
    assert_eq!(
        store::get_session(&conn, "psyche-session")?.unwrap().labels,
        vec!["source:psyche-build", "ui.native"]
    );
    Ok(())
}
```

Add a table-driven rejection test that submits each payload below and asserts status `400` plus error code `invalid_request`:

```rust
json!({ "labels": "source:psyche-build" })
json!({ "labels": ["source:psyche-build", 1] })
json!({ "labels": [""] })
json!({ "labels": ["source psyche-build"] })
json!({ "labels": ["é"] })
json!({ "labels": ["x".repeat(65)] })
json!({ "labels": ["duplicate", "duplicate"] })
json!({ "labels": (0..17).map(|i| format!("label:{i}")).collect::<Vec<_>>() })
```

Separately submit `json!({ "labels": [] })` as a valid request and assert it persists as `[]`.

Add an idempotency assertion: register `source:psyche-build`, re-register the same ID with `source:foreign`, expect `200`, and verify the persisted/returned labels remain `source:psyche-build`.

- [ ] Run the focused test and confirm it fails because labels are currently discarded.

```bash
cargo test -p coven-cli register_external_session -- --nocapture
```

- [ ] Add a private bounded parser near `register_external_session`.

```rust
const MAX_EXTERNAL_SESSION_LABELS: usize = 16;
const MAX_EXTERNAL_SESSION_LABEL_BYTES: usize = 64;

fn external_session_labels(payload: &Value) -> Result<Vec<String>> {
    let Some(value) = payload.get("labels") else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("labels must be an array"))?;
    if values.len() > MAX_EXTERNAL_SESSION_LABELS {
        anyhow::bail!("labels must contain at most {MAX_EXTERNAL_SESSION_LABELS} values");
    }

    let mut labels = Vec::with_capacity(values.len());
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    for value in values {
        let label = value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("labels must contain only strings"))?;
        if label.is_empty() || label.len() > MAX_EXTERNAL_SESSION_LABEL_BYTES {
            anyhow::bail!("each label must be between 1 and {MAX_EXTERNAL_SESSION_LABEL_BYTES} ASCII bytes");
        }
        if !label.is_ascii()
            || !label.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            anyhow::bail!("labels may contain only ASCII letters, digits, '.', '_', ':', and '-'");
        }
        if !seen.insert(label) {
            anyhow::bail!("labels must not contain duplicates");
        }
        labels.push(label.to_string());
    }
    Ok(labels)
}
```

- [ ] Parse labels before constructing the record and map any validation error to the existing API envelope.

```rust
let labels = match external_session_labels(&payload) {
    Ok(labels) => labels,
    Err(error) => return api_error(400, "invalid_request", &error.to_string(), None),
};
```

Replace only `labels: Vec::new()` in `register_external_session` with `labels`. Do not change `insert_session_if_absent`, the persisted-row re-read, or the daemon-managed collision check; those provide the approved idempotency behavior.

- [ ] Run focused and package-level verification.

```bash
cargo fmt --all -- --check
cargo test -p coven-cli register_external_session -- --nocapture
cargo test -p coven-cli
```

- [ ] Review the diff, then commit only the verified Coven change.

```bash
git diff --check
git diff -- crates/coven-cli/src/api.rs
git add crates/coven-cli/src/api.rs
git commit -m "feat: persist labels for external sessions"
```

### Task 3: Map Psyche's trusted marker in Coven Code

**Working directory:** `/Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source`

**Files:**

- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source/src-rust/crates/core/src/coven_daemon.rs`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source/src-rust/crates/core/src/coven_ledger.rs`

- [ ] Extend the serialization test first.

Construct `RegisterExternalSession` with:

```rust
labels: vec!["source:psyche-build".to_string()],
```

Parse the serialized value and assert exact camel-case payload behavior:

```rust
let value: serde_json::Value = serde_json::to_value(&req).unwrap();
assert_eq!(value["labels"], serde_json::json!(["source:psyche-build"]));
```

Add a second serialization assertion showing `labels: Vec::new()` omits the field, preserving compatibility with older daemons.

- [ ] Add pure unit tests in `coven_ledger.rs` for exact marker mapping.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_the_exact_psyche_source() {
        assert_eq!(
            registration_labels(Some("psyche-build")),
            vec![PSYCHE_SOURCE_LABEL.to_string()]
        );
        assert!(registration_labels(None).is_empty());
        assert!(registration_labels(Some("")).is_empty());
        assert!(registration_labels(Some("Psyche-Build")).is_empty());
        assert!(registration_labels(Some("foreign")).is_empty());
    }
}
```

- [ ] Run the focused tests and confirm they fail to compile until the request and helper exist.

```bash
cargo test -p claurst-core register_external_session_serializes_camel_case -- --nocapture
cargo test -p claurst-core maps_only_the_exact_psyche_source -- --nocapture
```

- [ ] Add the request field without sending empty arrays.

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub labels: Vec<String>,
```

- [ ] Add the exact-value mapping and use it only during initial external registration.

```rust
const COVEN_SESSION_SOURCE: &str = "COVEN_SESSION_SOURCE";
const PSYCHE_SESSION_SOURCE: &str = "psyche-build";
const PSYCHE_SOURCE_LABEL: &str = "source:psyche-build";

fn registration_labels(source: Option<&str>) -> Vec<String> {
    match source {
        Some(PSYCHE_SESSION_SOURCE) => vec![PSYCHE_SOURCE_LABEL.to_string()],
        _ => Vec::new(),
    }
}
```

In `notify_session_start`, add:

```rust
let source = std::env::var(COVEN_SESSION_SOURCE).ok();
let labels = registration_labels(source.as_deref());
```

and pass `labels` in `RegisterExternalSession`. `std::env::var` deliberately maps a non-Unicode value to no label. Do not read the variable in completion, attach, or resume paths, and never copy arbitrary environment content.

- [ ] Run focused and crate-level verification.

```bash
cargo fmt --all -- --check
cargo test -p claurst-core register_external_session_serializes_camel_case -- --nocapture
cargo test -p claurst-core maps_only_the_exact_psyche_source -- --nocapture
cargo test -p claurst-core
```

- [ ] Review and commit only the two verified files.

```bash
git diff --check
git diff -- src-rust/crates/core/src/coven_daemon.rs src-rust/crates/core/src/coven_ledger.rs
git add src-rust/crates/core/src/coven_daemon.rs src-rust/crates/core/src/coven_ledger.rs
git commit -m "feat: label Psyche-launched sessions"
```

### Task 4: Normalize daemon labels at Psyche's Rust boundary

**Working directory:** `/Users/buns/Documents/GitHub/OpenCoven/psyche-build/.worktrees/native-coven-attach`

**Files:**

- Modify: `native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs`

- [ ] Add failing normalization tests beside `normalizes_camel_and_snake_case_session_fields`.

Test all of the following:

- camel-case response with `"labels":["source:psyche-build"]` yields that exact vector;
- snake-case response preserves the same `labels` field;
- missing `labels` yields an empty vector for old-daemon compatibility;
- non-array, non-string member, more than 16 values, duplicate, empty, over-64-byte, non-ASCII, or illegal-character labels cause `normalize_session` to return `None`.

- [ ] Run the focused test and confirm it fails.

```bash
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml coven_sessions::tests::normalizes -- --nocapture
```

- [ ] Add `labels: Vec<String>` to `CovenSessionSummary` and a fail-closed parser matching the daemon contract.

```rust
fn normalized_labels(fields: &Map<String, Value>) -> Option<Vec<String>> {
    let Some(value) = fields.get("labels") else {
        return Some(Vec::new());
    };
    let values = value.as_array()?;
    if values.len() > 16 {
        return None;
    }
    let mut labels = Vec::with_capacity(values.len());
    let mut seen = HashSet::with_capacity(values.len());
    for value in values {
        let label = value.as_str()?;
        if label.is_empty() || label.len() > 64 || !label.is_ascii()
            || !label.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
            || !seen.insert(label)
        {
            return None;
        }
        labels.push(label.to_string());
    }
    Some(labels)
}
```

Populate the summary with `labels: normalized_labels(fields)?`. Keep the existing canonical path, cwd ownership, and session-ID checks intact.

- [ ] Run focused and Rust crate verification.

```bash
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml coven_sessions::tests -- --nocapture
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

### Task 5: Filter before Psyche grouping and search

**Working directory:** `/Users/buns/Documents/GitHub/OpenCoven/psyche-build/.worktrees/native-coven-attach`

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/sessions/session-model.mjs`
- Modify: `native/macos/psyche-build-tauri/web/sessions/session-model.d.mts`
- Regenerate: `native/macos/psyche-build-tauri/web/sessions.bundle.js`
- Modify: `__tests__/tauriSessionModel.test.ts`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`

- [ ] Write a failing eligibility matrix in `tauriSessionModel.test.ts`.

Use an exact-labeled `starting`, `running`, and `waiting` session as the only expected rows. Include and reject:

- exact-labeled `idle`, `completed`, `failed`, `killed`, `orphaned`, and `archived` sessions;
- active sessions with missing labels, `[]`, `source:foreign`, and near misses such as `source:psyche-build-extra`;
- malformed records and unsafe IDs already covered by the model.

Then search for the title and ID of a hidden completed or foreign session and assert it still produces no Coven row.

- [ ] Update siderail fixtures that intentionally render remote rows so they carry `labels: ['source:psyche-build']` and an active status. Add the screenshot regression: many same-project completed/foreign records yield no Coven rows, while one exact-labeled running record yields one row.

- [ ] Run focused JS tests and confirm the new assertions fail.

```bash
pnpm test -- __tests__/tauriSessionModel.test.ts __tests__/tauriCovenSessionSiderail.test.ts
```

- [ ] Add the eligibility helper and filter at the earliest model boundary.

```javascript
export const PSYCHE_COVEN_SOURCE_LABEL = 'source:psyche-build';

export function isPsycheOwnedActiveCovenSession(session) {
  return Array.isArray(session?.labels)
    && session.labels.includes(PSYCHE_COVEN_SOURCE_LABEL)
    && statusPresentation(session?.status).live;
}
```

Change the `groupCovenSessions` loop guard to include:

```javascript
if (!session || !isPsycheOwnedActiveCovenSession(session)
  || !isSafeCovenSessionId(session.id)
  || typeof session.projectRoot !== 'string' || !session.projectRoot) {
  continue;
}
```

Also filter the `remote` input at the start of `filterProjectSessions` so that helper remains fail-closed even when called directly:

```javascript
const remote = (Array.isArray(covenSessions) ? covenSessions : [])
  .filter(isPsycheOwnedActiveCovenSession);
```

These two boundary checks ensure ineligible sessions never enter `sessionsByProject`, stale discovery state, rail grouping, or search. Do not add a UI-only hide condition.

- [ ] Extend declarations.

```typescript
export type CovenSession = {
  labels?: string[];
};

export const PSYCHE_COVEN_SOURCE_LABEL: 'source:psyche-build';
export function isPsycheOwnedActiveCovenSession(session: Partial<CovenSession>): boolean;
```

- [ ] Regenerate the committed bundle and verify focused behavior.

```bash
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm test -- __tests__/tauriSessionModel.test.ts __tests__/tauriCovenSessionSiderail.test.ts
pnpm typecheck
```

### Task 6: Mark native chat and reject relabeling on attach

**Working directory:** `/Users/buns/Documents/GitHub/OpenCoven/psyche-build/.worktrees/native-coven-attach`

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `native/macos/psyche-build-tauri/src-tauri/src/lib.rs`
- Modify: `__tests__/tauriCovenLaunch.test.ts`
- Modify: `__tests__/tauriCovenSessionNativeContract.test.ts`

- [ ] Update the JS launch contract test first: `covenChatLaunch` must contain exactly:

```typescript
env: { COVEN_SESSION_SOURCE: 'psyche-build' },
```

Keep attach descriptors unmarked. Add static/native contract assertions that chat requires the marker and attach rejects it.

- [ ] Extend Rust launch-validation tests before implementation.

Add a helper that sets `StartOptions.env`, then assert:

- chat with exactly `COVEN_SESSION_SOURCE=psyche-build` is accepted;
- chat with no env, wrong value, wrong key, or an additional env entry is rejected;
- attach with no env is accepted;
- attach carrying `COVEN_SESSION_SOURCE` or any other caller-supplied env is rejected;
- legacy launch descriptors without `launchKind` retain existing behavior.

- [ ] Run focused tests and confirm failures.

```bash
pnpm test -- __tests__/tauriCovenLaunch.test.ts __tests__/tauriCovenSessionNativeContract.test.ts
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml accepts_exact_native_coven_chat_and_attach_launches -- --nocapture
```

- [ ] Mark only native chat in `covenChatLaunch`.

```javascript
env: { COVEN_SESSION_SOURCE: "psyche-build" },
```

Do not change the `coven attach <id>` descriptor or the explicit legacy `/new-psyche` tmux path.

- [ ] Enforce the exact descriptor in `validate_coven_launch_with`.

```rust
const COVEN_SESSION_SOURCE: &str = "COVEN_SESSION_SOURCE";
const PSYCHE_SESSION_SOURCE: &str = "psyche-build";

fn has_exact_psyche_source(env: Option<&HashMap<String, String>>) -> bool {
    matches!(env, Some(values) if values.len() == 1
        && values.get(COVEN_SESSION_SOURCE).map(String::as_str) == Some(PSYCHE_SESSION_SOURCE))
}

fn has_no_launch_env(env: Option<&HashMap<String, String>>) -> bool {
    env.is_none_or(HashMap::is_empty)
}
```

In the `coven-chat` branch, reject unless `has_exact_psyche_source(options.env.as_ref())`. In `coven-attach`, reject unless `has_no_launch_env(options.env.as_ref())`. Keep command, argument, safe-ID, and resolved-executable checks unchanged. If the repository's Rust toolchain does not support `Option::is_none_or`, use `env.map_or(true, HashMap::is_empty)`.

- [ ] Run focused and combined Psyche verification.

```bash
pnpm test -- __tests__/tauriCovenLaunch.test.ts __tests__/tauriCovenSessionNativeContract.test.ts __tests__/tauriSessionModel.test.ts __tests__/tauriCovenSessionSiderail.test.ts
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml accepts_exact_native_coven_chat_and_attach_launches -- --nocapture
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
```

### Task 7: Document packaged acceptance and commit Psyche

**Working directory:** `/Users/buns/Documents/GitHub/OpenCoven/psyche-build/.worktrees/native-coven-attach`

**Files:**

- Modify: `docs/SMOKE.md`
- Verify all Psyche files from Tasks 4–6

- [ ] Update the native physical-pane acceptance section with this exact behavioral sequence:

1. Start a Coven Code session from Psyche and confirm it opens in a physical Tauri pane without Psyche tmux.
2. Confirm exactly one active daemon-backed Coven row appears for that new session.
3. Start a concurrent active Coven Code session outside Psyche in the same repository and confirm it never appears.
4. Complete the Psyche-created session and confirm its Coven row disappears after the next successful refresh.
5. Confirm the local pane lifecycle remains unchanged and `coven attach <id>` does not mutate daemon provenance.

- [ ] Run the complete Psyche verification gate.

```bash
pnpm test -- --maxWorkers=1
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
git diff --check
```

Use one Vitest worker because unrelated machine-local load generators previously made the default parallel run unreliable. A test failure is still a failure; do not attribute it to load without reproducing and proving that distinction.

- [ ] Review the complete Psyche diff and confirm no tmux regression or unrelated file was included.

```bash
git status --short
git diff --stat
git diff -- native/macos/psyche-build-tauri/web/main.js native/macos/psyche-build-tauri/src-tauri/src/lib.rs native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs native/macos/psyche-build-tauri/web/sessions/session-model.mjs native/macos/psyche-build-tauri/web/sessions/session-model.d.mts __tests__/tauriCovenLaunch.test.ts __tests__/tauriCovenSessionNativeContract.test.ts __tests__/tauriSessionModel.test.ts __tests__/tauriCovenSessionSiderail.test.ts docs/SMOKE.md
```

- [ ] Commit the verified Psyche implementation separately from the already committed design and plan docs.

```bash
git add native/macos/psyche-build-tauri/web/main.js native/macos/psyche-build-tauri/src-tauri/src/lib.rs native/macos/psyche-build-tauri/src-tauri/src/coven_sessions.rs native/macos/psyche-build-tauri/web/sessions/session-model.mjs native/macos/psyche-build-tauri/web/sessions/session-model.d.mts native/macos/psyche-build-tauri/web/sessions.bundle.js __tests__/tauriCovenLaunch.test.ts __tests__/tauriCovenSessionNativeContract.test.ts __tests__/tauriSessionModel.test.ts __tests__/tauriCovenSessionSiderail.test.ts docs/SMOKE.md
git commit -m "fix: show only Psyche-owned active Coven sessions"
```

### Task 8: Cross-version acceptance and publication handoff

**Working directory:** Use each isolated worktree for its build; run the packaged app from the Psyche worktree.

**Files:** No new source files expected.

- [ ] Build the verified Coven and Coven Code artifacts from their isolated worktrees. Do not replace the user's installed binaries.

```bash
cargo build --manifest-path /Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels/Cargo.toml -p coven-cli
cargo build --manifest-path /Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source/src-rust/Cargo.toml -p claurst --bin coven-code
```

Create a task-specific temporary bin directory and link the build outputs without changing installed binaries:

```bash
PSYCHE_ACCEPT_BIN="$(mktemp -d /tmp/psyche-owned-sessions.XXXXXX)"
ln -s /Users/buns/Documents/GitHub/OpenCoven/coven/.worktrees/psyche-external-session-labels/target/debug/coven "$PSYCHE_ACCEPT_BIN/coven"
ln -s /Users/buns/Documents/GitHub/OpenCoven/coven-code/.worktrees/psyche-session-source/src-rust/target/debug/coven-code "$PSYCHE_ACCEPT_BIN/coven-code"
PATH="$PSYCHE_ACCEPT_BIN:$PATH" command -v coven
PATH="$PSYCHE_ACCEPT_BIN:$PATH" command -v coven-code
PATH="$PSYCHE_ACCEPT_BIN:$PATH" coven --version
PATH="$PSYCHE_ACCEPT_BIN:$PATH" coven-code --version
```

Prepend that directory only to the packaged app process's `PATH`. After acceptance, verify `PSYCHE_ACCEPT_BIN` begins with `/tmp/psyche-owned-sessions.` before removing that exact directory. Do not mutate global shell configuration or installed packages.

- [ ] Run packaged Psyche acceptance, not only web preview acceptance.

```bash
pnpm --dir native/macos/psyche-build-tauri build
```

Open the generated `.app`, execute the five-step `docs/SMOKE.md` scenario, and capture these proofs:

- the native chat launch has the source marker;
- the daemon record contains exactly `source:psyche-build`;
- the rail contains only exact-labeled active rows;
- same-project externally launched active history is absent;
- completion removes the daemon-backed row;
- attach does not alter labels;
- no native chat or attach path uses Psyche tmux.

- [ ] Re-run repository status checks and report commit SHAs, test totals, artifact path, and any proof gaps. Do not claim completion if packaged acceptance was not performed.

- [ ] Stop for explicit publication approval. Once approved, publish in dependency order as three separate PRs: Coven, Coven Code, Psyche Build. Before each PR, refresh remote branch and PR state through `gh api` REST, rerun the repository's required verification, and keep the change squashable.
