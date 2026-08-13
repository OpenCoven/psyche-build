use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Read as StdRead;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(windows)]
use tokio::net::windows::named_pipe::ClientOptions;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use unicode_normalization::UnicodeNormalization;

pub const MAX_PROVIDER_LINE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PROVIDER_RESULT_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PENDING_REQUESTS: usize = 128;
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

#[derive(Default)]
pub struct ControlProviderState {
    connections: Arc<Mutex<HashMap<String, Arc<ManagedProvider>>>>,
    next_generation: AtomicU64,
}

impl Drop for ControlProviderState {
    fn drop(&mut self) {
        for (_, connection) in self.connections.lock().drain() {
            connection.clear_pending("control provider manager dropped");
            if let Some(task) = connection.task.lock().take() {
                task.abort();
            }
        }
    }
}

struct ManagedProvider {
    generation: u64,
    provider_id: String,
    writer: mpsc::Sender<OutboundFrame>,
    pending: Arc<Mutex<HashSet<String>>>,
    responses: Arc<Mutex<HashMap<String, PendingResponse>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

struct PendingResponse {
    expected_type: &'static str,
    sender: oneshot::Sender<Result<Value, String>>,
}

impl ManagedProvider {
    fn clear_pending(&self, reason: &str) {
        self.pending.lock().clear();
        for (_, response) in self.responses.lock().drain() {
            let _ = response.sender.send(Err(reason.to_string()));
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    project_root: String,
    provider_id: String,
    connected: bool,
    pending_effects: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabResource {
    id: String,
    kind: String,
    generation: u64,
    provider_id: String,
    webview_label: String,
    project_root: String,
    worktree_root: String,
    url: String,
    title: String,
    loading: bool,
    viewport: BrowserViewport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProviderEffectResult {
    Succeeded {
        action_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
    Failed {
        action_id: String,
        code: String,
        message: String,
    },
    Unknown {
        action_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

impl ProviderEffectResult {
    fn action_id(&self) -> &str {
        match self {
            Self::Succeeded { action_id, .. }
            | Self::Failed { action_id, .. }
            | Self::Unknown { action_id, .. } => action_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseTarget {
    kind: String,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseGrant {
    target: LeaseTarget,
    capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OperatorCommand {
    LeaseGrant {
        request_id: String,
        actor_id: String,
        task_id: String,
        ttl_ms: u64,
        grants: Vec<LeaseGrant>,
    },
    LeaseRevoke {
        lease_id: String,
    },
    ApprovalResolve {
        approval_id: String,
        payload_digest: String,
        decision: ApprovalDecision,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEffectRequest {
    version: u8,
    #[serde(rename = "type")]
    frame_type: String,
    request_id: String,
    action_id: String,
    tab_id: String,
    generation: u64,
    operation: Value,
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    project_root: Option<String>,
}

fn validate_effect_request(effect: &ProviderEffectRequest) -> Result<(), String> {
    if effect.version != 1 || effect.frame_type != "provider.effect.request" {
        return Err("invalid provider effect envelope".to_string());
    }
    if effect.request_id != effect.action_id
        || effect.request_id.trim().is_empty()
        || effect.action_id.trim().is_empty()
        || effect.tab_id.trim().is_empty()
        || effect.request_id.len() > 256
        || effect.action_id.len() > 256
        || effect.tab_id.len() > 256
        || effect.generation == 0
    {
        return Err("invalid provider effect identity".to_string());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum OutboundFrame {
    #[serde(rename = "hello", rename_all = "camelCase")]
    Hello {
        version: u8,
        request_id: String,
        token: String,
        client_name: String,
        project_root: String,
    },
    #[serde(rename = "provider.register", rename_all = "camelCase")]
    Register {
        version: u8,
        request_id: String,
        provider_id: String,
    },
    #[serde(rename = "provider.resource.upsert", rename_all = "camelCase")]
    ResourceUpsert {
        version: u8,
        request_id: String,
        resource: BrowserTabResource,
    },
    #[serde(rename = "provider.resource.remove", rename_all = "camelCase")]
    ResourceRemove {
        version: u8,
        request_id: String,
        id: String,
        generation: u64,
    },
    #[serde(rename = "provider.effect.result", rename_all = "camelCase")]
    EffectResult {
        version: u8,
        request_id: String,
        result: ProviderEffectResult,
    },
    #[serde(rename = "command.submit", rename_all = "camelCase")]
    CommandSubmit {
        version: u8,
        request_id: String,
        command: Value,
    },
    #[serde(rename = "state.get", rename_all = "camelCase")]
    StateGet { version: u8, request_id: String },
}

impl OutboundFrame {
    fn request_id(&self) -> &str {
        match self {
            Self::Hello { request_id, .. }
            | Self::Register { request_id, .. }
            | Self::ResourceUpsert { request_id, .. }
            | Self::ResourceRemove { request_id, .. }
            | Self::EffectResult { request_id, .. }
            | Self::CommandSubmit { request_id, .. }
            | Self::StateGet { request_id, .. } => request_id,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredentials {
    operator_token: String,
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
enum IdentityPlatform {
    MacOs,
    Windows,
    Other,
}

fn normalize_canonical_identity_for(platform: IdentityPlatform, canonical: &str) -> String {
    match platform {
        IdentityPlatform::MacOs => canonical.nfc().collect(),
        IdentityPlatform::Windows => {
            if let Some(rest) = canonical.strip_prefix(r"\\?\UNC\") {
                format!(r"\\{rest}")
            } else {
                canonical
                    .strip_prefix(r"\\?\")
                    .unwrap_or(canonical)
                    .to_string()
            }
        }
        IdentityPlatform::Other => canonical.to_string(),
    }
}

fn normalize_canonical_identity(canonical: &Path) -> String {
    #[cfg(target_os = "macos")]
    let platform = IdentityPlatform::MacOs;
    #[cfg(windows)]
    let platform = IdentityPlatform::Windows;
    #[cfg(not(any(target_os = "macos", windows)))]
    let platform = IdentityPlatform::Other;
    normalize_canonical_identity_for(platform, &canonical.to_string_lossy())
}

fn project_identity_hash(identity: &str) -> String {
    let encoded = format!("{:x}", Sha256::digest(identity.as_bytes()));
    encoded.chars().take(20).collect()
}

struct CanonicalProjectRoot {
    path: PathBuf,
    identity: String,
}

fn canonical_root(project_root: &str) -> Result<CanonicalProjectRoot, String> {
    let path = Path::new(project_root)
        .canonicalize()
        .map_err(|error| format!("invalid project root: {error}"))?;
    let identity = normalize_canonical_identity(&path);
    Ok(CanonicalProjectRoot { path, identity })
}

fn endpoint_for_root(identity: &str) -> Result<PathBuf, String> {
    let identifier = project_identity_hash(identity);
    #[cfg(windows)]
    {
        return Ok(PathBuf::from(format!(
            r"\\.\pipe\psyche-control-{identifier}"
        )));
    }
    #[cfg(unix)]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
        Ok(PathBuf::from(home)
            .join(".psyche/runtime/sockets")
            .join(format!("{identifier}.sock")))
    }
}

fn operator_token(root: &Path) -> Result<String, String> {
    let path = root.join(".psyche/runtime/control-credentials.json");
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options
        .open(&path)
        .map_err(|error| format!("control credentials unavailable: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("control credentials unavailable: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("control credentials must be a regular file".to_string());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("control credentials must have mode 0600".to_string());
    }
    if metadata.len() > MAX_CREDENTIAL_BYTES {
        return Err("control credentials exceed maximum size".to_string());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CREDENTIAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("control credentials unavailable: {error}"))?;
    if bytes.len() as u64 > MAX_CREDENTIAL_BYTES {
        return Err("control credentials exceed maximum size".to_string());
    }
    let stored: StoredCredentials = serde_json::from_slice(&bytes)
        .map_err(|_| "control credentials are invalid".to_string())?;
    if stored.operator_token.is_empty() {
        return Err("operator token is missing".to_string());
    }
    Ok(stored.operator_token)
}

async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &OutboundFrame,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(frame).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_PROVIDER_LINE_BYTES {
        return Err("provider frame exceeds maximum size".to_string());
    }
    bytes.push(b'\n');
    timeout(WRITE_TIMEOUT, writer.write_all(&bytes))
        .await
        .map_err(|_| "control provider write timed out".to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
async fn connect_control(endpoint: &Path) -> Result<UnixStream, String> {
    UnixStream::connect(endpoint)
        .await
        .map_err(|error| format!("control owner unavailable: {error}"))
}

#[cfg(windows)]
async fn connect_control(
    endpoint: &Path,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    ClientOptions::new()
        .open(endpoint)
        .map_err(|error| format!("control owner unavailable: {error}"))
}

fn ensure_trusted_control_caller(label: &str) -> Result<(), String> {
    if label == "main" {
        return Ok(());
    }
    Err(format!(
        "control provider authority is only available to trusted webview 'main'; rejected caller '{label}'"
    ))
}

async fn send_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    project_identity: &str,
    token: String,
    provider_id: String,
) -> Result<(), String> {
    write_frame(
        stream,
        &OutboundFrame::Hello {
            version: 1,
            request_id: "hello".to_string(),
            token,
            client_name: "psyche-build-desktop".to_string(),
            project_root: project_identity.to_string(),
        },
    )
    .await?;
    expect_handshake_response(stream, "welcome", "welcome").await?;
    write_frame(
        stream,
        &OutboundFrame::Register {
            version: 1,
            request_id: "provider-register".to_string(),
            provider_id,
        },
    )
    .await?;
    expect_handshake_response(stream, "ack", "provider-register").await
}

async fn connect_provider(
    root: &CanonicalProjectRoot,
    token: &str,
    provider_id: &str,
) -> Result<impl AsyncRead + AsyncWrite + Unpin, String> {
    let endpoint = endpoint_for_root(&root.identity)?;
    let mut stream = connect_control(&endpoint).await?;
    send_handshake(
        &mut stream,
        &root.identity,
        token.to_string(),
        provider_id.to_string(),
    )
    .await?;
    Ok(stream)
}

async fn read_bounded_line<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        let read = reader
            .read(&mut byte)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("truncated provider frame".to_string())
            };
        }
        if byte[0] == b'\n' {
            return Ok(Some(line));
        }
        if line.len() >= MAX_PROVIDER_LINE_BYTES {
            return Err("provider frame exceeds maximum size".to_string());
        }
        line.push(byte[0]);
    }
}

async fn expect_handshake_response<R: AsyncRead + Unpin>(
    reader: &mut R,
    expected_type: &str,
    expected_request_id: &str,
) -> Result<(), String> {
    let line = timeout(REQUEST_TIMEOUT, read_bounded_line(reader))
        .await
        .map_err(|_| "control provider handshake timed out".to_string())??
        .ok_or_else(|| "control provider disconnected during handshake".to_string())?;
    let value: Value = serde_json::from_slice(&line)
        .map_err(|_| "control provider handshake response is invalid".to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || value.get("requestId").and_then(Value::as_str) != Some(expected_request_id)
    {
        return Err("control provider handshake correlation is invalid".to_string());
    }
    if value.get("type").and_then(Value::as_str) == Some(expected_type) {
        return Ok(());
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("control provider handshake failed");
    let code = value.get("code").and_then(Value::as_str);
    Err(match code {
        Some(code) => format!("{code}: {message}"),
        None => message.to_string(),
    })
}

async fn provider_loop<R, W>(
    app: AppHandle,
    root_key: String,
    generation: u64,
    mut reader: R,
    mut writer: W,
    mut frames: mpsc::Receiver<OutboundFrame>,
    pending: Arc<Mutex<HashSet<String>>>,
    responses: Arc<Mutex<HashMap<String, PendingResponse>>>,
    connections: Arc<Mutex<HashMap<String, Arc<ManagedProvider>>>>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            line = read_bounded_line(&mut reader) => {
                let Some(line) = line.ok().flatten() else { break };
                let Ok(value) = serde_json::from_slice::<Value>(&line) else { break };
                if value.get("type").and_then(Value::as_str) == Some("provider.effect.request") {
                    let Ok(mut effect) = serde_json::from_value::<ProviderEffectRequest>(value) else { break };
                    if validate_effect_request(&effect).is_err() {
                        break;
                    }
                    {
                        let mut pending_effects = pending.lock();
                        if pending_effects.len() >= MAX_PENDING_REQUESTS
                            || pending_effects.contains(&effect.action_id)
                        {
                            break;
                        }
                        pending_effects.insert(effect.action_id.clone());
                    }
                    effect.project_root = Some(root_key.clone());
                    let emitted = app
                        .get_webview_window("main")
                        .ok_or(())
                        .and_then(|window| window.emit("control:provider-effect-request", &effect).map_err(|_| ()));
                    if emitted.is_err() { break; }
                    continue;
                }
                if !resolve_provider_response(&responses, value) { break; }
            }
            frame = frames.recv() => {
                let Some(frame) = frame else { break };
                if write_frame(&mut writer, &frame).await.is_err() { break; }
            }
        }
    }

    pending.lock().clear();
    for (_, response) in responses.lock().drain() {
        let _ = response
            .sender
            .send(Err("control provider disconnected".to_string()));
    }
    let should_remove = connections
        .lock()
        .get(&root_key)
        .is_some_and(|connection| connection.generation == generation);
    if should_remove {
        connections.lock().remove(&root_key);
    }
}

fn resolve_provider_response(
    responses: &Mutex<HashMap<String, PendingResponse>>,
    value: Value,
) -> bool {
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return false;
    }
    let Some(frame_type) = value.get("type").and_then(Value::as_str) else {
        return false;
    };
    let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
        return false;
    };
    if frame_type.is_empty()
        || frame_type.len() > 64
        || request_id.is_empty()
        || request_id.len() > 256
    {
        return false;
    }
    let Some(response) = responses.lock().remove(request_id) else {
        return frame_type == "ack" || frame_type == "error";
    };
    if frame_type == "error" {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("control request failed")
            .to_string();
        let _ = response.sender.send(Err(message));
        return true;
    }
    if frame_type == response.expected_type {
        let _ = response.sender.send(Ok(value));
        return true;
    }
    let expected = response.expected_type;
    let _ = response.sender.send(Err(format!(
        "unexpected control response type '{frame_type}'; expected '{expected}'"
    )));
    false
}

fn next_request_id(state: &ControlProviderState) -> String {
    let sequence = state.next_generation.fetch_add(1, Ordering::Relaxed);
    format!("desktop-{sequence}")
}

fn connection_for(
    state: &ControlProviderState,
    root: &CanonicalProjectRoot,
) -> Result<Arc<ManagedProvider>, String> {
    state
        .connections
        .lock()
        .get(&root.identity)
        .cloned()
        .ok_or_else(|| "control provider is not connected".to_string())
}

async fn send_request(connection: &ManagedProvider, frame: OutboundFrame) -> Result<Value, String> {
    let request_id = frame.request_id().to_string();
    let (sender, receiver) = oneshot::channel();
    reserve_response(&connection.responses, request_id.clone(), "ack", sender)?;
    let sent = timeout(WRITE_TIMEOUT, connection.writer.send(frame)).await;
    if !matches!(sent, Ok(Ok(()))) {
        connection.responses.lock().remove(&request_id);
        return Err(match sent {
            Err(_) => "control provider queue timed out".to_string(),
            _ => "control provider is disconnected".to_string(),
        });
    }
    match timeout(REQUEST_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("control provider disconnected".to_string()),
        Err(_) => {
            connection.responses.lock().remove(&request_id);
            Err("control provider request timed out".to_string())
        }
    }
}

fn reserve_response(
    responses: &Mutex<HashMap<String, PendingResponse>>,
    request_id: String,
    expected_type: &'static str,
    sender: oneshot::Sender<Result<Value, String>>,
) -> Result<(), String> {
    let mut responses = responses.lock();
    if responses.len() >= MAX_PENDING_REQUESTS {
        return Err("control provider request limit reached".to_string());
    }
    if responses.contains_key(&request_id) {
        return Err("duplicate control provider request id".to_string());
    }
    responses.insert(
        request_id,
        PendingResponse {
            expected_type,
            sender,
        },
    );
    Ok(())
}

async fn standalone_control_request(
    root: &CanonicalProjectRoot,
    frame: OutboundFrame,
) -> Result<Value, String> {
    let token = operator_token(&root.path)?;
    let endpoint = endpoint_for_root(&root.identity)?;
    let mut stream = connect_control(&endpoint).await?;
    write_frame(
        &mut stream,
        &OutboundFrame::Hello {
            version: 1,
            request_id: "hello".to_string(),
            token,
            client_name: "psyche-build-operator".to_string(),
            project_root: root.identity.clone(),
        },
    )
    .await?;
    expect_handshake_response(&mut stream, "welcome", "welcome").await?;
    let expected_request_id = frame.request_id().to_string();
    let expected_type = match &frame {
        OutboundFrame::CommandSubmit { .. } => "command.result",
        OutboundFrame::StateGet { .. } => "state.result",
        _ => return Err("unsupported standalone control request".to_string()),
    };
    write_frame(&mut stream, &frame).await?;
    let line = timeout(REQUEST_TIMEOUT, read_bounded_line(&mut stream))
        .await
        .map_err(|_| "control request timed out".to_string())??
        .ok_or_else(|| "control owner disconnected".to_string())?;
    let value: Value =
        serde_json::from_slice(&line).map_err(|_| "control response is invalid".to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || value.get("requestId").and_then(Value::as_str) != Some(&expected_request_id)
    {
        return Err("control response correlation is invalid".to_string());
    }
    if value.get("type").and_then(Value::as_str) == Some("error") {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("control request failed")
            .to_string());
    }
    if value.get("type").and_then(Value::as_str) != Some(expected_type) {
        return Err(format!(
            "unexpected control response type; expected '{expected_type}'"
        ));
    }
    Ok(value)
}

#[tauri::command]
pub async fn control_provider_start(
    webview: tauri::Webview,
    app: AppHandle,
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<ProviderStatus, String> {
    ensure_trusted_control_caller(webview.label())?;
    let root = canonical_root(&project_root)?;
    let root_key = root.identity.clone();
    let previous = { state.connections.lock().remove(&root_key) };
    if let Some(previous) = previous {
        previous.clear_pending("control provider reconnecting");
        let old_task = { previous.task.lock().take() };
        if let Some(task) = old_task {
            task.abort();
            let _ = task.await;
        }
    }

    let token = operator_token(&root.path)?;
    let provider_id = format!("desktop-{}", project_identity_hash(&root_key));
    let mut attempts = 0_u8;
    let stream = loop {
        match connect_provider(&root, &token, &provider_id).await {
            Ok(stream) => break stream,
            Err(error) if attempts < 2 && error.starts_with("provider_already_registered:") => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Err(error) => return Err(error),
        }
    };

    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
    let (reader, writer) = tokio::io::split(stream);
    let (sender, receiver) = mpsc::channel(128);
    let pending = Arc::new(Mutex::new(HashSet::new()));
    let responses = Arc::new(Mutex::new(HashMap::new()));
    let connection = Arc::new(ManagedProvider {
        generation,
        provider_id: provider_id.clone(),
        writer: sender,
        pending: Arc::clone(&pending),
        responses: Arc::clone(&responses),
        task: Mutex::new(None),
    });
    state
        .connections
        .lock()
        .insert(root_key.clone(), Arc::clone(&connection));
    let task = tokio::spawn(provider_loop(
        app,
        root_key,
        generation,
        reader,
        writer,
        receiver,
        pending,
        responses,
        Arc::clone(&state.connections),
    ));
    *connection.task.lock() = Some(task);
    Ok(ProviderStatus {
        project_root: root.identity,
        provider_id,
        connected: true,
        pending_effects: 0,
    })
}

#[tauri::command]
pub async fn control_provider_stop(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<(), String> {
    ensure_trusted_control_caller(webview.label())?;
    let root = canonical_root(&project_root)?;
    let connection = { state.connections.lock().remove(&root.identity) };
    if let Some(connection) = connection {
        connection.clear_pending("control provider stopped");
        let provider_task = { connection.task.lock().take() };
        if let Some(task) = provider_task {
            task.abort();
            let _ = task.await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn control_provider_upsert(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
    project_root: String,
    resource: BrowserTabResource,
) -> Result<BrowserTabResource, String> {
    ensure_trusted_control_caller(webview.label())?;
    let root = canonical_root(&project_root)?;
    let connection = connection_for(&state, &root)?;
    if resource.provider_id != connection.provider_id || resource.project_root != root.identity {
        return Err("browser resource is outside provider scope".to_string());
    }
    let request_id = next_request_id(&state);
    let response = send_request(
        &connection,
        OutboundFrame::ResourceUpsert {
            version: 1,
            request_id,
            resource,
        },
    )
    .await?;
    serde_json::from_value(
        response
            .get("resource")
            .cloned()
            .ok_or_else(|| "provider upsert response omitted canonical resource".to_string())?,
    )
    .map_err(|_| "provider upsert response contained an invalid canonical resource".to_string())
}

#[tauri::command]
pub async fn control_provider_remove(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
    project_root: String,
    tab_id: String,
    generation: u64,
) -> Result<(), String> {
    ensure_trusted_control_caller(webview.label())?;
    let root = canonical_root(&project_root)?;
    let connection = connection_for(&state, &root)?;
    let request_id = next_request_id(&state);
    send_request(
        &connection,
        OutboundFrame::ResourceRemove {
            version: 1,
            request_id,
            id: tab_id,
            generation,
        },
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn control_provider_complete(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
    project_root: String,
    result: ProviderEffectResult,
) -> Result<(), String> {
    ensure_trusted_control_caller(webview.label())?;
    let encoded = serde_json::to_vec(&result).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_PROVIDER_RESULT_BYTES {
        return Err("provider result exceeds maximum size".to_string());
    }
    let root = canonical_root(&project_root)?;
    let connection = connection_for(&state, &root)?;
    let action_id = result.action_id().to_string();
    if !connection.pending.lock().contains(&action_id) {
        return Err("provider effect is not pending".to_string());
    }
    let request_id = next_request_id(&state);
    send_request(
        &connection,
        OutboundFrame::EffectResult {
            version: 1,
            request_id,
            result,
        },
    )
    .await?;
    connection.pending.lock().remove(&action_id);
    Ok(())
}

#[tauri::command]
pub async fn control_operator_submit(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
    project_root: String,
    command: OperatorCommand,
) -> Result<Value, String> {
    ensure_trusted_control_caller(webview.label())?;
    let root = canonical_root(&project_root)?;
    let request_id = next_request_id(&state);
    let (kind, payload) = match command {
        OperatorCommand::LeaseGrant {
            request_id,
            actor_id,
            task_id,
            ttl_ms,
            grants,
        } => (
            "lease.grant",
            json!({ "requestId": request_id, "actorId": actor_id, "taskId": task_id, "ttlMs": ttl_ms, "grants": grants }),
        ),
        OperatorCommand::LeaseRevoke { lease_id } => {
            ("lease.revoke", json!({ "leaseId": lease_id }))
        }
        OperatorCommand::ApprovalResolve {
            approval_id,
            payload_digest,
            decision,
        } => (
            "approval.resolve",
            json!({ "approvalId": approval_id, "payloadDigest": payload_digest, "decision": decision }),
        ),
    };
    let now = format!("{}", chrono_free_timestamp());
    let canonical = json!({
        "id": request_id,
        "idempotencyKey": format!("desktop:{request_id}"),
        "kind": kind,
        "projectRoot": root.identity,
        "createdAt": now,
        "payload": payload,
    });
    standalone_control_request(
        &root,
        OutboundFrame::CommandSubmit {
            version: 1,
            request_id,
            command: canonical,
        },
    )
    .await
}

fn chrono_free_timestamp() -> String {
    // The server validates RFC3339. Avoid a second time crate by formatting UTC
    // through the platform `date` command is not acceptable, so use a stable
    // current-time conversion supplied by serde_json-compatible system time.
    // This placeholder is replaced below by a compact civil-date conversion.
    format_system_time(std::time::SystemTime::now())
}

fn format_system_time(time: std::time::SystemTime) -> String {
    let seconds = time
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        day_seconds / 3600,
        (day_seconds % 3600) / 60,
        day_seconds % 60
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[tauri::command]
pub async fn control_state(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<Value, String> {
    ensure_trusted_control_caller(webview.label())?;
    let root = canonical_root(&project_root)?;
    if !state.connections.lock().contains_key(&root.identity) {
        return Ok(json!({ "connected": false, "projectRoot": root.identity }));
    }
    let request_id = next_request_id(&state);
    standalone_control_request(
        &root,
        OutboundFrame::StateGet {
            version: 1,
            request_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn control_provider_shutdown(
    webview: tauri::Webview,
    state: State<'_, ControlProviderState>,
) -> Result<(), String> {
    ensure_trusted_control_caller(webview.label())?;
    let connections: Vec<_> = {
        let mut managed = state.connections.lock();
        managed.drain().map(|(_, connection)| connection).collect()
    };
    for connection in &connections {
        connection.clear_pending("control provider manager shutting down");
    }
    for connection in connections {
        let provider_task = { connection.task.lock().take() };
        if let Some(task) = provider_task {
            task.abort();
            let _ = task.await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod control_provider_tests {
    use super::*;

    #[test]
    fn endpoint_hash_matches_the_typescript_contract() {
        let vectors = [
            (
                IdentityPlatform::MacOs,
                "/tmp/Cafe\u{301}",
                "/tmp/Café",
                "c5d313be878d0ecbc02e",
            ),
            (
                IdentityPlatform::Windows,
                r"\\?\C:\Users\Val\Repo",
                r"C:\Users\Val\Repo",
                "c256e15c0de5a4be0851",
            ),
            (
                IdentityPlatform::Windows,
                r"\\?\UNC\Server\Share\Repo",
                r"\\Server\Share\Repo",
                "a9c53493f2ac537428dd",
            ),
        ];
        for (platform, raw, expected_identity, expected_hash) in vectors {
            let identity = normalize_canonical_identity_for(platform, raw);
            assert_eq!(identity, expected_identity);
            assert_eq!(project_identity_hash(&identity), expected_hash);
        }
    }

    #[test]
    fn timestamp_is_rfc3339_shaped() {
        assert_eq!(
            format_system_time(std::time::UNIX_EPOCH),
            "1970-01-01T00:00:00Z"
        );
    }

    #[test]
    fn trusted_control_caller_rejects_external_browser_webviews() {
        assert_eq!(ensure_trusted_control_caller("main"), Ok(()));
        let error = ensure_trusted_control_caller("psyche-browser-untrusted")
            .expect_err("external browser webview must not control provider authority");
        assert!(error.contains("trusted webview 'main'"));
        assert!(error.contains("psyche-browser-untrusted"));
    }

    #[test]
    fn response_reservations_are_atomic_bounded_and_unique() {
        let responses = Mutex::new(HashMap::new());
        for index in 0..MAX_PENDING_REQUESTS {
            let (sender, _receiver) = oneshot::channel();
            reserve_response(&responses, format!("request-{index}"), "ack", sender)
                .expect("reservation within bound must succeed");
        }
        let (overflow, _receiver) = oneshot::channel();
        assert!(
            reserve_response(&responses, "overflow".to_string(), "ack", overflow)
                .unwrap_err()
                .contains("limit")
        );

        responses.lock().remove("request-0");
        let (duplicate, _receiver) = oneshot::channel();
        assert!(
            reserve_response(&responses, "request-1".to_string(), "ack", duplicate)
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    fn provider_effect_validation_rejects_wrong_identity_and_envelope() {
        let mut effect = ProviderEffectRequest {
            version: 1,
            frame_type: "provider.effect.request".to_string(),
            request_id: "action-1".to_string(),
            action_id: "action-1".to_string(),
            tab_id: "tab-1".to_string(),
            generation: 1,
            operation: json!({ "kind": "inspect" }),
            project_root: None,
        };
        assert!(validate_effect_request(&effect).is_ok());
        effect.request_id = "other-request".to_string();
        assert!(validate_effect_request(&effect).is_err());
        effect.request_id = effect.action_id.clone();
        effect.version = 2;
        assert!(validate_effect_request(&effect).is_err());
        effect.version = 1;
        effect.action_id.clear();
        assert!(validate_effect_request(&effect).is_err());
    }

    #[test]
    fn provider_responses_require_exact_version_type_and_request_id() {
        let responses = Mutex::new(HashMap::new());

        let (mismatch_sender, mut mismatch_receiver) = oneshot::channel();
        reserve_response(
            &responses,
            "expected-id".to_string(),
            "ack",
            mismatch_sender,
        )
        .unwrap();
        assert!(resolve_provider_response(
            &responses,
            json!({ "version": 1, "type": "ack", "requestId": "other-id" }),
        ));
        assert!(matches!(
            mismatch_receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        responses.lock().remove("expected-id");

        let (wrong_sender, wrong_receiver) = oneshot::channel();
        reserve_response(&responses, "wrong".to_string(), "ack", wrong_sender).unwrap();
        assert!(!resolve_provider_response(
            &responses,
            json!({ "version": 1, "type": "welcome", "requestId": "wrong" }),
        ));
        assert!(wrong_receiver
            .blocking_recv()
            .unwrap()
            .unwrap_err()
            .contains("unexpected"));

        let (ack_sender, ack_receiver) = oneshot::channel();
        reserve_response(&responses, "ack-1".to_string(), "ack", ack_sender).unwrap();
        assert!(resolve_provider_response(
            &responses,
            json!({ "version": 1, "type": "ack", "requestId": "ack-1" }),
        ));
        assert_eq!(
            ack_receiver.blocking_recv().unwrap().unwrap()["type"],
            "ack"
        );

        let (error_sender, error_receiver) = oneshot::channel();
        reserve_response(&responses, "error-1".to_string(), "ack", error_sender).unwrap();
        assert!(resolve_provider_response(
            &responses,
            json!({ "version": 1, "type": "error", "requestId": "error-1", "message": "denied" }),
        ));
        assert_eq!(
            error_receiver.blocking_recv().unwrap().unwrap_err(),
            "denied"
        );

        assert!(!resolve_provider_response(
            &responses,
            json!({ "version": 2, "type": "ack", "requestId": "unknown" }),
        ));
    }
}
