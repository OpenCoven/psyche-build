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

This single-host manifest requires the observed source-smoke architecture to
match the selected DMG. Record `aarch64` or `arm64` for Apple Silicon and
`x86_64` or `x64` for Intel; the validator normalizes these aliases for comparison.
Keep observations from different hosts in separate manifests.

## Preparation

Run the read-only setup preflight before preparing a disposable session:

```sh
pnpm acceptance:preflight
pnpm acceptance:preflight -- --artifact-arch arm64
```

For JSON-only output, use `node scripts/operator-preflight.mjs` with the same
optional flag. Accepted architecture aliases are `arm64`/`aarch64` and
`x64`/`x86_64`. The artifact architecture is **operator-declared**, not binary
inspection, digest verification, or installed-artifact evidence. No path input
is accepted. Host architecture is the Node process architecture; a translated
process does not establish physical hardware architecture.

The versioned report checks PATH availability of Node, pnpm, Git, and tmux using
four non-login shell lookups, without executing those tools. Availability does
not prove versions or runtime health. Each subprocess has a 1-second timeout,
SIGKILL termination, a 1 KiB buffer ceiling, and discarded output; PATH is capped
at 32 Ki characters. No files are read. No releases are downloaded or mounted,
no product or GUI is launched, and no permissions or contexts are changed.

UI automation permission remains `unknown`: this command intentionally avoids
potentially prompting probes. Disposable context remains `unverified`; directory
names and user assertions cannot prove isolation from an active profile.
Establish these prerequisites manually before the execution steps below.
Missing tools, failed lookups, unsupported hosts, and architecture mismatches
are setup blockers, never product failures. Fix missing dependencies or PATH,
use a supported Mac, and select a matching artifact as appropriate.

Exit 0 means only that no observed setup blocker was found; exit 1 reports setup
blockers; exit 64 rejects invalid arguments with a fixed, redacted error.
Unknown permission and unverified context do not cause exit 1 or authorize
execution. Every acceptance scenario remains `not_observed`, even with exit 0.
This report is not an acceptance manifest and cannot close #199 or #239.

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

### New-candidate app-local profile (explicit opt-in; not historical release proof)

The `tauri.acceptance.conf.json` overlay builds a separate **local, unsigned or
ad-hoc** candidate named **Psyche Build Acceptance** with identifier
`dev.opencoven.psyche.acceptance`. It does not modify the installed application,
the fixed development channel, or the production default profile. Do not apply
its observations retroactively to the public `v0.0.1`/`v0.0.2` artifacts.

This profile is a conventional storage and subprocess-routing boundary, **not a
macOS sandbox**. It makes the local project/terminal/tmux/files/Git/settings/
restart path available for a new candidate without importing the active cockpit.
It deliberately excludes provider-backed lanes, remote Git/PR success,
clipboard/opener integration, and automatic browser restoration. Those rows
remain unobserved, not passed. A disposable macOS account remains necessary for
acceptance requiring isolation from OS credentials, existing TCC grants, system
services, arbitrary shell commands, or unrestricted web content.

#### Construct without launching

From the exact candidate worktree, with dependencies already available:

```sh
pnpm --dir native/desktop/psyche-build-tauri build:web
env -i HOME="$HOME" PATH="$PATH" CARGO_NET_OFFLINE=true \
  pnpm --dir native/desktop/psyche-build-tauri exec tauri build \
  --config src-tauri/tauri.acceptance.conf.json --bundles app --no-sign --ci
```

This invokes Tauri directly, **not** `scripts/build-macos-app.mjs`; it neither
installs a development channel nor replaces `/Applications/Psyche Build.app`.
`--no-sign` excludes signing/notarization credentials. Build-time HOME/PATH locate
the existing toolchain; they are **not** the application launch environment.
On a host prohibiting system scratch directories, add
`TMPDIR="$PWD/<existing-worktree-scratch-directory>"` to the build environment.
Never install dependencies merely to refresh them.

The resulting executable is
`native/desktop/psyche-build-tauri/src-tauri/target/release/bundle/macos/Psyche Build Acceptance.app/Contents/MacOS/psyche-build-tauri`.
Record the source SHA, executable/app digest, architecture and overlay digest.
Do not use Finder, `open`, a release installer, login items, or GUI automation at
this stage. Independent review and the applicable source gate precede GUI use.

#### Prepare, then obtain a separate owner decision before GUI use

Choose a **new**, short, absolute directory beneath a private, current-user-owned
parent, named `psyche-acceptance-<unique-run>`. All ancestor directories must be
real and not group/world writable. The resulting `run/tmux.sock` path must be
shorter than 104 bytes. Do not use the user's home itself, `.psyche`, a shared
directory, a symlink, a copied profile, or an existing unmarked directory.
Use the same exact root for restart; copying/relocating it is rejected.

In an operator-controlled shell, set `APP` to the exact executable above and
`PROFILE` to that chosen root. This preparation command is headless:

```sh
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  "$APP" --acceptance-prepare "$PROFILE"
```

It creates private storage, an opaque path-bound marker and two distinct
persistent WebKit store identifiers, validates the profile, prints only a fixed
success message, and exits **before plugins or any window are created**.
Invalid inputs exit 64. Partial setup is preserved and fails closed rather than
silently becoming a normal/default profile. Provision only a fresh disposable
Git repository beneath `$PROFILE/projects/`; put any linked worktrees there too.
Use local fixture commits, branches and an uncommitted sentinel, no personal
repository, credential configuration, hooks, external gitdir, or remote.

**The following command launches GUI and must not be run as part of source-only
preparation.** After an explicit owner decision covering the limitations below:

```sh
env -i HOME="$PROFILE/home" CFFIXED_USER_HOME="$PROFILE/home" \
  XDG_CONFIG_HOME="$PROFILE/config" XDG_DATA_HOME="$PROFILE/data" \
  XDG_CACHE_HOME="$PROFILE/cache" XDG_RUNTIME_DIR="$PROFILE/run" \
  TMPDIR="$PROFILE/scratch" \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin \
  "$APP" --acceptance-profile "$PROFILE"
```

HOME and CFFIXED_USER_HOME must be set **before exec**, not only changed after
Foundation initialization. Startup checks them, checks macOS 14+, takes a
nonblocking exclusive profile lock, then clears the inherited process
environment and installs the fixed application allowlist. macOS 13 and older
fail closed: Wry would otherwise silently select its default data store.
An acceptance candidate without an explicit profile refuses to launch.
Production candidates refuse these acceptance arguments.

#### Sanitized state/API/path matrix

`P` below means the opaque acceptance root. Do not retain its personal absolute
path, profile marker, raw environment, prompts, terminal history, or repository
contents in evidence.

| Surface / actual call chain | Acceptance route | Persistence / boundary |
|---|---|---|
| `app::run` → acceptance-only deferred windows → explicit `WebviewWindowBuilder` in setup | Direct `.data_store_identifier(profile.main_store).incognito(false)` before build, after FPS plugin registration | Persistent cockpit-only UUID requested; production automatic window creation unchanged |
| `ensure_browser` → `WebviewBuilder` → `main.add_child` | `WebviewBuilder::data_store_identifier`, distinct browser UUID before creation | Browser tabs share only their profile's browser store, not cockpit storage |
| WKWebView localStorage, IndexedDB, cookies, service worker/cache data | OS-managed `WKWebsiteDataStore.dataStoreForIdentifier` | Physical directory is managed by WebKit, **not** `P/data` and not promised to follow HOME; isolate by supported identifier API |
| Cockpit settings `psyche.tauri.settings.v1`, project appearance keys, legacy workspace fallback | Cockpit UUID's localStorage | Empty for a new profile; stable across restart; legacy fallback cannot import the default cockpit store |
| `workspace_load/save`, locks, forward/rollback/recovery/candidate artifacts | `P/home/.psyche/macos-app/workspace-v3.json` and existing sibling artifact names | Existing native secure persistence/rollback implementation, not a mock or replacement format |
| `native_session_*`, durable restore, PTY attach/stop/capture | Explicit `-S P/run/tmux.sock`; tmux server configuration `-f /dev/null` | Persistent session semantics unchanged; never the user's default tmux socket |
| Profile admission | `P/profile.v1`, `P/profile.lock` | Random domain-separated store IDs; path-bound marker; exclusive lock; unmarked/shared/copied/symlink/collision rejection; storage hardlinks require every alias inside validated storage |
| Config, data, cache, runtime scratch | HOME/CFFIXED → `P/home`; XDG → `P/config`, `P/data`, `P/cache`, `P/run`; TMPDIR → `P/scratch` | Own process and descendants; existing platform config remains `P/home/.config/psyche` where it explicitly derives HOME |
| `app_environment` executable/CWD repository discovery | Disabled in acceptance; no Psyche entry or Coven executable advertised | Cannot infer a launchable project from the candidate worktree |
| Project picker → native authority → canonical project/PTY/Git paths | Picker starts at `P/projects`; admission requires a canonical descendant | Picker is still a real NSOpenPanel and may display other locations; selecting outside fails authority admission |
| Shell PTY / durable shell | `/bin/bash --noprofile --norc`; fixed PATH; no inherited BASH_ENV, ENV, ZDOTDIR, SSH agent, token, proxy, DYLD, Coven or Git override | No login/global shell startup; PTY API rejects launch command/argument/environment overrides; arbitrary commands typed later are **not sandboxed** |
| Git panels and ordinary file operations | Existing production project authority, secure metadata checks, optimistic file conflict checks | Global/system Git configuration and prompting disabled; only disposable local fixtures admitted |
| `refreshCovenSessions`, `startCovenPolling`, `loadAgentSkills`, browser provider publication | Skipped in frontend; `coven_*`, `control_*`, `agent_skills` IPC rejected natively | No status CLI, provider socket connection/publication, capability probe, optional agent launch or automatic skill import |
| Startup browser restore | Suppressed in acceptance | Explicit navigation still uses the real browser; restored tabs must be navigated explicitly |
| Dialog, clipboard, opener plugins | Dialog retained for explicit project selection; clipboard/opener plugins not installed | These integrations are not acceptance successes; no automatic prompt/grant |
| Update/autostart/install | No startup integration in the native entry chain | No update request, login item, installation or installed-app replacement introduced |
| CF preferences, Keychain, TCC, system clipboard, LaunchServices, DNS/proxy policy, system WebKit processes | macOS-managed state; separate candidate bundle identity plus pre-exec HOME are not an OS account boundary | **Not isolated by this profile.** Disabling the clipboard plugin is not a clipboard sandbox for native menus or web content. No credential read/write, permission probe/reset, signing grant or cleanup claim is authorized |
| Network and user commands | No automatic provider activity or browser restore; explicit local fixture navigation/terminal commands only by operator contract | Not a network firewall; subresources, system services and arbitrary commands can reach shared resources |

The supported API is documented in
[Tauri `WebviewBuilder::data_store_identifier`](https://docs.rs/tauri/2.10.3/tauri/webview/struct.WebviewBuilder.html#method.data_store_identifier).
The lock selects Tauri 2.10.3, tauri-runtime 2.10.1,
tauri-runtime-wry 2.10.1 and Wry 0.54.4.
That runtime's actual `WebviewAttributes::from(&WindowConfig)` conversion omits
`data_store_identifier`. Assigning the config field does **not** isolate an
automatically created cockpit. Acceptance therefore defers only windows marked
for automatic creation, then builds them explicitly with the direct setter in
setup. The FPS plugin still registers before any WebView is built. A locked-crate
Rust conversion test records the omission; source contract checks cover the
explicit builder path. These tests are not an observed WKWebsiteDataStore or GUI
restart result; independent review and subsequent authorized runtime proof remain
required.

Startup enumerates `home/config/data/cache/run/scratch` together using no-follow,
descriptor-relative traversal. Two stable snapshots must account for every
regular-file inode's link count, with a shared 100,000-entry limit and depth 64.
This admits internal workspace forward/rollback links without admitting aliases
outside storage (including `projects`). Symlinks, foreign ownership, writable
shared storage, external aliases and observed enumeration churn fail closed.
Marker and profile lock files still require a single link. Real publication
fault tests cover retained prior/forward hardlinks, profile reopen, recovery and
the next save; recovery semantics and artifact names are unchanged. This bounded
startup check is not a sandbox against same-user tampering after validation.

Wry's macOS implementation selects `dataStoreForIdentifier` only on macOS 14+
and otherwise falls back to `defaultDataStore`; the explicit OS gate prevents
that fallback. `data_directory` is not a supported substitute on macOS.
Incognito would lose restart persistence and is deliberately not used.

Do not infer WebKit's actual storage location from a UUID, bundle name, or HOME.
Before recording runtime isolation as observed, the owner must observe clean
cockpit/browser storage, stable separate stores after restart, no default-profile
change, and only profile-owned session/process identities. Use bounded digests
and enumerated observations, never raw directory or process dumps. No such GUI
observation is established by unit tests or constructing the `.app`.

Quitting releases the profile lock but follows the real tmux survival contract.
Cleanup must target only positively identified profile sessions through the
application/explicit socket, never name-based process killing or another user's
server. Retain the profile and work on any unknown cleanup result. Deleting `P`
alone is **not** proof that OS-managed WebKit stores/preferences were removed;
defer that cleanup to an explicitly approved owner action or disposable account
teardown. No automatic deletion, migration, or TCC reset is provided.

#### Source-only validation record (2026-09-14)

The implementation was checked in its registered worktree without GUI launch,
installation, signing credentials, permission changes, provider launch or
personal project use. The unsigned arm64 `.app` built with the command above;
its identifier was inspected and its headless invalid-profile command exited
64. Parent verification also ran the actual candidate's `--acceptance-prepare`
against a fresh short private root: exit 0, fixed preparation-success output,
no stderr, and no GUI launch. The empty prepared profile was retained. This
proves headless preparation, not a successful GUI/profile runtime observation.

The 234 focused native-frontend tests, all 477 Rust tests, Rust check/format,
TypeScript checks, documentation focus/build, source smoke, package smoke and
generated hooks/web-bundle parity passed. Independent review's browser
provider-disabled navigation/close finding was reproduced, fixed and re-reviewed
without remaining findings. The separate Beads render suite passed 221 tests.

The initial host-constrained unit attempt had 5,415 passed, 40 failed and 11 skipped.
There were 36 Unix-socket path-limit failures across four unchanged control test
files, two Beads scratch-prefix expectation failures, and two recovery-harness
failures. These failed attempt results are retained, not rewritten as passes.
A short relative scratch-path retry removed most socket failures, but
fixtures that canonicalize their sockets still exceed macOS's path limit here.

The initial execution reported a restriction on `mktemp` and system scratch
writes. Its constituent checks were therefore run individually
with a worktree-local `TMPDIR`, and a `GIT_CEILING_DIRECTORIES` at that scratch
root to prevent non-repository fixtures discovering the enclosing checkout.
This initial attempt is **not** a passing `scripts/agent-check full` receipt.
A subsequent independent execution of `bash ./scripts/agent-check full` at
`4bc02373a033177e98cc0ccfdd99bff221b66b60` used the normal supported environment,
encountered no tool denial, completed successfully (exit 0), and left the
worktree clean. This includes the previously failing suites, Rust tests/check,
source/package smoke and generated parity. No product fix or test waiver was
needed for those environment-induced failures. iOS was not enabled. This
source-gate result does not establish GUI or release acceptance.

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

#### Known tagged-source first-run failure

On 2026-09-14, the unchanged accepted source reproduced a failed `pnpm smoke`
with a fresh HOME, no inherited credentials, and a private tmux server:
the cockpit exited after declining tmux setup, before writing the project
configuration. The command exited 1 after the configuration wait timed out.
The observed host was arm64 macOS 26.6.2 with Node 24.18.1, pnpm 10.34.5,
tmux 3.6a, and Git 2.55.0. This is a source-only observation, not an
observation of either published DMG.

The tag predates [PR #275](https://github.com/OpenCoven/psyche-build/pull/275)
(`fc58e9c88931c3e12e0d78d22044622d520bf87d`), which re-references stdin when
handing the TTY from Ink to readline and makes the smoke harness decline the
separate OpenRouter setup prompt. Current source
`c5d1896d56acff54f097b65074dd02d2d24bdcef` completed `pnpm smoke` in the same
credential-free environment, but that result does not repair or reverify the
tagged source.

If this failure is reproduced, retain `sourceSmoke.status: "failed"` and
`commandExitStatus: 1` with its evidence digest, and keep the manifest
`incomplete`. Do not inject credentials, patch the tagged checkout, or replace
the failed observation with a newer-source pass to satisfy the historical gate.
The source and packaged-runtime acceptance requirements remain unchanged.

### 2. Packaged first run and ordinary lifecycle

Verify the chosen DMG digest before installation. Then:

- launch the packaged application and complete onboarding;
- open the disposable repository;
- create and use one plain tmux-backed terminal;
- create one supported agent lane when available, otherwise mark it
  `inapplicable` only for the `supported-agent-lane` observation, with the reason in
  `safeNextAction`, set
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

`failed` means the expected terminal state was not reached. Retain the failure
and keep the manifest `incomplete` until remediation is re-observed on the named
evidence subject. A #199 transfer does not turn a failed observation into a pass.
An expected `recovery_required` outcome may support completion only with
`expectationMet: true`, preserved work, evidence, and a safe next action.

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

For each reusable gap, append a `transfers.issue199` record with `observationId`
set to its manifest observation ID and `url` set to the concrete #199 comment
that records ownership and follow-up. The URL must have the form
`https://github.com/OpenCoven/psyche-build/issues/199#issuecomment-<id>`.
The validator checks the record shape and destination, not the existence or
content of remote comments; the operator/verifier must confirm those.
Retain existing failure evidence when appending later successful observations.
