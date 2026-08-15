#!/usr/bin/env node

import { execSync, spawnSync } from 'child_process';
import chalk from 'chalk';
import fs from 'fs/promises';
import * as fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { render } from 'ink';
import React from 'react';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { createInterface } from 'node:readline/promises';
import PsycheApp from './PsycheApp.js';
import FileBrowserApp from './FileBrowserApp.js';
import { AutoUpdater } from './services/AutoUpdater.js';
import { StateManager } from './shared/StateManager.js';
import { LogService } from './services/LogService.js';
import { TmuxService } from './services/TmuxService.js';
import {
  applyTmuxThemeToSession,
  createWelcomePane,
  destroyWelcomePane,
} from './utils/welcomePane.js';
import { SIDEBAR_WIDTH } from './utils/layoutManager.js';
import { validateSystemRequirements, printValidationResults } from './utils/systemCheck.js';
import { getUntrackedPanes } from './utils/shellPaneDetection.js';
import { runFirstRunOnboardingIfNeeded } from './utils/onboarding.js';
import {
  mutateProjectPaneConfig,
  readProjectPaneConfig,
} from './services/ProjectPaneConfig.js';
import { buildDevWatchCommand, buildDevWatchRespawnCommand } from './utils/devWatchCommand.js';
import { shouldUseQuietDevWatchExit } from './utils/devWatchExit.js';
import {
  buildPaneExitedHookCommandForSession,
  buildPaneFocusHookCommandForSession,
} from './utils/tmuxHookCommands.js';
import { ensureTmuxRuntimeCompatibility } from './utils/tmuxRuntimeCompatibility.js';
import { claimProcessShutdown } from './utils/processShutdown.js';
import { sendTmuxShellCommand } from './utils/tmuxSendKeys.js';
import { ensurePsycheRuntimeIgnored } from './utils/gitignore.js';
import {
  detectLegacyComuxState,
  formatLegacyComuxWarning,
} from './utils/legacyComuxState.js';
import {
  addSidebarProject,
  getAutoSidebarProjectColorTheme,
  getSidebarProjectColorTheme,
  hasSidebarProject,
  normalizeSidebarProjects,
} from './utils/sidebarProjects.js';
import { SettingsManager } from './utils/settingsManager.js';
import {
  buildRemotePaneActionBindingCommandArgs,
  buildRemotePaneActionCleanupCommandArgs,
  clearRemotePaneActions,
  PSYCHE_CONTROLLER_PID_OPTION,
  PSYCHE_CONTROL_PANE_OPTION,
  PSYCHE_REMOTE_PANE_MODE_OPTION,
  enqueueRemotePaneAction,
  getCurrentTmuxPaneId as getFocusedTmuxPaneId,
  getCurrentTmuxSessionName as getFocusedTmuxSessionName,
  getTmuxSessionOption,
  isRemotePaneActionShortcut,
  showTmuxMessage,
} from './utils/remotePaneActions.js';
import {
  resolveEnabledAgentsSelection,
  type AgentName,
} from './utils/agentLaunch.js';
import {
  formatTmuxDoctorJson,
  formatTmuxDoctorText,
  getTmuxDoctorExitCode,
  runTmuxDoctor,
} from './utils/tmuxDoctor.js';
import { COLORS } from './theme/colors.js';
import { TMUX_PANE_TITLE_DISPLAY_FORMAT } from './utils/paneTitle.js';
import {
  TMUX_PANE_TITLE_LABEL_FORMAT,
  TMUX_PANE_TITLE_PREFIX_FORMAT,
} from './utils/paneTitlePrefix.js';
import type { PsycheConfig, PsychePane } from './types.js';
import { BridgeDaemon } from './services/bridge/BridgeDaemon.js';
import type { PaneSnapshot, Project, Ritual } from './services/bridge/wireProtocol.js';
import { tmuxSessionNameForRoot } from './services/tmuxControl.js';
import { listAvailableRituals } from './utils/rituals.js';
import {
  createTuiWorkspaceProvider,
  groupCovenSessionsByProject,
} from './workspace/tuiSnapshot.js';
import os from 'node:os';
import {
  acknowledgeWorktreeRecoveryMarker,
  listWorktreeRecoveryMarkers,
} from './services/WorktreeRecoveryMarker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

interface ExistingSessionContext {
  sessionName: string;
  sessionProjectRoot: string;
  sessionProjectName: string;
  sessionConfigPath: string;
}

function isFilesOnlyMode(): boolean {
  return process.argv.slice(2).includes('--files-only');
}

function getArgValue(flag: string): string | null {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return null;
  }

  return args[flagIndex + 1] || null;
}

function isDoctorMode(): boolean {
  return process.argv.slice(2)[0] === 'doctor';
}

function isRecoveryMode(): boolean {
  return process.argv.slice(2)[0] === 'recover';
}

async function handleRecoveryCli(): Promise<number> {
  const args = process.argv.slice(3);
  const projectFlagIndex = args.indexOf('--project');
  const projectRoot = projectFlagIndex >= 0
    ? args[projectFlagIndex + 1]
    : process.cwd();
  if (!projectRoot) {
    console.error('psyche recover requires a project path after --project');
    return 1;
  }

  const acknowledgeIndex = args.indexOf('--acknowledge');
  if (acknowledgeIndex >= 0) {
    const markerId = args[acknowledgeIndex + 1];
    if (!markerId) {
      console.error('psyche recover --acknowledge requires a marker ID');
      return 1;
    }
    const removed = await acknowledgeWorktreeRecoveryMarker(projectRoot, markerId);
    console.log(
      removed
        ? `Acknowledged worktree recovery marker ${markerId}.`
        : `No worktree recovery marker found for ${markerId}.`,
    );
    return removed ? 0 : 1;
  }

  const markers = await listWorktreeRecoveryMarkers(projectRoot);
  if (markers.length === 0) {
    console.log('No worktree recovery markers found.');
    return 0;
  }

  for (const marker of markers) {
    console.log([
      `${marker.id} ${marker.operation}`,
      `  worktree: ${marker.worktreePath}`,
      `  pane: ${marker.pane.id} (${marker.pane.paneId})`,
      `  reason: ${marker.reason}`,
      `  ${marker.operatorInstructions}`,
    ].join('\n'));
  }
  return 2;
}

async function handleDoctorCli(): Promise<number> {
  const args = process.argv.slice(3);
  const result = await runTmuxDoctor({
    fix: args.includes('--fix'),
  });

  if (args.includes('--json')) {
    console.log(formatTmuxDoctorJson(result));
  } else {
    console.log(formatTmuxDoctorText(result));
  }

  return getTmuxDoctorExitCode(result);
}

async function handleRemotePaneActionCli(shortcutArg: string): Promise<number> {
  if (!isRemotePaneActionShortcut(shortcutArg)) {
    showTmuxMessage(`Unsupported psyche pane action: ${shortcutArg}`);
    return 1;
  }

  const sessionName = getFocusedTmuxSessionName();
  const targetPaneId = getFocusedTmuxPaneId();

  if (!sessionName || !targetPaneId) {
    showTmuxMessage('psyche remote pane actions require an active tmux pane');
    return 1;
  }

  const controllerPid = getTmuxSessionOption(sessionName, PSYCHE_CONTROLLER_PID_OPTION);
  if (!controllerPid || !/^\d+$/.test(controllerPid)) {
    showTmuxMessage('No active psyche controller found for this session');
    return 1;
  }

  const controlPaneId = getTmuxSessionOption(sessionName, PSYCHE_CONTROL_PANE_OPTION);
  if (controlPaneId && controlPaneId === targetPaneId) {
    showTmuxMessage('Focused pane is already the psyche control pane');
    return 1;
  }

  try {
    process.kill(Number(controllerPid), 0);
  } catch {
    showTmuxMessage('The psyche controller for this session is not running');
    return 1;
  }

  try {
    await enqueueRemotePaneAction(sessionName, targetPaneId, shortcutArg);
    process.kill(Number(controllerPid), 'SIGUSR2');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showTmuxMessage(`Failed to queue psyche pane action: ${message}`);
    return 1;
  }
}

class Psyche {
  private panesFile: string;
  private settingsFile: string;
  private projectName: string;
  private sessionName: string;
  private projectRoot: string;
  private autoUpdater: AutoUpdater;
  private stateManager: StateManager;
  private bridgeDaemon?: BridgeDaemon;

  constructor() {
    // Get git root directory to determine project scope
    // NOTE: No caching - must be re-evaluated per instance to support multiple projects
    this.projectRoot = this.getProjectRoot();
    // Get project name from git root directory
    this.projectName = path.basename(this.projectRoot);

    // Create a stable, collision-safe session name for this project root
    this.sessionName = this.buildSessionNameForRoot(this.projectRoot);

    // Store config in .psyche directory inside project root
    const psycheDir = path.join(this.projectRoot, '.psyche');
    const configFile = path.join(psycheDir, 'psyche.config.json');

    // Always use the .psyche directory config location
    this.panesFile = configFile;
    this.settingsFile = configFile; // Same file for all config

    // Initialize auto-updater with config file
    this.autoUpdater = new AutoUpdater(configFile);

    // Initialize state manager
    this.stateManager = StateManager.getInstance();
  }

  async init() {
    // Set up global signal handlers for clean exit
    this.setupGlobalSignalHandlers();

    // Surface leftover comux state. Nothing is migrated; this only makes the
    // clean break visible instead of letting hooks silently stop firing.
    this.warnAboutLegacyComuxState();

    // Ensure .psyche directory exists and is in .gitignore
    await this.ensurePsycheDirectory();

    // First-run onboarding (tmux config + OpenRouter API key)
    await runFirstRunOnboardingIfNeeded();

    // The shared pane/settings registry is initialized through the same
    // cross-process lease used by the daemon and TUI mutations. A corrupt or
    // unreadable file deliberately aborts startup rather than being replaced.
    await mutateProjectPaneConfig(this.projectRoot, (config) => {
      config.projectName ??= this.projectName;
      config.projectRoot ??= this.projectRoot;
      config.panes ??= [];
      config.sidebarProjects ??= [{
        projectName: this.projectName,
        projectRoot: this.projectRoot,
      }];
      config.lastUpdated ??= new Date().toISOString();
      config.controlPaneSize ??= SIDEBAR_WIDTH;
    });

    const inTmux = process.env.TMUX !== undefined;
    const isDev = process.env.PSYCHE_DEV === 'true';
    const isDevWatch = process.env.PSYCHE_DEV_WATCH === 'true';
    const currentTmuxSessionName = inTmux
      ? this.getCurrentTmuxSessionName()
      : null;
    const sessionNameForCurrentTmux = currentTmuxSessionName || this.sessionName;

    if (inTmux) {
      ensureTmuxRuntimeCompatibility(sessionNameForCurrentTmux);
    }

    // Running psyche from another project while already inside a psyche session:
    // offer to attach this project to the current sidebar/session instead.
    if (
      inTmux &&
      currentTmuxSessionName &&
      currentTmuxSessionName.startsWith('psyche-') &&
      currentTmuxSessionName !== this.sessionName
    ) {
      const shouldAttachToCurrent = await this.promptYesNo(
        `Detected active psyche session '${currentTmuxSessionName}'. Add project '${this.projectName}' to this session's sidebar?`,
        true
      );

      if (shouldAttachToCurrent) {
        const attached = await this.attachProjectToExistingSession(currentTmuxSessionName);
        if (attached) {
          return;
        }
      }
    }

    // If launched with `pnpm dev` from inside tmux, transparently upgrade this pane
    // to watch mode so source changes apply without manual relaunches.
    if (inTmux && isDev && !isDevWatch) {
      try {
        const tmuxService = TmuxService.getInstance();
        const currentPaneId = await tmuxService.getCurrentPaneId();
        const preferredControlPaneId =
          this.resolveDevControlPane(sessionNameForCurrentTmux) || undefined;
        const targetPaneId = preferredControlPaneId || currentPaneId;
        const devDirectory = this.isWorktree() ? process.cwd() : this.projectRoot;
        const devCommand = buildDevWatchRespawnCommand(devDirectory);
        const escapedDevCommand = devCommand.replace(/'/g, "'\\''");
        execSync(
          `tmux respawn-pane -k -t '${targetPaneId}' '${escapedDevCommand}'`,
          { stdio: 'pipe' }
        );
        return;
      } catch {
        // If promotion fails, continue with current process so dev is still usable.
      }
    }

    // Check for updates in background if needed
    this.checkForUpdatesBackground();

    // Set up hooks for this session (if in tmux)
    if (inTmux) {
      this.setupResizeHook(sessionNameForCurrentTmux);
      this.setupPaneSplitHook(sessionNameForCurrentTmux);
      this.setupPaneFocusHook(sessionNameForCurrentTmux);
    }

    if (!inTmux) {
      // Check if project-specific session already exists
      let sessionExists = false;
      // In dev mode, use current directory if we're in a worktree, otherwise use projectRoot
      let devDirectory = this.projectRoot;
      if (isDev && this.isWorktree()) {
        devDirectory = process.cwd();
      }

      try {
        execSync(`tmux has-session -t ${this.sessionName} 2>/dev/null`, { stdio: 'pipe' });
        sessionExists = true;
      } catch {
        sessionExists = false;
      }

      if (sessionExists) {
        ensureTmuxRuntimeCompatibility(this.sessionName);
        this.applySessionPaneBorderOptions(this.sessionName, 'pipe');
        // Existing session:
        // In dev mode, always ensure watcher loop is running from the intended source.
        if (isDev) {
          try {
            const targetPane = this.resolveDevControlPane(this.sessionName);
            if (targetPane) {
              const devCommand = buildDevWatchRespawnCommand(devDirectory);
              const escapedDevCommand = devCommand.replace(/'/g, "'\\''");
              execSync(
                `tmux respawn-pane -k -t '${targetPane}' '${escapedDevCommand}'`,
                { stdio: 'pipe' }
              );
            }
          } catch {
            // Best effort - if respawn fails, still attach.
          }
        }
      } else {
        // Expected - session doesn't exist, create new one
        // Create new session first
        execSync(`tmux new-session -d -s ${this.sessionName}`, { stdio: 'inherit' });
        ensureTmuxRuntimeCompatibility(this.sessionName);
        // Batch all session configuration commands into a single tmux call for faster startup
        // This reduces 5 process spawns to 1, significantly improving startup time
        this.applySessionPaneBorderOptions(this.sessionName, 'inherit');
        execSync(`tmux select-pane -t ${this.sessionName} -T "psyche"`, { stdio: 'inherit' });
        // Send psyche command to the new session (use dev command if in dev mode)
        // Determine the psyche command to use
        let psycheCommand: string;
        if (isDev) {
          psycheCommand = buildDevWatchCommand(devDirectory);
        } else {
          // Check if we're running from a local installation
          // __dirname is 'dist' when compiled, so '../psyche' points to the wrapper
          const localPsychePath = path.join(__dirname, '..', 'psyche');
          if (fsSync.existsSync(localPsychePath)) {
            // Use absolute path to local psyche (works for both local builds and global installs)
            psycheCommand = `"${localPsychePath}"`;
          } else {
            // Fallback to global psyche command
            psycheCommand = 'psyche';
          }
        }

        sendTmuxShellCommand(this.sessionName, psycheCommand, 'inherit');
      }
      execSync(`tmux attach-session -t ${this.sessionName}`, { stdio: 'inherit' });
      return;
    }

    // Enable pane borders to show titles
    // NOTE: Temporarily disabled to test if border updates cause UI shifts
    // try {
    //   execSync(`tmux set-option pane-border-status top`, { stdio: 'pipe' });
    // } catch {
    //   // Ignore if it fails
    // }

    // Set pane title for the current pane running psyche
    // TODO(future): Re-enable control pane title once UI shift issue is resolved
    // Setting the title can cause visual artifacts in some tmux configurations
    // Original code: execSync(`tmux select-pane -T "psyche v${version} - ${project}"`)
    // See: Title updates are currently handled by enforcePaneTitles() in usePaneSync.ts

    try {
      const activeSessionName = this.getCurrentTmuxSessionName() || this.sessionName;
      this.applySessionPaneBorderOptions(activeSessionName, 'pipe');
    } catch {
      // Best effort - psyche still works without reapplying border format here.
    }

    // Get current pane ID (control pane for left sidebar)
    let controlPaneId: string | undefined;

    try {
      // Get current pane ID
      const tmuxService = TmuxService.getInstance();
      controlPaneId = await tmuxService.getCurrentPaneId();

      // Read the shared registry without a write side effect. Every mutation
      // below targets only the field it owns through ProjectPaneConfig.
      const config = await readProjectPaneConfig(this.projectRoot) as any;

      // Ensure panes array exists
      if (!config.panes) {
        config.panes = [];
      }

      const oldControlPaneId = config.controlPaneId;
      const sessionPaneIds = execSync(
        `tmux list-panes -t '${sessionNameForCurrentTmux}' -F "#{pane_id}"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      )
        .split('\n')
        .map((paneId: string) => paneId.trim())
        .filter(Boolean);

      // Preserve an existing valid control pane ID when psyche is launched from a non-control pane.
      // This prevents nested psyche UIs from accidentally hijacking control-pane ownership.
      const preservedControlPaneId =
        typeof oldControlPaneId === 'string' && sessionPaneIds.includes(oldControlPaneId)
          ? oldControlPaneId
          : undefined;
      const nextControlPaneId = preservedControlPaneId || controlPaneId;
      const needsUpdate = oldControlPaneId !== nextControlPaneId;

      if (needsUpdate) {
        if (oldControlPaneId) {
          LogService.getInstance().info(
            `Control pane ID changed: ${oldControlPaneId} → ${nextControlPaneId}`,
            'Setup'
          );
        } else {
          LogService.getInstance().info(
            `Setting initial control pane ID: ${nextControlPaneId}`,
            'Setup'
          );
        }
      }

      controlPaneId = nextControlPaneId;
      config.controlPaneId = nextControlPaneId;
      config.controlPaneSize = SIDEBAR_WIDTH;

      // If this is initial load or control pane changed, resize the sidebar
      if (needsUpdate) {
        // Resize control pane to sidebar width
        await tmuxService.resizePane(controlPaneId, { width: SIDEBAR_WIDTH });
        // Refresh client
        await tmuxService.refreshClient();
        await mutateProjectPaneConfig(this.projectRoot, (freshConfig) => {
          freshConfig.controlPaneId = nextControlPaneId;
          freshConfig.controlPaneSize = SIDEBAR_WIDTH;
          freshConfig.lastUpdated = new Date().toISOString();
        });
      }

      // Create welcome pane if there are no psyche panes and no existing welcome pane
      // Check if welcome pane actually exists, not just if it's in config (handles tmux restarts)
      const { welcomePaneExists } = await import('./utils/welcomePane.js');
      const normalizePathForComparison = (candidatePath?: string): string | null => {
        if (!candidatePath) return null;

        const resolvedPath = path.resolve(candidatePath);
        try {
          return fsSync.realpathSync(resolvedPath);
        } catch {
          return resolvedPath;
        }
      };
      const normalizedProjectRoot = normalizePathForComparison(this.projectRoot);
      const isProjectRootPath = (candidatePath?: string): boolean => {
        const normalizedCandidatePath = normalizePathForComparison(candidatePath);
        return !!normalizedProjectRoot &&
          !!normalizedCandidatePath &&
          normalizedCandidatePath === normalizedProjectRoot;
      };
      const getPaneCurrentPath = (paneId: string): string | undefined => {
        try {
          const escapedPaneId = paneId.replace(/'/g, "'\\''");
          const panePath = execSync(
            `tmux display-message -t '${escapedPaneId}' -p '#{pane_current_path}'`,
            { encoding: 'utf-8', stdio: 'pipe' }
          ).trim();

          return panePath || undefined;
        } catch {
          return undefined;
        }
      };

      // Validate welcome pane existence
      let hasValidWelcomePane = false;
      if (config.welcomePaneId) {
        hasValidWelcomePane = await welcomePaneExists(config.welcomePaneId);

        if (hasValidWelcomePane) {
          const trackedWelcomePanePath = getPaneCurrentPath(config.welcomePaneId);
          if (!isProjectRootPath(trackedWelcomePanePath)) {
            LogService.getInstance().warn(
              `Welcome pane ${config.welcomePaneId} has stale cwd '${trackedWelcomePanePath ?? 'unknown'}'; recreating`,
              'Setup'
            );
            await destroyWelcomePane(config.welcomePaneId);
            hasValidWelcomePane = false;
          }
        }

        if (!hasValidWelcomePane) {
          LogService.getInstance().info(
            `Welcome pane ${config.welcomePaneId} no longer exists, will create new one`,
            'Setup'
          );
          // Clear stale welcome pane ID from config
          const staleWelcomePaneId = config.welcomePaneId;
          config.welcomePaneId = undefined;
          await mutateProjectPaneConfig(this.projectRoot, (freshConfig) => {
            if (freshConfig.welcomePaneId !== staleWelcomePaneId) {
              return;
            }
            freshConfig.welcomePaneId = undefined;
            freshConfig.lastUpdated = new Date().toISOString();
          });
          LogService.getInstance().debug(
            `Cleared stale welcome pane ID ${staleWelcomePaneId} from config`,
            'Setup'
          );
        } else {
          LogService.getInstance().debug(
            `Welcome pane ${config.welcomePaneId} exists`,
            'Setup'
          );
        }
      }

      // Recovery + dedupe:
      // If a welcome pane exists in tmux but config is stale/missing, adopt it.
      // If multiple welcome panes exist, keep one and remove extras.
      let welcomePaneIdsInSession: string[] = [];
      try {
        const escapedSessionName = sessionNameForCurrentTmux.replace(/'/g, "'\\''");
        const paneInfoOutput = execSync(
          `tmux list-panes -t '${escapedSessionName}' -F "#{pane_id}::#{pane_title}::#{pane_current_path}"`,
          { encoding: 'utf-8', stdio: 'pipe' }
        ).trim();

        if (paneInfoOutput) {
          const welcomePanesInSession = paneInfoOutput
            .split('\n')
            .map((line: string) => {
              const [paneId, paneTitle, panePath] = line.split('::');
              return { paneId, paneTitle, panePath };
            })
            .filter(({ paneId, paneTitle }) =>
              !!paneId &&
              paneTitle === 'Welcome' &&
              paneId !== controlPaneId
            );

          const staleWelcomePanes = welcomePanesInSession
            .filter(({ panePath }) => !isProjectRootPath(panePath));
          for (const stalePane of staleWelcomePanes) {
            await destroyWelcomePane(stalePane.paneId);
          }

          if (staleWelcomePanes.length > 0) {
            LogService.getInstance().warn(
              `Discarded ${staleWelcomePanes.length} stale welcome pane(s) with non-root cwd`,
              'Setup'
            );
          }

          welcomePaneIdsInSession = welcomePanesInSession
            .filter(({ panePath }) => isProjectRootPath(panePath))
            .map(({ paneId }) => paneId);
        }
      } catch {
        // Ignore detection failures - normal startup logic below remains safe.
      }

      if (!hasValidWelcomePane && welcomePaneIdsInSession.length > 0) {
        const recoveredWelcomePaneId = welcomePaneIdsInSession[0];
        const recovered = await mutateProjectPaneConfig(
          this.projectRoot,
          (freshConfig) => {
            if (freshConfig.welcomePaneId) {
              return false;
            }
            freshConfig.welcomePaneId = recoveredWelcomePaneId;
            freshConfig.lastUpdated = new Date().toISOString();
            return true;
          },
        );
        if (recovered.result) {
          config.welcomePaneId = recoveredWelcomePaneId;
          hasValidWelcomePane = true;
          LogService.getInstance().warn(
            `Recovered untracked welcome pane ${recoveredWelcomePaneId} from tmux state`,
            'Setup'
          );
        }
      }

      if (hasValidWelcomePane && config.welcomePaneId) {
        const duplicateWelcomePaneIds = welcomePaneIdsInSession
          .filter((paneId) => paneId !== config.welcomePaneId);

        if (duplicateWelcomePaneIds.length > 0) {
          LogService.getInstance().warn(
            `Detected ${duplicateWelcomePaneIds.length} duplicate welcome pane(s), cleaning up`,
            'Setup'
          );
          for (const duplicatePaneId of duplicateWelcomePaneIds) {
            await destroyWelcomePane(duplicatePaneId);
          }
        }
      }

      // Check for untracked panes (terminal panes created outside psyche tracking)
      const trackedPaneIds = config.panes?.map((p: any) => p.paneId) ?? [];
      const untrackedPanes = await getUntrackedPanes(
        sessionNameForCurrentTmux,
        trackedPaneIds,
        controlPaneId,
        config.welcomePaneId
      );

      // Only show welcome pane if there are no tracked AND no untracked panes
      const hasAnyPanes = (config.panes?.length ?? 0) > 0 || untrackedPanes.length > 0;

      if (controlPaneId && !hasAnyPanes) {
        if (!hasValidWelcomePane) {
          // Create new welcome pane
          const welcomePaneId = await createWelcomePane(controlPaneId, this.projectRoot);
          if (welcomePaneId) {
            const persisted = await mutateProjectPaneConfig(
              this.projectRoot,
              (freshConfig) => {
                if (freshConfig.welcomePaneId) {
                  return false;
                }
                freshConfig.welcomePaneId = welcomePaneId;
                freshConfig.lastUpdated = new Date().toISOString();
                return true;
              },
            );
            if (persisted.result) {
              config.welcomePaneId = welcomePaneId;
              LogService.getInstance().info(`Created welcome pane: ${welcomePaneId}`, 'Setup');
            } else {
              await destroyWelcomePane(welcomePaneId);
            }
          }
        } else {
          // Welcome pane exists from previous session - fix the layout
          LogService.getInstance().debug('Welcome pane exists, applying correct layout', 'Setup');

          // Apply correct layout: sidebar (40) | welcome pane (rest)
          // Use "latest" mode so window auto-follows terminal size
          // Batch layout commands into single tmux call for better performance
          execSync(`tmux set-window-option window-size latest \\; set-window-option main-pane-width ${SIDEBAR_WIDTH} \\; select-layout main-vertical`, { stdio: 'pipe' });
          await tmuxService.refreshClient();
        }
      } else if (hasValidWelcomePane && hasAnyPanes) {
        // If welcome pane exists but there are other panes, destroy it
        LogService.getInstance().info('Destroying welcome pane because other panes exist', 'Setup');
        await destroyWelcomePane(config.welcomePaneId);
        const destroyedWelcomePaneId = config.welcomePaneId;
        config.welcomePaneId = undefined;
        await mutateProjectPaneConfig(this.projectRoot, (freshConfig) => {
          if (freshConfig.welcomePaneId !== destroyedWelcomePaneId) {
            return;
          }
          freshConfig.welcomePaneId = undefined;
          freshConfig.lastUpdated = new Date().toISOString();
        });
      }
    } catch (error) {
      // Ignore errors in sidebar setup - will work without it
      LogService.getInstance().error('Failed to set up sidebar layout', 'Setup', undefined, error instanceof Error ? error : undefined);
    }

    const metadataSessionName = currentTmuxSessionName || this.getCurrentTmuxSessionName() || this.sessionName;
    const shouldPublishMetadata =
      !metadataSessionName.startsWith('psyche-') || metadataSessionName === this.sessionName;
    if (shouldPublishMetadata) {
      this.publishSessionMetadata(metadataSessionName, controlPaneId);
      this.clearRemotePaneModeIndicators(metadataSessionName);
      this.setupRemotePaneActionBindings(metadataSessionName);
      await clearRemotePaneActions(metadataSessionName);
    }

    // Update state manager with project info
    this.stateManager.updateProjectInfo(this.projectName, this.sessionName, this.projectRoot, this.panesFile);

    // Start the bridge daemon so iOS/macOS clients can connect to this TUI session.
    // paneProvider and projectProvider are lazy: they read live state on each call.
    try {
      const workspaceProvider = createTuiWorkspaceProvider({
        primaryProjectRoot: this.projectRoot,
        primaryProjectName: this.projectName,
        panes: () => this.stateManager.getPanes(),
        covenSessionsByProject: () => groupCovenSessionsByProject(
          this.stateManager.getCovenSessions(),
        ),
        sidebarProjects: async () => {
          const rawConfig = await fs.readFile(this.panesFile, 'utf8');
          const config = JSON.parse(rawConfig) as Partial<PsycheConfig>;
          return normalizeSidebarProjects(
            config.sidebarProjects,
            this.stateManager.getPanes(),
            this.projectRoot,
            this.projectName,
          );
        },
        onWorktreeReadError: (projectRoot, error) => {
          LogService.getInstance().warn(
            `mobile workspace could not read worktrees for ${projectRoot}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'BridgeDaemon',
          );
        },
      });

      this.bridgeDaemon = new BridgeDaemon({
        serverName: os.hostname(),
        projectName: this.projectName || null,
        sessionName: tmuxSessionNameForRoot(this.projectRoot),
        workspaceProvider,
        paneProvider: (): PaneSnapshot[] => {
          return this.stateManager.getPanes().map((p: PsychePane): PaneSnapshot => {
            let status: PaneSnapshot['status'];
            switch (p.agentStatus) {
              case 'working':
              case 'analyzing':
                status = 'working';
                break;
              case 'idle':
                status = 'idle';
                break;
              case 'waiting':
                status = 'waiting';
                break;
              default:
                status = 'unknown';
            }
            return {
              id: p.paneId,
              displayName: p.displayName ?? p.slug ?? p.id,
              kind: p.type ?? 'worktree',
              projectId: p.projectRoot ?? null,
              projectName: p.projectName ?? null,
              worktreePath: p.worktreePath ?? null,
              agent: p.agent ?? null,
              status,
            };
          });
        },
        projectProvider: (): Project[] => {
          const panes = this.stateManager.getPanes();
          const projectMap = new Map<string, { displayName: string; attentionCount: number }>();

          // Seed with the primary project so it appears even when there are no panes yet.
          if (this.projectRoot) {
            projectMap.set(this.projectRoot, {
              displayName: this.projectName,
              attentionCount: 0,
            });
          }

          for (const p of panes) {
            const projId = p.projectRoot ?? this.projectRoot;
            if (!projId) continue;
            const existing = projectMap.get(projId);
            const attention = p.needsAttention ? 1 : 0;
            if (existing) {
              existing.attentionCount += attention;
            } else {
              projectMap.set(projId, {
                displayName: p.projectName ?? path.basename(projId),
                attentionCount: attention,
              });
            }
          }

          return Array.from(projectMap.entries()).map(([id, meta]): Project => ({
            id,
            displayName: meta.displayName,
            attentionCount: meta.attentionCount,
          }));
        },
        ritualProvider: (projectId): Ritual[] => {
          // Resolve the project root: use projectId if it looks like a known
          // project path, otherwise fall back to the session's primary root.
          const projectRoot = (projectId && projectId.trim()) ? projectId : this.projectRoot;
          return listAvailableRituals(projectRoot).map((ritual): Ritual => ({
            id: ritual.id,
            displayName: ritual.name,
            description: ritual.description ?? null,
            scope: ritual.scope === 'builtin' ? 'builtIn' : 'project',
            projectId: ritual.scope === 'builtin' ? null : projectRoot,
          }));
        },
        launchRitual: async () => { throw new Error("psyche UI not ready — try again in a moment"); },
      });

      const { port, fingerprint } = await this.bridgeDaemon.start();
      LogService.getInstance().info(
        `bridge listening on wss://0.0.0.0:${port} (fp ${fingerprint.slice(0, 17)}…)`,
        'BridgeDaemon'
      );
    } catch (err) {
      LogService.getInstance().warn(
        `bridge daemon failed to start: ${err instanceof Error ? err.message : String(err)}`,
        'BridgeDaemon'
      );
    }

    // Logging system is ready (removed debug logs to reduce clutter)

    // Suppress console output from LogService to prevent interference with Ink UI
    LogService.getInstance().setSuppressConsole(true);

    // Clear screen before launching Ink - minimal clearing to avoid artifacts
    // Don't use \x1b[3J as it can cause layout shifts
    process.stdout.write('\x1b[2J\x1b[H');  // Clear screen and move cursor to home

    // Ensure cursor is truly at home position and scrollback is clear
    process.stdout.write('\x1b[1;1H');  // Force cursor to row 1, column 1

    // Launch the Ink app
    const appProps = {
      panesFile: this.panesFile,
      settingsFile: this.settingsFile,
      projectName: this.projectName,
      sessionName: this.sessionName,
      projectRoot: this.projectRoot,
      autoUpdater: this.autoUpdater,
      controlPaneId,
      bridgeDaemon: this.bridgeDaemon,
    };

    const app = render(React.createElement(PsycheApp, appProps), {
      exitOnCtrlC: false  // Disable automatic exit on Ctrl+C
    });

    // Clean shutdown on app exit
    app.waitUntilExit().then(async () => {
      process.exit(0);
    });
  }

  private buildSessionNameForRoot(projectRoot: string): string {
    const projectName = path.basename(projectRoot);
    const projectHash = createHash('md5').update(projectRoot).digest('hex').substring(0, 8);
    const projectIdentifier = `${projectName}-${projectHash}`;
    const sanitizedProjectIdentifier = projectIdentifier.replace(/\./g, '-');
    return `psyche-${sanitizedProjectIdentifier}`;
  }

  private getCurrentTmuxSessionName(): string | null {
    try {
      const result = spawnSync('tmux', ['display-message', '-p', '#S'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) return null;
      const sessionName = (result.stdout || '').trim();
      return sessionName || null;
    } catch {
      return null;
    }
  }

  private resolveDevControlPane(sessionName: string): string | null {
    // Prefer tracked control pane from config when available.
    try {
      if (fsSync.existsSync(this.panesFile)) {
        const rawConfig = fsSync.readFileSync(this.panesFile, 'utf-8');
        const parsedConfig = JSON.parse(rawConfig);
        const trackedControlPane = parsedConfig?.controlPaneId;
        if (typeof trackedControlPane === 'string' && trackedControlPane) {
          const paneListResult = spawnSync(
            'tmux',
            ['list-panes', '-t', sessionName, '-F', '#{pane_id}'],
            { encoding: 'utf-8', stdio: 'pipe' }
          );
          if (paneListResult.status === 0) {
            const paneIds = (paneListResult.stdout || '')
              .split('\n')
              .map((id) => id.trim())
              .filter(Boolean);
            if (paneIds.includes(trackedControlPane)) {
              return trackedControlPane;
            }
          }
        }
      }
    } catch {
      // Fall through to first-pane fallback.
    }

    // Fallback: first pane in the target session.
    try {
      const firstPaneResult = spawnSync(
        'tmux',
        ['list-panes', '-t', sessionName, '-F', '#{pane_id}'],
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      if (firstPaneResult.status !== 0) return null;
      const firstPane = (firstPaneResult.stdout || '')
        .split('\n')
        .map((id) => id.trim())
        .find(Boolean);
      return firstPane || null;
    } catch {
      return null;
    }
  }

  private getTmuxOptionValue(sessionName: string, optionName: string): string | null {
    try {
      const result = spawnSync('tmux', ['show-options', '-v', '-t', sessionName, optionName], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (result.status !== 0) return null;
      const value = (result.stdout || '').trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private publishSessionMetadata(sessionName: string, controlPaneId?: string): void {
    try {
      spawnSync('tmux', ['set-option', '-t', sessionName, '@psyche_project_root', this.projectRoot], { stdio: 'pipe' });
      spawnSync('tmux', ['set-option', '-t', sessionName, '@psyche_project_name', this.projectName], { stdio: 'pipe' });
      spawnSync('tmux', ['set-option', '-t', sessionName, '@psyche_config_path', this.panesFile], { stdio: 'pipe' });
      spawnSync('tmux', ['set-option', '-t', sessionName, PSYCHE_CONTROLLER_PID_OPTION, String(process.pid)], { stdio: 'pipe' });
      if (controlPaneId) {
        spawnSync('tmux', ['set-option', '-t', sessionName, PSYCHE_CONTROL_PANE_OPTION, controlPaneId], { stdio: 'pipe' });
      }
    } catch {
      // Metadata is best-effort only
    }
  }

  private cleanupSessionRuntimeMetadata(
    sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName
  ) {
    try {
      const activeControllerPid = this.getTmuxOptionValue(sessionName, PSYCHE_CONTROLLER_PID_OPTION);
      if (activeControllerPid !== String(process.pid)) {
        return;
      }

      spawnSync('tmux', ['set-option', '-u', '-t', sessionName, PSYCHE_CONTROLLER_PID_OPTION], { stdio: 'pipe' });
      spawnSync('tmux', ['set-option', '-u', '-t', sessionName, PSYCHE_CONTROL_PANE_OPTION], { stdio: 'pipe' });
    } catch {
      // Metadata cleanup is best-effort only.
    }
  }

  private setupRemotePaneActionBindings(
    sessionName: string = this.sessionName
  ) {
    try {
      try {
        for (const args of buildRemotePaneActionCleanupCommandArgs()) {
          spawnSync('tmux', args, { stdio: 'pipe' });
        }
      } catch {
        // Ignore stale binding cleanup errors during setup.
      }

      for (const args of buildRemotePaneActionBindingCommandArgs()) {
        const result = spawnSync('tmux', args, { stdio: 'pipe' });
        if (result.status !== 0) {
          throw new Error('tmux binding failed');
        }
      }
    } catch {
      LogService.getInstance().warn('Failed to set up remote pane action bindings', 'Setup');
    }
  }

  private clearRemotePaneModeIndicators(
    sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName
  ) {
    try {
      const paneListResult = spawnSync(
        'tmux',
        ['list-panes', '-t', sessionName, '-F', '#{pane_id}'],
        {
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      );
      if (paneListResult.status !== 0) {
        return;
      }

      const paneIds = (paneListResult.stdout || '')
        .split('\n')
        .map((paneId) => paneId.trim())
        .filter(Boolean);

      for (const paneId of paneIds) {
        spawnSync(
          'tmux',
          ['set-option', '-u', '-p', '-t', paneId, PSYCHE_REMOTE_PANE_MODE_OPTION],
          { stdio: 'pipe' }
        );
      }
    } catch {
      // Best effort only.
    }
  }

  private cleanupRemotePaneActionBindings(
    sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName
  ) {
    try {
      const activeControllerPid = this.getTmuxOptionValue(sessionName, PSYCHE_CONTROLLER_PID_OPTION);
      if (activeControllerPid !== String(process.pid)) {
        return;
      }

      const sessionListResult = spawnSync(
        'tmux',
        ['list-sessions', '-F', '#{session_name}'],
        {
          encoding: 'utf-8',
          stdio: 'pipe',
        }
      );
      if (sessionListResult.status === 0) {
        const otherControllerExists = (sessionListResult.stdout || '')
          .split('\n')
          .map((name) => name.trim())
          .filter(Boolean)
          .some((name) =>
            name !== sessionName
            && this.getTmuxOptionValue(name, PSYCHE_CONTROLLER_PID_OPTION) !== null
          );
        if (otherControllerExists) {
          return;
        }
      }

      for (const args of buildRemotePaneActionCleanupCommandArgs()) {
        spawnSync('tmux', args, { stdio: 'pipe' });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private async promptYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return false;
    }

    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (!answer) return defaultYes;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      return defaultYes;
    } finally {
      rl.close();
    }
  }

  private getAncestorPaths(startPath: string): string[] {
    const ancestors: string[] = [];
    let cursor = path.resolve(startPath);

    while (true) {
      ancestors.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }

    return ancestors;
  }

  private inferSessionContextFromPanePaths(sessionName: string): ExistingSessionContext | null {
    try {
      const listResult = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_current_path}'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      if (listResult.status !== 0) {
        return null;
      }

      const panePaths = (listResult.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const seenRoots = new Set<string>();
      for (const panePath of panePaths) {
        for (const candidateRoot of this.getAncestorPaths(panePath)) {
          if (seenRoots.has(candidateRoot)) continue;
          seenRoots.add(candidateRoot);

          const configPath = path.join(candidateRoot, '.psyche', 'psyche.config.json');
          if (!fsSync.existsSync(configPath)) {
            continue;
          }

          if (this.buildSessionNameForRoot(candidateRoot) !== sessionName) {
            continue;
          }

          return {
            sessionName,
            sessionProjectRoot: candidateRoot,
            sessionProjectName: path.basename(candidateRoot),
            sessionConfigPath: configPath,
          };
        }
      }
    } catch {
      // Fall through to null
    }

    return null;
  }

  private getExistingSessionContext(sessionName: string): ExistingSessionContext | null {
    const optionProjectRoot = this.getTmuxOptionValue(sessionName, '@psyche_project_root');
    const optionProjectName = this.getTmuxOptionValue(sessionName, '@psyche_project_name');
    const optionConfigPath = this.getTmuxOptionValue(sessionName, '@psyche_config_path');

    const sessionProjectRoot =
      optionProjectRoot
      || (optionConfigPath ? path.dirname(path.dirname(optionConfigPath)) : undefined);
    const sessionConfigPath =
      optionConfigPath
      || (sessionProjectRoot ? path.join(sessionProjectRoot, '.psyche', 'psyche.config.json') : undefined);

    if (
      sessionProjectRoot &&
      sessionConfigPath &&
      fsSync.existsSync(sessionConfigPath)
    ) {
      return {
        sessionName,
        sessionProjectRoot,
        sessionProjectName: optionProjectName || path.basename(sessionProjectRoot),
        sessionConfigPath,
      };
    }

    return this.inferSessionContextFromPanePaths(sessionName);
  }

  private async attachProjectToExistingSession(sessionName: string): Promise<boolean> {
    const context = this.getExistingSessionContext(sessionName);
    if (!context) {
      console.log(chalk.yellow(
        `Unable to locate config for session '${sessionName}'. Run psyche inside that project once, then try again.`
      ));
      return false;
    }

    if (path.resolve(context.sessionProjectRoot) === path.resolve(this.projectRoot)) {
      return false;
    }

    try {
      const mutation = await mutateProjectPaneConfig(
        context.sessionProjectRoot,
        (configRecord) => {
          const latestConfig = configRecord as unknown as PsycheConfig;
          const latestPanes = Array.isArray(latestConfig.panes) ? latestConfig.panes : [];
          const normalizedProjects = normalizeSidebarProjects(
            latestConfig.sidebarProjects,
            latestPanes,
            context.sessionProjectRoot,
            context.sessionProjectName
          );
          if (hasSidebarProject(normalizedProjects, this.projectRoot)) {
            return false;
          }

          latestConfig.sidebarProjects = addSidebarProject(normalizedProjects, {
            projectName: this.projectName,
            projectRoot: this.projectRoot,
            colorTheme: getAutoSidebarProjectColorTheme(
              normalizedProjects,
              {
                projectRoot: this.projectRoot,
              },
              (targetProjectRoot) =>
                getSidebarProjectColorTheme(normalizedProjects, targetProjectRoot)
                || new SettingsManager(targetProjectRoot).getSettings().colorTheme
            ),
            colorThemeSource: 'auto',
          });
          latestConfig.lastUpdated = new Date().toISOString();
          return true;
        }
      );
      if (!mutation.result) {
        console.log(chalk.yellow(
          `Project '${this.projectName}' is already in session '${sessionName}'.`
        ));
        return true;
      }

      console.log(chalk.hex(COLORS.success)(
        `Added project '${this.projectName}' to session '${sessionName}' sidebar.`
      ));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Failed to add project '${this.projectName}': ${message}`));
      return false;
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      // Expected - file doesn't exist
      return false;
    }
  }

  private isWorktree(): boolean {
    try {
      // Check if current directory is different from project root
      const cwd = process.cwd();
      if (cwd === this.projectRoot) {
        return false;
      }

      // Check if we're in a git worktree by checking if .git is a file (not a directory)
      const gitPath = path.join(cwd, '.git');
      if (fsSync.existsSync(gitPath)) {
        const stats = fsSync.statSync(gitPath);
        // In a worktree, .git is a file, not a directory
        return stats.isFile();
      }

      return false;
    } catch {
      // Expected - errors during git/file checks
      return false;
    }
  }

  private getProjectRoot(): string {
    try {
      // First, try to get the main worktree if we're in a git repository
      // This ensures we always use the main repository root, even when run from a worktree
      const worktreeList = execSync('git worktree list --porcelain', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();

      // The first line contains the main worktree path
      const mainWorktreeLine = worktreeList.split('\n')[0];
      if (mainWorktreeLine && mainWorktreeLine.startsWith('worktree ')) {
        const mainWorktreePath = mainWorktreeLine.substring(9).trim();
        return mainWorktreePath;
      }

      // Fallback to git rev-parse if worktree list fails
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        stdio: 'pipe'
      }).trim();
      return gitRoot;
    } catch {
      // Fallback to current directory if not in a git repo
      return process.cwd();
    }
  }

  private warnAboutLegacyComuxState() {
    const findings = detectLegacyComuxState({
      projectRoot: this.projectRoot,
      homeDir: process.env.HOME,
    });
    if (findings.length === 0) return;
    console.log(chalk.yellow(formatLegacyComuxWarning(findings)));
  }

  private async ensurePsycheDirectory() {
    const psycheDir = path.join(this.projectRoot, '.psyche');
    const worktreesDir = path.join(psycheDir, 'worktrees');
    const promptsDir = path.join(psycheDir, 'prompts');

    // Create .psyche directory if it doesn't exist
    if (!await this.fileExists(psycheDir)) {
      await fs.mkdir(psycheDir, { recursive: true });
    }

    // Create worktrees directory if it doesn't exist
    if (!await this.fileExists(worktreesDir)) {
      await fs.mkdir(worktreesDir, { recursive: true });
    }

    // Create prompts directory for file-backed initial agent prompts
    if (!await this.fileExists(promptsDir)) {
      await fs.mkdir(promptsDir, { recursive: true });
    }

    const { addedEntries } = ensurePsycheRuntimeIgnored(this.projectRoot);
    if (addedEntries.length > 0) {
      LogService.getInstance().debug(
        `Added ${addedEntries.join(', ')} to .gitignore`,
        'Setup'
      );
    }
  }

  private checkForUpdatesBackground() {
    // Run update check in background without blocking startup
    setImmediate(async () => {
      try {
        const shouldCheck = await this.autoUpdater.shouldCheckForUpdates();
        if (shouldCheck) {
          // Check for updates asynchronously
          this.autoUpdater.checkForUpdates().catch(() => {
            // Silently ignore update check failures
          });
        }
      } catch {
        // Silently ignore errors in background update check
      }
    });
  }

  async getUpdateInfo() {
    return await this.autoUpdater.checkForUpdates();
  }

  async performUpdate() {
    const updateInfo = await this.autoUpdater.checkForUpdates();
    return await this.autoUpdater.performUpdate(updateInfo);
  }

  async skipUpdate(version: string) {
    return await this.autoUpdater.skipVersion(version);
  }

  getAutoUpdater() {
    return this.autoUpdater;
  }

  private applySessionPaneBorderOptions(sessionName: string, stdio: 'pipe' | 'inherit' = 'pipe') {
    const sessionOptions = [
      `set-option -t ${sessionName} pane-border-status top`,
      `set-option -t ${sessionName} pane-border-format " #{?@psyche_attention,#[bold]![ready] #[default],}${TMUX_PANE_TITLE_PREFIX_FORMAT}${TMUX_PANE_TITLE_LABEL_FORMAT} "`,
      // Session-scoped mouse on so the Ink sidebar's click/dbl-click handlers
      // receive mouse events. Session-scoped (-t) means we don't touch the
      // user's global tmux preferences. ensureMouseMode() in PsycheApp also
      // tries to set this on mount, but that races with session creation —
      // applying it here guarantees it's on before the control pane spawns.
      `set-option -t ${sessionName} mouse on`,
    ].join(' \\; ');

    execSync(`tmux ${sessionOptions}`, { stdio });
    applyTmuxThemeToSession(sessionName, this.projectRoot);
  }

  private setupResizeHook(sessionName: string = this.sessionName) {
    try {
      // Set up session-specific hook that sends SIGUSR1 to psyche process on resize
      // This works inside tmux where normal SIGWINCH may not propagate
      const pid = process.pid;
      execSync(`tmux set-hook -t '${sessionName}' client-resized 'run-shell "kill -USR1 ${pid} 2>/dev/null || true"'`, { stdio: 'pipe' });
      // LogService.getInstance().debug(`Set up resize hook for session ${this.sessionName}`, 'Setup');
    } catch (error) {
      LogService.getInstance().warn('Failed to set up resize hook', 'Setup');
    }
  }

  private setupPaneSplitHook(sessionName: string = this.sessionName) {
    try {
      // Set up hooks that send SIGUSR2 to psyche process for pane events
      // This allows immediate detection of pane changes
      const pid = process.pid;
      const paneExitedHookCommand = buildPaneExitedHookCommandForSession(pid, sessionName);

      // Detect manually created panes via Ctrl+b %
      execSync(`tmux set-hook -t '${sessionName}' after-split-window 'run-shell "kill -USR2 ${pid} 2>/dev/null || true # psyche-hook"'`, { stdio: 'pipe' });

      // Detect pane closures via Ctrl+b x or process exit.
      // If the control pane is closed, this also recreates a replacement pane.
      execSync(`tmux set-hook -t '${sessionName}' pane-exited '${paneExitedHookCommand}'`, { stdio: 'pipe' });

      // LogService.getInstance().debug(`Set up pane detection hooks for session ${this.sessionName}`, 'Setup');
    } catch (error) {
      LogService.getInstance().warn('Failed to set up pane hooks', 'Setup');
    }
  }

  private setupPaneFocusHook(sessionName: string = this.sessionName) {
    try {
      const pid = process.pid;
      const paneFocusHookCommand = buildPaneFocusHookCommandForSession(
        sessionName,
        pid
      );
      execSync(
        `tmux set-hook -t '${sessionName}' after-select-pane '${paneFocusHookCommand}'`,
        { stdio: 'pipe' }
      );
    } catch (error) {
      LogService.getInstance().warn('Failed to set up pane focus hook', 'Setup');
    }
  }

  private cleanupResizeHook(sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName) {
    try {
      // Remove session-specific hook
      execSync(`tmux set-hook -u -t '${sessionName}' client-resized`, { stdio: 'pipe' });
      LogService.getInstance().debug('Cleaned up resize hook', 'Setup');
    } catch {
      // Ignore cleanup errors
    }
  }

  private cleanupPaneSplitHook(sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName) {
    try {
      // Remove pane hooks
      execSync(`tmux set-hook -u -t '${sessionName}' after-split-window`, { stdio: 'pipe' });
      execSync(`tmux set-hook -u -t '${sessionName}' pane-exited`, { stdio: 'pipe' });
      LogService.getInstance().debug('Cleaned up pane hooks', 'Setup');
    } catch {
      // Ignore cleanup errors
    }
  }

  private cleanupPaneFocusHook(sessionName: string = this.getCurrentTmuxSessionName() || this.sessionName) {
    try {
      execSync(`tmux set-hook -u -t '${sessionName}' after-select-pane`, { stdio: 'pipe' });
      LogService.getInstance().debug('Cleaned up pane focus hook', 'Setup');
    } catch {
      // Ignore cleanup errors
    }
  }

  private setupGlobalSignalHandlers() {
    let isCleaningUp = false;

    const cleanTerminalExit = (signal?: NodeJS.Signals) => {
      if (isCleaningUp) {
        return;
      }
      if (!claimProcessShutdown('signal-handler')) {
        return;
      }
      isCleaningUp = true;

      // Stop the bridge daemon (best-effort; fire-and-forget)
      if (this.bridgeDaemon) {
        this.bridgeDaemon.stop().catch(() => { /* ignore cleanup errors */ });
      }

      // Clean up hooks
      if (process.env.TMUX) {
        this.cleanupResizeHook();
        this.cleanupPaneSplitHook();
        this.cleanupPaneFocusHook();
        this.clearRemotePaneModeIndicators();
        this.cleanupRemotePaneActionBindings();
        this.cleanupSessionRuntimeMetadata();
      }

      if (shouldUseQuietDevWatchExit(signal)) {
        process.exit(0);
      }

      // Clear screen multiple times to ensure no artifacts
      process.stdout.write('\x1b[2J\x1b[H'); // Clear screen and move to home
      process.stdout.write('\x1b[3J'); // Clear scrollback buffer
      process.stdout.write('\n'.repeat(100)); // Push any remaining content off screen

      // Clear tmux pane if we're in tmux
      if (process.env.TMUX) {
        try {
          const tmuxService = TmuxService.getInstance();
          tmuxService.clearHistorySync();
        } catch {
          // Intentionally silent - cleanup is best-effort
        }
      }

      // Wait a moment for clearing to settle, then show goodbye message
      setTimeout(() => {
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write('\n\n  psyche session ended.\n\n');
        process.exit(0);
      }, 100);
    };

    // Handle Ctrl+C and SIGTERM
    process.on('SIGINT', () => {
      cleanTerminalExit('SIGINT');
    });
    process.on('SIGTERM', () => {
      cleanTerminalExit('SIGTERM');
    });

    // Handle SIGUSR2 for pane split detection
    // This signal is sent by tmux hook when a new pane is created
    process.on('SIGUSR2', () => {
      // Log that a pane split was detected
      LogService.getInstance().debug('Pane split detected via SIGUSR2, triggering immediate detection', 'shellDetection');
      // Emit a custom event to trigger immediate shell pane detection
      process.emit('pane-split-detected' as any);
      process.emit('psyche-external-command-signal' as any);
    });

    // Handle uncaught exceptions and unhandled rejections
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      cleanTerminalExit();
    });

    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled rejection:', reason);
      cleanTerminalExit();
    });
  }
}

// Validate system requirements before starting
(async () => {
  if (isFilesOnlyMode()) {
    render(React.createElement(FileBrowserApp), { exitOnCtrlC: false });
    return;
  }

  if (process.argv[2] === 'daemon') {
    const { runDaemon, parseDaemonArgs } = await import('./daemon/index.js');
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };
    const opts = parseDaemonArgs(process.argv.slice(3));
    await runDaemon({ ...opts, serverVersion: pkg.version ?? 'unknown' });
    return;
  }

  if (process.argv[2] === 'mcp') {
    // The stdio MCP process is only the canonical control client. It obtains a
    // project-scoped agent credential and connects to (or starts) the detached
    // project owner when the project-derived socket is absent; no pane mutation
    // is performed in this process.
    const { runMcpServer } = await import('./mcp/server.js');
    await runMcpServer();
    return;
  }

  if (isRecoveryMode()) {
    process.exit(await handleRecoveryCli());
  }

  const remotePaneActionArg = getArgValue('--remote-pane-action');
  if (remotePaneActionArg) {
    process.exit(await handleRemotePaneActionCli(remotePaneActionArg));
  }

  if (isDoctorMode()) {
    process.exit(await handleDoctorCli());
  }

  const validationResult = await validateSystemRequirements();
  printValidationResults(validationResult);

  // Only proceed if system requirements are met
  if (validationResult.canRun) {
    const psyche = new Psyche();
    psyche.init().catch(() => process.exit(1));
  }
})();
