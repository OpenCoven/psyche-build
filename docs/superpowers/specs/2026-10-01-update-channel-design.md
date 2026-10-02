# In-app update channel: design record

**Classification:** `reference`, per the [dated-record default](../README.md#classification).
This record becomes `active` only when the owner approves it under
[#477](https://github.com/OpenCoven/psyche-build/issues/477) and the
classification change is recorded in `docs/superpowers/README.md`. It decides
plan item 3.1 of the [production-readiness plan](../plans/2026-10-01-production-readiness.md)
(§3, Phase 3). It is a design, not an implementation, and it makes no support
claim. Implementing it is R4 under [AGENTS.md](../../../AGENTS.md#risk-and-review).

## 1. Current state

Citations are to `main` at `05364c68`.

**Desktop app: no updater.**

- `native/desktop/psyche-build-tauri/src-tauri/tauri.conf.json:40-45` configures
  only the `macos-fps` and `opener` plugins. There is no `plugins.updater`
  block, no updater public key, and no `bundle.createUpdaterArtifacts`
  (`:32-39`).
- `native/desktop/psyche-build-tauri/src-tauri/Cargo.toml:22-25,48` lists
  `tauri`, `opener`, `dialog`, `clipboard-manager` and `macos-fps`. There is no
  `tauri-plugin-updater`.
- The desktop web UI (`native/desktop/psyche-build-tauri/web/`) has no update
  banner or update check.

**CLI `AutoUpdater`: unsigned, and pointed at a channel that does not exist.**

- `src/services/AutoUpdater.ts:136-170` reads the latest version from
  `npm view psyche-build` or the npm registry. `docs/SUPPORT-MATRIX.md:33`
  marks the npm package **Unavailable**. On 2026-10-01, `npm view psyche-build`
  returned 404, so the package name is unclaimed. Nothing about the answer is
  signed. A third party who claims the name controls what the check reports.
- `:291-326` installs with `npm update -g` / `pnpm update -g` /
  `yarn global upgrade` through `execSync`. That runs only when `:191-263`
  detects a global install, which a source `link` can satisfy.
- `src/hooks/useAutoUpdater.ts:111-115` would call `process.exit(0)` three
  seconds after a successful update, with no user consent, which violates the
  "no silent restart" requirement. In practice that exit is never reached. The
  post-install check in `performUpdate()` re-enters `checkForUpdates()`, whose
  `currentVersion` comes from the module-level, `require`-cached `packageJson`.
  Replacing the global package cannot change that value in the running process,
  so the comparison against the latest version fails, and the hook reports
  "Update failed" even after a successful install. Remove the exit and fix the
  stale-version check before any updater is retargeted. (PR #502 has since
  disabled the registry path entirely.)
- Settings persist as `updateSettings` inside the **per-project**
  `.psyche/psyche.config.json` (`src/index.ts:277`,
  `AutoUpdater.ts:69-98`). This config sits behind the versioned config gate
  from PR #464. The gate stamps `PROJECT_CONFIG_SCHEMA_VERSION = 1`
  (`src/services/ProjectPaneConfig.ts:45`) and refuses a newer file with
  `config_newer_schema` (`:931-938`). `v0.0.2` predates #464, so `v0.0.2`
  does not refuse a newer file.
- The support-bundle collector `updater` from PR #467
  (`src/diagnostics/supportBundleCollectors.ts:185-208`) reports `mode`, a
  `current`/`stale` cache state and `capability`. It describes the npm cache
  only.

**Release pipeline.**

- `.github/workflows/release.yml:347-359` builds each architecture with
  `tauri build --bundles dmg`. `:361-399` notarizes, staples, and verifies the
  result with `codesign --verify --deep --strict` and `stapler validate`. The
  Apple secrets live in the protected `release` environment (`:221`,
  `:284-305`).
- `:798-799` writes `SHA256SUMS` over the two DMGs in the `publish` job. Four
  checks pin the asset set to exactly two DMGs plus `SHA256SUMS`: `:793`,
  `:824`, `:882` and `:891`. `:906` then flips the draft to latest.
- `notify-homebrew` (`:908-936`) sends a `repository_dispatch` to
  `OpenCoven/homebrew-tap`, authenticated with the `HOMEBREW_TAP_TOKEN`
  bearer token. The request and its payload carry no cryptographic signature,
  so the receiving workflow has nothing to verify. Success means
  only that the dispatch was accepted. It does not show that the tap changed.
- The release workflow has no updater signing secret and no signing step for
  a manifest.

**Homebrew Cask.** `OpenCoven/homebrew-tap:Casks/psyche-build.rb` (read through
`gh api` on 2026-10-01) pins `version "0.0.2"` and per-architecture `sha256`
values (`:6-8`), and installs `app "Psyche Build.app"` (`:17`). It declares
neither `auto_updates` nor `livecheck`, so `brew upgrade` owns upgrades today.

## 2. Options

**(a) Tauri updater.** Add `tauri-plugin-updater`. A `latest.json` file on
GitHub Releases names a per-architecture `.app.tar.gz` and its minisign
signature. The app downloads the archive, verifies it against an embedded
public key, replaces the bundle, and relaunches on request.

**(b) Detect and defer.** The app fetches a release manifest, verifies its
detached signature against an embedded public key, and tells the user how to
upgrade:

- for a Cask install: `brew upgrade --cask psyche-build`;
- for a DMG install: the release DMG, its SHA-256 value, and the release page.

The app never replaces itself.

**(c) Hybrid.** Use (b) for detection everywhere. Install with (a) only for
DMG installs, and only in a later slice.

| Criterion | (a) Tauri updater | (b) Detect + defer | (c) Hybrid |
|---|---|---|---|
| Signing and key custody | New updater key (`TAURI_SIGNING_PRIVATE_KEY` plus password) in the `release` environment. Signs payloads. | New manifest key in the `release` environment, or signing offline by the owner. Signs one small file. | One key serves both, because the Tauri signer uses minisign. |
| What is verified before use | The payload signature. **`latest.json` itself is unsigned.** Its integrity rests on TLS and GitHub, and the plugin's default version comparison is the only defence against replay. | The whole manifest: version, tag, source SHA, DMG digests and expiry. Its signature is checked before the manifest is parsed. | Both. |
| Key rotation | One `pubkey` in `tauri.conf.json`. A rotation means shipping a bridge release first. A lost key strands every installed copy. | The app embeds a current and a next key slot, so a rotation needs no bridge release. A lost key degrades to "check the release page". | Same as (b) for detection. Same as (a) for installs. |
| Rollback | The update replaces the bundle in place, and the plugin has no rollback. A rollback is a manual DMG reinstall. | Unchanged from today. Reinstall the `v0.0.2` DMG from its immutable tag and verify it with `SHA256SUMS`. | Same as (b). |
| Cask interaction | The Cask must declare `auto_updates true`. `brew upgrade` then skips the app unless `--greedy`, `brew outdated` goes quiet, and Caskroom metadata drifts from the installed version. | None. Brew remains the installer, and the Cask stays as it is. | Cask installs never self-update, so `auto_updates` stays undeclared. Install-source detection becomes load-bearing. |
| Notarization and Gatekeeper | The `.app.tar.gz` holds a notarized, stapled app, but no Gatekeeper first-launch assessment runs on the swapped bundle. The workflow needs a new `--bundles app` path. | Unchanged. Brew and DMG installs get the existing notarized and stapled assessment. | Same as (b) for detection. Same as (a) for installs. |
| Offline and failure modes | Download, verification and replacement can each fail partway and must each be surfaced. | Only the check can fail. Offline, a bad signature, an expired manifest and a malformed manifest each end in a named state with no action taken. | Union of both. |
| Consent | The app must not call `relaunch()` automatically. The user confirms the restart. | No restart exists to consent to. | Same as (a) for installs. |
| Persisted state | App-level state is needed in any case. Reconciliation after an upgrade runs at first launch of the new build. | The same reconciliation runs, but brew or the DMG performs the upgrade. | Same. |
| G4/G5 operator evidence | Covers download, signature, swap, relaunch, a bad-signature refusal and a Cask conflict. | Covers detection, a bad-signature refusal, an expired manifest, offline, and a brew or DMG upgrade. | The sum of both. |
| Implementation size | Plugin, config, workflow bundle changes, five or more new release assets, UI, Cask change. Large. | Manifest generation and signing, about 150 lines of verifier and banner, a retargeted CLI check. Small to medium. | (b) now, then (a) later. |
| New secrets | Updater private key and password. | Manifest signing key and password, unless the owner signs offline. | One key. |

## 3. Recommendation

**Adopt (c), and ship only its detection half (option b) as the first slice.**
Defer self-install until the owner decides it is worth the Cask and Gatekeeper
costs. This matches the plan's stated fallback (§5, "The update-channel
design stalls").

Option (b) satisfies all three requirements on its own:

- **A signed manifest, verified before use.** The signature covers the whole
  manifest, which is stronger than Tauri's design, where `latest.json` is
  unsigned.
- **Explicit failure.** Every failure ends in a named state, and no step is
  taken after one.
- **No silent restart.** The app never restarts itself.

It also leaves brew in charge, so nothing changes for Cask users.

### Minimal first slice (plan item 3.2, R4)

1. **Manifest.** The `publish` job writes `update-manifest.json` with these
   fields:
   - `schema: 1`;
   - `version`, `tag` and the 40-character `source_sha`;
   - the DMG `sha256` values per architecture (the same digests as
     `SHA256SUMS`);
   - `published_at` and `expires_at`, where `expires_at` is at most 30 days
     later. This limits a freeze attack, in which a replayed old manifest
     withholds updates.

   The job signs the manifest with minisign into `update-manifest.json.minisig`.
   Both files join the exact asset set (`release.yml:793,824,882,891`, from
   three assets to five). Plan item 3.4 adds a check that the manifest
   `version` equals the tag, `package.json` and `tauri.conf.json`.
2. **Desktop verifier (Rust, in `src-tauri`).** The app fetches
   `releases/latest/download/update-manifest.json` and its signature. It
   verifies the signature against two embedded public-key slots (current and
   next) **before** it parses the manifest. It refuses a manifest whose
   version is not greater than the running version, which is expired, or
   whose tag does not match its version. It returns one of the states
   `current`, `available`, `offline`, `signature_invalid`, `expired` or
   `malformed`.
3. **Banner.** The app infers the install source from a
   `Caskroom/psyche-build` path. The inference serves only to choose which
   instructions to show, and an `unknown` source shows both. The banner offers
   no install button and never restarts the app.
4. **Persisted state.** Update state (`last_check`, `skipped_version`,
   `last_seen_version`) lives in app scope under
   `~/Library/Application Support/dev.opencoven.psyche`, not in project
   configs. On the first launch after `last_seen_version` changes, the app
   reads each open project through the #464 gate and reports the outcome:
   migrated, current, or `config_newer_schema`.
5. **Rollback safety.** `v0.0.2` predates the #464 gate. It cannot refuse a
   newer-schema project config; it would read it and could later overwrite
   fields it does not understand. A note in the release notes does not
   prevent that. So the first production release **must not bump**
   `PROJECT_CONFIG_SCHEMA_VERSION`, and CI should assert that the constant
   equals the value shipped in the previous public release. Only under that
   constraint does reinstalling `v0.0.2` count as the G4 rollback. A later
   release that needs a bump must first ship a release that understands the
   gate, which becomes the rollback floor, and must give the operator a
   pre-launch path: restore the `config-schema-snapshots` copy written on the
   first superseding write, or quarantine the project.
6. **CLI.** Retarget `AutoUpdater` to the same verified manifest, or disable
   its npm path until an npm release exists. Remove the timed
   `process.exit(0)` in `useAutoUpdater.ts:111-115`. Extend the #467 collector
   with the verifier state.

The slice needs no Cask change, no `auto_updates` declaration, and no change
to the Tauri bundle. It adds one new secret pair (the manifest key and its
password), or none if the owner signs offline.

### G5 acceptance evidence (updater acceptance record)

The operator captures the following on the packaged candidate. Each item ties
to the exact DMG digest and manifest digest.

1. The previous release is installed. Detection reports `available` with the
   candidate's version and `source_sha`.
2. Running `brew upgrade --cask psyche-build` from a Cask install leaves the
   installed version, the codesign result and the Gatekeeper assessment
   matching the candidate.
3. The DMG path: the downloaded digest equals the manifest digest, which
   equals `SHA256SUMS`.
4. Negative cases, each ending in its named state with no action taken: a
   manifest with a flipped byte (`signature_invalid`), an expired manifest
   served locally (`expired`), and the network disabled (`offline`).
5. No restart or exit happens at any point unless the user requests it.
6. The post-upgrade reconciliation report and a support bundle show the
   updater state.

Steps 1 and 2 also feed the G4 two-build upgrade record. The G4 rollback is
the existing manual `v0.0.2` DMG reinstall.

## 4. Open questions for the owner

1. **Key custody.** Should the manifest key live in the protected `release`
   environment, alongside the Apple secrets, or be held offline by a named
   owner with a manual signing step? Who holds the next-slot key, and where
   is the recovery copy?
2. **Self-install.** Is self-install (option (a) for DMG installs) wanted at
   all? If it is, does that justify `auto_updates true` for every user, or
   should Cask installs stay brew-only for good?
3. **Expiry window.** Is a 30-day `expires_at` acceptable? It obliges the
   project to re-sign the manifest periodically when no release ships.
4. **CLI path.** Should the CLI update check be removed outright until npm
   publication (if ever), or retargeted to the manifest?
5. **Tap ownership.** Plan item 3.3 replaces `notify-homebrew` with a tap PR
   and a read-back check. Does the manifest's `source_sha` become the value
   that read-back checks?
