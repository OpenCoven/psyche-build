# Psyche Build Public Documentation Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every public documentation surface in this repository describe Psyche Build as the sole product while keeping concise third-party integration guidance where it serves a Psyche Build workflow.

**Architecture:** Treat `docs/src/` as the source of truth for the Vite site, `package.json#files` as the package-publication boundary, and root/package Markdown as the remaining public surface. Add a repository check that prevents standalone non-Psyche pages or positioning from returning, then rebuild generated `docs/client/` from the focused source.

**Tech Stack:** Markdown, JavaScript content modules, Node.js validation script, Vite, npm package dry-run.

---

## File Map

- Create `scripts/check-public-docs-focus.mjs`: enforce public-doc inventory and prohibited standalone positioning.
- Modify `package.json`: add the focus check and replace Coven-specific packaged docs with a Psyche Build integration guide.
- Modify `README.md`: remove standalone demo/roadmap/OpenClaw promotion and link to Psyche Build integration guidance.
- Modify `docs/README.md`: describe the Psyche Build-only public boundary and update related links.
- Create `docs/INTEGRATIONS.md`: concise Psyche Build integration boundaries for supported agent CLIs and optional Coven sessions.
- Delete `docs/COVEN-DEMO-LOOP.md`: standalone ecosystem demo.
- Delete `docs/COVEN-SESSIONS.md`: superseded by `docs/INTEGRATIONS.md`.
- Modify `docs/CONTROL-PLANE.md`: link to the Psyche Build integrations guide.
- Modify `docs/src/content/index.js`: remove the standalone Coven demo page.
- Delete `docs/src/content/coven-demo.js`: standalone demo content.
- Modify `docs/src/content/agents.js`: neutral supported-agent framing.
- Modify `docs/src/content/getting-started.js`: Psyche Build-first setup and concise optional integration note.
- Modify `docs/src/content/troubleshooting.js`: integration troubleshooting as a Psyche Build subsection.
- Modify other `docs/src/content/*.js` files only where the audit finds standalone product positioning.
- Regenerate `docs/src/dist/` and `docs/client/` through the existing docs build.

### Task 1: Add a public-documentation focus gate

**Files:**
- Create: `scripts/check-public-docs-focus.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing public-doc focus checker**

Create `scripts/check-public-docs-focus.mjs`:

```js
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const publicFiles = [
  'README.md',
  'docs/README.md',
  ...packageJson.files.filter((file) => file.endsWith('.md')),
  'docs/src/content/index.js',
  'docs/src/content/agents.js',
  'docs/src/content/getting-started.js',
  'docs/src/content/troubleshooting.js',
];
const prohibitedFiles = new Set([
  'docs/COVEN-DEMO-LOOP.md',
  'docs/COVEN-SESSIONS.md',
]);
const prohibitedText = [
  ['Coven Demo Loop', 'standalone Coven demo positioning'],
  ['Fix OpenClaw cockpit', 'standalone OpenClaw promotion'],
  ['OpenCoven public roadmap', 'external ecosystem roadmap promotion'],
  ['led by <strong>Coven Code</strong>', 'agent catalog product favoritism'],
];

const failures = [];
for (const file of prohibitedFiles) {
  if (packageJson.files.includes(file)) {
    failures.push(`${file}: must not be package-published`);
  }
  try {
    await stat(path.join(root, file));
    failures.push(`${file}: standalone public document must be removed`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const file of [...new Set(publicFiles)]) {
  const absolute = path.join(root, file);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      failures.push(`${file}: public documentation entry is not a file`);
      continue;
    }
  } catch {
    failures.push(`${file}: public documentation entry is missing`);
    continue;
  }
  const source = await readFile(absolute, 'utf8');
  for (const [needle, reason] of prohibitedText) {
    if (source.includes(needle)) failures.push(`${file}: ${reason}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Public documentation focus check passed (${new Set(publicFiles).size} files).`);
}
```

- [ ] **Step 2: Add and run the package script**

Add:

```json
"docs:focus:check": "node scripts/check-public-docs-focus.mjs"
```

Run:

```bash
pnpm run docs:focus:check
```

Expected: FAIL on the two Coven-specific package files, the demo navigation,
OpenClaw copy, roadmap link, and agent-catalog favoritism.

- [ ] **Step 3: Commit the failing guard**

```bash
git add scripts/check-public-docs-focus.mjs package.json
git commit -m "test: enforce Psyche Build public docs focus" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Focus the public Vite documentation site

**Files:**
- Modify: `docs/src/content/index.js`
- Delete: `docs/src/content/coven-demo.js`
- Modify: `docs/src/content/agents.js`
- Modify: `docs/src/content/getting-started.js`
- Modify: `docs/src/content/troubleshooting.js`
- Modify: `docs/src/hero.js`
- Modify: other `docs/src/content/*.js` files identified by the focus scan

- [ ] **Step 1: Remove the standalone demo from source navigation**

Delete the `coven-demo.js` import, module entry, and Usage navigation item from
`docs/src/content/index.js`:

```js
// Remove:
import * as covenDemo from './coven-demo.js';
'coven-demo': covenDemo,
{ path: '/coven-demo', title: 'Coven Demo Loop' },
```

Delete `docs/src/content/coven-demo.js`.

- [ ] **Step 2: Reframe the supported-agent catalog**

Replace the lead in `docs/src/content/agents.js` with:

```html
<p class="lead">Psyche Build detects supported AI coding agent CLIs and launches them in isolated panes and git worktrees. Each agent remains an optional integration; plain terminal panes work without any agent CLI.</p>
```

Keep the actual supported-agent table and command-specific permission flags,
because they explain Psyche Build behavior. Remove language that presents one
agent product as the lead or primary product.

- [ ] **Step 3: Make setup and troubleshooting Psyche Build-first**

In `getting-started.js`, replace “Doctor … explains which Coven features are
optional” with:

```html
<p>Doctor confirms tmux and git, reports detected supported agent CLIs, and identifies optional integration availability.</p>
```

Rename `Standalone vs Coven` to `Optional integrations` and use:

```html
<h2>Optional integrations</h2>
<p>Psyche Build does not require another OpenCoven product for panes, worktrees, agent launches, file inspection, merging, pull requests, rituals, settings, or cleanup.</p>
<p>When a supported local integration is available, Psyche Build may add scoped session actions without changing the core workflow.</p>
```

In `troubleshooting.js`, rename `No Coven Sessions Appear` to
`Optional session integration is unavailable` and keep only Psyche Build
diagnostics:

```html
<h2>Optional session integration is unavailable</h2>
<p>Psyche Build's core tmux, worktree, agent, merge, pull-request, ritual, settings, and file-browser workflows continue without the optional session provider.</p>
<p>If you enabled that integration, verify its local service is running for the same canonical project root, then restart or refresh Psyche Build.</p>
```

- [ ] **Step 4: Audit all site source for standalone product positioning**

Run:

```bash
rg -n "Coven Demo|OpenCoven public roadmap|Fix OpenClaw|led by.*Coven|coven run|coven daemon" docs/src
```

Expected: no standalone demo, roadmap, or other-product operational commands.
Retain product names only in supported-agent names or concise integration
boundaries that directly explain Psyche Build behavior.

- [ ] **Step 5: Run the focus gate and commit site source**

```bash
pnpm run docs:focus:check
git add docs/src/content/index.js docs/src/content/agents.js \
  docs/src/content/getting-started.js docs/src/content/troubleshooting.js \
  docs/src/hero.js
git add -u docs/src/content/coven-demo.js
git commit -m "docs: focus the public site on Psyche Build" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: the focus gate may still fail on Markdown/package surfaces, but no
site-source failure remains.

### Task 3: Consolidate public Markdown around Psyche Build

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`
- Create: `docs/INTEGRATIONS.md`
- Delete: `docs/COVEN-DEMO-LOOP.md`
- Delete: `docs/COVEN-SESSIONS.md`
- Modify: `docs/CONTROL-PLANE.md`
- Modify: `package.json`

- [ ] **Step 1: Create the Psyche Build integrations guide**

Create `docs/INTEGRATIONS.md` with this structure:

```markdown
# Psyche Build integrations

Psyche Build's core tmux, git-worktree, pane, file-browser, merge, pull-request,
ritual, settings, and cleanup workflows work without optional integrations.

## Supported coding agents

Psyche Build detects supported agent CLIs from the launch environment and runs
each selected agent inside a Psyche-managed pane and worktree. Agent-specific
permission flags are configured by Psyche Build; installation, accounts, and
provider behavior remain owned by the agent CLI.

## Optional local session provider

When a compatible local Coven daemon is available, Psyche Build can list,
launch, and attach project-scoped sessions. Psyche Build verifies the canonical
project root before exposing a session and keeps unavailable states non-fatal.
The integration is optional and does not replace Psyche Build's ordinary agent
or terminal panes.

## Failure behavior

Missing, stopped, incompatible, or malformed integrations stay isolated from
Psyche Build's core workflow. Psyche Build reports the unavailable integration
without disabling panes, worktrees, file browsing, merges, pull requests, or
cleanup.
```

Include only the stable API/identity details needed to understand Psyche Build.
Do not include demo scripts, another product's roadmap, proposed contracts, or
standalone operational runbooks.

- [ ] **Step 2: Remove standalone public documents and update publication**

Delete:

```text
docs/COVEN-DEMO-LOOP.md
docs/COVEN-SESSIONS.md
```

In `package.json#files`, replace those two entries with:

```json
"docs/INTEGRATIONS.md"
```

Update `docs/CONTROL-PLANE.md` from `Coven sessions` to:

```markdown
- [Psyche Build integrations](INTEGRATIONS.md)
```

- [ ] **Step 3: Focus the root README**

Remove:

- the “full Psyche Build + Coven walkthrough” link;
- `Fix OpenClaw` from the built-in ritual examples;
- the standalone `Fix OpenClaw cockpit` feature bullet;
- standalone Coven demo and external roadmap links.

Keep concise integration language in the supported-agent and optional
integration sections. Add the user-facing link:

```markdown
For optional agent and local-session boundaries, see
[Psyche Build integrations](./docs/INTEGRATIONS.md).
```

- [ ] **Step 4: Focus the docs README and related links**

Replace the related-doc entries for Coven sessions/demo with:

```markdown
- [Psyche Build integrations](INTEGRATIONS.md)
```

State explicitly that `docs/src/` is the Psyche Build public site source and
`docs/superpowers/` contains internal historical design records.

- [ ] **Step 5: Run link/content scans and commit**

```bash
rg -n "COVEN-DEMO-LOOP|COVEN-SESSIONS|Coven Demo|Fix OpenClaw|OpenCoven public roadmap" \
  README.md docs package.json \
  --glob '!docs/superpowers/**' \
  --glob '!docs/client/**' \
  --glob '!docs/src/dist/**'
pnpm run docs:focus:check
```

Expected: `rg` returns no matches and the focus gate passes.

```bash
git add README.md docs/README.md docs/INTEGRATIONS.md docs/CONTROL-PLANE.md package.json
git add -u docs/COVEN-DEMO-LOOP.md docs/COVEN-SESSIONS.md
git commit -m "docs: consolidate Psyche Build public guidance" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Rebuild and verify published documentation

**Files:**
- Regenerate: `docs/src/dist/**`
- Regenerate: `docs/client/**`
- Verify: package archive contents

- [ ] **Step 1: Build the public docs site in its own package**

```bash
pnpm --dir docs run build
```

Expected: Vite build succeeds, then `docs/client/` is replaced by the generated
`docs/src/dist/` output.

- [ ] **Step 2: Verify generated output contains no removed page**

```bash
rg -n "Coven Demo Loop|OpenCoven public roadmap|Fix OpenClaw cockpit" \
  docs/src/dist docs/client
```

Expected: no matches.

- [ ] **Step 3: Verify source and generated client parity**

```bash
diff -qr docs/src/dist docs/client
```

Expected: no differences.

- [ ] **Step 4: Inspect package publication**

```bash
npm pack --dry-run --json > "${TMPDIR:-/tmp}/psyche-build-pack.json"
node -e '
const fs = require("node:fs");
const [pack] = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const names = pack.files.map((entry) => entry.path);
for (const required of ["README.md", "docs/README.md", "docs/INTEGRATIONS.md"]) {
  if (!names.includes(required)) throw new Error(`missing ${required}`);
}
for (const removed of ["docs/COVEN-DEMO-LOOP.md", "docs/COVEN-SESSIONS.md"]) {
  if (names.includes(removed)) throw new Error(`unexpected ${removed}`);
}
' "${TMPDIR:-/tmp}/psyche-build-pack.json"
```

Expected: required Psyche Build docs are present and removed standalone docs
are absent.

- [ ] **Step 5: Run final checks**

```bash
pnpm run docs:focus:check
git diff --check origin/main...HEAD
git status --short
```

Expected: focus check passes, no whitespace errors, and only intentional source,
generated documentation, package-boundary, spec, and plan changes remain.

- [ ] **Step 6: Commit generated output**

```bash
git add docs/src/dist docs/client
git commit -m "build: regenerate Psyche Build documentation site" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
