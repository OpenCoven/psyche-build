use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
#[cfg(unix)]
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
#[cfg(unix)]
use std::net::{Shutdown, TcpStream};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::Url;

#[cfg(unix)]
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const STABLE_API_VERSION: &str = "coven.daemon.v1";
const MAX_JAVASCRIPT_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;
const UNAVAILABLE_MESSAGE: &str = "Coven daemon is not running; run `coven daemon start`";
const INCOMPATIBLE_MESSAGE: &str = "Coven daemon API update required";
const ERROR_MESSAGE: &str = "Coven sessions could not be loaded";

#[derive(Debug, PartialEq, Eq)]
enum CovenEndpoint {
    Unix(PathBuf),
    Http(SocketAddr),
}

#[derive(Clone, Copy)]
enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CovenProjectScope {
    project_root: String,
    #[serde(default)]
    worktree_roots: Vec<String>,
}

#[derive(Debug)]
struct CanonicalProjectScope {
    project_root: String,
    owned_roots: HashSet<PathBuf>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CovenSessionSummary {
    id: String,
    project_root: String,
    cwd: Option<String>,
    labels: Vec<String>,
    harness: Option<String>,
    model: Option<String>,
    current_task: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
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

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
#[derive(Debug, Serialize, PartialEq, Eq)]
pub(crate) struct CovenSessionsUnavailableResponse {
    status: &'static str,
    reason: &'static str,
}

#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
fn windows_transport_unavailable_response() -> CovenSessionsUnavailableResponse {
    CovenSessionsUnavailableResponse {
        status: "unavailable",
        reason: "local Coven Unix socket transport is unsupported on Windows",
    }
}

fn error_response() -> CovenSessionsResponse {
    CovenSessionsResponse {
        status: "error".to_string(),
        sessions: Vec::new(),
        message: Some(ERROR_MESSAGE.to_string()),
    }
}

fn coven_environment<I>(values: I) -> Result<HashMap<String, String>, ()>
where
    I: IntoIterator<Item = (&'static str, Option<OsString>)>,
{
    let mut env = HashMap::new();
    for (key, value) in values {
        if let Some(value) = value {
            env.insert(key.to_string(), value.into_string().map_err(|_| ())?);
        }
    }
    Ok(env)
}

fn home_path(value: Option<OsString>) -> PathBuf {
    value
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
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

pub(crate) fn is_safe_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(all(test, unix))]
fn load_coven_sessions(
    endpoint: &CovenEndpoint,
    project_roots: &[PathBuf],
) -> CovenSessionsResponse {
    let project_scopes = default_project_scopes(project_roots);
    load_coven_sessions_with_scopes(endpoint, project_roots, &project_scopes)
}

#[cfg(unix)]
fn load_coven_sessions_with_scopes(
    endpoint: &CovenEndpoint,
    project_roots: &[PathBuf],
    project_scopes: &[CovenProjectScope],
) -> CovenSessionsResponse {
    match try_load_coven_sessions(endpoint, project_roots, project_scopes) {
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
        Err(CovenAdapterError::Failed) => error_response(),
    }
}

#[cfg(unix)]
fn discover(
    env: &HashMap<String, String>,
    home: &Path,
    project_roots: Vec<String>,
    project_scopes: Option<Vec<CovenProjectScope>>,
) -> CovenSessionsResponse {
    let endpoint = match resolve_endpoint(env, home) {
        Ok(endpoint) => endpoint,
        Err(_) => return error_response(),
    };
    let project_roots = project_roots
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let project_scopes = project_scopes.unwrap_or_else(|| default_project_scopes(&project_roots));

    load_coven_sessions_with_scopes(&endpoint, &project_roots, &project_scopes)
}

#[cfg(unix)]
#[tauri::command]
pub(crate) async fn coven_sessions(
    project_roots: Vec<String>,
    project_scopes: Option<Vec<CovenProjectScope>>,
) -> CovenSessionsResponse {
    match tauri::async_runtime::spawn_blocking(move || {
        let env = match coven_environment([
            ("COVEN_SOCKET", std::env::var_os("COVEN_SOCKET")),
            ("COVEN_HOME", std::env::var_os("COVEN_HOME")),
            ("COVEN_URL", std::env::var_os("COVEN_URL")),
            ("COVEN_PORT", std::env::var_os("COVEN_PORT")),
        ]) {
            Ok(env) => env,
            Err(()) => return error_response(),
        };
        let home = home_path(std::env::var_os("HOME"));

        discover(&env, &home, project_roots, project_scopes)
    })
    .await
    {
        Ok(response) => response,
        Err(_) => error_response(),
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) async fn coven_sessions(
    _project_roots: Vec<String>,
    _project_scopes: Option<Vec<CovenProjectScope>>,
) -> CovenSessionsUnavailableResponse {
    windows_transport_unavailable_response()
}

#[cfg(unix)]
#[tauri::command]
pub(crate) async fn coven_session_kill(session_id: String) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || {
        if !is_safe_session_id(&session_id) {
            return Err("Invalid Coven session".to_string());
        }
        let env = coven_environment([
            ("COVEN_SOCKET", std::env::var_os("COVEN_SOCKET")),
            ("COVEN_HOME", std::env::var_os("COVEN_HOME")),
            ("COVEN_URL", std::env::var_os("COVEN_URL")),
            ("COVEN_PORT", std::env::var_os("COVEN_PORT")),
        ])
        .map_err(|()| adapter_error_message(CovenAdapterError::Failed).to_string())?;
        let home = home_path(std::env::var_os("HOME"));
        let endpoint = resolve_endpoint(&env, &home)
            .map_err(|_| adapter_error_message(CovenAdapterError::Failed).to_string())?;

        try_kill_coven_session(&endpoint, &session_id)
            .map_err(|error| adapter_error_message(error).to_string())
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(adapter_error_message(CovenAdapterError::Failed).to_string()),
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub(crate) async fn coven_session_kill(_session_id: String) -> Result<(), String> {
    Err("Local Coven session control is unsupported on Windows".to_string())
}

#[cfg(unix)]
fn try_load_coven_sessions(
    endpoint: &CovenEndpoint,
    project_roots: &[PathBuf],
    project_scopes: &[CovenProjectScope],
) -> Result<Vec<CovenSessionSummary>, CovenAdapterError> {
    let deadline = Instant::now() + EXCHANGE_TIMEOUT;
    let health_body = request_endpoint(endpoint, HttpMethod::Get, "/api/v1/health", deadline)?;
    let health: CovenHealthResponse =
        serde_json::from_slice(&health_body).map_err(|_| CovenAdapterError::Failed)?;
    if health.api_version != STABLE_API_VERSION {
        return Err(CovenAdapterError::Incompatible);
    }

    let sessions_body = request_endpoint(endpoint, HttpMethod::Get, "/api/v1/sessions", deadline)?;
    let sessions_value =
        serde_json::from_slice(&sessions_body).map_err(|_| CovenAdapterError::Failed)?;
    normalize_sessions_with_scopes(sessions_value, project_roots, project_scopes)
        .map_err(|_| CovenAdapterError::Failed)
}

#[cfg(unix)]
fn try_kill_coven_session(
    endpoint: &CovenEndpoint,
    session_id: &str,
) -> Result<(), CovenAdapterError> {
    if !is_safe_session_id(session_id) {
        return Err(CovenAdapterError::Failed);
    }

    let deadline = Instant::now() + EXCHANGE_TIMEOUT;
    let health_body = request_endpoint(endpoint, HttpMethod::Get, "/api/v1/health", deadline)?;
    let health: CovenHealthResponse =
        serde_json::from_slice(&health_body).map_err(|_| CovenAdapterError::Failed)?;
    if health.api_version != STABLE_API_VERSION {
        return Err(CovenAdapterError::Incompatible);
    }

    let kill_path = format!("/api/v1/sessions/{session_id}/kill");
    request_endpoint(endpoint, HttpMethod::Post, &kill_path, deadline)?;
    Ok(())
}

#[cfg(unix)]
fn adapter_error_message(error: CovenAdapterError) -> &'static str {
    match error {
        CovenAdapterError::Unavailable => UNAVAILABLE_MESSAGE,
        CovenAdapterError::Incompatible => INCOMPATIBLE_MESSAGE,
        CovenAdapterError::Failed => "Coven session could not be stopped",
    }
}

#[cfg(unix)]
fn request_endpoint(
    endpoint: &CovenEndpoint,
    method: HttpMethod,
    path: &str,
    deadline: Instant,
) -> Result<Vec<u8>, CovenAdapterError> {
    let allowed = match method {
        HttpMethod::Get => matches!(path, "/api/v1/health" | "/api/v1/sessions"),
        HttpMethod::Post => path
            .strip_prefix("/api/v1/sessions/")
            .and_then(|value| value.strip_suffix("/kill"))
            .is_some_and(is_safe_session_id),
    };
    if !allowed {
        return Err(CovenAdapterError::Failed);
    }

    match endpoint {
        #[cfg(unix)]
        CovenEndpoint::Unix(socket) => {
            let mut stream = connect_unix_before(socket, deadline)
                .map_err(|error| categorize_io_error(&error, true))?;
            exchange_http(&mut stream, method, path, deadline)
        }
        CovenEndpoint::Http(address) => {
            if !address.ip().is_loopback() {
                return Err(CovenAdapterError::Failed);
            }
            let connect_timeout =
                remaining_before(deadline).map_err(|error| categorize_io_error(&error, false))?;
            let mut stream = TcpStream::connect_timeout(address, connect_timeout)
                .map_err(|error| categorize_io_error(&error, false))?;
            stream
                .set_nonblocking(true)
                .map_err(|error| categorize_io_error(&error, false))?;
            exchange_http(&mut stream, method, path, deadline)
        }
    }
}

#[cfg(unix)]
trait LocalHttpStream: Read + Write + AsRawFd {
    fn shutdown_write(&self) -> io::Result<()>;
}

#[cfg(unix)]
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

#[cfg(unix)]
fn exchange_http<S: LocalHttpStream>(
    stream: &mut S,
    method: HttpMethod,
    path: &str,
    deadline: Instant,
) -> Result<Vec<u8>, CovenAdapterError> {
    let request = format!(
        "{} {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        method.as_str()
    );
    write_all_before(stream, request.as_bytes(), deadline)
        .map_err(|error| categorize_io_error(&error, false))?;
    flush_before(stream, deadline).map_err(|error| categorize_io_error(&error, false))?;
    remaining_before(deadline).map_err(|error| categorize_io_error(&error, false))?;
    stream
        .shutdown_write()
        .map_err(|error| categorize_io_error(&error, false))?;

    let response =
        read_to_end_before(stream, deadline).map_err(|error| categorize_io_error(&error, false))?;
    parse_http_response(&response).map_err(|_| CovenAdapterError::Failed)
}

#[cfg(unix)]
fn remaining_before(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Coven exchange deadline elapsed"))
}

#[cfg(unix)]
fn write_all_before<S: LocalHttpStream>(
    stream: &mut S,
    mut bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    while !bytes.is_empty() {
        remaining_before(deadline)?;
        match stream.write(bytes) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_for_io(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn flush_before<S: LocalHttpStream>(stream: &mut S, deadline: Instant) -> io::Result<()> {
    loop {
        remaining_before(deadline)?;
        match stream.flush() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_for_io(stream.as_raw_fd(), libc::POLLOUT, deadline)?;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(unix)]
fn read_to_end_before<S: LocalHttpStream>(
    stream: &mut S,
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    let mut response = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        remaining_before(deadline)?;
        let remaining_capacity = MAX_RESPONSE_BYTES + 1 - response.len();
        let read_capacity = buffer.len().min(remaining_capacity);
        match stream.read(&mut buffer[..read_capacity]) {
            Ok(0) => return Ok(response),
            Ok(read) => {
                response.extend_from_slice(&buffer[..read]);
                if response.len() > MAX_RESPONSE_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Coven response exceeded the byte limit",
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_for_io(stream.as_raw_fd(), libc::POLLIN, deadline)?;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(unix)]
fn connect_unix_before(path: &Path, deadline: Instant) -> io::Result<UnixStream> {
    let path = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if path.is_empty() || path.contains(&0) || path.len() >= address.sun_path.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Coven socket path is invalid or too long",
        ));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (target, byte) in address.sun_path.iter_mut().zip(path.iter().copied()) {
        *target = byte as libc::c_char;
    }
    let address_length = std::mem::offset_of!(libc::sockaddr_un, sun_path) + path.len() + 1;
    #[cfg(target_vendor = "apple")]
    {
        address.sun_len = address_length as u8;
    }

    let raw_fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { UnixStream::from_raw_fd(raw_fd) };
    let flags = unsafe { libc::fcntl(raw_fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(raw_fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    stream.set_nonblocking(true)?;

    let connected = unsafe {
        libc::connect(
            raw_fd,
            std::ptr::addr_of!(address).cast::<libc::sockaddr>(),
            address_length as libc::socklen_t,
        )
    };
    if connected < 0 {
        let error = io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(code)
                if matches!(
                    code,
                    libc::EINPROGRESS | libc::EALREADY | libc::EWOULDBLOCK | libc::EINTR
                )
        ) {
            return Err(error);
        }
        wait_for_unix_connect(raw_fd, deadline)?;
    }
    remaining_before(deadline)?;
    Ok(stream)
}

#[cfg(unix)]
fn wait_for_unix_connect(raw_fd: RawFd, deadline: Instant) -> io::Result<()> {
    wait_for_io(raw_fd, libc::POLLOUT, deadline)?;
    let mut socket_error: libc::c_int = 0;
    let mut socket_error_length = std::mem::size_of_val(&socket_error) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            raw_fd,
            libc::SOL_SOCKET,
            libc::SO_ERROR,
            std::ptr::addr_of_mut!(socket_error).cast(),
            std::ptr::addr_of_mut!(socket_error_length),
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    if socket_error == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(socket_error))
    }
}

#[cfg(unix)]
fn wait_for_io(raw_fd: RawFd, events: libc::c_short, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = remaining_before(deadline)?;
        let rounded_millis = remaining
            .as_millis()
            .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0));
        let timeout = rounded_millis.min(libc::c_int::MAX as u128) as libc::c_int;
        let mut descriptor = libc::pollfd {
            fd: raw_fd,
            events,
            revents: 0,
        };
        let ready = unsafe { libc::poll(std::ptr::addr_of_mut!(descriptor), 1, timeout) };
        if ready == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Coven exchange deadline elapsed",
            ));
        }
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        remaining_before(deadline)?;
        if descriptor.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Coven socket descriptor is invalid",
            ));
        }
        return Ok(());
    }
}

#[cfg(unix)]
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

#[cfg(test)]
fn normalize_sessions(
    value: Value,
    requested_roots: &[PathBuf],
) -> Result<Vec<CovenSessionSummary>, String> {
    let project_scopes = default_project_scopes(requested_roots);
    normalize_sessions_with_scopes(value, requested_roots, &project_scopes)
}

fn default_project_scopes(requested_roots: &[PathBuf]) -> Vec<CovenProjectScope> {
    let union = requested_roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    requested_roots
        .iter()
        .map(|root| CovenProjectScope {
            project_root: root.to_string_lossy().into_owned(),
            worktree_roots: union.clone(),
        })
        .collect()
}

fn normalize_sessions_with_scopes(
    value: Value,
    requested_roots: &[PathBuf],
    project_scopes: &[CovenProjectScope],
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
    let project_scopes = canonical_project_scopes(project_scopes, &requested_roots);
    Ok(sessions
        .iter()
        .filter_map(|session| normalize_session(session, &project_scopes))
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

fn canonical_project_scopes(
    project_scopes: &[CovenProjectScope],
    requested_roots: &HashMap<PathBuf, String>,
) -> HashMap<PathBuf, CanonicalProjectScope> {
    let mut canonical_scopes = HashMap::new();
    for scope in project_scopes {
        let Ok(canonical_project_root) = Path::new(&scope.project_root).canonicalize() else {
            continue;
        };
        let Some(project_root) = requested_roots.get(&canonical_project_root) else {
            continue;
        };
        let canonical_scope = canonical_scopes
            .entry(canonical_project_root.clone())
            .or_insert_with(|| CanonicalProjectScope {
                project_root: project_root.clone(),
                owned_roots: HashSet::from([canonical_project_root]),
            });
        for worktree_root in &scope.worktree_roots {
            let Ok(canonical_worktree_root) = Path::new(worktree_root).canonicalize() else {
                continue;
            };
            if requested_roots.contains_key(&canonical_worktree_root) {
                canonical_scope.owned_roots.insert(canonical_worktree_root);
            }
        }
    }
    canonical_scopes
}

fn normalize_session(
    value: &Value,
    project_scopes: &HashMap<PathBuf, CanonicalProjectScope>,
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
    let project_scope = project_scopes.get(&canonical_project_root)?;

    let cwd = match optional_string(fields, "cwd", "cwd")? {
        Some(cwd) => {
            let canonical_cwd = Path::new(&cwd).canonicalize().ok()?;
            if !project_scope
                .owned_roots
                .iter()
                .any(|owned_root| canonical_cwd.starts_with(owned_root))
            {
                return None;
            }
            Some(canonical_cwd.to_string_lossy().into_owned())
        }
        None => None,
    };

    Some(CovenSessionSummary {
        id: id.to_string(),
        project_root: project_scope.project_root.clone(),
        cwd,
        labels: normalized_labels(fields)?,
        harness: optional_string(fields, "harness", "harness")?,
        model: optional_string(fields, "model", "model")?,
        current_task: optional_string(fields, "currentTask", "current_task")?,
        input_tokens: optional_javascript_safe_u64(fields, "inputTokens", "input_tokens"),
        output_tokens: optional_javascript_safe_u64(fields, "outputTokens", "output_tokens"),
        title: optional_string(fields, "title", "title")?,
        status: optional_string(fields, "status", "status")?,
        created_at: optional_string(fields, "createdAt", "created_at")?,
        updated_at: optional_string(fields, "updatedAt", "updated_at")?,
        archived_at: optional_string(fields, "archivedAt", "archived_at")?,
    })
}

fn normalized_labels(fields: &Map<String, Value>) -> Option<Vec<String>> {
    let Some(values) = fields.get("labels") else {
        return Some(Vec::new());
    };
    let values = values.as_array()?;
    if values.len() > 16 {
        return None;
    }

    let mut seen = HashSet::with_capacity(values.len());
    let mut labels = Vec::with_capacity(values.len());
    for value in values {
        let label = value.as_str()?;
        if !(1..=64).contains(&label.len())
            || !label.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
            || !seen.insert(label)
        {
            return None;
        }
        labels.push(label.to_string());
    }
    Some(labels)
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

fn optional_javascript_safe_u64(
    fields: &Map<String, Value>,
    camel_case: &str,
    snake_case: &str,
) -> Option<u64> {
    fields
        .get(camel_case)
        .or_else(|| fields.get(snake_case))
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_JAVASCRIPT_SAFE_INTEGER_U64)
}

#[cfg(test)]
#[cfg(all(test, unix))]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;
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

    fn expected_request(method: &str, path: &str) -> Vec<u8> {
        format!(
            "{method} {path} HTTP/1.1\r\nHost: coven\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn assert_server_requests(server: &FakeServer, paths: &[&str]) {
        for path in paths {
            assert_eq!(server.recv_request(), expected_request("GET", path));
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

    #[test]
    fn windows_unavailable_response_has_only_status_and_reason() {
        assert_eq!(
            serde_json::to_value(windows_transport_unavailable_response()).unwrap(),
            json!({
                "status": "unavailable",
                "reason": "local Coven Unix socket transport is unsupported on Windows"
            })
        );
    }

    #[test]
    fn collects_only_configured_unicode_coven_environment_values() {
        let env = coven_environment([
            ("COVEN_SOCKET", Some(OsString::from("/tmp/coven.sock"))),
            ("COVEN_HOME", None),
            ("COVEN_URL", Some(OsString::from("http://127.0.0.1:7777"))),
            ("COVEN_PORT", Some(OsString::from("7778"))),
        ])
        .unwrap();

        assert_eq!(env.len(), 3);
        assert_eq!(
            env.get("COVEN_SOCKET").map(String::as_str),
            Some("/tmp/coven.sock")
        );
        assert_eq!(
            env.get("COVEN_URL").map(String::as_str),
            Some("http://127.0.0.1:7777")
        );
        assert_eq!(env.get("COVEN_PORT").map(String::as_str), Some("7778"));
    }

    #[test]
    fn falls_back_to_root_when_home_is_missing() {
        assert_eq!(home_path(None), PathBuf::from("/"));
        assert_eq!(
            home_path(Some(OsString::from("/Users/tester"))),
            PathBuf::from("/Users/tester")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_non_unicode_coven_environment_values() {
        use std::os::unix::ffi::OsStringExt;

        assert!(
            coven_environment([("COVEN_SOCKET", Some(OsString::from_vec(vec![0xff])),)]).is_err()
        );
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
                labels: vec!["source:psyche-build".to_string()],
                harness: None,
                model: None,
                current_task: None,
                input_tokens: None,
                output_tokens: None,
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
                    "labels": ["source:psyche-build"],
                    "harness": null,
                    "model": null,
                    "currentTask": null,
                    "inputTokens": null,
                    "outputTokens": null,
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
        assert_eq!(EXCHANGE_TIMEOUT, Duration::from_secs(2));
        assert_eq!(MAX_RESPONSE_BYTES, 1024 * 1024);
        assert_eq!(STABLE_API_VERSION, "coven.daemon.v1");
    }

    #[test]
    fn deserializes_project_scope_from_camel_case_command_fields() {
        let scope: CovenProjectScope = serde_json::from_value(json!({
            "projectRoot": "/project",
            "worktreeRoots": ["/worktree"]
        }))
        .unwrap();

        assert_eq!(scope.project_root, "/project");
        assert_eq!(scope.worktree_roots, vec!["/worktree"]);
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
                    "labels": ["source:psyche-build"],
                    "harness": "  codex  ",
                    "model": "  claude-sonnet  ",
                    "currentTask": "  review tests  ",
                    "inputTokens": 11,
                    "outputTokens": 7,
                    "title": "  title  ",
                    "status": "  active  ",
                    "createdAt": "  c1  ",
                    "updatedAt": "  u1  ",
                    "archivedAt": "  a1  "
                },
                {
                    "id": "snake",
                    "project_root": project,
                    "labels": ["source:psyche-build"],
                    "model": "gpt-5.5",
                    "current_task": "answer follow-up",
                    "input_tokens": 22,
                    "output_tokens": 9,
                    "created_at": "c2",
                    "updated_at": "u2",
                    "archived_at": "a2"
                },
                {
                    "id": "invalid-tokens",
                    "projectRoot": project,
                    "inputTokens": "99",
                    "outputTokens": -1
                }
            ]
        });

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions[0].labels, vec!["source:psyche-build"]);
        assert_eq!(sessions[0].harness.as_deref(), Some("codex"));
        assert_eq!(sessions[0].model.as_deref(), Some("claude-sonnet"));
        assert_eq!(sessions[0].current_task.as_deref(), Some("review tests"));
        assert_eq!(sessions[0].input_tokens, Some(11));
        assert_eq!(sessions[0].output_tokens, Some(7));
        assert_eq!(sessions[0].title.as_deref(), Some("title"));
        assert_eq!(sessions[0].status.as_deref(), Some("active"));
        assert_eq!(sessions[0].created_at.as_deref(), Some("c1"));
        assert_eq!(sessions[0].updated_at.as_deref(), Some("u1"));
        assert_eq!(sessions[0].archived_at.as_deref(), Some("a1"));
        assert_eq!(sessions[0].cwd, None);
        assert_eq!(sessions[1].labels, vec!["source:psyche-build"]);
        assert_eq!(sessions[1].model.as_deref(), Some("gpt-5.5"));
        assert_eq!(
            sessions[1].current_task.as_deref(),
            Some("answer follow-up")
        );
        assert_eq!(sessions[1].input_tokens, Some(22));
        assert_eq!(sessions[1].output_tokens, Some(9));
        assert_eq!(sessions[1].created_at.as_deref(), Some("c2"));
        assert_eq!(sessions[1].updated_at.as_deref(), Some("u2"));
        assert_eq!(sessions[1].archived_at.as_deref(), Some("a2"));
        assert_eq!(sessions[2].id, "invalid-tokens");
        assert_eq!(sessions[2].input_tokens, None);
        assert_eq!(sessions[2].output_tokens, None);
    }

    #[test]
    fn accepts_token_metadata_at_javascript_safe_integer_boundary() {
        let tree = TempTree::new("max-safe-tokens");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let payload = json!([{
            "id": "max-safe",
            "projectRoot": project,
            "inputTokens": MAX_JAVASCRIPT_SAFE_INTEGER_U64,
            "outputTokens": MAX_JAVASCRIPT_SAFE_INTEGER_U64,
        }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].input_tokens,
            Some(MAX_JAVASCRIPT_SAFE_INTEGER_U64)
        );
        assert_eq!(
            sessions[0].output_tokens,
            Some(MAX_JAVASCRIPT_SAFE_INTEGER_U64)
        );
    }

    #[test]
    fn omits_token_metadata_past_javascript_safe_integer_boundary() {
        let tree = TempTree::new("unsafe-tokens");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let payload = json!([{
            "id": "unsafe-tokens",
            "projectRoot": project,
            "inputTokens": MAX_JAVASCRIPT_SAFE_INTEGER_U64 + 1,
            "outputTokens": MAX_JAVASCRIPT_SAFE_INTEGER_U64 + 1,
        }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "unsafe-tokens");
        assert_eq!(sessions[0].input_tokens, None);
        assert_eq!(sessions[0].output_tokens, None);
    }

    #[test]
    fn normalizes_missing_session_labels_to_an_empty_list() {
        let tree = TempTree::new("missing-labels");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let payload = json!([{ "id": "legacy", "projectRoot": project }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();

        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].labels.is_empty());
    }

    #[test]
    fn normalizes_label_boundaries_and_preserves_request_order() {
        let tree = TempTree::new("label-boundaries");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let mut labels = vec!["a._:-Z9".to_string(), "x".repeat(64)];
        labels.extend((2..16).map(|index| format!("label-{index}")));
        let payload = json!([{
            "id": "boundaries",
            "projectRoot": project,
            "labels": labels
        }]);

        let sessions = normalize_sessions(payload, &requested).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].labels, labels);
    }

    #[test]
    fn normalizes_by_dropping_sessions_with_malformed_labels() {
        let tree = TempTree::new("malformed-labels");
        let project = tree.directory("project");
        let requested = vec![project.clone()];
        let malformed = [
            ("non-array", json!("source:psyche-build")),
            ("non-string", json!(["valid", 1])),
            (
                "too-many",
                Value::Array(
                    (0..17)
                        .map(|index| json!(format!("label-{index}")))
                        .collect(),
                ),
            ),
            ("duplicate", json!(["duplicate", "duplicate"])),
            ("empty", json!([""])),
            ("too-long", json!(["x".repeat(65)])),
            ("non-ascii", json!(["café"])),
            ("illegal-space", json!(["has space"])),
        ];

        for (case, labels) in malformed {
            let payload = json!([{
                "id": case,
                "projectRoot": project,
                "labels": labels
            }]);

            let sessions = normalize_sessions(payload, &requested).unwrap();

            assert!(sessions.is_empty(), "accepted malformed {case} labels");
        }
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
    fn keeps_only_cwds_within_requested_project_or_worktree_roots() {
        let tree = TempTree::new("cwd-scope");
        let project = tree.directory("project");
        let inside = tree.directory("project/inside");
        let linked_worktree = tree.directory("external-worktree");
        let outside = tree.directory("outside");
        let requested = vec![project.clone(), linked_worktree.clone()];
        let project_scopes = vec![CovenProjectScope {
            project_root: project.to_string_lossy().into_owned(),
            worktree_roots: vec![linked_worktree.to_string_lossy().into_owned()],
        }];
        let payload = json!([
            { "id": "inside", "projectRoot": project, "cwd": inside },
            { "id": "linked", "projectRoot": project, "cwd": linked_worktree },
            { "id": "outside", "projectRoot": project, "cwd": outside }
        ]);

        let sessions =
            normalize_sessions_with_scopes(payload, &requested, &project_scopes).unwrap();
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec!["inside", "linked"],
        );
        assert_eq!(
            sessions[0].cwd.as_deref(),
            Some(inside.canonicalize().unwrap().to_string_lossy().as_ref())
        );
        assert_eq!(
            sessions[1].cwd.as_deref(),
            Some(
                linked_worktree
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn legacy_flat_roots_preserve_union_cwd_authorization() {
        let tree = TempTree::new("legacy-flat-cwd");
        let project = tree.directory("project");
        let linked_worktree = tree.directory("linked-worktree");
        let requested = vec![project.clone(), linked_worktree.clone()];
        let payload = json!([
            { "id": "legacy-linked", "projectRoot": project, "cwd": linked_worktree }
        ]);

        let sessions = normalize_sessions(payload, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "legacy-linked");
        assert_eq!(
            sessions[0].cwd.as_deref(),
            Some(
                linked_worktree
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
    }

    #[test]
    fn rejects_a_cwd_owned_by_another_requested_project() {
        let tree = TempTree::new("cross-project-cwd");
        let first = tree.directory("first");
        let first_worktree = tree.directory("first-worktree");
        let second = tree.directory("second");
        let requested = vec![
            CovenProjectScope {
                project_root: first.to_string_lossy().into_owned(),
                worktree_roots: vec![first_worktree.to_string_lossy().into_owned()],
            },
            CovenProjectScope {
                project_root: second.to_string_lossy().into_owned(),
                worktree_roots: vec![],
            },
        ];
        let roots = vec![first, first_worktree.clone(), second.clone()];
        let payload = json!([
            { "id": "wrong-owner", "projectRoot": second, "cwd": first_worktree }
        ]);

        let sessions = normalize_sessions_with_scopes(payload, &roots, &requested).unwrap();
        assert!(sessions.is_empty());
    }

    #[test]
    fn returns_canonical_owned_cwd_for_aliases() {
        let tree = TempTree::new("canonical-cwd");
        let project = tree.directory("project");
        let cwd = tree.directory("project/worktree");
        let cwd_alias = cwd.join("..").join("worktree");
        let requested = vec![CovenProjectScope {
            project_root: project.to_string_lossy().into_owned(),
            worktree_roots: vec![],
        }];
        let roots = vec![project.clone()];
        let payload = json!([
            { "id": "canonical", "projectRoot": project, "cwd": cwd_alias }
        ]);

        let sessions = normalize_sessions_with_scopes(payload, &roots, &requested).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].cwd.as_deref(),
            Some(cwd.canonicalize().unwrap().to_string_lossy().as_ref())
        );
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
        assert_eq!(health_request, expected_request("GET", "/api/v1/health"));
        assert_eq!(
            sessions_request,
            expected_request("GET", "/api/v1/sessions")
        );
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
        assert_eq!(health_request, expected_request("GET", "/api/v1/health"));
        assert_eq!(
            sessions_request,
            expected_request("GET", "/api/v1/sessions")
        );
    }

    #[test]
    fn kills_a_session_over_loopback_tcp_with_exact_requests() {
        let (endpoint, server) = spawn_tcp_server(vec![
            http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
            http_json(b"{}"),
        ]);

        let result = try_kill_coven_session(&endpoint, "release:fix_01.a-b");
        let health_request = server.recv_request();
        let kill_request = server.recv_request();
        server.finish();

        assert_eq!(result, Ok(()));
        assert_eq!(health_request, expected_request("GET", "/api/v1/health"));
        assert_eq!(
            kill_request,
            expected_request("POST", "/api/v1/sessions/release:fix_01.a-b/kill")
        );
    }

    #[cfg(unix)]
    #[test]
    fn kills_a_session_over_unix_with_exact_requests() {
        let socket = TempSocket::new("kill-round-trip");
        let server = spawn_unix_server(
            &socket.path,
            vec![
                http_json(br#"{"apiVersion":"coven.daemon.v1"}"#),
                http_json(b"{}"),
            ],
        );
        let endpoint = CovenEndpoint::Unix(socket.path.clone());

        let result = try_kill_coven_session(&endpoint, "release:fix_01.a-b");
        let health_request = server.recv_request();
        let kill_request = server.recv_request();
        server.finish();

        assert_eq!(result, Ok(()));
        assert_eq!(health_request, expected_request("GET", "/api/v1/health"));
        assert_eq!(
            kill_request,
            expected_request("POST", "/api/v1/sessions/release:fix_01.a-b/kill")
        );
    }

    #[test]
    fn rejects_an_unsafe_kill_id_before_connecting() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = CovenEndpoint::Http(listener.local_addr().unwrap());

        assert_eq!(
            try_kill_coven_session(&endpoint, "../foreign"),
            Err(CovenAdapterError::Failed)
        );
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
        );
    }

    #[test]
    fn maps_kill_adapter_errors_to_operator_messages() {
        assert_eq!(
            adapter_error_message(CovenAdapterError::Unavailable),
            UNAVAILABLE_MESSAGE
        );
        assert_eq!(
            adapter_error_message(CovenAdapterError::Incompatible),
            INCOMPATIBLE_MESSAGE
        );
        assert_eq!(
            adapter_error_message(CovenAdapterError::Failed),
            "Coven session could not be stopped"
        );
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
        assert_eq!(request, expected_request("GET", "/api/v1/health"));
        assert_adapter_state(
            &response,
            "unavailable",
            Some("Coven daemon is not running; run `coven daemon start`"),
        );
    }

    #[test]
    fn enforces_wall_clock_deadline_against_slow_drip_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = CovenEndpoint::Http(listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            configure_fake_tcp_stream(&stream).unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert_eq!(request, expected_request("GET", "/api/v1/health"));

            let response = http_json(br#"{"apiVersion":"coven.daemon.v1"}"#);
            for byte in response {
                match stream.write_all(&[byte]) {
                    Ok(()) => thread::sleep(Duration::from_millis(100)),
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                        ) =>
                    {
                        break;
                    }
                    Err(error) => panic!("slow-drip server write failed: {error}"),
                }
            }
        });

        let started = Instant::now();
        let result = request_endpoint(
            &endpoint,
            HttpMethod::Get,
            "/api/v1/health",
            Instant::now() + EXCHANGE_TIMEOUT,
        );
        let elapsed = started.elapsed();
        server.join().unwrap();

        assert_eq!(result, Err(CovenAdapterError::Unavailable));
        assert!(
            elapsed < Duration::from_secs(3),
            "wall-clock deadline took {elapsed:?}"
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
        assert_eq!(health_request, expected_request("GET", "/api/v1/health"));
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
        assert_eq!(request, expected_request("GET", "/api/v1/health"));
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
        assert_eq!(request, expected_request("GET", "/api/v1/health"));
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
