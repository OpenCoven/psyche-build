# Sessions Sidebar Scannability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native Tauri sessions rail with a compact, accessible project → branch → category → session tree that is faster to scan, searchable across metadata, filterable by type/status, explicit about selection and runtime state, and persistent where the underlying sessions still exist.

**Architecture:** Keep the current dependency-free HTML/CSS/JavaScript shell and existing pane/worktree actions. Add one pure sidebar model module for normalization, status derivation, grouping, sorting, filtering, search highlighting, and persistence keys; expose it through the existing `PsycheSessions` bundle. Refactor the `main.js` rail renderer into focused DOM-builder functions while leaving project activation, worktree activation, pane focus, rename, hide, attach, interrupt, and close behavior in their current authoritative functions.

**Tech Stack:** Plain JavaScript ES modules bundled by esbuild, Tauri webview HTML/CSS, xterm.js PTY events, Vitest, TypeScript test files, pnpm.

---

## File map

- Create `native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs`
  - Pure sidebar view-model logic only: filters, status presentation, stable
    selection keys, duplicate-name differentiation, sorting, search fields,
    match ranges, category grouping, and project/branch counts.
- Modify `native/macos/psyche-build-tauri/web/sessions/session-entry.js`
  - Re-export the new sidebar model functions into the existing
    `window.PsycheSessions` bundle.
- Create `__tests__/tauriSidebarModel.test.ts`
  - Unit coverage for all pure model behavior.
- Modify `native/macos/psyche-build-tauri/web/index.html`
  - Add compact pinned tabs/search/actions/filters markup and the shared status
    legend tooltip. Promote `#session-list` to `role="tree"` with
    `treeitem`/`group` semantics; keyboard navigation is already wired.
- Modify `native/macos/psyche-build-tauri/web/main.js`
  - Persist sidebar tab/filter/project expansion/selection key, track recent PTY
    output and working state, build the tree through reusable functions, attach
    existing actions, implement search/filter/temporary expansion, and add full
    keyboard navigation.
- Modify `native/macos/psyche-build-tauri/web/styles.css`
  - Replace the current sidebar-specific visual treatment with the approved
    hierarchy, alignment grid, interaction states, status system, tooltip, and
    responsive/reduced-motion rules.
- Modify `__tests__/tauriCovenSessionSiderail.test.ts`
  - Exercise rendered hierarchy, merged Coven agents, actions, search,
    persistence hooks, ARIA, and state labels through the existing fake DOM.
- Modify `__tests__/tauriWorkspaceRail.test.ts`
  - Update source-contract assertions for the pinned controls now, then move
    the tree-role assertion into Task 4 with the keyboard/tree contract.
- Modify `__tests__/tauriSessionAttention.test.ts`
  - Verify the sidebar working/activity state uses the existing terminal-tail
    classifier without changing attention semantics.
- Regenerate `native/macos/psyche-build-tauri/web/sessions.bundle.js`
  - Produced by the existing `build:web` script after source changes.

### Task 1: Build the pure sidebar model

**Files:**
- Create: `native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs`
- Create: `__tests__/tauriSidebarModel.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/sessions/session-entry.js`

- [ ] **Step 1: Write the failing model tests**

Create `__tests__/tauriSidebarModel.test.ts` with explicit coverage for status
precedence, stable keys, type/status filters, duplicate labels, sorting,
metadata search, highlighting, temporary expansion, and Coven-under-Agents:

```ts
import { describe, expect, it } from 'vitest';

import {
  buildSidebarProjectModel,
  deriveCovenSidebarStatus,
  deriveLocalSidebarStatus,
  localSidebarSelectionKey,
  matchTextRanges,
  normalizeSidebarFilter,
  sidebarSelectionKey,
} from '../native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs';

const project = {
  id: 'psyche',
  name: 'PSYCHE-BUILD',
  root: '/repo/psyche-build',
  collapsed: false,
  selectedWorktreePath: '/repo/psyche-build-wt',
  worktrees: [{
    path: '/repo/psyche-build-wt',
    branch: 'feat/web-pane-attention',
    collapsed: true,
    dirty: true,
    missing: false,
  }],
};

describe('Tauri sidebar model', () => {
  it('derives local state with deterministic precedence', () => {
    expect(deriveLocalSidebarStatus({ status: 'exited' }, 10_000)).toMatchObject({
      key: 'exited', label: 'EXITED',
    });
    expect(deriveLocalSidebarStatus({
      status: 'running', needsAttention: true, isWorking: true, lastOutputAt: 9_999,
    }, 10_000)).toMatchObject({ key: 'attention', label: 'REPLY' });
    expect(deriveLocalSidebarStatus({
      status: 'running', spawning: true, needsAttention: false,
    }, 10_000)).toMatchObject({ key: 'busy', label: 'BUSY' });
    expect(deriveLocalSidebarStatus({
      status: 'running', isWorking: true, lastOutputAt: 1,
    }, 10_000)).toMatchObject({ key: 'busy', label: 'BUSY' });
    expect(deriveLocalSidebarStatus({
      status: 'running', lastOutputAt: 7_000,
    }, 10_000)).toMatchObject({ key: 'active', label: 'ACTIVE' });
    expect(deriveLocalSidebarStatus({
      status: 'running', lastOutputAt: 1_000,
    }, 10_000)).toMatchObject({ key: 'idle', label: 'IDLE' });
  });

  it('maps daemon status without inventing local activity evidence', () => {
    expect(deriveCovenSidebarStatus({ status: 'waiting' }).key).toBe('attention');
    expect(deriveCovenSidebarStatus({ status: 'starting' }).key).toBe('busy');
    expect(deriveCovenSidebarStatus({ status: 'running' }).key).toBe('busy');
    expect(deriveCovenSidebarStatus({ status: 'failed' }).key).toBe('exited');
  });

  it('validates filters and produces stable persisted selection keys', () => {
    expect(normalizeSidebarFilter('agents')).toBe('agents');
    expect(normalizeSidebarFilter('wat')).toBe('all');
    expect(sidebarSelectionKey({
      source: 'coven', id: 'coven-1',
    })).toBe('coven:coven-1');
    expect(localSidebarSelectionKey(
      { root: '/repo/psyche-build' },
      {
        id: 'shell-api',
        name: 'shell 8',
        kind: 'shell',
        worktreePath: '/repo/psyche-build-wt',
        launch: { command: 'pnpm', args: ['dev'] },
      },
    )).toBe(
      'psyche:/repo/psyche-build\u0000/repo/psyche-build-wt\u0000shell\u0000shell 8\u0000pnpm dev',
    );
    expect(localSidebarSelectionKey(
      { root: '/repo/psyche-build' },
      {
        id: 'shell-no-command',
        name: 'shell 7',
        kind: 'shell',
      worktreePath: '/repo/psyche-build-wt',
      },
    )).toBe(
      'psyche:/repo/psyche-build\u0000/repo/psyche-build-wt\u0000shell\u0000shell 7\u0000shell-no-command',
    );
  });

  it('groups Coven under Agents and differentiates duplicate shell names', () => {
    const result = buildSidebarProjectModel({
      project,
      localSessions: [
        {
          id: 'shell-api',
          name: 'shell 8',
          kind: 'shell',
          status: 'running',
          worktreePath: '/repo/psyche-build-wt',
          launch: { command: 'pnpm', args: ['dev'] },
          lastOutputAt: 9_000,
        },
        {
          id: 'shell-tests',
          name: 'shell 8',
          kind: 'shell',
          status: 'running',
          worktreePath: '/repo/psyche-build-wt',
          launch: { command: 'vitest', args: ['--watch'] },
          lastOutputAt: 1_000,
        },
      ],
      covenSessions: [{
        id: 'coven-1',
        title: 'Agent Coven',
        harness: 'Coven',
        status: 'running',
        cwd: '/repo/psyche-build-wt',
        projectRoot: '/repo/psyche-build',
      }],
      query: '',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });

    expect(result.branches[0].categories.map((category) => category.label))
      .toEqual(['Agents', 'Shells']);
    expect(result.branches[0].categories[0].rows[0]).toMatchObject({
      title: 'Agent Coven', source: 'coven', meta: expect.stringContaining('Coven'),
    });
    expect(result.branches[0].categories[1].rows.map((row) => row.title))
      .toEqual(['shell 8 · pnpm dev', 'shell 8 · vitest --watch']);
  });

  it('sorts selected, attention, busy, active, idle, exited, then recency', () => {
    const sessions = [
      ['idle', { status: 'running', lastOutputAt: 1_000 }],
      ['selected', { status: 'running', lastOutputAt: 1_000 }],
      ['active', { status: 'running', lastOutputAt: 9_000 }],
      ['attention', { status: 'running', needsAttention: true }],
      ['busy', { status: 'starting', spawning: true }],
      ['exited', { status: 'exited' }],
    ].map(([id, values]) => ({
      id,
      name: id,
      kind: 'shell',
      worktreePath: '/repo/psyche-build-wt',
      ...values,
    }));
    const selectedKey = localSidebarSelectionKey(project, sessions[1]);
    const result = buildSidebarProjectModel({
      project, localSessions: sessions, covenSessions: [],
      query: '', filter: 'all', selectedKey, now: 10_000,
    });

    expect(result.branches[0].categories[0].rows.map((row) => row.title))
      .toEqual(['selected', 'attention', 'busy', 'active', 'idle', 'exited']);
  });

  it('searches project, branch, type, command, harness, status, and identifier', () => {
    const base = {
      project,
      localSessions: [{
        id: 'shell-tests',
        name: 'shell 8',
        kind: 'shell',
        status: 'running',
        worktreePath: '/repo/psyche-build-wt',
        launch: { command: 'vitest', args: ['--watch'] },
        lastOutputAt: 1_000,
      }],
      covenSessions: [{
        id: 'coven-1',
        title: 'Agent Coven',
        harness: 'Coven',
        status: 'running',
        cwd: '/repo/psyche-build-wt',
        projectRoot: '/repo/psyche-build',
      }],
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    };

    for (const query of [
      'psyche-build', 'web-pane', 'shells', 'vitest', 'coven', 'busy', 'coven-1',
    ]) {
      expect(buildSidebarProjectModel({ ...base, query }).visibleCount)
        .toBeGreaterThan(0);
    }
    expect(buildSidebarProjectModel({ ...base, query: 'missing' }).visibleCount).toBe(0);
  });

  it('filters type and status while active includes busy plus active', () => {
    const localSessions = [
      {
        id: 'agent', name: 'Agent', kind: 'agent', status: 'starting',
        worktreePath: '/repo/psyche-build-wt',
      },
      {
        id: 'shell', name: 'Shell', kind: 'shell', status: 'running',
        worktreePath: '/repo/psyche-build-wt', lastOutputAt: 9_000,
      },
      {
        id: 'reply', name: 'Reply', kind: 'agent', status: 'running',
        worktreePath: '/repo/psyche-build-wt', needsAttention: true,
      },
    ];
    const build = (filter: string) => buildSidebarProjectModel({
      project, localSessions, covenSessions: [], query: '', filter,
      selectedKey: '', now: 10_000,
    });

    expect(build('agents').visibleCount).toBe(2);
    expect(build('shells').visibleCount).toBe(1);
    expect(build('active').visibleCount).toBe(2);
    expect(build('attention').visibleCount).toBe(1);
  });

  it('returns highlight ranges without changing source text', () => {
    expect(matchTextRanges('Agent Coven', 'coven')).toEqual([[6, 11]]);
    expect(matchTextRanges('shell 8 · tests', '')).toEqual([]);
  });

  it('temporarily expands matching collapsed groups', () => {
    const result = buildSidebarProjectModel({
      project,
      localSessions: [{
        id: 'shell', name: 'shell 10', kind: 'shell', status: 'running',
        worktreePath: '/repo/psyche-build-wt',
      }],
      covenSessions: [],
      query: 'shell 10',
      filter: 'all',
      selectedKey: '',
      now: 10_000,
    });
    expect(result.expanded).toBe(true);
    expect(result.branches[0].expanded).toBe(true);
    expect(project.collapsed).toBe(false);
    expect(project.worktrees[0].collapsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriSidebarModel.test.ts
```

Expected: FAIL because `sidebar-model.mjs` does not exist.

- [ ] **Step 3: Implement the pure model**

Create `native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs`.
Use the existing `buildProjectRailModel` only for worktree ownership, then apply
all new presentation logic in this module:

```js
import { hasWorkingIndicators } from './attention.mjs';
import { buildProjectRailModel, statusPresentation } from './session-model.mjs';

export const SIDEBAR_FILTERS = Object.freeze([
  'all', 'agents', 'shells', 'active', 'attention',
]);
export const SIDEBAR_ACTIVE_WINDOW_MS = 8_000;

const STATUS_ORDER = Object.freeze({
  attention: 1,
  busy: 2,
  active: 3,
  idle: 4,
  exited: 5,
});

const STATUS_PRESENTATION = Object.freeze({
  active: {
    key: 'active', label: 'ACTIVE', icon: '●',
    tooltip: 'Active — process is alive and recently produced output',
  },
  busy: {
    key: 'busy', label: 'BUSY', icon: '↻',
    tooltip: 'Busy — process is starting or actively working',
  },
  idle: {
    key: 'idle', label: 'IDLE', icon: '–',
    tooltip: 'Idle — process is alive and ready for input',
  },
  attention: {
    key: 'attention', label: 'REPLY', icon: '!',
    tooltip: 'Attention — waiting for your response',
  },
  exited: {
    key: 'exited', label: 'EXITED', icon: '×',
    tooltip: 'Exited — process has ended',
  },
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function lower(value) {
  return text(value).toLowerCase();
}

function basename(value) {
  const normalized = text(value).replace(/\/+$/, '');
  return normalized.split('/').pop() || normalized;
}

function commandLabel(thread) {
  const command = basename(thread?.launch?.command);
  const firstArg = Array.isArray(thread?.launch?.args)
    ? text(thread.launch.args[0])
    : '';
  return [command, firstArg].filter(Boolean).join(' ');
}

export function normalizeSidebarFilter(value) {
  const normalized = lower(value);
  return SIDEBAR_FILTERS.includes(normalized) ? normalized : 'all';
}

export function deriveLocalSidebarStatus(
  thread,
  now = Date.now(),
  activeWindowMs = SIDEBAR_ACTIVE_WINDOW_MS,
) {
  if (thread?.status === 'exited') return STATUS_PRESENTATION.exited;
  if (thread?.needsAttention) return STATUS_PRESENTATION.attention;
  if (thread?.spawning || thread?.status === 'starting' || thread?.isWorking) {
    return STATUS_PRESENTATION.busy;
  }
  const lastOutputAt = Number(thread?.lastOutputAt) || 0;
  if (thread?.status === 'running' && now - lastOutputAt <= activeWindowMs) {
    return STATUS_PRESENTATION.active;
  }
  return STATUS_PRESENTATION.idle;
}

export function deriveCovenSidebarStatus(session) {
  const label = statusPresentation(session?.status).label;
  if (label === 'waiting') return STATUS_PRESENTATION.attention;
  if (label === 'starting' || label === 'running') return STATUS_PRESENTATION.busy;
  return STATUS_PRESENTATION.exited;
}

export function sidebarSelectionKey(row) {
  if (row?.source === 'coven') return `coven:${text(row.id)}`;
  return [
    'psyche:',
    text(row?.projectRoot),
    '\u0000',
    text(row?.worktreePath),
    '\u0000',
    text(row?.kind || 'shell'),
    '\u0000',
    text(row?.title),
    '\u0000',
    text(row?.discriminator || row?.id),
  ].join('');
}

export function localSidebarSelectionKey(project, thread) {
  return sidebarSelectionKey({
    source: 'psyche',
    id: thread?.id,
    projectRoot: project?.root,
    worktreePath: thread?.worktreePath,
    kind: thread?.kind || 'shell',
    title: thread?.name || thread?.title || thread?.id,
    discriminator: commandLabel(thread) || thread?.id,
  });
}

export function matchTextRanges(value, query) {
  const source = String(value ?? '');
  const needle = lower(query);
  if (!needle) return [];
  const haystack = source.toLowerCase();
  const ranges = [];
  let start = 0;
  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    ranges.push([index, index + needle.length]);
    start = index + needle.length;
  }
  return ranges;
}

function matchesFilter(row, filter) {
  if (filter === 'agents') return row.type === 'agents';
  if (filter === 'shells') return row.type === 'shells';
  if (filter === 'active') return row.status.key === 'active' || row.status.key === 'busy';
  if (filter === 'attention') return row.status.key === 'attention';
  return true;
}

function searchValue(parts) {
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function normalizeLocalRow(project, worktree, thread, now) {
  const kind = thread?.kind || 'shell';
  const title = text(thread?.name || thread?.title || thread?.id);
  const command = commandLabel(thread);
  const status = deriveLocalSidebarStatus(thread, now);
  const type = kind === 'shell' ? 'shells' : 'agents';
  const meta = command || (type === 'agents' ? kind : 'ready');
  const row = {
    key: `psyche:${text(thread?.id)}`,
    source: 'psyche',
    id: text(thread?.id),
    projectRoot: text(project?.root),
    worktreePath: text(worktree?.path),
    kind,
    type,
    title,
    baseTitle: title,
    meta,
    command,
    status,
    needsAttention: status.key === 'attention',
    lastActiveAt: Number(thread?.lastOutputAt) || 0,
    value: thread,
  };
  row.selectionKey = localSidebarSelectionKey(project, thread);
  row.searchText = searchValue([
    project?.name, project?.root, worktree?.branch, worktree?.path,
    type, title, thread?.id, kind, command, status.label, status.tooltip,
  ]);
  return row;
}

function normalizeCovenRow(project, worktree, session) {
  const title = text(session?.title || session?.id);
  const status = deriveCovenSidebarStatus(session);
  const harness = text(session?.harness || 'Coven');
  const row = {
    key: `coven:${text(session?.id)}`,
    source: 'coven',
    id: text(session?.id),
    projectRoot: text(project?.root),
    worktreePath: text(worktree?.path),
    kind: 'agent',
    type: 'agents',
    title,
    baseTitle: title,
    meta: [harness, status.label.toLowerCase()].filter(Boolean).join(' · '),
    command: '',
    status,
    needsAttention: status.key === 'attention',
    lastActiveAt: Date.parse(session?.updatedAt || '') || 0,
    value: session,
  };
  row.selectionKey = sidebarSelectionKey(row);
  row.searchText = searchValue([
    project?.name, project?.root, worktree?.branch, worktree?.path,
    'agents', title, session?.id, harness, session?.status,
    status.label, status.tooltip, session?.cwd,
  ]);
  return row;
}

function differentiateDuplicateTitles(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.baseTitle.toLowerCase();
    const matches = groups.get(key) ?? [];
    matches.push(row);
    groups.set(key, matches);
  }
  for (const matches of groups.values()) {
    if (matches.length < 2) continue;
    matches.forEach((row, index) => {
      const detail = row.command || row.meta || String(index + 1);
      row.title = `${row.baseTitle} · ${detail}`;
      row.searchText += `\n${row.title.toLowerCase()}`;
    });
  }
  return rows;
}

function sortRows(rows, selectedKey) {
  return [...rows].sort((left, right) => {
    const selected = Number(right.selectionKey === selectedKey)
      - Number(left.selectionKey === selectedKey);
    if (selected) return selected;
    const status = STATUS_ORDER[left.status.key] - STATUS_ORDER[right.status.key];
    if (status) return status;
    const recent = right.lastActiveAt - left.lastActiveAt;
    if (recent) return recent;
    return left.key.localeCompare(right.key);
  });
}

function category(label, icon, rows, query) {
  return {
    key: label.toLowerCase(),
    label,
    icon,
    count: rows.length,
    labelMatches: matchTextRanges(label, query),
    rows: rows.map((row) => ({
      ...row,
      titleMatches: matchTextRanges(row.title, query),
      metaMatches: matchTextRanges(row.meta, query),
    })),
  };
}

export function buildSidebarProjectModel(options) {
  const {
    project,
    localSessions = [],
    covenSessions = [],
    query = '',
    filter = 'all',
    selectedKey = '',
    now = Date.now(),
  } = options ?? {};
  const normalizedQuery = lower(query);
  const normalizedFilter = normalizeSidebarFilter(filter);
  const ownership = buildProjectRailModel(project, localSessions, covenSessions, '');
  const projectSearch = searchValue([project?.name, project?.root]);
  const projectMatches = normalizedQuery && projectSearch.includes(normalizedQuery);
  const branchEntries = ownership.worktrees;

  if (ownership.projectRows.length) {
    branchEntries.push({
      worktree: {
        path: '',
        branch: 'Unresolved sessions',
        collapsed: false,
        dirty: false,
        missing: true,
        virtual: true,
      },
      rows: ownership.projectRows,
    });
  }

  const branches = branchEntries.map((entry) => {
    const worktree = entry.worktree;
    const branchSearch = searchValue([worktree?.branch, worktree?.path]);
    const branchMatches = normalizedQuery && branchSearch.includes(normalizedQuery);
    const normalizedRows = differentiateDuplicateTitles(entry.rows.map((row) => (
      row.source === 'coven'
        ? normalizeCovenRow(project, worktree, row.value)
        : normalizeLocalRow(project, worktree, row.value, now)
    )));
    const visibleRows = sortRows(normalizedRows.filter((row) => {
      if (!matchesFilter(row, normalizedFilter)) return false;
      return !normalizedQuery || projectMatches || branchMatches
        || row.searchText.includes(normalizedQuery);
    }), selectedKey);
    const agents = visibleRows.filter((row) => row.type === 'agents');
    const shells = visibleRows.filter((row) => row.type === 'shells');
    const branchTitle = text(worktree?.branch)
      || (worktree?.is_main ? 'main checkout' : basename(worktree?.path));
    const categories = [
      agents.length ? category('Agents', '✳', agents, normalizedQuery) : null,
      shells.length ? category('Shells', '❯_', shells, normalizedQuery) : null,
    ].filter(Boolean);
    return {
      key: `branch:${text(worktree?.path) || 'unresolved'}`,
      worktree,
      title: branchTitle,
      titleMatches: matchTextRanges(branchTitle, normalizedQuery),
      count: visibleRows.length,
      attentionCount: visibleRows.filter((row) => row.needsAttention).length,
      expanded: Boolean(normalizedQuery) || !worktree?.collapsed,
      autoExpanded: Boolean(normalizedQuery) && Boolean(worktree?.collapsed),
      categories,
    };
  }).filter((branch) => branch.count > 0);

  const visibleRows = branches.flatMap((branch) => (
    branch.categories.flatMap((group) => group.rows)
  ));
  return {
    key: `project:${text(project?.id || project?.root)}`,
    project,
    title: text(project?.name || basename(project?.root)),
    titleMatches: matchTextRanges(
      text(project?.name || basename(project?.root)),
      normalizedQuery,
    ),
    count: visibleRows.length,
    visibleCount: visibleRows.length,
    attentionCount: visibleRows.filter((row) => row.needsAttention).length,
    expanded: Boolean(normalizedQuery) || !project?.collapsed,
    autoExpanded: Boolean(normalizedQuery) && Boolean(project?.collapsed),
    current: false,
    branches,
  };
}

export function sidebarTailIsWorking(tail) {
  return hasWorkingIndicators(tail);
}
```

Update `native/macos/psyche-build-tauri/web/sessions/session-entry.js`:

```js
export {
  buildSidebarProjectModel,
  deriveCovenSidebarStatus,
  deriveLocalSidebarStatus,
  localSidebarSelectionKey,
  matchTextRanges,
  normalizeSidebarFilter,
  sidebarSelectionKey,
  sidebarTailIsWorking,
  SIDEBAR_ACTIVE_WINDOW_MS,
  SIDEBAR_FILTERS,
} from './sidebar-model.mjs';
```

- [ ] **Step 4: Run the model tests**

Run:

```bash
pnpm vitest --run __tests__/tauriSidebarModel.test.ts __tests__/tauriSessionModel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the model**

```bash
git add \
  native/macos/psyche-build-tauri/web/sessions/sidebar-model.mjs \
  native/macos/psyche-build-tauri/web/sessions/session-entry.js \
  __tests__/tauriSidebarModel.test.ts
git commit -m "feat: add sessions sidebar model" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Add pinned controls, filter markup, and persistence fields

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html:40-100`
- Modify: `native/macos/psyche-build-tauri/web/main.js:447-540`
- Modify: `__tests__/tauriWorkspaceRail.test.ts`

- [ ] **Step 1: Write failing source-contract tests**

Append these assertions to `__tests__/tauriWorkspaceRail.test.ts`:

```ts
it('pins compact tabs, search, actions, filters, and honest navigation semantics', () => {
  const html = readFileSync(join(root, 'native/macos/psyche-build-tauri/web/index.html'), 'utf8');
  expect(html).toContain('class="sidebar-controls"');
  expect(html).toContain('class="session-search-wrap"');
  expect(html).toContain('<kbd class="session-search-key">/</kbd>');
  for (const filter of ['all', 'agents', 'shells', 'active', 'attention']) {
    expect(html).toContain(`data-session-filter="${filter}"`);
  }
  expect(html).toContain('id="session-status-legend"');
  expect(html).toContain('id="session-list" role="navigation"');
  expect(html).toContain('aria-label="Create a new session"');
  expect(html).toContain('aria-label="Collapse sidebar"');
});

it('validates and persists sidebar tab, filter, project expansion, and selection key', () => {
  expect(mainJs).toContain('sidebarTab: saved.sidebarTab === "files" ? "files" : "sessions"');
  expect(mainJs).toContain('sessionFilter: PsycheSessions.normalizeSidebarFilter(saved.sessionFilter)');
  expect(mainJs).toContain('selectedSessionKey: typeof saved.selectedSessionKey === "string"');
  expect(mainJs).toContain('collapsed: saved.collapsed === true');
  expect(mainJs).toContain('collapsed: !!project.collapsed');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts
```

Expected: FAIL on the missing controls and persistence fields.

- [ ] **Step 3: Replace the sidebar header markup**

In `index.html`, replace the current `.sidebar-head`, `.sidebar-tabs`, and
`#session-list` opening markup with:

```html
<div class="sidebar-controls">
  <div class="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
    <button class="sidebar-tab is-active" data-sidebar-tab="sessions" type="button"
            role="tab" aria-selected="true">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M2.75 4.25h10.5M2.75 8h10.5M2.75 11.75h6.5"
              fill="none" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round"/>
      </svg>
      <span>Sessions</span>
    </button>
    <button class="sidebar-tab" data-sidebar-tab="files" type="button"
            role="tab" aria-selected="false">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M2.4 4.6A1.35 1.35 0 0 1 3.75 3.25h2.3c.42 0 .82.2
                 1.07.54l.62.83h4.51a1.35 1.35 0 0 1 1.35 1.35v5.68
                 A1.35 1.35 0 0 1 12.25 13H3.75a1.35 1.35 0 0 1-1.35-1.35z"
              fill="none" stroke="currentColor" stroke-width="1.4"
              stroke-linejoin="round"/>
      </svg>
      <span>Files</span>
    </button>
  </div>

  <div class="sidebar-head">
    <label class="session-search-wrap" for="session-search">
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor"
                stroke-width="1.4"/>
        <path d="m10.25 10.25 3 3" fill="none" stroke="currentColor"
              stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <input id="session-search" class="session-search" type="search"
             spellcheck="false" autocomplete="off"
             placeholder="Search projects, branches, sessions…"
             aria-label="Search projects, branches, agents, shells, and session metadata" />
      <kbd class="session-search-key">/</kbd>
    </label>
    <button id="rail-new-tab" class="rail-btn has-tooltip"
            data-tooltip="Create a new session"
            title="Create a new session (t / a / w)"
            aria-label="Create a new session" aria-haspopup="menu"
            aria-expanded="false">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M8 3.75v8.5M3.75 8h8.5" fill="none"
              stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>
    <button id="sidebar-collapse" class="rail-btn has-tooltip"
            data-tooltip="Collapse sidebar"
            title="Collapse sidebar (⌘B)" aria-label="Collapse sidebar">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2"
              fill="none" stroke="currentColor" stroke-width="1.3"/>
        <line x1="6" y1="2.5" x2="6" y2="13.5"
              stroke="currentColor" stroke-width="1.3"/>
        <path d="M10.5 6 8.5 8l2 2" fill="none" stroke="currentColor"
              stroke-width="1.3" stroke-linecap="round"
              stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

  <div class="session-filter-row" role="toolbar" aria-label="Filter sessions">
    <button class="session-filter is-active" type="button"
            data-session-filter="all" aria-pressed="true">All</button>
    <button class="session-filter" type="button"
            data-session-filter="agents" aria-pressed="false">Agents</button>
    <button class="session-filter" type="button"
            data-session-filter="shells" aria-pressed="false">Shells</button>
    <button class="session-filter" type="button"
            data-session-filter="active" aria-pressed="false">Active</button>
    <button class="session-filter" type="button"
            data-session-filter="attention" aria-pressed="false">Attention</button>
    <button class="session-legend-button has-tooltip" type="button"
            aria-label="Session status legend"
            aria-describedby="session-status-legend"
            data-tooltip="Purple: selected context · Green: active · Blue: busy · Yellow: attention · Gray: idle">
      ?
    </button>
  </div>
  <div id="session-status-legend" class="sr-only">
    Purple marks current navigation context. Green means active. Blue means busy.
    Yellow means attention required. Gray means idle. Red means exited.
  </div>
</div>

<div class="session-list" id="session-list" role="navigation"
     aria-label="Sessions grouped by project and branch"></div>
```

Keep the existing new-pane menu immediately after `.sidebar-controls`, so its
position remains anchored to the top of the rail.

- [ ] **Step 4: Persist validated sidebar settings and project expansion**

Extend `loadSettings()` defaults and return value:

```js
var defaults = {
  maxProjects: 10,
  maxBrowserTabsPerProject: 10,
  bgOpacity: DEFAULT_BG_OPACITY,
  theme: DEFAULT_THEME,
  solidBg: false,
  sidebarTab: "sessions",
  sessionFilter: "all",
  selectedSessionKey: "",
};
```

```js
sidebarTab: saved.sidebarTab === "files" ? "files" : "sessions",
sessionFilter: PsycheSessions.normalizeSidebarFilter(saved.sessionFilter),
selectedSessionKey: typeof saved.selectedSessionKey === "string"
  ? saved.selectedSessionKey.slice(0, 1024)
  : "",
```

Extend `saveSettings()`:

```js
settings.sidebarTab = settings.sidebarTab === "files" ? "files" : "sessions";
settings.sessionFilter = PsycheSessions.normalizeSidebarFilter(settings.sessionFilter);
settings.selectedSessionKey = typeof settings.selectedSessionKey === "string"
  ? settings.selectedSessionKey.slice(0, 1024)
  : "";
```

Extend `persistableProject()`:

```js
function persistableProject(project) {
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    collapsed: !!project.collapsed,
    selectedWorktreePath: project.selectedWorktreePath,
    worktreePresentation: (project.worktrees || []).map(function (worktree) {
      return { path: worktree.path, collapsed: !!worktree.collapsed };
    }),
    layout: ensureProjectLayout(project),
    browsersByWorktree: persistableBrowsers(project),
  };
}
```

Change `sanitizeSavedProject()` from `collapsed: false` to:

```js
collapsed: saved.collapsed === true,
```

When `mergeRestoredProject()` prefers incoming state, also copy:

```js
target.collapsed = incoming.collapsed;
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit controls and persistence**

```bash
git add \
  native/macos/psyche-build-tauri/web/index.html \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriWorkspaceRail.test.ts
git commit -m "feat: add sidebar controls and persistence" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Track active, busy, idle, attention, and exited state

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:845-1105,1118-1170`
- Modify: `__tests__/tauriSessionAttention.test.ts`

- [ ] **Step 1: Write failing activity-state assertions**

Add to `__tests__/tauriSessionAttention.test.ts`:

```ts
it('tracks PTY output time and working-tail state for sidebar presentation', () => {
  expect(mainJs).toContain('thread.lastOutputAt = Date.now();');
  expect(mainJs).toContain(
    'thread.isWorking = PsycheSessions.sidebarTailIsWorking(tail);',
  );
  expect(mainJs).toContain('thread.lastOutputAt = 0');
  expect(mainJs).toContain('thread.isWorking = false');
  expect(mainJs).toContain('thread.sidebarStatusKey = nextStatus.key;');
});

it('keeps shell prompts idle instead of turning them into attention', () => {
  expect(mainJs).toMatch(
    /function threadWantsAttentionTracking\(thread\)[\s\S]{0,320}\(thread\.kind \|\| "shell"\) !== "shell"/,
  );
  expect(mainJs).toMatch(
    /function sampleThreadAttention\(\)[\s\S]{0,700}PsycheSessions\.sidebarTailIsWorking\(tail\)/,
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriSessionAttention.test.ts
```

Expected: FAIL on missing `lastOutputAt`, `isWorking`, and
`sidebarTailIsWorking`.

- [ ] **Step 3: Initialize and update activity fields**

In `createThread()`, add:

```js
lastOutputAt: 0,
isWorking: false,
sidebarStatusKey: "idle",
```

In the `pty:data` listener, before writing or buffering bytes:

```js
thread.lastOutputAt = Date.now();
```

In `handlePtyExit()` after setting `thread.status = "exited"`:

```js
thread.isWorking = false;
```

Refactor `sampleThreadAttention()` to compute the visible tail once:

```js
function sampleThreadAttention() {
  var now = Date.now();
  var tracked = [];
  var sidebarStateChanged = false;
  state.threads.forEach(function (thread) {
    if (!thread || !thread.term) return;
    var tail = terminalTail(thread.term, ATTENTION_TAIL_LINES);
    thread.isWorking = PsycheSessions.sidebarTailIsWorking(tail);
    if (!threadWantsAttentionTracking(thread)) {
      if (thread.needsAttention) clearThreadAttention(thread);
    } else {
      tracked.push(thread.id);
      applyThreadAttention(
        thread,
        attentionTracker.observe(thread.id, tail, now)
      );
    }
    var nextStatus = PsycheSessions.deriveLocalSidebarStatus(thread, now);
    if (thread.sidebarStatusKey !== nextStatus.key) {
      thread.sidebarStatusKey = nextStatus.key;
      sidebarStateChanged = true;
    }
  });
  attentionTracker.retain(tracked);
  if (sidebarStateChanged) {
    renderSessionList();
    syncSessionListScroll();
  }
}
```

This does not change the attention tracker: it only reuses its existing working
classifier for sidebar status.

- [ ] **Step 4: Run attention and model tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriSidebarModel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit activity state**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriSessionAttention.test.ts
git commit -m "feat: track sidebar session activity" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Refactor the rail into reusable tree components

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/index.html:141`
- Modify: `native/macos/psyche-build-tauri/web/main.js:2938-3645`
- Modify: `__tests__/tauriWorkspaceRail.test.ts`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`

Promote `#session-list` from `role="navigation"` to `role="tree"` in this task,
in the same change that introduces the first rendered `treeitem`/`group`
semantics and their source-contract assertion.

- [ ] **Step 1: Add failing rendered-tree tests**

Add a test to `__tests__/tauriCovenSessionSiderail.test.ts` using the existing
fake document harness and realistic project data:

```ts
// Extend Project before adding these tests:
// collapsed?: boolean;
//
// Extend LocalThread before adding these tests:
// launch?: { command?: string; args?: string[] };
// lastOutputAt?: number;
// isWorking?: boolean;

it('renders project, branch, category, and unified session rows with counts', () => {
  vi.spyOn(Date, 'now').mockReturnValue(10_000);
  const renderer = createRenderer({
    projects: [{
      id: 'psyche',
      name: 'PSYCHE-BUILD',
      root: '/repo/psyche-build',
      collapsed: false,
      selectedWorktreePath: '/repo/psyche-wt',
      worktrees: [{
        path: '/repo/psyche-wt',
        branch: 'feat/web-pane-attention',
        is_main: false,
        collapsed: false,
        dirty: true,
        missing: false,
      }],
    }],
    threads: [
      {
        id: 'shell-7', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
        name: 'shell 7', kind: 'shell', status: 'running', lastOutputAt: 1,
      },
      {
        id: 'shell-8-api', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
        name: 'shell 8', kind: 'shell', status: 'running',
        launch: { command: 'pnpm', args: ['dev'] }, lastOutputAt: 9_999,
      },
      {
        id: 'shell-8-tests', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
        name: 'shell 8', kind: 'shell', status: 'running',
        launch: { command: 'vitest', args: ['--watch'] }, lastOutputAt: 1,
      },
      {
        id: 'shell-9', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
        name: 'shell 9', kind: 'shell', status: 'running', needsAttention: true,
      },
      {
        id: 'shell-10', projectId: 'psyche', worktreePath: '/repo/psyche-wt',
        name: 'shell 10', kind: 'shell', status: 'running', lastOutputAt: 9_999,
      },
    ],
    activeThreadId: 'shell-10',
  });

  renderer.render();

  expect(renderer.sessionListEl.querySelector('.session-project-head')?.textContent)
    .toContain('PSYCHE-BUILD');
  expect(renderer.sessionListEl.querySelector('.session-project-head')?.textContent)
    .toContain('5');
  expect(renderer.sessionListEl.querySelector('.session-branch-head')?.textContent)
    .toContain('feat/web-pane-attention');
  expect(renderer.sessionListEl.querySelector('.session-category-label')?.textContent)
    .toContain('Shells');
  expect(renderer.sessionListEl.querySelector('.session-category-label')?.textContent)
    .toContain('5');
  expect(textOf(renderer.sessionListEl.querySelectorAll('.session-title'))).toEqual([
    'shell 10',
    'shell 9',
    'shell 8 · pnpm dev',
    'shell 7',
    'shell 8 · vitest --watch',
  ]);
  expect(renderer.sessionListEl.querySelector('.is-selected')?.textContent)
    .toContain('shell 10');
});

it('renders daemon-backed Coven sessions inside Agents with Coven metadata', () => {
  const renderer = createRenderer({
    projects: [{
      id: 'coven-cave',
      name: 'COVEN-CAVE',
      root: '/repo/coven-cave',
      collapsed: false,
      selectedWorktreePath: '/repo/coven-cave',
      worktrees: [{
        path: '/repo/coven-cave', branch: 'main',
        is_main: true,
        collapsed: false, dirty: false, missing: false,
      }],
    }],
    sessions: [{
      id: 'coven-1', projectRoot: '/repo/coven-cave',
      cwd: '/repo/coven-cave', title: 'Agent Coven',
      harness: 'Coven', status: 'running',
    }],
  });

  renderer.render();

  expect(renderer.sessionListEl.querySelector('.session-category-label')?.textContent)
    .toContain('Agents');
  expect(renderer.sessionListEl.querySelector('.session-title')?.textContent)
    .toBe('Agent Coven');
  expect(renderer.sessionListEl.querySelector('.session-meta')?.textContent)
    .toContain('Coven');
  expect(renderer.sessionListEl.querySelector('.session-status')?.textContent)
    .toContain('BUSY');
  expect(renderer.sessionListEl.querySelector('.session-coven-row')).toBeNull();
});
```

Update `createRenderer()` so its extracted `sources` array includes
`attachTooltip`, `appendHighlightedText`, `createStatusIndicator`,
`createCategoryLabel`, `createSessionRow`, `createBranchGroup`, and
`createProjectGroup`. Pass a mutable `settings` object containing
`selectedSessionKey`, a `saveSettings` spy, and `sessionTypeFilter: "all"` into
the generated function. Keep using the existing fake DOM rather than
introducing a second renderer harness.

Use these concrete harness additions:

```ts
// Add to FakeElement:
get parentElement() {
  return this.parentNode;
}

// Replace the selector guard at the start of querySelectorAll:
const classSelector = selector.startsWith('.') ? selector.slice(1) : null;
const treeItemSelector = selector === '[data-tree-item]';
if (!classSelector && !treeItemSelector) {
  throw new Error(`unsupported selector ${selector}`);
}
// Inside visit():
if (classSelector && element.classList.contains(classSelector)) matches.push(element);
if (treeItemSelector && element.dataset.treeItem) matches.push(element);
```

```ts
const settings = {
  selectedSessionKey: '',
  sessionFilter: 'all',
  sidebarTab: 'sessions',
};
const saveSettings = vi.fn();
```

```ts
// Insert these entries immediately before the existing renderSessionList entry.
'var sessionTypeFilter = seedSessionTypeFilter;',
  extractFunctionSource(mainJs, 'attachTooltip'),
  extractFunctionSource(mainJs, 'appendHighlightedText'),
  extractFunctionSource(mainJs, 'createStatusIndicator'),
  extractFunctionSource(mainJs, 'createCategoryLabel'),
  extractFunctionSource(mainJs, 'createSessionRow'),
  extractFunctionSource(mainJs, 'createBranchGroup'),
  extractFunctionSource(mainJs, 'createProjectGroup'),
```

Add `settings`, `saveSettings`, and `seedSessionTypeFilter` to the generated
`Function` parameter list and pass `settings`, `saveSettings`, and
`settings.sessionFilter` at invocation. Return `settings` and `saveSettings`
from `createRenderer()` so persistence assertions can inspect them.

- [ ] **Step 2: Run the siderail tests and verify they fail**

Run:

```bash
pnpm vitest --run __tests__/tauriCovenSessionSiderail.test.ts
```

Expected: FAIL because the old renderer has no project/branch/category
components and Coven still renders separately.

- [ ] **Step 3: Add shared DOM helpers**

Add these functions above `renderSessionList()` in `main.js`:

```js
function attachTooltip(element, text) {
  if (!element || !text) return element;
  element.classList.add("has-tooltip");
  element.dataset.tooltip = text;
  if (!element.title) element.title = text;
  return element;
}

function appendHighlightedText(element, value, ranges) {
  var source = String(value || "");
  var cursor = 0;
  (ranges || []).forEach(function (range) {
    var start = range[0];
    var end = range[1];
    if (start > cursor) {
      var plain = document.createElement("span");
      plain.textContent = source.slice(cursor, start);
      element.appendChild(plain);
    }
    var mark = document.createElement("mark");
    mark.textContent = source.slice(start, end);
    element.appendChild(mark);
    cursor = end;
  });
  if (cursor < source.length) {
    var remainder = document.createElement("span");
    remainder.textContent = source.slice(cursor);
    element.appendChild(remainder);
  }
}

function createStatusIndicator(status) {
  var indicator = document.createElement("span");
  indicator.className = "session-status status-" + status.key;
  indicator.setAttribute("aria-label", status.tooltip);
  var icon = document.createElement("span");
  icon.className = "session-status-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = status.icon;
  var label = document.createElement("span");
  label.className = "session-status-label";
  label.textContent = status.label;
  indicator.appendChild(icon);
  indicator.appendChild(label);
  attachTooltip(indicator, status.tooltip);
  return indicator;
}

function createCategoryLabel(category) {
  var label = document.createElement("div");
  label.className = "session-category-label";
  label.setAttribute("role", "presentation");
  var icon = document.createElement("span");
  icon.className = "session-category-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = category.icon;
  var name = document.createElement("span");
  name.className = "session-category-name";
  appendHighlightedText(name, category.label, category.labelMatches);
  var count = document.createElement("span");
  count.className = "session-category-count";
  count.textContent = String(category.count);
  label.appendChild(icon);
  label.appendChild(name);
  label.appendChild(count);
  return label;
}

function createSessionRow(rowModel, options) {
  var wrapper = document.createElement("div");
  wrapper.className = "session-row-wrap";
  wrapper.setAttribute("role", "none");
  var row = document.createElement("button");
  row.type = "button";
  row.className = "session-row kind-" + rowModel.type.slice(0, -1)
    + " status-" + rowModel.status.key
    + (options.selected ? " is-selected" : "")
    + (rowModel.needsAttention ? " needs-attention" : "");
  row.dataset.treeItem = "session";
  row.dataset.treeKey = rowModel.key;
  row.dataset.selectionKey = rowModel.selectionKey;
  row.setAttribute("role", "treeitem");
  row.setAttribute("tabindex", options.tabindex);
  if (options.selected) row.setAttribute("aria-current", "true");
  attachTooltip(row, options.tooltip);

  var icon = document.createElement("span");
  icon.className = "session-type-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = rowModel.type === "shells" ? "❯_" : "✳";

  var text = document.createElement("span");
  text.className = "session-text";
  var titleLine = document.createElement("span");
  titleLine.className = "session-title-line";
  var title = document.createElement("span");
  title.className = "session-title";
  appendHighlightedText(title, rowModel.title, rowModel.titleMatches);
  titleLine.appendChild(title);
  if (options.onCanvas) {
    var onCanvas = document.createElement("span");
    onCanvas.className = "session-oncanvas";
    onCanvas.textContent = "▣";
    onCanvas.setAttribute("aria-label", "On the canvas");
    attachTooltip(onCanvas, "On the canvas");
    titleLine.appendChild(onCanvas);
  }
  if (options.sets && options.sets.length) {
    var swatches = document.createElement("span");
    swatches.className = "session-sets";
    options.sets.forEach(function (set) {
      var swatch = document.createElement("span");
      swatch.className = "session-set-swatch";
      swatch.dataset.set = String(Math.min(4, Math.max(1, Number(set.index) || 1)));
      swatch.setAttribute("aria-label", "In " + (set.name || "a focus set"));
      attachTooltip(swatch, "In " + (set.name || "a focus set"));
      swatches.appendChild(swatch);
    });
    titleLine.appendChild(swatches);
  }
  var meta = document.createElement("span");
  meta.className = "session-meta";
  appendHighlightedText(meta, rowModel.meta, rowModel.metaMatches);
  text.appendChild(titleLine);
  text.appendChild(meta);

  row.appendChild(icon);
  row.appendChild(text);
  row.appendChild(createStatusIndicator(rowModel.status));
  wrapper.appendChild(row);
  return { wrapper: wrapper, row: row, title: title };
}

function createBranchGroup(branchModel, options) {
  var group = document.createElement("div");
  group.className = "session-branch";
  group.dataset.treeItem = "branch";
  group.dataset.treeKey = branchModel.key;
  group.setAttribute("role", "treeitem");
  group.setAttribute("tabindex", options.tabindex);
  group.setAttribute("aria-expanded", branchModel.expanded ? "true" : "false");
  if (branchModel.worktree.virtual || branchModel.worktree.missing) {
    group.setAttribute("aria-disabled", "true");
  }

  var head = document.createElement("div");
  head.className = "session-branch-head"
    + (options.active ? " is-active" : "")
    + (branchModel.worktree.missing ? " is-missing" : "");

  var twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "session-disclosure";
  twisty.setAttribute("tabindex", "-1");
  twisty.setAttribute(
    "aria-label",
    (branchModel.expanded ? "Collapse " : "Expand ") + branchModel.title
  );
  twisty.textContent = branchModel.expanded ? "▾" : "▸";
  var title = document.createElement("span");
  title.className = "session-branch-name";
  appendHighlightedText(title, branchModel.title, branchModel.titleMatches);
  var count = document.createElement("span");
  count.className = "session-branch-count";
  count.textContent = String(branchModel.count);
  if (branchModel.worktree.dirty) count.textContent += " ±";
  if (branchModel.attentionCount > 0) {
    var attention = document.createElement("span");
    attention.className = "session-attention-count";
    attention.textContent = "!" + branchModel.attentionCount;
    count.appendChild(attention);
    count.setAttribute(
      "aria-label",
      branchModel.count + " sessions, " + branchModel.attentionCount + " need attention"
    );
  }
  head.appendChild(twisty);
  head.appendChild(title);
  head.appendChild(count);
  attachTooltip(head, branchModel.worktree.path || branchModel.title);
  group.setAttribute("aria-label", branchModel.title);
  group.title = branchModel.worktree.path || branchModel.title;

  var children = document.createElement("div");
  children.className = "session-branch-children";
  children.setAttribute("role", "group");
  group.appendChild(head);
  group.appendChild(children);
  return {
    group: group,
    head: head,
    disclosure: twisty,
    children: children,
  };
}

function createProjectGroup(projectModel, options) {
  var group = document.createElement("section");
  group.className = "session-project" + (options.current ? " is-current" : "");
  group.dataset.treeItem = "project";
  group.dataset.treeKey = projectModel.key;
  group.setAttribute("role", "treeitem");
  group.setAttribute("tabindex", options.tabindex);
  group.setAttribute("aria-expanded", projectModel.expanded ? "true" : "false");

  var head = document.createElement("div");
  head.className = "session-project-head";
  var twisty = document.createElement("button");
  twisty.type = "button";
  twisty.className = "session-disclosure";
  twisty.setAttribute("tabindex", "-1");
  twisty.setAttribute(
    "aria-label",
    (projectModel.expanded ? "Collapse " : "Expand ") + projectModel.title
  );
  twisty.textContent = projectModel.expanded ? "▾" : "▸";
  var title = document.createElement("span");
  title.className = "session-project-name";
  appendHighlightedText(title, projectModel.title, projectModel.titleMatches);
  if (options.current) {
    var current = document.createElement("span");
    current.className = "session-current-badge";
    current.textContent = "CURRENT";
    title.appendChild(current);
  }
  var count = document.createElement("span");
  count.className = "session-project-count";
  count.textContent = String(projectModel.count);
  if (projectModel.attentionCount > 0) {
    var attention = document.createElement("span");
    attention.className = "session-attention-count";
    attention.textContent = "!" + projectModel.attentionCount;
    count.appendChild(attention);
    count.setAttribute(
      "aria-label",
      projectModel.count + " sessions, " + projectModel.attentionCount + " need attention"
    );
  }
  head.appendChild(twisty);
  head.appendChild(title);
  head.appendChild(count);
  attachTooltip(head, projectModel.project.root || projectModel.title);
  group.setAttribute("aria-label", projectModel.title);
  group.title = projectModel.project.root || projectModel.title;
  var children = document.createElement("div");
  children.className = "session-project-children";
  children.setAttribute("role", "group");
  group.appendChild(head);
  group.appendChild(children);
  return {
    group: group,
    head: head,
    disclosure: twisty,
    children: children,
  };
}
```

- [ ] **Step 4: Rebuild `renderSessionList()` around the project model**

At the start of `renderSessionList()`, preserve focus:

```js
var focusedKey = document.activeElement && document.activeElement.dataset
  ? document.activeElement.dataset.treeKey
  : "";
```

For each project, build the model:

```js
var selectedThread = findThread(state.activeThreadId);
var selectedKey = selectedThread
  ? PsycheSessions.localSidebarSelectionKey(project, selectedThread)
  : settings.selectedSessionKey;
var projectModel = PsycheSessions.buildSidebarProjectModel({
  project: project,
  localSessions: localRows,
  covenSessions: remoteRows,
  query: sessionFilter,
  filter: sessionTypeFilter,
  selectedKey: selectedKey,
  now: Date.now(),
});
projectModel.current = project.id === state.activeProjectId;
```

Skip only zero-result project models, create the project/branch/category/session
components, and append category rows under `role="group"` containers. For local
rows, move the existing click, F2/double-click rename, context-menu, focus-set,
and close-button handlers onto the returned `row` and `wrapper`. For Coven
rows, attach `openCovenSession(project, rowModel.value)` to the same unified
session-row component and do not render `.session-coven-row`.

Delete `createCovenSessionRow()` once the unified path is wired, and remove its
entry from the test harness `sources` array. No production path should retain a
second Coven-only row component.

Delete the now-unused `sessionGitState()` and string-returning
`sessionSetSwatches()` helpers after the branch header and DOM-based focus-set
swatches replace them. Keep `sessionLaneLabel()` because pane metadata outside
the sidebar still uses it.

Call `createSessionRow()` for local rows with:

```js
{
  selected: rowModel.selectionKey === selectedKey,
  tabindex: "-1",
  tooltip: rowModel.title + " — " + rowModel.meta + " — " + rowModel.status.tooltip,
  onCanvas: onCanvasIds.indexOf(rowModel.id) !== -1,
  sets: setsForThread(rowModel.value),
}
```

For Coven rows, pass `onCanvas: false` and `sets: []`.

Append branch groups to `projectParts.children`, category labels and session
rows to `branchParts.children`, and append those child containers only when the
corresponding model is expanded.

Project activation and disclosure behavior:

```js
projectParts.disclosure.addEventListener("click", function (event) {
  event.preventDefault();
  event.stopPropagation();
  project.collapsed = !project.collapsed;
  refreshSidebar();
  saveWorkspaceSoon();
});
projectParts.head.addEventListener("click", function () {
  clearFocusSet();
  setActiveProject(project.id);
});
```

Branch activation and disclosure behavior:

```js
branchParts.disclosure.addEventListener("click", function (event) {
  if (branchModel.worktree.virtual || branchModel.worktree.missing) return;
  event.preventDefault();
  event.stopPropagation();
  branchModel.worktree.collapsed = !branchModel.worktree.collapsed;
  refreshSidebar();
  saveWorkspaceSoon();
});
branchParts.head.addEventListener("click", async function () {
  if (branchModel.worktree.virtual || branchModel.worktree.missing) return;
  await activateProjectWorktree(project, branchModel.worktree.path);
});
```

Attach the branch context menu to `branchParts.head`:

```js
branchParts.head.addEventListener("contextmenu", function (event) {
  var actions = [{
    label: "Open Coven Terminal",
    run: async function () {
      if (!(await activateProjectWorktree(project, branchModel.worktree.path))) return;
      await ensureProjectCoven(project);
    },
  }];
  if (hiddenThreads.length > 0) {
    actions.push({
      label: "Show " + hiddenThreads.length + " hidden session"
        + (hiddenThreads.length === 1 ? "" : "s"),
      run: async function () {
        await reopenThreadsForWorkspace(project, branchModel.worktree.path);
      },
    });
  }
  openSessionContextMenu(event, actions);
});
```

On local row activation, persist selection before focus:

```js
settings.selectedSessionKey = rowModel.selectionKey;
saveSettings();
```

After a successful rename of the selected local thread, recompute and persist:

```js
if (renameThread(rowModel.id, value)
    && state.activeThreadId === rowModel.id) {
  settings.selectedSessionKey = PsycheSessions.localSidebarSelectionKey(
    project,
    rowModel.value
  );
  saveSettings();
}
```

On Coven activation, persist the Coven key before attaching/focusing:

```js
settings.selectedSessionKey = rowModel.selectionKey;
saveSettings();
openCovenSession(project, rowModel.value);
```

After rendering, restore roving focus with:

```js
var renderedItems = Array.prototype.slice.call(
  sessionListEl.querySelectorAll("[data-tree-item]")
);
var preferred = renderedItems.find(function (item) {
  return focusedKey && item.dataset.treeKey === focusedKey;
}) || renderedItems.find(function (item) {
  return item.dataset.selectionKey === selectedKey;
}) || renderedItems.find(function (item) {
  return item.dataset.treeItem === "project"
    && item.classList.contains("is-current");
}) || renderedItems[0];
renderedItems.forEach(function (item) {
  item.setAttribute("tabindex", item === preferred ? "0" : "-1");
});
if (focusedKey && preferred) preferred.focus();
```

If `settings.selectedSessionKey` is nonempty but no rendered row has that
selection key and there is no active local thread, clear the stale key and call
`saveSettings()`. Do not mark a nonexistent local PTY as selected.

- [ ] **Step 5: Run the siderail and workspace tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS, including existing focus, attach, rename, hide, interrupt, and
close assertions.

- [ ] **Step 6: Commit the reusable renderer**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
git commit -m "feat: render accessible sessions tree" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Wire search, filters, temporary expansion, and full keyboard navigation

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/main.js:2938-3710`
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`
- Modify: `__tests__/tauriWorkspaceRail.test.ts`

- [ ] **Step 1: Add failing interaction tests**

Add source and fake-DOM assertions:

```ts
it('searches metadata, highlights matches, and restores manual expansion', () => {
  expect(mainJs).toContain('PsycheSessions.matchTextRanges');
  expect(mainJs).toContain('autoExpanded');
  expect(mainJs).toContain('session-result-summary');
  expect(mainJs).toContain('Clear search');
});

it('persists one compact filter and keeps search visit-local', () => {
  expect(mainJs).toContain('var sessionTypeFilter = settings.sessionFilter;');
  expect(mainJs).toContain('settings.sessionFilter = sessionTypeFilter;');
  expect(mainJs).not.toContain('settings.sessionSearch');
});

it('implements roving tree focus and complete keyboard navigation', () => {
  expect(mainJs).toContain('[data-tree-item]');
  expect(mainJs).toContain('event.key === "ArrowLeft"');
  expect(mainJs).toContain('event.key === "ArrowRight"');
  expect(mainJs).toContain('event.key === "Home"');
  expect(mainJs).toContain('event.key === "End"');
  expect(mainJs).toContain('event.key === "Enter"');
  expect(mainJs).toContain('event.key === " "');
  expect(mainJs).toContain('event.key === "/"');
  expect(mainJs).toContain('event.key === "Escape"');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: FAIL on filter wiring, result summary, highlighting contract, and
full key handling.

- [ ] **Step 3: Initialize tabs and filters from settings**

Replace:

```js
var sidebarTab = "sessions";
```

with:

```js
var sidebarTab = settings.sidebarTab;
var sessionTypeFilter = settings.sessionFilter;
```

Change the signature to `setSidebarTab(name, options)` and add at the end:

```js
settings.sidebarTab = sidebarTab;
if (!options || options.persist !== false) saveSettings();
```

Add:

```js
function setSessionTypeFilter(value, options) {
  sessionTypeFilter = PsycheSessions.normalizeSidebarFilter(value);
  settings.sessionFilter = sessionTypeFilter;
  if (!options || options.persist !== false) saveSettings();
  Array.prototype.forEach.call(
    document.querySelectorAll("[data-session-filter]"),
    function (button) {
      var active = button.dataset.sessionFilter === sessionTypeFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  );
  renderSessionList();
}

Array.prototype.forEach.call(
  document.querySelectorAll("[data-session-filter]"),
  function (button) {
    button.addEventListener("click", function () {
      setSessionTypeFilter(button.dataset.sessionFilter);
    });
  }
);
```

Call these exact initializers after listeners are attached:

```js
setSidebarTab(settings.sidebarTab, { persist: false });
setSessionTypeFilter(settings.sessionFilter, { persist: false });
```

- [ ] **Step 4: Add result summary and reset actions**

First collect the visible project models into `projectModels` and set `matched`
to the sum of their `visibleCount` values. Before appending the first project,
render a summary only when search/filter is active:

```js
var summary = document.createElement("div");
summary.className = "session-result-summary";
summary.textContent = matched + (matched === 1 ? " session" : " sessions");
var reset = document.createElement("button");
reset.type = "button";
reset.className = "session-result-reset";
if (needle) {
  reset.textContent = "Clear search";
  reset.addEventListener("click", function () {
    sessionSearchEl.value = "";
    sessionFilter = "";
    renderSessionList();
    sessionSearchEl.focus();
  });
} else {
  reset.textContent = "Reset filter";
  reset.addEventListener("click", function () { setSessionTypeFilter("all"); });
}
summary.appendChild(reset);
sessionListEl.appendChild(summary);
```

Then append each item in `projectModels`. This keeps `matched` as the visible
session count rather than a group count.

- [ ] **Step 5: Replace list key handling with roving tree navigation**

Add helpers:

```js
function visibleSessionTreeItems() {
  return Array.prototype.filter.call(
    sessionListEl.querySelectorAll("[data-tree-item]"),
    function (item) { return item.offsetParent !== null; }
  );
}

function focusSessionTreeItem(item) {
  visibleSessionTreeItems().forEach(function (candidate) {
    candidate.setAttribute("tabindex", candidate === item ? "0" : "-1");
  });
  item.focus();
}

function parentSessionTreeItem(item) {
  var parent = item.parentElement;
  while (parent && parent !== sessionListEl) {
    if (parent.matches(".session-branch")) return parent;
    if (parent.matches(".session-project")) return parent;
    parent = parent.parentElement;
  }
  return null;
}

function firstChildSessionTreeItem(item) {
  if (item.dataset.treeItem === "project") {
    return item.querySelector(".session-branch");
  }
  if (item.dataset.treeItem === "branch") {
    return item.querySelector(".session-row");
  }
  return null;
}

function toggleSessionTreeDisclosure(item) {
  var disclosure = item.querySelector(".session-disclosure");
  if (disclosure) disclosure.click();
}

function activateSessionTreeItem(item) {
  if (item.dataset.treeItem === "session") {
    item.click();
    return;
  }
  var head = item.querySelector(
    item.dataset.treeItem === "project"
      ? ".session-project-head"
      : ".session-branch-head"
  );
  if (head) head.click();
}
```

Replace the current session-list keydown listener with:

```js
sessionListEl.addEventListener("keydown", function (event) {
  var item = event.target.closest("[data-tree-item]");
  if (!item) return;
  var items = visibleSessionTreeItems();
  var index = items.indexOf(item);

  if (event.key === "ArrowDown" || event.key === "ArrowUp"
      || event.key === "Home" || event.key === "End") {
    var next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
    else next = Math.max(0, index - 1);
    event.preventDefault();
    focusSessionTreeItem(items[next]);
    return;
  }

  if (event.key === "ArrowLeft") {
    if ((item.dataset.treeItem === "project" || item.dataset.treeItem === "branch")
        && item.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
        toggleSessionTreeDisclosure(item);
      return;
    }
    var parent = parentSessionTreeItem(item);
    if (parent) {
      event.preventDefault();
      focusSessionTreeItem(parent);
    }
    return;
  }

  if (event.key === "ArrowRight") {
    if ((item.dataset.treeItem === "project" || item.dataset.treeItem === "branch")
        && item.getAttribute("aria-expanded") === "false") {
      event.preventDefault();
        toggleSessionTreeDisclosure(item);
      return;
    }
    var child = firstChildSessionTreeItem(item);
    if (child) {
      event.preventDefault();
      focusSessionTreeItem(child);
    }
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    activateSessionTreeItem(item);
    return;
  }
  if (event.key === " " && item.dataset.treeItem !== "session") {
    event.preventDefault();
    toggleSessionTreeDisclosure(item);
  }
});
```

Add a document-level `/` shortcut that ignores editable targets:

```js
document.addEventListener("keydown", function (event) {
  var target = event.target;
  var editing = target && (
    target.tagName === "INPUT" || target.tagName === "TEXTAREA"
    || target.isContentEditable
  );
  if (event.key === "/" && !editing && sidebarTab === "sessions") {
    event.preventDefault();
    sessionSearchEl.focus();
    sessionSearchEl.select();
  }
});
```

On Escape in search, clear the query, rerender, and restore focus to the last
saved tree key if it still exists.

- [ ] **Step 6: Run interaction tests**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit search and keyboard behavior**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
git commit -m "feat: add sidebar search filters and keyboard tree" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Apply the approved visual system

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/styles.css:20-620,3034-3425`
- Modify: `__tests__/tauriWorkspaceRail.test.ts`

- [ ] **Step 1: Add failing CSS contract tests**

Append:

```ts
it('styles hierarchy, selection, focus, hover, status, tooltips, and pinned regions distinctly', () => {
  expect(styles).toMatch(/\.sidebar-controls\s*\{[\s\S]*position:\s*relative/);
  expect(styles).toMatch(/\.session-list\s*\{[\s\S]*overflow-y:\s*auto/);
  expect(styles).toMatch(/\.session-project-head\s*\{[\s\S]*position:\s*sticky/);
  expect(styles).toMatch(/\.session-project\.is-current[\s\S]*var\(--accent\)/);
  expect(styles).toMatch(/\.session-row\.is-selected\s*\{/);
  expect(styles).toMatch(/\.session-row:hover\s*\{/);
  expect(styles).toMatch(/\.session-row:focus-visible\s*\{/);
  expect(styles).toMatch(/\.session-row:active\s*\{/);
  expect(styles).toMatch(/\.status-active\s*\{/);
  expect(styles).toMatch(/\.status-busy\s*\{/);
  expect(styles).toMatch(/\.status-idle\s*\{/);
  expect(styles).toMatch(/\.status-attention\s*\{/);
  expect(styles).toMatch(/\.has-tooltip:hover::after/);
  expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

it('keeps the sidebar within the approved width range and uses a tighter row rhythm', () => {
  expect(styles).toContain('--sidebar-min: 320px;');
  expect(styles).toContain('--sidebar-max: 420px;');
  expect(styles).toMatch(/--session-row-h:\s*40px/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts
```

Expected: FAIL against the old selectors and 220-pixel minimum.

- [ ] **Step 3: Update tokens**

In `:root`, change:

```css
--sidebar-w: 360px;
--sidebar-min: 320px;
--sidebar-max: 420px;
--session-row-h: 40px;
--info: #60a5fa;
--focus-ring-strong: 0 0 0 2px #c9bdf0;
```

Keep the existing accent and semantic tokens. Purple continues to represent
current navigation context; `--info` represents Busy.

- [ ] **Step 4: Replace the sidebar control and tree rules**

Replace the current sidebar-specific blocks for `.sidebar-head`,
`.session-search`, `.sidebar-tabs`, `.session-list`, `.session-group*`,
`.session-worktree*`, `.session-subsection-label`, `.session-coven-row`,
`.session-row*`, `.session-dot`, and `.session-chip` with:

```css
.sidebar-controls {
  position: relative;
  z-index: 20;
  flex: none;
  padding: 10px 10px 9px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.96));
}

.sidebar-tabs {
  display: flex;
  width: 190px;
  height: 31px;
  gap: 2px;
  margin: 0 0 9px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.94));
}
.sidebar-tab {
  flex: 1;
  height: 23px;
  gap: 5px;
  padding: 0 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
}
.sidebar-tab:hover { background: var(--surface-2); color: var(--text-soft); }
.sidebar-tab.is-active {
  background: var(--surface-3);
  color: var(--text);
  box-shadow: inset 0 -2px var(--accent);
}
.sidebar-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.sidebar-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px 30px;
  gap: 6px;
  padding: 0;
}
.session-search-wrap {
  height: 32px;
  min-width: 0;
  display: grid;
  grid-template-columns: 15px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface-2);
  color: var(--muted);
}
.session-search-wrap:focus-within {
  border-color: var(--accent-line);
  background: var(--surface-3);
  box-shadow: var(--focus-ring);
}
.session-search {
  width: 100%;
  height: 30px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  outline: 0;
  font-size: 12px;
}
.session-search::placeholder { color: var(--muted); opacity: 1; }
.session-search-key {
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface-3);
  color: var(--text-soft);
  font: 10px var(--font-mono);
}
.sidebar-head .rail-btn {
  width: 30px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-1);
}
.sidebar-head .rail-btn:hover { background: var(--surface-3); color: var(--text); }
.sidebar-head .rail-btn:active { background: var(--surface-2); transform: translateY(1px); }
.sidebar-head .rail-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.new-pane-menu { top: 82px; }

.session-filter-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.session-filter-row::-webkit-scrollbar { display: none; }
.session-filter {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 700;
}
.session-filter:hover { background: var(--surface-2); color: var(--text-soft); }
.session-filter:active { background: var(--surface-3); }
.session-filter.is-active {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--text);
}
.session-filter:focus-visible,
.session-legend-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.session-legend-button {
  flex: none;
  width: 24px;
  height: 24px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-weight: 750;
}

.session-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 8px 14px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}
.session-list[hidden] { display: none; }

.session-result-summary {
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 9px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.96));
  color: var(--muted);
  font-size: 10.5px;
}
.session-result-reset {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--text-soft);
  font-size: 10.5px;
}

.session-project {
  position: relative;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.session-project + .session-project { margin-top: 6px; }
.session-project.is-current::before {
  content: "";
  position: absolute;
  z-index: 8;
  top: 8px;
  bottom: 12px;
  left: 0;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}
.session-project-head {
  position: sticky;
  top: 0;
  z-index: 7;
  width: 100%;
  height: 38px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px;
  padding: 0 9px 0 4px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--rgb-deep), calc(var(--bg-opacity) * 0.97));
  color: var(--text);
  text-align: left;
}
.session-project-head:hover { background: var(--surface-2); }
.session-project-head:active { background: var(--surface-3); }
.session-project:focus-visible { outline: none; }
.session-project:focus-visible > .session-project-head {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.session-project-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 760;
  letter-spacing: 0.07em;
}
.session-current-badge {
  margin-left: 6px;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--text);
  font-size: 8.5px;
  letter-spacing: 0.02em;
}
.session-project-count,
.session-branch-count,
.session-category-count {
  color: var(--muted);
  font: 10px var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.session-attention-count {
  margin-left: 5px;
  color: var(--warn);
  font-weight: 750;
}
.session-disclosure {
  width: 22px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  display: inline-grid;
  place-items: center;
  color: var(--text-soft);
  font-size: 11px;
}

.session-branch { margin-left: 5px; }
.session-branch-head {
  width: 100%;
  height: 32px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  padding: 0 8px 0 2px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-soft);
  text-align: left;
}
.session-branch-head:hover { background: var(--surface-2); color: var(--text); }
.session-branch-head:active { background: var(--surface-3); }
.session-branch-head.is-active { background: var(--surface-1); color: var(--text); }
.session-branch:focus-visible { outline: none; }
.session-branch:focus-visible > .session-branch-head {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.session-branch-head.is-missing { color: var(--error); }
.session-branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 11.5px var(--font-mono);
}

.session-category-label {
  height: 25px;
  margin: 2px 0 1px 20px;
  padding-right: 8px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.session-category-icon { color: var(--text-soft); font: 11px var(--font-mono); }

.session-row-wrap { position: relative; }
.session-row {
  position: relative;
  width: calc(100% - 20px);
  min-height: var(--session-row-h);
  margin: 1px 0 1px 20px;
  padding: 4px 8px;
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 68px;
  align-items: center;
  gap: 7px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-soft);
  text-align: left;
  transition: background var(--transition-fast), color var(--transition-fast),
              border-color var(--transition-fast);
}
.session-row:hover { background: var(--surface-2); color: var(--text); }
.session-row:active { background: rgba(var(--rgb-s3), calc(var(--bg-opacity) * 0.8)); }
.session-row:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring-strong);
  z-index: 2;
}
.session-row.is-selected {
  background: var(--surface-3);
  border-color: var(--accent-line);
  color: var(--text);
  box-shadow: inset 3px 0 var(--accent);
}
.session-row.is-selected .session-title { font-weight: 700; }
.session-type-icon {
  width: 22px;
  color: var(--text-soft);
  text-align: center;
  font: 11px var(--font-mono);
}
.session-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.session-title-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 5px;
}
.session-title,
.session-meta {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-title { color: inherit; font-size: 12.5px; font-weight: 610; line-height: 16px; }
.session-meta { color: var(--muted); font: 10px/13px var(--font-mono); }
.session-oncanvas { flex: none; color: var(--accent); font-size: 10px; }
.session-sets { flex: none; display: inline-flex; align-items: center; gap: 3px; }
.session-set-swatch {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--set-1);
}
.session-set-swatch[data-set="2"] { background: var(--set-2); }
.session-set-swatch[data-set="3"] { background: var(--set-3); }
.session-set-swatch[data-set="4"] { background: var(--set-4); }
.session-list mark {
  padding: 0 1px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--warn) 22%, transparent);
  color: #ffe39a;
}
.session-status {
  justify-self: end;
  min-width: 62px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  font-size: 9.5px;
  font-weight: 750;
}
.session-status-icon {
  width: 10px;
  height: 10px;
  display: inline-grid;
  place-items: center;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 7px;
  line-height: 1;
}
.status-active { color: var(--ok); }
.status-busy { color: var(--info); }
.status-idle { color: var(--text-soft); }
.status-attention { color: var(--warn); }
.status-exited { color: var(--error); }

.has-tooltip { position: relative; }
.has-tooltip::after {
  content: attr(data-tooltip);
  position: absolute;
  z-index: 100;
  left: 50%;
  bottom: calc(100% + 7px);
  max-width: 240px;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: rgb(var(--rgb-s3));
  color: var(--text);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.35;
  white-space: normal;
  pointer-events: none;
  opacity: 0;
  transform: translate(-50%, 3px);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.has-tooltip:hover::after,
.has-tooltip:focus-visible::after,
.has-tooltip:focus-within::after {
  opacity: 1;
  transform: translate(-50%, 0);
}
.session-project:focus-visible > .session-project-head.has-tooltip::after,
.session-branch:focus-visible > .session-branch-head.has-tooltip::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .session-row,
  .sidebar-tab,
  .session-filter,
  .has-tooltip::after {
    transition: none;
  }
  .sidebar-head .rail-btn:active { transform: none; }
}
```

Retain the existing `.session-close`, close-confirmation, focus-set, empty-state,
new-pane menu, files panel, and Appearance rules, updating their selectors only
where the renamed row classes require it.

- [ ] **Step 5: Run CSS/source tests**

Run:

```bash
pnpm vitest --run __tests__/tauriWorkspaceRail.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the visual system**

```bash
git add \
  native/macos/psyche-build-tauri/web/styles.css \
  __tests__/tauriWorkspaceRail.test.ts
git commit -m "style: redesign sessions sidebar hierarchy" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 7: Preserve actions, errors, and realistic state coverage

**Files:**
- Modify: `__tests__/tauriCovenSessionSiderail.test.ts`
- Modify: `__tests__/tauriWorkspaceRail.test.ts`
- Modify: `native/macos/psyche-build-tauri/web/main.js`

- [ ] **Step 1: Add regression tests for actions and error states**

Extend the existing tests with:

```ts
const referenceSidebarFixture = JSON.stringify([
  {
    project: 'PSYCHE-BUILD',
    branch: 'feat/web-pane-attention',
    shells: ['shell 7', 'shell 8 · api', 'shell 8 · tests', 'shell 9', 'shell 10'],
  },
  {
    project: 'COVEN-CAVE',
    branch: 'main',
    agents: ['Agent Coven'],
    shells: ['shell 5'],
  },
  {
    project: 'CHAT',
    branch: 'main',
    agents: ['Agent Coven'],
  },
]);

it('keeps lifecycle actions on unified local rows', () => {
  const source = extractFunctionSource(mainJs, 'renderSessionList');
  for (const behavior of [
    'focusThread(rowModel.id)',
    'renameThread(rowModel.id',
    'duplicateThread(rowModel.value)',
    'sendToThread(rowModel.value, "\\x03")',
    'hideThread(rowModel.id)',
    'armSessionClose(wrapper, close, rowModel.value)',
  ]) {
    expect(source).toContain(behavior);
  }
});

it('keeps Coven attach and explicit discovery errors in the new tree', () => {
  const source = extractFunctionSource(mainJs, 'renderSessionList');
  expect(source).toContain('openCovenSession(project, rowModel.value)');
  expect(source).toContain('covenInlineState(covenDiscovery)');
  expect(mainJs).toContain('showing last confirmed sessions');
  expect(mainJs).toContain('Coven sessions unavailable');
});

it('distinguishes empty search, empty filter, and no-project states', () => {
  const source = extractFunctionSource(mainJs, 'renderSessionList');
  expect(source).toContain('No sessions match');
  expect(source).toContain('No sessions match this filter');
  expect(source).toContain('No project open');
});

it('covers the approved reference content and state classes', () => {
  for (const value of [
    'PSYCHE-BUILD',
    'feat/web-pane-attention',
    'COVEN-CAVE',
    'CHAT',
    'Agent Coven',
    'shell 5',
    'shell 7',
    'shell 8',
    'shell 9',
    'shell 10',
  ]) {
    expect(referenceSidebarFixture).toContain(value);
  }
  for (const state of [
    'is-selected', 'status-active', 'status-busy',
    'status-idle', 'status-attention', 'status-exited',
  ]) {
    expect(styles).toContain(state);
  }
});
```

Keep the fixture test-only; do not add a production demo mode.

- [ ] **Step 2: Run the regression tests and fix only direct failures**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriSidebarModel.test.ts
```

Expected: PASS. If an existing action assertion fails, restore the exact
existing handler on the unified row instead of creating a second action path.

- [ ] **Step 3: Verify empty and discovery messages are explicit**

In `renderSessionList()`, use:

```js
if (matched === 0) {
  var empty = document.createElement("div");
  empty.className = "session-empty";
  if (needle) {
    empty.textContent = "No sessions match “" + sessionFilter.trim() + "”.";
  } else if (sessionTypeFilter !== "all") {
    empty.textContent = "No sessions match this filter.";
  } else if (state.projects.length === 0) {
    empty.textContent = "No project open — ⌘O to add one.";
  } else {
    empty.textContent = "No sessions are available.";
  }
  sessionListEl.appendChild(empty);
}
```

Keep `covenInlineState()` appended independently so stale/unavailable/error
messages are never replaced by a normal empty state.

- [ ] **Step 4: Commit regression coverage**

```bash
git add \
  native/macos/psyche-build-tauri/web/main.js \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts
git commit -m "test: cover redesigned sessions sidebar" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 8: Regenerate the bundle and run final verification

**Files:**
- Modify: `native/macos/psyche-build-tauri/web/sessions.bundle.js`

- [ ] **Step 1: Rebuild browser bundles**

Run:

```bash
pnpm --filter psyche-build-tauri run build:web
```

Expected: esbuild exits successfully and rewrites
`native/macos/psyche-build-tauri/web/sessions.bundle.js`.

- [ ] **Step 2: Run the focused sidebar suite**

Run:

```bash
pnpm vitest --run \
  __tests__/tauriSidebarModel.test.ts \
  __tests__/tauriSessionModel.test.ts \
  __tests__/tauriSessionAttention.test.ts \
  __tests__/tauriCovenSessionSiderail.test.ts \
  __tests__/tauriWorkspaceRail.test.ts \
  __tests__/tauriWorkspacePanels.test.ts \
  __tests__/tauriWebBundles.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository type checking**

Run:

```bash
pnpm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git --no-pager diff --check
git --no-pager status --short
git --no-pager diff --stat
```

Expected: no whitespace errors; only the planned sidebar source, tests, bundle,
and documentation are changed.

- [ ] **Step 5: Commit the generated bundle**

```bash
git add native/macos/psyche-build-tauri/web/sessions.bundle.js
git commit -m "build: regenerate sessions bundle" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 6: Perform a packaged-width acceptance pass**

Run the existing Tauri development command:

```bash
pnpm run dev:tauri
```

At sidebar widths of 320, 390, and 420 pixels, confirm:

1. The current project and active branch are identifiable without scrolling
   sideways.
2. Project and branch disclosure targets work with pointer, Space, Left, and
   Right.
3. Selected, hovered, focused, pressed, active, busy, idle, attention, and
   exited treatments are visually distinct.
4. Search matches project, branch, type, command, harness, status, ID, and
   metadata; highlights text; and restores prior collapse state when cleared.
5. All five filters work and persist after reopening the application.
6. The selected session restores only when a matching session still exists.
7. Tabs, search, filters, and action buttons remain pinned while the tree
   scrolls.
8. Appearance remains anchored and visually secondary.
9. Tooltips appear on pointer hover and keyboard focus.
10. With macOS Reduce Motion enabled, no sidebar pulse or movement remains.

Stop the development app through its normal window close or terminal interrupt
after the acceptance pass.
