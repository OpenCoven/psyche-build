use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

const MAX_STATS_BYTES: usize = 2 * 1024 * 1024;

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
    let has_finite_cost = session.cost_usd.is_finite();

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
        spend_usd: has_finite_cost.then_some(session.cost_usd),
        cost_kind: if has_finite_cost {
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
) -> Result<PaneSessionMetrics, String> {
    let output = Command::new(coven_binary)
        .args(["code", "stats", "session", session_id, "--json"])
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("failed to run Coven stats: {error}"))?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

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
}
