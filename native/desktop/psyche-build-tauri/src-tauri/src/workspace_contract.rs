use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSnapshotEnvelope {
    pub(crate) r#type: String,
    pub(crate) request_id: String,
    pub(crate) workspace: WorkspaceSnapshot,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSnapshot {
    pub(crate) revision: u64,
    pub(crate) projects: Vec<WorkspaceProjectSnapshot>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceProjectSnapshot {
    pub(crate) id: String,
    pub(crate) root: String,
    pub(crate) title: String,
    pub(crate) worktrees: Vec<WorkspaceWorktreeSnapshot>,
    pub(crate) project_panes: Vec<WorkspacePaneSnapshot>,
    pub(crate) running_count: u64,
    pub(crate) attention_count: u64,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceWorktreeSnapshot {
    pub(crate) path: String,
    pub(crate) head: String,
    pub(crate) branch: Option<String>,
    pub(crate) is_main: bool,
    pub(crate) detached: bool,
    pub(crate) bare: bool,
    pub(crate) locked: bool,
    pub(crate) lock_reason: Option<String>,
    pub(crate) prunable: bool,
    pub(crate) prune_reason: Option<String>,
    pub(crate) dirty: bool,
    pub(crate) missing: bool,
    pub(crate) panes: Vec<WorkspacePaneSnapshot>,
    pub(crate) running_count: u64,
    pub(crate) attention_count: u64,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspacePaneSnapshot {
    pub(crate) id: String,
    pub(crate) cwd: String,
    pub(crate) title: Option<String>,
    pub(crate) kind: String,
    pub(crate) agent: Option<String>,
    pub(crate) status: String,
    pub(crate) needs_attention: Option<bool>,
    pub(crate) recoverability: String,
}

#[cfg(test)]
mod tests {
    use super::WorkspaceSnapshotEnvelope;

    #[test]
    fn decodes_the_generated_workspace_fixture() {
        let fixture = include_str!("../../../../../protocol-fixtures/workspace-snapshot.json");
        let envelope: WorkspaceSnapshotEnvelope =
            serde_json::from_str(fixture).expect("workspace fixture should decode");

        assert_eq!(envelope.r#type, "workspace.snapshot.result");
        assert_eq!(envelope.workspace.revision, 42);
        assert_eq!(envelope.workspace.projects[0].worktrees.len(), 2);
        assert_eq!(
            envelope.workspace.projects[0].project_panes[0].recoverability,
            "missing-worktree"
        );
    }
}
