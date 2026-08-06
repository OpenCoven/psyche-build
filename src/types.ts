import type { AgentName, PermissionMode } from './utils/agentLaunch.js';
import type { NotificationSoundId } from './utils/notificationSounds.js';
import type { OrchestrationLaneMode } from './orchestration/types.js';

export type PsycheThemeName =
  | 'red'
  | 'blue'
  | 'yellow'
  | 'orange'
  | 'green'
  | 'purple'
  | 'cyan'
  | 'magenta';

// Agent status with new analyzing state
export type AgentStatus = 'idle' | 'analyzing' | 'waiting' | 'working';

export interface OptionChoice {
  action: string;
  keys: string[];
  description?: string;
}

export interface PotentialHarm {
  hasRisk: boolean;
  description?: string;
}

export interface MergeTargetReference {
  displayName?: string;
  slug?: string;
  branchName: string;
  worktreePath?: string;
}

export interface SidebarProject {
  projectRoot: string;
  projectName: string;
  colorTheme?: PsycheThemeName;
  colorThemeSource?: 'auto' | 'manual';
}

export interface AgentSessionReference {
  agent: AgentName;
  id?: string;
  transcriptPath?: string;
  cwd?: string;
  lastTurnId?: string;
  updatedAt: string;
  source?: string;
}

export interface PsychePane {
  id: string;
  slug: string;
  displayName?: string; // User-facing pane name (independent from worktree slug/branch)
  branchName?: string; // Git branch name (may differ from slug when branchPrefix is set)
  prompt: string;
  paneId: string;
  hidden?: boolean; // Pane is detached from the active psyche window but still running
  projectRoot?: string; // Main repository root this pane belongs to
  projectName?: string; // Display name for pane's project
  colorTheme?: PsycheThemeName; // Cached effective project accent for fast focus/theme switches
  type?: 'worktree' | 'shell' | 'desktop-use';  // Type of pane (defaults to 'worktree' for backward compat)
  shellType?: string;  // Shell type for shell panes (bash, zsh, fish, fb, desktop-use, etc)
  covenSession?: {
    id: string;
    harness?: string;
    status?: string;
    projectRoot?: string;
  };
  desktopUse?: {
    sessionId?: string;
    status?: string;
    currentAction?: string;
    screenState?: string;
    accessibilityTree?: string;
    permissions?: Record<string, string>;
    screenshotPath?: string;
    updatedAt?: string;
  };
  worktreePath?: string;
  browserPath?: string; // Root path when a shell pane is a psyche file browser
  testWindowId?: string;  // Background window for tests
  testStatus?: 'running' | 'passed' | 'failed';
  testOutput?: string;
  devWindowId?: string;   // Background window for dev server
  devStatus?: 'running' | 'stopped';
  devUrl?: string;        // Detected dev server URL
  agent?: AgentName;
  agentSession?: AgentSessionReference;
  orchestration?: {
    taskId: string;
    laneId: string;
    traceId: string;
    mode: OrchestrationLaneMode;
  };
  permissionMode?: PermissionMode;
  agentStatus?: AgentStatus;  // Agent working/attention status
  needsAttention?: boolean; // Pane has settled and is waiting on the user
  lastAgentCheck?: number;  // Timestamp of last status check
  lastDeterministicStatus?: 'ambiguous' | 'working';  // For LLM detection coordination
  llmRequestId?: string;  // Track active LLM request
  // Options dialog data (when agentStatus is 'waiting')
  optionsQuestion?: string;
  options?: OptionChoice[];
  potentialHarm?: PotentialHarm;
  // Summary of what agent said (when agentStatus is 'idle')
  agentSummary?: string;
  // Autopilot mode - automatically accept options when no risk detected
  autopilot?: boolean;
  // Error message if pane analyzer encounters issues
  analyzerError?: string;
  // Merge ancestry for sub-worktrees; first entry is the immediate parent target.
  mergeTargetChain?: MergeTargetReference[];
}

export interface PanePosition {
  paneId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowDimensions {
  width: number;
  height: number;
}

export interface ProjectSettings {
  testCommand?: string;
  devCommand?: string;
  firstTestRun?: boolean;  // Track if test has been run before
  firstDevRun?: boolean;   // Track if dev has been run before
}

export interface PsycheSettings {
  // Agent permission mode
  // '' = agent default behavior (usually prompts for permissions)
  // plan = Claude plan mode only (read/plan focused)
  // acceptEdits = edit files without asking, ask for command execution
  // bypassPermissions = fully autonomous mode (dangerous)
  permissionMode?: '' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  // Autopilot settings
  enableAutopilotByDefault?: boolean;
  // Agent selection
  defaultAgent?: AgentName | '';
  // Which agents appear in new-pane selection
  enabledAgents?: AgentName[];
  // Which macOS helper notification sounds are eligible for random selection
  enabledNotificationSounds?: NotificationSoundId[];
  // Rotate short psyche tips in the footer
  showFooterTips?: boolean;
  // Accent color theme used across the TUI and welcome pane
  colorTheme?: PsycheThemeName;
  // Tmux hooks for event-driven updates (low CPU)
  // true = use hooks, false = use polling, undefined = not yet asked
  useTmuxHooks?: boolean;
  // Base branch for new worktrees (e.g. 'main', 'master', 'develop')
  // When set, worktrees branch from this instead of the current HEAD
  baseBranch?: string;
  // Prefix for branch names (e.g. 'feat/' produces 'feat/fix-auth')
  branchPrefix?: string;
  // Maximum number of psyche-managed worktrees to keep per project.
  // Old inactive managed worktrees are pruned after pane creation.
  maxManagedWorktrees?: number;
  // Preferred minimum content pane width in characters
  minPaneWidth?: number;
  // Preferred maximum content pane width in characters
  maxPaneWidth?: number;
}

export type SettingsScope = 'global' | 'project';
export type EffectiveSettingsScope = SettingsScope | 'team';

export interface SettingDefinition {
  key: keyof PsycheSettings | string;
  label: string;
  description: string;
  type: 'boolean' | 'select' | 'text' | 'number' | 'action';
  scopeBehavior?: 'choose' | 'session' | 'global' | 'project';
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  shiftStep?: number;
}

export interface PsycheAppProps {
  panesFile: string;
  projectName: string;
  sessionName: string;
  projectRoot?: string;
  settingsFile: string;
  autoUpdater?: any; // AutoUpdater instance
  controlPaneId?: string; // Pane ID running psyche TUI (left sidebar)
  bridgeDaemon?: any; // BridgeDaemon instance (optional, macOS-only progressive enhancement)
}

export type PaneSplitDirection = 'horizontal' | 'vertical';

export interface PaneLayoutLeaf {
  kind: 'leaf';
  paneId: string;
}

export interface PaneLayoutSplit {
  kind: 'split';
  direction: PaneSplitDirection;
  ratio: number;
  first: PaneLayoutNode;
  second: PaneLayoutNode;
}

export type PaneLayoutNode = PaneLayoutLeaf | PaneLayoutSplit;

export interface PaneLayout {
  version: 1;
  root: PaneLayoutNode | null;
}

export interface PsycheConfig {
  projectName: string;
  projectRoot: string;
  panes: PsychePane[];
  paneLayout?: PaneLayout;
  sidebarProjects?: SidebarProject[];
  settings: PsycheSettings;
  lastUpdated: string;
  controlPaneId?: string; // Pane ID running psyche TUI (left sidebar)
  controlPaneSize?: number; // Fixed sidebar width (40 chars)
  welcomePaneId?: string; // Pane ID for the welcome/placeholder pane
}

// Hook types - re-exported from hooks utility for convenience
export type {
  HookType,
  HookEnvironment,
} from './utils/hooks.js';

// Log types - re-exported from LogService for convenience
export type {
  LogLevel,
  LogEntry,
} from './services/LogService.js';
