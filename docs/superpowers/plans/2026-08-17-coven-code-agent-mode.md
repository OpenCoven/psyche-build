# Coven Code Agent Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every new Coven agent pane launch, display, and persist as Coven Code while migrating saved `coven-chat` panes to the canonical `coven-code` identity.

**Architecture:** Normalize the one legacy persistence value at the workspace-model boundary, then use `coven-code` exclusively in the live JavaScript and Rust launch contracts. Keep `coven-attach` unchanged, preserve the existing secure `coven code --session-id` command and provenance marker, and update metrics, pane classification, UI copy, generated bundles, tests, and smoke documentation together.

**Tech Stack:** Tauri 2, Rust, plain browser JavaScript/HTML, ES modules, Vitest, pnpm, esbuild

---

## File Structure

- Modify `native/desktop/psyche-build-tauri/web/workspace/workspace-model.mjs`
  - Accept canonical `coven-code` session descriptors and convert exact legacy
    `coven-chat` values before restored sessions enter live state.
- Modify `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs`
  - Validate only `coven-code` and `coven-attach` protected launch kinds and use
    Coven Code terminology in validation errors and Rust tests.
- Modify `native/desktop/psyche-build-tauri/web/main.js`
  - Rename the canonical launch builder, use `coven-code` throughout live pane
    state, and update all agent-mode labels and command hints.
- Modify `native/desktop/psyche-build-tauri/web/index.html`
  - Label the Ctrl+A action as Coven Code.
- Modify `native/desktop/psyche-build-tauri/web/panes/pane-footer.mjs`
  - Classify `coven-code` panes as agent panes.
- Modify `native/desktop/psyche-build-tauri/web/status/status-model.mjs`
  - Count `coven-code` panes as local agents.
- Regenerate `native/desktop/psyche-build-tauri/web/workspace.bundle.js`,
  `native/desktop/psyche-build-tauri/web/panes.bundle.js`, and
  `native/desktop/psyche-build-tauri/web/status.bundle.js`.
- Modify `__tests__/tauriSessionPersistence.test.ts`
  - Prove exact legacy migration and canonical persistence/UI contracts.
- Modify `__tests__/tauriCovenLaunch.test.ts`
  - Prove canonical launch descriptors, retry, duplication, deduplication,
    metrics, and Rust validation use `coven-code`.
- Modify `__tests__/tauriAgentPicker.test.ts`
  - Prove the picker displays and delegates to Coven Code.
- Modify `__tests__/tauriCovenSessionLifecycle.test.ts`
  - Update persistent-kind fixtures to `coven-code`.
- Modify `__tests__/tauriFooterStatusBar.test.ts`
  - Update local-agent status fixtures to `coven-code`.
- Modify `__tests__/tauriPaneFooter.test.ts`
  - Update agent-pane and Coven metrics fixtures to `coven-code`.
- Modify `__tests__/tauriPhysicalPanes.test.ts`
  - Update persistent-pane and explicit-launch fixtures to `coven-code`.
- Modify `docs/SMOKE.md`
  - Describe explicit `coven code` launches instead of Coven Chat.

### Task 1: Migrate Persisted Coven Chat Metadata

**Files:**

- Modify: `native/desktop/psyche-build-tauri/web/workspace/workspace-model.mjs:1-190`
- Test: `__tests__/tauriSessionPersistence.test.ts:34-200`

- [ ] **Step 1: Replace the legacy retry test with migration and canonical descriptor tests**

In `__tests__/tauriSessionPersistence.test.ts`, replace
`preserves safe Coven chat identifiers needed for explicit retry` with:

```typescript
  test('migrates legacy Coven descriptors to Coven Code metadata', () => {
    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'code-legacy',
        projectId: 'project-a',
        worktreePath: '/repo',
        name: 'Coven',
        kind: 'coven-chat',
        launchKind: 'coven-chat',
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
      }),
    ).toEqual({
      id: 'code-legacy',
      projectId: 'project-a',
      worktreePath: '/repo',
      name: 'Coven',
      kind: 'coven-code',
      launchKind: 'coven-code',
      hidden: false,
      covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
    });
  });

  test('preserves canonical Coven Code identifiers needed for explicit retry', () => {
    expect(
      workspaceModel.sanitizeSessionDescriptor({
        id: 'code-current',
        projectId: 'project-a',
        worktreePath: '/repo',
        name: 'Coven Code',
        kind: 'coven-code',
        launchKind: 'coven-code',
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
      }),
    ).toEqual({
      id: 'code-current',
      projectId: 'project-a',
      worktreePath: '/repo',
      name: 'Coven Code',
      kind: 'coven-code',
      launchKind: 'coven-code',
      hidden: false,
      covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
    });
  });
```

- [ ] **Step 2: Add a workspace-level assertion that the migrated value is the saved model value**

Add this test after the descriptor tests:

```typescript
  test('normalizes legacy Coven metadata before workspace state is returned', () => {
    expect(
      workspaceModel.sanitizeWorkspaceV3({
        version: 3,
        activeProjectId: 'project-a',
        activeThreadId: 'code-legacy',
        projects: [{ id: 'project-a', root: '/repo' }],
        sessions: [{
          id: 'code-legacy',
          projectId: 'project-a',
          worktreePath: '/repo',
          name: 'Coven',
          kind: 'coven-chat',
          launchKind: 'coven-chat',
          covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
        }],
        filesPanes: [],
        paneLayouts: [],
      }),
    ).toMatchObject({
      activeThreadId: 'code-legacy',
      sessions: [{
        id: 'code-legacy',
        kind: 'coven-code',
        launchKind: 'coven-code',
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
      }],
    });
  });
```

- [ ] **Step 3: Run the persistence tests and verify they fail**

Run:

```bash
pnpm exec vitest --run __tests__/tauriSessionPersistence.test.ts
```

Expected: FAIL because `coven-code` is not allowlisted and legacy
`coven-chat` values are returned unchanged.

- [ ] **Step 4: Add the exact legacy-to-canonical normalization**

In `workspace-model.mjs`, replace the kind constants and `normalizeKind` with:

```javascript
const CANONICAL_COVEN_KIND = 'coven-code';
const LEGACY_COVEN_KIND = 'coven-chat';
const ALLOWED_KINDS = new Set([
  'shell',
  'psyche',
  CANONICAL_COVEN_KIND,
  'coven-attach',
]);

function normalizeKind(value) {
  const kind = safeString(value);
  if (kind === LEGACY_COVEN_KIND) return CANONICAL_COVEN_KIND;
  return kind && ALLOWED_KINDS.has(kind) ? kind : null;
}
```

In `sanitizeSessionDescriptor`, replace the Coven session-ID branch with:

```javascript
  if (launchKind === 'coven-attach' || launchKind === CANONICAL_COVEN_KIND) {
    const covenSessionId = safeCovenAttachmentId(saved.covenSessionId);
    if (!covenSessionId) return null;
    descriptor.covenSessionId = covenSessionId;
  }
```

The exact `LEGACY_COVEN_KIND` comparison is the only active runtime allowance
for `coven-chat`.

- [ ] **Step 5: Run the persistence tests and verify they pass**

Run:

```bash
pnpm exec vitest --run __tests__/tauriSessionPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the persistence migration**

```bash
git add \
  native/desktop/psyche-build-tauri/web/workspace/workspace-model.mjs \
  __tests__/tauriSessionPersistence.test.ts
git commit -m "fix: migrate persisted Coven Code panes"
```

### Task 2: Rename the Protected Rust Launch Contract

**Files:**

- Modify: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:1561-1615,9250-9470`
- Test: `native/desktop/psyche-build-tauri/src-tauri/src/lib.rs:9250-9470`

- [ ] **Step 1: Rename the Rust test helper and expected launch kind**

In the `#[cfg(test)]` section of `lib.rs`, replace `native_chat_options` with:

```rust
    fn native_code_options(
        session_id: Option<&str>,
        command: Option<&str>,
        args: Option<&[&str]>,
    ) -> StartOptions {
        launch_options_with_env(
            Some("coven-code"),
            session_id,
            command,
            args,
            Some(&[(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE)]),
        )
    }
```

Rename `accepts_exact_native_coven_chat_and_attach_launches` to
`accepts_exact_native_coven_code_and_attach_launches`, use
`native_code_options`, and keep the accepted arguments:

```rust
Some(&["code", "--session-id", session_id])
```

Change the environment and malformed-launch test cases so every protected new
session uses `Some("coven-code")` and every expected message begins with
`coven-code`.

- [ ] **Step 2: Add a regression that the old launch kind is rejected**

Add this test beside the accepted-launch test:

```rust
    #[test]
    fn rejects_legacy_native_coven_chat_launch_kind_after_workspace_migration() {
        let coven = "/canonical/bin/coven";
        let session_id = "12345678-1234-4abc-8def-1234567890ab";
        let legacy = launch_options_with_env(
            Some("coven-chat"),
            Some(session_id),
            Some(coven),
            Some(&["code", "--session-id", session_id]),
            Some(&[(COVEN_SESSION_SOURCE, PSYCHE_SESSION_SOURCE)]),
        );

        assert_eq!(
            validate_coven_launch_with(&legacy, Some(coven)),
            Err("unsupported launch kind: coven-chat".to_string())
        );
    }
```

- [ ] **Step 3: Run the focused Rust tests and verify they fail**

Run:

```bash
cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  native_coven \
  --locked
```

Expected: FAIL because production validation still accepts `coven-chat` and
rejects `coven-code`.

- [ ] **Step 4: Update the production validator**

Replace the launch-kind guard and Coven Code match arm in
`validate_coven_launch_with` with:

```rust
    if !matches!(launch_kind, "coven-code" | "coven-attach") {
        return Err(format!("unsupported launch kind: {launch_kind}"));
    }

    let resolved_coven = resolved_coven.ok_or_else(|| "Coven executable not found".to_string())?;
    if options.command.as_deref() != Some(resolved_coven) {
        return Err("Coven launch command does not match the resolved executable".to_string());
    }

    match launch_kind {
        "coven-code" => {
            if !has_exact_psyche_source(options.env.as_ref()) {
                return Err(
                    "coven-code requires exactly COVEN_SESSION_SOURCE=psyche-build".to_string(),
                );
            }
            let session_id = options
                .coven_session_id
                .as_deref()
                .ok_or_else(|| "coven-code requires a session id".to_string())?;
            if !is_safe_session_id(session_id) {
                return Err("coven-code session id is unsafe".to_string());
            }
            match options.args.as_deref() {
                Some([verb, flag, argument])
                    if verb == "code" && flag == "--session-id" && argument == session_id =>
                {
                    Ok(())
                }
                _ => Err(
                    "coven-code requires exactly 'code --session-id' and the validated session id"
                        .to_string(),
                ),
            }
        }
```

Leave the `coven-attach` arm unchanged.

- [ ] **Step 5: Update the launch-environment test to use Coven Code**

Replace:

```rust
apply_launch_env(&mut chat, Some(&chat_env), Some("coven-chat"));
```

with:

```rust
apply_launch_env(&mut code, Some(&code_env), Some("coven-code"));
```

Rename the local variables from `chat`/`chat_env` to `code`/`code_env`; the
assertion must still prove `COVEN_SESSION_SOURCE=psyche-build` replaces an
inherited value.

- [ ] **Step 6: Run the focused Rust tests and verify they pass**

Run:

```bash
cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  native_coven \
  --locked
```

Expected: PASS.

- [ ] **Step 7: Commit the Rust contract**

```bash
git add native/desktop/psyche-build-tauri/src-tauri/src/lib.rs
git commit -m "fix: validate Coven Code launch identity"
```

### Task 3: Canonicalize the Live Desktop Agent Identity

**Files:**

- Modify: `native/desktop/psyche-build-tauri/web/main.js:8870-8910,11250-11395,12515-12725`
- Modify: `native/desktop/psyche-build-tauri/web/index.html:100-110`
- Modify: `native/desktop/psyche-build-tauri/web/panes/pane-footer.mjs:12-24`
- Modify: `native/desktop/psyche-build-tauri/web/status/status-model.mjs:8-16`
- Test: `__tests__/tauriAgentPicker.test.ts:80-205,1190-1240`
- Test: `__tests__/tauriCovenLaunch.test.ts:440-870,1400-1445,2100-2135`
- Test: `__tests__/tauriSessionPersistence.test.ts:1140-1170`
- Test: `__tests__/tauriCovenSessionLifecycle.test.ts`
- Test: `__tests__/tauriFooterStatusBar.test.ts`
- Test: `__tests__/tauriPaneFooter.test.ts`
- Test: `__tests__/tauriPhysicalPanes.test.ts`

- [ ] **Step 1: Update picker expectations to the Coven Code contract**

In `__tests__/tauriAgentPicker.test.ts`, change the Coven registry expectation
to:

```typescript
{ id: 'coven-code', label: 'Coven Code', command: null, args: ['code'], kind: 'coven-code' }
```

Change the delegated result fixture to:

```typescript
const result = { kind: 'coven-code' };
```

Use the same canonical registry entry in the delegation and missing-Coven
tests. Replace the menu/help expectations with:

```typescript
expect(indexHtml).toMatch(
  /id="new-pane-agent"[\s\S]*?Agent — Coven Code[\s\S]*?<span class="new-pane-key">⌃A<\/span>/,
);
expect(mainJs).toMatch(/\["New agent pane \(Coven Code\)", "⌃A"\]/);
expect(mainJs).not.toMatch(/\["New agent pane \(Coven Code\)", "⌘T"\]/);
```

- [ ] **Step 2: Update canonical launch descriptor tests**

In `__tests__/tauriCovenLaunch.test.ts`, rename the test
`builds a Coven chat descriptor scoped to the project and selected worktree`
to `builds a Coven Code descriptor scoped to the project and selected
worktree`.

Compile `functionSource('covenCodeLaunch')` and expect:

```typescript
{
  command: '/opt/homebrew/bin/coven',
  args: ['code', '--session-id', COVEN_SESSION_ID],
  env: { COVEN_SESSION_SOURCE: 'psyche-build' },
  projectRoot: '/repo',
  cwd: '/repo/.worktrees/feature',
  kind: 'coven-code',
  launchKind: 'coven-code',
  covenSessionId: COVEN_SESSION_ID,
  metricsProvider: 'coven',
}
```

Rename the duplicate and secure-session failure tests from Coven Chat to Coven
Code. Their source function and injected dependency must be
`covenCodeLaunch`; use `kind: 'coven-code'`, `launchKind: 'coven-code'`, and
the default pane name `Coven Code`.

- [ ] **Step 3: Add source assertions for the displayed command and success copy**

Add this test to `tauriAgentPicker.test.ts`:

```typescript
  it('describes the Coven entry as coven code across agent-mode surfaces', () => {
    expect(functionSource('renderAgentPicker')).toContain('"coven code"');
    expect(mainJs).toContain('desc: "Spawn a new Coven Code thread"');
    expect(mainJs).toContain('toast("Coven Code opened")');
    expect(indexHtml).toContain(
      'Agent — Coven Code<span class="new-pane-key">⌃A</span>',
    );
  });
```

- [ ] **Step 4: Run the launch and picker tests and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriSessionPersistence.test.ts
```

Expected: FAIL because the registry, launch builder name, pane metadata, and
visible labels still use the old identity.

- [ ] **Step 5: Rename the canonical launch builder and descriptor**

In `main.js`, rename every call and definition of `covenChatLaunch` to
`covenCodeLaunch`. Implement the builder as:

```javascript
  function covenCodeLaunch(project, worktreePath) {
    var worktree = worktreePath ? { path: worktreePath } : selectedWorktree(project);
    var sessionId = makeCovenSessionId();
    if (!sessionId) return null;
    return {
      command: state.env.coven_path,
      args: ["code", "--session-id", sessionId],
      env: { COVEN_SESSION_SOURCE: "psyche-build" },
      projectRoot: project.root,
      cwd: worktree.path,
      kind: "coven-code",
      launchKind: "coven-code",
      covenSessionId: sessionId,
      metricsProvider: "coven",
    };
  }
```

In `spawnCovenThread`, call `covenCodeLaunch` and create the thread with:

```javascript
    return createThread({
      project: currentProject,
      worktreePath: launch.cwd,
      name: "Coven Code",
      kind: "coven-code",
      launch: launch,
    });
```

In `ensureProjectCoven`, deduplicate on:

```javascript
t.kind === "coven-code"
```

- [ ] **Step 6: Update the agent registry and command hint**

Replace the Coven entry in `agentLaunchOptions` with:

```javascript
{ id: "coven-code", label: "Coven Code", command: null, args: ["code"], kind: "coven-code" }
```

In `renderAgentPicker`, render:

```javascript
escapeHtml(entry.id === "coven-code" ? "coven code" : (entry.command || ""))
```

Keep the special `spawnAgentThread` delegation to `ensureProjectCoven(project)`
so the picker shares deduplication and the in-flight launch guard.

- [ ] **Step 7: Update agent-mode labels**

In `main.js`, use these exact strings:

```javascript
desc: "Spawn a new Coven Code thread"
toast("Coven Code opened")
["New agent pane (Coven Code)", "⌃A"]
```

In `index.html`, use:

```html
<span class="new-pane-glyph">✳</span>Agent — Coven Code<span class="new-pane-key">⌃A</span>
```

- [ ] **Step 8: Update the live-state test fixtures**

Across the five test files in this task, replace active launch fixtures and
expectations:

```typescript
kind: 'coven-chat'
launchKind: 'coven-chat'
```

with:

```typescript
kind: 'coven-code'
launchKind: 'coven-code'
```

Update persistent-kind sets to:

```typescript
new Set(['shell', 'psyche', 'coven-code', 'coven-attach'])
```

Update source-contract regexes to match
`thread.launch.launchKind === "coven-code"`.

Rename every active test description containing `Coven chat` to use
`Coven Code`.

Do not change the Task 1 legacy migration input fixture in
`tauriSessionPersistence.test.ts`.

Add this persistence regression to `tauriSessionPersistence.test.ts`:

```typescript
  test('persists restored Coven Code sessions without legacy metadata', () => {
    const persistableSession = Function(
      `"use strict"; return (${functionSource('persistableSession')});`,
    )() as (thread: Record<string, any>) => Record<string, unknown> | null;

    expect(persistableSession({
      id: 'code-restored',
      projectId: 'project-a',
      worktreePath: '/repo',
      name: 'Coven Code',
      kind: 'coven-code',
      hidden: false,
      launch: {
        launchKind: 'coven-code',
        covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
      },
    })).toEqual({
      id: 'code-restored',
      projectId: 'project-a',
      worktreePath: '/repo',
      name: 'Coven Code',
      kind: 'coven-code',
      launchKind: 'coven-code',
      hidden: false,
      covenSessionId: '12345678-1234-4abc-8def-1234567890ab',
    });
  });
```

- [ ] **Step 9: Add a live-source regression that the legacy identifier is absent**

Add this test to `__tests__/tauriCovenLaunch.test.ts`:

```typescript
  it('keeps the legacy Coven identifier out of live desktop state', () => {
    expect(mainJs).not.toContain('"coven-chat"');
    expect(mainJs).toContain('"coven-code"');
    expect(libRs).toContain('if !matches!(launch_kind, "coven-code" | "coven-attach")');
  });
```

- [ ] **Step 10: Run the combined desktop suites and verify they fail**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionPersistence.test.ts
```

Expected: FAIL because persistence, focus rules, metrics, status counts, and
footer classification still compare against `coven-chat`.

- [ ] **Step 11: Replace all live `main.js` kind comparisons**

In `main.js`, replace every live-state string literal:

```javascript
"coven-chat"
```

with:

```javascript
"coven-code"
```

This includes:

- passive focus exclusion in `activatePaneLayoutFocus`, `setActiveProject`,
  `focusThread`, and `reopenThread`;
- `persistableSession` and `isPersistentThread`;
- initial and restored metrics state;
- native session creation and retry lifecycle refreshes;
- duplicate-thread handling;
- sidebar/session filtering;
- attachment-aware focus behavior;
- `threadWantsMetrics` and `paneFooterState`;
- restored metrics-provider selection; and
- status-controller thread context.

After the replacement, `main.js` must contain no `coven-chat` literal.

- [ ] **Step 12: Update pane footer classification**

In `pane-footer.mjs`, set the first entry of `AGENT_PANE_KINDS` to:

```javascript
"coven-code",
```

Keep `coven-attach` and the four external-agent kinds unchanged.

- [ ] **Step 13: Update status-bar local-agent classification**

In `status-model.mjs`, replace the local-agent set with:

```javascript
const LOCAL_AGENT_KINDS = new Set(['coven-code', 'coven-attach']);
```

- [ ] **Step 14: Run the combined desktop suites and verify they pass**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 15: Commit the canonical desktop identity**

```bash
git add \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/panes/pane-footer.mjs \
  native/desktop/psyche-build-tauri/web/status/status-model.mjs \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionPersistence.test.ts
git commit -m "fix: launch agents as Coven Code"
```

### Task 4: Regenerate Bundles and Update Smoke Documentation

**Files:**

- Modify: `native/desktop/psyche-build-tauri/web/workspace.bundle.js`
- Modify: `native/desktop/psyche-build-tauri/web/panes.bundle.js`
- Modify: `native/desktop/psyche-build-tauri/web/status.bundle.js`
- Modify: `docs/SMOKE.md:75-90,150-215`

- [ ] **Step 1: Update native persistence smoke copy**

In `docs/SMOKE.md`, replace native persistence step 3 with:

```markdown
3. Press `Ctrl+A` and confirm Coven Code opens in the same worktree by running
   `coven code --session-id <id>`.
```

- [ ] **Step 2: Make the Coven physical-pane smoke explicit and canonical**

Replace physical-pane steps 2-3 with:

```markdown
2. Open the linked-worktree path itself as the project and confirm project
   opening does not create an agent pane.
3. Press `Ctrl+A` or choose **Open Coven Terminal** and confirm one
   `coven code --session-id <id>` PTY is created for that linked worktree.
   Define `PSYCHE_SESSION_ID=<id>` from its daemon session.
```

Replace step 15 with:

```markdown
15. Stop the daemon and confirm new Coven Code panes still launch with
    `coven code --session-id <id>` while the rail shows stale/unavailable
    discovery state.
```

- [ ] **Step 3: Regenerate tracked web bundles**

Run:

```bash
pnpm --filter psyche-build-tauri build:web
```

Expected: PASS and tracked changes in:

```text
native/desktop/psyche-build-tauri/web/workspace.bundle.js
native/desktop/psyche-build-tauri/web/panes.bundle.js
native/desktop/psyche-build-tauri/web/status.bundle.js
```

If another generated bundle changes without a corresponding source change,
inspect the diff and do not commit unrelated generated churn.

- [ ] **Step 4: Verify active terminology and the bounded migration exception**

Run:

```bash
git grep -n -E 'Coven chat|coven chat' -- \
  native/desktop/psyche-build-tauri \
  __tests__ \
  docs/SMOKE.md
```

Expected: no matches.

Run:

```bash
git grep -n 'coven-chat' -- \
  native/desktop/psyche-build-tauri/web/main.js \
  native/desktop/psyche-build-tauri/web/index.html \
  native/desktop/psyche-build-tauri/web/panes \
  native/desktop/psyche-build-tauri/web/status
```

Expected: no matches.

Run:

```bash
git grep -n 'coven-chat' -- \
  native/desktop/psyche-build-tauri/web/workspace/workspace-model.mjs \
  native/desktop/psyche-build-tauri/src-tauri/src/lib.rs \
  __tests__/tauriSessionPersistence.test.ts
```

Expected: matches only for the exact workspace migration constant, migration
input fixtures, and the Rust regression proving the legacy protected launch
kind is rejected.

- [ ] **Step 5: Run the complete focused regression suite**

Run:

```bash
pnpm exec vitest --run \
  __tests__/tauriAgentPicker.test.ts \
  __tests__/tauriCovenLaunch.test.ts \
  __tests__/tauriCovenSessionLifecycle.test.ts \
  __tests__/tauriFooterStatusBar.test.ts \
  __tests__/tauriPaneFooter.test.ts \
  __tests__/tauriPhysicalPanes.test.ts \
  __tests__/tauriSessionPersistence.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run Rust validation and repository type checks**

Run:

```bash
cargo test \
  --manifest-path native/desktop/psyche-build-tauri/src-tauri/Cargo.toml \
  native_coven \
  --locked
pnpm typecheck
```

Expected: both commands PASS.

- [ ] **Step 7: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff -- \
  native/desktop/psyche-build-tauri \
  __tests__ \
  docs/SMOKE.md
```

Expected: no whitespace errors; only the planned source, test, generated
bundle, and smoke-documentation files are changed. Existing unrelated
`.beads/interactions.jsonl` and `pnpm-lock.yaml` changes remain unstaged.

- [ ] **Step 8: Commit generated bundles and documentation**

```bash
git add \
  native/desktop/psyche-build-tauri/web/workspace.bundle.js \
  native/desktop/psyche-build-tauri/web/panes.bundle.js \
  native/desktop/psyche-build-tauri/web/status.bundle.js \
  docs/SMOKE.md
git commit -m "docs: describe Coven Code agent launches"
```
