# Documentation History Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every document in `HEAD` authoritative while preserving all retired plans, specs, release instructions, migration guidance, roadmap text, and demo-mobile claims through an exact commit-based history manifest.

**Architecture:** Record the implementation-plan commit as the final complete archive baseline, then make all cleanup changes without intermediate commits. Generate `docs/HISTORY.md` from that baseline and per-file Git history, replace the version-specific release runbook with a current version-neutral guide, audit surviving docs against current behavior, delete the approved historical files, and enforce the result with Vitest plus full-history CI checkout.

**Tech Stack:** Markdown, JavaScript docs content, Node.js, Vitest, Git history, GitHub immutable blob links, Vite.

---

## File structure

**Create**

- `docs/HISTORY.md` — sole in-tree index for retired documentation and retired sections.
- `docs/RELEASING.md` — version-neutral operator guide for the active release workflow.
- `__tests__/documentationHistory.test.ts` — validates archive baseline, manifest completeness, uniqueness, immutable links, and historical blob existence.

**Modify**

- `README.md` — remove migration and completed-release copy; describe current source/release discovery and link history.
- `CHANGELOG.md` — add a historical correction to the inaccurate v0.0.1 mobile-pairing claim without deleting release history.
- `CONTRIBUTING.md` — point maintainers to `docs/RELEASING.md`.
- `package.json` — ship `HISTORY.md` and `RELEASING.md`; stop shipping retired files.
- `.github/workflows/ci.yml` — fetch full Git history for the manifest contract test.
- `docs/README.md` — describe the current documentation classes and link the history/releasing pages.
- `docs/COVEN-DEMO-LOOP.md` — remove completed v0.0.1/Cask prerequisites and use source/release-discovery guidance.
- `native/ios/README.md` — document the actual production composition and the currently unwired first-pair UI without demo-era release identity.
- `docs/src/hero.js` — remove v0.0.1 and unavailable-Cask claims; present a source-checkout command.
- `docs/src/main.js` — copy the source-checkout command shown by the hero.
- `docs/src/content/getting-started.js` — use current source setup and release-discovery guidance.
- `docs/src/content/coven-demo.js` — remove completed v0.0.1/Cask prerequisites.
- `docs/src/content/troubleshooting.js` — replace obsolete Homebrew-availability troubleshooting with source and published-release checks.
- `__tests__/releaseDocs.test.ts` — replace the v0.0.1 documentation contract with current documentation/release invariants.
- `__tests__/releaseVersion.test.ts` — expect the packaged version-neutral release guide.

**Delete**

- Every tracked Markdown file under `docs/superpowers/plans/`.
- Every tracked Markdown file under `docs/superpowers/specs/`.
- `docs/BREAKING-CHANGES.md`.
- `docs/PRODUCT-SPEC.md`.
- `docs/RELEASE.md`.

The plan and its design spec are intentionally included in the deleted
historical set. During execution they remain readable from the recorded
baseline with:

```bash
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
git show "$(cat "$BASELINE_FILE")":docs/superpowers/plans/2026-08-12-documentation-history-cleanup.md
git show "$(cat "$BASELINE_FILE")":docs/superpowers/specs/2026-08-12-documentation-history-cleanup-design.md
```

## Atomicity rule

Do not create an implementation commit until Task 9. The parent of the cleanup
commit must remain the final complete tree containing every retired file.
Checkpoint with tests and `git diff`; do not checkpoint with Git commits.

### Task 1: Record the archive baseline and retirement inventory

**Files:**
- Read: `docs/superpowers/plans/*.md`
- Read: `docs/superpowers/specs/*.md`
- Read: `docs/BREAKING-CHANGES.md`
- Read: `docs/PRODUCT-SPEC.md`
- Read: `docs/RELEASE.md`
- Create outside worktree: `$(git rev-parse --git-path psyche-doc-history-baseline)`
- Create outside worktree: `$(git rev-parse --git-path psyche-retired-doc-paths)`

- [ ] **Step 1: Require a clean implementation starting point**

Run:

```bash
set -euo pipefail
test -z "$(git status --porcelain)"
```

Expected: exit 0 with no output. If it fails, stop rather than mixing unrelated
changes into the archive baseline.

- [ ] **Step 2: Record the immutable pre-cleanup commit**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
git rev-parse HEAD > "$BASELINE_FILE"
BASELINE="$(cat "$BASELINE_FILE")"
test "${#BASELINE}" -eq 40
git cat-file -e "$BASELINE^{commit}"
printf '%s\n' "$BASELINE"
```

Expected: one 40-character commit SHA.

- [ ] **Step 3: Generate the complete deleted-file inventory**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
RETIRED_PATHS_FILE="$(git rev-parse --git-path psyche-retired-doc-paths)"
BASELINE="$(cat "$BASELINE_FILE")"
{
  git ls-tree -r --name-only "$BASELINE" -- \
    docs/superpowers/plans \
    docs/superpowers/specs
  printf '%s\n' \
    docs/BREAKING-CHANGES.md \
    docs/PRODUCT-SPEC.md \
    docs/RELEASE.md
} | LC_ALL=C sort -u > "$RETIRED_PATHS_FILE"

test -s "$RETIRED_PATHS_FILE"
while IFS= read -r path; do
  git cat-file -e "$BASELINE:$path"
done < "$RETIRED_PATHS_FILE"

wc -l "$RETIRED_PATHS_FILE"
```

Expected: every listed path exists at the baseline. The count includes every
plan, every design spec, and the three explicit retired manuals.

- [ ] **Step 4: Confirm no extra historical category is being removed**

Run:

```bash
set -euo pipefail
RETIRED_PATHS_FILE="$(git rev-parse --git-path psyche-retired-doc-paths)"
if grep -Ev \
  '^(docs/superpowers/(plans|specs)/.+\.md|docs/(BREAKING-CHANGES|PRODUCT-SPEC|RELEASE)\.md)$' \
  "$RETIRED_PATHS_FILE"; then
  exit 1
else
  status=$?
  if [ "$status" -eq 1 ]; then
    :
  else
    exit "$status"
  fi
fi
```

Expected: exit 0 with no output.

### Task 2: Add the commit-history contract

**Files:**
- Create: `__tests__/documentationHistory.test.ts`
- Modify: `.github/workflows/ci.yml:21-24`

- [ ] **Step 1: Write the failing history-manifest test**

Create `__tests__/documentationHistory.test.ts` with these tests:

```ts
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const historyPath = 'docs/HISTORY.md';
const repositoryUrl = 'https://github.com/OpenCoven/psyche-build';

interface DeletedFileRow {
  category: string;
  path: string;
  lastCommit: string;
  date: string;
  subject: string;
  url: string;
}

function section(markdown: string, start: string, end: string): string {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  expect(startIndex, `${start} marker`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${end} marker`).toBeGreaterThan(startIndex);
  return markdown.slice(startIndex + start.length, endIndex);
}

function parseDeletedRows(markdown: string): DeletedFileRow[] {
  return section(
    markdown,
    '<!-- deleted-files:start -->',
    '<!-- deleted-files:end -->',
  )
    .split(/\r?\n/)
    .filter((line) => /^\| [^|]+ \| `[^`]+` \| `[0-9a-f]{40}` \|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return {
        category: cells[0],
        path: cells[1].slice(1, -1),
        lastCommit: cells[2].slice(1, -1),
        date: cells[3],
        subject: cells[4],
        url: cells[5].replace(/^\[view\]\(/, '').replace(/\)$/, ''),
      };
    });
}

async function deletedDocumentationPaths(baseline: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-only', '--diff-filter=D', baseline, '--'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => path.endsWith('.md') || path.startsWith('docs/'))
    .sort();
}

describe('documentation history', () => {
  it('records an immutable archive baseline and unique deleted-file rows', async () => {
    const markdown = await readFile(historyPath, 'utf8');
    const baseline = markdown.match(/Archive baseline: `([0-9a-f]{40})`/)?.[1];
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);

    const rows = parseDeletedRows(markdown);
    expect(rows.length).toBeGreaterThan(100);
    expect(new Set(rows.map((row) => row.path)).size).toBe(rows.length);
    expect(rows.map((row) => row.path).sort()).toEqual(
      await deletedDocumentationPaths(baseline!),
    );
  });

  it('pins every deleted file to a commit where its former path exists', async () => {
    const rows = parseDeletedRows(await readFile(historyPath, 'utf8'));
    for (const row of rows) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.subject).not.toBe('');
      expect(row.url).toBe(
        `${repositoryUrl}/blob/${row.lastCommit}/${row.path}`,
      );
      await expect(
        execFileAsync('git', ['cat-file', '-e', `${row.lastCommit}:${row.path}`]),
      ).resolves.toBeDefined();
    }
  });

  it('documents command-line recovery and retired sections', async () => {
    const markdown = await readFile(historyPath, 'utf8');
    expect(markdown).toContain('git show <commit>:<former-path>');
    expect(markdown).toContain('<!-- retired-sections:start -->');
    expect(markdown).toContain('<!-- retired-sections:end -->');
    expect(markdown).toContain('mobile pairing');
    expect(markdown).toContain('v0.0.1');
    expect(markdown).toContain('comux');
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing page fails**

Run:

```bash
set -euo pipefail
if output="$(pnpm exec vitest --run __tests__/documentationHistory.test.ts 2>&1)"; then
  printf '%s\n' "$output"
  printf '%s\n' 'Expected failure: __tests__/documentationHistory.test.ts passed before docs/HISTORY.md exists.' >&2
  exit 1
else
  status=$?
  if printf '%s\n' "$output" | grep -Eq '(ENOENT|no such file or directory).*docs/HISTORY\.md|docs/HISTORY\.md.*(ENOENT|no such file or directory)'; then
    printf '%s\n' "$output"
    printf '%s\n' "Expected failure confirmed: docs/HISTORY.md is missing (exit $status)." >&2
    exit 0
  fi
  printf '%s\n' "$output"
  printf '%s\n' "Unexpected Vitest failure: expected a docs/HISTORY.md ENOENT/missing-file error." >&2
  exit 1
fi
```

Expected: the test output is preserved, and the command exits 0 only when the
failure output proves `docs/HISTORY.md` is missing with an ENOENT/missing-file
error. Any other Vitest failure prints an unexpected-failure message and exits 1.

- [ ] **Step 3: Give CI the history required by the contract**

In the first checkout step of `.github/workflows/ci.yml`, add:

```yaml
          fetch-depth: 0
```

Keep `persist-credentials: false`.

- [ ] **Step 4: Do not commit**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
test "$(git rev-parse HEAD)" = "$(cat "$BASELINE_FILE")"
```

Expected: exit 0. The test remains intentionally red until the manifest and
retirements are complete.

### Task 3: Generate the full historical page

**Files:**
- Create: `docs/HISTORY.md`
- Read: `$(git rev-parse --git-path psyche-doc-history-baseline)`
- Read: `$(git rev-parse --git-path psyche-retired-doc-paths)`

- [ ] **Step 1: Generate immutable rows from Git instead of hand-copying SHAs**

Run this one-time generator:

```bash
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const repositoryUrl = 'https://github.com/OpenCoven/psyche-build';
const baselineFile = execFileSync('git', ['rev-parse', '--git-path', 'psyche-doc-history-baseline'], { encoding: 'utf8' }).trim();
const retiredPathsFile = execFileSync('git', ['rev-parse', '--git-path', 'psyche-retired-doc-paths'], { encoding: 'utf8' }).trim();
const baseline = readFileSync(baselineFile, 'utf8').trim();
const paths = readFileSync(retiredPathsFile, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function escapeCell(value) {
  return value.replace(/\|/g, '&#124;').replace(/\r?\n/g, ' ');
}

function category(path) {
  if (path.startsWith('docs/superpowers/plans/')) return 'Implementation plan';
  if (path.startsWith('docs/superpowers/specs/')) return 'Design spec';
  if (path.endsWith('BREAKING-CHANGES.md')) return 'Migration guide';
  if (path.endsWith('PRODUCT-SPEC.md')) return 'Roadmap/product spec';
  if (path.endsWith('RELEASE.md')) return 'Completed release runbook';
  throw new Error(`Unclassified retired path: ${path}`);
}

const rows = paths.map((path) => {
  const metadata = git([
    'log',
    '-1',
    '--format=%H%x09%cs%x09%s',
    baseline,
    '--',
    path,
  ]).split('\t');
  if (metadata.length < 3) throw new Error(`Missing history for ${path}`);
  const [lastCommit, date, ...subjectParts] = metadata;
  const subject = escapeCell(subjectParts.join('\t'));
  const url = `${repositoryUrl}/blob/${lastCommit}/${path}`;
  return `| ${category(path)} | \`${path}\` | \`${lastCommit}\` | ${date} | ${subject} | [view](${url}) |`;
});

const retiredSections = [
  ['`README.md`', 'comux upgrade banner and v0.0.1 distribution copy', 'Migration and completed-release guidance are no longer current.'],
  ['`CHANGELOG.md`', 'v0.0.1 mobile pairing claim', 'The pairing sheet did not complete live transport pairing.'],
  ['`CONTRIBUTING.md`', 'link to the version-specific release runbook', 'Release operations now use a version-neutral guide.'],
  ['`docs/README.md`', 'v0.0.1 distribution section and retired-page links', 'The docs index now lists only current pages.'],
  ['`docs/COVEN-DEMO-LOOP.md`', 'v0.0.1 Cask prerequisite', 'The demo uses current source/release discovery.'],
  ['`native/ios/README.md`', 'demo-first and v0.0.1 TestFlight identity copy', 'The page now describes current code and pairing limitations.'],
  ['`docs/src/hero.js`', 'v0.0.1 badge and unavailable-Cask claim', 'The hero no longer presents a completed release promise.'],
  ['`docs/src/content/getting-started.js`', 'v0.0.1 Cask setup', 'Getting started now uses current source/release discovery.'],
  ['`docs/src/content/coven-demo.js`', 'v0.0.1 Cask prerequisite', 'The demo no longer depends on a historical release.'],
  ['`docs/src/content/troubleshooting.js`', 'v0.0.1 Homebrew availability section', 'Troubleshooting now distinguishes source use from published releases.'],
];

const retiredSectionRows = retiredSections.map(([source, topic, reason]) =>
  `| ${source} | ${topic} | ${reason} | [view baseline](${repositoryUrl}/blob/${baseline}/${source.slice(1, -1)}) |`
);

const markdown = `# Documentation History

This page indexes documentation intentionally removed from the current tree.
The checked-out manuals describe current behavior; historical plans and
completed release material remain available through immutable Git history.

Archive baseline: \`${baseline}\`

The baseline is the final complete commit before the documentation cleanup.
Branch-based links are not used for retired material because branches move.

## Recover a retired file

\`\`\`sh
git show <commit>:<former-path>
\`\`\`

Use the per-file commit below for the last content revision, or substitute the
archive baseline to inspect the final complete pre-cleanup tree.

## Deleted files

<!-- deleted-files:start -->
| Category | Former path | Last content commit | Date | Last commit subject | Historical file |
|---|---|---|---|---|---|
${rows.join('\n')}
<!-- deleted-files:end -->

## Retired sections from surviving files

<!-- retired-sections:start -->
| Source | Retired topic | Why it left current docs | Pre-cleanup source |
|---|---|---|---|
${retiredSectionRows.join('\n')}
<!-- retired-sections:end -->

## Policy

- Current docs contain user guidance, contributor/operator guidance, active
  technical contracts, and release history.
- Completed plans, superseded specs, one-time runbooks, migration guides, and
  stale roadmap/demo claims belong in Git history.
- \`CHANGELOG.md\` remains the chronological release record; corrections are
  explicit rather than silently rewriting history.
`;

writeFileSync('docs/HISTORY.md', markdown);
NODE
```

Expected: `docs/HISTORY.md` contains one row for every path in
`$(git rev-parse --git-path psyche-retired-doc-paths)`, sorted by former path.

- [ ] **Step 2: Verify the manifest format before deleting anything**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
RETIRED_PATHS_FILE="$(git rev-parse --git-path psyche-retired-doc-paths)"
BASELINE="$(cat "$BASELINE_FILE")"
grep -F "Archive baseline: \`$BASELINE\`" docs/HISTORY.md
RETIRED_COUNT="$(wc -l < "$RETIRED_PATHS_FILE" | tr -d ' ')"
URL_COUNT="$(grep -c 'https://github.com/OpenCoven/psyche-build/blob/' docs/HISTORY.md || true)"
ROW_COUNT="$(grep -c '^| .* | `docs/' docs/HISTORY.md || true)"
test "$ROW_COUNT" -eq "$RETIRED_COUNT"
test "$URL_COUNT" -ge "$RETIRED_COUNT"
```

Expected: the first command prints the baseline line; deleted-file row count
matches the inventory; URL count is at least the deleted-file count.

### Task 4: Replace the completed release runbook with current guidance

**Files:**
- Create: `docs/RELEASING.md`
- Modify: `CONTRIBUTING.md:66-73`
- Modify: `package.json:39-49`
- Modify: `__tests__/releaseDocs.test.ts`
- Modify: `__tests__/releaseVersion.test.ts:79-86`

- [ ] **Step 1: Write the version-neutral release guide**

Create `docs/RELEASING.md` with these sections and commands:

````markdown
# Releasing Psyche Build

This guide describes the active `.github/workflows/release.yml` contract. It
does not claim that a release exists; GitHub Releases is the authoritative list
of published versions.

## Release outputs

- signed and notarized Apple Silicon and Intel macOS DMGs;
- `SHA256SUMS`;
- internal TestFlight upload unless `desktop_only=true`;
- Homebrew tap dispatch;
- one GitHub Release sourced from the signed stable tag.

The source Node CLI is included in the repository/package archive. A GitHub
release does not imply an npm publication.

## Protected release environment

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Base64 Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Developer ID certificate password |
| `APPLE_SIGNING_IDENTITY` | Developer ID identity name or fingerprint |
| `APPLE_ID` | Apple account used by `notarytool` |
| `APPLE_PASSWORD` | App-specific password |
| `APPLE_DISTRIBUTION_CERTIFICATE` | Base64 Apple Distribution `.p12` |
| `APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD` | Distribution certificate password |
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect issuer ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | Complete `.p8` contents |
| `APPLE_TEAM_ID` | Apple team ID |
| `HOMEBREW_TAP_TOKEN` | Token allowed to dispatch the tap update |

Keep these values only in the protected GitHub `release` environment. There is
no repository-secret fallback.

## Prepare a release

\`\`\`sh
VERSION="${PSYCHE_RELEASE_VERSION:?set PSYCHE_RELEASE_VERSION to the approved stable version}"
TAG="v$VERSION"

pnpm install --frozen-lockfile
pnpm release:version -- "$VERSION"
pnpm release:check -- "$TAG"
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
\`\`\`

Also run the Rust, Tauri, and iOS checks listed in the workflow before tagging.
Generate and review release notes from the matching changelog entry:

\`\`\`sh
node scripts/release-notes.mjs --github "$VERSION"
node scripts/release-notes.mjs --testflight "$VERSION"
\`\`\`

## Tag and publish

\`\`\`sh
test -z "$(git status --porcelain)"
git fetch origin main --tags
release_sha="$(git rev-parse origin/main)"
git checkout --detach "$release_sha"
test "$(git rev-parse HEAD)" = "$release_sha"
pnpm install --frozen-lockfile
pnpm release:check -- "$TAG"
git tag -s "$TAG" "$release_sha" -m "Psyche Build $TAG"
git verify-tag "$TAG"
git push origin "$TAG"
\`\`\`

The workflow requires a public repository, a verified signed annotated tag on
`main`, protected `main` and `v*` refs, and approval in the protected `release`
environment.

## Recovery

Re-run an existing immutable tag from `main`:

\`\`\`sh
gh workflow run Release \
  --repo OpenCoven/psyche-build \
  --ref main \
  -f tag="$TAG"
\`\`\`

Use `-f desktop_only=true` only when intentionally publishing macOS/Homebrew
without TestFlight. Tag pushes always use the coordinated release path.

Do not replace, move, or delete a published release tag.
````

- [ ] **Step 2: Point contributor guidance and package contents at the new files**

In `CONTRIBUTING.md`, replace `docs/RELEASE.md` with
`docs/RELEASING.md`.

In `package.json`:

- add `docs/HISTORY.md`;
- add `docs/RELEASING.md`;
- remove `docs/BREAKING-CHANGES.md`;
- remove `docs/PRODUCT-SPEC.md`;
- remove `docs/RELEASE.md`.

- [ ] **Step 3: Refactor release documentation tests away from v0.0.1**

In `__tests__/releaseDocs.test.ts`:

- rename the suite to `current documentation and release contract`;
- set `releaseDocs` to `README.md`, `docs/README.md`,
  `docs/RELEASING.md`, and `native/ios/README.md`;
- remove `historicalDocDirectories` filtering and instead assert no tracked
  path starts with `docs/superpowers/`;
- keep the exact protected-secret table test against `docs/RELEASING.md`;
- replace hard-coded `v0.0.1` tag/artifact expectations with the variables and
  commands from the new guide;
- remove tests that require every public guide to claim an unavailable Cask;
- add an assertion that active docs outside `CHANGELOG.md` and
  `docs/HISTORY.md` do not contain version-specific availability promises,
  `demo-first`, or the deleted paths;
- keep the no-public-npm claim and workflow-integrity assertions that still
  match `.github/workflows/release.yml`.

The central stale-claim loop should use:

```ts
const allowedHistoricalFiles = new Set(['CHANGELOG.md', 'docs/HISTORY.md']);
const stalePattern =
  /docs\/(?:BREAKING-CHANGES|PRODUCT-SPEC|RELEASE)\.md|docs\/superpowers\/|available after[^\n]*v0\.0\.1|demo-first|production iOS remote control is not yet available/i;

for (const filePath of activeFiles) {
  if (allowedHistoricalFiles.has(filePath)) continue;
  const contents = await readFile(filePath, 'utf8');
  if (stalePattern.test(contents)) staleClaims.push(filePath);
}
expect(staleClaims).toEqual([]);
```

- [ ] **Step 4: Update the packaged-runbook assertion**

In `__tests__/releaseVersion.test.ts`, change:

```ts
expect(packageJson.files).toContain('docs/RELEASE.md');
```

to:

```ts
expect(packageJson.files).toContain('docs/RELEASING.md');
expect(packageJson.files).toContain('docs/HISTORY.md');
expect(packageJson.files).not.toContain('docs/RELEASE.md');
```

- [ ] **Step 5: Run the release-doc tests**

Run:

```bash
set -euo pipefail
pnpm exec vitest --run __tests__/releaseVersion.test.ts
pnpm exec vitest --run \
  __tests__/releaseDocs.test.ts \
  -t 'protected release-environment secret'
```

Expected: both commands pass. The complete release-doc suite waits until the
historical files are deleted in Task 7.

### Task 5: Audit surviving Markdown entry points

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/README.md`
- Modify: `docs/COVEN-DEMO-LOOP.md`
- Modify: `native/ios/README.md`

- [ ] **Step 1: Make the root README current**

In `README.md`:

- remove the opening comux migration banner;
- replace the v0.0.1 distribution section with a `Distribution` section that
  says GitHub Releases is authoritative for packaged builds and gives source
  commands that work now;
- do not claim a Homebrew Cask, TestFlight build, npm release, Windows/Linux
  artifact, or App Store build exists unless the linked release actually
  exists;
- preserve the working Node CLI quick start;
- replace the documentation list with links to `docs/README.md`,
  `docs/HISTORY.md`, `docs/BRIDGE-SECURITY.md`,
  `docs/CONTROL-PLANE.md`, `docs/COVEN-DEMO-LOOP.md`,
  `docs/COVEN-SESSIONS.md`, `docs/SMOKE.md`, and
  `docs/RELEASING.md`.

Use this durable release wording:

```markdown
Packaged releases, when published, are listed on
[GitHub Releases](https://github.com/OpenCoven/psyche-build/releases). If no
release is listed, use the source development paths below; do not assume a
Homebrew, npm, TestFlight, or App Store distribution exists.
```

- [ ] **Step 2: Preserve changelog history with an explicit correction**

Under `### TestFlight: What to Test` in the `0.0.1` entry, add:

```markdown
> **Historical correction (2026-08-12):** The iOS pairing sheet in this
> release recorded a host label locally but did not submit the pairing code to
> `ConnectionManager`. Live mobile pairing and production remote control were
> not available in `0.0.1`.
```

Keep the release entry and its original date.

- [ ] **Step 3: Rebuild the docs index around current classes**

In `docs/README.md`:

- remove the v0.0.1 distribution section;
- keep local docs-site development commands;
- list current user guidance, contributor/operator guidance, active technical
  contracts, and release history as separate groups;
- link `HISTORY.md` and explain that completed plans/specs intentionally live
  only in Git history;
- remove links to `BREAKING-CHANGES.md`, `PRODUCT-SPEC.md`, and `RELEASE.md`;
- add `RELEASING.md`.

- [ ] **Step 4: Remove historical distribution claims from the Coven demo**

In `docs/COVEN-DEMO-LOOP.md`, replace the v0.0.1/Cask prerequisite with:

````markdown
Use a packaged build only when one is present on
[GitHub Releases](https://github.com/OpenCoven/psyche-build/releases).
For the source CLI demo, install this repository's dependencies and invoke the
checkout directly:

```bash
pnpm install --frozen-lockfile
node /path/to/psyche-build/psyche doctor --json
npx @opencoven/cli doctor
```
````

Remove the sentence tying npm availability to `0.0.1`. Keep the current Coven
daemon API and recovery instructions.

- [ ] **Step 5: Make the iOS README describe the actual first-pair boundary**

In `native/ios/README.md`:

- remove `demo-first`, the v0.0.1 identity, and TestFlight availability copy;
- preserve XcodeGen authority, bundle identifier, build/test commands,
  provenance, signing, and export configuration;
- state that production composition reconnects to a host already stored in
  `PairedHostStore`;
- state that `PsycheCore` contains Bonjour discovery, pinned TLS transport,
  token storage, and `ConnectionManager.pair`;
- state that the current `PairHostSheet` only calls
  `AppModel.recordPairedHostName` and does not invoke discovery, connect, or
  `ConnectionManager.pair`, so a fresh device cannot complete live pairing
  through the current UI.

Use direct wording:

```markdown
The protocol and transport layers support pairing, but the current first-pair
UI is not wired to them. `PairHostSheet` records the entered host name locally
and ignores the pairing code. A production launch can reconnect only when a
valid paired-host record already exists.
```

- [ ] **Step 6: Check the Markdown audit**

Run:

```bash
set -euo pipefail
if rg -n -i \
  'available after.*v0\.0\.1|demo-first|docs/(BREAKING-CHANGES|PRODUCT-SPEC|RELEASE)\.md' \
  README.md CONTRIBUTING.md docs/README.md docs/COVEN-DEMO-LOOP.md native/ios/README.md; then
  exit 1
else
  status=$?
  if [ "$status" -eq 1 ]; then
    :
  else
    exit "$status"
  fi
fi
```

Expected: no matches.

### Task 6: Remove historical release promises from the docs site

**Files:**
- Modify: `docs/src/hero.js`
- Modify: `docs/src/main.js`
- Modify: `docs/src/content/getting-started.js`
- Modify: `docs/src/content/coven-demo.js`
- Modify: `docs/src/content/troubleshooting.js`

- [ ] **Step 1: Replace the hero's completed-release copy**

In `docs/src/hero.js`:

- change `Operator field manual / v0.0.1` to `Operator field manual`;
- replace the Homebrew copy button text with:

```text
git clone https://github.com/OpenCoven/psyche-build.git
```

- remove `Homebrew Cask available after the v0.0.1 release.`;
- keep the GitHub repository and source CLI references.

In `docs/src/main.js`, change the clipboard string to the same `git clone`
command.

- [ ] **Step 2: Make Getting Started source-first**

In `docs/src/content/getting-started.js`, replace the v0.0.1 install section
with:

```html
<h2>Get Psyche Build</h2>
<p>Check <a href="https://github.com/OpenCoven/psyche-build/releases" target="_blank" rel="noopener">GitHub Releases</a> for packaged builds. If none is listed, use a source checkout:</p>
<pre><code data-lang="bash">git clone https://github.com/OpenCoven/psyche-build.git
cd psyche-build
pnpm install --frozen-lockfile
pnpm dev</code></pre>
<p>To run the source CLI against another repository, invoke <code>node /path/to/psyche-build/psyche</code> from that repository.</p>
```

Do not claim npm, Homebrew, TestFlight, or App Store availability.

- [ ] **Step 3: Update the rendered Coven demo**

In `docs/src/content/coven-demo.js`, mirror the source-first prerequisites from
`docs/COVEN-DEMO-LOOP.md` and remove every `v0.0.1`, Cask, and historical npm
sentence.

- [ ] **Step 4: Replace obsolete Homebrew troubleshooting**

In `docs/src/content/troubleshooting.js`:

- rename `Homebrew Install Fails` to `Packaged Build Is Missing`;
- direct readers to GitHub Releases as the authoritative package list;
- say that an absent release means source setup is required;
- keep checksum mismatch guidance only for an actually published release;
- remove the v0.0.1 Cask commands and version-specific npm sentence.

- [ ] **Step 5: Build the docs site**

Run:

```bash
set -euo pipefail
pnpm --dir docs build
```

Expected: Vite build succeeds and refreshes the generated docs client without
references to the retired release copy.

### Task 7: Retire the approved historical files

**Files:**
- Delete: `docs/superpowers/plans/*.md`
- Delete: `docs/superpowers/specs/*.md`
- Delete: `docs/BREAKING-CHANGES.md`
- Delete: `docs/PRODUCT-SPEC.md`
- Delete: `docs/RELEASE.md`

- [ ] **Step 1: Delete exactly the inventoried files**

Run:

```bash
set -euo pipefail
while IFS= read -r path; do
  git rm -- "$path"
done < "$(git rev-parse --git-path psyche-retired-doc-paths)"
```

Expected: Git stages deletion of every manifest path and nothing else.

- [ ] **Step 2: Prove the deletion set equals the manifest set**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
RETIRED_PATHS_FILE="$(git rev-parse --git-path psyche-retired-doc-paths)"
ACTUAL_RETIRED_PATHS_FILE="$(git rev-parse --git-path psyche-actual-retired-doc-paths)"
BASELINE="$(cat "$BASELINE_FILE")"
git diff --name-only --diff-filter=D "$BASELINE" -- | LC_ALL=C sort \
  > "$ACTUAL_RETIRED_PATHS_FILE"
diff -u "$RETIRED_PATHS_FILE" "$ACTUAL_RETIRED_PATHS_FILE"
```

Expected: no diff.

- [ ] **Step 3: Run the history contract**

Run:

```bash
set -euo pipefail
pnpm exec vitest --run __tests__/documentationHistory.test.ts
```

Expected: PASS. Every deleted file is indexed exactly once and every historical
blob resolves.

### Task 8: Finish current-doc contracts and validate the complete tree

**Files:**
- Validate: all files changed in Tasks 2-7

- [ ] **Step 1: Run the focused documentation tests**

Run:

```bash
set -euo pipefail
pnpm exec vitest --run \
  __tests__/documentationHistory.test.ts \
  __tests__/releaseDocs.test.ts \
  __tests__/releaseVersion.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Prove active docs contain no retired links or claims**

Run:

```bash
set -euo pipefail
if rg -n -i \
  'docs/(BREAKING-CHANGES|PRODUCT-SPEC|RELEASE)\.md|docs/superpowers/|available after.*v0\.0\.1|demo-first' \
  README.md CONTRIBUTING.md package.json docs/README.md docs/COVEN-DEMO-LOOP.md \
  native/ios/README.md docs/src; then
  exit 1
else
  status=$?
  if [ "$status" -eq 1 ]; then
    :
  else
    exit "$status"
  fi
fi
```

Expected: no matches.

- [ ] **Step 3: Prove historical terms remain only where intentional**

Run:

```bash
set -euo pipefail
rg -n -i 'comux|v0\.0\.1|mobile pairing' CHANGELOG.md docs/HISTORY.md
```

Expected: matches are limited to the historical release correction and history
index.

- [ ] **Step 4: Run type and documentation validation**

Run:

```bash
set -euo pipefail
pnpm typecheck
pnpm --dir docs build
pnpm smoke:pack
git diff --check
```

Expected: every command passes.

- [ ] **Step 5: Inspect package contents**

Run:

```bash
set -euo pipefail
npm pack --dry-run --json | jq -e '
  [.[0].files[].path] as $paths
  | ($paths | index("docs/HISTORY.md")) != null
  and ($paths | index("docs/RELEASING.md")) != null
  and ($paths | index("docs/RELEASE.md")) == null
  and ($paths | index("docs/BREAKING-CHANGES.md")) == null
  and ($paths | index("docs/PRODUCT-SPEC.md")) == null
'
```

Expected: `jq` returns `true`.

- [ ] **Step 6: Confirm scope**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
SCOPE_PATHS_FILE="$(git rev-parse --git-path psyche-doc-scope-paths)"
BASELINE="$(cat "$BASELINE_FILE")"
git diff --name-only "$BASELINE" -- > "$SCOPE_PATHS_FILE"
if grep -Ev \
  '^(\.github/workflows/ci\.yml|README\.md|CHANGELOG\.md|CONTRIBUTING\.md|package\.json|__tests__/(documentationHistory|releaseDocs|releaseVersion)\.test\.ts|docs/|native/ios/README\.md)$' \
  "$SCOPE_PATHS_FILE"; then
  exit 1
else
  status=$?
  if [ "$status" -eq 1 ]; then
    :
  else
    exit "$status"
  fi
fi
```

Expected: exit 0 with no output. Product source files remain
unchanged.

### Task 9: Create the atomic cleanup commit

**Files:**
- Commit: every validated change from Tasks 2-8

- [ ] **Step 1: Review the final deletion and modification summary**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
BASELINE="$(cat "$BASELINE_FILE")"
git status --short
git diff --stat "$BASELINE"
git diff --summary "$BASELINE"
```

Expected: the summary contains the three new current files/tests, current-doc
edits, CI history checkout, and only the inventoried historical deletions.

- [ ] **Step 2: Stage and commit once**

Run:

```bash
set -euo pipefail
git add -A
git commit \
  -m "docs: replace stale documentation with commit history" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one cleanup commit.

- [ ] **Step 3: Prove the cleanup commit has the documented baseline as parent**

Run:

```bash
set -euo pipefail
BASELINE_FILE="$(git rev-parse --git-path psyche-doc-history-baseline)"
test "$(git rev-parse HEAD^)" = "$(cat "$BASELINE_FILE")"
git status --short
```

Expected: exit 0 and a clean worktree.

- [ ] **Step 4: Re-run the history test against committed state**

Run:

```bash
set -euo pipefail
pnpm exec vitest --run __tests__/documentationHistory.test.ts
```

Expected: PASS using the committed baseline-to-HEAD diff.
