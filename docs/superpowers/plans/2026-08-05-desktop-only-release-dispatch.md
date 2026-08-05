# Desktop-Only Release Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed manual release mode that publishes the signed and notarized macOS application and Homebrew Cask without running or requiring the iOS/TestFlight release path.

**Architecture:** The manual workflow input is normalized by the existing verification job and exported as a trusted job output. The iOS job skips only when that output is true, while the publish job uses explicit dependency-result validation so a failed or cancelled iOS job cannot masquerade as a desktop-only release. Tag-triggered releases retain the coordinated macOS+iOS behavior.

**Tech Stack:** GitHub Actions YAML, Bash, TypeScript, Vitest, GitHub CLI release workflow contracts

---

### Task 1: Lock the desktop-only routing contract

**Files:**
- Modify: `__tests__/releaseWorkflow.test.ts`

- [ ] **Step 1: Add a failing workflow-input test**

Add a test beside the existing trigger contract:

```ts
it('allows only manual dispatches to select desktop-only publication', () => {
  const workflow = workflowSource();
  const verifyJob = workflowJobSource(workflow, 'verify');

  expect(workflow).toContain('desktop_only:');
  expect(workflow).toContain('type: boolean');
  expect(workflow).toContain('default: false');
  expect(verifyJob).toContain('desktop_only: ${{ steps.release.outputs.desktop_only }}');
  expect(verifyJob).toContain('DESKTOP_ONLY="${{ github.event_name == \'workflow_dispatch\' && inputs.desktop_only || false }}"');
  expect(verifyJob).toContain('echo "desktop_only=$DESKTOP_ONLY" >> "$GITHUB_OUTPUT"');
});
```

- [ ] **Step 2: Add failing iOS and publish-routing tests**

Require the iOS job to consume only the verified output and require publication
to accept an iOS skip only in desktop-only mode:

```ts
it('skips TestFlight only for verified desktop-only dispatches', () => {
  const workflow = workflowSource();
  const iosJob = workflowJobSource(workflow, 'upload-ios');
  const publishJob = workflowJobSource(workflow, 'publish');

  expect(iosJob).toContain("if: needs.verify.outputs.desktop_only != 'true'");
  expect(publishJob).toContain('if: always()');
  expect(publishJob).toContain("needs.verify.result == 'success'");
  expect(publishJob).toContain("needs.build-macos.result == 'success'");
  expect(publishJob).toContain(
    "(needs.upload-ios.result == 'success' || (needs.verify.outputs.desktop_only == 'true' && needs.upload-ios.result == 'skipped'))",
  );
});
```

- [ ] **Step 3: Run the targeted test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/releaseWorkflow.test.ts
```

Expected: FAIL because the workflow has no `desktop_only` input, output, or
dependency routing.

- [ ] **Step 4: Commit the failing contract**

```sh
git add __tests__/releaseWorkflow.test.ts
git commit -m "test: define desktop-only release routing"
```

### Task 2: Implement fail-closed workflow routing

**Files:**
- Modify: `.github/workflows/release.yml`
- Test: `__tests__/releaseWorkflow.test.ts`

- [ ] **Step 1: Add the manual input**

Under `workflow_dispatch.inputs`, add:

```yaml
      desktop_only:
        description: "Publish macOS and Homebrew without TestFlight"
        required: false
        type: boolean
        default: false
```

- [ ] **Step 2: Export the normalized verify-job output**

Add the output:

```yaml
      desktop_only: ${{ steps.release.outputs.desktop_only }}
```

In the existing release-resolution step, normalize the value:

```bash
DESKTOP_ONLY="${{ github.event_name == 'workflow_dispatch' && inputs.desktop_only || false }}"
echo "desktop_only=$DESKTOP_ONLY" >> "$GITHUB_OUTPUT"
```

Do not read `inputs.desktop_only` in downstream jobs.

- [ ] **Step 3: Skip only the iOS job**

Add this job-level condition to `upload-ios`:

```yaml
    if: needs.verify.outputs.desktop_only != 'true'
```

Keep `needs: verify`, the protected `release` environment, and every existing
iOS credential and cleanup step unchanged.

- [ ] **Step 4: Make publication explicitly fail-closed**

Keep all three dependencies and add:

```yaml
    if: >-
      always() &&
      needs.verify.result == 'success' &&
      needs.build-macos.result == 'success' &&
      (
        needs.upload-ios.result == 'success' ||
        (
          needs.verify.outputs.desktop_only == 'true' &&
          needs.upload-ios.result == 'skipped'
        )
      )
```

This condition must not accept `failure`, `cancelled`, or an unverified skip.

- [ ] **Step 5: Run the targeted test and verify GREEN**

Run:

```sh
pnpm vitest --run __tests__/releaseWorkflow.test.ts
```

Expected: all release workflow contract tests pass.

- [ ] **Step 6: Commit the workflow patch**

```sh
git add .github/workflows/release.yml __tests__/releaseWorkflow.test.ts
git commit -m "feat: add desktop-only release dispatch"
```

### Task 3: Document the reduced desktop credential path

**Files:**
- Modify: `docs/RELEASE.md`
- Modify: `__tests__/releaseDocs.test.ts`

- [ ] **Step 1: Add a failing runbook contract**

Add a test requiring the desktop-only command and its exact credential scope:

```ts
it('documents desktop-only recovery without weakening coordinated releases', () => {
  const release = readFileSync(resolve('docs/RELEASE.md'), 'utf8');

  expect(release).toContain(
    'gh workflow run Release --repo OpenCoven/psyche-build --ref main -f tag=v0.0.1 -f desktop_only=true',
  );
  expect(release).toContain('Desktop-only publication still requires');
  expect(release).toContain('APPLE_CERTIFICATE');
  expect(release).toContain('APPLE_CERTIFICATE_PASSWORD');
  expect(release).toContain('APPLE_SIGNING_IDENTITY');
  expect(release).toContain('APPLE_ID');
  expect(release).toContain('APPLE_PASSWORD');
  expect(release).toContain('APPLE_TEAM_ID');
  expect(release).toContain('HOMEBREW_TAP_TOKEN');
  expect(release).toContain('Tag pushes always run the coordinated macOS and internal TestFlight release');
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```sh
pnpm vitest --run __tests__/releaseDocs.test.ts
```

Expected: FAIL because the runbook does not mention desktop-only dispatch.

- [ ] **Step 3: Add the desktop-only runbook section**

Document:

```sh
gh workflow run Release \
  --repo OpenCoven/psyche-build \
  --ref main \
  -f tag=v0.0.1 \
  -f desktop_only=true
```

State explicitly:

- the tag must already exist and remain immutable;
- tag pushes always run the coordinated release;
- desktop-only publication still requires all macOS signing/notarization and
  Homebrew credentials;
- it does not require Apple Distribution or App Store Connect credentials;
- it does not claim or publish TestFlight availability.

- [ ] **Step 4: Run documentation tests and verify GREEN**

Run:

```sh
pnpm vitest --run __tests__/releaseDocs.test.ts
```

Expected: all release documentation tests pass.

- [ ] **Step 5: Commit the runbook update**

```sh
git add docs/RELEASE.md __tests__/releaseDocs.test.ts
git commit -m "docs: add desktop-only release recovery"
```

### Task 4: Validate and publish the patch branch

**Files:**
- Modify only files from Tasks 1-3

- [ ] **Step 1: Run the focused release contract suite**

```sh
pnpm vitest --run \
  __tests__/releaseWorkflow.test.ts \
  __tests__/releaseDocs.test.ts \
  __tests__/releaseVersion.test.ts \
  __tests__/releaseNotes.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run type and formatting validation**

```sh
pnpm typecheck
git diff --check origin/main...HEAD
```

Expected: typecheck passes and no whitespace errors are reported.

- [ ] **Step 3: Review the final diff**

Confirm:

- tag-triggered releases cannot select desktop-only mode;
- only `upload-ios` skips;
- publication rejects failed/cancelled iOS;
- macOS signing/notarization, release notes, checksums, and Homebrew remain
  mandatory;
- no credential values or fallback secrets were added.

- [ ] **Step 4: Push and open a pull request**

```sh
git push -u origin fix/desktop-only-release
gh pr create \
  --repo OpenCoven/psyche-build \
  --base main \
  --head fix/desktop-only-release \
  --title "feat: add desktop-only release dispatch" \
  --body "Adds a fail-closed manual release mode for signed/notarized macOS DMGs and Homebrew while preserving coordinated tag-triggered macOS+iOS releases."
```

- [ ] **Step 5: Wait for required checks**

```sh
gh pr checks --watch
```

Expected: `TypeScript and Rust` and `iOS` both pass.
