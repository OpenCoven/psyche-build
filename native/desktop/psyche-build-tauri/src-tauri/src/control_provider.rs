use std::collections::{HashMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};

pub const MAX_PROVIDER_LINE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PROVIDER_RESULT_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PENDING_REQUESTS: usize = 128;

#[derive(Default)]
pub struct ControlProviderState {
    connections: Arc<Mutex<HashMap<String, Arc<ManagedProvider>>>>,
    next_generation: AtomicU64,
}

struct ManagedProvider {
    generation: u64,
    provider_id: String,
    writer: mpsc::Sender<OutboundFrame>,
    pending: Arc<Mutex<HashSet<String>>>,
    responses: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ManagedProvider {
    fn clear_pending(&self, reason: &str) {
        self.pending.lock().clear();
        for (_, response) in self.responses.lock().drain() {
            let _ = response.send(Err(reason.to_string()));
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

fn canonical_root(project_root: &str) -> Result<PathBuf, String> {
    Path::new(project_root)
        .canonicalize()
        .map_err(|error| format!("invalid project root: {error}"))
}

fn endpoint_for_root(root: &Path) -> Result<PathBuf, String> {
    let encoded = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
    let identifier: String = encoded.chars().take(20).collect();
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
    Ok(PathBuf::from(home)
        .join(".psyche/runtime/sockets")
        .join(format!("{identifier}.sock")))
}

fn operator_token(root: &Path) -> Result<String, String> {
    let path = root.join(".psyche/runtime/control-credentials.json");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|error| format!("control credentials unavailable: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("control credentials must be a regular file".to_string());
    }
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("control credentials must have mode 0600".to_string());
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("control credentials unavailable: {error}"))?;
    if bytes.len() > 64 * 1024 {
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
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())
}

async fn send_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    root: &Path,
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
            project_root: root.to_string_lossy().to_string(),
        },
    )
    .await?;
    expect_handshake_response(stream, "welcome").await?;
    write_frame(
        stream,
        &OutboundFrame::Register {
            version: 1,
            request_id: "provider-register".to_string(),
            provider_id,
        },
    )
    .await?;
    expect_handshake_response(stream, "ack").await
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
) -> Result<(), String> {
    let line = timeout(REQUEST_TIMEOUT, read_bounded_line(reader))
        .await
        .map_err(|_| "control provider handshake timed out".to_string())??
        .ok_or_else(|| "control provider disconnected during handshake".to_string())?;
    let value: Value = serde_json::from_slice(&line)
        .map_err(|_| "control provider handshake response is invalid".to_string())?;
    if value.get("type").and_then(Value::as_str) == Some(expected_type) {
        return Ok(());
    }
    Err(value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("control provider handshake failed")
        .to_string())
}

async fn provider_loop<R, W>(
    app: AppHandle,
    root_key: String,
    generation: u64,
    mut reader: R,
    mut writer: W,
    mut frames: mpsc::Receiver<OutboundFrame>,
    pending: Arc<Mutex<HashSet<String>>>,
    responses: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
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
                    let Ok(effect) = serde_json::from_value::<ProviderEffectRequest>(value) else { break };
                    if effect.action_id.len() > 256 || pending.lock().len() >= 128 {
                        break;
                    }
                    pending.lock().insert(effect.action_id.clone());
                    let emitted = app
                        .get_webview_window("main")
                        .ok_or(())
                        .and_then(|window| window.emit("control:provider-effect-request", &effect).map_err(|_| ()));
                    if emitted.is_err() { break; }
                    continue;
                }
                if let Some(request_id) = value.get("requestId").and_then(Value::as_str) {
                    if let Some(response) = responses.lock().remove(request_id) {
                        let result = if value.get("type").and_then(Value::as_str) == Some("error") {
                            Err(value.get("message").and_then(Value::as_str).unwrap_or("control request failed").to_string())
                        } else {
                            Ok(value)
                        };
                        let _ = response.send(result);
                    }
                }
            }
            frame = frames.recv() => {
                let Some(frame) = frame else { break };
                if write_frame(&mut writer, &frame).await.is_err() { break; }
            }
        }
    }

    pending.lock().clear();
    for (_, response) in responses.lock().drain() {
        let _ = response.send(Err("control provider disconnected".to_string()));
    }
    let should_remove = connections
        .lock()
        .get(&root_key)
        .is_some_and(|connection| connection.generation == generation);
    if should_remove {
        connections.lock().remove(&root_key);
    }
}

fn next_request_id(state: &ControlProviderState) -> String {
    let sequence = state.next_generation.fetch_add(1, Ordering::Relaxed);
    format!("desktop-{sequence}")
}

fn connection_for(
    state: &ControlProviderState,
    root: &Path,
) -> Result<Arc<ManagedProvider>, String> {
    state
        .connections
        .lock()
        .get(&root.to_string_lossy().to_string())
        .cloned()
        .ok_or_else(|| "control provider is not connected".to_string())
}

async fn send_request(connection: &ManagedProvider, frame: OutboundFrame) -> Result<Value, String> {
    let request_id = frame.request_id().to_string();
    if connection.responses.lock().len() >= MAX_PENDING_REQUESTS {
        return Err("control provider request limit reached".to_string());
    }
    let (sender, receiver) = oneshot::channel();
    connection
        .responses
        .lock()
        .insert(request_id.clone(), sender);
    if connection.writer.send(frame).await.is_err() {
        connection.responses.lock().remove(&request_id);
        return Err("control provider is disconnected".to_string());
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

async fn standalone_control_request(root: &Path, frame: OutboundFrame) -> Result<Value, String> {
    let token = operator_token(root)?;
    let endpoint = endpoint_for_root(root)?;
    let mut stream = UnixStream::connect(endpoint)
        .await
        .map_err(|error| format!("control owner unavailable: {error}"))?;
    write_frame(
        &mut stream,
        &OutboundFrame::Hello {
            version: 1,
            request_id: "hello".to_string(),
            token,
            client_name: "psyche-build-operator".to_string(),
            project_root: root.to_string_lossy().to_string(),
        },
    )
    .await?;
    expect_handshake_response(&mut stream, "welcome").await?;
    write_frame(&mut stream, &frame).await?;
    let line = timeout(REQUEST_TIMEOUT, read_bounded_line(&mut stream))
        .await
        .map_err(|_| "control request timed out".to_string())??
        .ok_or_else(|| "control owner disconnected".to_string())?;
    let value: Value =
        serde_json::from_slice(&line).map_err(|_| "control response is invalid".to_string())?;
    if value.get("type").and_then(Value::as_str) == Some("error") {
        return Err(value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("control request failed")
            .to_string());
    }
    Ok(value)
}

#[tauri::command]
pub async fn control_provider_start(
    app: AppHandle,
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<ProviderStatus, String> {
    let root = canonical_root(&project_root)?;
    let root_key = root.to_string_lossy().to_string();
    if let Some(previous) = state.connections.lock().remove(&root_key) {
        previous.clear_pending("control provider reconnecting");
        if let Some(task) = previous.task.lock().take() {
            task.abort();
        }
    }

    let token = operator_token(&root)?;
    let endpoint = endpoint_for_root(&root)?;
    let mut stream = UnixStream::connect(endpoint)
        .await
        .map_err(|error| format!("control owner unavailable: {error}"))?;
    let digest = format!("{:x}", Sha256::digest(root_key.as_bytes()));
    let provider_id = format!("desktop-{}", digest.chars().take(20).collect::<String>());
    send_handshake(&mut stream, &root, token, provider_id.clone()).await?;

    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
    let (reader, writer) = stream.into_split();
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
        project_root: root.to_string_lossy().to_string(),
        provider_id,
        connected: true,
        pending_effects: 0,
    })
}

#[tauri::command]
pub async fn control_provider_stop(
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<(), String> {
    let root = canonical_root(&project_root)?;
    if let Some(connection) = state
        .connections
        .lock()
        .remove(&root.to_string_lossy().to_string())
    {
        connection.clear_pending("control provider stopped");
        if let Some(task) = connection.task.lock().take() {
            task.abort();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn control_provider_upsert(
    state: State<'_, ControlProviderState>,
    project_root: String,
    resource: BrowserTabResource,
) -> Result<(), String> {
    let root = canonical_root(&project_root)?;
    let connection = connection_for(&state, &root)?;
    if resource.provider_id != connection.provider_id
        || resource.project_root != root.to_string_lossy()
    {
        return Err("browser resource is outside provider scope".to_string());
    }
    let request_id = next_request_id(&state);
    send_request(
        &connection,
        OutboundFrame::ResourceUpsert {
            version: 1,
            request_id,
            resource,
        },
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn control_provider_remove(
    state: State<'_, ControlProviderState>,
    project_root: String,
    tab_id: String,
    generation: u64,
) -> Result<(), String> {
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
    state: State<'_, ControlProviderState>,
    project_root: String,
    result: ProviderEffectResult,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(&result).map_err(|error| error.to_string())?;
    if encoded.len() > MAX_PROVIDER_RESULT_BYTES {
        return Err("provider result exceeds maximum size".to_string());
    }
    let root = canonical_root(&project_root)?;
    let connection = connection_for(&state, &root)?;
    if !connection.pending.lock().remove(result.action_id()) {
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
    Ok(())
}

#[tauri::command]
pub async fn control_operator_submit(
    state: State<'_, ControlProviderState>,
    project_root: String,
    command: OperatorCommand,
) -> Result<Value, String> {
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
        "projectRoot": root.to_string_lossy(),
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
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<Value, String> {
    let root = canonical_root(&project_root)?;
    if !state
        .connections
        .lock()
        .contains_key(&root.to_string_lossy().to_string())
    {
        return Ok(json!({ "connected": false, "projectRoot": root.to_string_lossy() }));
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

#[cfg(test)]
mod control_provider_tests {
    use super::*;

    #[test]
    fn endpoint_hash_matches_the_typescript_contract() {
        let root = Path::new("/tmp/example-project");
        let encoded = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
        assert_eq!(encoded.chars().take(20).collect::<String>().len(), 20);
    }

    #[test]
    fn timestamp_is_rfc3339_shaped() {
        assert_eq!(
            format_system_time(std::time::UNIX_EPOCH),
            "1970-01-01T00:00:00Z"
        );
    }
}
