use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_STATS_BYTES: usize = 2 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const COVEN_STATS_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Deserialize)]
struct CovenStatsOutput {
    sessions: Vec<CovenStatsSession>,
}

#[derive(Debug, Deserialize)]
struct CovenStatsSession {
    session_id: String,
    project_dir: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    cost_usd: f64,
    last_ts: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneSessionMetrics {
    pub provider: String,
    pub session_id: String,
    pub model: Option<String>,
    pub context_used: Option<u64>,
    pub context_limit: Option<u64>,
    pub cumulative_input_tokens: u64,
    pub cumulative_output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub spend_usd: Option<f64>,
    pub cost_kind: String,
    pub updated_at: Option<String>,
}

fn normalize_coven_stats(
    raw: &[u8],
    cwd: &Path,
    session_id: &str,
) -> Result<PaneSessionMetrics, String> {
    if raw.len() > MAX_STATS_BYTES {
        return Err("Coven stats output exceeded the 2 MiB limit".to_string());
    }

    let output: CovenStatsOutput = serde_json::from_slice(raw)
        .map_err(|error| format!("invalid Coven stats JSON: {error}"))?;
    let project_dir = cwd
        .to_str()
        .ok_or_else(|| "Coven metrics cwd is not valid UTF-8".to_string())?;
    let session = output
        .sessions
        .into_iter()
        .find(|session| session.session_id == session_id && session.project_dir == project_dir)
        .ok_or_else(|| {
            format!(
                "Coven stats did not include session '{session_id}' for project '{project_dir}'"
            )
        })?;
    let has_meaningful_cost = session.cost_usd.is_finite() && session.cost_usd >= 0.0;

    Ok(PaneSessionMetrics {
        provider: "coven".to_string(),
        session_id: session.session_id,
        model: None,
        context_used: None,
        context_limit: None,
        cumulative_input_tokens: session.input_tokens,
        cumulative_output_tokens: session.output_tokens,
        cache_creation_tokens: session.cache_creation_tokens,
        cache_read_tokens: session.cache_read_tokens,
        spend_usd: has_meaningful_cost.then_some(session.cost_usd),
        cost_kind: if has_meaningful_cost {
            "local-estimate"
        } else {
            "unknown"
        }
        .to_string(),
        updated_at: session.last_ts,
    })
}

pub(crate) fn load_coven_metrics(
    coven_binary: &str,
    cwd: &Path,
    session_id: &str,
    path: &OsStr,
) -> Result<PaneSessionMetrics, String> {
    load_coven_metrics_with_timeout(coven_binary, cwd, session_id, path, COVEN_STATS_TIMEOUT)
}

fn load_coven_metrics_with_timeout(
    coven_binary: &str,
    cwd: &Path,
    session_id: &str,
    path: &OsStr,
    timeout: Duration,
) -> Result<PaneSessionMetrics, String> {
    let output = run_coven_stats(coven_binary, cwd, session_id, path, timeout)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(if stderr.is_empty() {
            "Coven stats command failed".to_string()
        } else {
            format!("Coven stats command failed: {stderr}")
        });
    }

    normalize_coven_stats(&output.stdout, cwd, session_id)
}

struct CovenStatsProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct BoundedRead {
    bytes: Vec<u8>,
    overflowed: bool,
}

fn run_coven_stats(
    coven_binary: &str,
    cwd: &Path,
    session_id: &str,
    path: &OsStr,
    timeout: Duration,
) -> Result<CovenStatsProcessOutput, String> {
    let mut command = Command::new(coven_binary);
    command
        .args(["code", "stats", "session", session_id, "--json"])
        .current_dir(cwd)
        .env("PATH", path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to run Coven stats: {error}"))?;
    let child_id = child.id();
    let Some(stdout) = child.stdout.take() else {
        let _ = terminate_and_reap(&mut child);
        return Err("failed to capture Coven stats stdout".to_string());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = terminate_and_reap(&mut child);
        return Err("failed to capture Coven stats stderr".to_string());
    };
    let mut stdout_reader = Some(spawn_bounded_reader(stdout, MAX_STATS_BYTES));
    let mut stderr_reader = Some(spawn_bounded_reader(stderr, MAX_STDERR_BYTES));
    let mut stdout_read = None;
    let mut stderr_read = None;
    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut failure = None;

    loop {
        if reader_finished(&stdout_reader) {
            match join_reader(&mut stdout_reader, "stdout") {
                Ok(read) if read.overflowed => {
                    failure = Some("Coven stats output exceeded the 2 MiB limit".to_string());
                    break;
                }
                Ok(read) => stdout_read = Some(read),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if reader_finished(&stderr_reader) {
            match join_reader(&mut stderr_reader, "stderr") {
                Ok(read) if read.overflowed => {
                    failure = Some("Coven stats stderr exceeded the 64 KiB limit".to_string());
                    break;
                }
                Ok(read) => stderr_read = Some(read),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }

        status = match child.try_wait() {
            Ok(status) => status,
            Err(error) => {
                failure = Some(format!("failed to wait for Coven stats: {error}"));
                break;
            }
        };
        if status.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            failure = Some(format!(
                "Coven stats command timed out after {} seconds",
                timeout.as_secs_f64()
            ));
            break;
        }
        thread::sleep(
            PROCESS_POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
        );
    }

    let reap_error = if failure.is_some() {
        terminate_and_reap(&mut child).err()
    } else {
        terminate_process_group(child_id);
        None
    };

    if stdout_read.is_none() {
        match join_reader(&mut stdout_reader, "stdout") {
            Ok(read) => stdout_read = Some(read),
            Err(error) if failure.is_none() => failure = Some(error),
            Err(_) => {}
        }
    }
    if stderr_read.is_none() {
        match join_reader(&mut stderr_reader, "stderr") {
            Ok(read) => stderr_read = Some(read),
            Err(error) if failure.is_none() => failure = Some(error),
            Err(_) => {}
        }
    }
    if failure.is_none() {
        failure = reap_error;
    }
    if let Some(failure) = failure {
        return Err(failure);
    }
    let stdout = stdout_read.ok_or_else(|| "Coven stats stdout was unavailable".to_string())?;
    let stderr = stderr_read.ok_or_else(|| "Coven stats stderr was unavailable".to_string())?;
    if stdout.overflowed {
        return Err("Coven stats output exceeded the 2 MiB limit".to_string());
    }
    if stderr.overflowed {
        return Err("Coven stats stderr exceeded the 64 KiB limit".to_string());
    }
    let status = status.ok_or_else(|| "Coven stats process status was unavailable".to_string())?;

    Ok(CovenStatsProcessOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn spawn_bounded_reader<R: Read + Send + 'static>(
    reader: R,
    limit: usize,
) -> JoinHandle<Result<BoundedRead, String>> {
    thread::spawn(move || {
        let mut bytes = Vec::with_capacity(limit + 1);
        reader
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to read Coven stats output: {error}"))?;
        let overflowed = bytes.len() > limit;
        Ok(BoundedRead { bytes, overflowed })
    })
}

fn reader_finished(reader: &Option<JoinHandle<Result<BoundedRead, String>>>) -> bool {
    reader.as_ref().is_some_and(JoinHandle::is_finished)
}

fn join_reader(
    reader: &mut Option<JoinHandle<Result<BoundedRead, String>>>,
    stream_name: &str,
) -> Result<BoundedRead, String> {
    reader
        .take()
        .ok_or_else(|| format!("Coven stats {stream_name} reader was unavailable"))?
        .join()
        .map_err(|_| format!("Coven stats {stream_name} reader panicked"))?
}

fn terminate_and_reap(child: &mut Child) -> Result<(), String> {
    terminate_process_group(child.id());
    let _ = child.kill();
    child
        .wait()
        .map(|_| ())
        .map_err(|error| format!("failed to reap Coven stats process: {error}"))
}

#[cfg(unix)]
fn terminate_process_group(child_id: u32) {
    let process_group = -(child_id as i32);
    // The child is placed in its own process group before spawn, so this also
    // closes pipes inherited by any descendants before the readers are joined.
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_child_id: u32) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_TREE_COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TestTree {
        path: PathBuf,
    }

    impl TestTree {
        fn new(name: &str) -> Self {
            let unique = TEST_TREE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("pane-metrics-tests")
                .join(format!("{name}-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TestTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, contents).unwrap();
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(path, permissions).unwrap();
    }

    fn stats_json(project_dir: &Path, cost_usd: f64) -> Vec<u8> {
        format!(
            r#"{{
                "sessions": [{{
                    "session_id": "session",
                    "project_dir": "{}",
                    "input_tokens": 1,
                    "output_tokens": 2,
                    "cache_creation_tokens": 3,
                    "cache_read_tokens": 4,
                    "cost_usd": {cost_usd},
                    "last_ts": null
                }}]
            }}"#,
            project_dir.to_str().unwrap()
        )
        .into_bytes()
    }

    #[test]
    fn selects_exact_session_and_project_and_normalizes_values() {
        let raw = br#"{
            "sessions": [
                {
                    "session_id": "other-session",
                    "project_dir": "/repo/project",
                    "input_tokens": 1,
                    "output_tokens": 2,
                    "cache_creation_tokens": 3,
                    "cache_read_tokens": 4,
                    "cost_usd": 0.25,
                    "last_ts": "2026-08-10T20:00:00Z"
                },
                {
                    "session_id": "wanted-session",
                    "project_dir": "/repo/other",
                    "input_tokens": 5,
                    "output_tokens": 6,
                    "cache_creation_tokens": 7,
                    "cache_read_tokens": 8,
                    "cost_usd": 0.5,
                    "last_ts": "2026-08-10T20:01:00Z"
                },
                {
                    "session_id": "wanted-session",
                    "project_dir": "/repo/project",
                    "input_tokens": 101,
                    "output_tokens": 202,
                    "cache_creation_tokens": 303,
                    "cache_read_tokens": 404,
                    "cost_usd": 1.25,
                    "last_ts": "2026-08-10T20:02:00Z"
                }
            ]
        }"#;

        let metrics =
            normalize_coven_stats(raw, Path::new("/repo/project"), "wanted-session").unwrap();

        assert_eq!(
            metrics,
            PaneSessionMetrics {
                provider: "coven".to_string(),
                session_id: "wanted-session".to_string(),
                model: None,
                context_used: None,
                context_limit: None,
                cumulative_input_tokens: 101,
                cumulative_output_tokens: 202,
                cache_creation_tokens: 303,
                cache_read_tokens: 404,
                spend_usd: Some(1.25),
                cost_kind: "local-estimate".to_string(),
                updated_at: Some("2026-08-10T20:02:00Z".to_string()),
            }
        );
    }

    #[test]
    fn rejects_a_session_from_the_wrong_project() {
        let raw = br#"{
            "sessions": [{
                "session_id": "wanted-session",
                "project_dir": "/repo/other",
                "input_tokens": 1,
                "output_tokens": 2,
                "cache_creation_tokens": 3,
                "cache_read_tokens": 4,
                "cost_usd": 0.25,
                "last_ts": null
            }]
        }"#;

        assert!(normalize_coven_stats(raw, Path::new("/repo/project"), "wanted-session").is_err());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(normalize_coven_stats(b"{", Path::new("/repo/project"), "session").is_err());
    }

    #[test]
    fn rejects_oversized_output() {
        let raw = vec![b' '; MAX_STATS_BYTES + 1];

        assert!(normalize_coven_stats(&raw, Path::new("/repo/project"), "session").is_err());
    }

    #[test]
    fn preserves_zero_cost_as_a_local_estimate() {
        let metrics = normalize_coven_stats(
            &stats_json(Path::new("/repo/project"), 0.0),
            Path::new("/repo/project"),
            "session",
        )
        .unwrap();

        assert_eq!(metrics.spend_usd, Some(0.0));
        assert_eq!(metrics.cost_kind, "local-estimate");
    }

    #[test]
    fn preserves_positive_cost_as_a_local_estimate() {
        let metrics = normalize_coven_stats(
            &stats_json(Path::new("/repo/project"), 0.01),
            Path::new("/repo/project"),
            "session",
        )
        .unwrap();

        assert_eq!(metrics.spend_usd, Some(0.01));
        assert_eq!(metrics.cost_kind, "local-estimate");
    }

    #[test]
    fn treats_negative_cost_as_unreported() {
        let metrics = normalize_coven_stats(
            &stats_json(Path::new("/repo/project"), -0.01),
            Path::new("/repo/project"),
            "session",
        )
        .unwrap();

        assert_eq!(metrics.spend_usd, None);
        assert_eq!(metrics.cost_kind, "unknown");
    }

    #[cfg(unix)]
    #[test]
    fn runner_rejects_stdout_overflow() {
        let tree = TestTree::new("stdout-overflow");
        let coven = tree.path.join("coven");
        write_executable(
            &coven,
            "#!/bin/sh\nexec /bin/dd if=/dev/zero bs=2097153 count=1 2>/dev/null\n",
        );

        let error = load_coven_metrics_with_timeout(
            coven.to_str().unwrap(),
            &tree.path,
            "session",
            OsStr::new("/usr/bin:/bin"),
            Duration::from_secs(2),
        )
        .unwrap_err();

        assert!(error.contains("exceeded the 2 MiB limit"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn runner_enforces_timeout() {
        let tree = TestTree::new("timeout");
        let coven = tree.path.join("coven");
        write_executable(&coven, "#!/bin/sh\nwhile :; do :; done\n");
        let started = Instant::now();

        let error = load_coven_metrics_with_timeout(
            coven.to_str().unwrap(),
            &tree.path,
            "session",
            OsStr::new("/usr/bin:/bin"),
            Duration::from_millis(100),
        )
        .unwrap_err();

        assert!(error.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn runner_uses_explicit_path_for_shebang_interpreter() {
        let tree = TestTree::new("explicit-path");
        let stripped = tree.path.join("stripped");
        let augmented = tree.path.join("augmented");
        std::fs::create_dir_all(&stripped).unwrap();
        std::fs::create_dir_all(&augmented).unwrap();
        let coven = tree.path.join("coven");
        let fake_node = augmented.join("node");
        let json = String::from_utf8(stats_json(&tree.path, 0.5)).unwrap();
        write_executable(
            &coven,
            &format!("#!/usr/bin/env node\nprintf '%s' '{json}'\n"),
        );
        write_executable(&fake_node, "#!/bin/sh\nexec /bin/sh \"$@\"\n");

        let stripped_error = load_coven_metrics_with_timeout(
            coven.to_str().unwrap(),
            &tree.path,
            "session",
            stripped.as_os_str(),
            Duration::from_secs(2),
        )
        .unwrap_err();
        assert!(
            stripped_error.contains("command failed"),
            "{stripped_error}"
        );

        let path = std::env::join_paths([augmented, stripped]).unwrap();
        let metrics = load_coven_metrics_with_timeout(
            coven.to_str().unwrap(),
            &tree.path,
            "session",
            &path,
            Duration::from_secs(2),
        )
        .unwrap();

        assert_eq!(metrics.spend_usd, Some(0.5));
        assert_eq!(metrics.cost_kind, "local-estimate");
    }
}
