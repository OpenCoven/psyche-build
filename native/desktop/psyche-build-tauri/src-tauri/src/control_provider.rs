use std::collections::{HashMap, HashSet};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use unicode_normalization::UnicodeNormalization;

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const MAX_CONTROL_FRAME_BYTES: usize = 6 * 1024 * 1024;
const MAX_PENDING_EFFECTS: usize = 256;
const MAX_PENDING_RESPONSES: usize = 128;
const MAX_RAW_SCREENSHOT_BYTES: usize = 4 * 1024 * 1024;
const BASE64_SCREENSHOT_BYTES: usize = ((MAX_RAW_SCREENSHOT_BYTES + 2) / 3) * 4;
const PROVIDER_RESULT_ENVELOPE_BYTES: usize = 128 * 1024;
const MAX_PROVIDER_RESULT_BYTES: usize = BASE64_SCREENSHOT_BYTES + PROVIDER_RESULT_ENVELOPE_BYTES;
const PUBLICATION_PENDING: u64 = 0;
const PUBLICATION_ACTIVE: u64 = 1;
const PUBLICATION_TERMINAL: u64 = 2;

#[derive(Default)]
pub struct ControlProviderState {
    providers: Arc<Mutex<HashMap<String, ProviderConnection>>>,
    start_reservations: Mutex<HashMap<String, u64>>,
    lifecycle_gates: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

struct ProviderConnection {
    provider_id: String,
    connection_nonce: u64,
    registered: bool,
    writer: mpsc::UnboundedSender<Vec<u8>>,
    publication: Arc<AtomicU64>,
    task: JoinHandle<()>,
    pending_effects: Arc<Mutex<HashSet<String>>>,
    pending_responses: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    resources: Arc<Mutex<HashMap<String, BrowserTabResource>>>,
    connected: Arc<AtomicBool>,
    socket_path: PathBuf,
    operator_token: String,
}

impl ProviderConnection {
    fn stop(self) {
        self.pending_effects.lock().clear();
        self.pending_responses.lock().clear();
        self.resources.lock().clear();
        self.connected.store(false, Ordering::Release);
        self.task.abort();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    project_root: String,
    provider_id: String,
    connected: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserViewport {
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BrowserTabResource {
    id: String,
    kind: BrowserResourceKind,
    generation: u64,
    project_root: String,
    worktree_root: String,
    provider_id: String,
    webview_label: String,
    url: String,
    title: String,
    loading: bool,
    viewport: BrowserViewport,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserResourceKind {
    BrowserTab,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseTargetKind {
    Project,
    Pane,
    BrowserTab,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub enum SurfaceCapability {
    #[serde(rename = "pane.create")]
    PaneCreate,
    #[serde(rename = "pane.observe")]
    PaneObserve,
    #[serde(rename = "pane.input")]
    PaneInput,
    #[serde(rename = "pane.interrupt")]
    PaneInterrupt,
    #[serde(rename = "pane.focus")]
    PaneFocus,
    #[serde(rename = "pane.resize")]
    PaneResize,
    #[serde(rename = "pane.close")]
    PaneClose,
    #[serde(rename = "browser.inspect")]
    BrowserInspect,
    #[serde(rename = "browser.screenshot")]
    BrowserScreenshot,
    #[serde(rename = "browser.navigate")]
    BrowserNavigate,
    #[serde(rename = "browser.interact")]
    BrowserInteract,
    #[serde(rename = "browser.history")]
    BrowserHistory,
    #[serde(rename = "browser.close")]
    BrowserClose,
    #[serde(rename = "browser.script")]
    BrowserScript,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderEffectResult {
    Succeeded {
        action_id: String,
        value: Option<Value>,
    },
    Failed {
        action_id: String,
        code: String,
        message: String,
    },
    Unknown {
        action_id: String,
        code: String,
        message: String,
        #[serde(deserialize_with = "deserialize_true")]
        ambiguous: bool,
    },
}

fn deserialize_true<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    let value = bool::deserialize(deserializer)?;
    if value {
        Ok(true)
    } else {
        Err(serde::de::Error::custom("ambiguous must be true"))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LeaseTarget {
    kind: LeaseTargetKind,
    id: String,
    generation: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LeaseGrantSpec {
    target: LeaseTarget,
    capabilities: Vec<SurfaceCapability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LeaseGrantCommand {
    request_id: String,
    actor_id: String,
    task_id: String,
    ttl_ms: u64,
    grants: Vec<LeaseGrantSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LeaseRevokeCommand {
    lease_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ApprovalResolveCommand {
    approval_id: String,
    payload_digest: String,
    decision: ApprovalDecision,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", content = "payload", deny_unknown_fields)]
pub enum OperatorCommand {
    #[serde(rename = "lease.grant")]
    LeaseGrant(LeaseGrantCommand),
    #[serde(rename = "lease.revoke")]
    LeaseRevoke(LeaseRevokeCommand),
    #[serde(rename = "approval.resolve")]
    ApprovalResolve(ApprovalResolveCommand),
}

impl OperatorCommand {
    fn into_wire(self) -> (&'static str, Value) {
        match self {
            Self::LeaseGrant(value) => ("lease.grant", json!(value)),
            Self::LeaseRevoke(value) => ("lease.revoke", json!(value)),
            Self::ApprovalResolve(value) => ("approval.resolve", json!(value)),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorCredentials {
    operator_token: String,
}

fn canonical_key(project_root: &str) -> Result<(String, PathBuf), String> {
    let canonical = std::fs::canonicalize(project_root)
        .map_err(|error| format!("canonicalize project root: {error}"))?;
    Ok((canonical.to_string_lossy().nfc().collect(), canonical))
}

fn socket_path(canonical_root: &Path) -> Result<PathBuf, String> {
    let canonical_nfc = canonical_root.to_string_lossy().nfc().collect::<String>();
    let digest = Sha256::digest(canonical_nfc.as_bytes());
    let lowercase_hex = format!("{digest:x}");
    let socket_id = &lowercase_hex[..20];
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is unavailable".to_string())?;
    Ok(PathBuf::from(home)
        .join(".psyche/runtime/sockets")
        .join(format!("{socket_id}.sock")))
}

fn operator_token(canonical_root: &Path) -> Result<String, String> {
    let path = canonical_root.join(".psyche/runtime/control-credentials.json");
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("read control credential metadata: {error}"))?;
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("control credentials must have mode 0600".to_string());
    }
    let credentials: OperatorCredentials = serde_json::from_slice(
        &std::fs::read(&path).map_err(|error| format!("read control credentials: {error}"))?,
    )
    .map_err(|error| format!("decode control credentials: {error}"))?;
    Ok(credentials.operator_token)
}

fn next_request_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}",
        REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

async fn read_bounded_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut frame = Vec::with_capacity(max_bytes.min(8 * 1024));
    loop {
        let available = reader.fill_buf().await.map_err(|error| error.to_string())?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(frame))
            };
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if frame.len().saturating_add(newline) > max_bytes {
                return Err("frame_too_large".to_string());
            }
            frame.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return Ok(Some(frame));
        }
        if frame.len().saturating_add(available.len()) > max_bytes {
            return Err("frame_too_large".to_string());
        }
        let consumed = available.len();
        frame.extend_from_slice(available);
        reader.consume(consumed);
    }
}

struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
}

impl Write for BoundedWriter {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(input.len()) > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::FileTooLarge,
                "result_too_large",
            ));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_bounded<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>, String> {
    let mut writer = BoundedWriter {
        bytes: Vec::with_capacity(limit.min(8 * 1024)),
        limit,
    };
    serde_json::to_writer(&mut writer, value).map_err(|error| {
        if error.io_error_kind() == Some(std::io::ErrorKind::FileTooLarge) {
            "result_too_large".to_string()
        } else {
            error.to_string()
        }
    })?;
    Ok(writer.bytes)
}

fn reserve_pending_response(
    pending: &mut HashMap<String, oneshot::Sender<Value>>,
    request_id: String,
    sender: oneshot::Sender<Value>,
    limit: usize,
) -> Result<(), String> {
    if pending.len() >= limit {
        return Err("provider_busy".to_string());
    }
    pending.insert(request_id, sender);
    Ok(())
}

fn cancel_pending_response(
    pending: &mut HashMap<String, oneshot::Sender<Value>>,
    request_id: &str,
) {
    pending.remove(request_id);
}

fn remove_if_nonce<V, F>(entries: &mut HashMap<String, V>, key: &str, nonce: u64, get_nonce: F)
where
    F: Fn(&V) -> u64,
{
    if entries
        .get(key)
        .is_some_and(|entry| get_nonce(entry) == nonce)
    {
        entries.remove(key);
    }
}

fn apply_if_connection_nonce<V, T, G, A>(
    entries: &mut HashMap<String, V>,
    key: &str,
    nonce: u64,
    get_nonce: G,
    apply: A,
) -> Result<T, String>
where
    G: Fn(&V) -> u64,
    A: FnOnce(&mut V) -> T,
{
    let entry = entries
        .get_mut(key)
        .filter(|entry| get_nonce(entry) == nonce)
        .ok_or_else(|| "control provider connection was replaced".to_string())?;
    Ok(apply(entry))
}

fn reserve_start(reservations: &mut HashMap<String, u64>, key: &str, nonce: u64) {
    reservations.insert(key.to_string(), nonce);
}

fn lifecycle_gate(
    gates: &Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    key: &str,
) -> Arc<AsyncMutex<()>> {
    gates
        .lock()
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

fn ensure_current_reservation(
    reservations: &Mutex<HashMap<String, u64>>,
    key: &str,
    nonce: u64,
) -> Result<(), String> {
    if reservations.lock().get(key) == Some(&nonce) {
        Ok(())
    } else {
        Err("control provider start was superseded".to_string())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum PublishConnectionError {
    Superseded,
    Unavailable,
}

impl PublishConnectionError {
    fn into_message(self) -> String {
        match self {
            Self::Superseded => "control provider start was superseded".to_string(),
            Self::Unavailable => {
                "control provider connection closed before publication".to_string()
            }
        }
    }
}

fn publish_connection<V, F>(
    entries: &mut HashMap<String, V>,
    key: &str,
    value: V,
    publication: F,
) -> Result<Option<V>, (PublishConnectionError, V)>
where
    F: FnOnce(&V) -> &AtomicU64,
{
    if publication(&value)
        .compare_exchange(
            PUBLICATION_PENDING,
            PUBLICATION_ACTIVE,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_err()
    {
        return Err((PublishConnectionError::Unavailable, value));
    }
    Ok(entries.insert(key.to_string(), value))
}

fn publish_reserved_connection<V, F>(
    reservations: &HashMap<String, u64>,
    entries: &mut HashMap<String, V>,
    key: &str,
    nonce: u64,
    connection: &mut Option<V>,
    publication: F,
) -> Result<Option<V>, PublishConnectionError>
where
    F: FnOnce(&V) -> &AtomicU64,
{
    if reservations.get(key) != Some(&nonce) {
        return Err(PublishConnectionError::Superseded);
    }
    let Some(value) = connection.take() else {
        return Err(PublishConnectionError::Unavailable);
    };
    match publish_connection(entries, key, value, publication) {
        Ok(previous) => Ok(previous),
        Err((error, value)) => {
            *connection = Some(value);
            Err(error)
        }
    }
}

fn response_error(response: &Value, fallback: &str) -> String {
    let code = response
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("internal");
    let message = response
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(fallback);
    format!("{code}: {message}")
}

fn queue_json(
    writer: &mpsc::UnboundedSender<Vec<u8>>,
    value: &Value,
    limit: usize,
) -> Result<(), String> {
    writer
        .send(encode_bounded(value, limit)?)
        .map_err(|_| "control provider writer is closed".to_string())
}

async fn await_provider_response(
    state: &ControlProviderState,
    project_root: &str,
    request_id: &str,
    receiver: oneshot::Receiver<Value>,
    closed_message: &str,
    timeout_message: &str,
) -> Result<Value, String> {
    match timeout(Duration::from_secs(15), receiver).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(_)) => Err(closed_message.to_string()),
        Err(_) => {
            if let Ok((_, connection)) = provider(state, project_root) {
                cancel_pending_response(&mut connection.pending_responses.lock(), request_id);
            }
            Err(timeout_message.to_string())
        }
    }
}

fn provider_busy_result(frame: &Value) -> Option<Value> {
    let request_id = frame.get("requestId")?.as_str()?;
    let action_id = frame.get("actionId").and_then(Value::as_str).unwrap_or("");
    Some(json!({
        "version": 1, "type": "provider.effect.result", "requestId": request_id,
        "result": { "actionId": action_id, "status": "failed", "code": "provider_busy",
            "message": "desktop browser provider is busy" }
    }))
}

fn apply_remove_response(
    resources: &mut HashMap<String, BrowserTabResource>,
    tab_id: &str,
    generation: u64,
    response: &Value,
) -> Result<(), String> {
    if response.get("type").and_then(Value::as_str) != Some("ack") {
        return Err(response_error(response, "provider resource removal failed"));
    }
    if resources
        .get(tab_id)
        .is_some_and(|resource| resource.generation == generation)
    {
        resources.remove(tab_id);
    }
    Ok(())
}

fn decode_canonical_resource(
    response: &Value,
    expected_id: &str,
) -> Result<BrowserTabResource, String> {
    if response.get("type").and_then(Value::as_str) != Some("provider.resource.result") {
        return Err(response_error(
            response,
            "provider resource registration failed",
        ));
    }
    let canonical: BrowserTabResource = serde_json::from_value(response["resource"].clone())
        .map_err(|error| format!("decode canonical browser resource: {error}"))?;
    if canonical.id != expected_id {
        return Err("canonical browser resource ID mismatch".to_string());
    }
    Ok(canonical)
}

fn provider<'a>(
    state: &'a ControlProviderState,
    project_root: &str,
) -> Result<
    (
        String,
        parking_lot::MappedMutexGuard<'a, ProviderConnection>,
    ),
    String,
> {
    let (key, _) = canonical_key(project_root)?;
    let guard = Mutex::lock(&state.providers);
    if !guard.contains_key(&key) {
        return Err("control provider is not connected".to_string());
    }
    let connection = parking_lot::MutexGuard::map(guard, |providers| {
        providers.get_mut(&key).expect("provider presence checked")
    });
    if !connection.connected.load(Ordering::Acquire) {
        return Err("control provider connection is closed".to_string());
    }
    Ok((key, connection))
}

#[cfg(unix)]
async fn connect_provider(
    app: AppHandle,
    providers: Arc<Mutex<HashMap<String, ProviderConnection>>>,
    provider_key: String,
    canonical_root: PathBuf,
    token: String,
    provider_id: String,
    connection_nonce: u64,
) -> Result<ProviderConnection, String> {
    let endpoint = socket_path(&canonical_root)?;
    let stream = tokio::net::UnixStream::connect(&endpoint)
        .await
        .map_err(|error| format!("connect control socket: {error}"))?;
    let (reader, mut socket_writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let (writer, mut outbound) = mpsc::unbounded_channel::<Vec<u8>>();
    let publication = Arc::new(AtomicU64::new(PUBLICATION_PENDING));
    let pending_effects = Arc::new(Mutex::new(HashSet::new()));
    let pending_responses = Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<Value>>::new()));
    let resources = Arc::new(Mutex::new(HashMap::new()));
    let connected = Arc::new(AtomicBool::new(true));

    let register_request_id = next_request_id("provider-register");
    for frame in [
        json!({
            "version": 1, "type": "hello", "requestId": "hello",
            "token": token, "clientName": provider_id,
            "projectRoot": canonical_root.to_string_lossy(),
        }),
        json!({
            "version": 1, "type": "provider.register",
            "requestId": register_request_id,
            "providerId": provider_id,
        }),
    ] {
        let mut encoded = encode_bounded(&frame, MAX_CONTROL_FRAME_BYTES)?;
        encoded.push(b'\n');
        socket_writer
            .write_all(&encoded)
            .await
            .map_err(|error| format!("write control provider handshake: {error}"))?;
    }
    timeout(Duration::from_secs(15), async {
        let welcome = read_bounded_frame(&mut reader, MAX_CONTROL_FRAME_BYTES)
            .await?
            .ok_or_else(|| "control provider connection closed during hello".to_string())?;
        let welcome: Value = serde_json::from_slice(&welcome).map_err(|error| error.to_string())?;
        if welcome.get("type").and_then(Value::as_str) != Some("welcome") {
            return Err("control provider hello was rejected".to_string());
        }
        let registered = read_bounded_frame(&mut reader, MAX_CONTROL_FRAME_BYTES)
            .await?
            .ok_or_else(|| "control provider connection closed during registration".to_string())?;
        let registered: Value =
            serde_json::from_slice(&registered).map_err(|error| error.to_string())?;
        if registered.get("type").and_then(Value::as_str) != Some("ack")
            || registered.get("requestId").and_then(Value::as_str)
                != Some(register_request_id.as_str())
        {
            return Err("control provider registration was rejected".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|_| "control provider handshake timed out".to_string())??;

    let effects = pending_effects.clone();
    let responses = pending_responses.clone();
    let live = connected.clone();
    let task_publication = publication.clone();
    let task_connection_nonce = connection_nonce;
    let effect_writer = writer.clone();
    let task = tokio::spawn(async move {
        let writer_task = tokio::spawn(async move {
            while let Some(frame) = outbound.recv().await {
                let mut bytes = frame;
                bytes.push(b'\n');
                if socket_writer.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        loop {
            let Ok(Some(encoded)) = read_bounded_frame(&mut reader, MAX_CONTROL_FRAME_BYTES).await
            else {
                break;
            };
            let Ok(frame) = serde_json::from_slice::<Value>(&encoded) else {
                continue;
            };
            if frame.get("type").and_then(Value::as_str) == Some("provider.effect.request") {
                let request_id = frame
                    .get("requestId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(request_id) = &request_id {
                    let mut pending = effects.lock();
                    if pending.len() >= MAX_PENDING_EFFECTS {
                        if let Some(result) = provider_busy_result(&frame) {
                            let _ = queue_json(&effect_writer, &result, MAX_PROVIDER_RESULT_BYTES);
                        }
                        continue;
                    }
                    pending.insert(request_id.clone());
                }
                if let Some(main) = app.get_webview_window("main") {
                    let mut desktop_frame = frame.clone();
                    if let Some(object) = desktop_frame.as_object_mut() {
                        object.insert(
                            "projectRoot".to_string(),
                            Value::String(provider_key.clone()),
                        );
                    }
                    if main
                        .emit("control:provider-effect-request", &desktop_frame)
                        .is_err()
                    {
                        if let Some(request_id) = &request_id {
                            effects.lock().remove(request_id);
                            let action_id =
                                frame.get("actionId").and_then(Value::as_str).unwrap_or("");
                            let _ = queue_json(
                                &effect_writer,
                                &json!({
                                    "version": 1, "type": "provider.effect.result",
                                    "requestId": request_id,
                                    "result": { "actionId": action_id, "status": "failed",
                                      "code": "webview_emit_failed", "message": "browser webview event delivery failed" }
                                }),
                                MAX_PROVIDER_RESULT_BYTES,
                            );
                        }
                    }
                }
                continue;
            }
            if frame.get("type").and_then(Value::as_str) == Some("provider.effect.cancel") {
                if let Some(request_id) = frame.get("requestId").and_then(Value::as_str) {
                    effects.lock().remove(request_id);
                }
                continue;
            }
            if let Some(request_id) = frame.get("requestId").and_then(Value::as_str) {
                if let Some(sender) = responses.lock().remove(request_id) {
                    let _ = sender.send(frame);
                }
            }
        }
        task_publication.store(PUBLICATION_TERMINAL, Ordering::Release);
        effects.lock().clear();
        responses.lock().clear();
        live.store(false, Ordering::Release);
        writer_task.abort();
        remove_if_nonce(
            &mut providers.lock(),
            &provider_key,
            task_connection_nonce,
            |connection| connection.connection_nonce,
        );
    });

    Ok(ProviderConnection {
        provider_id,
        connection_nonce,
        registered: true,
        writer,
        publication,
        task,
        pending_effects,
        pending_responses,
        resources,
        connected,
        socket_path: endpoint,
        operator_token: token,
    })
}

#[tauri::command]
pub async fn control_provider_start(
    app: AppHandle,
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<ProviderStatus, String> {
    let (key, canonical_root) = canonical_key(&project_root)?;
    let connection_nonce = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    reserve_start(&mut state.start_reservations.lock(), &key, connection_nonce);
    let lifecycle_gate = lifecycle_gate(&state.lifecycle_gates, &key);
    let _lifecycle_guard = lifecycle_gate.lock_owned().await;
    ensure_current_reservation(&state.start_reservations, &key, connection_nonce)?;
    let token = operator_token(&canonical_root)?;
    let provider_id = format!(
        "desktop-{}",
        &format!("{:x}", Sha256::digest(key.as_bytes()))[..20]
    );
    #[cfg(unix)]
    let connection = connect_provider(
        app,
        state.providers.clone(),
        key.clone(),
        canonical_root,
        token,
        provider_id.clone(),
        connection_nonce,
    )
    .await?;
    if let Err(error) =
        ensure_current_reservation(&state.start_reservations, &key, connection_nonce)
    {
        connection.stop();
        return Err(error);
    }
    #[cfg(not(unix))]
    let connection: ProviderConnection = {
        let _ = (app, canonical_root, token);
        return Err("desktop control provider requires a Unix socket".to_string());
    };
    let mut connection = Some(connection);
    let previous = {
        let reservations = state.start_reservations.lock();
        let mut providers = state.providers.lock();
        publish_reserved_connection(
            &reservations,
            &mut providers,
            &key,
            connection_nonce,
            &mut connection,
            |connection| connection.publication.as_ref(),
        )
    };
    let previous = match previous {
        Ok(previous) => previous,
        Err(error) => {
            if let Some(connection) = connection.take() {
                connection.stop();
            }
            return Err(error.into_message());
        }
    };
    if let Some(previous) = previous {
        previous.pending_effects.lock().clear();
        previous.stop();
    }
    Ok(ProviderStatus {
        project_root: key,
        provider_id,
        connected: true,
    })
}

#[tauri::command]
pub async fn control_provider_stop(
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<(), String> {
    let (key, _) = canonical_key(&project_root)?;
    let stop_nonce = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    reserve_start(&mut state.start_reservations.lock(), &key, stop_nonce);
    let lifecycle_gate = lifecycle_gate(&state.lifecycle_gates, &key);
    let _lifecycle_guard = lifecycle_gate.lock_owned().await;
    if let Some(connection) = state.providers.lock().remove(&key) {
        connection.pending_effects.lock().clear();
        connection.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn control_provider_upsert(
    state: State<'_, ControlProviderState>,
    project_root: String,
    resource: BrowserTabResource,
) -> Result<BrowserTabResource, String> {
    let request_id = next_request_id("resource-upsert");
    let resource_id = resource.id.clone();
    let (provider_key, connection_nonce, receiver) = {
        let (provider_key, connection) = provider(&state, &project_root)?;
        if !connection.registered || resource.provider_id != connection.provider_id {
            return Err(
                "browser resource provider does not match the registered provider".to_string(),
            );
        }
        let (sender, receiver) = oneshot::channel();
        reserve_pending_response(
            &mut connection.pending_responses.lock(),
            request_id.clone(),
            sender,
            MAX_PENDING_RESPONSES,
        )?;
        if let Err(error) = queue_json(
            &connection.writer,
            &json!({
                "version": 1, "type": "provider.resource.upsert",
                "requestId": request_id, "resource": resource,
            }),
            MAX_CONTROL_FRAME_BYTES,
        ) {
            cancel_pending_response(&mut connection.pending_responses.lock(), &request_id);
            return Err(error);
        }
        (provider_key, connection.connection_nonce, receiver)
    };
    let response = await_provider_response(
        &state,
        &project_root,
        &request_id,
        receiver,
        "provider connection closed during resource registration",
        "provider resource registration timed out",
    )
    .await?;
    apply_if_connection_nonce(
        &mut state.providers.lock(),
        &provider_key,
        connection_nonce,
        |connection| connection.connection_nonce,
        |connection| {
            if !connection.connected.load(Ordering::Acquire) {
                return Err("control provider connection is closed".to_string());
            }
            let canonical = decode_canonical_resource(&response, &resource_id)?;
            connection
                .resources
                .lock()
                .insert(canonical.id.clone(), canonical.clone());
            Ok(canonical)
        },
    )?
}

#[tauri::command]
pub async fn control_provider_remove(
    state: State<'_, ControlProviderState>,
    project_root: String,
    tab_id: String,
) -> Result<(), String> {
    let request_id = next_request_id("resource-remove");
    let (provider_key, connection_nonce, generation, receiver) = {
        let (provider_key, connection) = provider(&state, &project_root)?;
        let generation = connection
            .resources
            .lock()
            .get(&tab_id)
            .map(|resource| resource.generation)
            .ok_or_else(|| "browser resource is not registered".to_string())?;
        let (sender, receiver) = oneshot::channel();
        reserve_pending_response(
            &mut connection.pending_responses.lock(),
            request_id.clone(),
            sender,
            MAX_PENDING_RESPONSES,
        )?;
        if let Err(error) = queue_json(
            &connection.writer,
            &json!({
                "version": 1, "type": "provider.resource.remove",
                "requestId": request_id, "id": tab_id,
                "generation": generation,
            }),
            MAX_CONTROL_FRAME_BYTES,
        ) {
            cancel_pending_response(&mut connection.pending_responses.lock(), &request_id);
            return Err(error);
        }
        (
            provider_key,
            connection.connection_nonce,
            generation,
            receiver,
        )
    };
    let response = await_provider_response(
        &state,
        &project_root,
        &request_id,
        receiver,
        "provider connection closed during resource removal",
        "provider resource removal timed out",
    )
    .await?;
    apply_if_connection_nonce(
        &mut state.providers.lock(),
        &provider_key,
        connection_nonce,
        |connection| connection.connection_nonce,
        |connection| {
            if !connection.connected.load(Ordering::Acquire) {
                return Err("control provider connection is closed".to_string());
            }
            apply_remove_response(
                &mut connection.resources.lock(),
                &tab_id,
                generation,
                &response,
            )
        },
    )?
}

#[tauri::command]
pub fn control_provider_complete(
    state: State<'_, ControlProviderState>,
    project_root: String,
    request_id: String,
    result: ProviderEffectResult,
) -> Result<(), String> {
    let (_, connection) = provider(&state, &project_root)?;
    let frame = json!({
        "version": 1, "type": "provider.effect.result",
        "requestId": request_id, "result": result,
    });
    let encoded = encode_bounded(&frame, MAX_PROVIDER_RESULT_BYTES)?;
    if !connection.pending_effects.lock().remove(&request_id) {
        return Err("unknown or stale provider effect request".to_string());
    }
    connection
        .writer
        .send(encoded)
        .map_err(|_| "control provider writer is closed".to_string())
}

#[cfg(unix)]
async fn operator_request(
    state: &ControlProviderState,
    project_root: &str,
    request_id: String,
    frame: Value,
) -> Result<Value, String> {
    let (endpoint, token, canonical_root) = {
        let (_, connection) = provider(state, project_root)?;
        let (canonical_root, _) = canonical_key(project_root)?;
        (
            connection.socket_path.clone(),
            connection.operator_token.clone(),
            canonical_root,
        )
    };
    timeout(Duration::from_secs(15), async move {
        let stream = tokio::net::UnixStream::connect(endpoint)
            .await
            .map_err(|error| format!("connect operator control socket: {error}"))?;
        let (reader, mut writer) = stream.into_split();
        for outbound in [
            json!({ "version": 1, "type": "hello", "requestId": "hello",
                "token": token, "clientName": "psyche-desktop-operator",
                "projectRoot": canonical_root }),
            frame,
        ] {
            let mut bytes = encode_bounded(&outbound, MAX_CONTROL_FRAME_BYTES)
                .map_err(|error| format!("encode operator control frame: {error}"))?;
            bytes.push(b'\n');
            writer
                .write_all(&bytes)
                .await
                .map_err(|error| format!("write operator control frame: {error}"))?;
        }
        let mut reader = BufReader::new(reader);
        while let Some(line) = read_bounded_frame(&mut reader, MAX_CONTROL_FRAME_BYTES).await? {
            let response: Value = serde_json::from_slice(&line)
                .map_err(|error| format!("decode operator control frame: {error}"))?;
            if response.get("requestId").and_then(Value::as_str) == Some(request_id.as_str()) {
                return Ok(response);
            }
        }
        Err("operator control connection closed".to_string())
    })
    .await
    .map_err(|_| "control request timed out".to_string())?
}

#[tauri::command]
pub async fn control_operator_submit(
    state: State<'_, ControlProviderState>,
    project_root: String,
    command: OperatorCommand,
) -> Result<Value, String> {
    let (kind, payload) = command.into_wire();
    let request_id = next_request_id("operator-command");
    let command_id = next_request_id("operator-action");
    operator_request(&state, &project_root, request_id.clone(), json!({
        "version": 1, "type": "command.submit", "requestId": request_id,
        "command": { "id": command_id, "idempotencyKey": next_request_id("operator-idem"),
          "kind": kind, "projectRoot": project_root, "createdAt": timestamp(), "payload": payload }
    })).await
}

#[tauri::command]
pub async fn control_state(
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<Value, String> {
    let request_id = next_request_id("control-state");
    operator_request(
        &state,
        &project_root,
        request_id.clone(),
        json!({
            "version": 1, "type": "state.get", "requestId": request_id,
        }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn browser_resource(generation: u64) -> BrowserTabResource {
        BrowserTabResource {
            id: "browser:tab-1".into(),
            kind: BrowserResourceKind::BrowserTab,
            generation,
            project_root: "/project".into(),
            worktree_root: "/project".into(),
            provider_id: "desktop-provider".into(),
            webview_label: "main".into(),
            url: "https://example.test".into(),
            title: "Example".into(),
            loading: false,
            viewport: BrowserViewport {
                width: 800,
                height: 600,
            },
        }
    }

    async fn run_test_start(
        gate: Arc<AsyncMutex<()>>,
        reservations: Arc<Mutex<HashMap<String, u64>>>,
        remote: Arc<Mutex<Option<(&'static str, u64)>>>,
        native: Arc<Mutex<Option<(&'static str, u64)>>>,
        provider_id: &'static str,
        nonce: u64,
        entered: Option<oneshot::Sender<()>>,
        release: Option<oneshot::Receiver<()>>,
    ) -> Result<(), String> {
        let _guard = gate.lock().await;
        ensure_current_reservation(&reservations, "project", nonce)?;
        if let Some(entered) = entered {
            let _ = entered.send(());
        }
        if let Some(release) = release {
            let _ = release.await;
        }
        *remote.lock() = Some((provider_id, nonce));
        if let Err(error) = ensure_current_reservation(&reservations, "project", nonce) {
            if remote.lock().as_ref() == Some(&(provider_id, nonce)) {
                *remote.lock() = None;
            }
            return Err(error);
        }
        *native.lock() = Some((provider_id, nonce));
        Ok(())
    }

    async fn run_test_stop(
        gate: Arc<AsyncMutex<()>>,
        remote: Arc<Mutex<Option<(&'static str, u64)>>>,
        native: Arc<Mutex<Option<(&'static str, u64)>>>,
    ) {
        let _guard = gate.lock().await;
        *remote.lock() = None;
        *native.lock() = None;
    }

    #[test]
    fn socket_hash_is_lowercase_and_twenty_hex_characters() {
        let digest = format!("{:x}", Sha256::digest(b"/tmp/project"));
        let id = &digest[..20];
        assert_eq!(id.len(), 20);
        assert!(id
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
    }

    #[test]
    fn decomposed_unicode_fixture_matches_typescript_nfc_hash() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../protocol-fixtures/control-v1/unicode-project-root.json"
        ))
        .expect("unicode fixture");
        let normalized = fixture["decomposed"]
            .as_str()
            .expect("decomposed")
            .nfc()
            .collect::<String>();
        let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
        assert_eq!(
            &digest[..20],
            fixture["sha256First20"].as_str().expect("hash")
        );
    }

    #[test]
    fn provider_results_reject_impossible_status_shapes() {
        assert!(serde_json::from_value::<ProviderEffectResult>(json!({
            "status": "unknown", "actionId": "a", "code": "x", "message": "x", "ambiguous": false
        }))
        .is_err());
        assert!(serde_json::from_value::<ProviderEffectResult>(json!({
            "status": "succeeded", "actionId": "a", "code": "impossible"
        }))
        .is_err());
    }

    #[test]
    fn operator_command_is_bounded_to_three_variants() {
        let revoke: OperatorCommand = serde_json::from_value(json!({
            "kind": "lease.revoke", "payload": { "leaseId": "lease-1" }
        }))
        .expect("typed revoke");
        assert_eq!(revoke.into_wire().0, "lease.revoke");
        assert!(serde_json::from_value::<OperatorCommand>(json!({
            "kind": "browser.action", "payload": {}
        }))
        .is_err());
    }

    #[tokio::test]
    async fn bounded_reader_rejects_terminated_and_unterminated_over_limit_frames() {
        for bytes in [vec![b'x'; 33], [vec![b'x'; 33], vec![b'\n']].concat()] {
            let mut reader = BufReader::new(Cursor::new(bytes));
            assert_eq!(
                read_bounded_frame(&mut reader, 32).await.unwrap_err(),
                "frame_too_large"
            );
        }
        let mut reader = BufReader::new(Cursor::new(b"ok\nnext\n".to_vec()));
        assert_eq!(
            read_bounded_frame(&mut reader, 32).await.unwrap(),
            Some(b"ok".to_vec())
        );
        assert_eq!(
            read_bounded_frame(&mut reader, 32).await.unwrap(),
            Some(b"next".to_vec())
        );
    }

    #[test]
    fn bounded_result_serializer_rejects_over_limit_without_growing_past_cap() {
        let result = ProviderEffectResult::Succeeded {
            action_id: "a".into(),
            value: Some(Value::String("x".repeat(128))),
        };
        assert_eq!(encode_bounded(&result, 32).unwrap_err(), "result_too_large");
        assert!(encode_bounded(&result, 512).unwrap().len() <= 512);
    }

    #[test]
    fn old_connection_nonce_cannot_remove_replacement() {
        let mut entries = HashMap::from([("project".to_string(), 2_u64)]);
        remove_if_nonce(&mut entries, "project", 1, |nonce| *nonce);
        assert_eq!(entries.get("project"), Some(&2));
        remove_if_nonce(&mut entries, "project", 2, |nonce| *nonce);
        assert!(!entries.contains_key("project"));
    }

    #[test]
    fn pending_response_cap_and_failure_cleanup_are_bounded() {
        let mut pending = HashMap::new();
        let (first, _) = oneshot::channel();
        reserve_pending_response(&mut pending, "one".into(), first, 1).unwrap();
        let (second, _) = oneshot::channel();
        assert_eq!(
            reserve_pending_response(&mut pending, "two".into(), second, 1).unwrap_err(),
            "provider_busy"
        );
        cancel_pending_response(&mut pending, "one");
        assert!(pending.is_empty());
    }

    #[test]
    fn canonical_upsert_result_returns_server_generation() {
        let mut canonical = browser_resource(1);
        canonical.generation = 9;
        let decoded = decode_canonical_resource(
            &json!({"type":"provider.resource.result", "resource":canonical}),
            "browser:tab-1",
        )
        .unwrap();
        assert_eq!(decoded.generation, 9);
    }

    #[test]
    fn saturated_effect_gets_correlated_provider_busy_result() {
        let result = provider_busy_result(&json!({
            "type": "provider.effect.request", "requestId": "request-1", "actionId": "action-1"
        }))
        .expect("busy result");
        assert_eq!(result["requestId"], "request-1");
        assert_eq!(result["result"]["actionId"], "action-1");
        assert_eq!(result["result"]["code"], "provider_busy");
    }

    #[test]
    fn resource_remove_keeps_cache_on_error_and_evicts_only_matching_ack() {
        let resource = browser_resource(7);
        let mut resources = HashMap::from([(resource.id.clone(), resource)]);
        assert_eq!(
            apply_remove_response(
                &mut resources,
                "browser:tab-1",
                7,
                &json!({"type":"error", "code":"stale_generation", "message":"stale"}),
            )
            .unwrap_err(),
            "stale_generation: stale"
        );
        assert!(resources.contains_key("browser:tab-1"));
        apply_remove_response(&mut resources, "browser:tab-1", 7, &json!({"type":"ack"})).unwrap();
        assert!(!resources.contains_key("browser:tab-1"));
    }

    #[test]
    fn operator_payload_internals_reject_unknown_values_and_fields() {
        assert!(serde_json::from_value::<OperatorCommand>(json!({
          "kind":"approval.resolve", "payload":{"approvalId":"a","payloadDigest":"d","decision":"maybe"}
        })).is_err());
        assert!(serde_json::from_value::<OperatorCommand>(json!({
          "kind":"lease.grant", "payload":{"requestId":"r","actorId":"a","taskId":"t","ttlMs":1,
            "grants":[{"target":{"kind":"future","id":"x"},"capabilities":["browser.inspect"]}]}
        }))
        .is_err());
        assert!(serde_json::from_value::<OperatorCommand>(json!({
          "kind":"approval.resolve", "payload":{"approvalId":"a","payloadDigest":"d",
            "decision":"approve", "unexpected":true}
        }))
        .is_err());
        assert!(serde_json::from_value::<OperatorCommand>(json!({
          "kind":"lease.grant", "payload":{"requestId":"r","actorId":"a","taskId":"t","ttlMs":1,
            "grants":[{"target":{"kind":"browser_tab","id":"x"},"capabilities":["future.action"]}]}
        }))
        .is_err());
    }

    #[test]
    fn rust_capabilities_round_trip_the_shared_canonical_contract() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../protocol-fixtures/control-v1/provider-contract.json"
        ))
        .unwrap();
        for capability in fixture["surfaceCapabilities"].as_array().unwrap() {
            let decoded: SurfaceCapability = serde_json::from_value(capability.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), *capability);
        }
        assert!(serde_json::from_value::<SurfaceCapability>(json!("browser.action")).is_err());
        assert!(serde_json::from_value::<SurfaceCapability>(json!("future.action")).is_err());
    }

    #[test]
    fn stale_response_nonce_cannot_mutate_replacement_cache_for_upsert_or_remove() {
        #[derive(Debug)]
        struct Entry {
            nonce: u64,
            resources: HashMap<String, BrowserTabResource>,
        }
        let replacement = browser_resource(11);
        let mut entries = HashMap::from([(
            "project".to_string(),
            Entry {
                nonce: 2,
                resources: HashMap::from([(replacement.id.clone(), replacement.clone())]),
            },
        )]);
        let upsert = apply_if_connection_nonce(
            &mut entries,
            "project",
            1,
            |entry| entry.nonce,
            |entry| {
                entry
                    .resources
                    .insert("browser:old".into(), browser_resource(7));
            },
        );
        assert_eq!(
            upsert.unwrap_err(),
            "control provider connection was replaced"
        );
        let remove = apply_if_connection_nonce(
            &mut entries,
            "project",
            1,
            |entry| entry.nonce,
            |entry| {
                entry.resources.remove("browser:tab-1");
            },
        );
        assert_eq!(
            remove.unwrap_err(),
            "control provider connection was replaced"
        );
        assert_eq!(entries["project"].resources["browser:tab-1"].generation, 11);
        assert!(!entries["project"].resources.contains_key("browser:old"));
    }

    #[test]
    fn late_start_cannot_replace_newer_installed_registration() {
        #[derive(Debug)]
        struct InstalledProvider {
            provider_id: &'static str,
            nonce: u64,
            publication: Arc<AtomicU64>,
        }
        let mut reservations = HashMap::new();
        let mut installed = HashMap::new();
        let broker_provider_id = "desktop-project";
        reserve_start(&mut reservations, "project", 1);
        reserve_start(&mut reservations, "project", 2);
        let mut current = Some(InstalledProvider {
            provider_id: broker_provider_id,
            nonce: 2,
            publication: Arc::new(AtomicU64::new(PUBLICATION_PENDING)),
        });
        publish_reserved_connection(
            &reservations,
            &mut installed,
            "project",
            2,
            &mut current,
            |connection| connection.publication.as_ref(),
        )
        .unwrap();
        let mut late = Some(InstalledProvider {
            provider_id: broker_provider_id,
            nonce: 1,
            publication: Arc::new(AtomicU64::new(PUBLICATION_PENDING)),
        });
        assert_eq!(
            publish_reserved_connection(
                &reservations,
                &mut installed,
                "project",
                1,
                &mut late,
                |connection| connection.publication.as_ref(),
            )
            .unwrap_err(),
            PublishConnectionError::Superseded,
        );
        assert_eq!(late.expect("superseded start retains ownership").nonce, 1);
        assert_eq!(installed["project"].nonce, 2);
        assert_eq!(installed["project"].provider_id, broker_provider_id);
    }

    #[test]
    fn provider_result_wire_cap_matches_fixture_and_admits_max_screenshot() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../protocol-fixtures/control-v1/provider-contract.json"
        ))
        .unwrap();
        assert_eq!(
            MAX_CONTROL_FRAME_BYTES as u64,
            fixture["maxControlFrameBytes"].as_u64().unwrap()
        );
        assert_eq!(
            MAX_PROVIDER_RESULT_BYTES as u64,
            fixture["maxProviderResultWireBytes"].as_u64().unwrap()
        );
        let screenshot = "A".repeat(fixture["base64ScreenshotBytes"].as_u64().unwrap() as usize);
        let frame = json!({"version":1,"type":"provider.effect.result","requestId":"request",
            "result":{"actionId":"action","status":"succeeded","value":{"pngBase64":screenshot}}});
        assert!(encode_bounded(&frame, MAX_PROVIDER_RESULT_BYTES).is_ok());
        let over = json!({"value":"x".repeat(MAX_PROVIDER_RESULT_BYTES)});
        assert_eq!(
            encode_bounded(&over, MAX_PROVIDER_RESULT_BYTES).unwrap_err(),
            "result_too_large"
        );
    }

    #[tokio::test]
    async fn serialized_starts_leave_native_and_remote_on_newest_provider() {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let reservations = Arc::new(Mutex::new(HashMap::new()));
        let remote = Arc::new(Mutex::new(None::<(&'static str, u64)>));
        let native = Arc::new(Mutex::new(None::<(&'static str, u64)>));
        let (a_entered_tx, a_entered_rx) = oneshot::channel();
        let (release_a_tx, release_a_rx) = oneshot::channel();
        reserve_start(&mut reservations.lock(), "project", 1);
        let a = tokio::spawn(run_test_start(
            gate.clone(),
            reservations.clone(),
            remote.clone(),
            native.clone(),
            "provider-a",
            1,
            Some(a_entered_tx),
            Some(release_a_rx),
        ));
        a_entered_rx.await.unwrap();
        reserve_start(&mut reservations.lock(), "project", 2);
        let b = tokio::spawn(run_test_start(
            gate.clone(),
            reservations.clone(),
            remote.clone(),
            native.clone(),
            "provider-b",
            2,
            None,
            None,
        ));
        release_a_tx.send(()).unwrap();
        assert_eq!(
            a.await.unwrap().unwrap_err(),
            "control provider start was superseded"
        );
        b.await.unwrap().unwrap();
        assert_eq!(*remote.lock(), Some(("provider-b", 2)));
        assert_eq!(*native.lock(), Some(("provider-b", 2)));
    }

    #[tokio::test]
    async fn stop_waits_for_inflight_start_and_is_terminal_for_it() {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let reservations = Arc::new(Mutex::new(HashMap::new()));
        let remote = Arc::new(Mutex::new(None::<(&'static str, u64)>));
        let native = Arc::new(Mutex::new(None::<(&'static str, u64)>));
        let (a_entered_tx, a_entered_rx) = oneshot::channel();
        let (release_a_tx, release_a_rx) = oneshot::channel();
        reserve_start(&mut reservations.lock(), "project", 1);
        let a = tokio::spawn(run_test_start(
            gate.clone(),
            reservations.clone(),
            remote.clone(),
            native.clone(),
            "provider-a",
            1,
            Some(a_entered_tx),
            Some(release_a_rx),
        ));
        a_entered_rx.await.unwrap();
        reserve_start(&mut reservations.lock(), "project", 2);
        let stop = tokio::spawn(run_test_stop(gate, remote.clone(), native.clone()));
        assert!(!stop.is_finished());
        release_a_tx.send(()).unwrap();
        assert_eq!(
            a.await.unwrap().unwrap_err(),
            "control provider start was superseded"
        );
        stop.await.unwrap();
        assert_eq!(*remote.lock(), None);
        assert_eq!(*native.lock(), None);
    }

    #[tokio::test]
    async fn eof_between_registration_ack_and_publication_cannot_install_dead_connection() {
        #[derive(Debug)]
        struct TestConnection {
            publication: Arc<AtomicU64>,
            stopped: Arc<AtomicBool>,
        }
        impl TestConnection {
            fn stop(self) {
                self.stopped.store(true, Ordering::Release);
            }
        }
        let reservations = HashMap::from([("project".to_string(), 9)]);
        let mut entries = HashMap::<String, TestConnection>::new();
        let publication = Arc::new(AtomicU64::new(PUBLICATION_PENDING));
        let stopped = Arc::new(AtomicBool::new(false));
        publication.store(PUBLICATION_TERMINAL, Ordering::Release);
        let mut connection = Some(TestConnection {
            publication,
            stopped: stopped.clone(),
        });
        assert_eq!(
            publish_reserved_connection(
                &reservations,
                &mut entries,
                "project",
                9,
                &mut connection,
                |connection| connection.publication.as_ref(),
            )
            .unwrap_err(),
            PublishConnectionError::Unavailable,
        );
        assert!(entries.is_empty());
        connection
            .take()
            .expect("failed start retains ownership")
            .stop();
        assert!(stopped.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn atomic_publication_supports_normal_start_and_immediate_post_install_eof() {
        #[derive(Debug)]
        struct TestConnection {
            nonce: u64,
            publication: Arc<AtomicU64>,
        }
        let entries = Arc::new(Mutex::new(HashMap::<String, TestConnection>::new()));
        let (eof_tx, eof_rx) = oneshot::channel();
        let publication = Arc::new(AtomicU64::new(PUBLICATION_PENDING));
        let cleanup_entries = entries.clone();
        let cleanup_publication = publication.clone();
        let cleanup = tokio::spawn(async move {
            eof_rx.await.unwrap();
            cleanup_publication.store(PUBLICATION_TERMINAL, Ordering::Release);
            remove_if_nonce(&mut cleanup_entries.lock(), "project", 9, |entry| {
                entry.nonce
            });
        });
        publish_connection(
            &mut entries.lock(),
            "project",
            TestConnection {
                nonce: 9,
                publication: publication.clone(),
            },
            |connection| connection.publication.as_ref(),
        )
        .unwrap();
        assert_eq!(entries.lock()["project"].nonce, 9);
        assert_eq!(publication.load(Ordering::Acquire), PUBLICATION_ACTIVE);
        eof_tx.send(()).unwrap();
        cleanup.await.unwrap();
        assert!(entries.lock().is_empty());
    }
}
