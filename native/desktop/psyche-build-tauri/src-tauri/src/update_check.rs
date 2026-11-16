//! Notify-only update check (outcome #477, item 3.2; owner decisions
//! 2026-10-03: notify only, never self-install, never restart, Cask unchanged).
//!
//! The app fetches the two signed manifest assets from the latest GitHub
//! Release, verifies them with [`crate::update_manifest`], and reports one
//! bounded [`CheckState`]. It never executes anything, never downloads a DMG,
//! and never restarts. Every failure ends in a named state and nothing else
//! happens.
//!
//! The feature is inert until a release key is provisioned: while
//! `release/update-manifest-keys.json` has `current: null`, no HTTP client is
//! constructed and the state is `disabled`.
//!
//! App-scoped state (`last_check`, `skipped_version`, `last_seen_version`,
//! the checks setting and the failure backoff) lives in `update-check.json`
//! under the app data directory, never in a project config.

use crate::update_manifest::{self, Manifest, Reason, TrustedKeys};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const MANIFEST_URL: &str =
    "https://github.com/OpenCoven/psyche-build/releases/latest/download/update-manifest.json";
pub const SIGNATURE_URL: &str =
    "https://github.com/OpenCoven/psyche-build/releases/latest/download/update-manifest.json.sig";
/// Real manifests are about 500 bytes and envelopes about 150.
pub const MAX_ASSET_BYTES: usize = 64 * 1024;
pub const CHECK_INTERVAL_SECONDS: i64 = 24 * 60 * 60;
pub const MAX_BACKOFF_SECONDS: i64 = 7 * 24 * 60 * 60;
pub const LAUNCH_DELAY: Duration = Duration::from_secs(30);
pub const SCHEDULER_TICK: Duration = Duration::from_secs(60 * 60);
pub const STATE_FILE: &str = "update-check.json";
pub const STATUS_EVENT: &str = "update:status-changed";
const STATE_SCHEMA: u32 = 1;
const MAX_STATE_FILE_BYTES: u64 = 16 * 1024;
const RELEASE_TAG_URL: &str = "https://github.com/OpenCoven/psyche-build/releases/tag/";

static EMBEDDED_KEYS: &[u8] = include_bytes!("../../../../../release/update-manifest-keys.json");

/// The only states the web UI ever sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    /// Checks are enabled but none has completed in this process yet.
    Idle,
    /// No key is provisioned, the platform publishes no update, or this is an
    /// acceptance profile. No network request is ever made.
    Disabled,
    /// The user turned checks off.
    Off,
    /// The app data directory could not be resolved, so there is nowhere to
    /// keep state; no check runs.
    Unavailable,
    Checking,
    Unreachable,
    Oversize,
    InvalidSignature,
    UnknownKey,
    NonCanonical,
    Malformed,
    NotYetValid,
    Expired,
    NotNewer,
    Available,
}

impl CheckState {
    fn from_reason(reason: Reason) -> Self {
        match reason {
            Reason::KeysMalformed | Reason::NoTrustedKeys => CheckState::Disabled,
            Reason::SignatureMalformed | Reason::SignatureInvalid => CheckState::InvalidSignature,
            Reason::UnknownKeyId => CheckState::UnknownKey,
            Reason::ManifestMalformed => CheckState::Malformed,
            Reason::ManifestNotCanonical => CheckState::NonCanonical,
            Reason::ManifestNotYetValid => CheckState::NotYetValid,
            Reason::ManifestExpired => CheckState::Expired,
        }
    }

    fn is_success(self) -> bool {
        matches!(self, CheckState::Available | CheckState::NotNewer)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    Unreachable,
    TooLarge,
}

/// Fetches one release asset, refusing bodies over `cap` bytes.
pub trait Fetch {
    fn get(
        &self,
        url: &'static str,
        cap: usize,
    ) -> impl Future<Output = Result<Vec<u8>, FetchError>> + Send;
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub state: CheckState,
    pub manifest: Option<Manifest>,
}

impl Outcome {
    fn state(state: CheckState) -> Self {
        Self {
            state,
            manifest: None,
        }
    }
}

/// One check. `make_fetcher` runs only after the key gate passes, so with no
/// current key no client is ever constructed.
pub async fn check_once<F, M>(
    keys: &TrustedKeys,
    running_version: &str,
    now_ms: i64,
    make_fetcher: M,
) -> Outcome
where
    F: Fetch,
    M: FnOnce() -> Result<F, FetchError>,
{
    if keys.current.is_none() {
        return Outcome::state(CheckState::Disabled);
    }
    let fetched = async {
        let fetcher = make_fetcher()?;
        let manifest = fetcher.get(MANIFEST_URL, MAX_ASSET_BYTES).await?;
        let signature = fetcher.get(SIGNATURE_URL, MAX_ASSET_BYTES).await?;
        // Defence in depth: never trust the fetcher alone with the bound.
        if manifest.len() > MAX_ASSET_BYTES || signature.len() > MAX_ASSET_BYTES {
            return Err(FetchError::TooLarge);
        }
        Ok((manifest, signature))
    }
    .await;
    let (manifest, signature) = match fetched {
        Ok(bytes) => bytes,
        Err(FetchError::Unreachable) => return Outcome::state(CheckState::Unreachable),
        Err(FetchError::TooLarge) => return Outcome::state(CheckState::Oversize),
    };
    match update_manifest::verify_manifest(&manifest, &signature, keys, now_ms) {
        Err(reason) => {
            log::info!("update manifest refused: {}", reason.as_str());
            Outcome::state(CheckState::from_reason(reason))
        }
        Ok(verified) => {
            log::info!(
                "update manifest verified with the {} key {}",
                verified.slot.as_str(),
                verified.key_id
            );
            let newer =
                update_manifest::is_newer_version(&verified.manifest.version, running_version);
            if newer == Some(true) {
                Outcome {
                    state: CheckState::Available,
                    manifest: Some(verified.manifest),
                }
            } else {
                Outcome::state(CheckState::NotNewer)
            }
        }
    }
}

/// Persisted app-scoped state. It is read field by field (see
/// [`Persisted::from_json`]), so one invalid or future field never discards
/// the others, in particular a user's `checks_enabled: false`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Persisted {
    pub schema: u32,
    pub checks_enabled: Option<bool>,
    pub last_check: Option<String>,
    pub last_outcome: Option<CheckState>,
    pub skipped_version: Option<String>,
    pub last_seen_version: Option<String>,
    pub consecutive_failures: u32,
}

impl Persisted {
    /// Lenient per-field reader: each field that is missing, mistyped, out of
    /// range, or an unknown enum value (for example a state written by a newer
    /// build before a downgrade) falls back to its own default.
    fn from_json(value: &serde_json::Value) -> Self {
        let text = |key: &str| value.get(key).and_then(|v| v.as_str()).map(str::to_string);
        // A missing or legacy schema reads as version 1; a newer one is kept
        // so the caller can refuse to overwrite that file.
        let schema = value
            .get("schema")
            .and_then(|v| v.as_u64())
            .filter(|schema| *schema > u64::from(STATE_SCHEMA))
            .map_or(STATE_SCHEMA, |schema| {
                schema.min(u64::from(u32::MAX)) as u32
            });
        Self {
            schema,
            checks_enabled: value.get("checks_enabled").and_then(|v| v.as_bool()),
            last_check: text("last_check"),
            last_outcome: value
                .get("last_outcome")
                .and_then(|v| serde_json::from_value(v.clone()).ok()),
            skipped_version: text("skipped_version"),
            last_seen_version: text("last_seen_version"),
            consecutive_failures: value
                .get("consecutive_failures")
                .and_then(|v| v.as_u64())
                .map_or(0, |count| count.min(16) as u32),
        }
    }

    fn sanitized(mut self) -> Self {
        self.schema = self.schema.max(STATE_SCHEMA);
        if self
            .last_check
            .as_deref()
            .and_then(update_manifest::parse_timestamp)
            .is_none()
        {
            self.last_check = None;
        }
        let version_ok = |v: &Option<String>| v.as_deref().is_some_and(is_plain_version);
        if !version_ok(&self.skipped_version) {
            self.skipped_version = None;
        }
        if !version_ok(&self.last_seen_version) {
            self.last_seen_version = None;
        }
        self.consecutive_failures = self.consecutive_failures.min(16);
        self
    }
}

/// A short semver-looking string, so a hostile file cannot inject markup or
/// unbounded text into the UI.
fn is_plain_version(value: &str) -> bool {
    value.len() <= 64
        && !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

pub fn load_state(path: &Path) -> Persisted {
    let read = || -> Option<Persisted> {
        let file = std::fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > MAX_STATE_FILE_BYTES {
            return None;
        }
        let value: serde_json::Value =
            serde_json::from_reader(std::io::Read::take(file, MAX_STATE_FILE_BYTES)).ok()?;
        value.is_object().then(|| Persisted::from_json(&value))
    };
    read().unwrap_or_default().sanitized()
}

/// Writes the state through a sibling temporary file and an atomic rename.
pub fn save_state(path: &Path, state: &Persisted) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::other("state path has no parent"))?;
    std::fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer_pretty(&mut file, state)?;
    std::io::Write::write_all(&mut file, b"\n")?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// Whether a scheduled check is due: at most once per 24 hours, doubling per
/// consecutive failure up to a week.
pub fn check_due(state: &Persisted, now_seconds: i64) -> bool {
    let Some(last) = state
        .last_check
        .as_deref()
        .and_then(update_manifest::parse_timestamp)
    else {
        return true;
    };
    let interval = CHECK_INTERVAL_SECONDS
        .saturating_mul(1i64 << state.consecutive_failures.min(8))
        .min(MAX_BACKOFF_SECONDS);
    // A clock that moved backwards must not suppress checks forever.
    now_seconds < last || now_seconds - last >= interval
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallSource {
    HomebrewCask,
    Dmg,
    Unknown,
}

/// Chooses which upgrade instructions to show; it grants nothing. A bundle at
/// `/Applications/Psyche Build.app` (or `~/Applications`) with a
/// `Caskroom/psyche-build` entry is a Cask install; a bundle there without one
/// is a DMG install; anything else (a source or bundle-folder build) is
/// unknown, and the UI then shows both instructions.
pub fn detect_install_source(
    executable: &Path,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> InstallSource {
    let Some(bundle) = executable
        .ancestors()
        .find(|path| path.extension().is_some_and(|ext| ext == "app"))
    else {
        return InstallSource::Unknown;
    };
    let mut install_roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home {
        install_roots.push(home.join("Applications"));
    }
    let installed = bundle
        .file_name()
        .is_some_and(|name| name == "Psyche Build.app")
        && install_roots
            .iter()
            .any(|root| bundle.parent() == Some(root.as_path()));
    if !installed {
        return InstallSource::Unknown;
    }
    let cask = [
        "/opt/homebrew/Caskroom/psyche-build",
        "/usr/local/Caskroom/psyche-build",
    ]
    .iter()
    .any(|path| exists(Path::new(path)));
    if cask {
        InstallSource::HomebrewCask
    } else {
        InstallSource::Dmg
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AvailableView {
    pub version: String,
    pub tag: String,
    pub release_url: String,
    pub arch: Option<&'static str>,
    pub dmg_file: Option<String>,
    pub dmg_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct UpdateStatusView {
    pub state: CheckState,
    pub running_version: String,
    /// A key is provisioned and this platform can check.
    pub checks_supported: bool,
    pub checks_enabled: bool,
    pub last_check: Option<String>,
    /// The result of the most recent check, which can differ from `state`
    /// when a later check failed after an update was verified.
    pub last_outcome: Option<CheckState>,
    pub install_source: InstallSource,
    pub skipped: bool,
    pub dismissed: bool,
    pub available: Option<AvailableView>,
    /// The previous `last_seen_version` when this launch is the first of a new
    /// version. Project-config reconciliation is out of scope (#464 gate).
    pub upgraded_from: Option<String>,
    pub storage: Storage,
}

/// Whether the app-scoped state file can be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Storage {
    /// `initialize` has not run (for example, the acceptance profile).
    NotLoaded,
    Ok,
    /// The file was written by a newer build. It is read but never rewritten,
    /// so downgrading cannot destroy the newer build's state.
    NewerSchema,
    /// No app data directory could be resolved.
    Unavailable,
}

struct Inner {
    persisted: Persisted,
    state: CheckState,
    available: Option<Manifest>,
    /// The version the user dismissed in this session. The banner stays
    /// hidden for exactly that version and reappears for a different one.
    dismissed_version: Option<String>,
    in_flight: bool,
    storage: Storage,
}

/// Tauri-managed update-check state.
pub struct UpdateCheck {
    keys: TrustedKeys,
    supported: bool,
    running_version: String,
    install_source: InstallSource,
    path: OnceLock<PathBuf>,
    upgraded_from: OnceLock<Option<String>>,
    inner: parking_lot::Mutex<Inner>,
}

impl UpdateCheck {
    pub fn new(
        keys: TrustedKeys,
        supported: bool,
        running_version: String,
        install_source: InstallSource,
    ) -> Self {
        let supported = supported && keys.current.is_some();
        Self {
            keys,
            supported,
            running_version,
            install_source,
            path: OnceLock::new(),
            upgraded_from: OnceLock::new(),
            inner: parking_lot::Mutex::new(Inner {
                persisted: Persisted::default().sanitized(),
                state: if supported {
                    CheckState::Idle
                } else {
                    CheckState::Disabled
                },
                available: None,
                dismissed_version: None,
                in_flight: false,
                storage: Storage::NotLoaded,
            }),
        }
    }

    /// The production configuration: embedded keys, macOS only, no checks in
    /// an acceptance profile. A malformed embedded keys file is inert too.
    pub fn from_startup() -> Self {
        let keys = update_manifest::parse_keys_file(EMBEDDED_KEYS).unwrap_or(TrustedKeys {
            current: None,
            next: None,
        });
        let supported = cfg!(target_os = "macos") && !crate::acceptance::active();
        let home = crate::platform::home_directory().map(PathBuf::from);
        let install_source = std::env::current_exe()
            .map(|exe| detect_install_source(&exe, home.as_deref(), |path| path.is_dir()))
            .unwrap_or(InstallSource::Unknown);
        Self::new(
            keys,
            supported,
            env!("CARGO_PKG_VERSION").to_string(),
            install_source,
        )
    }

    fn checks_enabled(&self, persisted: &Persisted) -> bool {
        self.supported && persisted.checks_enabled.unwrap_or(true)
    }

    /// Loads persisted state and records the running version (post-upgrade
    /// step). Call once, with the app data directory.
    pub fn initialize(&self, directory: PathBuf) {
        let path = directory.join(STATE_FILE);
        let mut persisted = load_state(&path);
        let storage = if persisted.schema > STATE_SCHEMA {
            log::warn!("update check state has a newer schema; it is read but left unchanged");
            Storage::NewerSchema
        } else {
            Storage::Ok
        };
        // Only a move to a strictly newer version is an upgrade; a downgrade
        // or a reinstall of the same version reports nothing. A prerelease
        // running build is never reported as an upgrade.
        let upgraded_from = persisted
            .last_seen_version
            .clone()
            .filter(|seen| {
                update_manifest::is_newer_version(&self.running_version, seen) == Some(true)
            })
            .filter(|_| storage == Storage::Ok);
        let first_launch_of_version =
            persisted.last_seen_version.as_deref() != Some(&self.running_version);
        if first_launch_of_version && storage == Storage::Ok {
            persisted.last_seen_version = Some(self.running_version.clone());
            if let Err(error) = save_state(&path, &persisted) {
                log::warn!("update check state not saved: {}", error.kind());
            }
        }
        let _ = self.upgraded_from.set(upgraded_from);
        let mut inner = self.inner.lock();
        if !self.checks_enabled(&persisted) {
            inner.state = if self.supported {
                CheckState::Off
            } else {
                CheckState::Disabled
            };
        }
        inner.persisted = persisted;
        inner.storage = storage;
        drop(inner);
        let _ = self.path.set(path);
    }

    /// Records that no app data directory exists: no state, no checks, and
    /// `update_status` reports `unavailable`.
    pub fn mark_unavailable(&self) {
        let mut inner = self.inner.lock();
        inner.storage = Storage::Unavailable;
        inner.state = if self.supported {
            CheckState::Unavailable
        } else {
            CheckState::Disabled
        };
    }

    /// Writes a user's choice. Errors are bounded and returned to the
    /// command, so the UI never reports a choice that was not saved.
    fn persist(&self, storage: Storage, persisted: &Persisted) -> Result<(), String> {
        match storage {
            Storage::Ok => {}
            Storage::NewerSchema => {
                return Err(
                    "update preferences were saved by a newer Psyche Build and are left unchanged"
                        .into(),
                )
            }
            Storage::NotLoaded | Storage::Unavailable => {
                return Err("update preferences cannot be saved".into())
            }
        }
        let path = self
            .path
            .get()
            .ok_or("update preferences cannot be saved")?;
        save_state(path, persisted)
            .map_err(|error| format!("update preference not saved: {}", error.kind()))
    }

    /// Background bookkeeping (check results): failures are only logged.
    fn save_in_background(&self, storage: Storage, persisted: &Persisted) {
        if storage != Storage::Ok {
            return;
        }
        if let Err(error) = self.persist(storage, persisted) {
            log::warn!("{error}");
        }
    }

    pub fn status(&self) -> UpdateStatusView {
        let inner = self.inner.lock();
        let arch = update_manifest::ARCHITECTURES
            .into_iter()
            .find(|arch| *arch == std::env::consts::ARCH);
        let available = inner
            .available
            .as_ref()
            .filter(|_| inner.state == CheckState::Available)
            .map(|manifest| {
                let artifact = arch.and_then(|arch| manifest.artifact(arch));
                AvailableView {
                    version: manifest.version.clone(),
                    tag: manifest.tag.clone(),
                    // The tag is validated as `v<MAJOR.MINOR.PATCH>`, so it is URL-safe.
                    release_url: format!("{RELEASE_TAG_URL}{}", manifest.tag),
                    arch,
                    dmg_file: artifact.map(|artifact| artifact.file.clone()),
                    dmg_sha256: artifact.map(|artifact| artifact.sha256.clone()),
                }
            });
        UpdateStatusView {
            state: inner.state,
            running_version: self.running_version.clone(),
            checks_supported: self.supported,
            checks_enabled: self.checks_enabled(&inner.persisted),
            last_check: inner.persisted.last_check.clone(),
            last_outcome: inner.persisted.last_outcome,
            install_source: self.install_source,
            skipped: available.as_ref().is_some_and(|view| {
                inner.persisted.skipped_version.as_deref() == Some(view.version.as_str())
            }),
            dismissed: available.as_ref().is_some_and(|view| {
                inner.dismissed_version.as_deref() == Some(view.version.as_str())
            }),
            storage: inner.storage,
            available,
            upgraded_from: self.upgraded_from.get().cloned().flatten(),
        }
    }

    /// Claims the next check if one is due. Returns false when checks are off,
    /// unsupported, already running, or not yet due.
    fn begin_check(&self, now_seconds: i64, force: bool) -> bool {
        let mut inner = self.inner.lock();
        if self.path.get().is_none() || inner.in_flight || !self.checks_enabled(&inner.persisted) {
            return false;
        }
        if !force && !check_due(&inner.persisted, now_seconds) {
            return false;
        }
        inner.in_flight = true;
        inner.state = CheckState::Checking;
        true
    }

    fn finish_check(&self, outcome: Outcome, now_seconds: i64) {
        let mut inner = self.inner.lock();
        inner.in_flight = false;
        inner.persisted.last_check = Some(update_manifest::format_timestamp(now_seconds));
        inner.persisted.last_outcome = Some(outcome.state);
        inner.persisted.consecutive_failures = if outcome.state.is_success() {
            0
        } else {
            inner
                .persisted
                .consecutive_failures
                .saturating_add(1)
                .min(16)
        };
        if outcome.state.is_success() {
            // Only an offer of a different version clears a dismissal; a
            // not_newer result or a re-offer of the same version keeps it.
            let offered = outcome.manifest.as_ref().map(|m| m.version.as_str());
            if offered.is_some() && offered != inner.dismissed_version.as_deref() {
                inner.dismissed_version = None;
            }
            inner.available = outcome.manifest;
        } else {
            // A failed check (offline, refused manifest, ...) neither withdraws
            // an update this session already verified nor forgets its
            // dismissal, unless that manifest has since expired.
            let still_valid = inner.available.as_ref().is_some_and(|manifest| {
                update_manifest::parse_timestamp(&manifest.expires_at)
                    .is_some_and(|expires| now_seconds < expires)
            });
            if !still_valid {
                inner.available = None;
            }
        }
        let shown = if inner.available.is_some() {
            CheckState::Available
        } else {
            outcome.state
        };
        // Turning checks off while one ran keeps the user's choice visible.
        inner.state = if self.checks_enabled(&inner.persisted) {
            shown
        } else {
            CheckState::Off
        };
        let (storage, persisted) = (inner.storage, inner.persisted.clone());
        drop(inner);
        self.save_in_background(storage, &persisted);
    }

    /// Records "Skip this version" for exactly the version on offer.
    pub fn skip_version(&self, version: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        let offered = inner.available.as_ref().map(|m| m.version.as_str());
        if inner.state != CheckState::Available || offered != Some(version) {
            return Err("only the version currently on offer can be skipped".into());
        }
        let mut next = inner.persisted.clone();
        next.skipped_version = Some(version.to_string());
        self.persist(inner.storage, &next)?;
        inner.persisted = next;
        Ok(())
    }

    /// Hides the banner until the next launch or a different version.
    pub fn dismiss(&self) {
        let mut inner = self.inner.lock();
        inner.dismissed_version = inner.available.as_ref().map(|m| m.version.clone());
    }

    pub fn set_checks_enabled(&self, enabled: bool) -> Result<(), String> {
        if !self.supported {
            return Err("update checks are unavailable in this build".into());
        }
        let mut inner = self.inner.lock();
        let mut next = inner.persisted.clone();
        next.checks_enabled = Some(enabled);
        // Nothing changes unless the choice was saved.
        self.persist(inner.storage, &next)?;
        inner.persisted = next;
        if !enabled {
            inner.state = CheckState::Off;
            inner.available = None;
        } else if inner.state == CheckState::Off {
            inner.state = CheckState::Idle;
        }
        Ok(())
    }

    /// Runs one check through `make_fetcher` if due. Returns whether it ran.
    pub async fn run_if_due<F, M>(&self, now_ms: i64, make_fetcher: M) -> bool
    where
        F: Fetch,
        M: FnOnce() -> Result<F, FetchError>,
    {
        let now_seconds = now_ms.div_euclid(1000);
        if !self.begin_check(now_seconds, false) {
            return false;
        }
        let outcome = check_once(&self.keys, &self.running_version, now_ms, make_fetcher).await;
        self.finish_check(outcome, now_seconds);
        true
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
mod http {
    use super::{Fetch, FetchError};
    use std::time::Duration;

    pub struct HttpFetcher {
        client: reqwest::Client,
    }

    impl HttpFetcher {
        pub fn new(running_version: &str) -> Result<Self, FetchError> {
            let client = reqwest::Client::builder()
                .https_only(true)
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                // releases/latest/download redirects twice to the asset host.
                .redirect(reqwest::redirect::Policy::limited(5))
                .user_agent(format!("PsycheBuild/{running_version} update-check"))
                .build()
                .map_err(|_| FetchError::Unreachable)?;
            Ok(Self { client })
        }
    }

    impl Fetch for HttpFetcher {
        async fn get(&self, url: &'static str, cap: usize) -> Result<Vec<u8>, FetchError> {
            let mut response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|_| FetchError::Unreachable)?;
            if !response.status().is_success() {
                return Err(FetchError::Unreachable);
            }
            if response
                .content_length()
                .is_some_and(|length| length > cap as u64)
            {
                return Err(FetchError::TooLarge);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| FetchError::Unreachable)?
            {
                if body.len() + chunk.len() > cap {
                    return Err(FetchError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        }
    }
}

/// A fetcher for platforms that publish no update. Never constructed in
/// practice because `supported` is false there.
#[cfg(not(target_os = "macos"))]
mod http {
    use super::{Fetch, FetchError};

    pub struct HttpFetcher;

    impl HttpFetcher {
        pub fn new(_running_version: &str) -> Result<Self, FetchError> {
            Err(FetchError::Unreachable)
        }
    }

    impl Fetch for HttpFetcher {
        async fn get(&self, _url: &'static str, _cap: usize) -> Result<Vec<u8>, FetchError> {
            Err(FetchError::Unreachable)
        }
    }
}

/// Starts the scheduler: first check shortly after launch, then re-evaluated
/// hourly against the 24-hour interval and failure backoff.
pub fn spawn_scheduler(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LAUNCH_DELAY).await;
        loop {
            let state = app.state::<UpdateCheck>();
            let running = state.running_version.clone();
            if state
                .run_if_due(now_ms(), || http::HttpFetcher::new(&running))
                .await
            {
                let _ = app.emit_to("main", STATUS_EVENT, ());
            }
            tokio::time::sleep(SCHEDULER_TICK).await;
        }
    });
}

fn ensure_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(format!(
            "update status is only available to trusted webview 'main'; rejected caller '{label}'"
        ))
    }
}

#[tauri::command]
pub(crate) fn update_status(
    webview: tauri::Webview,
    state: tauri::State<'_, UpdateCheck>,
) -> Result<UpdateStatusView, String> {
    ensure_main(webview.label())?;
    Ok(state.status())
}

#[tauri::command]
pub(crate) fn update_skip_version(
    webview: tauri::Webview,
    state: tauri::State<'_, UpdateCheck>,
    version: String,
) -> Result<UpdateStatusView, String> {
    ensure_main(webview.label())?;
    state.skip_version(&version)?;
    Ok(state.status())
}

#[tauri::command]
pub(crate) fn update_dismiss(
    webview: tauri::Webview,
    state: tauri::State<'_, UpdateCheck>,
) -> Result<UpdateStatusView, String> {
    ensure_main(webview.label())?;
    state.dismiss();
    Ok(state.status())
}

#[tauri::command]
pub(crate) fn update_set_checks_enabled(
    webview: tauri::Webview,
    state: tauri::State<'_, UpdateCheck>,
    enabled: bool,
) -> Result<UpdateStatusView, String> {
    ensure_main(webview.label())?;
    state.set_checks_enabled(enabled)?;
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use serde_json::Value;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const VECTORS: &str = include_str!("../test-fixtures/update-manifest/vectors.json");

    struct Vectors {
        keys: TrustedKeys,
        all: Value,
    }

    fn vectors() -> Vectors {
        let all: Value = serde_json::from_str(VECTORS).unwrap();
        let keys = update_manifest::parse_keys_file(all["keys"].to_string().as_bytes()).unwrap();
        Vectors { keys, all }
    }

    impl Vectors {
        fn case(&self, name: &str) -> (Vec<u8>, Vec<u8>, i64) {
            let case = self.all["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["name"] == name)
                .unwrap();
            let decode = |v: &Value| {
                base64::engine::general_purpose::STANDARD
                    .decode(v.as_str().unwrap())
                    .unwrap()
            };
            let now =
                update_manifest::parse_timestamp(case["now"].as_str().unwrap()).unwrap() * 1000;
            (
                decode(&case["manifest_base64"]),
                decode(&case["signature_base64"]),
                now,
            )
        }
    }

    struct Fake {
        manifest: Result<Vec<u8>, FetchError>,
        signature: Result<Vec<u8>, FetchError>,
        calls: AtomicUsize,
    }

    impl Fake {
        fn serving(manifest: Vec<u8>, signature: Vec<u8>) -> Self {
            Self {
                manifest: Ok(manifest),
                signature: Ok(signature),
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl Fetch for &Fake {
        async fn get(&self, url: &'static str, cap: usize) -> Result<Vec<u8>, FetchError> {
            assert_eq!(cap, MAX_ASSET_BYTES);
            self.calls.fetch_add(1, Ordering::SeqCst);
            match url {
                MANIFEST_URL => self.manifest.clone(),
                SIGNATURE_URL => self.signature.clone(),
                _ => panic!("unexpected url {url}"),
            }
        }
    }

    async fn run(keys: &TrustedKeys, fake: &Fake, running: &str, now: i64) -> CheckState {
        check_once(keys, running, now, || Ok::<_, FetchError>(fake))
            .await
            .state
    }

    #[tokio::test]
    async fn inert_without_a_current_key_never_constructs_a_client() {
        let constructed = AtomicUsize::new(0);
        let keys = update_manifest::parse_keys_file(EMBEDDED_KEYS).unwrap();
        let none = TrustedKeys {
            current: None,
            next: None,
        };
        for keys in [&keys, &none] {
            if keys.current.is_some() {
                continue; // a provisioned key makes this case inapplicable
            }
            let outcome = check_once(keys, "0.0.1", 0, || {
                constructed.fetch_add(1, Ordering::SeqCst);
                Err::<&Fake, _>(FetchError::Unreachable)
            })
            .await;
            assert_eq!(outcome.state, CheckState::Disabled);
        }
        assert_eq!(constructed.load(Ordering::SeqCst), 0);
        // The managed state is disabled and never claims a check either.
        let check = UpdateCheck::new(none, true, "0.0.1".into(), InstallSource::Unknown);
        let dir = tempfile::tempdir().unwrap();
        check.initialize(dir.path().to_path_buf());
        assert_eq!(check.status().state, CheckState::Disabled);
        assert!(!check.status().checks_supported);
        let ran = check
            .run_if_due(0, || {
                constructed.fetch_add(1, Ordering::SeqCst);
                Err::<&Fake, _>(FetchError::Unreachable)
            })
            .await;
        assert!(!ran);
        assert_eq!(constructed.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn verified_outcomes_map_to_bounded_states() {
        let v = vectors();
        let (manifest, signature, now) = v.case("valid_current_key");
        let fake = Fake::serving(manifest.clone(), signature.clone());
        assert_eq!(
            run(&v.keys, &fake, "0.0.2", now).await,
            CheckState::Available
        );
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            run(&v.keys, &fake, "9.8.7", now).await,
            CheckState::NotNewer
        );
        assert_eq!(
            run(&v.keys, &fake, "10.0.0", now).await,
            CheckState::NotNewer
        );
        assert_eq!(
            run(&v.keys, &fake, "9.8.7-dev", now).await,
            CheckState::Available
        );
        let expired = update_manifest::parse_timestamp("2026-10-01T00:00:00Z").unwrap() * 1000;
        assert_eq!(
            run(&v.keys, &fake, "0.0.2", expired).await,
            CheckState::Expired
        );
        let future = update_manifest::parse_timestamp("2026-08-31T23:54:59Z").unwrap() * 1000;
        assert_eq!(
            run(&v.keys, &fake, "0.0.2", future).await,
            CheckState::NotYetValid
        );

        let (m, s, now) = v.case("valid_next_key");
        assert_eq!(
            run(&v.keys, &Fake::serving(m, s), "0.0.2", now).await,
            CheckState::Available
        );
        for (name, state) in [
            ("tampered_manifest", CheckState::InvalidSignature),
            ("tampered_signature", CheckState::InvalidSignature),
            ("wrong_key_claims_current_id", CheckState::InvalidSignature),
            (
                "signature_envelope_not_canonical",
                CheckState::InvalidSignature,
            ),
            ("unknown_key_id", CheckState::UnknownKey),
            ("manifest_pretty_printed", CheckState::NonCanonical),
            ("manifest_tag_mismatch", CheckState::Malformed),
        ] {
            let (m, s, now) = v.case(name);
            assert_eq!(
                run(&v.keys, &Fake::serving(m, s), "0.0.2", now).await,
                state,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn network_failures_and_oversize_are_named() {
        let v = vectors();
        let (manifest, signature, now) = v.case("valid_current_key");
        let offline = Fake {
            manifest: Err(FetchError::Unreachable),
            signature: Ok(signature.clone()),
            calls: AtomicUsize::new(0),
        };
        assert_eq!(
            run(&v.keys, &offline, "0.0.2", now).await,
            CheckState::Unreachable
        );
        assert_eq!(
            offline.calls.load(Ordering::SeqCst),
            1,
            "stops after the first failure"
        );
        let refused = Fake {
            manifest: Err(FetchError::TooLarge),
            signature: Ok(signature.clone()),
            calls: AtomicUsize::new(0),
        };
        assert_eq!(
            run(&v.keys, &refused, "0.0.2", now).await,
            CheckState::Oversize
        );
        // A fetcher that ignored the cap is still refused before verification.
        let mut padded = manifest.clone();
        padded.resize(MAX_ASSET_BYTES + 1, b' ');
        assert_eq!(
            run(
                &v.keys,
                &Fake::serving(padded, signature.clone()),
                "0.0.2",
                now
            )
            .await,
            CheckState::Oversize
        );
        let no_client = check_once(&v.keys, "0.0.2", now, || {
            Err::<&Fake, _>(FetchError::Unreachable)
        })
        .await;
        assert_eq!(no_client.state, CheckState::Unreachable);
    }

    #[test]
    fn schedule_is_daily_with_failure_backoff() {
        let day = CHECK_INTERVAL_SECONDS;
        let at = |seconds: i64| update_manifest::format_timestamp(seconds);
        let mut state = Persisted::default();
        assert!(check_due(&state, 0));
        state.last_check = Some(at(10 * day));
        assert!(!check_due(&state, 11 * day - 1));
        assert!(check_due(&state, 11 * day));
        state.consecutive_failures = 1;
        assert!(!check_due(&state, 12 * day - 1));
        assert!(check_due(&state, 12 * day));
        state.consecutive_failures = 9;
        assert!(!check_due(&state, 17 * day - 1));
        assert!(check_due(&state, 17 * day));
        assert!(
            check_due(&state, 9 * day),
            "a clock moved backwards does not suppress checks"
        );
    }

    #[tokio::test]
    async fn persisted_state_round_trips_and_records_skip_and_failures() {
        let v = vectors();
        let (manifest, signature, now) = v.case("valid_current_key");
        let dir = tempfile::tempdir().unwrap();
        let check = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Dmg);
        check.initialize(dir.path().to_path_buf());
        assert_eq!(check.status().state, CheckState::Idle);
        let fake = Fake::serving(manifest, signature);
        assert!(check.run_if_due(now, || Ok::<_, FetchError>(&fake)).await);
        assert!(
            !check
                .run_if_due(now + 1000, || Ok::<_, FetchError>(&fake))
                .await,
            "not due again"
        );
        let status = check.status();
        assert_eq!(status.state, CheckState::Available);
        let available = status.available.clone().unwrap();
        assert_eq!(available.version, "9.8.7");
        assert_eq!(
            available.release_url,
            "https://github.com/OpenCoven/psyche-build/releases/tag/v9.8.7"
        );
        assert!(check.skip_version("9.8.6").is_err());
        check.skip_version("9.8.7").unwrap();
        assert!(check.status().skipped);
        check.dismiss();
        assert!(check.status().dismissed);

        let saved = load_state(&dir.path().join(STATE_FILE));
        assert_eq!(saved.skipped_version.as_deref(), Some("9.8.7"));
        assert_eq!(saved.last_seen_version.as_deref(), Some("0.0.2"));
        assert_eq!(saved.last_outcome, Some(CheckState::Available));
        assert_eq!(
            saved.last_check,
            Some(update_manifest::format_timestamp(now / 1000))
        );
        assert_eq!(saved.consecutive_failures, 0);

        // A restart keeps the skip and the schedule; a failure backs off.
        let again = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Dmg);
        again.initialize(dir.path().to_path_buf());
        assert_eq!(again.status().upgraded_from, None);
        let offline = Fake {
            manifest: Err(FetchError::Unreachable),
            signature: Err(FetchError::Unreachable),
            calls: AtomicUsize::new(0),
        };
        let next_day = now + CHECK_INTERVAL_SECONDS * 1000;
        assert!(
            again
                .run_if_due(next_day, || Ok::<_, FetchError>(&offline))
                .await
        );
        assert_eq!(again.status().state, CheckState::Unreachable);
        assert_eq!(
            load_state(&dir.path().join(STATE_FILE)).consecutive_failures,
            1
        );
        assert!(
            !again
                .run_if_due(next_day + CHECK_INTERVAL_SECONDS * 1000 + 1000, || Ok::<
                    _,
                    FetchError,
                >(
                    &offline
                ))
                .await
        );
    }

    #[tokio::test]
    async fn checks_can_be_turned_off_and_stay_off() {
        let v = vectors();
        let dir = tempfile::tempdir().unwrap();
        let check = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        check.set_checks_enabled(false).unwrap();
        assert_eq!(check.status().state, CheckState::Off);
        let constructed = AtomicUsize::new(0);
        assert!(
            !check
                .run_if_due(0, || {
                    constructed.fetch_add(1, Ordering::SeqCst);
                    Err::<&Fake, _>(FetchError::Unreachable)
                })
                .await
        );
        assert_eq!(constructed.load(Ordering::SeqCst), 0);
        let restarted =
            UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Unknown);
        restarted.initialize(dir.path().to_path_buf());
        assert_eq!(restarted.status().state, CheckState::Off);
        assert!(!restarted.status().checks_enabled);
        restarted.set_checks_enabled(true).unwrap();
        assert_eq!(restarted.status().state, CheckState::Idle);
        let unsupported = UpdateCheck::new(
            TrustedKeys {
                current: None,
                next: None,
            },
            true,
            "0.0.2".into(),
            InstallSource::Unknown,
        );
        assert!(unsupported.set_checks_enabled(true).is_err());
    }

    #[test]
    fn first_launch_of_a_new_version_records_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        save_state(
            &path,
            &Persisted {
                last_seen_version: Some("0.0.2".into()),
                ..Persisted::default()
            },
        )
        .unwrap();
        let none = || TrustedKeys {
            current: None,
            next: None,
        };
        let check = UpdateCheck::new(none(), false, "0.0.3".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        assert_eq!(check.status().upgraded_from.as_deref(), Some("0.0.2"));
        assert_eq!(
            load_state(&path).last_seen_version.as_deref(),
            Some("0.0.3")
        );
        let relaunch = UpdateCheck::new(none(), false, "0.0.3".into(), InstallSource::Unknown);
        relaunch.initialize(dir.path().to_path_buf());
        assert_eq!(relaunch.status().upgraded_from, None);
    }

    #[test]
    fn corrupt_or_hostile_state_files_load_as_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load_state(&path), Persisted::default().sanitized());
        std::fs::write(&path, br#"{"skipped_version":"<img src=x>","last_check":"yesterday","last_seen_version":"0.0.2","consecutive_failures":999}"#).unwrap();
        let loaded = load_state(&path);
        assert_eq!(loaded.skipped_version, None);
        assert_eq!(loaded.last_check, None);
        assert_eq!(loaded.last_seen_version.as_deref(), Some("0.0.2"));
        assert_eq!(loaded.consecutive_failures, 16);
        std::fs::write(&path, vec![b' '; (MAX_STATE_FILE_BYTES + 1) as usize]).unwrap();
        assert_eq!(load_state(&path), Persisted::default().sanitized());
    }

    #[test]
    fn one_invalid_field_never_discards_a_valid_checks_setting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        let load = |text: &str| {
            std::fs::write(&path, text).unwrap();
            load_state(&path)
        };
        let future = load(r#"{"checks_enabled":false,"last_outcome":"future_state"}"#);
        assert_eq!(future.checks_enabled, Some(false));
        assert_eq!(future.last_outcome, None);
        let negative = load(
            r#"{"checks_enabled":false,"consecutive_failures":-1,"last_seen_version":"0.0.2"}"#,
        );
        assert_eq!(negative.checks_enabled, Some(false));
        assert_eq!(negative.consecutive_failures, 0);
        assert_eq!(negative.last_seen_version.as_deref(), Some("0.0.2"));
        let mistyped = load(
            r#"{"checks_enabled":"no","skipped_version":"1.2.3","schema":"x","last_check":7}"#,
        );
        assert_eq!(mistyped.checks_enabled, None);
        assert_eq!(mistyped.skipped_version.as_deref(), Some("1.2.3"));
        assert_eq!(mistyped.last_check, None);
        let known =
            load(r#"{"checks_enabled":false,"last_outcome":"not_newer","future_field":{"a":1}}"#);
        assert_eq!(known.checks_enabled, Some(false));
        assert_eq!(known.last_outcome, Some(CheckState::NotNewer));
        assert_eq!(load("[]"), Persisted::default().sanitized());
        // The setting survives into the running state too.
        load(r#"{"checks_enabled":false,"last_outcome":"future_state"}"#);
        let check = UpdateCheck::new(vectors().keys, true, "0.0.2".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        assert_eq!(check.status().state, CheckState::Off);
    }

    #[tokio::test]
    async fn a_failed_check_keeps_a_verified_update_and_its_dismissal() {
        let v = vectors();
        let (manifest, signature, now) = v.case("valid_current_key");
        let dir = tempfile::tempdir().unwrap();
        let check = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Dmg);
        check.initialize(dir.path().to_path_buf());
        let fake = Fake::serving(manifest, signature);
        assert!(check.run_if_due(now, || Ok::<_, FetchError>(&fake)).await);
        check.dismiss();
        let offline = Fake {
            manifest: Err(FetchError::Unreachable),
            signature: Err(FetchError::Unreachable),
            calls: AtomicUsize::new(0),
        };
        let day_ms = CHECK_INTERVAL_SECONDS * 1000;
        assert!(
            check
                .run_if_due(now + day_ms, || Ok::<_, FetchError>(&offline))
                .await
        );
        let status = check.status();
        assert_eq!(status.state, CheckState::Available);
        assert_eq!(status.last_outcome, Some(CheckState::Unreachable));
        assert!(status.dismissed, "the dismissal survives a failed check");
        assert_eq!(status.available.unwrap().version, "9.8.7");
        // Once the retained manifest has expired, a failure withdraws it.
        let after_expiry = update_manifest::parse_timestamp("2026-10-02T00:00:00Z").unwrap() * 1000;
        assert!(
            check
                .run_if_due(after_expiry, || Ok::<_, FetchError>(&offline))
                .await
        );
        assert_eq!(check.status().state, CheckState::Unreachable);
        assert!(check.status().available.is_none());
    }

    #[test]
    fn a_downgrade_is_not_reported_as_an_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        save_state(
            &path,
            &Persisted {
                last_seen_version: Some("0.0.3".into()),
                ..Persisted::default()
            },
        )
        .unwrap();
        let check = UpdateCheck::new(
            TrustedKeys {
                current: None,
                next: None,
            },
            false,
            "0.0.2".into(),
            InstallSource::Unknown,
        );
        check.initialize(dir.path().to_path_buf());
        assert_eq!(check.status().upgraded_from, None);
        assert_eq!(
            load_state(&path).last_seen_version.as_deref(),
            Some("0.0.2")
        );
    }

    #[tokio::test]
    async fn a_missing_app_data_directory_is_reported_and_runs_nothing() {
        let check = UpdateCheck::new(vectors().keys, true, "0.0.2".into(), InstallSource::Unknown);
        check.mark_unavailable();
        let status = check.status();
        assert_eq!(status.state, CheckState::Unavailable);
        assert_eq!(status.storage, Storage::Unavailable);
        let constructed = AtomicUsize::new(0);
        let ran = check
            .run_if_due(0, || {
                constructed.fetch_add(1, Ordering::SeqCst);
                Err::<&Fake, _>(FetchError::Unreachable)
            })
            .await;
        assert!(!ran);
        assert_eq!(constructed.load(Ordering::SeqCst), 0);
        assert!(
            check.set_checks_enabled(false).is_err(),
            "an unsaved choice is not reported as saved"
        );
        let unsupported = UpdateCheck::new(
            TrustedKeys {
                current: None,
                next: None,
            },
            true,
            "0.0.2".into(),
            InstallSource::Unknown,
        );
        unsupported.mark_unavailable();
        assert_eq!(unsupported.status().state, CheckState::Disabled);
    }

    #[tokio::test]
    async fn a_newer_schema_file_is_read_but_never_rewritten() {
        let v = vectors();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_FILE);
        let newer = br#"{"schema":2,"checks_enabled":false,"skipped_version":"1.0.0","last_seen_version":"0.0.9","future":{"x":1}}"#;
        std::fs::write(&path, newer).unwrap();
        let check = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        let status = check.status();
        assert_eq!(status.storage, Storage::NewerSchema);
        assert_eq!(
            status.state,
            CheckState::Off,
            "the newer file's checks-off choice is honoured"
        );
        assert_eq!(status.upgraded_from, None);
        assert!(check.set_checks_enabled(true).is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            newer,
            "the newer file is untouched"
        );

        // With checks on, a check runs in memory and still leaves the file alone.
        let enabled = br#"{"schema":3,"checks_enabled":true}"#;
        std::fs::write(&path, enabled).unwrap();
        let check = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        let (manifest, signature, now) = v.case("valid_current_key");
        let fake = Fake::serving(manifest, signature);
        assert!(check.run_if_due(now, || Ok::<_, FetchError>(&fake)).await);
        assert_eq!(check.status().state, CheckState::Available);
        assert!(check.skip_version("9.8.7").is_err());
        assert!(!check.status().skipped);
        assert_eq!(std::fs::read(&path).unwrap(), enabled);

        // A missing or legacy schema loads as version 1 and is upgraded.
        std::fs::write(&path, br#"{"checks_enabled":false}"#).unwrap();
        let legacy = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Unknown);
        legacy.initialize(dir.path().to_path_buf());
        assert_eq!(legacy.status().storage, Storage::Ok);
        assert_eq!(legacy.status().state, CheckState::Off);
        let rewritten: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(rewritten["schema"], 1);
        assert_eq!(rewritten["checks_enabled"], false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn user_choices_report_a_failed_save_and_change_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let v = vectors();
        let dir = tempfile::tempdir().unwrap();
        let check = UpdateCheck::new(v.keys.clone(), true, "0.0.2".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        let (manifest, signature, now) = v.case("valid_current_key");
        let fake = Fake::serving(manifest, signature);
        assert!(check.run_if_due(now, || Ok::<_, FetchError>(&fake)).await);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let skip = check.skip_version("9.8.7");
        let toggle = check.set_checks_enabled(false);
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let error = skip.unwrap_err();
        assert!(
            error.starts_with("update preference not saved: "),
            "{error}"
        );
        assert!(
            !error.contains(dir.path().to_str().unwrap()),
            "no path in the error"
        );
        assert!(toggle.is_err());
        let status = check.status();
        assert!(!status.skipped);
        assert!(status.checks_enabled);
        assert_eq!(status.state, CheckState::Available);
        // Once the directory is writable again the same choices succeed.
        check.skip_version("9.8.7").unwrap();
        assert!(check.status().skipped);
    }

    #[test]
    fn a_dismissal_lasts_for_its_version_only() {
        let v = vectors();
        let (manifest, _, now) = v.case("valid_current_key");
        let keys = v.keys.clone();
        let parsed =
            update_manifest::verify_manifest(&manifest, &v.case("valid_current_key").1, &keys, now)
                .unwrap()
                .manifest;
        let dir = tempfile::tempdir().unwrap();
        let check = UpdateCheck::new(keys, true, "0.0.2".into(), InstallSource::Unknown);
        check.initialize(dir.path().to_path_buf());
        let seconds = now / 1000;
        let offer = |m: &Manifest| Outcome {
            state: CheckState::Available,
            manifest: Some(m.clone()),
        };
        check.finish_check(offer(&parsed), seconds);
        check.dismiss();
        assert!(check.status().dismissed);
        // not_newer withdraws the offer but not the dismissal of 9.8.7.
        check.finish_check(Outcome::state(CheckState::NotNewer), seconds + 1);
        assert!(check.status().available.is_none());
        check.finish_check(offer(&parsed), seconds + 2);
        assert!(check.status().dismissed, "the same version stays dismissed");
        let mut newer = parsed.clone();
        newer.version = "9.8.8".into();
        newer.tag = "v9.8.8".into();
        check.finish_check(offer(&newer), seconds + 3);
        assert!(
            !check.status().dismissed,
            "a different version is shown again"
        );
        check.finish_check(offer(&parsed), seconds + 4);
        assert!(!check.status().dismissed, "the old dismissal was cleared");
    }

    #[test]
    fn install_source_detection_only_picks_instructions() {
        let home = Path::new("/Users/someone");
        let exe = |path: &str| PathBuf::from(path);
        let cask = |path: &Path| path == Path::new("/opt/homebrew/Caskroom/psyche-build");
        let none = |_: &Path| false;
        let installed = exe("/Applications/Psyche Build.app/Contents/MacOS/psyche-build-tauri");
        assert_eq!(
            detect_install_source(&installed, Some(home), cask),
            InstallSource::HomebrewCask
        );
        assert_eq!(
            detect_install_source(&installed, Some(home), none),
            InstallSource::Dmg
        );
        let user =
            exe("/Users/someone/Applications/Psyche Build.app/Contents/MacOS/psyche-build-tauri");
        assert_eq!(
            detect_install_source(&user, Some(home), none),
            InstallSource::Dmg
        );
        let built = exe(
            "/src/target/release/bundle/macos/Psyche Build.app/Contents/MacOS/psyche-build-tauri",
        );
        assert_eq!(
            detect_install_source(&built, Some(home), cask),
            InstallSource::Unknown
        );
        assert_eq!(
            detect_install_source(
                &exe("/src/target/debug/psyche-build-tauri"),
                Some(home),
                cask
            ),
            InstallSource::Unknown
        );
    }

    #[test]
    fn only_the_main_webview_may_read_update_state() {
        assert!(ensure_main("main").is_ok());
        assert!(ensure_main("psyche-browser-default").is_err());
    }

    #[test]
    fn states_serialize_as_snake_case_names() {
        assert_eq!(
            serde_json::to_value(CheckState::InvalidSignature).unwrap(),
            "invalid_signature"
        );
        assert_eq!(
            serde_json::to_value(InstallSource::HomebrewCask).unwrap(),
            "homebrew_cask"
        );
    }
}
