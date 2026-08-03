# CI-Safe Cockpit Smoke Test

## Goal

Add one command that proves a built Psyche Build cockpit can start in a clean,
disposable project without relying on a user profile, a real agent CLI, network
access, or Coven.

## Scope

The smoke command will build first, then run a single Vitest integration test
against `dist/index.js`.

The test will:

1. Create a temporary Git repository with one committed file.
2. Create a temporary HOME directory so Psyche Build cannot read or write the
   developer's real settings, tmux config, or runtime state.
3. Start an isolated tmux server with its own socket name and no user tmux
   configuration.
4. Launch the built CLI inside that tmux server from the disposable repository.
5. Wait for Psyche Build to initialize its project-local `.psyche` config.
6. Assert that the configuration identifies the disposable project and starts
   with no panes.
7. Quit the cockpit, then assert the tmux session is gone.
8. Always remove the tmux server and temporary directories in `finally`.

The test will not create a worktree pane, invoke an agent binary, call Coven,
or contact a network service. Existing focused tests continue to cover pane
creation, agent launch, and bridge behavior independently.

## Interface

Add `pnpm smoke` to `package.json`. It runs the production build followed by
the new smoke test file. The test requires `tmux`; when it is unavailable, the
command fails with an explicit prerequisite error instead of silently skipping
the only smoke assertion.

The existing `pnpm test` remains unchanged. This keeps the fast unit suite
portable while making `pnpm smoke` the explicit release and CI gate for
environments that provision tmux.

## Test Structure

Place the test at `__tests__/psyche.smoke.test.ts`, following the repository's
tmux E2E cleanup patterns:

- Generate unique tmux server and session names.
- Use direct `execFileSync` argument arrays where possible rather than shell
  interpolation.
- Poll with a bounded timeout for the `.psyche/psyche.config.json` file.
- Capture the tmux pane on failure to make startup failures diagnosable.
- Use a 30-second test timeout; startup normally completes much faster.

The smoke test launches `node <checkout>/dist/index.js` directly, so it checks
the compiled entry point used by the packaged CLI instead of TypeScript source
or the developer convenience command.

## Documentation

Update `docs/SMOKE.md` and `CONTRIBUTING.md` to make `pnpm smoke` the
repeatable cockpit startup check. Keep the manual interactive checklist for
testing richer pane, ritual, merge, and optional Coven flows.

## Acceptance Criteria

- `pnpm smoke` succeeds on macOS or Linux with Node, Git, and tmux installed.
- The test writes no state outside its temporary repository, HOME, or tmux
  server.
- The test does not require any configured or authenticated agent CLI.
- A startup failure reports the captured cockpit output.
- Cleanup runs after success and failure, leaving no named tmux server or
  temporary project behind.
- `pnpm test` and `pnpm typecheck` continue to pass.
