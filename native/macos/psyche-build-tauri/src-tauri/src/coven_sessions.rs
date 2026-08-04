use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv6Addr, Shutdown, SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const STABLE_API_VERSION: &str = "coven.daemon.v1";
const UNAVAILABLE_MESSAGE: &str = "Coven daemon is not running; run `coven daemon start`";
const INCOMPATIBLE_MESSAGE: &str = "Coven daemon API update required";
const ERROR_MESSAGE: &str = "Coven sessions could not be loaded";

#[derive(Debug, PartialEq, Eq)]
enum CovenEndpoint {
    Unix(PathBuf),
    Http(SocketAddr),
}

#[derive(Debug, PartialEq, Eq)]
enum HttpResponseError {
    Malformed,
    Status(u16),
    TooLarge,
}

#[derive(Debug, PartialEq, Eq)]
enum CovenAdapterError {
    Unavailable,
    Incompatible,
    Failed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CovenHealthResponse {
    api_version: String,
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

#[allow(dead_code)]
fn load_coven_sessions(
    endpoint: &CovenEndpoint,
    project_roots: &[PathBuf],
) -> CovenSessionsResponse {
    match try_load_coven_sessions(endpoint, project_roots) {
        Ok(sessions) => CovenSessionsResponse {
            status: "ready".to_string(),
            sessions,
            message: None,
        },
        Err(CovenAdapterError::Unavailable) => CovenSessionsResponse {
            status: "unavailable".to_string(),
            sessions: Vec::new(),
            message: Some(UNAVAILABLE_MESSAGE.to_string()),
        },
        Err(CovenAdapterError::Incompatible) => CovenSessionsResponse {
            status: "incompatible".to_string(),
            sessions: Vec::new(),
            message: Some(INCOMPATIBLE_MESSAGE.to_string()),
        },
        Err(CovenAdapterError::Failed) => CovenSessionsResponse {
            status: "error".to_string(),
            sessions: Vec::new(),
            message: Some(ERROR_MESSAGE.to_string()),
        },
    }
}

fn try_load_coven_sessions(
    endpoint: &CovenEndpoint,
    project_roots: &[PathBuf],
) -> Result<Vec<CovenSessionSummary>, CovenAdapterError> {
    let health_body = request_endpoint(endpoint, "/api/v1/health")?;
    let health: CovenHealthResponse =
        serde_json::from_slice(&health_body).map_err(|_| CovenAdapterError::Failed)?;
    if health.api_version != STABLE_API_VERSION {
        return Err(CovenAdapterError::Incompatible);
    }

    let sessions_body = request_endpoint(endpoint, "/api/v1/sessions")?;
    let sessions_value =
        serde_json::from_slice(&sessions_body).map_err(|_| CovenAdapterError::Failed)?;
    normalize_sessions(sessions_value, project_roots).map_err(|_| CovenAdapterError::Failed)
}

fn request_endpoint(endpoint: &CovenEndpoint, path: &str) -> Result<Vec<u8>, CovenAdapterError> {
    if !matches!(path, "/api/v1/health" | "/api/v1/sessions") {
        return Err(CovenAdapterError::Failed);
    }

    match endpoint {
        #[cfg(unix)]
        CovenEndpoint::Unix(socket) => {
            let mut stream =
                UnixStream::connect(socket).map_err(|error| categorize_io_error(&error, true))?;
            stream
                .set_read_timeout(Some(READ_TIMEOUT))
                .map_err(|error| categorize_io_error(&error, false))?;
            stream
                .set_write_timeout(Some(READ_TIMEOUT))
                .map_err(|error| categorize_io_error(&error, false))?;
            exchange_http(&mut stream, path)
        }
        #[cfg(not(unix))]
        CovenEndpoint::Unix(_) => Err(CovenAdapterError::Failed),
        CovenEndpoint::Http(address) => {
            if !address.ip().is_loopback() {
                return Err(CovenAdapterError::Failed);
            }
            let mut stream = TcpStream::connect_timeout(address, CONNECT_TIMEOUT)
                .map_err(|error| categorize_io_error(&error, false))?;
            stream
                .set_read_timeout(Some(READ_TIMEOUT))
                .map_err(|error| categorize_io_error(&error, false))?;
            stream
                .set_write_timeout(Some(READ_TIMEOUT))
                .map_err(|error| categorize_io_error(&error, false))?;
            exchange_http(&mut stream, path)
        }
    }
}

trait LocalHttpStream: Read + Write {
    fn shutdown_write(&self) -> io::Result<()>;
}

impl LocalHttpStream for TcpStream {
    fn shutdown_write(&self) -> io::Result<()> {
        self.shutdown(Shutdown::Write)
    }
}

#[cfg(unix)]
impl LocalHttpStream for UnixStream {
    fn shutdown_write(&self) -> io::Result<()> {
        self.shutdown(Shutdown::Write)
    }
}

fn exchange_http<S: LocalHttpStream>(
    stream: &mut S,
    path: &str,
) -> Result<Vec<u8>, CovenAdapterError> {
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| categorize_io_error(&error, false))?;
    stream
        .flush()
        .map_err(|error| categorize_io_error(&error, false))?;
    stream
        .shutdown_write()
        .map_err(|error| categorize_io_error(&error, false))?;

    let mut response = Vec::new();
    stream
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|error| categorize_io_error(&error, false))?;
    if response.len() > MAX_RESPONSE_BYTES {
        return Err(CovenAdapterError::Failed);
    }
    parse_http_response(&response).map_err(|_| CovenAdapterError::Failed)
}

fn categorize_io_error(error: &io::Error, missing_is_unavailable: bool) -> CovenAdapterError {
    if matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) || (missing_is_unavailable && error.kind() == io::ErrorKind::NotFound)
    {
        CovenAdapterError::Unavailable
    } else {
        CovenAdapterError::Failed
    }
}

fn parse_http_response(response: &[u8]) -> Result<Vec<u8>, HttpResponseError> {
    if response.len() > MAX_RESPONSE_BYTES {
        return Err(HttpResponseError::TooLarge);
    }

    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or(HttpResponseError::Malformed)?;
    let header_bytes = &response[..header_end];
    if !header_bytes.is_ascii() {
        return Err(HttpResponseError::Malformed);
    }
    let header_block =
        std::str::from_utf8(header_bytes).map_err(|_| HttpResponseError::Malformed)?;
    let mut lines = header_block.split("\r\n");
    let status_line = lines.next().ok_or(HttpResponseError::Malformed)?;
    let mut status_parts = status_line.split_ascii_whitespace();
    let version = status_parts.next().ok_or(HttpResponseError::Malformed)?;
    let status_text = status_parts.next().ok_or(HttpResponseError::Malformed)?;
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || status_text.len() != 3
        || !status_text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(HttpResponseError::Malformed);
    }
    let status = status_text
        .parse::<u16>()
        .map_err(|_| HttpResponseError::Malformed)?;
    if !(200..=299).contains(&status) {
        return Err(HttpResponseError::Status(status));
    }

    let mut content_lengths = Vec::new();
    let mut transfer_encodings = Vec::new();
    for line in lines {
        let (name, value) = parse_header_line(line)?;
        if name.eq_ignore_ascii_case("content-length") {
            for length in value.split(',') {
                let length = length.trim();
                if length.is_empty() || !length.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(HttpResponseError::Malformed);
                }
                content_lengths.push(
                    length
                        .parse::<usize>()
                        .map_err(|_| HttpResponseError::Malformed)?,
                );
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            for encoding in value.split(',') {
                let encoding = encoding.trim();
                if encoding.is_empty() {
                    return Err(HttpResponseError::Malformed);
                }
                transfer_encodings.push(encoding.to_ascii_lowercase());
            }
        }
    }

    let content_length = match content_lengths.first().copied() {
        Some(first) if content_lengths.iter().all(|length| *length == first) => Some(first),
        Some(_) => return Err(HttpResponseError::Malformed),
        None => None,
    };
    if content_length.is_some() && !transfer_encodings.is_empty() {
        return Err(HttpResponseError::Malformed);
    }

    let body = &response[header_end + 4..];
    if !transfer_encodings.is_empty() {
        if transfer_encodings.as_slice() != ["chunked"] {
            return Err(HttpResponseError::Malformed);
        }
        return decode_chunked_body(body);
    }

    if let Some(content_length) = content_length {
        if content_length > MAX_RESPONSE_BYTES {
            return Err(HttpResponseError::TooLarge);
        }
        if body.len() != content_length {
            return Err(HttpResponseError::Malformed);
        }
    }

    if body.len() > MAX_RESPONSE_BYTES {
        return Err(HttpResponseError::TooLarge);
    }
    Ok(body.to_vec())
}

fn parse_header_line(line: &str) -> Result<(&str, &str), HttpResponseError> {
    if line.starts_with([' ', '\t']) {
        return Err(HttpResponseError::Malformed);
    }
    let (name, value) = line.split_once(':').ok_or(HttpResponseError::Malformed)?;
    if name.is_empty() || !name.bytes().all(is_http_token_byte) {
        return Err(HttpResponseError::Malformed);
    }
    Ok((name, value.trim_matches([' ', '\t'])))
}

fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn decode_chunked_body(body: &[u8]) -> Result<Vec<u8>, HttpResponseError> {
    let mut position = 0;
    let mut decoded = Vec::new();

    loop {
        let line_end = find_crlf(body, position).ok_or(HttpResponseError::Malformed)?;
        let size_line = &body[position..line_end];
        if !size_line.is_ascii() {
            return Err(HttpResponseError::Malformed);
        }
        let size_line = std::str::from_utf8(size_line).map_err(|_| HttpResponseError::Malformed)?;
        let chunk_size = parse_chunk_size(size_line)?;
        position = line_end + 2;

        if chunk_size == 0 {
            loop {
                let trailer_end = find_crlf(body, position).ok_or(HttpResponseError::Malformed)?;
                let trailer = &body[position..trailer_end];
                position = trailer_end + 2;
                if trailer.is_empty() {
                    return (position == body.len())
                        .then_some(decoded)
                        .ok_or(HttpResponseError::Malformed);
                }
                if !trailer.is_ascii() {
                    return Err(HttpResponseError::Malformed);
                }
                let trailer =
                    std::str::from_utf8(trailer).map_err(|_| HttpResponseError::Malformed)?;
                parse_header_line(trailer)?;
            }
        }

        let decoded_length = decoded
            .len()
            .checked_add(chunk_size)
            .ok_or(HttpResponseError::TooLarge)?;
        if decoded_length > MAX_RESPONSE_BYTES {
            return Err(HttpResponseError::TooLarge);
        }
        let data_end = position
            .checked_add(chunk_size)
            .ok_or(HttpResponseError::Malformed)?;
        let terminator_end = data_end
            .checked_add(2)
            .ok_or(HttpResponseError::Malformed)?;
        if body.get(data_end..terminator_end) != Some(b"\r\n") {
            return Err(HttpResponseError::Malformed);
        }
        let chunk = body
            .get(position..data_end)
            .ok_or(HttpResponseError::Malformed)?;
        decoded.extend_from_slice(chunk);
        position = terminator_end;
    }
}

fn find_crlf(bytes: &[u8], start: usize) -> Option<usize> {
    bytes
        .get(start..)?
        .windows(2)
        .position(|window| window == b"\r\n")
        .map(|offset| start + offset)
}

fn parse_chunk_size(line: &str) -> Result<usize, HttpResponseError> {
    let (size, extensions) = line
        .split_once(';')
        .map_or((line, None), |(size, extensions)| (size, Some(extensions)));
    let size = size.trim_end_matches([' ', '\t']);
    if size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HttpResponseError::Malformed);
    }
    if let Some(extensions) = extensions {
        validate_chunk_extensions(extensions)?;
    }
    usize::from_str_radix(size, 16).map_err(|_| HttpResponseError::Malformed)
}

fn validate_chunk_extensions(extensions: &str) -> Result<(), HttpResponseError> {
    for extension in split_chunk_extensions(extensions)? {
        let extension = extension.trim_matches([' ', '\t']);
        let (name, value) = extension
            .split_once('=')
            .map_or((extension, None), |(name, value)| (name, Some(value)));
        let name = name.trim_end_matches([' ', '\t']);
        if name.is_empty() || !name.bytes().all(is_http_token_byte) {
            return Err(HttpResponseError::Malformed);
        }
        if let Some(value) = value {
            let value = value.trim_matches([' ', '\t']);
            let valid = !value.is_empty()
                && (value.bytes().all(is_http_token_byte) || is_valid_quoted_string(value));
            if !valid {
                return Err(HttpResponseError::Malformed);
            }
        }
    }
    Ok(())
}

fn split_chunk_extensions(extensions: &str) -> Result<Vec<&str>, HttpResponseError> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;

    for (index, byte) in extensions.bytes().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b';' {
            parts.push(&extensions[start..index]);
            start = index + 1;
        }
    }

    if quoted || escaped {
        return Err(HttpResponseError::Malformed);
    }
    parts.push(&extensions[start..]);
    Ok(parts)
}

fn is_valid_quoted_string(value: &str) -> bool {
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return false;
    };
    let mut escaped = false;
    for byte in inner.bytes() {
        if escaped {
            if byte.is_ascii_control() && byte != b'\t' {
                return false;
            }
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'"' || (byte.is_ascii_control() && byte != b'\t') {
            return false;
        }
    }
    !escaped
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
    use std::io::{Read, Write};
    use std::net::{Shutdown, TcpListener};
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::Instant;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

    use serde_json::json;

    use super::*;

    static TEMP_TREE_COUNTER: AtomicUsize = AtomicUsize::new(0);
    const FAKE_SERVER_ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);
    const FAKE_SERVER_IO_TIMEOUT: Duration = Duration::from_secs(1);
    const FAKE_SERVER_POLL_INTERVAL: Duration = Duration::from_millis(10);
    const FAKE_SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(1);
    const FAKE_SERVER_STALL_TIMEOUT: Duration = Duration::from_secs(4);

    struct TempTree {
        root: PathBuf,
    }

    struct FakeServer {
        requests: Receiver<Vec<u8>>,
        shutdown: Sender<()>,
        thread: Option<JoinHandle<Result<(), String>>>,
        expected_exchanges: usize,
        completed_exchanges: Arc<AtomicUsize>,
    }

    #[cfg(unix)]
    struct TempSocket {
        path: PathBuf,
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

    impl FakeServer {
        fn recv_request(&self) -> Vec<u8> {
            self.requests
                .recv_timeout(FAKE_SERVER_REQUEST_TIMEOUT)
                .expect("fake server did not receive a request before the deadline")
        }

        fn finish(mut self) {
            let completed = self.completed_exchanges.load(Ordering::Acquire);
            if completed != self.expected_exchanges {
                self.stop_and_join(true);
                panic!(
                    "fake server consumed {completed} of {} scripted exchanges",
                    self.expected_exchanges
                );
            }
            self.stop_and_join(true);
        }

        fn cancel(mut self) {
            self.stop_and_join(true);
        }

        fn stop_and_join(&mut self, report_failure: bool) {
            let _ = self.shutdown.send(());
            let Some(thread) = self.thread.take() else {
                return;
            };
            let result = thread.join();
            if !report_failure {
                return;
            }
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => panic!("fake server failed: {error}"),
                Err(_) => panic!("fake server thread panicked"),
            }
        }
    }

    impl Drop for FakeServer {
        fn drop(&mut self) {
            if self.thread.is_none() {
                return;
            }
            let report_failure = !thread::panicking();
            let completed = self.completed_exchanges.load(Ordering::Acquire);
            self.stop_and_join(report_failure);
            if report_failure && completed != self.expected_exchanges {
                panic!(
                    "fake server dropped after consuming {completed} of {} scripted exchanges",
                    self.expected_exchanges
                );
            }
        }
    }

    #[cfg(unix)]
    impl TempSocket {
        fn new(name: &str) -> Self {
            let suffix = TEMP_TREE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = PathBuf::from(format!(
                "/tmp/pbcoven-{name}-{}-{suffix}.sock",
                std::process::id()
            ));
            Self { path }
        }
    }

    #[cfg(unix)]
    impl Drop for TempSocket {
        fn drop(&mut self) {
            match fs::remove_file(&self.path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => panic!("failed to clean up {}: {error}", self.path.display()),
            }
        }
    }

    fn http_json(body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn expected_request(path: &str) -> Vec<u8> {
        format!(
            "GET {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn assert_server_requests(server: &FakeServer, paths: &[&str]) {
        for path in paths {
            assert_eq!(server.recv_request(), expected_request(path));
        }
    }

    fn spawn_tcp_server(responses: Vec<Vec<u8>>) -> (CovenEndpoint, FakeServer) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let expected_exchanges = responses.len();
        let completed_exchanges = Arc::new(AtomicUsize::new(0));
        let thread_completed_exchanges = Arc::clone(&completed_exchanges);
        let handle = thread::spawn(move || -> Result<(), String> {
            for response in responses {
                let Some(mut stream) = accept_tcp_connection(&listener, &shutdown_rx)? else {
                    return Ok(());
                };
                configure_fake_tcp_stream(&stream)?;
                let mut request = Vec::new();
                stream
                    .read_to_end(&mut request)
                    .map_err(|error| format!("failed to read fake TCP request: {error}"))?;
                request_tx
                    .send(request)
                    .map_err(|_| "fake TCP request receiver closed".to_string())?;
                stream
                    .write_all(&response)
                    .map_err(|error| format!("failed to write fake TCP response: {error}"))?;
                thread_completed_exchanges.fetch_add(1, Ordering::Release);
                stream
                    .shutdown(Shutdown::Write)
                    .map_err(|error| format!("failed to close fake TCP response: {error}"))?;
            }
            Ok(())
        });
        (
            CovenEndpoint::Http(address),
            FakeServer {
                requests: request_rx,
                shutdown: shutdown_tx,
                thread: Some(handle),
                expected_exchanges,
                completed_exchanges,
            },
        )
    }

    fn spawn_stalling_tcp_server() -> (CovenEndpoint, FakeServer) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let completed_exchanges = Arc::new(AtomicUsize::new(0));
        let handle = thread::spawn(move || -> Result<(), String> {
            let Some(mut stream) = accept_tcp_connection(&listener, &shutdown_rx)? else {
                return Ok(());
            };
            configure_fake_tcp_stream(&stream)?;
            let mut request = Vec::new();
            stream
                .read_to_end(&mut request)
                .map_err(|error| format!("failed to read stalling TCP request: {error}"))?;
            request_tx
                .send(request)
                .map_err(|_| "stalling TCP request receiver closed".to_string())?;
            match shutdown_rx.recv_timeout(FAKE_SERVER_STALL_TIMEOUT) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => Ok(()),
                Err(RecvTimeoutError::Timeout) => {
                    Err("stalling TCP server cancellation deadline elapsed".to_string())
                }
            }
        });
        (
            CovenEndpoint::Http(address),
            FakeServer {
                requests: request_rx,
                shutdown: shutdown_tx,
                thread: Some(handle),
                expected_exchanges: 1,
                completed_exchanges,
            },
        )
    }

    #[cfg(unix)]
    fn spawn_unix_server(socket: &Path, responses: Vec<Vec<u8>>) -> FakeServer {
        let listener = UnixListener::bind(socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let expected_exchanges = responses.len();
        let completed_exchanges = Arc::new(AtomicUsize::new(0));
        let thread_completed_exchanges = Arc::clone(&completed_exchanges);
        let handle = thread::spawn(move || -> Result<(), String> {
            for response in responses {
                let Some(mut stream) = accept_unix_connection(&listener, &shutdown_rx)? else {
                    return Ok(());
                };
                configure_fake_unix_stream(&stream)?;
                let mut request = Vec::new();
                stream
                    .read_to_end(&mut request)
                    .map_err(|error| format!("failed to read fake Unix request: {error}"))?;
                request_tx
                    .send(request)
                    .map_err(|_| "fake Unix request receiver closed".to_string())?;
                stream
                    .write_all(&response)
                    .map_err(|error| format!("failed to write fake Unix response: {error}"))?;
                thread_completed_exchanges.fetch_add(1, Ordering::Release);
                stream
                    .shutdown(Shutdown::Write)
                    .map_err(|error| format!("failed to close fake Unix response: {error}"))?;
            }
            Ok(())
        });
        FakeServer {
            requests: request_rx,
            shutdown: shutdown_tx,
            thread: Some(handle),
            expected_exchanges,
            completed_exchanges,
        }
    }

    fn accept_tcp_connection(
        listener: &TcpListener,
        shutdown: &Receiver<()>,
    ) -> Result<Option<TcpStream>, String> {
        let deadline = Instant::now() + FAKE_SERVER_ACCEPT_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((stream, _)) => return Ok(Some(stream)),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("fake TCP accept failed: {error}")),
            }
            if wait_for_fake_server_work(shutdown, deadline)? {
                return Ok(None);
            }
        }
    }

    fn configure_fake_tcp_stream(stream: &TcpStream) -> Result<(), String> {
        stream
            .set_nonblocking(false)
            .map_err(|error| format!("failed to make fake TCP stream blocking: {error}"))?;
        stream
            .set_read_timeout(Some(FAKE_SERVER_IO_TIMEOUT))
            .map_err(|error| format!("failed to set fake TCP read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(FAKE_SERVER_IO_TIMEOUT))
            .map_err(|error| format!("failed to set fake TCP write timeout: {error}"))
    }

    #[cfg(unix)]
    fn accept_unix_connection(
        listener: &UnixListener,
        shutdown: &Receiver<()>,
    ) -> Result<Option<UnixStream>, String> {
        let deadline = Instant::now() + FAKE_SERVER_ACCEPT_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((stream, _)) => return Ok(Some(stream)),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(format!("fake Unix accept failed: {error}")),
            }
            if wait_for_fake_server_work(shutdown, deadline)? {
                return Ok(None);
            }
        }
    }

    #[cfg(unix)]
    fn configure_fake_unix_stream(stream: &UnixStream) -> Result<(), String> {
        stream
            .set_nonblocking(false)
            .map_err(|error| format!("failed to make fake Unix stream blocking: {error}"))?;
        stream
            .set_read_timeout(Some(FAKE_SERVER_IO_TIMEOUT))
            .map_err(|error| format!("failed to set fake Unix read timeout: {error}"))?;
        stream
            .set_write_timeout(Some(FAKE_SERVER_IO_TIMEOUT))
            .map_err(|error| format!("failed to set fake Unix write timeout: {error}"))
    }

    fn wait_for_fake_server_work(
        shutdown: &Receiver<()>,
        deadline: Instant,
    ) -> Result<bool, String> {
        let now = Instant::now();
        if now >= deadline {
            return Err("fake server accept deadline elapsed".to_string());
        }
        let wait = FAKE_SERVER_POLL_INTERVAL.min(deadline.duration_since(now));
        match shutdown.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => Ok(true),
            Err(RecvTimeoutError::Timeout) => Ok(false),
        }
    }

    fn assert_adapter_state(response: &CovenSessionsResponse, status: &str, message: Option<&str>) {
        assert_eq!(response.status, status);
        assert!(response.sessions.is_empty());
        assert_eq!(response.message.as_deref(), message);
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

    #[test]
    fn parses_content_length_json_responses() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";

        assert_eq!(parse_http_response(response).unwrap(), b"{\"ok\":true}");
    }

    #[test]
    fn parses_chunked_json_responses_with_extensions() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4 ; part = one\r\n{\"ok\r\n7\r\n\":true}\r\n0\r\nChecksum: ignored\r\n\r\n";

        assert_eq!(parse_http_response(response).unwrap(), b"{\"ok\":true}");
    }

    #[test]
    fn parses_chunk_extensions_with_quoted_semicolons() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;note=\"a;b\"\r\ntest\r\n0\r\n\r\n";

        assert_eq!(parse_http_response(response).unwrap(), b"test");
    }

    #[test]
    fn parses_header_names_case_insensitively() {
        let response = b"HTTP/1.1 204 No Content\r\ncOnTeNt-LeNgTh: 0\r\n\r\n";

        assert_eq!(parse_http_response(response).unwrap(), b"");
    }

    #[test]
    fn rejects_incomplete_and_extra_fixed_bodies() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n1234".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n12345".as_slice(),
        ] {
            assert_eq!(
                parse_http_response(response),
                Err(HttpResponseError::Malformed)
            );
        }
    }

    #[test]
    fn rejects_invalid_chunk_sizes_terminators_and_trailers() {
        for response in [
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nnope\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx!\r\n0\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nTrailer: open\r\n"
                .as_slice(),
        ] {
            assert_eq!(
                parse_http_response(response),
                Err(HttpResponseError::Malformed)
            );
        }
    }

    #[test]
    fn rejects_non_success_status_without_retaining_the_body() {
        let response =
            b"HTTP/1.1 503 Unavailable\r\nContent-Length: 21\r\n\r\nsensitive daemon data";

        assert_eq!(
            parse_http_response(response),
            Err(HttpResponseError::Status(503))
        );
    }

    #[test]
    fn rejects_responses_without_a_complete_header_block() {
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n"),
            Err(HttpResponseError::Malformed)
        );
    }

    #[test]
    fn rejects_conflicting_lengths_and_transfer_encodings() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx".as_slice(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\nx"
                .as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nx".as_slice(),
        ] {
            assert_eq!(
                parse_http_response(response),
                Err(HttpResponseError::Malformed)
            );
        }
    }

    #[test]
    fn enforces_raw_and_decoded_response_limits() {
        let raw = vec![b'x'; MAX_RESPONSE_BYTES + 1];
        assert_eq!(parse_http_response(&raw), Err(HttpResponseError::TooLarge));

        let mut chunked = format!("{:x}\r\n", MAX_RESPONSE_BYTES + 1).into_bytes();
        chunked.extend(vec![b'x'; MAX_RESPONSE_BYTES + 1]);
        chunked.extend_from_slice(b"\r\n0\r\n\r\n");
        assert_eq!(
            decode_chunked_body(&chunked),
            Err(HttpResponseError::TooLarge)
        );
    }

    #[test]
    fn accepts_connection_close_bodies_without_length_headers() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n[]";

        assert_eq!(parse_http_response(response).unwrap(), b"[]");
    }

    #[cfg(unix)]
    #[test]
    fn loads_sessions_over_unix_and_sends_exact_paths() {
        let tree = TempTree::new("unix-transport");
        let project = tree.directory("project");
        let socket = TempSocket::new("round-trip");
        let sessions = serde_json::to_vec(&json!({
            "sessions": [{
                "id": "unix-session",
                "projectRoot": project,
                "title": "  Native session  "
            }]
        }))
        .unwrap();
        let server = spawn_unix_server(
            &socket.path,
            vec![
                http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
                http_json(&sessions),
            ],
        );

        let response = load_coven_sessions(&CovenEndpoint::Unix(socket.path.clone()), &[project]);
        let health_request = server.recv_request();
        let sessions_request = server.recv_request();
        server.finish();

        assert_eq!(response.status, "ready");
        assert_eq!(response.sessions.len(), 1);
        assert_eq!(response.sessions[0].id, "unix-session");
        assert_eq!(
            response.sessions[0].title.as_deref(),
            Some("Native session")
        );
        assert_eq!(response.message, None);
        assert_eq!(health_request, expected_request("/api/v1/health"));
        assert_eq!(sessions_request, expected_request("/api/v1/sessions"));
    }

    #[test]
    fn loads_sessions_over_loopback_tcp_and_sends_exact_paths() {
        let tree = TempTree::new("tcp-transport");
        let project = tree.directory("project");
        let other = tree.directory("other");
        let sessions = serde_json::to_vec(&json!([
            { "id": "tcp-session", "projectRoot": project, "status": " active " },
            { "id": "out-of-scope", "projectRoot": other }
        ]))
        .unwrap();
        let (endpoint, server) = spawn_tcp_server(vec![
            http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
            http_json(&sessions),
        ]);

        let response = load_coven_sessions(&endpoint, &[project.clone()]);
        let health_request = server.recv_request();
        let sessions_request = server.recv_request();
        server.finish();

        assert_eq!(response.status, "ready");
        assert_eq!(response.sessions.len(), 1);
        assert_eq!(response.sessions[0].id, "tcp-session");
        assert_eq!(response.sessions[0].project_root, project.to_string_lossy());
        assert_eq!(response.sessions[0].status.as_deref(), Some("active"));
        assert_eq!(response.message, None);
        assert_eq!(health_request, expected_request("/api/v1/health"));
        assert_eq!(sessions_request, expected_request("/api/v1/sessions"));
    }

    #[test]
    fn accepted_fake_tcp_streams_use_bounded_blocking_io() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel();
        let mut stream = accept_tcp_connection(&listener, &shutdown_rx)
            .unwrap()
            .unwrap();
        configure_fake_tcp_stream(&stream).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            started_tx.send(()).unwrap();
            let mut byte = [0];
            done_tx.send(stream.read_exact(&mut byte)).unwrap();
            byte
        });

        started_rx
            .recv_timeout(FAKE_SERVER_REQUEST_TIMEOUT)
            .unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(RecvTimeoutError::Timeout)
        ));
        client.write_all(b"x").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        assert!(done_rx
            .recv_timeout(FAKE_SERVER_REQUEST_TIMEOUT)
            .unwrap()
            .is_ok());
        assert_eq!(reader.join().unwrap(), *b"x");
    }

    #[cfg(unix)]
    #[test]
    fn accepted_fake_unix_streams_use_bounded_blocking_io() {
        let socket = TempSocket::new("blocking-io");
        let listener = UnixListener::bind(&socket.path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = UnixStream::connect(&socket.path).unwrap();
        let (_shutdown_tx, shutdown_rx) = mpsc::channel();
        let mut stream = accept_unix_connection(&listener, &shutdown_rx)
            .unwrap()
            .unwrap();
        configure_fake_unix_stream(&stream).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            started_tx.send(()).unwrap();
            let mut byte = [0];
            done_tx.send(stream.read_exact(&mut byte)).unwrap();
            byte
        });

        started_rx
            .recv_timeout(FAKE_SERVER_REQUEST_TIMEOUT)
            .unwrap();
        assert!(matches!(
            done_rx.recv_timeout(Duration::from_millis(100)),
            Err(RecvTimeoutError::Timeout)
        ));
        client.write_all(b"x").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        assert!(done_rx
            .recv_timeout(FAKE_SERVER_REQUEST_TIMEOUT)
            .unwrap()
            .is_ok());
        assert_eq!(reader.join().unwrap(), *b"x");
    }

    #[cfg(unix)]
    #[test]
    fn maps_a_missing_unix_socket_to_unavailable() {
        let socket = TempSocket::new("missing");
        let response = load_coven_sessions(&CovenEndpoint::Unix(socket.path.clone()), &[]);

        assert_adapter_state(
            &response,
            "unavailable",
            Some("Coven daemon is not running; run `coven daemon start`"),
        );
    }

    #[test]
    fn maps_a_refused_tcp_connection_to_unavailable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = CovenEndpoint::Http(listener.local_addr().unwrap());
        drop(listener);

        let response = load_coven_sessions(&endpoint, &[]);

        assert_adapter_state(
            &response,
            "unavailable",
            Some("Coven daemon is not running; run `coven daemon start`"),
        );
    }

    #[test]
    fn bounds_daemon_read_timeouts_and_maps_them_to_unavailable() {
        let (endpoint, server) = spawn_stalling_tcp_server();

        let started = Instant::now();
        let response = load_coven_sessions(&endpoint, &[]);
        let elapsed = started.elapsed();
        let request = server.recv_request();
        server.cancel();

        assert!(elapsed < Duration::from_secs(5), "timeout took {elapsed:?}");
        assert_eq!(request, expected_request("/api/v1/health"));
        assert_adapter_state(
            &response,
            "unavailable",
            Some("Coven daemon is not running; run `coven daemon start`"),
        );
    }

    #[test]
    fn rejects_non_loopback_tcp_endpoints_at_request_time() {
        let response = load_coven_sessions(
            &CovenEndpoint::Http("192.0.2.10:7777".parse().unwrap()),
            &[],
        );

        assert_adapter_state(
            &response,
            "error",
            Some("Coven sessions could not be loaded"),
        );
    }

    #[test]
    fn maps_an_incompatible_health_version_without_requesting_sessions() {
        let (endpoint, server) =
            spawn_tcp_server(vec![http_json(br#"{"apiVersion":"coven.daemon.v2"}"#)]);

        let response = load_coven_sessions(&endpoint, &[]);
        let health_request = server.recv_request();
        server.finish();

        assert_adapter_state(
            &response,
            "incompatible",
            Some("Coven daemon API update required"),
        );
        assert_eq!(health_request, expected_request("/api/v1/health"));
    }

    #[test]
    fn strict_fake_server_finish_rejects_an_unconsumed_script() {
        let (endpoint, server) = spawn_tcp_server(vec![
            http_json(br#"{"apiVersion":"coven.daemon.v2"}"#),
            http_json(br#"{"sessions":[]}"#),
        ]);
        let started = Instant::now();

        let response = load_coven_sessions(&endpoint, &[]);
        let request = server.recv_request();
        let finish = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| server.finish()));

        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(finish.is_err());
        assert_adapter_state(
            &response,
            "incompatible",
            Some("Coven daemon API update required"),
        );
        assert_eq!(request, expected_request("/api/v1/health"));
    }

    #[test]
    fn explicit_fake_server_cancel_allows_an_intentionally_skipped_exchange() {
        let (endpoint, server) = spawn_tcp_server(vec![
            http_json(br#"{"apiVersion":"coven.daemon.v2"}"#),
            http_json(br#"{"sessions":[]}"#),
        ]);
        let started = Instant::now();

        let response = load_coven_sessions(&endpoint, &[]);
        let request = server.recv_request();
        server.cancel();

        assert!(started.elapsed() < Duration::from_secs(1));
        assert_adapter_state(
            &response,
            "incompatible",
            Some("Coven daemon API update required"),
        );
        assert_eq!(request, expected_request("/api/v1/health"));
    }

    #[test]
    fn maps_malformed_health_json_to_error() {
        let (endpoint, server) = spawn_tcp_server(vec![http_json(b"{")]);

        let response = load_coven_sessions(&endpoint, &[]);
        assert_server_requests(&server, &["/api/v1/health"]);
        server.finish();

        assert_adapter_state(
            &response,
            "error",
            Some("Coven sessions could not be loaded"),
        );
    }

    #[test]
    fn maps_malformed_sessions_json_and_envelopes_to_error() {
        for sessions in [b"{".as_slice(), br#"{"sessions":{}}"#.as_slice()] {
            let (endpoint, server) = spawn_tcp_server(vec![
                http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
                http_json(sessions),
            ]);

            let response = load_coven_sessions(&endpoint, &[]);
            assert_server_requests(&server, &["/api/v1/health", "/api/v1/sessions"]);
            server.finish();

            assert_adapter_state(
                &response,
                "error",
                Some("Coven sessions could not be loaded"),
            );
        }
    }

    #[test]
    fn maps_malformed_http_on_health_or_sessions_to_error() {
        for (responses, expected_paths) in [
            (vec![b"not http".to_vec()], vec!["/api/v1/health"]),
            (
                vec![
                    http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n".to_vec(),
                ],
                vec!["/api/v1/health", "/api/v1/sessions"],
            ),
        ] {
            let (endpoint, server) = spawn_tcp_server(responses);

            let response = load_coven_sessions(&endpoint, &[]);
            assert_server_requests(&server, &expected_paths);
            server.finish();

            assert_adapter_state(
                &response,
                "error",
                Some("Coven sessions could not be loaded"),
            );
        }
    }

    #[test]
    fn maps_non_success_health_or_sessions_responses_to_error() {
        let denied = b"HTTP/1.1 503 Unavailable\r\nContent-Length: 6\r\n\r\nsecret".to_vec();
        for (responses, expected_paths) in [
            (vec![denied.clone()], vec!["/api/v1/health"]),
            (
                vec![
                    http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
                    denied.clone(),
                ],
                vec!["/api/v1/health", "/api/v1/sessions"],
            ),
        ] {
            let (endpoint, server) = spawn_tcp_server(responses);

            let response = load_coven_sessions(&endpoint, &[]);
            assert_server_requests(&server, &expected_paths);
            server.finish();

            assert_adapter_state(
                &response,
                "error",
                Some("Coven sessions could not be loaded"),
            );
        }
    }

    #[test]
    fn a_successful_call_after_failure_has_no_stale_failure_state() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let failed_endpoint = CovenEndpoint::Http(listener.local_addr().unwrap());
        drop(listener);
        let failed = load_coven_sessions(&failed_endpoint, &[]);
        assert_eq!(failed.status, "unavailable");

        let (endpoint, server) = spawn_tcp_server(vec![
            http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
            http_json(br#"{"sessions":[]}"#),
        ]);
        let recovered = load_coven_sessions(&endpoint, &[]);
        assert_server_requests(&server, &["/api/v1/health", "/api/v1/sessions"]);
        server.finish();

        assert_eq!(recovered.status, "ready");
        assert!(recovered.sessions.is_empty());
        assert_eq!(recovered.message, None);
    }
}
