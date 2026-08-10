use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};

#[derive(Clone, Debug, PartialEq)]
struct ProcessSample {
    pid: u32,
    parent: Option<u32>,
    name: String,
    cpu_percent: f32,
    memory_bytes: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TrackedPty {
    pub thread_id: String,
    pub pid: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsScope {
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessMetrics {
    pub thread_id: String,
    pub process_name: String,
    pub pid: u32,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AggregateMetrics {
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MetricsSnapshot {
    pub sampled_at_ms: u64,
    pub total_memory_bytes: u64,
    pub used_memory_bytes: u64,
    pub memory_pressure_percent: f32,
    pub workspace: AggregateMetrics,
    pub processes: Vec<ProcessMetrics>,
}

pub(crate) struct MetricsCollector {
    system: sysinfo::System,
}

impl Default for MetricsCollector {
    fn default() -> Self {
        let mut system = sysinfo::System::new_all();
        system.refresh_memory();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        Self { system }
    }
}

impl MetricsCollector {
    pub(crate) fn snapshot(
        &mut self,
        app_pid: u32,
        tracked: &[TrackedPty],
        scope: MetricsScope,
    ) -> MetricsSnapshot {
        self.system.refresh_memory();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );

        let samples = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| ProcessSample {
                pid: pid.as_u32(),
                parent: process.parent().map(|parent| parent.as_u32()),
                name: process.name().to_string_lossy().into_owned(),
                cpu_percent: process.cpu_usage(),
                memory_bytes: process.memory(),
            })
            .collect::<Vec<_>>();

        let mut snapshot = aggregate_samples(
            &samples,
            app_pid,
            tracked,
            scope.thread_id.as_deref(),
            self.system.cpus().len(),
        );
        let sampled_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        snapshot.sampled_at_ms = sampled_at_ms;
        snapshot.total_memory_bytes = self.system.total_memory();
        snapshot.used_memory_bytes = self.system.used_memory();
        snapshot.memory_pressure_percent = if snapshot.total_memory_bytes == 0 {
            0.0
        } else {
            (snapshot.used_memory_bytes as f32 / snapshot.total_memory_bytes as f32) * 100.0
        };
        snapshot
    }
}

fn descendants(samples: &[ProcessSample], root: u32) -> HashSet<u32> {
    let present = samples.iter().any(|sample| sample.pid == root);
    if !present {
        return HashSet::new();
    }

    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for sample in samples {
        if let Some(parent) = sample.parent {
            children_by_parent
                .entry(parent)
                .or_default()
                .push(sample.pid);
        }
    }

    let mut seen = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&pid) {
            stack.extend(children.iter().copied());
        }
    }

    seen
}

fn aggregate_set(
    samples: &[ProcessSample],
    pids: &HashSet<u32>,
    cpu_count: usize,
) -> AggregateMetrics {
    let divisor = cpu_count.max(1) as f32;
    let (cpu_percent, memory_bytes) = samples
        .iter()
        .filter(|sample| pids.contains(&sample.pid))
        .fold((0.0, 0_u64), |(cpu_total, memory_total), sample| {
            (
                cpu_total + sample.cpu_percent,
                memory_total + sample.memory_bytes,
            )
        });

    AggregateMetrics {
        cpu_percent: cpu_percent / divisor,
        memory_bytes,
    }
}

fn aggregate_samples(
    samples: &[ProcessSample],
    app_pid: u32,
    tracked: &[TrackedPty],
    focused_thread_id: Option<&str>,
    cpu_count: usize,
) -> MetricsSnapshot {
    let sample_by_pid = samples
        .iter()
        .map(|sample| (sample.pid, sample))
        .collect::<HashMap<_, _>>();

    let process_rows = tracked
        .iter()
        .filter(|pty| {
            focused_thread_id
                .map(|focused| pty.thread_id == focused)
                .unwrap_or(true)
        })
        .filter_map(|pty| {
            let root = sample_by_pid.get(&pty.pid)?;
            let pids = descendants(samples, pty.pid);
            if pids.is_empty() {
                return None;
            }
            let aggregate = aggregate_set(samples, &pids, cpu_count);
            Some(ProcessMetrics {
                thread_id: pty.thread_id.clone(),
                process_name: root.name.clone(),
                pid: pty.pid,
                cpu_percent: aggregate.cpu_percent,
                memory_bytes: aggregate.memory_bytes,
            })
        })
        .collect::<Vec<_>>();

    let workspace_pids = if let Some(focused_thread_id) = focused_thread_id {
        tracked
            .iter()
            .find(|pty| pty.thread_id == focused_thread_id)
            .map(|pty| descendants(samples, pty.pid))
            .unwrap_or_default()
    } else {
        let mut pids = descendants(samples, app_pid);
        for pty in tracked {
            pids.extend(descendants(samples, pty.pid));
        }
        pids
    };

    let mut processes = process_rows;
    processes.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

    MetricsSnapshot {
        sampled_at_ms: 0,
        total_memory_bytes: 0,
        used_memory_bytes: 0,
        memory_pressure_percent: 0.0,
        workspace: aggregate_set(samples, &workspace_pids, cpu_count),
        processes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn sample(
        pid: u32,
        parent: Option<u32>,
        name: &str,
        cpu_percent: f32,
        memory_bytes: u64,
    ) -> ProcessSample {
        ProcessSample {
            pid,
            parent,
            name: name.to_string(),
            cpu_percent,
            memory_bytes,
        }
    }

    fn tracked(thread_id: &str, pid: u32) -> TrackedPty {
        TrackedPty {
            thread_id: thread_id.to_string(),
            pid,
        }
    }

    #[test]
    fn aggregate_samples_builds_workspace_and_focus_views() {
        let samples = vec![
            sample(10, None, "app", 40.0, 100),
            sample(20, Some(10), "pty-a", 20.0, 200),
            sample(21, Some(20), "child-a", 80.0, 300),
            sample(30, Some(10), "pty-b", 60.0, 400),
        ];
        let tracked = vec![tracked("b", 30), tracked("a", 20)];

        let workspace = aggregate_samples(&samples, 10, &tracked, None, 4);

        assert_eq!(workspace.sampled_at_ms, 0);
        assert_eq!(workspace.total_memory_bytes, 0);
        assert_eq!(workspace.used_memory_bytes, 0);
        assert_eq!(workspace.memory_pressure_percent, 0.0);
        assert_eq!(workspace.workspace.memory_bytes, 1_000);
        assert!((workspace.workspace.cpu_percent - 50.0).abs() < f32::EPSILON);
        assert_eq!(workspace.processes.len(), 2);
        assert_eq!(workspace.processes[0].thread_id, "a");
        assert_eq!(workspace.processes[0].memory_bytes, 500);
        assert_eq!(workspace.processes[1].thread_id, "b");

        let focused = aggregate_samples(&samples, 10, &tracked, Some("a"), 4);

        assert_eq!(focused.workspace.memory_bytes, 500);
        assert!((focused.workspace.cpu_percent - 25.0).abs() < f32::EPSILON);
        assert_eq!(focused.processes.len(), 1);
        assert_eq!(focused.processes[0].thread_id, "a");
    }

    #[test]
    fn aggregate_samples_omits_missing_tracked_roots() {
        let samples = vec![
            sample(10, None, "app", 40.0, 100),
            sample(20, Some(10), "pty-a", 20.0, 200),
        ];
        let tracked = vec![tracked("missing", 999), tracked("a", 20)];

        let snapshot = aggregate_samples(&samples, 10, &tracked, None, 4);

        assert_eq!(snapshot.processes.len(), 1);
        assert_eq!(snapshot.processes[0].thread_id, "a");
    }

    #[test]
    fn descendants_returns_root_and_descendants_recursively() {
        let samples = vec![
            sample(1, None, "root", 0.0, 0),
            sample(2, Some(1), "child", 0.0, 0),
            sample(3, Some(2), "grandchild", 0.0, 0),
            sample(4, Some(1), "sibling", 0.0, 0),
        ];

        let result = descendants(&samples, 1);

        assert_eq!(result, HashSet::from([1, 2, 3, 4]));
    }

    #[test]
    fn aggregate_set_uses_minimum_cpu_divisor_of_one() {
        let samples = vec![sample(7, None, "proc", 12.5, 64)];
        let pids = HashSet::from([7]);

        let aggregate = aggregate_set(&samples, &pids, 0);

        assert_eq!(
            aggregate,
            AggregateMetrics {
                cpu_percent: 12.5,
                memory_bytes: 64,
            }
        );
    }
}
