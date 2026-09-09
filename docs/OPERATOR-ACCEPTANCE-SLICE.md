# Bounded macOS operator acceptance slice

**Owners:** [#196](https://github.com/OpenCoven/psyche-build/issues/196) and
[#239](https://github.com/OpenCoven/psyche-build/issues/239)

This runbook advances the remaining packaged Tauri/tmux acceptance gate with one
bounded disposable workspace. It does not reopen or repeat release construction,
signing, notarization, checksum, publication, or Homebrew packaging work.

## Evidence subjects

Keep these subjects separate throughout collection:

| Subject | Immutable identity | What it may prove |
|---|---|---|
| Exact-source smoke | signed tag `v0.0.1`, tag object `6c628be321419c07c508e75c3652b44376d2ab3b`, commit `57c6c71bd5264fde960b062e95de278c8438c94f` | `pnpm smoke` on a tmux-equipped supported Mac |
| Apple Silicon packaged runtime | `Psyche-Build-v0.0.1-aarch64.dmg`, SHA-256 `e0c8cce02cedc7b7cc122c4b453da8ccc665f42da457aa571c2c476d3f03c74f` | operator-observed Tauri behavior on Apple Silicon |
| Intel packaged runtime | `Psyche-Build-v0.0.1-x86_64.dmg`, SHA-256 `c6d62f8aeea1570f377fe6bc2d5c90f5b6a4701390af1c42073465f2a586e882` | operator-observed Tauri behavior on Intel |

Choose exactly one packaged runtime matching the operator host. Do not describe
the source smoke as packaged-runtime evidence. Do not describe current-source
tests or the recovery harness as observations of either DMG. Existing
`v0.0.1` Homebrew lifecycle evidence remains a distinct completed publication
record.

## Preparation

1. Copy the
   [v0.0.1 manifest template](https://github.com/OpenCoven/psyche-build/blob/main/docs/templates/operator-acceptance-v0.0.1.json)
   outside the repository into the durable, operator-controlled evidence
   location.
2. Work in a disposable macOS user context and disposable Git repository.
3. Add an uncommitted sentinel file, a named branch, and a disposable worktree.
4. Record only bounded enumerated outcomes and SHA-256 digests. Do not retain raw
   prompts, terminal history, repository contents, environment dumps, private
   infrastructure details, credentials, or personal paths.
5. Run the validator before and after the session:

```sh
pnpm acceptance:validate -- /absolute/path/to/manifest.json
```

The template is intentionally incomplete. Use `--require-complete` only when
requesting closure:

```sh
pnpm acceptance:validate -- /absolute/path/to/manifest.json --require-complete
```

## One-session execution order

### 1. Exact-source tmux smoke

From a clean checkout at the exact tagged commit:

```sh
test "$(git rev-parse HEAD)" = 57c6c71bd5264fde960b062e95de278c8438c94f
pnpm install --frozen-lockfile
pnpm smoke
```

Record the sanitized versions of Node, pnpm, tmux, Git, macOS, architecture,
command exit status, and reviewed evidence digest. A source smoke failure does
not rewrite packaged-runtime observations.

### 2. Packaged first run and ordinary lifecycle

Verify the chosen DMG digest before installation. Then:

- launch the packaged application and complete onboarding;
- open the disposable repository;
- create and use one plain tmux-backed terminal;
- create one supported agent lane when available, otherwise mark it
  `inapplicable` with the reason in `safeNextAction`, set
  `expectationMet` to `true`, and retain at least one sanitized evidence digest;
- exercise project selection, lane selection, split, focus, resize,
  hide/restore, and active-project handoff;
- close one pane while the sentinel remains uncommitted;
- confirm the sentinel, branch, and worktree remain present.

Do not record every UI gesture as an independent artifact. One bounded record
may cover the ordinary lifecycle when it names all observed invariants.

### 3. Normal restart and interrupted transition

- quit normally and relaunch;
- confirm the intended workspace restores without duplicate projects, panes,
  sessions, or worktrees;
- record whether tmux/process behavior matches the documented contract;
- begin one disposable workspace transition and force-quit the application;
- relaunch and require deterministic restoration or an explicit
  `recovery_required` state with a safe next action;
- confirm the sentinel, branch, and worktree remain present.

A timeout, an advanced UI, or an apparently successful retry is not a terminal
result.

### 4. Representative consequential failures

Exercise only these two live boundaries in this slice:

1. Produce a merge conflict and interrupt the associated cleanup/reconciliation
   path. Require preserved work and an explicit reconciliation or safe-retry
   action.
2. Interrupt or revoke one optional provider during the disposable session.
   Require the provider-specific operation to fail closed while the plain
   terminal and unrelated local project operations remain usable.

Record `succeeded`, `failed`, or `recovery_required` only when the
consequence is known. Record `unknown` when it is not known; the validator
will prevent an unknown consequence from supporting closure.

## Deferred matrix

This first slice does not claim packaged observation of corrupt persisted state,
stale/replaced tmux identity, full storage, duplicate consequential retry,
successful remote pull-request creation, or uninstall/reinstall. Leave those
records `deferred` with #239 as owner unless the operator actually exercises
them.

The current recovery harness may remain linked as implementation evidence for
its six bounded scenarios. It must not be promoted to packaged GUI evidence.

## Handoff

After execution:

1. validate the manifest without `--require-complete`;
2. retain the manifest and bounded records in the approved durable evidence
   location;
3. append new evidence digests to the existing 15 rather than replacing them;
4. post the new terminal classifications to #239;
5. link that #239 update from #196;
6. keep both issues open while the manifest is `incomplete`;
7. request closure only after `--require-complete` passes, every reusable gap
   is mapped to #199, and no consequential observation remains unknown.
