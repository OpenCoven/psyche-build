# Contributing to Psyche Build

This project is built while running Psyche Build itself. The goal is a fast, repeatable loop for maintainers and contributors.

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

2. Start Psyche Build in local dev mode:

```bash
pnpm dev
```

`pnpm dev` is the standard maintainer entrypoint for this repo. It generates hook docs, compiles TypeScript, then launches Psyche Build from `dist/index.js` with `PSYCHE_DEV=true`.

If tmux setup looks wrong, run:

```bash
pnpm run dev:doctor
node ./psyche doctor --fix
```

`psyche doctor --fix` applies safe tmux repairs, backs up an existing `~/.tmux.conf`, and only edits the psyche-managed block.

## Local macOS App Channels

Build a protected daily-use app from an explicit tested Git ref:

```sh
pnpm app:stable -- <git-ref>
```

The stable command builds the resolved commit in a temporary detached worktree,
runs the full desktop verification gate, smoke-launches the candidate with
temporary local data, and transactionally replaces
`~/Applications/Psyche Build.app` only after every check passes.

Build the current checkout as a separate experimental app:

```sh
pnpm app:dev
```

This fast path accepts a dirty checkout, skips the stable-only full gate and
startup smoke, and replaces only `~/Applications/Psyche Build Dev.app`.
The stable app uses bundle identifier `dev.opencoven.psyche`; the dev app uses
`dev.opencoven.psyche.dev`, keeping preferences, WebView data, caches, and
restored state isolated between channels. Neither command automatically opens
the installed app.

Local commands do not create a signed or notarized public release. These
commands produce local application bundles only; use `docs/RELEASE.md` for the
publication workflow.

## Recommended Daily Workflow

1. Keep one long-lived maintainer checkout for running local Psyche Build (`pnpm dev`).
2. Create feature panes/worktrees from Psyche Build (`n`) for actual changes.
3. Iterate in feature worktree panes and merge from the pane menu (`m`) when possible.
4. Close panes with care when you want to preserve worktrees for later.
5. Reopen closed worktrees with `r` when you need to resume work.

In DEV mode, source switching is available from the pane menu (`[DEV] Use as Source`) or hotkey (`S`):

- Select any worktree pane and run source toggle -> that worktree becomes active source.
- Toggle again on the already-active source pane -> source falls back to project root.
- If the active source worktree is closed/removed, Psyche Build automatically falls back to project root.
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
2. Merge through Psyche Build when possible to dogfood merge + cleanup paths.
3. Ensure local checks pass:

```bash
pnpm run typecheck
pnpm run test
```

`pnpm run typecheck` covers both trees: `tsc --noEmit` for `src/`, then
`typecheck:tests` for `__tests__/` via `tsconfig.test.json`. The test tree
needs its own config because the base one sets `rootDir` to `./src` so `tsc`
emits `dist/` with the right layout — which means `__tests__` can never be part
of it. Run `pnpm run typecheck:tests` alone when you only touched tests.

When you touch startup, onboarding, or the tmux session lifecycle, also run:

```bash
pnpm smoke
```

It builds and starts the real `dist/index.js` in a throwaway repo and `HOME` on
its own tmux server. `pnpm run test` deliberately excludes it — it needs tmux
and a production build, so keeping it out leaves the unit suite fast and
portable. See `docs/SMOKE.md`.

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
pnpm smoke
npm pack --dry-run
```

`pnpm smoke` and `npm pack --dry-run` check different things and both belong
here: one proves the built cockpit starts, the other proves the tarball carries
what it should. A package can pack correctly and still fail to launch.

Do not publish, tag, push protected branches, or merge release work without explicit maintainer approval.
