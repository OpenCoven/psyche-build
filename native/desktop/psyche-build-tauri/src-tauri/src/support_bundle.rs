//! Local support export; only the trusted main WebView may request it.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

#[cfg(unix)]
#[path = "support_bundle_io.rs"]
mod io;
#[cfg(target_os = "macos")]
#[path = "support_reveal.rs"]
mod reveal;

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
    helper_active: bool,
    lingering: Option<PendingHelper>,
}
struct PendingHelper {
    child: Option<tokio::process::Child>,
    group: Option<u32>,
}
fn group_alive(group: Option<u32>) -> bool {
    #[cfg(unix)]
    if let Some(group) = group {
        let answer = unsafe { libc::kill(-(group as libc::pid_t), 0) };
        return answer == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    false
}
impl PendingHelper {
    fn pending(&mut self) -> bool {
        let leader = self
            .child
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none());
        if !leader {
            self.child = None;
        }
        leader || group_alive(self.group)
    }
}
#[derive(Clone)]
pub(crate) struct SupportBundleJobs {
    inner: Arc<Mutex<Inner>>,
    executable: Option<PathBuf>,
}
impl Default for SupportBundleJobs {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::default())),
            executable: std::env::current_exe().ok(),
        }
    }
}
impl SupportBundleJobs {
    fn helper_available(inner: &mut Inner) -> Result<(), String> {
        if inner.helper_active {
            return Err("export_in_progress".into());
        }
        if let Some(child) = inner.lingering.as_mut() {
            if child.pending() {
                return Err("export_recovery_in_progress".into());
            }
            inner.lingering = None;
        }
        Ok(())
    }
    fn begin(&self, root: PathBuf) -> Result<(String, watch::Receiver<bool>), String> {
        let mut inner = self.inner.lock();
        Self::helper_available(&mut inner)?;
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
        inner.helper_active = true;
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
    fn finish(&self, id: &str, result: WorkerResult, lingering: Option<PendingHelper>) {
        let mut inner = self.inner.lock();
        inner.helper_active = false;
        inner.lingering = lingering;
        if let Some(job) = inner.job.as_mut().filter(|job| job.id == id) {
            job.result = Some(result);
        }
    }
    fn begin_reveal(&self) -> Result<(), String> {
        let mut inner = self.inner.lock();
        Self::helper_available(&mut inner)?;
        inner.helper_active = true;
        Ok(())
    }
    fn end_reveal(&self, lingering: Option<PendingHelper>) {
        let mut inner = self.inner.lock();
        inner.helper_active = false;
        inner.lingering = lingering;
    }
}

pub(crate) fn helper_entry() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref()
        != Some(std::ffi::OsStr::new("--support-bundle-helper"))
    {
        return None;
    }
    if std::env::args_os().count() != 2 {
        return Some(64);
    }
    #[cfg(unix)]
    {
        Some(io::entry())
    }
    #[cfg(not(unix))]
    {
        Some(64)
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
fn private_result(result: &WorkerResult) -> serde_json::Value {
    let mut value = serde_json::to_value(result).unwrap_or_else(
        |_| serde_json::json!({"state":"recovery_required","code":"worker_failed"}),
    );
    if let Some(path) = &result.path {
        value["path"] = path.clone().into();
    }
    value
}
fn scope_path(root: &Path, output: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute()
        || output.parent() != Some(root.join(".psyche/runtime/support-bundles").as_path())
    {
        return Err("support_file_unavailable".into());
    }
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("support_file_unavailable")?;
    #[cfg(unix)]
    if !crate::support_store::valid_bundle_name(name) {
        return Err("support_file_unavailable".into());
    }
    #[cfg(not(unix))]
    {
        let _ = name;
        return Err("support_file_unavailable".into());
    }
    Ok(output.to_path_buf())
}
// Pure protocol checks only: the GUI executor never opens project files.
fn decode_metadata(root: &Path, bytes: &[u8]) -> Result<WorkerResult, String> {
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
                    "invalid_request"
                        | "write_failed"
                        | "collection_failed"
                        | "node_unavailable"
                        | "worker_failed"
                )
                | ("recovery_required", "worker_failed")
                | ("revealed", "revealed")
        ) || result.path.is_some()
            || result.file_name.is_some()
            || result.categories.is_some()
        {
            return Err(invalid());
        }
        return Ok(result);
    }
    let output = scope_path(root, Path::new(result.path.as_deref().ok_or_else(invalid)?))?;
    let digest = result.digest.as_deref().ok_or_else(invalid)?;
    if result.code != "saved"
        || result.file_name.as_deref() != output.file_name().and_then(|name| name.to_str())
        || result.bytes.is_none_or(|bytes| bytes > MAX_BUNDLE_BYTES)
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !result
            .file_name
            .as_deref()
            .unwrap_or_default()
            .ends_with(&format!("-{}.json", &digest[..12]))
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
        "truncated",
    ];
    let categories = result.categories.as_ref().ok_or_else(invalid)?;
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
// Called only by the isolated helper (and focused tests), under its parent's
// process deadline. Descriptor-relative inspection never follows a replacement.
fn decode_result(root: &Path, bytes: &[u8]) -> Result<WorkerResult, String> {
    #[cfg(unix)]
    {
        decode_file_result(root, bytes).map(|(result, _file)| result)
    }
    #[cfg(not(unix))]
    {
        let _ = (root, bytes);
        Err("worker_failed".into())
    }
}
#[cfg(unix)]
fn decode_file_result(
    root: &Path,
    bytes: &[u8],
) -> Result<(WorkerResult, Option<std::fs::File>), String> {
    let result = decode_metadata(root, bytes)?;
    if result.state != "saved" {
        return Ok((result, None));
    }
    let (file, data) = crate::support_store::inspect_file(
        root,
        result.file_name.as_deref().ok_or("worker_failed")?,
    )?;
    if result.bytes != Some(data.len() as u64)
        || result.digest.as_deref() != Some(format!("{:x}", Sha256::digest(&data)).as_str())
    {
        return Err("worker_failed".into());
    }
    let bundle: serde_json::Value = serde_json::from_slice(&data).map_err(|_| "worker_failed")?;
    if bundle.get("schema").and_then(|value| value.as_str()) != Some("psyche.diagnostics/v1")
        || bundle.get("status").and_then(|value| value.as_str()) != result.bundle_status.as_deref()
    {
        return Err("worker_failed".into());
    }
    Ok((result, Some(file)))
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
    let root = Path::new(root);
    if !root.is_absolute() {
        return Err("invalid_request".into());
    }
    crate::acceptance::require_local_project(root).map_err(|_| "project_unavailable")?;
    let lease = authority
        .claim_admitted_submission(root)
        .map_err(|_| "project_unavailable")?;
    Ok((lease.root.clone(), lease))
}
#[cfg(test)]
fn scoped_output(root: &Path, output: &Path) -> Result<PathBuf, String> {
    let output = scope_path(root, output)?;
    #[cfg(unix)]
    {
        crate::support_store::inspect_file(
            root,
            output
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("support_file_unavailable")?,
        )?;
    }
    Ok(output)
}

async fn run_helper(
    executable: &Path,
    args: &[&str],
    request: serde_json::Value,
    root: &Path,
    mut cancel: watch::Receiver<bool>,
    budget: Duration,
) -> (WorkerResult, Option<PendingHelper>) {
    if *cancel.borrow() {
        return (terminal("cancelled", "cancelled"), None);
    }
    let failed = || terminal("recovery_required", "worker_failed");
    let deadline = tokio::time::Instant::now() + budget;
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Copy only explicit runtime settings; perform Node/path discovery in the
    // supervised helper, never on the application executor.
    for key in [
        "PATH",
        "HOME",
        "CFFIXED_USER_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    let Ok(mut child) = command.spawn() else {
        return (failed(), None);
    };
    let pid = child.id();
    let work = async {
        let mut stdin = child.stdin.take().ok_or(())?;
        let mut input = serde_json::to_vec(&request).map_err(|_| ())?;
        if input.len() + 1 > 32768 { return Err(()); }
        input.push(b'\n');
        tokio::time::timeout_at(deadline, stdin.write_all(&input)).await.map_err(|_| ())?.map_err(|_| ())?;
        let stdout = child.stdout.take().ok_or(())?;
        let read = async { let mut bytes = Vec::new(); stdout.take(MAX_RESULT_BYTES + 1).read_to_end(&mut bytes).await.map(|_| bytes) };
        tokio::pin!(read);
        let mut cancellation_seen = false;
        let mut cancel_deadline = deadline;
        let output = loop {
            tokio::select! {
                value = &mut read => break value.map_err(|_| ()),
                _ = tokio::time::sleep_until(deadline) => break Err(()),
                _ = tokio::time::sleep_until(cancel_deadline), if cancellation_seen => break Err(()),
                _ = cancel.changed(), if !cancellation_seen => {
                    cancellation_seen = true;
                    cancel_deadline = std::cmp::min(deadline, tokio::time::Instant::now() + Duration::from_secs(2));
                    let _ = tokio::time::timeout_at(cancel_deadline, stdin.write_all(b"cancel\n")).await;
                }
            }
        }?;
        // Only bounded protocol parsing happens here. Filesystem validation,
        // persistence and reveal preparation all ran inside the helper.
        decode_metadata(root, &output).map_err(|_| ())
    }.await;
    // The helper and its Node child share a fresh process group. Never leave
    // a blocked descendant behind after a timeout or parent cancellation.
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(1), child.wait())
        .await
        .ok()
        .and_then(Result::ok)
        .is_some();
    let lingering = if !reaped || group_alive(pid) {
        Some(PendingHelper {
            child: (!reaped).then_some(child),
            group: pid,
        })
    } else {
        None
    };
    (work.unwrap_or_else(|_| failed()), lingering)
}

#[tauri::command]
pub(crate) async fn support_bundle_start(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    jobs: State<'_, SupportBundleJobs>,
    authority: State<'_, crate::NativeProjectAuthority>,
    updater: State<'_, crate::UpdateCheck>,
    runtime: State<'_, crate::RuntimeDiagnosticsState>,
    root: String,
    panes: u32,
) -> Result<JobView, String> {
    ensure_main(webview.label())?;
    if panes > 10000 {
        return Err("invalid_request".into());
    }
    let (root, lease) = claim_root(webview.label(), &authority, &root)?;
    #[cfg(not(unix))]
    return Err("secure_support_export_unavailable".into());
    let executable = jobs
        .executable
        .clone()
        .ok_or("native_runtime_unavailable")?;
    let source = env!("PSYCHE_SUPPORT_SOURCE_SHA");
    if source.len() != 40 {
        return Err("build_identity_unavailable".into());
    }
    let engine = match runtime.support_engine() {
        "WKWebView" => "wkwebview",
        "WebView2" => "webview2",
        _ => "webkitgtk",
    };
    let update = updater.support_state();
    let update_state = match update.map(|(_, state)| state) {
        Some(crate::update_check::CheckState::Disabled | crate::update_check::CheckState::Off) => {
            "disabled"
        }
        Some(crate::update_check::CheckState::Available) => "available",
        Some(crate::update_check::CheckState::Unavailable) => "unavailable",
        _ => "unknown",
    };
    let mut request = serde_json::json!({ "projectRoot": root, "releaseVersion": app.package_info().version.to_string(), "sourceSha": source,
        "graphics": { "engine": engine, "accelerated": "unknown" }, "lifecycle": { "panes": panes } });
    if let Some((enabled, _)) = update {
        request["updater"] = serde_json::json!({ "checksEnabled": enabled, "state": update_state });
    }
    let request = serde_json::json!({ "operation": "create", "request": request });
    let (id, cancel) = jobs.begin(root.clone())?;
    let view = jobs.view(&id)?;
    let jobs = jobs.inner().clone();
    tauri::async_runtime::spawn(async move {
        let (mut result, lingering) = run_helper(
            &executable,
            &["--support-bundle-helper"],
            request,
            &root,
            cancel,
            Duration::from_secs(35),
        )
        .await;
        if result.state == "revealed" {
            result = terminal("recovery_required", "worker_failed");
        }
        jobs.finish(&id, result, lingering);
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
        .claim_admitted_submission(&root)
        .map_err(|_| "project_unavailable")?;
    let executable = jobs
        .executable
        .clone()
        .ok_or("native_runtime_unavailable")?;
    jobs.begin_reveal()?;
    let (cancel_owner, cancel) = watch::channel(false);
    let request = serde_json::json!({ "operation": "reveal", "root": root, "result": private_result(&result) });
    let (answer, lingering) = run_helper(
        &executable,
        &["--support-bundle-helper"],
        request,
        &root,
        cancel,
        Duration::from_secs(35),
    )
    .await;
    jobs.end_reveal(lingering);
    drop(cancel_owner);
    drop(lease);
    if answer.state == "revealed" {
        Ok(())
    } else {
        Err("reveal_failed".into())
    }
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
    #[cfg(unix)]
    #[tokio::test]
    async fn support_bundle_group_fence_outlives_a_reaped_helper_leader() {
        let mut command = tokio::process::Command::new(node());
        command
            .args(["--eval", "setInterval(()=>{},1000)"])
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let mut pending = PendingHelper {
            child: None,
            group: child.id(),
        };
        let was_pending = pending.pending();
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        assert!(was_pending);
        assert!(!pending.pending());
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
    #[cfg(unix)]
    #[tokio::test]
    async fn support_bundle_native_runner_uses_the_embedded_pipeline_and_hides_private_paths() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let (_sender, cancel) = watch::channel(false);
        let result = io::create(
            request(&root),
            Arc::new(std::sync::atomic::AtomicBool::new(*cancel.borrow())),
            None,
        );
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
        jobs.finish(&id, result, None);
        assert_eq!(jobs.cancel(&id).unwrap().state, "saved");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn support_bundle_native_runner_cancels_before_launch_without_files() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let (_sender, cancel) = watch::channel(true);
        let result = io::create(
            request(&root),
            Arc::new(std::sync::atomic::AtomicBool::new(*cancel.borrow())),
            None,
        );
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
            let script = std::str::from_utf8(script).unwrap();
            let (result, lingering) = run_helper(
                &node(),
                &["--eval", script],
                request(&root),
                &root,
                cancel,
                budget,
            )
            .await;
            assert!(lingering.is_none());
            assert_eq!(result.state, "recovery_required");
            assert!(result.path.is_none());
        }
    }
    #[cfg(unix)]
    #[test]
    fn support_bundle_worker_clears_node_injection_environment() {
        const CHILD: &str = "PSYCHE_SUPPORT_NODE_ENV_TEST";
        if std::env::var(CHILD).as_deref() == Ok("1") {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let project = tempfile::tempdir().unwrap();
                let root = project.path().canonicalize().unwrap();
                let (_sender, cancel) = watch::channel(false);
                let result = io::create(
                    request(&root),
                    Arc::new(std::sync::atomic::AtomicBool::new(*cancel.borrow())),
                    None,
                );
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
    #[tokio::test]
    async fn support_bundle_supervisor_bounds_all_helper_phases_and_releases_project_lease() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let authority = crate::NativeProjectAuthority::default();
        authority
            .authorize_canonical_native_open(root.clone())
            .unwrap();
        authority
            .reconcile_startup_roots(&[root.to_string_lossy().to_string()])
            .unwrap();
        let (_, lease) = claim_root("main", &authority, &root.to_string_lossy()).unwrap();
        let (_sender, cancel) = watch::channel(false);
        let (result, lingering) = run_helper(&node(), &["--eval", "process.stdin.on('data',()=>{process.stdout.write('validation started');setInterval(()=>{},1000);});"], request(&root), &root, cancel, Duration::from_millis(50)).await;
        assert_eq!(result.state, "recovery_required");
        assert!(lingering.is_none());
        drop(lease);
        assert!(authority.revoke_native_open(&root).unwrap());
    }
    #[tokio::test]
    async fn support_bundle_pending_worker_fence_prevents_accumulating_blocked_helpers() {
        let jobs = SupportBundleJobs::default();
        let root = tempfile::tempdir().unwrap();
        let child = tokio::process::Command::new(node())
            .args(["--eval", "setInterval(()=>{},1000)"])
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        jobs.inner.lock().lingering = Some(PendingHelper {
            child: Some(child),
            group: None,
        });
        assert!(
            matches!(jobs.begin(root.path().into()), Err(code) if code == "export_recovery_in_progress")
        );
        let mut child = jobs.inner.lock().lingering.take().unwrap().child.unwrap();
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        jobs.inner.lock().lingering = Some(PendingHelper {
            child: Some(child),
            group: None,
        });
        assert!(jobs.begin(root.path().into()).is_ok());
    }
    #[test]
    fn support_bundle_claim_does_not_touch_project_storage_before_helper_deadline() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let authority = crate::NativeProjectAuthority::default();
        authority
            .authorize_canonical_native_open(root.clone())
            .unwrap();
        authority
            .reconcile_startup_roots(&[root.to_string_lossy().to_string()])
            .unwrap();
        std::fs::remove_dir(&root).unwrap();
        let (_, lease) = claim_root("main", &authority, &root.to_string_lossy()).unwrap();
        drop(lease);
        assert!(authority.revoke_native_open(&root).unwrap());
    }
}
