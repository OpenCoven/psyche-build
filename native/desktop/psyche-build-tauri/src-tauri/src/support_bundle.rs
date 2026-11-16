//! Local support export; only the trusted main WebView may request it.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

const WORKER: &[u8] = include_bytes!("../resources/support-bundle-worker.cjs");
const MAX_RESULT_BYTES: u64 = 16384;
const MAX_BUNDLE_BYTES: u64 = 65536;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerResult {
    state: String,
    code: String,
    #[serde(skip_serializing)]
    path: Option<String>,
    file_name: Option<String>,
    bytes: Option<u64>,
    digest: Option<String>,
    bundle_status: Option<String>,
    redacted_fields: Option<u32>,
    omitted_fields: Option<u32>,
    truncated: Option<bool>,
    retention_failures: Option<u32>,
    categories: Option<Vec<Category>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Category {
    category: String,
    disposition: String,
    reason: String,
}
#[derive(Clone, Serialize)]
pub(crate) struct JobView {
    id: String,
    state: String,
    result: Option<WorkerResult>,
}
struct Job {
    id: String,
    root: PathBuf,
    cancel: watch::Sender<bool>,
    result: Option<WorkerResult>,
}
#[derive(Default)]
struct Inner {
    next: u64,
    job: Option<Job>,
}
#[derive(Clone, Default)]
pub(crate) struct SupportBundleJobs {
    inner: Arc<Mutex<Inner>>,
}
impl SupportBundleJobs {
    fn begin(&self, root: PathBuf) -> Result<(String, watch::Receiver<bool>), String> {
        let mut inner = self.inner.lock();
        if inner.job.as_ref().is_some_and(|job| job.result.is_none()) {
            return Err("export_in_progress".into());
        }
        inner.next = inner.next.checked_add(1).ok_or("job_limit")?;
        let id = inner.next.to_string();
        let (cancel, receiver) = watch::channel(false);
        inner.job = Some(Job {
            id: id.clone(),
            root,
            cancel,
            result: None,
        });
        Ok((id, receiver))
    }
    fn cancel(&self, id: &str) -> Result<JobView, String> {
        {
            let inner = self.inner.lock();
            let job = inner
                .job
                .as_ref()
                .filter(|job| job.id == id)
                .ok_or("job_unavailable")?;
            if job.result.is_none() {
                job.cancel.send_replace(true);
            }
        }
        self.view(id)
    }
    fn view(&self, id: &str) -> Result<JobView, String> {
        let inner = self.inner.lock();
        let job = inner
            .job
            .as_ref()
            .filter(|job| job.id == id)
            .ok_or("job_unavailable")?;
        let state = job
            .result
            .as_ref()
            .map(|result| result.state.clone())
            .unwrap_or_else(|| {
                if *job.cancel.borrow() {
                    "cancelling".into()
                } else {
                    "collecting".into()
                }
            });
        Ok(JobView {
            id: job.id.clone(),
            state,
            result: job.result.clone(),
        })
    }
    fn finish(&self, id: &str, result: WorkerResult) {
        if let Some(job) = self.inner.lock().job.as_mut().filter(|job| job.id == id) {
            job.result = Some(result);
        }
    }
}
fn terminal(state: &str, code: &str) -> WorkerResult {
    WorkerResult {
        state: state.into(),
        code: code.into(),
        path: None,
        file_name: None,
        bytes: None,
        digest: None,
        bundle_status: None,
        redacted_fields: None,
        omitted_fields: None,
        truncated: None,
        retention_failures: None,
        categories: None,
    }
}
fn decode_result(root: &Path, bytes: &[u8]) -> Result<WorkerResult, String> {
    let invalid = || "worker_failed".to_string();
    if bytes.len() > MAX_RESULT_BYTES as usize {
        return Err(invalid());
    }
    let result: WorkerResult = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if result.state != "saved" {
        if !matches!(
            (result.state.as_str(), result.code.as_str()),
            ("cancelled", "cancelled")
                | (
                    "failed",
                    "invalid_request" | "write_failed" | "collection_failed"
                )
        ) || result.path.is_some()
            || result.file_name.is_some()
            || result.categories.is_some()
        {
            return Err(invalid());
        }
        return Ok(result);
    }
    let candidate = result.path.as_deref().ok_or_else(invalid)?;
    let output = scoped_output(root, Path::new(candidate))?;
    if result.code != "saved"
        || result.file_name.as_deref() != output.file_name().and_then(|name| name.to_str())
        || !matches!(
            result.bundle_status.as_deref(),
            Some("partial" | "unknown" | "recovery_required")
        )
        || result.redacted_fields.is_none()
        || result.omitted_fields.is_none()
        || result.truncated.is_none()
        || result.retention_failures.is_none()
    {
        return Err(invalid());
    }
    let file = std::fs::File::open(&output).map_err(|_| invalid())?;
    let mut data = Vec::new();
    Read::take(file, MAX_BUNDLE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| invalid())?;
    if data.len() > MAX_BUNDLE_BYTES as usize || result.bytes != Some(data.len() as u64) {
        return Err(invalid());
    }
    let digest = format!("{:x}", Sha256::digest(&data));
    if result.digest.as_deref() != Some(digest.as_str())
        || !result
            .file_name
            .as_deref()
            .unwrap_or_default()
            .ends_with(&format!("-{}.json", &digest[..12]))
    {
        return Err(invalid());
    }
    let bundle: serde_json::Value = serde_json::from_slice(&data).map_err(|_| invalid())?;
    if bundle.get("schema").and_then(|value| value.as_str()) != Some("psyche.diagnostics/v1")
        || bundle.get("status").and_then(|value| value.as_str()) != result.bundle_status.as_deref()
    {
        return Err(invalid());
    }
    let categories = result.categories.as_ref().ok_or_else(invalid)?;
    let expected = [
        "provenance",
        "persistence",
        "providers",
        "lifecycle",
        "updater",
        "graphics",
        "receipts",
        "terminal",
    ];
    let reasons = [
        "unverified",
        "project_recovery_only",
        "filesystem_only",
        "counts_only",
        "native_snapshot",
        "engine_only",
        "owner_unavailable",
        "content_excluded",
        "collection_failed",
    ];
    if categories.len() != expected.len()
        || categories.iter().zip(expected).any(|(category, name)| {
            category.category != name
                || !matches!(category.disposition.as_str(), "collected" | "omitted")
                || !reasons.contains(&category.reason.as_str())
        })
    {
        return Err(invalid());
    }
    Ok(result)
}

fn ensure_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("support_export_requires_main_webview".into())
    }
}

fn claim_root(
    label: &str,
    authority: &crate::NativeProjectAuthority,
    root: &str,
) -> Result<(PathBuf, crate::NativeProjectSubmissionLease), String> {
    ensure_main(label)?;
    if root.len() > 8192 {
        return Err("invalid_request".into());
    }
    let root = crate::canonical_project_root(root).map_err(|_| "project_unavailable")?;
    crate::acceptance::require_local_project(&root).map_err(|_| "project_unavailable")?;
    let lease = authority
        .claim_submission(&root)
        .map_err(|_| "project_unavailable")?;
    Ok((root, lease))
}
fn scoped_output(root: &Path, output: &Path) -> Result<PathBuf, String> {
    let invalid = || "support_file_unavailable".to_string();
    let root = root.canonicalize().map_err(|_| invalid())?;
    let directory = root.join(".psyche/runtime/support-bundles");
    if output.parent() != Some(directory.as_path()) {
        return Err(invalid());
    }
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(invalid)?;
    let stem = name
        .strip_prefix("psyche-support-")
        .and_then(|name| name.strip_suffix(".json"))
        .ok_or_else(invalid)?;
    let (stamp, digest) = stem.split_once('-').ok_or_else(invalid)?;
    if stamp.len() != 16
        || stamp.as_bytes()[8] != b'T'
        || stamp.as_bytes()[15] != b'Z'
        || !stamp
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 8 || index == 15 || byte.is_ascii_digit())
        || digest.len() != 12
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    let mut current = root;
    for part in [".psyche", "runtime", "support-bundles"] {
        current.push(part);
        let metadata = std::fs::symlink_metadata(&current).map_err(|_| invalid())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid());
        }
    }
    let metadata = std::fs::symlink_metadata(output).map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BUNDLE_BYTES
    {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(invalid());
        }
    }
    Ok(output.to_path_buf())
}

async fn run_worker(
    node: &Path,
    script: &[u8],
    request: serde_json::Value,
    root: &Path,
    mut cancel: watch::Receiver<bool>,
    budget: Duration,
) -> WorkerResult {
    if *cancel.borrow() {
        return terminal("cancelled", "cancelled");
    }
    let failed = || terminal("recovery_required", "worker_failed");
    let work = async {
        let directory = tempfile::Builder::new().prefix("psyche-support-worker-").tempdir().map_err(|_| ())?;
        let worker = directory.path().join("worker.cjs");
        let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        options.open(&worker).and_then(|mut file| file.write_all(script)).map_err(|_| ())?;
        let mut command = tokio::process::Command::new(node);
        command.arg(&worker).current_dir(directory.path()).env_clear().env("PATH", crate::platform::augmented_path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        if let Some(home) = crate::platform::home_directory() { command.env("HOME", home); }
        #[cfg(windows)] if let Some(system_root) = std::env::var_os("SystemRoot") { command.env("SystemRoot", system_root); }
        let mut child = command.spawn().map_err(|_| ())?;
        let mut stdin = child.stdin.take().ok_or(())?;
        let mut input = serde_json::to_vec(&request).map_err(|_| ())?;
        if input.len() + 1 > 16384 { return Err(()); }
        input.push(b'\n');
        tokio::time::timeout(Duration::from_secs(1), stdin.write_all(&input)).await.map_err(|_| ())?.map_err(|_| ())?;
        let stdout = child.stdout.take().ok_or(())?;
        let deadline = tokio::time::Instant::now() + budget;
        let output = {
            let read = async { let mut data = Vec::new(); stdout.take(MAX_RESULT_BYTES + 1).read_to_end(&mut data).await.map(|_| data) };
            tokio::pin!(read);
            let mut cancellation_seen = false;
            let mut cancel_deadline = deadline;
            loop {
                tokio::select! {
                    result = &mut read => break result.map_err(|_| ()),
                    _ = tokio::time::sleep_until(deadline) => break Err(()),
                    _ = tokio::time::sleep_until(cancel_deadline), if cancellation_seen => break Err(()),
                    _ = cancel.changed(), if !cancellation_seen => {
                        cancellation_seen = true;
                        cancel_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                        // EPIPE can mean the worker already committed and exited.
                        // Read its result before deciding whether it cancelled.
                        let _ = tokio::time::timeout(Duration::from_millis(200), stdin.write_all(b"cancel\n")).await;
                    }
                }
            }
        };
        drop(stdin);
        let result = output.ok().and_then(|bytes| decode_result(root, &bytes).ok());
        if result.is_none() { let _ = child.start_kill(); }
        if tokio::time::timeout(Duration::from_secs(1), child.wait()).await.is_err() { let _ = child.start_kill(); }
        result.ok_or(())
    }.await;
    work.unwrap_or_else(|_| failed())
}

#[tauri::command]
pub(crate) async fn support_bundle_start(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    jobs: State<'_, SupportBundleJobs>,
    authority: State<'_, crate::NativeProjectAuthority>,
    updater: State<'_, crate::UpdateCheck>,
    root: String,
    panes: u32,
) -> Result<JobView, String> {
    ensure_main(webview.label())?;
    if panes > 10000 {
        return Err("invalid_request".into());
    }
    let (root, lease) = claim_root(webview.label(), &authority, &root)?;
    let node = crate::which_on_path("node").ok_or("node_unavailable")?;
    let source = env!("PSYCHE_SUPPORT_SOURCE_SHA");
    if source.len() != 40 {
        return Err("build_identity_unavailable".into());
    }
    let engine = match crate::platform::runtime_info().webview_engine {
        "WKWebView" => "wkwebview",
        "WebView2" => "webview2",
        _ => "webkitgtk",
    };
    let update = updater.status();
    let update_state = match update.state {
        crate::update_check::CheckState::Disabled | crate::update_check::CheckState::Off => {
            "disabled"
        }
        crate::update_check::CheckState::Available => "available",
        crate::update_check::CheckState::Unavailable => "unavailable",
        _ => "unknown",
    };
    let request = serde_json::json!({ "projectRoot": root, "releaseVersion": app.package_info().version.to_string(), "sourceSha": source,
        "graphics": { "engine": engine, "accelerated": "unknown" }, "lifecycle": { "panes": panes },
        "updater": { "checksEnabled": update.checks_enabled, "state": update_state } });
    let (id, cancel) = jobs.begin(root.clone())?;
    let view = jobs.view(&id)?;
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = run_worker(
            Path::new(&node),
            WORKER,
            request,
            &root,
            cancel,
            Duration::from_secs(35),
        )
        .await;
        jobs.finish(&id, result);
        drop(lease);
    });
    Ok(view)
}

#[tauri::command]
pub(crate) fn support_bundle_status(
    webview: tauri::Webview,
    jobs: State<'_, SupportBundleJobs>,
    id: String,
) -> Result<JobView, String> {
    ensure_main(webview.label())?;
    jobs.view(&id)
}
#[tauri::command]
pub(crate) fn support_bundle_cancel(
    webview: tauri::Webview,
    jobs: State<'_, SupportBundleJobs>,
    id: String,
) -> Result<JobView, String> {
    ensure_main(webview.label())?;
    jobs.cancel(&id)
}
#[tauri::command]
pub(crate) async fn support_bundle_reveal(
    webview: tauri::Webview,
    jobs: State<'_, SupportBundleJobs>,
    authority: State<'_, crate::NativeProjectAuthority>,
    id: String,
) -> Result<(), String> {
    ensure_main(webview.label())?;
    let (root, result) = {
        let inner = jobs.inner.lock();
        let job = inner
            .job
            .as_ref()
            .filter(|job| job.id == id)
            .ok_or("job_unavailable")?;
        let result = job
            .result
            .as_ref()
            .filter(|result| result.state == "saved")
            .ok_or("support_file_unavailable")?;
        (job.root.clone(), result.clone())
    };
    let lease = authority
        .claim_submission(&root)
        .map_err(|_| "project_unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        // Recheck file identity, privacy and digest immediately before reveal.
        let encoded = serde_json::to_value(&result).map_err(|_| "support_file_unavailable")?;
        let mut encoded = encoded;
        encoded["path"] =
            serde_json::Value::String(result.path.clone().ok_or("support_file_unavailable")?);
        let checked = decode_result(
            &root,
            &serde_json::to_vec(&encoded).map_err(|_| "support_file_unavailable")?,
        )
        .map_err(|_| "support_file_unavailable")?;
        let answer = tauri_plugin_opener::reveal_item_in_dir(
            checked.path.ok_or("support_file_unavailable")?,
        )
        .map_err(|_| "reveal_failed");
        drop(lease);
        answer.map_err(String::from)
    })
    .await
    .map_err(|_| "reveal_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(root: &Path) -> serde_json::Value {
        serde_json::json!({ "projectRoot": root, "releaseVersion": "0.0.3", "sourceSha": "2".repeat(40) })
    }
    fn node() -> PathBuf {
        PathBuf::from(crate::which_on_path("node").expect("contributor Node prerequisite"))
    }
    #[test]
    fn support_bundle_refuses_browser_callers() {
        assert!(ensure_main("psyche-browser-untrusted").is_err());
        assert!(ensure_main("main").is_ok());
    }
    #[test]
    fn support_bundle_claims_only_an_open_reconciled_project_and_releases_its_lease() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let text = root.to_string_lossy();
        let authority = crate::NativeProjectAuthority::default();
        assert!(claim_root("main", &authority, &text).is_err());
        authority
            .authorize_canonical_native_open(root.clone())
            .unwrap();
        assert!(claim_root("main", &authority, &text).is_err());
        authority
            .reconcile_startup_roots(&[text.to_string()])
            .unwrap();
        assert!(claim_root("psyche-browser-untrusted", &authority, &text).is_err());
        let (_, lease) = claim_root("main", &authority, &text).unwrap();
        assert_eq!(
            authority
                .inner
                .roots
                .lock()
                .get(&root)
                .unwrap()
                .in_flight_submissions,
            1
        );
        drop(lease);
        assert_eq!(
            authority
                .inner
                .roots
                .lock()
                .get(&root)
                .unwrap()
                .in_flight_submissions,
            0
        );
        authority.revoke_native_open(&root).unwrap();
        assert!(claim_root("main", &authority, &text).is_err());
    }
    #[test]
    fn support_bundle_reveal_refuses_foreign_and_symlinked_files() {
        let root = tempfile::tempdir().unwrap();
        let foreign = tempfile::NamedTempFile::new().unwrap();
        assert!(scoped_output(root.path(), foreign.path()).is_err());
        let directory = root.path().join(".psyche/runtime/support-bundles");
        std::fs::create_dir_all(&directory).unwrap();
        let candidate = directory.join("psyche-support-20261116T000000Z-111111111111.json");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(foreign.path(), &candidate).unwrap();
            assert!(scoped_output(root.path(), &candidate).is_err());
        }
    }
    #[test]
    fn support_bundle_one_job_and_stale_ids_cannot_control_a_new_job() {
        let jobs = SupportBundleJobs::default();
        let root = tempfile::tempdir().unwrap();
        let (id, _) = jobs.begin(root.path().into()).unwrap();
        assert!(jobs.begin(root.path().into()).is_err());
        assert!(jobs.view("foreign").is_err());
        assert!(jobs.cancel("foreign").is_err());
        assert_eq!(jobs.view(&id).unwrap().state, "collecting");
    }
    #[test]
    fn support_bundle_cancellation_is_cooperative_until_a_terminal_result() {
        let jobs = SupportBundleJobs::default();
        let root = tempfile::tempdir().unwrap();
        let (id, signal) = jobs.begin(root.path().into()).unwrap();
        assert_eq!(jobs.cancel(&id).unwrap().state, "cancelling");
        assert!(*signal.borrow());
    }
    #[test]
    fn support_bundle_worker_output_must_match_a_saved_file_and_digest() {
        let root = tempfile::tempdir().unwrap();
        let forged = serde_json::json!({ "state": "saved", "code": "saved", "path": "/unowned/file", "fileName": "forged.json", "bytes": 1, "digest": "1".repeat(64) });
        assert!(decode_result(root.path(), &serde_json::to_vec(&forged).unwrap()).is_err());
        assert!(decode_result(root.path(), &vec![b'x'; 16385]).is_err());
    }
    #[tokio::test]
    async fn support_bundle_native_runner_uses_the_embedded_pipeline_and_hides_private_paths() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let (_sender, cancel) = watch::channel(false);
        let result = run_worker(
            &node(),
            WORKER,
            request(&root),
            &root,
            cancel,
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(result.state, "saved");
        let path = Path::new(result.path.as_ref().unwrap());
        assert!(scoped_output(&root, path).is_ok());
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains(&root.to_string_lossy().to_string()));
        assert!(!public.contains("\"path\""));
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.len() <= 65536);
        // A changed file cannot be revealed using its old summary/digest.
        std::fs::write(path, b"{}").unwrap();
        let mut encoded = serde_json::to_value(&result).unwrap();
        encoded["path"] = result.path.clone().unwrap().into();
        assert!(decode_result(&root, &serde_json::to_vec(&encoded).unwrap()).is_err());
        let jobs = SupportBundleJobs::default();
        let (id, _) = jobs.begin(root).unwrap();
        jobs.cancel(&id).unwrap();
        jobs.finish(&id, result);
        assert_eq!(jobs.cancel(&id).unwrap().state, "saved");
    }
    #[tokio::test]
    async fn support_bundle_native_runner_cancels_before_launch_without_files() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let (_sender, cancel) = watch::channel(true);
        let result = run_worker(
            &node(),
            WORKER,
            request(&root),
            &root,
            cancel,
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(result.state, "cancelled");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }
    #[tokio::test]
    async fn support_bundle_native_runner_bounds_output_timeout_and_crash() {
        for (script, budget) in [
            (
                b"process.stdout.write('x'.repeat(16385));process.stdin.resume();".as_slice(),
                Duration::from_secs(5),
            ),
            (b"process.stdin.resume();".as_slice(), Duration::ZERO),
            (b"process.exit(1);".as_slice(), Duration::from_secs(5)),
        ] {
            let project = tempfile::tempdir().unwrap();
            let root = project.path().canonicalize().unwrap();
            let (_sender, cancel) = watch::channel(false);
            let result = run_worker(&node(), script, request(&root), &root, cancel, budget).await;
            assert_eq!(result.state, "recovery_required");
            assert!(result.path.is_none());
        }
    }
    #[test]
    fn support_bundle_worker_clears_node_injection_environment() {
        const CHILD: &str = "PSYCHE_SUPPORT_NODE_ENV_TEST";
        if std::env::var(CHILD).as_deref() == Ok("1") {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let project = tempfile::tempdir().unwrap();
                let root = project.path().canonicalize().unwrap();
                let (_sender, cancel) = watch::channel(false);
                let result = run_worker(
                    &node(),
                    WORKER,
                    request(&root),
                    &root,
                    cancel,
                    Duration::from_secs(10),
                )
                .await;
                assert_eq!(result.state, "saved");
            });
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "support_bundle::tests::support_bundle_worker_clears_node_injection_environment",
            ])
            .env(CHILD, "1")
            .env("NODE_OPTIONS", "--require=/SYNTHETIC_MISSING_476.cjs")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "worker must clear inherited Node injection settings"
        );
    }
}
