import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { PsycheSettings, SettingsScope, EffectiveSettingsScope, SettingDefinition } from '../types.js';
import {
  DEFAULT_MIN_PANE_WIDTH,
  DEFAULT_MAX_PANE_WIDTH,
  MAX_MIN_PANE_WIDTH,
  MAX_MAX_PANE_WIDTH,
  MIN_MIN_PANE_WIDTH,
  MIN_MAX_PANE_WIDTH,
  SHIFT_MIN_PANE_WIDTH_STEP,
  SHIFT_MAX_PANE_WIDTH_STEP,
} from '../constants/layout.js';
import { isValidBranchName } from './git.js';
import {
  getAgentDefinitions,
  getDefaultEnabledAgents,
  isAgentName,
  type AgentName,
} from './agentLaunch.js';
import {
  getDefaultNotificationSoundSelection,
  isNotificationSoundId,
  type NotificationSoundId,
} from './notificationSounds.js';
import {
  DEFAULT_PSYCHE_THEME,
  PSYCHE_THEME_NAMES,
  getPsycheThemeLabel,
  isPsycheThemeName,
} from '../theme/themePalette.js';

const GLOBAL_SETTINGS_PATH = join(homedir(), '.psyche.global.json');
const TEAM_DEFAULTS_FILENAME = '.psyche.defaults.json';
const PERMISSION_MODES = ['', 'plan', 'acceptEdits', 'bypassPermissions'] as const;
const MIN_MAX_MANAGED_WORKTREES = 1;
const MAX_MAX_MANAGED_WORKTREES = 500;
const DEFAULT_MAX_MANAGED_WORKTREES = 12;
function isPermissionMode(value: string): value is NonNullable<PsycheSettings['permissionMode']> {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

function isValidMaxManagedWorktrees(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MAX_MANAGED_WORKTREES &&
    value <= MAX_MAX_MANAGED_WORKTREES
  );
}

function isValidMaxPaneWidth(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MAX_PANE_WIDTH &&
    value <= MAX_MAX_PANE_WIDTH
  );
}

function isValidMinPaneWidth(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MIN_PANE_WIDTH &&
    value <= MAX_MIN_PANE_WIDTH
  );
}

function sanitizeLoadedSettings(value: unknown): PsycheSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const parsed = value as Record<string, unknown>;
  const sanitized: PsycheSettings = {};

  if (typeof parsed.permissionMode === 'string' && isPermissionMode(parsed.permissionMode)) {
    sanitized.permissionMode = parsed.permissionMode;
  }

  if (typeof parsed.enableAutopilotByDefault === 'boolean') {
    sanitized.enableAutopilotByDefault = parsed.enableAutopilotByDefault;
  }

  if (
    typeof parsed.defaultAgent === 'string'
    && (parsed.defaultAgent === '' || isAgentName(parsed.defaultAgent))
  ) {
    sanitized.defaultAgent = parsed.defaultAgent;
  }

  if (Array.isArray(parsed.enabledAgents)) {
    sanitized.enabledAgents = parsed.enabledAgents.filter(
      (agent): agent is AgentName => typeof agent === 'string' && isAgentName(agent)
    );
  }

  if (Array.isArray(parsed.enabledNotificationSounds)) {
    sanitized.enabledNotificationSounds = parsed.enabledNotificationSounds.filter(
      (soundId): soundId is NotificationSoundId =>
        typeof soundId === 'string' && isNotificationSoundId(soundId)
    );
  }

  if (typeof parsed.showFooterTips === 'boolean') {
    sanitized.showFooterTips = parsed.showFooterTips;
  }

  if (typeof parsed.colorTheme === 'string' && isPsycheThemeName(parsed.colorTheme)) {
    sanitized.colorTheme = parsed.colorTheme;
  }

  if (typeof parsed.useTmuxHooks === 'boolean') {
    sanitized.useTmuxHooks = parsed.useTmuxHooks;
  }

  if (typeof parsed.baseBranch === 'string' && (parsed.baseBranch === '' || isValidBranchName(parsed.baseBranch))) {
    sanitized.baseBranch = parsed.baseBranch;
  }

  if (
    typeof parsed.branchPrefix === 'string'
    && (parsed.branchPrefix === '' || isValidBranchName(parsed.branchPrefix))
  ) {
    sanitized.branchPrefix = parsed.branchPrefix;
  }

  if (isValidMaxManagedWorktrees(parsed.maxManagedWorktrees)) {
    sanitized.maxManagedWorktrees = parsed.maxManagedWorktrees;
  }

  if (isValidMinPaneWidth(parsed.minPaneWidth)) {
    sanitized.minPaneWidth = parsed.minPaneWidth;
  }

  if (isValidMaxPaneWidth(parsed.maxPaneWidth)) {
    sanitized.maxPaneWidth = parsed.maxPaneWidth;
  }

  return sanitized;
}

function cloneSettingsArrays(settings: PsycheSettings): PsycheSettings {
  const cloned: PsycheSettings = { ...settings };

  if (Array.isArray(cloned.enabledAgents)) {
    cloned.enabledAgents = [...cloned.enabledAgents];
  }

  if (Array.isArray(cloned.enabledNotificationSounds)) {
    cloned.enabledNotificationSounds = [...cloned.enabledNotificationSounds];
  }

  return cloned;
}

const DEFAULT_SETTINGS: PsycheSettings = {
  // Most permissive defaults for new psyche setups.
  permissionMode: 'bypassPermissions',
  enableAutopilotByDefault: true,
  minPaneWidth: DEFAULT_MIN_PANE_WIDTH,
  maxPaneWidth: DEFAULT_MAX_PANE_WIDTH,
  enabledAgents: getDefaultEnabledAgents(),
  enabledNotificationSounds: getDefaultNotificationSoundSelection(),
  showFooterTips: true,
  colorTheme: DEFAULT_PSYCHE_THEME,
  maxManagedWorktrees: DEFAULT_MAX_MANAGED_WORKTREES,
};

const AGENT_OPTIONS = getAgentDefinitions().map((agent) => ({
  value: agent.id,
  label: agent.name,
}));

export const DEFAULT_COLOR_THEME_SETTING_KEY = 'defaultColorTheme';

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'permissionMode',
    label: 'Agent Permission Mode',
    description: 'Controls how much permission is granted to launched agents',
    type: 'select',
    options: [
      { value: '', label: 'Agent default (ask)' },
      { value: 'plan', label: 'Plan mode (Claude only)' },
      { value: 'acceptEdits', label: 'Accept edits' },
      { value: 'bypassPermissions', label: 'Bypass permissions (max autonomy)' },
    ],
  },
  {
    key: 'enableAutopilotByDefault',
    label: 'Enable Autopilot by Default',
    description: 'Automatically accept options when no risk is detected for new panes',
    type: 'boolean',
  },
  {
    key: 'defaultAgent',
    label: 'Default Agent',
    description: 'Skip agent selection and use this agent for all new panes',
    type: 'select',
    options: [
      { value: '', label: 'Ask each time' },
      ...AGENT_OPTIONS,
    ],
  },
  {
    key: 'enabledAgents' as any,
    label: 'Enabled Agents',
    description: 'Select which agents appear in the new pane selection list',
    type: 'action' as any,
  },
  {
    key: 'enabledNotificationSounds' as any,
    label: 'Attention Notification Sounds',
    description: 'Select the macOS helper sounds that psyche randomizes between for background alerts',
    type: 'action' as any,
  },
  {
    key: 'showFooterTips',
    label: 'Show Footer Tips',
    description: 'Rotate short psyche tips in the footer. Disable this if you prefer a quieter sidebar.',
    type: 'boolean',
  },
  {
    key: 'colorTheme',
    label: 'Color Theme',
    description: 'Choose the accent color for the psyche UI and welcome pane',
    type: 'select',
    options: PSYCHE_THEME_NAMES.map((themeName) => ({
      value: themeName,
      label: getPsycheThemeLabel(themeName),
    })),
  },
  {
    key: 'useTmuxHooks',
    label: 'Use Tmux Hooks',
    description: 'Use tmux hooks for event-driven updates (lower CPU). If disabled, uses polling in a worker thread.',
    type: 'boolean',
  },
  {
    key: 'baseBranch',
    label: 'Base Branch',
    description: 'Branch to create new worktrees from. Leave empty to use current HEAD.',
    type: 'text',
  },
  {
    key: 'branchPrefix',
    label: 'Branch Name Prefix',
    description: 'Prefix for new branch names (e.g. "feat/" produces branch "feat/fix-auth"). Leave empty for no prefix.',
    type: 'select',
    options: [
      { value: '', label: 'No prefix (default)' },
      { value: 'feat/', label: 'feat/' },
      { value: 'fix/', label: 'fix/' },
      { value: 'chore/', label: 'chore/' },
    ],
  },
  {
    key: 'maxManagedWorktrees',
    label: 'Max Managed Worktrees',
    description: 'Maximum psyche-managed worktrees to keep per project. Old inactive worktrees are pruned after new panes are created.',
    type: 'number',
    min: MIN_MAX_MANAGED_WORKTREES,
    max: MAX_MAX_MANAGED_WORKTREES,
    step: 1,
    shiftStep: 5,
  },
  {
    key: 'minPaneWidth',
    label: 'Min Pane Width',
    description: 'Global minimum content-pane width in characters used during layout fitting.',
    type: 'number',
    min: MIN_MIN_PANE_WIDTH,
    max: MAX_MIN_PANE_WIDTH,
    step: 1,
    shiftStep: SHIFT_MIN_PANE_WIDTH_STEP,
  },
  {
    key: 'maxPaneWidth',
    label: 'Max Pane Width',
    description: 'Global maximum content-pane width in characters before wrapping/spacer logic.',
    type: 'number',
    min: MIN_MAX_PANE_WIDTH,
    max: MAX_MAX_PANE_WIDTH,
    step: 1,
    shiftStep: SHIFT_MAX_PANE_WIDTH_STEP,
  },
  {
    key: 'hooks' as any,
    label: 'Manage Hooks',
    description: 'View and edit psyche lifecycle hooks',
    type: 'action' as any,
  },
];

export class SettingsManager {
  private globalPath: string;
  private projectPath: string;
  private teamDefaultsPath: string;
  private globalSettings: PsycheSettings = {};
  private projectSettings: PsycheSettings = {};
  private teamDefaults: PsycheSettings = {};

  constructor(projectRoot?: string) {
    const root = projectRoot || process.cwd();
    this.globalPath = GLOBAL_SETTINGS_PATH;
    this.projectPath = join(root, '.psyche', 'settings.json');
    this.teamDefaultsPath = join(root, TEAM_DEFAULTS_FILENAME);
    this.loadSettings();
  }

  private loadSettingsFile(filePath: string, label: string): PsycheSettings {
    if (!existsSync(filePath)) {
      return {};
    }

    try {
      const data = readFileSync(filePath, 'utf-8');
      return sanitizeLoadedSettings(JSON.parse(data));
    } catch (error) {
      console.error(`Failed to load ${label}:`, error);
      return {};
    }
  }

  private loadSettings(): void {
    this.teamDefaults = this.loadSettingsFile(this.teamDefaultsPath, 'team defaults');
    this.globalSettings = this.loadSettingsFile(this.globalPath, 'global settings');
    this.projectSettings = this.loadSettingsFile(this.projectPath, 'project settings');
  }

  private getValidGlobalMinPaneWidth(): number {
    return isValidMinPaneWidth(this.globalSettings.minPaneWidth)
      ? this.globalSettings.minPaneWidth
      : (DEFAULT_SETTINGS.minPaneWidth as number);
  }

  private getValidGlobalMaxPaneWidth(): number {
    return isValidMaxPaneWidth(this.globalSettings.maxPaneWidth)
      ? this.globalSettings.maxPaneWidth
      : (DEFAULT_SETTINGS.maxPaneWidth as number);
  }

  private resolveGlobalPaneWidths(
    overrides?: Partial<Pick<PsycheSettings, 'minPaneWidth' | 'maxPaneWidth'>>
  ): { minPaneWidth: number; maxPaneWidth: number } {
    const hasMinOverride = overrides?.minPaneWidth !== undefined;
    const hasMaxOverride = overrides?.maxPaneWidth !== undefined;

    let minPaneWidth = hasMinOverride
      ? (overrides?.minPaneWidth as number)
      : this.getValidGlobalMinPaneWidth();
    let maxPaneWidth = hasMaxOverride
      ? (overrides?.maxPaneWidth as number)
      : this.getValidGlobalMaxPaneWidth();

    if (minPaneWidth > maxPaneWidth) {
      if (hasMinOverride && !hasMaxOverride) {
        minPaneWidth = maxPaneWidth;
      } else {
        maxPaneWidth = minPaneWidth;
      }
    }

    return { minPaneWidth, maxPaneWidth };
  }

  /**
   * Get merged settings (project > global > team defaults > built-in defaults)
   */
  getSettings(): PsycheSettings {
    const merged = cloneSettingsArrays({
      ...DEFAULT_SETTINGS,
      ...this.teamDefaults,
      ...this.globalSettings,
      ...this.projectSettings,
    });

    // Pane width bounds are global-only; ignore any project override values.
    const paneWidths = this.resolveGlobalPaneWidths();
    merged.minPaneWidth = paneWidths.minPaneWidth;
    merged.maxPaneWidth = paneWidths.maxPaneWidth;

    return merged;
  }

  /**
   * Get a specific setting value (with project override)
   */
  getSetting<K extends keyof PsycheSettings>(key: K): PsycheSettings[K] {
    const merged = this.getSettings();
    return merged[key];
  }

  /**
   * Get global settings only
   */
  getGlobalSettings(): PsycheSettings {
    return cloneSettingsArrays(this.globalSettings);
  }

  /**
   * Get project settings only
   */
  getProjectSettings(): PsycheSettings {
    return cloneSettingsArrays(this.projectSettings);
  }

  /**
   * Update a setting at the specified scope
   */
  updateSetting<K extends keyof PsycheSettings>(
    key: K,
    value: PsycheSettings[K],
    scope: SettingsScope
  ): void {
    // Validate branch-related settings
    if ((key === 'baseBranch' || key === 'branchPrefix') && typeof value === 'string' && value !== '') {
      if (!isValidBranchName(value)) {
        throw new Error(`Invalid ${key}: contains characters not allowed in git branch names`);
      }
    }
    if (key === 'permissionMode' && typeof value === 'string' && !isPermissionMode(value)) {
      throw new Error(`Invalid permissionMode: "${value}"`);
    }
    if (key === 'colorTheme' && !isPsycheThemeName(value)) {
      throw new Error(`Invalid colorTheme: "${String(value)}"`);
    }
    if (key === 'enabledAgents') {
      if (!Array.isArray(value)) {
        throw new Error('Invalid enabledAgents: expected an array of agent IDs');
      }
      const invalidAgents = value.filter((agent) => !isAgentName(agent));
      if (invalidAgents.length > 0) {
        throw new Error(`Invalid enabledAgents: ${invalidAgents.join(', ')}`);
      }
    }
    if (key === 'enabledNotificationSounds') {
      if (!Array.isArray(value)) {
        throw new Error('Invalid enabledNotificationSounds: expected an array of sound IDs');
      }
      const invalidSoundIds = value.filter((soundId) => !isNotificationSoundId(soundId));
      if (invalidSoundIds.length > 0) {
        throw new Error(`Invalid enabledNotificationSounds: ${invalidSoundIds.join(', ')}`);
      }
    }
    if (key === 'minPaneWidth' && !isValidMinPaneWidth(value)) {
      throw new Error(
        `Invalid minPaneWidth: expected an integer between ${MIN_MIN_PANE_WIDTH} and ${MAX_MIN_PANE_WIDTH}`
      );
    }
    if (key === 'maxPaneWidth' && !isValidMaxPaneWidth(value)) {
      throw new Error(
        `Invalid maxPaneWidth: expected an integer between ${MIN_MAX_PANE_WIDTH} and ${MAX_MAX_PANE_WIDTH}`
      );
    }
    if (key === 'maxManagedWorktrees' && !isValidMaxManagedWorktrees(value)) {
      throw new Error(
        `Invalid maxManagedWorktrees: expected an integer between ${MIN_MAX_MANAGED_WORKTREES} and ${MAX_MAX_MANAGED_WORKTREES}`
      );
    }

    // Pane width settings are always stored globally, regardless of requested scope.
    if (key === 'minPaneWidth' || key === 'maxPaneWidth') {
      const paneWidthOverrides: Partial<Pick<PsycheSettings, 'minPaneWidth' | 'maxPaneWidth'>> = {};
      if (key === 'minPaneWidth') {
        paneWidthOverrides.minPaneWidth = value as number;
      } else {
        paneWidthOverrides.maxPaneWidth = value as number;
      }
      const paneWidths = this.resolveGlobalPaneWidths(paneWidthOverrides);
      this.globalSettings.minPaneWidth = paneWidths.minPaneWidth;
      this.globalSettings.maxPaneWidth = paneWidths.maxPaneWidth;

      let projectSettingsChanged = false;
      if (this.projectSettings.minPaneWidth !== undefined) {
        delete this.projectSettings.minPaneWidth;
        projectSettingsChanged = true;
      }
      if (this.projectSettings.maxPaneWidth !== undefined) {
        delete this.projectSettings.maxPaneWidth;
        projectSettingsChanged = true;
      }
      if (projectSettingsChanged) {
        this.saveProjectSettings();
      }
      this.saveGlobalSettings();
      return;
    }

    if (scope === 'global') {
      this.globalSettings[key] = value;
      this.saveGlobalSettings();
    } else {
      this.projectSettings[key] = value;
      this.saveProjectSettings();
    }
  }

  /**
   * Update multiple settings at once
   */
  updateSettings(settings: Partial<PsycheSettings>, scope: SettingsScope): void {
    if (typeof settings.permissionMode === 'string' && !isPermissionMode(settings.permissionMode)) {
      throw new Error(`Invalid permissionMode: "${settings.permissionMode}"`);
    }
    if (settings.colorTheme !== undefined && !isPsycheThemeName(settings.colorTheme)) {
      throw new Error(`Invalid colorTheme: "${String(settings.colorTheme)}"`);
    }
    if (settings.enabledAgents !== undefined) {
      if (!Array.isArray(settings.enabledAgents)) {
        throw new Error('Invalid enabledAgents: expected an array of agent IDs');
      }
      const invalidAgents = settings.enabledAgents.filter(
        (agent) => !isAgentName(agent)
      );
      if (invalidAgents.length > 0) {
        throw new Error(`Invalid enabledAgents: ${invalidAgents.join(', ')}`);
      }
      settings.enabledAgents = settings.enabledAgents as AgentName[];
    }
    if (settings.enabledNotificationSounds !== undefined) {
      if (!Array.isArray(settings.enabledNotificationSounds)) {
        throw new Error('Invalid enabledNotificationSounds: expected an array of sound IDs');
      }
      const invalidSoundIds = settings.enabledNotificationSounds.filter(
        (soundId) => !isNotificationSoundId(soundId)
      );
      if (invalidSoundIds.length > 0) {
        throw new Error(`Invalid enabledNotificationSounds: ${invalidSoundIds.join(', ')}`);
      }
      settings.enabledNotificationSounds = settings.enabledNotificationSounds as NotificationSoundId[];
    }
    if (typeof settings.baseBranch === 'string' && settings.baseBranch !== '' && !isValidBranchName(settings.baseBranch)) {
      throw new Error('Invalid baseBranch: contains characters not allowed in git branch names');
    }
    if (typeof settings.branchPrefix === 'string' && settings.branchPrefix !== '' && !isValidBranchName(settings.branchPrefix)) {
      throw new Error('Invalid branchPrefix: contains characters not allowed in git branch names');
    }
    if (settings.minPaneWidth !== undefined && !isValidMinPaneWidth(settings.minPaneWidth)) {
      throw new Error(
        `Invalid minPaneWidth: expected an integer between ${MIN_MIN_PANE_WIDTH} and ${MAX_MIN_PANE_WIDTH}`
      );
    }
    if (settings.maxPaneWidth !== undefined && !isValidMaxPaneWidth(settings.maxPaneWidth)) {
      throw new Error(
        `Invalid maxPaneWidth: expected an integer between ${MIN_MAX_PANE_WIDTH} and ${MAX_MAX_PANE_WIDTH}`
      );
    }
    if (settings.maxManagedWorktrees !== undefined && !isValidMaxManagedWorktrees(settings.maxManagedWorktrees)) {
      throw new Error(
        `Invalid maxManagedWorktrees: expected an integer between ${MIN_MAX_MANAGED_WORKTREES} and ${MAX_MAX_MANAGED_WORKTREES}`
      );
    }

    const settingsToApply: Partial<PsycheSettings> = { ...settings };
    let projectSettingsChanged = false;
    let paneWidthsUpdated = false;

    if (settingsToApply.minPaneWidth !== undefined || settingsToApply.maxPaneWidth !== undefined) {
      const paneWidthOverrides: Partial<Pick<PsycheSettings, 'minPaneWidth' | 'maxPaneWidth'>> = {};
      if (settingsToApply.minPaneWidth !== undefined) {
        paneWidthOverrides.minPaneWidth = settingsToApply.minPaneWidth;
      }
      if (settingsToApply.maxPaneWidth !== undefined) {
        paneWidthOverrides.maxPaneWidth = settingsToApply.maxPaneWidth;
      }
      const paneWidths = this.resolveGlobalPaneWidths(paneWidthOverrides);

      this.globalSettings.minPaneWidth = paneWidths.minPaneWidth;
      this.globalSettings.maxPaneWidth = paneWidths.maxPaneWidth;
      paneWidthsUpdated = true;

      delete settingsToApply.minPaneWidth;
      delete settingsToApply.maxPaneWidth;

      if (this.projectSettings.minPaneWidth !== undefined) {
        delete this.projectSettings.minPaneWidth;
        projectSettingsChanged = true;
      }
      if (this.projectSettings.maxPaneWidth !== undefined) {
        delete this.projectSettings.maxPaneWidth;
        projectSettingsChanged = true;
      }
    }

    const hasRemainingSettings = Object.keys(settingsToApply).length > 0;

    if (scope === 'global') {
      if (hasRemainingSettings) {
        this.globalSettings = { ...this.globalSettings, ...settingsToApply };
      }
      if (hasRemainingSettings || paneWidthsUpdated) {
        this.saveGlobalSettings();
      }
      if (projectSettingsChanged) {
        this.saveProjectSettings();
      }
    } else {
      if (hasRemainingSettings) {
        this.projectSettings = { ...this.projectSettings, ...settingsToApply };
        projectSettingsChanged = true;
      }
      if (projectSettingsChanged) {
        this.saveProjectSettings();
      }
      if (paneWidthsUpdated) {
        this.saveGlobalSettings();
      }
    }
  }

  /**
   * Remove a setting from the specified scope
   */
  removeSetting(key: keyof PsycheSettings, scope: SettingsScope): void {
    if (scope === 'global') {
      delete this.globalSettings[key];
      this.saveGlobalSettings();
    } else {
      delete this.projectSettings[key];
      this.saveProjectSettings();
    }
  }

  private saveGlobalSettings(): void {
    try {
      const dir = dirname(this.globalPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.globalPath, JSON.stringify(this.globalSettings, null, 2));
    } catch (error) {
      console.error('Failed to save global settings:', error);
      throw error;
    }
  }

  private saveProjectSettings(): void {
    try {
      const dir = dirname(this.projectPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.projectPath, JSON.stringify(this.projectSettings, null, 2));
    } catch (error) {
      console.error('Failed to save project settings:', error);
      throw error;
    }
  }

  /**
   * Check if a setting is overridden at the project level
   */
  isProjectOverride(key: keyof PsycheSettings): boolean {
    if (key === 'minPaneWidth' || key === 'maxPaneWidth') {
      return false;
    }
    return key in this.projectSettings;
  }

  /**
   * Get team defaults (committed to repo, read-only)
   */
  getTeamDefaults(): PsycheSettings {
    return cloneSettingsArrays(this.teamDefaults);
  }

  /**
   * Get the effective scope for a setting (where it's currently defined)
   */
  getEffectiveScope(key: keyof PsycheSettings): EffectiveSettingsScope | null {
    if (key === 'minPaneWidth') {
      return this.globalSettings.minPaneWidth !== undefined ? 'global' : null;
    }
    if (key === 'maxPaneWidth') {
      return this.globalSettings.maxPaneWidth !== undefined ? 'global' : null;
    }
    if (key in this.projectSettings) return 'project';
    if (key in this.globalSettings) return 'global';
    if (key in this.teamDefaults) return 'team';
    return null;
  }
}
