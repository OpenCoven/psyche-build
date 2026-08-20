use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
use tauri::State;

use crate::coven_sessions::is_safe_session_id;
use crate::platform::{self, RuntimePlatformInfo};

const PROCESS_METRICS_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cpu_percent: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rss_bytes: Option<u64>,
}

impl ProcessMetrics {
    fn new(cpu_percent: Option<f32>, rss_bytes: Option<u64>) -> Option<Self> {
        if cpu_percent.is_none() && rss_bytes.is_none() {
            None
        } else {
            Some(Self {
                cpu_percent,
                rss_bytes,
            })
        }
    }

    fn without_cpu(self) -> Option<Self> {
        Self::new(None, self.rss_bytes)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRuntimeReport {
    pub(crate) os: &'static str,
    pub(crate) arch: &'static str,
    pub(crate) engine: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) engine_version: Option<String>,
    pub(crate) debug_build: bool,
    pub(crate) stress_authorized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) process: Option<ProcessMetrics>,
}

impl NativeRuntimeReport {
    pub(crate) fn from_parts(
        os: &'static str,
        arch: &'static str,
        engine: &'static str,
        engine_version: Option<String>,
        process: Option<ProcessMetrics>,
        debug_build: bool,
        stress_authorized: bool,
    ) -> Self {
        Self {
            os,
            arch,
            engine,
            engine_version,
            debug_build,
            stress_authorized,
            process,
        }
    }

    fn from_platform_info(
        platform_info: &RuntimePlatformInfo,
        debug_build: bool,
        stress_authorized: bool,
        process: Option<ProcessMetrics>,
    ) -> Self {
        Self::from_parts(
            platform_info.os,
            platform_info.arch,
            platform_info.webview_engine,
            platform_info.webview_version.clone(),
            process,
            debug_build,
            stress_authorized,
        )
    }
}

pub(crate) fn stress_authorized_for(debug_build: bool, startup_value: Option<&str>) -> bool {
    debug_build && matches!(startup_value, Some("1"))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DiagnosticsFixture {
    Steady,
    Burst,
    Rewrite,
}

pub(crate) struct DiagnosticsCommandSpec {
    pub(crate) program: &'static str,
    pub(crate) args: Vec<String>,
}

#[cfg(unix)]
const STEADY_FIXTURE_SCRIPT: &str = r#"sequence=0
while :
do
  printf '\033[32msteady:%d\033[0m\n' "$sequence"
  sequence=$((sequence + 1))
  sleep 0.05
done
"#;

#[cfg(unix)]
const BURST_FIXTURE_SCRIPT: &str = r#"sequence=0
while :
do
  printf '\033[1;31mburst:%d\033[0m\n' "$sequence"
  sequence=$((sequence + 1))
  printf '\033[1;33mburst:%d\033[0m\n' "$sequence"
  sequence=$((sequence + 1))
  printf '\033[1;32mburst:%d\033[0m\n' "$sequence"
  sequence=$((sequence + 1))
  printf '\033[1;36mburst:%d\033[0m\n' "$sequence"
  sequence=$((sequence + 1))
  sleep 0.05
done
"#;

#[cfg(unix)]
const REWRITE_FIXTURE_SCRIPT: &str = r#"sequence=0
while :
do
  printf '\033[2K\033[36mrewrite:%d\033[0m\r' "$sequence"
  sequence=$((sequence + 1))
  sleep 0.05
done
"#;

#[cfg(windows)]
const STEADY_FIXTURE_SCRIPT: &str = r#"$sequence = 0
while ($true) {
  Write-Host "$([char]27)[32msteady:$sequence$([char]27)[0m"
  $sequence++
  Start-Sleep -Milliseconds 50
}
"#;

#[cfg(windows)]
const BURST_FIXTURE_SCRIPT: &str = r#"$sequence = 0
while ($true) {
  1..4 | ForEach-Object {
    Write-Host "$([char]27)[1;31mburst:$sequence$([char]27)[0m"
    $sequence++
  }
  Start-Sleep -Milliseconds 50
}
"#;

#[cfg(windows)]
const REWRITE_FIXTURE_SCRIPT: &str = r#"$sequence = 0
while ($true) {
  Write-Host -NoNewline "$([char]27)[2K$([char]27)[36mrewrite:$sequence$([char]27)[0m`r"
  $sequence++
  Start-Sleep -Milliseconds 50
}
"#;

impl DiagnosticsFixture {
    pub(crate) fn command_spec(self) -> DiagnosticsCommandSpec {
        let script = match self {
            Self::Steady => STEADY_FIXTURE_SCRIPT,
            Self::Burst => BURST_FIXTURE_SCRIPT,
            Self::Rewrite => REWRITE_FIXTURE_SCRIPT,
        };

        #[cfg(unix)]
        {
            DiagnosticsCommandSpec {
                program: "/bin/sh",
                args: vec!["-c".to_string(), script.to_string()],
            }
        }

        #[cfg(windows)]
        {
            DiagnosticsCommandSpec {
                program: "powershell.exe",
                args: vec![
                    "-NoLogo".to_string(),
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    script.to_string(),
                ],
            }
        }
    }
}

pub(crate) fn fixture_start_options(
    thread_id: &str,
    fixture: DiagnosticsFixture,
) -> Result<crate::StartOptions, String> {
    if !is_safe_session_id(thread_id) {
        return Err("thread id is unsafe".to_string());
    }

    let spec = fixture.command_spec();
    Ok(crate::StartOptions {
        thread_id: thread_id.to_string(),
        project_root: Some(".".to_string()),
        cwd: None,
        launch_kind: None,
        coven_session_id: None,
        command: Some(spec.program.to_string()),
        args: Some(spec.args),
        cols: Some(120),
        rows: Some(40),
        env: None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessSelection {
    CurrentProcess(Pid),
}

impl ProcessSelection {
    fn pid(self) -> Pid {
        match self {
            Self::CurrentProcess(pid) => pid,
        }
    }

    fn refresh_targets(self) -> [Pid; 1] {
        [self.pid()]
    }
}

trait ProcessMetricsSource {
    fn sample_process(&mut self, selection: ProcessSelection) -> Option<ProcessMetrics>;
}

struct SysinfoProcessMetricsSource {
    system: sysinfo::System,
}

impl Default for SysinfoProcessMetricsSource {
    fn default() -> Self {
        Self {
            system: sysinfo::System::new(),
        }
    }
}

impl SysinfoProcessMetricsSource {
    fn refresh_kind() -> ProcessRefreshKind {
        ProcessRefreshKind::nothing().with_cpu().with_memory()
    }
}

impl ProcessMetricsSource for SysinfoProcessMetricsSource {
    fn sample_process(&mut self, selection: ProcessSelection) -> Option<ProcessMetrics> {
        let refresh_targets = selection.refresh_targets();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&refresh_targets),
            true,
            Self::refresh_kind(),
        );
        let process = self.system.process(selection.pid())?;
        ProcessMetrics::new(Some(process.cpu_usage()), Some(process.memory()))
    }
}

struct ProcessMetricsCache<S> {
    source: S,
    selection: ProcessSelection,
    refresh_interval: Duration,
    last_refresh_at: Option<Instant>,
    // sysinfo process CPU is delta-based, so the first refresh only primes it.
    cpu_refresh_primed: bool,
    cached: Option<ProcessMetrics>,
}

impl<S> ProcessMetricsCache<S>
where
    S: ProcessMetricsSource,
{
    fn new(source: S, pid: Pid, refresh_interval: Duration) -> Self {
        Self {
            source,
            selection: ProcessSelection::CurrentProcess(pid),
            refresh_interval,
            last_refresh_at: None,
            cpu_refresh_primed: false,
            cached: None,
        }
    }

    fn sample(&mut self) -> Option<ProcessMetrics> {
        self.sample_at(Instant::now())
    }

    fn sample_at(&mut self, now: Instant) -> Option<ProcessMetrics> {
        if self.should_refresh(now) {
            let sampled = self.source.sample_process(self.selection);
            self.cached = match sampled {
                Some(sampled) if self.cpu_refresh_primed => Some(sampled),
                Some(sampled) => {
                    self.cpu_refresh_primed = true;
                    sampled.without_cpu()
                }
                None => {
                    self.cpu_refresh_primed = false;
                    None
                }
            };
            self.last_refresh_at = Some(now);
        }
        self.cached
    }

    fn should_refresh(&self, now: Instant) -> bool {
        self.last_refresh_at
            .map(|last_refresh_at| {
                now.saturating_duration_since(last_refresh_at) >= self.refresh_interval
            })
            .unwrap_or(true)
    }
}

pub(crate) struct RuntimeDiagnosticsState {
    platform_info: RuntimePlatformInfo,
    debug_build: bool,
    stress_authorized: bool,
    process_metrics: Mutex<ProcessMetricsCache<SysinfoProcessMetricsSource>>,
}

impl RuntimeDiagnosticsState {
    pub(crate) fn from_startup() -> Self {
        let debug_build = cfg!(debug_assertions);
        let startup_stress_value = std::env::var("PSYCHE_RENDER_DIAGNOSTICS").ok();

        Self {
            platform_info: platform::runtime_info(),
            debug_build,
            stress_authorized: stress_authorized_for(debug_build, startup_stress_value.as_deref()),
            process_metrics: Mutex::new(ProcessMetricsCache::new(
                SysinfoProcessMetricsSource::default(),
                Pid::from_u32(std::process::id()),
                PROCESS_METRICS_REFRESH_INTERVAL,
            )),
        }
    }

    fn current_process_metrics(&self) -> Option<ProcessMetrics> {
        self.process_metrics.lock().sample()
    }

    pub(crate) fn ensure_stress_authorized(&self) -> Result<(), String> {
        if self.stress_authorized {
            Ok(())
        } else {
            Err("render diagnostics are not authorized".to_string())
        }
    }

    fn report(&self) -> NativeRuntimeReport {
        NativeRuntimeReport::from_platform_info(
            &self.platform_info,
            self.debug_build,
            self.stress_authorized,
            self.current_process_metrics(),
        )
    }
}

#[tauri::command]
pub(crate) fn runtime_diagnostics(
    state: State<'_, RuntimeDiagnosticsState>,
) -> NativeRuntimeReport {
    state.report()
}

#[tauri::command]
pub(crate) fn runtime_process_metrics(
    state: State<'_, RuntimeDiagnosticsState>,
) -> Option<ProcessMetrics> {
    state.current_process_metrics()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Debug)]
    struct FakeProcessMetricsSource {
        responses: VecDeque<Option<ProcessMetrics>>,
        selections: Vec<ProcessSelection>,
    }

    impl FakeProcessMetricsSource {
        fn with_responses(responses: impl IntoIterator<Item = Option<ProcessMetrics>>) -> Self {
            Self {
                responses: responses.into_iter().collect(),
                selections: Vec::new(),
            }
        }
    }

    impl ProcessMetricsSource for FakeProcessMetricsSource {
        fn sample_process(&mut self, selection: ProcessSelection) -> Option<ProcessMetrics> {
            self.selections.push(selection);
            self.responses.pop_front().flatten()
        }
    }

    fn process_sample(cpu_percent: f32, rss_bytes: u64) -> ProcessMetrics {
        ProcessMetrics::new(Some(cpu_percent), Some(rss_bytes)).unwrap()
    }

    fn process_sample_without_cpu(rss_bytes: u64) -> ProcessMetrics {
        ProcessMetrics::new(None, Some(rss_bytes)).unwrap()
    }

    #[test]
    fn runtime_diagnostics_report_omits_unavailable_engine_version_and_process() {
        let report = NativeRuntimeReport::from_parts(
            "linux",
            "x86_64",
            "WebKitGTK",
            None,
            None,
            true,
            false,
        );

        let json = serde_json::to_value(report).unwrap();

        assert!(json.get("engineVersion").is_none());
        assert!(json.get("process").is_none());
    }

    #[test]
    fn runtime_diagnostics_report_uses_exact_camel_case_fields() {
        let report = NativeRuntimeReport::from_parts(
            "macos",
            "aarch64",
            "WKWebView",
            Some("17.6".to_string()),
            Some(process_sample(18.5, 8_192)),
            true,
            true,
        );

        let json = serde_json::to_value(report).unwrap();
        let mut keys = json
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();

        assert_eq!(
            keys,
            vec![
                "arch",
                "debugBuild",
                "engine",
                "engineVersion",
                "os",
                "process",
                "stressAuthorized",
            ]
        );
        assert!(json.get("debug_build").is_none());
        assert!(json.get("engine_version").is_none());
        assert!(json.get("stress_authorized").is_none());

        let process = json
            .get("process")
            .and_then(serde_json::Value::as_object)
            .unwrap();
        let mut process_keys = process.keys().cloned().collect::<Vec<_>>();
        process_keys.sort();
        assert_eq!(process_keys, vec!["cpuPercent", "rssBytes"]);
        assert!(process.get("cpu_percent").is_none());
        assert!(process.get("rss_bytes").is_none());
    }

    #[test]
    fn runtime_diagnostics_stress_authorization_rejects_production_and_non_exact_opt_in() {
        assert!(!stress_authorized_for(false, Some("1")));
        assert!(!stress_authorized_for(true, None));
        assert!(!stress_authorized_for(true, Some("0")));
        assert!(!stress_authorized_for(true, Some("true")));
        assert!(!stress_authorized_for(true, Some(" 1 ")));
        assert!(stress_authorized_for(true, Some("1")));
    }

    #[test]
    fn diagnostics_fixture_serializes_only_the_fixed_lowercase_values() {
        for (fixture, expected) in [
            (DiagnosticsFixture::Steady, "steady"),
            (DiagnosticsFixture::Burst, "burst"),
            (DiagnosticsFixture::Rewrite, "rewrite"),
        ] {
            assert_eq!(
                serde_json::to_string(&fixture).unwrap(),
                format!("\"{expected}\"")
            );
            assert_eq!(
                serde_json::from_str::<DiagnosticsFixture>(&format!("\"{expected}\"")).unwrap(),
                fixture
            );
        }
    }

    #[test]
    fn diagnostics_fixture_rejects_arbitrary_values_and_unknown_fields() {
        assert!(serde_json::from_str::<DiagnosticsFixture>("\"custom\"").is_err());
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        #[allow(dead_code)]
        struct FixtureRequest {
            fixture: DiagnosticsFixture,
        }

        assert!(
            serde_json::from_str::<FixtureRequest>(r#"{"fixture":"steady","extra":true}"#).is_err()
        );
    }

    #[test]
    fn diagnostics_fixture_command_specs_are_fixed_and_platform_specific() {
        for fixture in [
            DiagnosticsFixture::Steady,
            DiagnosticsFixture::Burst,
            DiagnosticsFixture::Rewrite,
        ] {
            let spec = fixture.command_spec();
            #[cfg(unix)]
            {
                assert_eq!(spec.program, "/bin/sh");
                assert_eq!(spec.args.len(), 2);
                assert_eq!(spec.args[0], "-c");
                assert!(spec.args[1].contains("sequence=$((sequence + 1))"));
                assert!(spec.args[1].contains("\\033"));
            }
            #[cfg(windows)]
            {
                assert_eq!(spec.program, "powershell.exe");
                assert_eq!(
                    &spec.args[..4],
                    &[
                        "-NoLogo".to_string(),
                        "-NoProfile".to_string(),
                        "-NonInteractive".to_string(),
                        "-Command".to_string()
                    ]
                );
                assert!(spec.args[4].contains("$sequence++"));
                assert!(spec.args[4].contains("[char]27"));
            }
        }
    }

    #[test]
    fn diagnostics_fixture_start_options_validate_thread_ids_and_fix_commands() {
        assert_eq!(
            fixture_start_options("../unsafe", DiagnosticsFixture::Rewrite).unwrap_err(),
            "thread id is unsafe"
        );

        let options = fixture_start_options("stress-1", DiagnosticsFixture::Burst).unwrap();
        assert_eq!(options.thread_id, "stress-1");
        assert_eq!(options.project_root.as_deref(), Some("."));
        assert!(options.command.is_some());
        assert!(options.args.is_some());
        assert!(options.env.is_none());
        assert!(options.launch_kind.is_none());
    }

    #[test]
    fn runtime_diagnostics_state_exposes_authorization_without_rereading_environment() {
        let state = RuntimeDiagnosticsState {
            platform_info: platform::runtime_info(),
            debug_build: false,
            stress_authorized: false,
            process_metrics: Mutex::new(ProcessMetricsCache::new(
                SysinfoProcessMetricsSource::default(),
                Pid::from_u32(1),
                PROCESS_METRICS_REFRESH_INTERVAL,
            )),
        };

        assert_eq!(
            state.ensure_stress_authorized().unwrap_err(),
            "render diagnostics are not authorized"
        );
    }

    #[test]
    fn runtime_diagnostics_process_sampling_refreshes_on_a_bounded_cadence() {
        let pid = Pid::from_u32(41);
        let mut cache = ProcessMetricsCache::new(
            FakeProcessMetricsSource::with_responses([
                Some(process_sample(10.0, 1_024)),
                Some(process_sample(40.0, 2_048)),
            ]),
            pid,
            Duration::from_secs(1),
        );
        let started_at = Instant::now();

        assert_eq!(
            cache.sample_at(started_at),
            Some(process_sample_without_cpu(1_024))
        );
        assert_eq!(
            cache.sample_at(started_at.checked_add(Duration::from_millis(500)).unwrap()),
            Some(process_sample_without_cpu(1_024))
        );
        assert_eq!(
            cache.sample_at(started_at.checked_add(Duration::from_secs(1)).unwrap()),
            Some(process_sample(40.0, 2_048))
        );

        assert_eq!(
            cache.source.selections,
            vec![
                ProcessSelection::CurrentProcess(pid),
                ProcessSelection::CurrentProcess(pid),
            ]
        );
    }

    #[test]
    fn runtime_diagnostics_process_sampling_omits_initial_cpu_until_a_later_refresh() {
        let mut cache = ProcessMetricsCache::new(
            FakeProcessMetricsSource::with_responses([
                Some(process_sample(0.0, 1_024)),
                Some(process_sample(40.0, 2_048)),
            ]),
            Pid::from_u32(17),
            Duration::from_secs(1),
        );
        let started_at = Instant::now();

        let first_sample = serde_json::to_value(cache.sample_at(started_at).unwrap()).unwrap();
        assert!(first_sample.get("cpuPercent").is_none());
        assert_eq!(
            first_sample
                .get("rssBytes")
                .and_then(|value| value.as_u64()),
            Some(1_024)
        );

        let second_sample = serde_json::to_value(
            cache
                .sample_at(started_at.checked_add(Duration::from_secs(1)).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            second_sample
                .get("cpuPercent")
                .and_then(|value| value.as_f64()),
            Some(40.0)
        );
        assert_eq!(
            second_sample
                .get("rssBytes")
                .and_then(|value| value.as_u64()),
            Some(2_048)
        );
    }

    #[test]
    fn runtime_diagnostics_process_sampling_returns_none_when_current_process_is_unavailable() {
        let mut cache = ProcessMetricsCache::new(
            FakeProcessMetricsSource::with_responses([None]),
            Pid::from_u32(7),
            Duration::from_secs(1),
        );

        assert_eq!(cache.sample_at(Instant::now()), None);
    }

    #[test]
    fn runtime_diagnostics_process_sampling_recovery_omits_cpu_until_a_later_successful_refresh() {
        let mut cache = ProcessMetricsCache::new(
            FakeProcessMetricsSource::with_responses([
                None,
                Some(process_sample(20.0, 1_024)),
                Some(process_sample(40.0, 2_048)),
            ]),
            Pid::from_u32(23),
            Duration::from_secs(1),
        );
        let started_at = Instant::now();

        assert_eq!(cache.sample_at(started_at), None);
        assert_eq!(
            cache.sample_at(started_at.checked_add(Duration::from_secs(1)).unwrap()),
            Some(process_sample_without_cpu(1_024))
        );
        assert_eq!(
            cache.sample_at(started_at.checked_add(Duration::from_secs(2)).unwrap()),
            Some(process_sample(40.0, 2_048))
        );
    }

    #[test]
    fn runtime_diagnostics_report_never_serializes_environment_data() {
        let startup_value = "super-secret-render-opt-in";
        let report = NativeRuntimeReport::from_parts(
            "windows",
            "x86_64",
            "WebView2",
            Some("128.0".to_string()),
            None,
            true,
            stress_authorized_for(true, Some(startup_value)),
        );

        let json = serde_json::to_value(report).unwrap();
        let serialized = serde_json::to_string(&json).unwrap();

        assert!(json.get("env").is_none());
        assert!(json.get("environment").is_none());
        assert!(!serialized.contains("PSYCHE_RENDER_DIAGNOSTICS"));
        assert!(!serialized.contains(startup_value));
    }

    #[test]
    fn runtime_diagnostics_current_process_refresh_targets_encode_a_single_pid_selection() {
        let pid = Pid::from_u32(99);
        let selection = ProcessSelection::CurrentProcess(pid);
        let refresh_targets = selection.refresh_targets();

        match ProcessesToUpdate::Some(&refresh_targets) {
            ProcessesToUpdate::Some(pids) => assert_eq!(pids, &[pid]),
            ProcessesToUpdate::All => panic!("expected a current-process-only refresh"),
        }
    }
}
