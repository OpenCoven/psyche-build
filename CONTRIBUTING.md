# Contributing to psyche

This project is built while running psyche itself. The goal is a fast, repeatable loop for maintainers and contributors.

## Prerequisites

- Node.js 18+
- `pnpm`
- `tmux` 3.0+
- Git 2.20+

## Local Development (Dogfood Loop)

1. Install dependencies:

```bash
pnpm install
```

2. Start psyche in local dev mode:

```bash
pnpm dev
```

`pnpm dev` is the standard maintainer entrypoint for this repo. It generates hook docs, compiles TypeScript, then launches psyche from `dist/index.js` with `PSYCHE_DEV=true`.

If tmux setup looks wrong, run:

```bash
pnpm run dev:doctor
node ./psyche doctor --fix
```

`psyche doctor --fix` applies safe tmux repairs, backs up an existing `~/.tmux.conf`, and only edits the psyche-managed block.

## Recommended Daily Workflow

1. Keep one long-lived maintainer checkout for running local psyche (`pnpm dev`).
2. Create feature panes/worktrees from psyche (`n`) for actual changes.
3. Iterate in feature worktree panes and merge from the pane menu (`m`) when possible.
4. Close panes with care when you want to preserve worktrees for later.
5. Reopen closed worktrees with `r` when you need to resume work.

In DEV mode, source switching is available from the pane menu (`[DEV] Use as Source`) or hotkey (`S`):

- Select any worktree pane and run source toggle -> that worktree becomes active source.
- Toggle again on the already-active source pane -> source falls back to project root.
- If the active source worktree is closed/removed, psyche automatically falls back to project root.
- The active source pane is marked with `[source]` in the pane list.

This keeps the dev session stable while still using pane-per-branch isolation.

## Bootstrap Behavior

`pnpm dev` generates hook docs before compiling. Hook documentation is generated from source into `src/utils/generated-agents-doc.ts`.

You can run the generator manually:

```bash
pnpm run generate:hooks-docs
```

If this generated file changes only because the date rolled forward, revert it before committing unless the generated content itself changed.

## Pull Request Workflow

1. One pane/worktree per PR branch.
2. Merge through psyche when possible to dogfood merge + cleanup paths.
3. Ensure local checks pass:

```bash
pnpm run typecheck
pnpm run test
```

4. For docs/package changes, also verify package contents:

```bash
npm pack --dry-run
```

5. Open PR from the feature branch created for that pane.

## Maintainer Checklist (Before Release)

```bash
pnpm run clean
pnpm run build
pnpm run typecheck
pnpm run test
npm pack --dry-run
```

Do not publish, tag, push protected branches, or merge release work without explicit maintainer approval.
