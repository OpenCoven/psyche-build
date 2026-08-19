use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
use tauri::State;

use crate::platform::{self, RuntimePlatformInfo};

const PROCESS_METRICS_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessMetrics {
    pub(crate) cpu_percent: f32,
    pub(crate) rss_bytes: u64,
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
        Some(ProcessMetrics {
            cpu_percent: process.cpu_usage(),
            rss_bytes: process.memory(),
        })
    }
}

struct ProcessMetricsCache<S> {
    source: S,
    selection: ProcessSelection,
    refresh_interval: Duration,
    last_refresh_at: Option<Instant>,
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
            cached: None,
        }
    }

    fn sample(&mut self) -> Option<ProcessMetrics> {
        self.sample_at(Instant::now())
    }

    fn sample_at(&mut self, now: Instant) -> Option<ProcessMetrics> {
        if self.should_refresh(now) {
            self.cached = self.source.sample_process(self.selection);
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
        ProcessMetrics {
            cpu_percent,
            rss_bytes,
        }
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
            Some(process_sample(10.0, 1_024))
        );
        assert_eq!(
            cache.sample_at(started_at.checked_add(Duration::from_millis(500)).unwrap()),
            Some(process_sample(10.0, 1_024))
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
    fn runtime_diagnostics_process_sampling_returns_none_when_current_process_is_unavailable() {
        let mut cache = ProcessMetricsCache::new(
            FakeProcessMetricsSource::with_responses([None]),
            Pid::from_u32(7),
            Duration::from_secs(1),
        );

        assert_eq!(cache.sample_at(Instant::now()), None);
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
