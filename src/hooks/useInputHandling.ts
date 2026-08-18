import { useEffect, useRef, type Dispatch, type SetStateAction } from "react"
import path from "path"
import { useInput } from "ink"
import { runPairAction } from "../actions/implementations/pairAction.js"
import { runDevicesAction } from "../actions/implementations/devicesAction.js"
import type { PsychePane, SavePanes, SidebarProject } from "../types.js"
import type { TrackProjectActivity } from "../types/activity.js"
import { StateManager } from "../shared/StateManager.js"
import { TmuxService } from "../services/TmuxService.js"
import {
  STATUS_MESSAGE_DURATION_SHORT,
  STATUS_MESSAGE_DURATION_LONG,
} from "../constants/timing.js"
import {
  isPaneAction,
  PaneAction,
  TOGGLE_PANE_VISIBILITY_ACTION,
} from "../actions/index.js"
import { getMainBranch } from "../utils/git.js"
import {
  getResumableBranches,
  type ResumableBranchCandidate,
} from "../utils/resumeBranches.js"
import { enforceControlPaneSize } from "../utils/tmux.js"
import { SIDEBAR_WIDTH } from "../utils/layoutManager.js"
import { suggestCommand } from "../utils/commands.js"
import type { PopupManager } from "../services/PopupManager.js"
import { getPaneProjectName, getPaneProjectRoot } from "../utils/paneProject.js"
import {
  getPaneDisplayName,
  getPaneTmuxTitle,
  sanitizePaneDisplayName,
} from "../utils/paneTitle.js"
import {
  buildProjectActionLayout,
  getProjectActionByIndex,
  type ProjectActionItem,
} from "../utils/projectActions.js"
import { createShellPane, getNextPsycheId } from "../utils/shellPaneDetection.js"
import { createPsychePaneId } from "../utils/paneIdentity.js"
import type { AgentName } from "../utils/agentLaunch.js"
import {
  getBulkVisibilityAction,
  getProjectVisibilityAction,
  partitionPanesByProject,
} from "../utils/paneVisibility.js"
import { buildFilesOnlyCommand } from "../utils/psycheCommand.js"
import {
  addSidebarProject,
  getAutoSidebarProjectColorTheme,
  getSidebarProjectColorTheme,
  getSidebarProjectDisplayName,
  hasSidebarProject,
  removeSidebarProject,
  setSidebarProjectName,
  setSidebarProjectColorThemeSettingValue,
  sameSidebarProjectRoot,
  SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY,
} from "../utils/sidebarProjects.js"
import {
  drainRemotePaneActions,
  getCurrentTmuxSessionName,
  type RemotePaneActionShortcut,
} from "../utils/remotePaneActions.js"
import {
  DEFAULT_COLOR_THEME_SETTING_KEY,
  SettingsManager,
} from "../utils/settingsManager.js"
import {
  captureRitualFromSession,
  getProjectDefaultRitualId,
  listAvailableRituals,
  loadRitual,
  saveProjectRitual,
  setProjectDefaultRitualId,
  type RitualDefinition,
} from "../utils/rituals.js"
import {
  resolveProjectColorTheme,
  syncPaneColorThemes,
} from "../utils/paneColors.js"
import { syncWelcomePaneVisibility } from "../utils/welcomePaneManager.js"
import {
  isPrimaryMousePress,
  parseSgrMouseEvent,
  resolveSidebarMouseTarget,
  type SidebarMouseTarget,
} from "../utils/sidebarMouse.js"
import { SIDE_PANEL_COLLAPSED_WIDTH } from "../utils/sidePanel.js"
import {
  MAX_INLINE_NAME_LENGTH,
  type InlineRenameState,
} from "../utils/inlineRename.js"
import {
  readWorktreeMetadata,
  writeWorktreeMetadata,
} from "../utils/worktreeMetadata.js"
import {
  buildCovenAttachCommand,
  createCovenClient,
  type CovenClient,
  launchProjectCovenSession,
  openProjectCovenSession,
} from "../daemon/bridge.js"
import type { CovenSessionSummary } from "../daemon/protocol.js"
import {
  pickCovenSessionToOpen,
  type CovenSessionsLoadState,
} from "../utils/covenSessions.js"
import {
  buildDesktopUseQuickInput,
  buildInitialDesktopUsePrompt,
  getDesktopUseSessionId,
  isDesktopUsePane,
  type DesktopUseQuickAction,
} from "../utils/covenDesktopUse.js"
import { createTransactionalPane } from "../utils/transactionalPaneCreation.js"
import { withWorktreePaneCreationReservation } from "../utils/worktreePaneCreationReservation.js"

// Type for the action system returned by useActionSystem hook
interface ActionSystem {
  actionState: any
  executeAction: (actionId: any, pane: PsychePane, params?: any) => Promise<void>
  executeCallback: (callback: (() => Promise<any>) | null, options?: { showProgress?: boolean; progressMessage?: string }) => Promise<void>
  clearDialog: (dialogType: any) => void
  clearStatus: () => void
  setActionState: (state: any) => void
}

interface UseInputHandlingParams {
  // State
  panes: PsychePane[]
  selectedIndex: number
  setSelectedIndex: (index: number) => void
  isCreatingPane: boolean
  setIsCreatingPane: (value: boolean) => void
  runningCommand: boolean
  isUpdating: boolean
  isLoading: boolean
  ignoreInput: boolean
  isDevMode: boolean
  quitConfirmMode: boolean
  setQuitConfirmMode: (value: boolean) => void

  // Dialog state
  showCommandPrompt: "test" | "dev" | null
  setShowCommandPrompt: (value: "test" | "dev" | null) => void
  commandInput: string
  setCommandInput: (value: string) => void
  showFileCopyPrompt: boolean
  setShowFileCopyPrompt: (value: boolean) => void
  currentCommandType: "test" | "dev" | null
  setCurrentCommandType: (value: "test" | "dev" | null) => void

  // Settings
  projectSettings: any
  saveSettings: (settings: any) => Promise<void>
  settingsManager: any
  refreshPsycheSettings: (projectRoot?: string) => void

  // Services
  popupManager: PopupManager
  actionSystem: ActionSystem
  controlPaneId: string | undefined
  trackProjectActivity: TrackProjectActivity

  // Callbacks
  setStatusMessage: (message: string) => void
  copyNonGitFiles: (worktreePath: string, sourceProjectRoot?: string) => Promise<void>
  runCommandInternal: (type: "test" | "dev", pane: PsychePane) => Promise<void>
  handlePaneCreationWithAgent: (prompt: string, targetProjectRoot?: string) => Promise<void>
  openRitual: (ritual: RitualDefinition, activeProjectRoot?: string) => Promise<void>
  handleCreateChildWorktree: (pane: PsychePane) => Promise<void>
  handleReopenWorktree: (
    candidate: ResumableBranchCandidate,
    targetProjectRoot?: string
  ) => Promise<void>
  setDevSourceFromPane: (pane: PsychePane) => Promise<void>
  savePanes: SavePanes
  sidebarProjects: SidebarProject[]
  saveSidebarProjects: (projects: SidebarProject[]) => Promise<SidebarProject[]>
  loadPanes: () => Promise<void>
  cleanExit: () => void

  // Agent info
  getAvailableAgentsForProject: (projectRoot?: string) => AgentName[]
  panesFile: string

  // Project info
  projectRoot: string
  projectActionItems: ProjectActionItem[]
  covenSessionsState?: CovenSessionsLoadState
  completeStartupPrimer?: (outcome: "dismissed" | "completed-first-action") => void
  showStartupPrimer?: boolean
  inlineRename?: InlineRenameState | null
  setInlineRename?: Dispatch<SetStateAction<InlineRenameState | null>>

  // Navigation
  findCardInDirection: (currentIndex: number, direction: "up" | "down" | "left" | "right") => number | null

  // Bridge daemon (optional, progressive enhancement)
  bridgeDaemon?: any
  showPairBanner?: (opts: { code: string; expiresAt: Date }) => void
  sidePanelCollapsed?: boolean
  sidePanelWidth?: number
  onToggleSidePanel?: () => void
}

/**
 * Hook that handles all keyboard input for the TUI
 * Extracted from PsycheApp.tsx to reduce component complexity
 */
const SIDEBAR_DOUBLE_CLICK_INTERVAL_MS = 800

export function useInputHandling(params: UseInputHandlingParams) {
  const {
    panes,
    selectedIndex,
    setSelectedIndex,
    isCreatingPane,
    setIsCreatingPane,
    runningCommand,
    isUpdating,
    isLoading,
    ignoreInput,
    isDevMode,
    quitConfirmMode,
    setQuitConfirmMode,
    showCommandPrompt,
    setShowCommandPrompt,
    commandInput,
    setCommandInput,
    showFileCopyPrompt,
    setShowFileCopyPrompt,
    currentCommandType,
    setCurrentCommandType,
    projectSettings,
    saveSettings,
    settingsManager,
    refreshPsycheSettings,
    popupManager,
    actionSystem,
    controlPaneId,
    trackProjectActivity,
    setStatusMessage,
    copyNonGitFiles,
    runCommandInternal,
    handlePaneCreationWithAgent,
    openRitual,
    handleCreateChildWorktree,
    handleReopenWorktree,
    setDevSourceFromPane,
    savePanes,
    sidebarProjects,
    saveSidebarProjects,
    loadPanes,
    cleanExit,
    getAvailableAgentsForProject,
    panesFile,
    projectRoot,
    projectActionItems,
    covenSessionsState,
    completeStartupPrimer,
    showStartupPrimer,
    inlineRename,
    setInlineRename,
    findCardInDirection,
    bridgeDaemon,
    showPairBanner,
    sidePanelCollapsed = false,
    sidePanelWidth = SIDEBAR_WIDTH,
    onToggleSidePanel,
  } = params

  const layoutRefreshDebounceRef = useRef<NodeJS.Timeout | null>(null)
  const lastMousePressRef = useRef<{
    targetKey: string
    timestamp: number
  } | null>(null)
  // Colon-command accumulator for :pair, :devices, etc.
  const colonBufferRef = useRef<string | null>(null)
  const completeStartupPrimerAfterAction = () => {
    if (showStartupPrimer) {
      completeStartupPrimer?.("completed-first-action")
    }
  }

  useEffect(() => {
    return () => {
      if (layoutRefreshDebounceRef.current) {
        clearTimeout(layoutRefreshDebounceRef.current)
        layoutRefreshDebounceRef.current = null
      }
    }
  }, [])

  const queueLayoutRefresh = () => {
    if (!controlPaneId) {
      return
    }

    if (layoutRefreshDebounceRef.current) {
      clearTimeout(layoutRefreshDebounceRef.current)
    }

    layoutRefreshDebounceRef.current = setTimeout(async () => {
      layoutRefreshDebounceRef.current = null
      try {
        await enforceControlPaneSize(controlPaneId, sidePanelWidth, { forceLayout: true })
      } catch (error: any) {
        setStatusMessage(`Setting saved but layout refresh failed: ${error?.message || String(error)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    }, 250)
  }

  const handleCreateAgentPane = async (targetProjectRoot: string) => {
    const promptValue = await popupManager.launchNewPanePopup(targetProjectRoot)
    if (promptValue) {
      await handlePaneCreationWithAgent(promptValue, targetProjectRoot)
    }
  }

  const handleCreateTerminalPane = async (targetProjectRoot: string) => {
    try {
      setIsCreatingPane(true)
      setStatusMessage("Creating terminal pane...")

      const tmuxService = TmuxService.getInstance()
      const nextId = getNextPsycheId(panes)
      await createTransactionalPane({
        projectRoot: targetProjectRoot,
        sessionProjectRoot: projectRoot,
        operation: "terminal-pane",
        slugBase: `shell-${nextId}`,
        tmuxService,
        allocate: () => tmuxService.splitPane({ cwd: targetProjectRoot }),
        createPane: async ({ paneId, tmuxServerIdentity }) => {
          const pane = await createShellPane(
            paneId,
            nextId,
            undefined,
            { tmuxServerIdentity, setPaneTitle: false },
          )
          pane.projectRoot = targetProjectRoot
          pane.projectName = getSidebarProjectDisplayName(
            sidebarProjects,
            targetProjectRoot,
          )
          pane.colorTheme = resolveProjectColorTheme(targetProjectRoot, sidebarProjects)
          return pane
        },
        persist: (pane) => savePanes([...panes, pane], panes),
        activate: async (pane) => {
          try {
            await tmuxService.setPaneTitle(pane.paneId, pane.slug)
          } catch {
            // The durable record remains available for later title repair.
          }
        },
      })

      setIsCreatingPane(false)
      setStatusMessage("Terminal pane created")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)

      // Force a reload to ensure tmux metadata and pane IDs are in sync
      await loadPanes()
    } catch (error: any) {
      setIsCreatingPane(false)
      setStatusMessage(`Failed to create terminal pane: ${error.message}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    }
  }

  const handleCreateDesktopUsePane = async (targetProjectRoot: string) => {
    const projectDisplayName = getProjectDisplayName(targetProjectRoot)
    const prompt = buildInitialDesktopUsePrompt(projectDisplayName)
    const title = "desktop-use"

    try {
      setIsCreatingPane(true)
      setStatusMessage("Launching Coven desktop-use session...")

      const client = createCovenClient()
      const session = await launchProjectCovenSession(targetProjectRoot, {
        harness: "codex",
        prompt,
        title,
        cwd: targetProjectRoot,
      }, client)

      const tmuxService = TmuxService.getInstance()
      const nextId = getNextPsycheId(panes)
      await createTransactionalPane({
        projectRoot: targetProjectRoot,
        sessionProjectRoot: projectRoot,
        operation: "desktop-use-pane",
        slugBase: `desktop-use-${nextId}`,
        tmuxService,
        allocate: () => tmuxService.splitPane({ cwd: targetProjectRoot }),
        createPane: ({ paneId, tmuxServerIdentity }) => ({
          id: createPsychePaneId(),
          slug: `desktop-use-${nextId}`,
          displayName: "desktop-use",
          prompt,
          paneId,
          ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
          projectRoot: targetProjectRoot,
          projectName: projectDisplayName,
          colorTheme: resolveProjectColorTheme(targetProjectRoot, sidebarProjects),
          type: "desktop-use",
          shellType: "computer-control",
          covenSession: {
            id: session.id,
            harness: session.harness,
            status: session.status,
            projectRoot: session.projectRoot,
          },
          desktopUse: {
            sessionId: session.id,
            status: session.status,
            currentAction: "inspect",
            updatedAt: new Date().toISOString(),
          },
        }),
        persist: (pane) => savePanes([...panes, pane], panes),
        activate: async (pane) => {
          await tmuxService.setPaneTitle(pane.paneId, "desktop-use")
          await tmuxService.sendShellCommand(
            pane.paneId,
            buildCovenAttachCommand(session.id),
          )
          await tmuxService.sendTmuxKeys(pane.paneId, "Enter")
          await client.sendInput?.(session.id, buildDesktopUseQuickInput("test"))
        },
      })
      await loadPanes()

      setStatusMessage("Desktop-use pane connected to Coven")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to create desktop-use pane: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const handleOpenCovenSession = async (targetProjectRoot: string) => {
    if (!covenSessionsState) {
      setStatusMessage("Coven sessions are not loaded yet")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    if (covenSessionsState.status === "unavailable") {
      setStatusMessage("Coven not running — start it with: coven start")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      return
    }

    const session = pickCovenSessionToOpen(targetProjectRoot, covenSessionsState.sessions)
    if (!session) {
      setStatusMessage("No Coven sessions for this project")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const sessionName = getCurrentTmuxSessionName()
    if (!sessionName) {
      setStatusMessage("Cannot open Coven session: tmux session unknown")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      return
    }

    try {
      setIsCreatingPane(true)
      setStatusMessage(`Opening Coven session ${session.title || session.id}...`)
      await openProjectCovenSession(
        targetProjectRoot,
        sessionName,
        session.id,
        createKnownCovenSessionClient(covenSessionsState)
      )
      await loadPanes()
      setStatusMessage(`Opened Coven session ${session.title || session.id}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to open Coven session: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const createKnownCovenSessionClient = (
    state: Exclude<CovenSessionsLoadState, { status: "unavailable" }>
  ): CovenClient => ({
    listSessions: async () => state.sessions.map((candidate) => ({
      id: candidate.id,
      projectRoot: candidate.projectRoot,
      harness: candidate.harness || "coven",
      title: candidate.title || candidate.id,
      status: (candidate.status || "created") as CovenSessionSummary["status"],
      createdAt: candidate.createdAt || "",
      updatedAt: candidate.updatedAt || candidate.archivedAt || candidate.createdAt || "",
      archivedAt: candidate.archivedAt,
    })),
  })

  const sendDesktopUseQuickAction = async (pane: PsychePane, action: DesktopUseQuickAction) => {
    const sessionId = getDesktopUseSessionId(pane)
    if (!sessionId) {
      setStatusMessage("Desktop-use pane has no Coven session")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    try {
      await createCovenClient().sendInput?.(sessionId, buildDesktopUseQuickInput(action))
      setStatusMessage(`Sent desktop-use ${action}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to send desktop-use ${action}: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    }
  }

  const selectProjectAction = (
    targetProjectRoot: string,
    projectsToRender: SidebarProject[] = sidebarProjects
  ) => {
    const actionLayout = buildProjectActionLayout(
      panes,
      projectsToRender,
      projectRoot,
      path.basename(projectRoot)
    )
    const selectedAction = actionLayout.actionItems.find(
      (action) =>
        action.kind === "new-agent" &&
        sameSidebarProjectRoot(action.projectRoot, targetProjectRoot)
    )
    if (selectedAction) {
      setSelectedIndex(selectedAction.index)
    }
  }

  const openTerminalInWorktree = async (selectedPane: PsychePane) => {
    if (!selectedPane.worktreePath) {
      setStatusMessage("Cannot open terminal: this pane has no worktree")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)

    try {
      setIsCreatingPane(true)
      setStatusMessage(`Opening terminal in ${getPaneDisplayName(selectedPane)}...`)

      const tmuxService = TmuxService.getInstance()
      const nextId = getNextPsycheId(panes)
      await withWorktreePaneCreationReservation({
        worktreePath: selectedPane.worktreePath,
        projectRoot: targetProjectRoot,
        operation: (canonicalWorktreePath, reservation) => createTransactionalPane({
          projectRoot: targetProjectRoot,
          sessionProjectRoot: projectRoot,
          operation: "worktree-terminal-pane",
          slugBase: `shell-${nextId}`,
          worktreePath: canonicalWorktreePath,
          tmuxService,
          reservation,
          allocate: () => tmuxService.splitPane({ cwd: canonicalWorktreePath }),
          createPane: async ({ paneId, tmuxServerIdentity }) => {
            const pane = await createShellPane(
              paneId,
              nextId,
              undefined,
              { tmuxServerIdentity, setPaneTitle: false },
            )
            pane.projectRoot = targetProjectRoot
            pane.projectName = getSidebarProjectDisplayName(
              sidebarProjects,
              targetProjectRoot,
            )
            pane.colorTheme = resolveProjectColorTheme(targetProjectRoot, sidebarProjects)
            return pane
          },
          persist: (pane) => savePanes([...panes, pane], panes),
          activate: async (pane) => {
            try {
              await tmuxService.setPaneTitle(pane.paneId, pane.slug)
            } catch {
              // The durable record remains available for later title repair.
            }
          },
        }),
      })

      setStatusMessage(`Opened terminal in ${getPaneDisplayName(selectedPane)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)

      // Force a reload to ensure tmux metadata and pane IDs are in sync
      await loadPanes()
    } catch (error: any) {
      setStatusMessage(`Failed to open terminal in worktree: ${error.message}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const openFileBrowserInWorktree = async (selectedPane: PsychePane) => {
    if (!selectedPane.worktreePath) {
      setStatusMessage("Cannot open file browser: this pane has no worktree")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const existingBrowserPane = panes.find((pane) =>
      pane.browserPath === selectedPane.worktreePath && !pane.hidden
    )

    if (existingBrowserPane) {
      try {
        await TmuxService.getInstance().selectPane(existingBrowserPane.paneId)
        setStatusMessage(`File browser already open for ${getPaneDisplayName(selectedPane)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } catch (error: any) {
        setStatusMessage(`Failed to focus file browser: ${error?.message || String(error)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
      return
    }

    const targetProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)
    const targetProjectName = path.basename(targetProjectRoot)

    try {
      setIsCreatingPane(true)
      setStatusMessage(`Opening file browser for ${getPaneDisplayName(selectedPane)}...`)

      const tmuxService = TmuxService.getInstance()
      const slugBase = `files-${path.basename(selectedPane.worktreePath)}`

      await withWorktreePaneCreationReservation({
        worktreePath: selectedPane.worktreePath,
        projectRoot: targetProjectRoot,
        operation: (canonicalWorktreePath, reservation) => createTransactionalPane({
          projectRoot: targetProjectRoot,
          sessionProjectRoot: projectRoot,
          operation: "file-browser-pane",
          slugBase,
          worktreePath: canonicalWorktreePath,
          tmuxService,
          reservation,
          // Do not pass a command to split-window: the browser must not start
          // until its exact record and generation are durable.
          allocate: () => tmuxService.splitPane({
            cwd: canonicalWorktreePath,
          }),
          createPane: ({ paneId, tmuxServerIdentity }) => ({
            id: createPsychePaneId(),
            slug: slugBase,
            prompt: "",
            paneId,
            ...(tmuxServerIdentity ? { tmuxServerIdentity } : {}),
            projectRoot: targetProjectRoot,
            projectName: targetProjectName,
            colorTheme: resolveProjectColorTheme(targetProjectRoot, sidebarProjects),
            type: "shell",
            shellType: "fb",
            browserPath: canonicalWorktreePath,
          }),
          persist: (pane) => savePanes([...panes, pane], panes),
          activate: async (pane) => {
            await tmuxService.setPaneTitle(pane.paneId, pane.slug)
            await tmuxService.sendShellCommand(pane.paneId, buildFilesOnlyCommand())
            await tmuxService.sendTmuxKeys(pane.paneId, "Enter")
          },
        }),
      })
      await loadPanes()

      setStatusMessage(`Opened file browser for ${getPaneDisplayName(selectedPane)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to open file browser: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const handleAddProjectToSidebar = async () => {
    const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    const defaultProjectPath = selectedPane
      ? getPaneProjectRoot(selectedPane, projectRoot)
      : (selectedAction?.projectRoot || projectRoot)

    const requestedProjectPath = await popupManager.launchProjectSelectPopup(
      defaultProjectPath,
      defaultProjectPath
    )

    if (!requestedProjectPath) {
      return
    }

    const resolveProjectTheme = (targetProjectRoot: string) =>
      getSidebarProjectColorTheme(sidebarProjects, targetProjectRoot)
      || new SettingsManager(targetProjectRoot).getSettings().colorTheme

    try {
      const { resolveProjectRootFromPath } = await import("../utils/projectRoot.js")
      const resolved = resolveProjectRootFromPath(requestedProjectPath, projectRoot)
      const nextProjects = addSidebarProject(sidebarProjects, {
        ...resolved,
        colorTheme: getAutoSidebarProjectColorTheme(
          sidebarProjects,
          resolved,
          resolveProjectTheme
        ),
        colorThemeSource: 'auto',
      })

      if (nextProjects === sidebarProjects) {
        selectProjectAction(resolved.projectRoot)
        setStatusMessage(`${resolved.projectName} is already in the sidebar`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }

      const savedProjects = await saveSidebarProjects(nextProjects)
      selectProjectAction(resolved.projectRoot, savedProjects)
      setStatusMessage(`Added ${resolved.projectName} to the sidebar`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      const {
        createEmptyGitProject,
        inspectProjectCreationTarget,
      } = await import("../utils/projectRoot.js")
      const target = inspectProjectCreationTarget(requestedProjectPath, projectRoot)

      if (target.state !== "missing" && target.state !== "empty_directory") {
        const message = target.state === "directory_not_empty"
          ? `Directory is not a git repository and is not empty: ${target.absolutePath}. New projects can only be created in a missing or empty directory.`
          : (error?.message || "Invalid project path")
        setStatusMessage(message)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
        return
      }

      const confirmMessage = target.state === "missing"
        ? `This project does not exist yet:\n${target.absolutePath}\n\nCreate a new empty git repository here?`
        : `This directory is not a git repository:\n${target.absolutePath}\n\nInitialize a new empty git repository here?`
      const shouldCreateProject = await popupManager.launchConfirmPopup(
        "Create Project",
        confirmMessage,
        "Create Project",
        "Cancel",
        projectRoot
      )

      if (!shouldCreateProject) {
        return
      }

      try {
        setStatusMessage(`Creating ${path.basename(target.absolutePath) || "project"}...`)
        const createdProject = createEmptyGitProject(requestedProjectPath, projectRoot)
        const nextProjects = addSidebarProject(sidebarProjects, {
          ...createdProject,
          colorTheme: getAutoSidebarProjectColorTheme(
            sidebarProjects,
            createdProject,
            resolveProjectTheme
          ),
          colorThemeSource: 'auto',
        })

        if (nextProjects === sidebarProjects) {
          selectProjectAction(createdProject.projectRoot)
          setStatusMessage(`${createdProject.projectName} is already in the sidebar`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
          return
        }

        const savedProjects = await saveSidebarProjects(nextProjects)
        selectProjectAction(createdProject.projectRoot, savedProjects)
        setStatusMessage(`Created ${createdProject.projectName} and added it to the sidebar`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } catch (creationError: any) {
        setStatusMessage(creationError?.message || "Failed to create project")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    }
  }

  const handleRemoveProjectFromSidebar = async (targetProjectRoot: string) => {
    if (sameSidebarProjectRoot(targetProjectRoot, projectRoot)) {
      setStatusMessage("The session project cannot be removed from the sidebar")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const projectHasPanes = panes.some((pane) =>
      sameSidebarProjectRoot(getPaneProjectRoot(pane, projectRoot), targetProjectRoot)
    )
    if (projectHasPanes) {
      setStatusMessage("Close this project's panes before removing it from the sidebar")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      return
    }

    if (!hasSidebarProject(sidebarProjects, targetProjectRoot)) {
      setStatusMessage("Project is not in the sidebar")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const updatedProjects = removeSidebarProject(sidebarProjects, targetProjectRoot)
    const savedProjects = await saveSidebarProjects(updatedProjects)
    selectProjectAction(projectRoot, savedProjects)
    setStatusMessage(`Removed ${path.basename(targetProjectRoot)} from the sidebar`)
    setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
  }

  const getActiveProjectRoot = (): string => {
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    if (selectedPane) {
      return getPaneProjectRoot(selectedPane, projectRoot)
    }

    const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)
    return selectedAction?.projectRoot || projectRoot
  }

  const getProjectDisplayName = (targetProjectRoot: string): string => {
    const sidebarProject = sidebarProjects.find((project) =>
      sameSidebarProjectRoot(project.projectRoot, targetProjectRoot)
    )
    if (sidebarProject?.projectName) {
      return sidebarProject.projectName
    }

    const pane = panes.find((candidate) =>
      sameSidebarProjectRoot(getPaneProjectRoot(candidate, projectRoot), targetProjectRoot)
    )
    if (pane) {
      return getPaneProjectName(pane, projectRoot)
    }

    const action = projectActionItems.find((candidate) =>
      sameSidebarProjectRoot(candidate.projectRoot, targetProjectRoot)
    )
    return action?.projectName || path.basename(targetProjectRoot) || "project"
  }

  const startPaneInlineRename = (pane: PsychePane) => {
    if (!setInlineRename) {
      return
    }

    const value = getPaneDisplayName(pane)
    setInlineRename({
      target: { kind: "pane", paneId: pane.id },
      value,
      cursor: value.length,
    })
    setStatusMessage(`Editing ${value}`)
  }

  const startProjectInlineRename = (targetProjectRoot: string) => {
    if (!setInlineRename) {
      return
    }

    const value = getProjectDisplayName(targetProjectRoot)
    setInlineRename({
      target: { kind: "project", projectRoot: targetProjectRoot },
      value,
      cursor: value.length,
    })
    setStatusMessage(`Editing ${value}`)
  }

  const startInlineRenameForSelection = () => {
    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    if (selectedPane) {
      startPaneInlineRename(selectedPane)
      return
    }

    startProjectInlineRename(getActiveProjectRoot())
  }

  const persistWorktreeDisplayName = (pane: PsychePane, displayName?: string) => {
    if (!pane.worktreePath) {
      return
    }

    const existingMetadata = readWorktreeMetadata(pane.worktreePath) || {}
    writeWorktreeMetadata(pane.worktreePath, {
      ...existingMetadata,
      displayName,
    })
  }

  const commitInlineRename = async (state: InlineRenameState) => {
    const normalizedName = sanitizePaneDisplayName(state.value)
    if (normalizedName.length > MAX_INLINE_NAME_LENGTH) {
      setStatusMessage(`Names must be ${MAX_INLINE_NAME_LENGTH} characters or fewer`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    if (state.target.kind === "pane") {
      const paneId = state.target.paneId
      const pane = panes.find((candidate) => candidate.id === paneId)
      if (!pane) {
        setInlineRename?.(null)
        return
      }

      const nextDisplayName = normalizedName && normalizedName !== pane.slug
        ? normalizedName
        : undefined
      const currentDisplayName = sanitizePaneDisplayName(pane.displayName || "") || undefined
      if (currentDisplayName === nextDisplayName) {
        setInlineRename?.(null)
        setStatusMessage(`Pane name unchanged: ${getPaneDisplayName(pane)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }

      const updatedPane: PsychePane = { ...pane, displayName: nextDisplayName }
      const updatedPanes = panes.map((candidate) =>
        candidate.id === pane.id ? updatedPane : candidate
      )

      persistWorktreeDisplayName(pane, nextDisplayName)
      await savePanes(updatedPanes, panes)
      try {
        const sessionProjectRoot = StateManager.getInstance().getState().projectRoot
        await TmuxService.getInstance().setPaneTitle(
          pane.paneId,
          getPaneTmuxTitle(updatedPane, sessionProjectRoot || projectRoot)
        )
      } catch {
        // Periodic title enforcement will reconcile transient tmux failures.
      }

      setInlineRename?.(null)
      const savedName = getPaneDisplayName(updatedPane)
      setStatusMessage(nextDisplayName
        ? `Renamed pane to "${savedName}"`
        : `Reset pane name to "${savedName}"`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetProjectRoot = state.target.projectRoot
    const nextProjectName = normalizedName || path.basename(targetProjectRoot) || "project"
    const updatedProjects = setSidebarProjectName(
      sidebarProjects,
      targetProjectRoot,
      nextProjectName
    )
    const updatedPanes = panes.map((pane) =>
      sameSidebarProjectRoot(getPaneProjectRoot(pane, projectRoot), targetProjectRoot)
        ? { ...pane, projectName: nextProjectName }
        : pane
    )
    const panesChanged = updatedPanes.some((pane, index) =>
      pane.projectName !== panes[index]?.projectName
    )
    const projectsChanged = updatedProjects !== sidebarProjects

    if (!panesChanged && !projectsChanged) {
      setInlineRename?.(null)
      setStatusMessage(`Project name unchanged: ${nextProjectName}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    if (projectsChanged) {
      await saveSidebarProjects(updatedProjects)
    }
    if (panesChanged) {
      await savePanes(updatedPanes, panes)
    }

    setInlineRename?.(null)
    setStatusMessage(`Renamed project to "${nextProjectName}"`)
    setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
  }

  const updateInlineRename = (updater: (state: InlineRenameState) => InlineRenameState) => {
    setInlineRename?.((current) => current ? updater(current) : current)
  }

  const insertInlineRenameText = (value: string) => {
    const cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ")
    if (!cleaned) {
      return
    }

    updateInlineRename((state) => {
      const before = state.value.slice(0, state.cursor)
      const after = state.value.slice(state.cursor)
      const nextValue = `${before}${cleaned}${after}`.slice(0, MAX_INLINE_NAME_LENGTH)
      const nextCursor = Math.min(
        MAX_INLINE_NAME_LENGTH,
        state.cursor + cleaned.length
      )
      return { ...state, value: nextValue, cursor: nextCursor }
    })
  }

  const handleInlineRenameInput = async (input: string, key: any): Promise<boolean> => {
    if (!inlineRename) {
      return false
    }

    if (key.escape || (key.ctrl && input === "c")) {
      setInlineRename?.(null)
      setStatusMessage("Rename cancelled")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return true
    }

    if (key.return) {
      await commitInlineRename(inlineRename)
      return true
    }

    if (key.leftArrow) {
      updateInlineRename((state) => ({
        ...state,
        cursor: Math.max(0, state.cursor - 1),
      }))
      return true
    }

    if (key.rightArrow) {
      updateInlineRename((state) => ({
        ...state,
        cursor: Math.min(state.value.length, state.cursor + 1),
      }))
      return true
    }

    if (key.ctrl && input === "a") {
      updateInlineRename((state) => ({ ...state, cursor: 0 }))
      return true
    }

    if (key.ctrl && input === "e") {
      updateInlineRename((state) => ({ ...state, cursor: state.value.length }))
      return true
    }

    if (key.backspace || key.delete || input === "\x7f" || input === "\x08") {
      updateInlineRename((state) => {
        if (state.cursor <= 0) {
          return state
        }

        return {
          ...state,
          value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
          cursor: state.cursor - 1,
        }
      })
      return true
    }

    if (input && !key.ctrl && !key.meta && !input.startsWith("\x1b")) {
      insertInlineRenameText(input)
      return true
    }

    return true
  }

  const getSidebarMouseTargetKey = (target: SidebarMouseTarget): string => {
    if (target.kind === "project-header") {
      return `project:${target.projectRoot}`
    }
    if (target.kind === "pane") {
      return `pane:${target.pane.id}`
    }
    return `action:${target.action.index}`
  }

  const handleSidebarMousePress = async (input: string): Promise<boolean> => {
    const mouseEvent = parseSgrMouseEvent(input)
    if (!mouseEvent || !isPrimaryMousePress(mouseEvent)) {
      return false
    }

    if (sidePanelCollapsed) {
      if (onToggleSidePanel && mouseEvent.column <= SIDE_PANEL_COLLAPSED_WIDTH) {
        onToggleSidePanel()
      }
      return true
    }

    if (
      onToggleSidePanel
      && mouseEvent.row === 1
      && mouseEvent.column === sidePanelWidth
    ) {
      onToggleSidePanel()
      return true
    }

    const layout = buildProjectActionLayout(
      panes,
      sidebarProjects,
      projectRoot,
      path.basename(projectRoot)
    )
    const target = resolveSidebarMouseTarget(
      layout,
      // The expanded panel renders a dedicated chevron row before project
      // headers; sidebarMouse models the project content itself.
      mouseEvent.row - 1,
      mouseEvent.column,
      { isLoading }
    )
    if (!target) {
      return true
    }

    const targetKey = getSidebarMouseTargetKey(target)
    const now = Date.now()
    const isDoubleClick =
      lastMousePressRef.current?.targetKey === targetKey
      && now - lastMousePressRef.current.timestamp <= SIDEBAR_DOUBLE_CLICK_INTERVAL_MS
    lastMousePressRef.current = { targetKey, timestamp: now }

    if (target.kind === "pane") {
      setSelectedIndex(target.index)
      if (isDoubleClick) {
        startPaneInlineRename(target.pane)
      }
      return true
    }

    if (target.kind === "project-header") {
      if (target.selectIndex !== null) {
        setSelectedIndex(target.selectIndex)
      }
      if (isDoubleClick) {
        startProjectInlineRename(target.projectRoot)
      }
      return true
    }

    setSelectedIndex(target.action.index)
    return true
  }

  const formatRitualDescription = (ritual: RitualDefinition): string => {
    const paneCount = ritual.projects.reduce(
      (count, project) => count + project.panes.length,
      0
    )
    const scopeLabel = ritual.scope === "builtin" ? "built-in" : "project"
    const paneLabel = `${paneCount} pane${paneCount === 1 ? "" : "s"}`
    return ritual.description
      ? `${ritual.description} (${scopeLabel}, ${paneLabel})`
      : `${scopeLabel}, ${paneLabel}`
  }

  const chooseRitual = async (
    title: string,
    message: string,
    activeProjectRoot: string,
    defaultRitualId?: string
  ): Promise<RitualDefinition | null> => {
    const rituals = listAvailableRituals(activeProjectRoot)
    if (rituals.length === 0) {
      setStatusMessage("No rituals available")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return null
    }

    const selectedRitualId = await popupManager.launchChoicePopup(
      title,
      message,
      rituals.map((ritual) => ({
        id: ritual.id,
        label: ritual.id === defaultRitualId
          ? `${ritual.name} (default)`
          : ritual.name,
        description: formatRitualDescription(ritual),
        default: ritual.id === defaultRitualId,
      })),
      undefined,
      activeProjectRoot
    )

    if (!selectedRitualId) {
      return null
    }

    return loadRitual(activeProjectRoot, selectedRitualId)
  }

  const handleSaveCurrentSetupAsRitual = async (activeProjectRoot: string) => {
    const ritualName = await popupManager.launchInputPopup(
      "Save Ritual",
      "Name this reusable setup. psyche will save projects, pane kinds, prompts, and agent preferences.",
      "Review Stack",
      "",
      activeProjectRoot
    )

    if (!ritualName?.trim()) {
      return
    }

    try {
      const ritual = captureRitualFromSession({
        name: ritualName,
        projectRoot: activeProjectRoot,
        panes,
        sidebarProjects,
      })
      const saved = saveProjectRitual(activeProjectRoot, ritual)
      setStatusMessage(`Saved ritual: ${saved.name}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(error?.message || "Failed to save ritual")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    }
  }

  const handleAttachDefaultRitual = async (activeProjectRoot: string) => {
    const ritual = await chooseRitual(
      "Attach Default Ritual",
      "Choose the ritual this project should offer by default.",
      activeProjectRoot,
      getProjectDefaultRitualId(activeProjectRoot)
    )

    if (!ritual) {
      return
    }

    setProjectDefaultRitualId(activeProjectRoot, ritual.id)
    setStatusMessage(`Default ritual set: ${ritual.name}`)
    setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
  }

  const handleRitualMenu = async () => {
    const activeProjectRoot = getActiveProjectRoot()
    const defaultRitualId = getProjectDefaultRitualId(activeProjectRoot)
    const rituals = listAvailableRituals(activeProjectRoot)
    const selected = await popupManager.launchChoicePopup(
      "Rituals",
      "Open or manage reusable project setups. Rituals create fresh panes and worktrees; they do not restore stale tmux snapshots.",
      [
        ...rituals.map((ritual) => ({
          id: `open:${ritual.id}`,
          label: ritual.id === defaultRitualId
            ? `${ritual.name} (default)`
            : ritual.name,
          description: formatRitualDescription(ritual),
          default: ritual.id === defaultRitualId,
        })),
        {
          id: "save-current",
          label: "Save current setup as ritual",
          description: "Capture the current projects, pane kinds, prompts, and agents.",
        },
        {
          id: "attach-default",
          label: "Attach default ritual to project",
          description: "Set which ritual this project should offer first.",
        },
        {
          id: "clear-default",
          label: "Clear project default ritual",
          description: "Keep rituals saved, but remove this project's default attachment.",
        },
      ],
      undefined,
      activeProjectRoot
    )

    if (!selected) {
      return
    }

    if (selected.startsWith("open:")) {
      const ritualId = selected.slice("open:".length)
      const ritual = loadRitual(activeProjectRoot, ritualId)
      if (!ritual) {
        setStatusMessage("Ritual no longer exists")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }

      completeStartupPrimerAfterAction()
      await openRitual(ritual, activeProjectRoot)
      return
    }

    if (selected === "save-current") {
      await handleSaveCurrentSetupAsRitual(activeProjectRoot)
      return
    }

    if (selected === "attach-default") {
      await handleAttachDefaultRitual(activeProjectRoot)
      return
    }

    if (selected === "clear-default") {
      setProjectDefaultRitualId(activeProjectRoot)
      setStatusMessage("Project default ritual cleared")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    }
  }

  // ---------------------------------------------------------------------------
  // Bridge daemon handlers (:pair and :devices colon commands)
  // ---------------------------------------------------------------------------

  const handlePair = async () => {
    await runPairAction({
      bridgeDaemon,
      setStatusMessage: (msg) => {
        setStatusMessage(msg)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      },
      showPairBanner,
    })
  }

  const handleDevices = async () => {
    await runDevicesAction({
      bridgeDaemon,
      popup: popupManager,
      setStatusMessage: (msg) => {
        setStatusMessage(msg)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      },
    })
  }

  const launchHooksAuthoringSession = async (targetProjectRoot?: string) => {
    const hooksProjectRoot = targetProjectRoot || getActiveProjectRoot()
    const { initializeHooksDirectory } = await import("../utils/hooks.js")
    initializeHooksDirectory(hooksProjectRoot)

    const prompt =
      "I would like to create or edit my psyche hooks in .psyche-hooks. Please read AGENTS.md or CLAUDE.md first, then ask me what I want to create or modify."
    await handlePaneCreationWithAgent(prompt, hooksProjectRoot)
  }

  const refreshPaneLayout = async () => {
    if (!controlPaneId) {
      return
    }

    await enforceControlPaneSize(controlPaneId, sidePanelWidth, {
      forceLayout: true,
      suppressLayoutLogs: true,
    })
  }

  const syncWelcomePaneForPanes = async (
    nextPanes: PsychePane[],
    targetProjectRoot: string = getActiveProjectRoot()
  ) => {
    if (!controlPaneId) {
      return
    }

    const hasVisiblePanes = nextPanes.some((pane) => !pane.hidden)
    const themeName = resolveProjectColorTheme(targetProjectRoot, sidebarProjects)

    await syncWelcomePaneVisibility(
      projectRoot,
      controlPaneId,
      !hasVisiblePanes,
      themeName
    )
  }

  const getPaneShowTarget = async (excludedPaneId?: string): Promise<string | null> => {
    const visiblePaneId = panes.find(
      (pane) => !pane.hidden && pane.paneId !== excludedPaneId
    )?.paneId
    if (visiblePaneId) {
      return visiblePaneId
    }

    if (controlPaneId) {
      return controlPaneId
    }

    try {
      return await TmuxService.getInstance().getCurrentPaneId()
    } catch {
      return null
    }
  }

  const togglePaneVisibility = async (selectedPane: PsychePane) => {
    const tmuxService = TmuxService.getInstance()

    try {
      setIsCreatingPane(true)
      setStatusMessage(
        selectedPane.hidden
          ? `Showing ${getPaneDisplayName(selectedPane)}...`
          : `Hiding ${getPaneDisplayName(selectedPane)}...`
      )

      if (selectedPane.hidden) {
        const targetPaneId = await getPaneShowTarget(selectedPane.paneId)
        if (!targetPaneId) {
          throw new Error("No target pane is available to show this pane")
        }
        await tmuxService.joinPaneToTarget(selectedPane.paneId, targetPaneId)
      } else {
        await tmuxService.breakPaneToWindow(
          selectedPane.paneId,
          `psyche-hidden-${selectedPane.id}`
        )
      }

      const updatedPanes = panes.map((pane) =>
        pane.id === selectedPane.id
          ? { ...pane, hidden: !selectedPane.hidden }
          : pane
      )

      await savePanes(updatedPanes, panes)
      await syncWelcomePaneForPanes(
        updatedPanes,
        getPaneProjectRoot(selectedPane, projectRoot)
      )
      await refreshPaneLayout()
      await loadPanes()

      setStatusMessage(
        selectedPane.hidden
          ? `Showing ${getPaneDisplayName(selectedPane)}`
          : `Hid ${getPaneDisplayName(selectedPane)}`
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to toggle pane visibility: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const toggleOtherPanesVisibility = async (selectedPane: PsychePane) => {
    const action = getBulkVisibilityAction(panes, selectedPane)
    if (!action) {
      setStatusMessage("No other panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetPanes = panes.filter((pane) =>
      pane.id !== selectedPane.id
        && (action === "hide-others" ? !pane.hidden : pane.hidden)
    )

    if (targetPanes.length === 0) {
      setStatusMessage("No other panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const tmuxService = TmuxService.getInstance()
    const hidden = action === "hide-others"

    try {
      setIsCreatingPane(true)
      setStatusMessage(hidden ? "Hiding other panes..." : "Showing other panes...")

      for (const pane of targetPanes) {
        if (hidden) {
          await tmuxService.breakPaneToWindow(
            pane.paneId,
            `psyche-hidden-${pane.id}`
          )
          continue
        }

        const targetPaneId = await getPaneShowTarget(pane.paneId)
        if (!targetPaneId) {
          throw new Error("No target pane is available to show hidden panes")
        }
        await tmuxService.joinPaneToTarget(pane.paneId, targetPaneId)
      }

      const targetPaneIds = new Set(targetPanes.map((pane) => pane.id))
      const updatedPanes = panes.map((pane) =>
        targetPaneIds.has(pane.id) ? { ...pane, hidden } : pane
      )

      await savePanes(updatedPanes, panes)
      await syncWelcomePaneForPanes(
        updatedPanes,
        getPaneProjectRoot(selectedPane, projectRoot)
      )
      await refreshPaneLayout()
      await loadPanes()

      setStatusMessage(
        hidden
          ? `Hid ${targetPanes.length} other pane${targetPanes.length === 1 ? "" : "s"}`
          : `Showed ${targetPanes.length} other pane${targetPanes.length === 1 ? "" : "s"}`
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to toggle other panes: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const toggleProjectPanesVisibility = async (
    targetProjectRoot: string = getActiveProjectRoot()
  ) => {
    const action = getProjectVisibilityAction(panes, targetProjectRoot, projectRoot)

    if (!action) {
      setStatusMessage("No project panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const { projectPanes, otherPanes } = partitionPanesByProject(
      panes,
      targetProjectRoot,
      projectRoot
    )

    if (projectPanes.length === 0) {
      setStatusMessage("No project panes to toggle")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const projectName = getPaneProjectName(
      projectPanes[0],
      projectRoot
    )
    const panesToShow = action === "focus-project"
      ? projectPanes.filter((pane) => pane.hidden)
      : panes.filter((pane) => pane.hidden)
    const panesToHide = action === "focus-project"
      ? otherPanes.filter((pane) => !pane.hidden)
      : []

    try {
      setIsCreatingPane(true)
      setStatusMessage(
        action === "focus-project"
          ? `Showing ${projectName} panes...`
          : "Showing all panes..."
      )

      // Show target project panes before hiding others so we always have
      // an attached pane available for tmux join targets.
      for (const pane of panesToShow) {
        const targetPaneId = await getPaneShowTarget(pane.paneId)
        if (!targetPaneId) {
          throw new Error("No target pane is available to show hidden panes")
        }
        await TmuxService.getInstance().joinPaneToTarget(pane.paneId, targetPaneId)
      }

      for (const pane of panesToHide) {
        await TmuxService.getInstance().breakPaneToWindow(
          pane.paneId,
          `psyche-hidden-${pane.id}`
        )
      }

      const shownPaneIds = new Set(panesToShow.map((pane) => pane.id))
      const hiddenPaneIds = new Set(panesToHide.map((pane) => pane.id))

      const updatedPanes = panes.map((pane) => {
        if (shownPaneIds.has(pane.id)) {
          return { ...pane, hidden: false }
        }
        if (hiddenPaneIds.has(pane.id)) {
          return { ...pane, hidden: true }
        }
        return pane
      })

      await savePanes(updatedPanes, panes)
      await syncWelcomePaneForPanes(updatedPanes, targetProjectRoot)
      await refreshPaneLayout()
      await loadPanes()

      setStatusMessage(
        action === "focus-project"
          ? panesToHide.length > 0
            ? `Showing only ${projectName} panes`
            : `Showed ${projectName} panes`
          : "Showed all panes"
      )
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
    } catch (error: any) {
      setStatusMessage(`Failed to toggle project panes: ${error?.message || String(error)}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const openPaneMenu = async (
    pane: PsychePane,
    options: { anchorToPane?: boolean } = {}
  ) => {
    const actionId = await popupManager.launchKebabMenuPopup(
      pane,
      panes,
      options
    )
    if (!actionId) {
      return
    }

    if (actionId === TOGGLE_PANE_VISIBILITY_ACTION) {
      await togglePaneVisibility(pane)
      return
    }

    if (actionId === "hide-others" || actionId === "show-others") {
      await toggleOtherPanesVisibility(pane)
      return
    }

    if (actionId === "focus-project" || actionId === "show-all") {
      await toggleProjectPanesVisibility(getPaneProjectRoot(pane, projectRoot))
      return
    }

    if (actionId === PaneAction.SET_SOURCE) {
      await setDevSourceFromPane(pane)
      return
    }

    if (actionId === PaneAction.ATTACH_AGENT) {
      await attachAgentsToPane(pane)
      return
    }

    if (actionId === PaneAction.CREATE_CHILD_WORKTREE) {
      await handleCreateChildWorktree(pane)
      return
    }

    if (actionId === PaneAction.OPEN_TERMINAL_IN_WORKTREE) {
      await openTerminalInWorktree(pane)
      return
    }

    if (actionId === PaneAction.OPEN_FILE_BROWSER) {
      await openFileBrowserInWorktree(pane)
      return
    }

    if (!isPaneAction(actionId)) {
      setStatusMessage(`Unknown menu action: ${actionId}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      return
    }

    await actionSystem.executeAction(actionId, pane, {
      mainBranch: getMainBranch(),
    })
  }

  const attachAgentsToPane = async (selectedPane: PsychePane) => {
    if (!selectedPane.worktreePath) {
      setStatusMessage("Cannot attach agent: this pane has no worktree")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    }

    const targetProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)

    // Warn if agent is actively working
    if (selectedPane.agentStatus === "working") {
      const confirmed = await popupManager.launchConfirmPopup(
        "Agent Active",
        `Agent in "${getPaneDisplayName(selectedPane)}" is currently working. Attach another agent anyway?`,
        "Attach",
        "Cancel",
        targetProjectRoot
      )
      if (!confirmed) return
    }

    let selectedAgents: AgentName[] = []
    const targetAvailableAgents = getAvailableAgentsForProject(targetProjectRoot)
    if (targetAvailableAgents.length === 0) {
      setStatusMessage("No agents available")
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      return
    } else if (targetAvailableAgents.length === 1) {
      selectedAgents = [targetAvailableAgents[0]]
    } else {
      const agents = await popupManager.launchAgentChoicePopup(targetProjectRoot)
      if (agents === null) {
        return
      }
      if (agents.length === 0) {
        setStatusMessage("Select at least one agent")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        return
      }
      selectedAgents = agents
    }

    // Prompt input
    const promptValue = await popupManager.launchNewPanePopup(targetProjectRoot)
    if (!promptValue) return

    try {
      setIsCreatingPane(true)
      setStatusMessage(
        selectedAgents.length > 1
          ? `Attaching ${selectedAgents.length} agents...`
          : "Attaching agent..."
      )

      const { Orchestrator } = await import("../orchestration/orchestrator.js")
      const { createLocalPaneBackend } = await import("../orchestration/localPaneBackend.js")

      const existingWorktreeBase = {
        slug: selectedPane.slug,
        worktreePath: selectedPane.worktreePath!,
        branchName: selectedPane.branchName || selectedPane.slug,
      }

      const lanes = selectedAgents.map((agent) => ({
        id: `${agent}-attach`,
        mode: "shared-worktree" as const,
        agent,
        existingWorktree: existingWorktreeBase,
      }))

      const backend = createLocalPaneBackend({
        projectName: selectedPane.projectName || path.basename(targetProjectRoot),
        sessionProjectRoot: projectRoot,
        sessionConfigPath: panesFile,
        basePanes: panes,
        availableAgents: targetAvailableAgents,
        persistReusedPane: async (_pane, previousPanes, panesToPersist) => {
          await savePanes(panesToPersist, previousPanes)
        },
        persistOrchestrationMetadata: async (originatingPane, nextPane) => {
          await savePanes([nextPane], [originatingPane])
          return nextPane
        },
      })
      const orchestrator = new Orchestrator({ executeLane: backend.execute })

      const result = await orchestrator.execute({
        taskId: `attach-${Date.now()}`,
        projectRoot: targetProjectRoot,
        prompt: promptValue,
        lanes,
      })

      const createdPanes = result.lanes.flatMap((lane) =>
        lane.status === "completed" && lane.pane ? [lane.pane] : []
      )
      const failures = result.lanes.filter((lane) => lane.status === "failed")

      if (createdPanes.length > 0 || failures.length > 0) {
        // createPane makes each pane durable while its reuse reservation is
        // held. Reload rather than replaying this stale React snapshot over
        // the cross-process registry.
        await loadPanes()
      }

      if (failures.length === 0) {
        setStatusMessage(
          `Attached ${createdPanes.length} agent${createdPanes.length === 1 ? "" : "s"} to ${getPaneDisplayName(selectedPane)}`
        )
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } else if (createdPanes.length === 0) {
        setStatusMessage(
          `Failed to attach agents: ${failures.map((f) => f.id).join(", ")}`
        )
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      } else {
        setStatusMessage(
          `Attached ${createdPanes.length}/${selectedAgents.length} agents to ${getPaneDisplayName(selectedPane)} (${failures.length} failed)`
        )
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    } catch (error: any) {
      setStatusMessage(`Failed to attach agent: ${error.message}`)
      setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
    } finally {
      setIsCreatingPane(false)
    }
  }

  const isInteractionBlocked = () =>
    ignoreInput
    || isCreatingPane
    || runningCommand
    || isUpdating
    || isLoading
    || showFileCopyPrompt
    || showCommandPrompt !== null
    || inlineRename !== null

  const reopenClosedWorktreesInProject = async (targetProjectRoot: string) => {
    const activeSlugs = panes
      .filter((pane) => sameSidebarProjectRoot(getPaneProjectRoot(pane, projectRoot), targetProjectRoot))
      .map((pane) => pane.slug)
    const popupState = {
      includeWorktrees: true,
      includeLocalBranches: true,
      includeRemoteBranches: true,
      remoteLoaded: false,
      filterQuery: "",
    }
    const resumableBranches = await trackProjectActivity(
      async () => getResumableBranches(targetProjectRoot, activeSlugs, {
        includeRemoteBranches: false,
      }),
      targetProjectRoot
    )

    const result = await popupManager.launchReopenWorktreePopup(
      resumableBranches,
      targetProjectRoot,
      popupState,
      activeSlugs
    )
    if (!result) {
      return
    }

    await handleReopenWorktree({
      branchName: result.candidate.branchName,
      slug: result.candidate.slug,
      path: result.candidate.path,
      lastModified: result.candidate.lastModified
        ? new Date(result.candidate.lastModified)
        : undefined,
      hasUncommittedChanges: result.candidate.hasUncommittedChanges,
      hasWorktree: result.candidate.hasWorktree,
      hasLocalBranch: result.candidate.hasLocalBranch,
      hasRemoteBranch: result.candidate.hasRemoteBranch,
      isRemote: result.candidate.isRemote,
    }, targetProjectRoot)
  }

  const executePaneShortcut = async (
    shortcut: RemotePaneActionShortcut,
    selectedPane: PsychePane,
    options: { anchorMenuToPane?: boolean } = {}
  ) => {
    switch (shortcut) {
      case "a":
        await attachAgentsToPane(selectedPane)
        return
      case "b":
        await handleCreateChildWorktree(selectedPane)
        return
      case "f":
        await openFileBrowserInWorktree(selectedPane)
        return
      case "A":
        await openTerminalInWorktree(selectedPane)
        return
      case "m":
        await openPaneMenu(selectedPane, {
          anchorToPane: options.anchorMenuToPane,
        })
        return
      case "h":
        await togglePaneVisibility(selectedPane)
        return
      case "H":
        await toggleOtherPanesVisibility(selectedPane)
        return
      case "P":
        await toggleProjectPanesVisibility(getPaneProjectRoot(selectedPane, projectRoot))
        return
      case "r":
        await reopenClosedWorktreesInProject(getPaneProjectRoot(selectedPane, projectRoot))
        return
      case "S":
        if (!isDevMode) {
          setStatusMessage("Source switching is only available in DEV mode")
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
          return
        }
        await setDevSourceFromPane(selectedPane)
        return
      case "e":
        startPaneInlineRename(selectedPane)
        return
      case "j":
        StateManager.getInstance().setDebugMessage(
          `Jumping to pane: ${getPaneDisplayName(selectedPane)}`
        )
        setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        await actionSystem.executeAction(PaneAction.VIEW, selectedPane)
        return
      case "x":
        StateManager.getInstance().setDebugMessage(
          `Closing pane: ${getPaneDisplayName(selectedPane)}`
        )
        setTimeout(() => StateManager.getInstance().setDebugMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        await actionSystem.executeAction(PaneAction.CLOSE, selectedPane)
        return
    }
  }

  const remoteDrainRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    const drainQueuedRemoteActions = async () => {
      const sessionName = getCurrentTmuxSessionName()
      if (!sessionName) {
        return
      }

      const queuedActions = await drainRemotePaneActions(sessionName)
      if (queuedActions.length === 0) {
        return
      }

      for (const action of queuedActions) {
        if (isInteractionBlocked()) {
          setStatusMessage(`psyche is busy; ignored remote pane action ${action.shortcut}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
          continue
        }

        const paneIndex = panes.findIndex((pane) => pane.paneId === action.targetPaneId)
        if (paneIndex === -1) {
          setStatusMessage(`Focused pane is not managed by psyche: ${action.targetPaneId}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
          continue
        }

        setSelectedIndex(paneIndex)
        await executePaneShortcut(action.shortcut, panes[paneIndex], {
          anchorMenuToPane: true,
        })
      }
    }

    const queueDrain = () => {
      remoteDrainRef.current = remoteDrainRef.current
        .then(drainQueuedRemoteActions)
        .catch((error: any) => {
          setStatusMessage(`Failed to process remote pane action: ${error?.message || String(error)}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
        })
      return remoteDrainRef.current
    }

    const handleRemoteSignal = () => {
      void queueDrain()
    }

    void queueDrain()
    process.on("psyche-external-command-signal" as any, handleRemoteSignal)

    return () => {
      process.off("psyche-external-command-signal" as any, handleRemoteSignal)
    }
  }, [
    actionSystem,
    handleCreateChildWorktree,
    handleReopenWorktree,
    ignoreInput,
    inlineRename,
    isCreatingPane,
    isDevMode,
    isLoading,
    isUpdating,
    panes,
    popupManager,
    projectRoot,
    runCommandInternal,
    runningCommand,
    setDevSourceFromPane,
    setSelectedIndex,
    setStatusMessage,
    showCommandPrompt,
    showFileCopyPrompt,
  ])

  useInput(async (input: string, key: any) => {
    // Ignore input temporarily after popup operations (prevents buffered keys from being processed)
    if (ignoreInput) {
      return
    }

    // SGR mouse events (\x1b[<button;col;rowM/m) must be fully consumed here
    // — `handleSidebarMousePress` only acts on primary *press* events, so
    // releases / motion / non-primary buttons would otherwise fall through
    // and arrive at the inline-rename handler as garbage characters
    // (visible as random "M" / "m" / digits typed into the rename input).
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(input)) {
      await handleSidebarMousePress(input)
      return
    }

    if (await handleInlineRenameInput(input, key)) {
      return
    }

    // Colon-command accumulator: `:pair` and `:devices`
    if (colonBufferRef.current !== null) {
      if (key.escape) {
        colonBufferRef.current = null
        setStatusMessage("")
        return
      }
      if (key.backspace || key.delete || input === "\x7f" || input === "\x08") {
        if (colonBufferRef.current.length > 0) {
          colonBufferRef.current = colonBufferRef.current.slice(0, -1)
        } else {
          colonBufferRef.current = null
          setStatusMessage("")
        }
        return
      }
      if (key.return) {
        const cmd = colonBufferRef.current.trim()
        colonBufferRef.current = null
        setStatusMessage("")
        if (cmd === "pair") {
          await handlePair()
        } else if (cmd === "devices") {
          await handleDevices()
        } else if (cmd.length > 0) {
          setStatusMessage(`Unknown command: :${cmd}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
        }
        return
      }
      // Accumulate printable chars
      if (input.length === 1 && !key.ctrl && !key.meta) {
        colonBufferRef.current += input
      }
      return
    }

    // Enter colon-command mode
    if (input === ":") {
      colonBufferRef.current = ""
      return
    }

    // Handle Ctrl+C for quit confirmation (must be first, before any other checks)
    if (key.ctrl && input === "c") {
      if (quitConfirmMode) {
        // Second Ctrl+C - actually quit
        cleanExit()
      } else {
        // First Ctrl+C - show confirmation
        setQuitConfirmMode(true)
        // Reset after 3 seconds if user doesn't press Ctrl+C again
        setTimeout(() => {
          setQuitConfirmMode(false)
        }, 3000)
      }
      return
    }

    if (isCreatingPane || runningCommand || isUpdating || isLoading) {
      // Disable input while performing operations or loading
      return
    }

    if (input === "z" && onToggleSidePanel) {
      onToggleSidePanel()
      return
    }

    // Handle quit confirm mode - ESC cancels it
    if (quitConfirmMode) {
      if (key.escape) {
        setQuitConfirmMode(false)
        return
      }
      // Allow other inputs to continue (don't return early)
    }

    if (showFileCopyPrompt) {
      if (input === "y" || input === "Y") {
        setShowFileCopyPrompt(false)
        const selectedPane = panes[selectedIndex]
        if (selectedPane && selectedPane.worktreePath && currentCommandType) {
          const paneProjectRoot = getPaneProjectRoot(selectedPane, projectRoot)
          await copyNonGitFiles(selectedPane.worktreePath, paneProjectRoot)

          // Mark as not first run and continue with command
          const newSettings = {
            ...projectSettings,
            [currentCommandType === "test" ? "firstTestRun" : "firstDevRun"]:
              true,
          }
          await saveSettings(newSettings)

          // Now run the actual command
          await runCommandInternal(currentCommandType, selectedPane)
        }
        setCurrentCommandType(null)
      } else if (input === "n" || input === "N" || key.escape) {
        setShowFileCopyPrompt(false)
        const selectedPane = panes[selectedIndex]
        if (selectedPane && currentCommandType) {
          // Mark as not first run and continue without copying
          const newSettings = {
            ...projectSettings,
            [currentCommandType === "test" ? "firstTestRun" : "firstDevRun"]:
              true,
          }
          await saveSettings(newSettings)

          // Now run the actual command
          await runCommandInternal(currentCommandType, selectedPane)
        }
        setCurrentCommandType(null)
      }
      return
    }

    if (showCommandPrompt) {
      if (key.escape) {
        setShowCommandPrompt(null)
        setCommandInput("")
      } else if (key.return) {
        if (commandInput.trim() === "") {
          // If empty, suggest a default command based on package manager
          const suggested = await suggestCommand(showCommandPrompt)
          if (suggested) {
            setCommandInput(suggested)
          }
        } else {
          // User provided manual command
          const newSettings = {
            ...projectSettings,
            [showCommandPrompt === "test" ? "testCommand" : "devCommand"]:
              commandInput.trim(),
          }
          await saveSettings(newSettings)
          const selectedPane = panes[selectedIndex]
          if (selectedPane) {
            // Check if first run
            const isFirstRun =
              showCommandPrompt === "test"
                ? !projectSettings.firstTestRun
                : !projectSettings.firstDevRun
            if (isFirstRun) {
              setCurrentCommandType(showCommandPrompt)
              setShowCommandPrompt(null)
              setShowFileCopyPrompt(true)
            } else {
              await runCommandInternal(showCommandPrompt, selectedPane)
              setShowCommandPrompt(null)
              setCommandInput("")
            }
          } else {
            setShowCommandPrompt(null)
            setCommandInput("")
          }
        }
      }
      return
    }

    if (input === "D" && showStartupPrimer) {
      completeStartupPrimer?.("dismissed")
      return
    }

    // Handle directional navigation with spatial awareness based on card grid layout
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      let targetIndex: number | null = null

      if (key.upArrow) {
        targetIndex = findCardInDirection(selectedIndex, "up")
      } else if (key.downArrow) {
        targetIndex = findCardInDirection(selectedIndex, "down")
      } else if (key.leftArrow) {
        targetIndex = findCardInDirection(selectedIndex, "left")
      } else if (key.rightArrow) {
        targetIndex = findCardInDirection(selectedIndex, "right")
      }

      if (targetIndex !== null) {
        setSelectedIndex(targetIndex)
      }
      return
    }

    const selectedPane = selectedIndex < panes.length ? panes[selectedIndex] : undefined
    if (selectedPane && isDesktopUsePane(selectedPane) && ["g", "o", "v", "y", "X"].includes(input)) {
      const quickAction: DesktopUseQuickAction = input === "g"
        ? "screenshot"
        : input === "o"
          ? "inspect"
          : input === "v"
            ? "permissions"
            : input === "y"
              ? "approve"
              : "deny"
      await sendDesktopUseQuickAction(selectedPane, quickAction)
      return
    }

    if (
      selectedIndex < panes.length
      && ["a", "b", "f", "A", "m"].includes(input)
    ) {
      await executePaneShortcut(input as RemotePaneActionShortcut, panes[selectedIndex])
      return
    } else if (input === "s") {
      // Open settings popup
      const result = await popupManager.launchSettingsPopup(async () => {
        // Launch hooks popup
        await popupManager.launchHooksPopup(async () => {
          await launchHooksAuthoringSession()
        }, getActiveProjectRoot())
      }, getActiveProjectRoot(), sidebarProjects)
      if (result) {
        try {
          const activeProjectRoot = getActiveProjectRoot()
          const projectSettingsManager = new SettingsManager(activeProjectRoot)
          const updates = Array.isArray((result as any).updates)
            ? (result as any).updates
            : [result]

          let savedCount = 0
          let layoutBoundsUpdated = false
          let lastScope: "global" | "project" | "session" | null = null
          let themeSettingsChanged = false
          let effectiveSidebarProjects = sidebarProjects
          const resolveSavedProjectTheme = (targetProjectRoot: string) =>
            new SettingsManager(targetProjectRoot).getSettings().colorTheme

          for (const update of updates) {
            if (
              !update
              || typeof update.key !== "string"
            ) {
              continue
            }

            if (update.scope === "session") {
              if (update.key !== SIDEBAR_PROJECT_COLOR_THEME_SETTING_KEY) {
                continue
              }

              const updatedProjects = setSidebarProjectColorThemeSettingValue(
                effectiveSidebarProjects,
                activeProjectRoot,
                update.value,
                resolveSavedProjectTheme
              )
              await saveSidebarProjects(updatedProjects)
              effectiveSidebarProjects = updatedProjects
              refreshPsycheSettings(activeProjectRoot)
              savedCount += 1
              lastScope = update.scope
              themeSettingsChanged = true
              continue
            }

            if (update.scope !== "global" && update.scope !== "project") {
              continue
            }

            const resolvedUpdateKey = update.key === DEFAULT_COLOR_THEME_SETTING_KEY
              ? "colorTheme"
              : update.key
            projectSettingsManager.updateSetting(
              resolvedUpdateKey as keyof import("../types.js").PsycheSettings,
              update.value,
              update.scope
            )
            refreshPsycheSettings(activeProjectRoot)
            savedCount += 1
            lastScope = update.scope
            if (resolvedUpdateKey === "colorTheme") {
              themeSettingsChanged = true
            }

            if (resolvedUpdateKey === "minPaneWidth" || resolvedUpdateKey === "maxPaneWidth") {
              layoutBoundsUpdated = true
            }
          }

          if (themeSettingsChanged) {
            const syncedPanes = syncPaneColorThemes(
              panes,
              effectiveSidebarProjects,
              projectRoot
            )
            if (syncedPanes !== panes) {
              await savePanes(syncedPanes, panes)
            }
          }

          if (layoutBoundsUpdated) {
            queueLayoutRefresh()
          }

          if (savedCount > 0) {
            const statusMessage =
              savedCount === 1
                ? `Setting saved (${lastScope})`
                : `${savedCount} settings saved`
            setStatusMessage(statusMessage)
            setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
          }
        } catch (error: any) {
          setStatusMessage(`Failed to save setting: ${error?.message || String(error)}`)
          setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
        }
      }
    } else if (input === "l") {
      // Open logs popup
      await popupManager.launchLogsPopup(getActiveProjectRoot())
    } else if (input === "u") {
      await handleRitualMenu()
    } else if (input === "h") {
      if (selectedIndex < panes.length) {
        await executePaneShortcut("h", panes[selectedIndex])
      } else {
        setStatusMessage("Select a pane to toggle visibility")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      }
    } else if (input === "H") {
      if (selectedIndex < panes.length) {
        await executePaneShortcut("H", panes[selectedIndex])
      } else {
        setStatusMessage("Select a pane to toggle the others")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      }
    } else if (input === "P") {
      if (selectedIndex < panes.length) {
        await executePaneShortcut("P", panes[selectedIndex])
      } else {
        await toggleProjectPanesVisibility()
      }
    } else if (input === "e") {
      startInlineRenameForSelection()
      return
    } else if (input === "?") {
      completeStartupPrimerAfterAction()
      // Open keyboard shortcuts popup
      const shortcutsAction = await popupManager.launchShortcutsPopup(
        !!controlPaneId,
        getActiveProjectRoot()
      )
      if (shortcutsAction === "hooks") {
        await launchHooksAuthoringSession()
      }
    } else if (input === "L" && controlPaneId) {
      // Reset layout to sidebar configuration (Shift+L)
      try {
        await enforceControlPaneSize(controlPaneId, sidePanelWidth, { forceLayout: true })
        setStatusMessage("Layout reset")
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_SHORT)
      } catch (error: any) {
        setStatusMessage(`Failed to reset layout: ${error?.message || String(error)}`)
        setTimeout(() => setStatusMessage(""), STATUS_MESSAGE_DURATION_LONG)
      }
    } else if (input === "T") {
      // Demo toasts (Shift+T) - cycles through different types
      const stateManager = StateManager.getInstance()
      const demos = [
        { msg: "Pane created successfully", severity: "success" as const },
        { msg: "Failed to merge: conflicts detected", severity: "error" as const },
        { msg: "Warning: API key not configured", severity: "warning" as const },
        { msg: "This is a longer informational message that will wrap to multiple lines if needed to demonstrate how toasts handle longer content", severity: "info" as const },
      ]
      // Queue all demo toasts
      demos.forEach(demo => stateManager.showToast(demo.msg, demo.severity))
    } else if (input === "q") {
      cleanExit()
    } else if (isDevMode && input === "S" && selectedIndex < panes.length) {
      await executePaneShortcut("S", panes[selectedIndex])
      return
    } else if (input === "r") {
      await reopenClosedWorktreesInProject(getActiveProjectRoot())
      return
    } else if (
      !isLoading &&
      (
        input === "p" ||
        input === "N"
      )
    ) {
      // Add a project to the sidebar ([p], with Shift+N fallback)
      await handleAddProjectToSidebar()
      return
    } else if (!isLoading && input === "R") {
      await handleRemoveProjectFromSidebar(getActiveProjectRoot())
      return
    } else if (!isLoading && input === "n") {
      completeStartupPrimerAfterAction()
      await handleCreateAgentPane(getActiveProjectRoot())
      return
    } else if (!isLoading && input === "t") {
      completeStartupPrimerAfterAction()
      await handleCreateTerminalPane(getActiveProjectRoot())
      return
    } else if (!isLoading && input === "d") {
      completeStartupPrimerAfterAction()
      await handleCreateDesktopUsePane(getActiveProjectRoot())
      return
    } else if (!isLoading && input === "o") {
      completeStartupPrimerAfterAction()
      await handleOpenCovenSession(getActiveProjectRoot())
      return
    } else if (
      !isLoading &&
      key.return &&
      !!getProjectActionByIndex(projectActionItems, selectedIndex)
    ) {
      const selectedAction = getProjectActionByIndex(projectActionItems, selectedIndex)!
      completeStartupPrimerAfterAction()
      if (selectedAction.kind === "new-agent") {
        await handleCreateAgentPane(selectedAction.projectRoot)
      } else if (selectedAction.kind === "terminal") {
        await handleCreateTerminalPane(selectedAction.projectRoot)
      } else if (selectedAction.kind === "remove-project") {
        await handleRemoveProjectFromSidebar(selectedAction.projectRoot)
      }
      return
    } else if (
      selectedIndex < panes.length
      && (input === "j" || input === "x")
    ) {
      await executePaneShortcut(input as RemotePaneActionShortcut, panes[selectedIndex])
      return
    } else if (key.return && selectedIndex < panes.length) {
      // Open pane menu for selected pane
      await openPaneMenu(panes[selectedIndex])
      return
    }
  })
}
