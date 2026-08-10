# Stable and Development macOS Build Channels

## Goal

Provide two locally built macOS applications that can be installed and used
side-by-side:

- `Psyche Build.app` is the protected daily-use build. It is produced only
  from an explicit Git ref in an isolated checkout after the full desktop
  verification gate passes.
- `Psyche Build Dev.app` is the experimental build. It is produced from the
  current checkout, including intentional uncommitted changes, without
  replacing or sharing local state with the stable app.

Both applications install under `~/Applications`. This work adds local build
channels only; it does not change the signed and notarized GitHub release
workflow.

## Commands

Add two root package commands:

```sh
pnpm app:stable -- <git-ref>
pnpm app:dev
```

`app:stable` requires exactly one Git ref. It resolves that ref to a commit
before doing any work and reports the exact commit SHA in its final output.
Missing, ambiguous, or non-commit refs fail before a checkout or build starts.

`app:dev` uses the current checkout. A dirty worktree is allowed because the
purpose of this channel is to exercise in-progress changes. Its final output
reports the current commit SHA and whether uncommitted changes were included.

Neither command launches the installed application automatically. Replacing an
app bundle therefore does not terminate or redirect a currently running
instance.

The implementation uses:

- `scripts/build-macos-app.mjs` for orchestration;
- `native/macos/psyche-build-tauri/src-tauri/tauri.dev.conf.json` for the
  dev-only Tauri identity overlay;
- `__tests__/macosBuildChannels.test.ts` for focused build-channel contracts.

## Channel identities

The existing Tauri configuration remains the production source of truth:

| Channel | Product and window name | Bundle identifier | Install path |
|---|---|---|---|
| Stable | `Psyche Build` | `dev.opencoven.psyche` | `~/Applications/Psyche Build.app` |
| Development | `Psyche Build Dev` | `dev.opencoven.psyche.dev` | `~/Applications/Psyche Build Dev.app` |

Add a Tauri dev-channel config overlay containing only the product name,
window title, and bundle identifier overrides. Tauri merges that overlay with
the production config during the dev build. Build settings, security policy,
icons, minimum macOS version, and application behavior continue to come from
the production config.

The distinct bundle identifiers give each app separate WebView storage,
preferences, caches, window restoration, and other identifier-scoped macOS
state. The dev app must never read or write the stable app's identifier-scoped
data.

## Builder architecture

Implement one Node ESM build orchestrator with small stages for:

1. Parsing the channel and optional ref.
2. Resolving source identity.
3. Preparing the source directory.
4. Running channel-specific validation.
5. Building the Tauri application bundle.
6. Locating and validating exactly one expected `.app`.
7. Smoke-launching the stable candidate.
8. Installing the bundle transactionally.
9. Recording build provenance.
10. Cleaning up temporary resources.

The command runner must use argument arrays rather than interpolated shell
commands. Errors include the failed stage, command, exit status, and captured
output needed to diagnose the failure. Cleanup errors are reported without
masking the original build or installation failure.

## Stable source isolation

The stable command creates a temporary detached Git worktree at the resolved
commit. It never copies files from the active worktree and never builds from
the active working directory. All dependency installation, generated files,
test output, Rust output, and Tauri artifacts remain inside that temporary
worktree.

The temporary worktree uses the checked-in lockfiles and runs:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:pack
cargo fmt --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --locked
cargo check --manifest-path native/macos/psyche-build-tauri/src-tauri/Cargo.toml --locked
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm --dir native/macos/psyche-build-tauri exec tauri build --bundles app
```

The active checkout may be dirty while a stable build runs. Its files, index,
branch, installed dependencies, and build outputs are not modified.

After success or failure, the orchestrator force-removes only the specific
temporary worktree it created, because generated bundles can make that
temporary checkout dirty. It does not prune or remove unrelated worktrees.

## Development build flow

The development command runs in the current checkout:

```sh
pnpm --dir native/macos/psyche-build-tauri build:web
pnpm --dir native/macos/psyche-build-tauri exec tauri build \
  --bundles app \
  --config src-tauri/tauri.dev.conf.json
```

This flow intentionally avoids the full stable gate so rebuilding the
experimental app remains fast. Compilation, web bundling, and Tauri packaging
must still succeed before the installed dev app changes.

The builder validates that the resulting bundle has product name
`Psyche Build Dev` and identifier `dev.opencoven.psyche.dev`. A production
identity in a dev artifact is a hard failure.

## Bundle validation and launch smoke

Before installation, both channels must have exactly one expected `.app`
artifact. The builder reads the candidate's `Info.plist` and verifies the
expected display name and bundle identifier.

The stable candidate then receives a short direct-launch smoke test before it
can replace the installed stable app:

1. Create temporary `HOME` and temporary state directories.
2. Start the executable inside the candidate app bundle and capture its output.
3. Require the process to remain alive for a bounded smoke window.
4. Terminate that exact process ID and wait for clean shutdown.
5. Fail with captured output if the process exits early or cannot start.

This smoke test detects immediate startup crashes without reading or modifying
the user's stable or dev application data. It is not a substitute for the
repository test suites or interactive product testing.

## Transactional installation

Installation happens on the same filesystem as `~/Applications`:

1. Create `~/Applications` when it does not exist.
2. Copy the verified candidate to a unique hidden staging path.
3. Revalidate the staged bundle identity.
4. Move the currently installed app for that channel to a unique backup path.
5. Rename the staged bundle to the channel's final install path.
6. Remove the backup only after the final bundle is present and valid.

If replacement fails after the old app is moved, restore the backup and return
a nonzero exit status. A stable build or installation failure must leave the
previous `Psyche Build.app` usable. The stable and dev commands only replace
their own channel paths.

## Provenance

After a successful install, write a build record under:

```text
~/Library/Application Support/Psyche Build Builder/builds.json
```

Each channel record contains:

- channel;
- resolved commit SHA;
- requested stable ref, when applicable;
- whether the source worktree was dirty;
- build completion time;
- installed application path;
- product name and bundle identifier.

Write the record atomically after the application install succeeds. A
provenance-write failure is reported as a command failure, but it does not
remove an already verified and installed app.

## Failure behavior

- Stable validation, build, identity, or smoke failures leave the installed
  stable app untouched.
- Dev build or identity failures leave the installed dev app untouched.
- A missing app artifact, multiple matching artifacts, or unexpected identity
  is always fatal.
- The builder does not silently fall back from stable to the current checkout.
- The builder does not weaken tests, retry failed commands as success, or
  create unsigned artifacts for the public release workflow.
- Temporary paths are unique and cleanup targets are explicit; cleanup never
  recursively removes the repository, home directory, or general worktree
  roots.

## Tests

Add focused tests around the orchestrator using temporary repositories,
fixture app bundles, and stub command runners. Cover:

- exact Git-ref resolution and rejection of invalid refs;
- stable command ordering and full-gate fail-closed behavior;
- stable isolation from a dirty active checkout;
- dev overlay contents and production/dev identity separation;
- dirty-source provenance for the dev channel;
- rejection of missing, duplicate, or incorrectly identified app bundles;
- stable launch-smoke success, early exit, timeout, and exact-process cleanup;
- transactional install success, rollback, and channel path isolation;
- atomic provenance updates;
- cleanup after success and failure.

The implementation is complete when the focused tests, existing TypeScript
tests and typecheck, Rust tests/checks, both real local channel builds, and the
stable candidate launch smoke all pass.

## Non-goals

- Publishing, signing, notarizing, or uploading a GitHub Release.
- Changing Homebrew or TestFlight distribution.
- Sharing settings or caches between stable and dev.
- Automatically selecting a "latest good" branch or tag.
- Automatically launching or terminating an installed app.
- Supporting Windows, Linux, or iOS build channels in these commands.
