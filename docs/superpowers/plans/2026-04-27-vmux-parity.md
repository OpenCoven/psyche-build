# VMUX Parity Implementation Plan

> **For agentic workers:** Implement this plan task-by-task and keep progress tracked with checkbox (`- [ ]`) syntax.

**Goal:** Bring `comux` from the clean public shell to practical parity with VMUX's core CLI, tmux/worktree pane engine, agent launcher registry, daemon bridge, and test harness while preserving clean git history and comux product naming.

**Architecture:** Import VMUX's proven TypeScript/Ink/tmux primitives into the clean `comux` repo as source, then rebrand runtime paths and public commands from `vmux` to `comux`. Keep the first parity target focused on the npm CLI/core/daemon path; native iOS/macOS companion assets are treated as a separate follow-up plan after the TypeScript package is green.

**Tech Stack:** Node.js ESM, TypeScript 5.9, pnpm 10, Ink/React for TUI, tmux, git worktrees, Vitest, ws, local daemon/control protocol.

---

## Scope boundary

This plan targets **core parity**, not every historical asset in the VMUX repository.

Included:

- CLI executable and TypeScript build pipeline.
- Ink terminal cockpit.
- tmux pane/session management.
- git worktree creation and metadata.
- coding-agent registry and launch commands.
- settings, project, pane, ritual, merge, PR, and hook utilities.
- daemon/bridge TypeScript services and tests.
- frontend/docs package metadata only when needed by the build scripts.

Excluded from this plan:

- VMUX git history.
- iOS Swift package and app assets.
- macOS native app bundle build products.
- archived screenshots/videos/build artifacts.
- old `.vmux` branding as the primary public path.

## File structure target

### Create or replace in `comux`

- `src/` — TypeScript source copied from VMUX, rebranded to comux.
- `__tests__/` — VMUX test suite copied and rebranded where tests assert names/paths.
- `frontend/` — only if required by existing build scripts; keep as direct VMUX parity until a comux UI plan replaces it.
- `scripts/` — build, guard, docs, smoke scripts required by npm scripts.
- `tsconfig.json` — VMUX TypeScript compiler settings.
- `vitest.config.ts` or existing VMUX test config files if present.
- `comux` — executable bin shim replacing the VMUX `vmux` shim.
- `docs/superpowers/plans/2026-04-27-vmux-parity.md` — this plan.

### Modify in `comux`

- `package.json` — convert from placeholder to real TypeScript package while preserving `name: "comux"`.
- `README.md` — keep public product positioning and add an implementation status section after parity lands.
- `docs/PRODUCT-SPEC.md` — keep as product source of truth; update only if implementation choices materially change the product model.
- `.gitignore` — add Node/TypeScript/build/runtime ignores from VMUX, rebranded for `.comux`.

---

## Task 1: Establish package/tooling parity

**Files:**
- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `comux`
- Create or modify: `.gitignore`

- [ ] **Step 1: Replace `package.json` with the comux TypeScript package manifest**

Write this package manifest. It keeps the public package name and product description, but adopts VMUX's build/test stack.

```json
{
  "name": "comux",
  "version": "0.0.0",
  "description": "Project-scoped agent cockpit for coordinating coding work across terminal sessions.",
  "type": "module",
  "author": "Valentina Alexander",
  "license": "MIT",
  "homepage": "https://github.com/BunsDev/comux#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/BunsDev/comux.git"
  },
  "bugs": {
    "url": "https://github.com/BunsDev/comux/issues"
  },
  "keywords": [
    "agents",
    "terminal",
    "tmux",
    "worktree",
    "git",
    "openclaw",
    "coding-agents"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist/**/*",
    "comux",
    "README.md",
    "docs/PRODUCT-SPEC.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "pnpm run generate:hooks-docs && pnpm run build:frontend && tsc",
    "build:frontend": "pnpm --filter comux-frontend run build",
    "generate:hooks-docs": "node scripts/generate-hooks-docs.js",
    "clean": "rm -rf dist src/utils/generated-agents-doc.ts",
    "dev": "pnpm run generate:hooks-docs && tsc && COMUX_DEV=true COMUX_DEV_WATCH=false node dist/index.js",
    "typecheck": "pnpm run generate:hooks-docs && tsc --noEmit",
    "test": "vitest --run",
    "prepublishOnly": "pnpm run build",
    "smoke:pack": "npm pack --dry-run"
  },
  "bin": {
    "comux": "comux"
  },
  "dependencies": {
    "bonjour-service": "^1.3.0",
    "chalk": "^5.3.0",
    "chokidar": "^4.0.3",
    "cli-highlight": "^2.1.11",
    "ink": "^5.0.1",
    "ink-text-input": "^6.0.0",
    "p-queue": "^9.0.0",
    "qrcode-terminal": "^0.12.0",
    "react": "^18.2.0",
    "selfsigned": "^2.4.1",
    "string-width": "^7.2.0",
    "vue": "^3.5.22",
    "ws": "^8.18.3"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.1",
    "@types/node": "^20.10.5",
    "@types/react": "^18.2.45",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-vue": "^5.2.1",
    "@vitest/coverage-v8": "^1.0.0",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-webgl": "^0.19.0",
    "@xterm/xterm": "^6.0.0",
    "npm-run-all2": "^8.0.4",
    "strip-ansi": "^7.1.2",
    "tsx": "^4.7.0",
    "typescript": "^5.9.2",
    "vite": "^6.4.2",
    "vitest": "^1.6.1"
  },
  "packageManager": "pnpm@10.14.0",
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Add VMUX TypeScript compiler settings**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "jsx": "react",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Replace the placeholder executable with a real bin shim**

Create `comux`:

```sh
#!/usr/bin/env node
import('./dist/index.js').catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

Run:

```bash
chmod +x comux
```

Expected: `ls -l comux` shows executable permissions.

- [ ] **Step 4: Add runtime/build ignores**

Create or update `.gitignore` with this content:

```gitignore
node_modules/
dist/
*.tgz
.DS_Store
.env
.env.*
.comux/
.vmux/
coverage/
playwright-report/
test-results/
```

- [ ] **Step 5: Install dependencies without running lifecycle scripts**

Run:

```bash
pnpm install --ignore-scripts
```

Expected: `pnpm-lock.yaml` is created or updated and no lifecycle scripts run.

- [ ] **Step 6: Commit package/tooling setup**

```bash
git add package.json pnpm-lock.yaml tsconfig.json comux .gitignore
git commit -m "chore: set up comux TypeScript package"
```

---

## Task 2: Import VMUX TypeScript source and tests with clean history

**Files:**
- Create: `src/**`
- Create: `__tests__/**`
- Create: `scripts/**`
- Create: `frontend/**` if build scripts require it
- Modify: `package.json` if copied frontend package names require script alignment

- [ ] **Step 1: Copy core source from VMUX**

Run from the comux repo root:

```bash
rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude 'dist' \
  "$HOME/Documents/GitHub/BunsDev/vmux/src/" \
  ./src/
```

Expected: `find src -type f | wc -l` reports more than 200 files.

- [ ] **Step 2: Copy VMUX tests**

```bash
rsync -a --delete \
  --exclude '.DS_Store' \
  "$HOME/Documents/GitHub/BunsDev/vmux/__tests__/" \
  ./__tests__/
```

Expected: `find __tests__ -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l` reports more than 100 files.

- [ ] **Step 3: Copy required scripts**

```bash
mkdir -p scripts
rsync -a \
  --exclude '.DS_Store' \
  --include 'generate-hooks-docs.js' \
  --include 'guard-runtime-parity.js' \
  --include 'smoke-pack-install.js' \
  --include 'dev-doctor.js' \
  --include 'install-local-hooks.sh' \
  --exclude '*' \
  "$HOME/Documents/GitHub/BunsDev/vmux/scripts/" \
  ./scripts/
```

Expected: `ls scripts` lists at least `generate-hooks-docs.js`.

- [ ] **Step 4: Copy frontend package if the build script references it**

```bash
if [ -d "$HOME/Documents/GitHub/BunsDev/vmux/frontend" ]; then
  rsync -a --delete \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude '.DS_Store' \
    "$HOME/Documents/GitHub/BunsDev/vmux/frontend/" \
    ./frontend/
fi
```

Expected: if `frontend/package.json` exists, it is present in comux.

- [ ] **Step 5: Commit raw import before rebrand**

```bash
git add src __tests__ scripts frontend package.json
git commit -m "chore: import vmux core sources"
```

This commit intentionally imports source without history but before broad renaming, making review easier.

---

## Task 3: Rebrand runtime names from VMUX to comux

**Files:**
- Modify: `src/**`
- Modify: `__tests__/**`
- Modify: `scripts/**`
- Modify: `frontend/**`
- Modify: `package.json`

- [ ] **Step 1: Run safe textual rebrand for product labels and env vars**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
replacements = [
    ('VMUX', 'COMUX'),
    ('Vmux', 'Comux'),
    ('vmux', 'comux'),
    ('.vmux', '.comux'),
    ('@lobes/comux', 'comux')
]
paths = [p for p in Path('.').rglob('*') if p.is_file()]
skip_parts = {'.git', 'node_modules', 'dist'}
for path in paths:
    if any(part in skip_parts for part in path.parts):
        continue
    if path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.dmg'}:
        continue
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        continue
    updated = text
    for old, new in replacements:
        updated = updated.replace(old, new)
    if updated != text:
        path.write_text(updated)
PY
```

Expected: `git diff --stat` shows broad text changes but no binary changes.

- [ ] **Step 2: Restore package name if broad replacement damaged it**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.name = 'comux';
pkg.bin = { comux: 'comux' };
pkg.repository = { type: 'git', url: 'git+https://github.com/BunsDev/comux.git' };
pkg.bugs = { url: 'https://github.com/BunsDev/comux/issues' };
pkg.homepage = 'https://github.com/BunsDev/comux#readme';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
NODE
```

Expected: `node -p "require('./package.json').name"` prints `comux`.

- [ ] **Step 3: Rename primary React/App files if imported names are still VMUX-specific**

Run:

```bash
for old in src/VmuxApp.tsx src/services/VmuxAttentionService.ts src/services/VmuxFocusService.ts; do
  if [ -f "$old" ]; then
    new="${old//Vmux/Comux}"
    git mv "$old" "$new"
  fi
done
```

Expected: files with `Comux` names exist when their `Vmux` counterparts existed.

- [ ] **Step 4: Fix import paths for renamed files**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
for path in list(Path('src').rglob('*.ts')) + list(Path('src').rglob('*.tsx')) + list(Path('__tests__').rglob('*.ts')) + list(Path('__tests__').rglob('*.tsx')):
    text = path.read_text()
    updated = text.replace('./VmuxApp.js', './ComuxApp.js')
    updated = updated.replace('../src/VmuxApp.js', '../src/ComuxApp.js')
    updated = updated.replace('VmuxAttentionService.js', 'ComuxAttentionService.js')
    updated = updated.replace('VmuxFocusService.js', 'ComuxFocusService.js')
    if updated != text:
        path.write_text(updated)
PY
```

Expected: `grep -R "VmuxApp" -n src __tests__` returns no import references.

- [ ] **Step 5: Run typecheck to expose remaining mechanical breaks**

```bash
pnpm typecheck
```

Expected: this may fail with remaining rename errors. Capture the first 30 errors and fix only mechanical comux/vmux rename issues in this task.

- [ ] **Step 6: Commit rebrand**

```bash
git add .
git commit -m "chore: rebrand vmux core to comux"
```

---

## Task 4: Restore green build and test baseline

**Files:**
- Modify: `src/**`
- Modify: `__tests__/**`
- Modify: `scripts/**`
- Modify: `frontend/package.json` if present
- Modify: `package.json`

- [ ] **Step 1: Run TypeScript check**

```bash
pnpm typecheck 2>&1 | tee /tmp/comux-typecheck.log
```

Expected: either pass or produce actionable TypeScript errors in `/tmp/comux-typecheck.log`.

- [ ] **Step 2: Fix missing module/file rename errors first**

Use this loop until there are no `Cannot find module` errors:

```bash
grep -E "Cannot find module|TS2307" /tmp/comux-typecheck.log | head -50
```

For each missing module caused by a rename, update the import path or rename the file to match the import. Do not change product behavior in this step.

- [ ] **Step 3: Fix symbol rename errors second**

Use this loop until there are no `Cannot find name` errors caused by `Vmux` to `Comux` symbols:

```bash
grep -E "Cannot find name|TS2304|TS2552" /tmp/comux-typecheck.log | head -50
```

For each broken symbol, make the class/function/type name consistent with the file name and imports.

- [ ] **Step 4: Run full TypeScript check again**

```bash
pnpm typecheck
```

Expected: exit code 0.

- [ ] **Step 5: Run unit tests**

```bash
pnpm test 2>&1 | tee /tmp/comux-test.log
```

Expected: many tests should pass. If tests fail only because they assert `vmux` strings or `.vmux` paths, update those assertions to `comux`/`.comux`.

- [ ] **Step 6: Run package dry run**

```bash
npm pack --dry-run
```

Expected: tarball includes `dist`, `comux`, README, product spec, and license after build has run.

- [ ] **Step 7: Commit green baseline**

```bash
git add .
git commit -m "test: restore comux core parity baseline"
```

---

## Task 5: Preserve VMUX compatibility through migration helpers

**Files:**
- Create: `src/utils/migrateVmuxConfig.ts`
- Modify: `src/index.ts`
- Test: `__tests__/migrateVmuxConfig.test.ts`

- [ ] **Step 1: Add failing migration tests**

Create `__tests__/migrateVmuxConfig.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateVmuxConfigIfNeeded } from '../src/utils/migrateVmuxConfig.js';

function tmpProject(): string {
  return mkdtempSync(path.join(tmpdir(), 'comux-migrate-'));
}

describe('migrateVmuxConfigIfNeeded', () => {
  it('copies legacy .vmux config into .comux when .comux is missing', async () => {
    const root = tmpProject();
    mkdirSync(path.join(root, '.vmux'), { recursive: true });
    writeFileSync(path.join(root, '.vmux', 'vmux.config.json'), JSON.stringify({ panes: [] }));

    const result = await migrateVmuxConfigIfNeeded(root);

    expect(result).toEqual({ migrated: true, reason: 'copied_legacy_config' });
    expect(existsSync(path.join(root, '.comux', 'comux.config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, '.comux', 'comux.config.json'), 'utf8'))).toEqual({ panes: [] });
  });

  it('does not overwrite an existing .comux config', async () => {
    const root = tmpProject();
    mkdirSync(path.join(root, '.vmux'), { recursive: true });
    mkdirSync(path.join(root, '.comux'), { recursive: true });
    writeFileSync(path.join(root, '.vmux', 'vmux.config.json'), JSON.stringify({ panes: ['legacy'] }));
    writeFileSync(path.join(root, '.comux', 'comux.config.json'), JSON.stringify({ panes: ['current'] }));

    const result = await migrateVmuxConfigIfNeeded(root);

    expect(result).toEqual({ migrated: false, reason: 'comux_config_exists' });
    expect(JSON.parse(readFileSync(path.join(root, '.comux', 'comux.config.json'), 'utf8'))).toEqual({ panes: ['current'] });
  });
});
```

- [ ] **Step 2: Run migration test and verify failure**

```bash
pnpm vitest --run __tests__/migrateVmuxConfig.test.ts
```

Expected: fail because `src/utils/migrateVmuxConfig.ts` does not exist.

- [ ] **Step 3: Implement migration helper**

Create `src/utils/migrateVmuxConfig.ts`:

```ts
import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

export type VmuxMigrationResult =
  | { migrated: true; reason: 'copied_legacy_config' }
  | { migrated: false; reason: 'comux_config_exists' | 'legacy_config_missing' };

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function migrateVmuxConfigIfNeeded(projectRoot: string): Promise<VmuxMigrationResult> {
  const comuxConfigPath = path.join(projectRoot, '.comux', 'comux.config.json');
  if (await exists(comuxConfigPath)) {
    return { migrated: false, reason: 'comux_config_exists' };
  }

  const legacyConfigPath = path.join(projectRoot, '.vmux', 'vmux.config.json');
  if (!(await exists(legacyConfigPath))) {
    return { migrated: false, reason: 'legacy_config_missing' };
  }

  await mkdir(path.dirname(comuxConfigPath), { recursive: true });
  await copyFile(legacyConfigPath, comuxConfigPath);
  return { migrated: true, reason: 'copied_legacy_config' };
}
```

- [ ] **Step 4: Wire migration into startup**

In `src/index.ts`, import and call the helper immediately after `projectRoot` is known and before reading comux config:

```ts
import { migrateVmuxConfigIfNeeded } from './utils/migrateVmuxConfig.js';
```

Inside initialization:

```ts
await migrateVmuxConfigIfNeeded(this.projectRoot);
```

- [ ] **Step 5: Verify migration and typecheck**

```bash
pnpm vitest --run __tests__/migrateVmuxConfig.test.ts
pnpm typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit migration compatibility**

```bash
git add src/utils/migrateVmuxConfig.ts src/index.ts __tests__/migrateVmuxConfig.test.ts
git commit -m "feat: migrate legacy vmux config into comux"
```

---

## Task 6: Validate core CLI smoke loop

**Files:**
- Modify: `README.md`
- Create: `docs/SMOKE.md`

- [ ] **Step 1: Build the package**

```bash
pnpm build
```

Expected: `dist/index.js` exists.

- [ ] **Step 2: Run the CLI help/doctor smoke**

```bash
node ./comux doctor --json
```

Expected: JSON output describing tmux/git/system checks.

- [ ] **Step 3: Run package dry run**

```bash
npm pack --dry-run
```

Expected: package includes `dist/**/*`, `comux`, README, product spec, and license.

- [ ] **Step 4: Document local smoke flow**

Create `docs/SMOKE.md`:

```md
# comux smoke test

Run these commands from a git repository on a machine with tmux installed:

```bash
pnpm install --ignore-scripts
pnpm build
node ./comux doctor --json
node ./comux
```

Expected behavior:

- `doctor --json` reports tmux and git checks.
- `node ./comux` opens the terminal cockpit for the current project.
- Creating a pane creates an isolated git worktree.
- Closing comux leaves no orphaned controller process.
```
```

- [ ] **Step 5: Link smoke docs from README**

Add this section to `README.md`:

```md
## Local smoke test

See [`docs/SMOKE.md`](./docs/SMOKE.md) for the current local verification loop.
```

- [ ] **Step 6: Commit smoke docs**

```bash
git add README.md docs/SMOKE.md
git commit -m "docs: add comux smoke test"
```

---

## Task 7: Prepare the first real npm release candidate

**Files:**
- Modify: `package.json`
- Modify: `README.md` if status text still says reserved shell

- [ ] **Step 1: Update version to 0.0.1**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '0.0.1';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
NODE
```

- [ ] **Step 2: Update README status**

Replace the reserved shell status with:

```md
## Status

`comux` is in early public development. The current package contains the TypeScript CLI/core port and local smoke path for the project-scoped agent cockpit.
```

- [ ] **Step 3: Verify release checks**

```bash
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit release candidate**

```bash
git add package.json README.md
git commit -m "chore: prepare comux 0.0.1"
```

- [ ] **Step 5: Stop before public publish**

Do not run `npm publish` or `git push` in this task unless Val explicitly approves those external state changes in the active conversation.

---

## Self-review checklist

- Spec coverage: Tasks 1-4 bring the VMUX TypeScript package, CLI, TUI, core services, tests, and daemon bridge into comux. Task 5 handles `.vmux` to `.comux` migration. Task 6 verifies local smoke. Task 7 prepares a publishable package without publishing.
- Scope control: native iOS/macOS app parity is intentionally excluded from this plan and should receive a separate plan after core package parity is green.
- Safety: push and publish are explicit stop points; destructive filesystem operations are limited to the comux repo and rsync into fresh target directories.
