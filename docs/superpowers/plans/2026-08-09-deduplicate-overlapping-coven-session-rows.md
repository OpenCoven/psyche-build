# Deduplicate Overlapping Coven Session Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each eligible Coven daemon session ID exactly once across overlapping saved parent-repository and explicit-worktree projects.

**Architecture:** Build one deterministic session-to-project assignment map from the already filtered discovery state. An exact saved-project root wins; otherwise a project explicitly listing the session root as a worktree owns it, with deepest-root and stable-ID tie-breakers. Rendering and attach retry checks consume the same assignment logic, while Rust discovery and daemon records remain unchanged.

**Tech Stack:** JavaScript, Tauri web UI, Vitest, pnpm, packaged macOS acceptance.

---

## Preconditions

- Work only in `/Users/buns/Documents/GitHub/OpenCoven/psyche-build/.worktrees/native-coven-attach`.
- Start from commit `017794e` on `feat/native-coven-attach` with a clean worktree.
- Preserve the accepted provenance/active filter, native chat/attach behavior, and local Agents/Shells rows.
- Do not touch the Coven or Coven Code worktrees, normal daemon state, saved user projects, global installs, or existing acceptance proof at `/tmp/psyche-packaged-acceptance.OdCPm1`.
- Do not push, open a PR, merge, release, or install. Commit only after verification.

### Task 1: Assign each eligible daemon session ID to one saved project

**Files:**

- Modify: `native/macos/psyche-build-tauri/web/main.js`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`

- [ ] **Step 1: Add the failing overlap regressions**

Extend the siderail test harness's extracted source list so it can execute the new ownership helpers once they exist:

```typescript
const sources = [
  extractFunctionSource(mainJs, 'covenProjectCandidate'),
  extractFunctionSource(mainJs, 'compareCovenProjectCandidates'),
  extractFunctionSource(mainJs, 'covenSessionAssignments'),
  extractFunctionSource(mainJs, 'covenSessionsForProject'),
  extractFunctionSource(mainJs, 'covenInlineState'),
  extractFunctionSource(mainJs, 'covenToneClass'),
  extractFunctionSource(mainJs, 'createCovenSessionRow'),
  extractFunctionSource(mainJs, 'renderSessionList'),
];
```

Add a shared active owned session fixture:

```typescript
const ownedWorktreeSession = {
  id: 'owned-worktree-session',
  projectRoot: '/repo/.worktrees/task',
  title: 'Owned worktree session',
  status: 'running',
  labels: ['source:psyche-build'],
};
```

Add these behavioral tests:

```typescript
it('renders an overlapping daemon session once under the exact-root project', () => {
  const renderer = createRenderer({
    projects: [
      {
        id: 'parent', name: 'Parent', root: '/repo',
        worktrees: [{
          path: '/repo/.worktrees/task', branch: 'task', is_main: false,
          dirty: false, missing: false,
        }],
      },
      { id: 'task', name: 'Task', root: '/repo/.worktrees/task' },
    ],
    sessions: [ownedWorktreeSession],
  });

  renderer.render();

  const rows = renderer.sessionListEl.querySelectorAll('.session-coven-row');
  expect(rows).toHaveLength(1);
  expect(rows[0].dataset.sessionId).toBe('owned-worktree-session');
  const groups = renderer.sessionListEl.querySelectorAll('.session-group');
  expect(groups).toHaveLength(1);
  expect(groups[0].textContent).toContain('Task');
  expect(groups[0].textContent).not.toContain('Parent');
});

it('keeps overlap ownership stable when saved project order is reversed', () => {
  const explicit = { id: 'task', name: 'Task', root: '/repo/.worktrees/task' };
  const parent = {
    id: 'parent', name: 'Parent', root: '/repo',
    worktrees: [{
      path: '/repo/.worktrees/task', branch: 'task', is_main: false,
      dirty: false, missing: false,
    }],
  };
  for (const projects of [[parent, explicit], [explicit, parent]]) {
    const renderer = createRenderer({ projects, sessions: [ownedWorktreeSession] });
    renderer.render();
    expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
    const groups = renderer.sessionListEl.querySelectorAll('.session-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('Task');
    expect(groups[0].textContent).not.toContain('Parent');
  }
});

it('renders a worktree session under its parent when no exact-root project is saved', () => {
  const renderer = createRenderer({
    projects: [{
      id: 'parent', name: 'Parent', root: '/repo',
      worktrees: [{
        path: '/repo/.worktrees/task', branch: 'task', is_main: false,
        dirty: false, missing: false,
      }],
    }],
    sessions: [ownedWorktreeSession],
  });
  renderer.render();
  expect(renderer.sessionListEl.querySelectorAll('.session-coven-row')).toHaveLength(1);
  const groups = renderer.sessionListEl.querySelectorAll('.session-group');
  expect(groups).toHaveLength(1);
  expect(groups[0].textContent).toContain('Parent');
});
```

- [ ] **Step 2: Run the focused test and prove RED**

```bash
pnpm exec vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: the overlap test finds two `.session-coven-row` elements because `covenSessionsForProject` independently consumes the same worktree bucket for both saved projects. The parent-only baseline should already pass.

- [ ] **Step 3: Implement deterministic global ownership**

Replace the current root-concatenation implementation of `covenSessionsForProject` with these focused helpers near the existing discovery-scope functions:

```javascript
function covenProjectCandidate(project, sessionRoot) {
  if (!project || !project.id || !sessionRoot) return null;
  if (project.root === sessionRoot) {
    return { project: project, rank: 0, depth: project.root.length };
  }
  var ownsWorktree = (project.worktrees || []).some(function (worktree) {
    return worktree && worktree.path === sessionRoot && !worktree.missing &&
      !worktree.prunable && !worktree.bare;
  });
  if (!ownsWorktree) return null;
  return {
    project: project,
    rank: 1,
    depth: typeof project.root === "string" ? project.root.length : 0,
  };
}

function compareCovenProjectCandidates(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.depth !== right.depth) return right.depth - left.depth;
  var leftId = String(left.project.id);
  var rightId = String(right.project.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function covenSessionAssignments() {
  var sessionsById = new Map();
  covenDiscovery.sessionsByProject.forEach(function (sessions) {
    (sessions || []).forEach(function (session) {
      if (session && session.id && !sessionsById.has(session.id)) {
        sessionsById.set(session.id, session);
      }
    });
  });

  var assignments = new Map();
  sessionsById.forEach(function (session) {
    var owner = state.projects
      .map(function (project) {
        return covenProjectCandidate(project, session.projectRoot);
      })
      .filter(Boolean)
      .sort(compareCovenProjectCandidates)[0];
    if (!owner) return;
    var projectSessions = assignments.get(owner.project.id) || [];
    projectSessions.push(session);
    assignments.set(owner.project.id, projectSessions);
  });
  return assignments;
}

function covenSessionsForProject(project, assignments) {
  var ownedSessions = assignments || covenSessionAssignments();
  return ownedSessions.get(project.id) || [];
}
```

Compute assignments once per rail render before iterating projects:

```javascript
var covenAssignments = covenSessionAssignments();

state.projects.forEach(function (project) {
  var localRows = state.threads.filter(function (thread) {
    return thread.projectId === project.id && !thread.hidden;
  });
  var remoteRows = covenSessionsForProject(project, covenAssignments);
  var railModel = PsycheSessions.buildProjectRailModel(
    project, localRows, remoteRows, currentSearchQuery
  );
});
```

Only insert the assignment construction and replace the existing
`covenSessionsForProject(project)` call with the two-argument call; retain the
remainder of the existing `state.projects.forEach` body byte-for-byte.

Leave the attach retry call as `covenSessionsForProject(project)` so it recomputes from current state after refresh. Do not alter `groupCovenSessions`, the provenance/active predicate, Rust discovery, search filtering, or local pane grouping.

- [ ] **Step 4: Run focused tests and make them green**

```bash
pnpm exec vitest --run __tests__/tauriCovenSessionSiderail.test.ts __tests__/tauriSessionModel.test.ts __tests__/tauriCovenSessionLifecycle.test.ts
```

Expected: all tests pass; overlap produces one exact-root row, parent-only fallback remains visible, and existing active/provenance/stale behavior remains green.

- [ ] **Step 5: Run the complete source verification gate**

```bash
pnpm exec vitest --run --minWorkers=1 --maxWorkers=1
pnpm typecheck
pnpm build
pnpm smoke
pnpm smoke:pack
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml -- --check
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml
git diff --check
```

Expected: the full Vitest, TypeScript, build, smoke, package, and Rust gates remain green. Record exact counts and distinguish known pre-existing warnings from failures.

- [ ] **Step 6: Review and commit the corrective patch**

```bash
git status --short
git diff -- native/macos/psyche-build-tauri/web/main.js __tests__/tauriCovenSessionSiderail.test.ts
git add -f native/macos/psyche-build-tauri/web/main.js
git add __tests__/tauriCovenSessionSiderail.test.ts
git diff --cached --check
git commit -m "fix(macos): deduplicate overlapping Coven session rows"
```

Expected: exactly the production rail assignment seam and its behavioral test file are committed; no generated bundle, dependency, runtime proof, or unrelated path changes.

### Task 2: Repeat packaged overlap acceptance

**Files:** No source changes expected.

- [ ] **Step 1: Build a fresh packaged app**

```bash
pnpm --dir native/macos/psyche-build-tauri build
```

Record the `.app`, DMG, and fresh SHA-256. Do not reuse the pre-fix app as proof.

- [ ] **Step 2: Create a new isolated runtime without deleting prior proof**

Create a new `mktemp -d /tmp/psyche-overlap-acceptance.XXXXXX` root with `bin` and `coven-home`, linking the already verified local Coven commit `57b9bdee` and Coven Code commit `0a8cd477`. Keep `/tmp/psyche-packaged-acceptance.OdCPm1` untouched.

Launch the new isolated daemon and packaged app with the temporary `PATH`, `COVEN_HOME`, and explicit `COVEN_ENGINE_BIN`. Computer Use remains authorized for this already-confirmed local packaged acceptance; use `node_repl` plus `@oai/sky` for UI interactions and do not alter saved project state.

- [ ] **Step 3: Prove overlap cardinality and preserved provenance behavior**

With the existing saved parent-repository and explicit-worktree projects both present:

1. Start one Psyche-owned active chat under the explicit worktree.
2. Prove isolated daemon JSON contains exactly one active owned ID with `source:psyche-build`.
3. Prove the entire rail contains exactly one row for that ID and it is under the exact-root worktree project.
4. Start one concurrent unlabeled same-project external session; prove daemon JSON contains it and rail cardinality stays one.
5. Complete both sessions; prove the owned row disappears and local pane behavior remains unchanged.
6. Prove no app-owned tmux process exists.

- [ ] **Step 4: Clean up and report**

Gracefully stop only the test-created app, sessions, and isolated daemon. Preserve or remove the new temp root based on whether it is required as durable proof, without touching the earlier proof root. Recheck all three worktrees are clean at their exact commits.

Report source verification totals, packaged evidence, artifact checksum, retained proof paths, known signing warnings, and the unchanged publication order: Coven → Coven Code → Psyche Build. Stop for explicit publication approval.
