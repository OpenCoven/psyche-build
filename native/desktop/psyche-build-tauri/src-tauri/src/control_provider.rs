<<OURS>>
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
<<OURS>>
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    project_root: String,
    provider_id: String,
    connected: bool,
<<OURS>>
pub struct BrowserViewport {
    width: u32,
    height: u32,
}

<<OURS>>
    url: String,
    title: String,
    loading: bool,
    viewport: BrowserViewport,
}

<<OURS>>
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
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
<<OURS>>
impl ProviderEffectResult {
    fn action_id(&self) -> &str {
        match self {
            Self::Succeeded { action_id, .. }
            | Self::Failed { action_id, .. }
<<OURS>>
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

<<OURS>>
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
<<OURS>>
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("control credentials must have mode 0600".to_string());
    }
<<OURS>>
        },
    );
    Ok(())
}

<<OURS>>
}

#[tauri::command]
pub async fn control_provider_start(
    app: AppHandle,
    state: State<'_, ControlProviderState>,
    project_root: String,
) -> Result<ProviderStatus, String> {
<<OURS>>
    })
}

#[tauri::command]
pub async fn control_provider_stop(
<<OURS>>
    }
    Ok(())
}

#[tauri::command]
pub async fn control_provider_upsert(
    state: State<'_, ControlProviderState>,
    project_root: String,
    resource: BrowserTabResource,
) -> Result<BrowserTabResource, String> {
<<OURS>>
}

#[tauri::command]
pub async fn control_provider_remove(
<<OURS>>
}

#[tauri::command]
pub async fn control_operator_submit(
    state: State<'_, ControlProviderState>,
    project_root: String,
    command: OperatorCommand,
) -> Result<Value, String> {
<<OURS>>
    )
    .await
}

<<OURS>>
        );
    }

    #[test]
<<OURS>>
    }
}
