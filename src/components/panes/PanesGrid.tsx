import React, { memo, useMemo } from "react"
import { Box, Text } from "ink"
import stringWidth from "string-width"
import type {
  PsychePane,
  PsycheThemeName,
  SidebarProject,
} from "../../types.js"
import type { AgentStatusMap } from "../../hooks/useAgentStatus.js"
import PaneCard from "./PaneCard.js"
import CovenSessionsPanel from "./CovenSessionsPanel.js"
import DesktopUsePanePanel from "./DesktopUsePanePanel.js"
import { COLORS } from "../../theme/colors.js"
import {
  getPsycheThemeAccent,
  getPsycheThemeActiveBorderHex,
} from "../../theme/colors.js"
import Spinner from "../indicators/Spinner.js"
import {
  buildProjectActionLayout,
  type ProjectActionItem,
} from "../../utils/projectActions.js"
import { isActiveDevSourcePath } from "../../utils/devSource.js"
import InlineNameEditor from "../ui/InlineNameEditor.js"
import type { InlineRenameState } from "../../utils/inlineRename.js"
import type { CovenSessionsLoadState } from "../../utils/covenSessions.js"
import type { DesktopUseStateMap } from "../../hooks/useCovenDesktopUse.js"

interface PanesGridProps {
  panes: PsychePane[]
  selectedIndex: number
  activeProjectRoot?: string
  isLoading: boolean
  themeName: string
  projectThemeByRoot: Map<string, PsycheThemeName>
  agentStatuses?: AgentStatusMap
  activeDevSourcePath?: string
  sidebarProjects: SidebarProject[]
  fallbackProjectRoot: string
  fallbackProjectName: string
  isProjectBusy?: (projectRoot: string) => boolean
  inlineRename?: InlineRenameState | null
  covenSessionsState?: CovenSessionsLoadState
  desktopUseStates?: DesktopUseStateMap
}

const PROJECT_BUSY_FRAMES = ['◴', '◷', '◶', '◵']
const HEADER_WIDTH = 40

const PanesGrid: React.FC<PanesGridProps> = memo(({
  panes,
  selectedIndex,
  activeProjectRoot: activeProjectRootProp,
  isLoading,
  themeName,
  projectThemeByRoot,
  agentStatuses,
  activeDevSourcePath,
  sidebarProjects,
  fallbackProjectRoot,
  fallbackProjectName,
  isProjectBusy,
  inlineRename,
  covenSessionsState,
  desktopUseStates,
}) => {
  const actionLayout = useMemo(
    () => buildProjectActionLayout(
      panes,
      sidebarProjects,
      fallbackProjectRoot,
      fallbackProjectName
    ),
    [panes, sidebarProjects, fallbackProjectRoot, fallbackProjectName]
  )
  const paneGroups = actionLayout.groups

  const actionsByProject = useMemo(() => {
    const map = new Map<
      string,
      {
        newAgent?: ProjectActionItem
        terminal?: ProjectActionItem
        removeProject?: ProjectActionItem
      }
    >()
    for (const action of actionLayout.actionItems) {
      const entry = map.get(action.projectRoot) || {}
      if (action.kind === "new-agent") {
        entry.newAgent = action
      } else if (action.kind === "terminal") {
        entry.terminal = action
      } else {
        entry.removeProject = action
      }
      map.set(action.projectRoot, entry)
    }
    return map
  }, [actionLayout.actionItems])

  // Determine which project group the current selection belongs to
  const activeProjectRoot = useMemo(() => {
    if (activeProjectRootProp) {
      return activeProjectRootProp
    }

    for (const group of paneGroups) {
      if (group.panes.some((entry) => entry.index === selectedIndex)) {
        return group.projectRoot
      }
    }

    // Check if selection is an action item
    const selectedAction = actionLayout.actionItems.find(a => a.index === selectedIndex)
    return selectedAction?.projectRoot
  }, [activeProjectRootProp, selectedIndex, paneGroups, actionLayout.actionItems])

  const getProjectThemeName = (projectRoot: string): PsycheThemeName =>
    projectThemeByRoot.get(projectRoot)
    || themeName as PsycheThemeName

  const renderActionRow = (
    actions: ProjectActionItem[],
    selIdx: number,
    isActiveGroup: boolean
  ) => {
    const actionThemeName = getProjectThemeName(actions[0]?.projectRoot || fallbackProjectRoot)
    const actionAccent = getPsycheThemeAccent(actionThemeName)

    const renderLabel = (action: ProjectActionItem) => {
      const isSelected = selIdx === action.index
      const showHotkey = isActiveGroup && !!action.hotkey
      const baseColor = action.kind === "remove-project" ? "red" : COLORS.border
      const color = isSelected ? actionAccent : baseColor

      if (action.kind === "new-agent") {
        return showHotkey
          ? <Text color={color} bold={isSelected}><Text color={COLORS.accent}>[n]</Text>ew agent</Text>
          : <Text color={color} bold={isSelected}>new agent</Text>
      }

      if (action.kind === "terminal") {
        return showHotkey
          ? <Text color={color} bold={isSelected}><Text color={COLORS.accent}>[t]</Text>erminal</Text>
          : <Text color={color} bold={isSelected}>terminal</Text>
      }

      return showHotkey
        ? <Text color={color} bold={isSelected}><Text color={COLORS.accent}>[R]</Text>emove</Text>
        : <Text color={color} bold={isSelected}>remove</Text>
    }

    return (
      <Box width={40} justifyContent="flex-end">
        {actions.map((action, index) => (
          <React.Fragment key={`${action.projectRoot}-${action.kind}`}>
            {index > 0 && <Text color={COLORS.border}>{"  "}</Text>}
            {renderLabel(action)}
          </React.Fragment>
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {paneGroups.map((group, groupIndex) => (
        <Box key={group.projectRoot} flexDirection="column">
          {(() => {
            const isActive = activeProjectRoot === group.projectRoot
            const groupThemeName = getProjectThemeName(group.projectRoot)
            const accentColor = getPsycheThemeAccent(groupThemeName)
            const busy = isProjectBusy?.(group.projectRoot) ?? false
            const spinnerWidth = busy ? 2 : 0
            const isEditingProjectName = inlineRename?.target.kind === "project"
              && inlineRename.target.projectRoot === group.projectRoot
            const nameSection = `⣿⣿ ${isEditingProjectName ? inlineRename.value : group.projectName} `
            const remaining = Math.max(
              0,
              HEADER_WIDTH - stringWidth(nameSection) - spinnerWidth
            )
            const fill = "⣿".repeat(remaining)
            const fillColor = isActive ? accentColor : COLORS.border
            const titleColor = isActive
              ? getPsycheThemeActiveBorderHex(groupThemeName)
              : COLORS.unselected
            return (
              <Text>
                <Text color={accentColor}>⣿⣿</Text>
                <Text> </Text>
                {isEditingProjectName ? (
                  <InlineNameEditor
                    value={inlineRename.value}
                    cursor={inlineRename.cursor}
                    maxWidth={Math.max(8, HEADER_WIDTH - 6 - spinnerWidth)}
                    color={accentColor}
                  />
                ) : (
                  <Text color={titleColor}>{group.projectName}</Text>
                )}
                <Text> </Text>
                {busy && (
                  <>
                    <Spinner
                      color={accentColor}
                      frames={PROJECT_BUSY_FRAMES}
                      interval={70}
                    />
                    <Text> </Text>
                  </>
                )}
                <Text color={fillColor}>{fill}</Text>
              </Text>
            )
          })()}

          {covenSessionsState && (
            <CovenSessionsPanel
              projectRoot={group.projectRoot}
              state={covenSessionsState}
              isActive={activeProjectRoot === group.projectRoot}
              themeName={getProjectThemeName(group.projectRoot)}
            />
          )}

          {group.panes.map((entry) => {
            const pane = entry.pane
            // Apply the runtime status to the pane
            const paneWithStatus = {
              ...pane,
              agentStatus: agentStatuses?.get(pane.id) || pane.agentStatus,
            }
            const paneIndex = entry.index
            const isSelected = selectedIndex === paneIndex
            const isDevSource = isActiveDevSourcePath(
              pane.worktreePath,
              activeDevSourcePath
            )

            return (
              <React.Fragment key={pane.id}>
                <PaneCard
                  pane={paneWithStatus}
                  isDevSource={isDevSource}
                  selected={isSelected}
                  themeName={themeName}
                  projectThemeName={getProjectThemeName(group.projectRoot)}
                  inlineRename={inlineRename}
                />
                {pane.type === "desktop-use" && (
                  <DesktopUsePanePanel
                    state={desktopUseStates?.get(pane.id)}
                    selected={isSelected}
                    themeName={getProjectThemeName(group.projectRoot)}
                  />
                )}
              </React.Fragment>
            )
          })}

          {!isLoading && actionLayout.multiProjectMode && (() => {
            const groupActions = actionsByProject.get(group.projectRoot)
            const actions = [
              groupActions?.newAgent,
              groupActions?.terminal,
              groupActions?.removeProject,
            ].filter((action): action is ProjectActionItem => !!action)

            if (actions.length === 0) {
              return null
            }

            return renderActionRow(
              actions,
              selectedIndex,
              activeProjectRoot === group.projectRoot
            )
          })()}

          {groupIndex < paneGroups.length - 1 && <Text>{" "}</Text>}
        </Box>
      ))}

      {!isLoading && !actionLayout.multiProjectMode && (() => {
        const actions = actionLayout.actionItems.filter(
          (item) => item.kind === "new-agent" || item.kind === "terminal"
        )

        if (actions.length === 0) {
          return null
        }

        return renderActionRow(actions, selectedIndex, true)
      })()}
    </Box>
  )
})

export default PanesGrid
