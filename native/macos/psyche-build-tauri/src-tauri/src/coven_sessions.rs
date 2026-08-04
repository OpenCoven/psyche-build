use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const STABLE_API_VERSION: &str = "coven.daemon.v1";

#[derive(Debug, PartialEq, Eq)]
enum CovenEndpoint {
    Unix(PathBuf),
    Http(SocketAddr),
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CovenSessionSummary {
    id: String,
    project_root: String,
    cwd: Option<String>,
    harness: Option<String>,
    title: Option<String>,
    status: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    archived_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CovenSessionsResponse {
    status: String,
    sessions: Vec<CovenSessionSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn resolve_endpoint(env: &HashMap<String, String>, home: &Path) -> Result<CovenEndpoint, String> {
    if let Some(socket) = env.get("COVEN_SOCKET").filter(|value| !value.is_empty()) {
        return Ok(CovenEndpoint::Unix(PathBuf::from(socket)));
    }

    let has_url = env.contains_key("COVEN_URL");
    let has_port = env.contains_key("COVEN_PORT");

    if !has_url && !has_port {
        if let Some(coven_home) = env.get("COVEN_HOME").filter(|value| !value.is_empty()) {
            return Ok(CovenEndpoint::Unix(
                Path::new(coven_home).join("coven.sock"),
            ));
        }
    }

    if has_url {
        return parse_coven_url(env.get("COVEN_URL").expect("checked above"));
    }

    if has_port {
        let port = env
            .get("COVEN_PORT")
            .expect("checked above")
            .parse::<u16>()
            .map_err(|_| "COVEN_PORT must be a nonzero u16".to_string())?;
        if port == 0 {
            return Err("COVEN_PORT must be a nonzero u16".to_string());
        }
        return Ok(CovenEndpoint::Http(SocketAddr::from((
            [127, 0, 0, 1],
            port,
        ))));
    }

    Ok(CovenEndpoint::Unix(home.join(".coven").join("coven.sock")))
}

fn parse_coven_url(value: &str) -> Result<CovenEndpoint, String> {
    let endpoint = parse_raw_coven_authority(value)?;
    let url = Url::parse(value).map_err(|error| format!("invalid COVEN_URL: {error}"))?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("COVEN_URL must not include a query, fragment, or non-root path".to_string());
    }

    Ok(CovenEndpoint::Http(endpoint))
}

fn parse_raw_coven_authority(value: &str) -> Result<SocketAddr, String> {
    let remainder = value
        .strip_prefix("http://")
        .ok_or_else(|| "COVEN_URL must use the literal http:// scheme".to_string())?;
    let authority_end = remainder
        .find(|character| matches!(character, '/' | '?' | '#'))
        .unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    if authority.contains('@') {
        return Err("COVEN_URL must not include user info".to_string());
    }

    let (host, port) = if let Some(port) = authority.strip_prefix("[::1]:") {
        ("[::1]", port)
    } else {
        authority
            .split_once(':')
            .ok_or_else(|| "COVEN_URL must include an explicit port".to_string())?
    };
    let port = parse_explicit_port(port)?;
    let address = match host {
        "127.0.0.1" => IpAddr::from([127, 0, 0, 1]),
        "localhost" => IpAddr::from([127, 0, 0, 1]),
        "[::1]" => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => return Err("COVEN_URL host must be 127.0.0.1, localhost, or [::1]".to_string()),
    };

    Ok(SocketAddr::new(address, port))
}

fn parse_explicit_port(value: &str) -> Result<u16, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("COVEN_URL must include a nonzero decimal u16 port".to_string());
    }
    let port = value
        .parse::<u16>()
        .map_err(|_| "COVEN_URL must include a nonzero decimal u16 port".to_string())?;
    if port == 0 {
        return Err("COVEN_URL must include a nonzero decimal u16 port".to_string());
    }
    Ok(port)
}

fn is_safe_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn normalize_sessions(
    value: Value,
    requested_roots: &[PathBuf],
) -> Result<Vec<CovenSessionSummary>, String> {
    let sessions = match value {
        Value::Array(sessions) => sessions,
        Value::Object(mut envelope) => match envelope.remove("sessions") {
            Some(Value::Array(sessions)) => sessions,
            _ => {
                return Err(
                    "Coven sessions response must be a list or an object with a sessions list"
                        .to_string(),
                )
            }
        },
        _ => {
            return Err(
                "Coven sessions response must be a list or an object with a sessions list"
                    .to_string(),
            )
        }
    };

    let requested_roots = canonical_requested_roots(requested_roots);
    Ok(sessions
        .iter()
        .filter_map(|session| normalize_session(session, &requested_roots))
        .collect())
}

fn canonical_requested_roots(requested_roots: &[PathBuf]) -> HashMap<PathBuf, String> {
    let mut canonical_roots = HashMap::new();
    let mut seen = HashSet::new();
    for requested_root in requested_roots {
        let Ok(canonical_root) = requested_root.canonicalize() else {
            continue;
        };
        if !canonical_root.is_dir() || !seen.insert(canonical_root.clone()) {
            continue;
        }
        canonical_roots.insert(
            canonical_root,
            requested_root.to_string_lossy().into_owned(),
        );
    }
    canonical_roots
}

fn normalize_session(
    value: &Value,
    requested_roots: &HashMap<PathBuf, String>,
) -> Option<CovenSessionSummary> {
    let fields = value.as_object()?;
    let id = required_string(fields, "id", "id")?;
    if !is_safe_session_id(id) {
        return None;
    }
    let project_root = required_string(fields, "projectRoot", "project_root")?;
    if project_root.is_empty() {
        return None;
    }
    let canonical_project_root = Path::new(project_root).canonicalize().ok()?;
    let requested_project_root = requested_roots.get(&canonical_project_root)?;

    let cwd = optional_string(fields, "cwd", "cwd")?;
    let cwd = cwd.and_then(|cwd| {
        Path::new(&cwd)
            .canonicalize()
            .ok()
            .filter(|canonical_cwd| canonical_cwd.starts_with(&canonical_project_root))
            .map(|_| cwd)
    });

    Some(CovenSessionSummary {
        id: id.to_string(),
        project_root: requested_project_root.clone(),
        cwd,
        harness: optional_string(fields, "harness", "harness")?,
        title: optional_string(fields, "title", "title")?,
        status: optional_string(fields, "status", "status")?,
        created_at: optional_string(fields, "createdAt", "created_at")?,
        updated_at: optional_string(fields, "updatedAt", "updated_at")?,
        archived_at: optional_string(fields, "archivedAt", "archived_at")?,
    })
}

fn required_string<'a>(
    fields: &'a Map<String, Value>,
    camel_case: &str,
    snake_case: &str,
) -> Option<&'a str> {
    fields
        .get(camel_case)
        .or_else(|| fields.get(snake_case))?
        .as_str()
}

fn optional_string(
    fields: &Map<String, Value>,
    camel_case: &str,
    snake_case: &str,
) -> Option<Option<String>> {
    let Some(value) = fields.get(camel_case).or_else(|| fields.get(snake_case)) else {
        return Some(None);
    };
    if value.is_null() {
        return Some(None);
    }
    let value = value.as_str()?.trim();
    Some((!value.is_empty()).then(|| value.to_string()))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::*;

    static TEMP_TREE_COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new(name: &str) -> Self {
            let suffix = TEMP_TREE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "psyche-build-coven-sessions-{name}-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn directory(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[cfg(unix)]
    struct PermissionsGuard {
        path: PathBuf,
        original_mode: u32,
    }

    #[cfg(unix)]
    impl PermissionsGuard {
        fn remove_execute_permissions(path: &Path) -> Self {
            let original_mode = fs::metadata(path).unwrap().permissions().mode();
            let mut restricted = fs::metadata(path).unwrap().permissions();
            restricted.set_mode(original_mode & !0o111);
            fs::set_permissions(path, restricted).unwrap();
            Self {
                path: path.to_path_buf(),
                original_mode,
            }
        }
    }

    #[cfg(unix)]
    impl Drop for PermissionsGuard {
        fn drop(&mut self) {
            fs::set_permissions(&self.path, fs::Permissions::from_mode(self.original_mode))
                .unwrap();
        }
    }

    #[test]
    fn resolves_socket_before_home_network_and_default_endpoints() {
        let mut env = HashMap::new();
        env.insert("COVEN_SOCKET".to_string(), "/tmp/explicit.sock".to_string());
        env.insert("COVEN_HOME".to_string(), "/tmp/coven-home".to_string());
        env.insert("COVEN_URL".to_string(), "http://127.0.0.1:7777".to_string());

        assert_eq!(
            resolve_endpoint(&env, Path::new("/Users/tester")).unwrap(),
            CovenEndpoint::Unix("/tmp/explicit.sock".into())
        );

        env.remove("COVEN_SOCKET");
        assert_eq!(
            resolve_endpoint(&env, Path::new("/Users/tester")).unwrap(),
            CovenEndpoint::Http("127.0.0.1:7777".parse().unwrap())
        );

        env.remove("COVEN_URL");
        env.insert("COVEN_PORT".to_string(), "7778".to_string());
        assert_eq!(
            resolve_endpoint(&env, Path::new("/Users/tester")).unwrap(),
            CovenEndpoint::Http("127.0.0.1:7778".parse().unwrap())
        );

        env.remove("COVEN_PORT");
        assert_eq!(
            resolve_endpoint(&env, Path::new("/Users/tester")).unwrap(),
            CovenEndpoint::Unix("/tmp/coven-home/coven.sock".into())
        );

        env.remove("COVEN_HOME");
        assert_eq!(
            resolve_endpoint(&env, Path::new("/Users/tester")).unwrap(),
            CovenEndpoint::Unix("/Users/tester/.coven/coven.sock".into())
        );
    }

    #[test]
    fn accepts_only_safe_session_identifiers() {
        assert!(is_safe_session_id("release:fix_01.a-b"));

        for unsafe_id in ["", "has spaces", "$(touch /tmp/pwned)", &"a".repeat(129)] {
            assert!(!is_safe_session_id(unsafe_id));
        }
    }

    #[test]
    fn rejects_non_loopback_coven_urls() {
        for url in ["http://192.0.2.10:7777", "http://127.0.0.2:7777"] {
            let mut env = HashMap::new();
            env.insert("COVEN_URL".to_string(), url.to_string());

            assert!(resolve_endpoint(&env, Path::new("/Users/tester")).is_err());
        }
    }

    #[test]
    fn accepts_all_supported_loopback_coven_url_hosts() {
        for (url, expected) in [
            ("http://127.0.0.1:7001", "127.0.0.1:7001"),
            ("http://127.0.0.1:80", "127.0.0.1:80"),
            ("http://localhost:7002", "127.0.0.1:7002"),
            ("http://[::1]:7003", "[::1]:7003"),
        ] {
            let mut env = HashMap::new();
            env.insert("COVEN_URL".to_string(), url.to_string());
            assert_eq!(
                resolve_endpoint(&env, Path::new("/Users/tester")).unwrap(),
                CovenEndpoint::Http(expected.parse().unwrap())
            );
        }
    }

    #[test]
    fn validates_raw_coven_url_authority_before_normalization() {
        for url in [
            "http://@127.0.0.1:7777",
            "http://user:password@127.0.0.1:7777",
            "http://2130706433:7777",
            "http://127.1:7777",
            "http://127.0.0.1",
            "http://127.0.0.1:7777/not-root",
            "http://127.0.0.1:7777?query=value",
            "http://127.0.0.1:7777#fragment",
        ] {
            let mut env = HashMap::new();
            env.insert("COVEN_URL".to_string(), url.to_string());

            assert!(resolve_endpoint(&env, Path::new("/Users/tester")).is_err());
        }
    }

    #[test]
    fn rejects_zero_coven_port() {
        let mut env = HashMap::new();
        env.insert("COVEN_PORT".to_string(), "0".to_string());

        assert!(resolve_endpoint(&env, Path::new("/Users/tester")).is_err());
    }

    #[test]
    fn rejects_zero_port_in_coven_url() {
        let mut env = HashMap::new();
        env.insert("COVEN_URL".to_string(), "http://127.0.0.1:0".to_string());

        assert!(resolve_endpoint(&env, Path::new("/Users/tester")).is_err());
    }

    #[test]
    fn does_not_fall_back_to_coven_home_when_network_configuration_is_empty() {
        let mut env = HashMap::new();
        env.insert("COVEN_HOME".to_string(), "/tmp/coven-home".to_string());
        env.insert("COVEN_URL".to_string(), String::new());

        assert!(resolve_endpoint(&env, Path::new("/Users/tester")).is_err());
    }

    #[test]
    fn serializes_the_command_response_in_camel_case() {
        let response = CovenSessionsResponse {
            status: "ok".to_string(),
            sessions: vec![CovenSessionSummary {
                id: "session".to_string(),
                project_root: "/project".to_string(),
                cwd: None,
                harness: None,
                title: None,
                status: Some("active".to_string()),
                created_at: None,
                updated_at: None,
                archived_at: None,
            }],
            message: None,
        };

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "status": "ok",
                "sessions": [{
                    "id": "session",
                    "projectRoot": "/project",
                    "cwd": null,
                    "harness": null,
                    "title": null,
                    "status": "active",
                    "createdAt": null,
                    "updatedAt": null,
                    "archivedAt": null
                }]
            })
        );
    }

    #[test]
    fn defines_the_daemon_adapter_limits() {
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(2));
        assert_eq!(READ_TIMEOUT, Duration::from_secs(2));
        assert_eq!(MAX_RESPONSE_BYTES, 1024 * 1024);
        assert_eq!(STABLE_API_VERSION, "coven.daemon.v1");
    }

    #[test]
    fn normalizes_list_and_object_envelopes() {
        let tree = TempTree::new("envelopes");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let session = json!({ "id": "list-session", "projectRoot": project });

        for payload in [json!([session.clone()]), json!({ "sessions": [session] })] {
            let sessions = normalize_sessions(payload, &requested).unwrap();
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].id, "list-session");
        }
    }

    #[test]
    fn rejects_malformed_session_envelopes() {
        let tree = TempTree::new("malformed-envelope");
        let requested = vec![tree.directory("project")];

        assert!(normalize_sessions(json!({ "sessions": {} }), &requested).is_err());
        assert!(normalize_sessions(json!({ "notSessions": [] }), &requested).is_err());
    }

    #[test]
    fn normalizes_camel_and_snake_case_session_fields() {
        let tree = TempTree::new("field-names");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let payload = json!({
            "sessions": [
                {
                    "id": "camel",
                    "projectRoot": project,
                    "cwd": "  ",
                    "harness": "  codex  ",
                    "title": "  title  ",
                    "status": "  active  ",
                    "createdAt": "  c1  ",
                    "updatedAt": "  u1  ",
                    "archivedAt": "  a1  "
                },
                {
                    "id": "snake",
                    "project_root": project,
                    "created_at": "c2",
                    "updated_at": "u2",
                    "archived_at": "a2"
                }
            ]
        });

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].harness.as_deref(), Some("codex"));
        assert_eq!(sessions[0].title.as_deref(), Some("title"));
        assert_eq!(sessions[0].status.as_deref(), Some("active"));
        assert_eq!(sessions[0].created_at.as_deref(), Some("c1"));
        assert_eq!(sessions[0].updated_at.as_deref(), Some("u1"));
        assert_eq!(sessions[0].archived_at.as_deref(), Some("a1"));
        assert_eq!(sessions[0].cwd, None);
        assert_eq!(sessions[1].created_at.as_deref(), Some("c2"));
        assert_eq!(sessions[1].updated_at.as_deref(), Some("u2"));
        assert_eq!(sessions[1].archived_at.as_deref(), Some("a2"));
    }

    #[test]
    fn ignores_missing_and_non_directory_requested_roots() {
        let tree = TempTree::new("invalid-roots");
        let valid = tree.directory("valid");
        let missing = tree.root.join("missing");
        let file = tree.root.join("not-a-directory");
        fs::write(&file, "not a directory").unwrap();
        let requested = vec![missing, file, valid.clone()];
        let payload = json!([{ "id": "valid", "projectRoot": valid }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "valid");
    }

    #[cfg(unix)]
    #[test]
    fn ignores_unreadable_requested_roots_without_losing_valid_siblings() {
        let tree = TempTree::new("unreadable-root");
        let valid = tree.directory("valid");
        let inaccessible_parent = tree.directory("inaccessible");
        let unreadable = inaccessible_parent.join("project");
        fs::create_dir_all(&unreadable).unwrap();
        let permissions = PermissionsGuard::remove_execute_permissions(&inaccessible_parent);

        assert!(unreadable.canonicalize().is_err());
        let requested = vec![unreadable, valid.clone()];
        let payload = json!([{ "id": "valid", "projectRoot": valid }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "valid");

        drop(permissions);
    }

    #[test]
    fn scopes_sessions_by_exact_canonical_project_root() {
        let tree = TempTree::new("sibling-roots");
        let app = tree.directory("app");
        let application = tree.directory("application");
        let requested = vec![app.clone()];
        let payload = json!([
            { "id": "app", "projectRoot": app },
            { "id": "application", "projectRoot": application }
        ]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "app");
    }

    #[test]
    fn keeps_only_cwds_within_the_matched_project_root() {
        let tree = TempTree::new("cwd-scope");
        let project = tree.directory("project");
        let inside = tree.directory("project/inside");
        let outside = tree.directory("outside");
        let requested = vec![project.clone()];
        let payload = json!([
            { "id": "inside", "projectRoot": project, "cwd": inside },
            { "id": "outside", "projectRoot": project, "cwd": outside }
        ]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions[0].cwd.as_deref(),
            Some(inside.to_string_lossy().as_ref())
        );
        assert_eq!(sessions[1].cwd, None);
    }

    #[test]
    fn drops_invalid_items_without_losing_valid_siblings() {
        let tree = TempTree::new("invalid-item");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let payload = json!([
            { "id": "invalid id", "projectRoot": project },
            { "id": "valid", "projectRoot": project }
        ]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "valid");
    }

    #[test]
    fn deduplicates_requested_roots_by_canonical_path() {
        let tree = TempTree::new("duplicate-root");
        let project = tree.directory("project");
        let alternate_spelling = project.join("..").join("project");
        let requested = vec![project.clone(), alternate_spelling];
        let payload = json!([{ "id": "session", "projectRoot": project }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].project_root, project.to_string_lossy().as_ref());
    }
}
