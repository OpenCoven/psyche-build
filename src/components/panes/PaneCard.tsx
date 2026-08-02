import React, { memo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { PsychePane, PsycheThemeName } from '../../types.js';
import { COLORS } from '../../theme/colors.js';
import { getPsycheThemeAccent } from '../../theme/colors.js';
import { getAgentShortLabel } from '../../utils/agentLaunch.js';
import { getPaneDisplayName } from '../../utils/paneTitle.js';
import InlineNameEditor from '../ui/InlineNameEditor.js';
import type { InlineRenameState } from '../../utils/inlineRename.js';

interface PaneCardProps {
  pane: PsychePane;
  isDevSource: boolean;
  selected: boolean;
  themeName?: string;
  projectThemeName?: PsycheThemeName;
  inlineRename?: InlineRenameState | null;
}

const ROW_WIDTH = 40;
const RIGHT_COLUMN_WIDTH = 10;
const LEFT_COLUMN_WIDTH = ROW_WIDTH - RIGHT_COLUMN_WIDTH;

const clipToWidth = (value: string, maxWidth: number): string => {
  if (maxWidth <= 0) return '';
  if (stringWidth(value) <= maxWidth) return value;

  let clipped = '';
  let currentWidth = 0;

  for (const char of value) {
    const charWidth = stringWidth(char);
    if (currentWidth + charWidth > maxWidth) {
      break;
    }
    clipped += char;
    currentWidth += charWidth;
  }

  return clipped;
};

const PaneCard: React.FC<PaneCardProps> = memo(({
  pane,
  isDevSource,
  selected,
  projectThemeName,
  inlineRename,
}) => {
  // Get status indicator
  const getStatusIcon = () => {
    if (pane.agentStatus === 'working') return { icon: '✻', color: COLORS.working };
    if (pane.agentStatus === 'analyzing') return { icon: '⟳', color: COLORS.analyzing };
    if (pane.agentStatus === 'waiting') return { icon: '△', color: COLORS.waiting };
    if (pane.testStatus === 'running') return { icon: '⧖', color: COLORS.warning };
    if (pane.testStatus === 'failed') return { icon: '✗', color: COLORS.error };
    if (pane.testStatus === 'passed') return { icon: '✓', color: COLORS.success };
    if (pane.devStatus === 'running') return { icon: '▶', color: COLORS.success };
    if (pane.type === 'desktop-use') return { icon: '⌘', color: COLORS.accent };
    return { icon: '◌', color: COLORS.border };
  };

  const status = getStatusIcon();
  const isFileBrowserPane = pane.type === 'shell' && pane.shellType === 'fb';
  const isDesktopUsePane = pane.type === 'desktop-use';
  const paneName = getPaneDisplayName(pane);
  const editingName = inlineRename?.target.kind === 'pane'
    && inlineRename.target.paneId === pane.id;

  // Right-aligned columns: [cc] = 4 chars, (ap) = 4 chars, space between = 1
  const hasAgent = pane.type === 'shell' || pane.type === 'desktop-use' || !!pane.agent;
  const agentTag = pane.type === 'desktop-use'
    ? 'du'
    : pane.type === 'shell'
      ? (pane.shellType || 'sh').substring(0, 2)
      : pane.agent ? getAgentShortLabel(pane.agent) : null;
  const apTag = pane.autopilot ? 'ap' : null;

  // Keep non-title segments fixed; only slug is allowed to clip.
  const prefix = selected ? '▸' : ' ';
  const statusText = `${status.icon} `;
  const attentionText = pane.needsAttention ? '! ' : '';
  const sourceText = isDevSource ? '★ ' : '';
  const hiddenText = pane.hidden ? ' (hidden)' : '';
  const agentText = hasAgent ? ` [${agentTag}]` : '     ';
  const autopilotText = apTag ? ` (${apTag})` : '     ';
  const shellPrefixText = isFileBrowserPane ? ' ' : isDesktopUsePane ? '⌘ ' : '';
  const fixedLeftWidth = stringWidth(prefix + statusText + attentionText + sourceText + shellPrefixText + hiddenText);
  const maxSlugWidth = Math.max(0, LEFT_COLUMN_WIDTH - fixedLeftWidth);
  const slugText = clipToWidth(paneName, maxSlugWidth);
  const projectSelectedColor = projectThemeName
    ? getPsycheThemeAccent(projectThemeName)
    : COLORS.selected;
  const paneSelectedColor = pane.colorTheme
    ? getPsycheThemeAccent(pane.colorTheme)
    : projectSelectedColor;
  const slugColor = isFileBrowserPane || isDesktopUsePane
    ? COLORS.accent
    : selected
      ? paneSelectedColor
      : COLORS.unselected;
  const shellTagColor = isFileBrowserPane
    ? COLORS.warning
    : pane.type === 'shell' || pane.type === 'desktop-use'
      ? COLORS.accent
      : COLORS.muted;

  return (
    <Box width={ROW_WIDTH}>
      <Box width={LEFT_COLUMN_WIDTH}>
        <Text color={selected ? paneSelectedColor : COLORS.border}>{prefix}</Text>
        <Text color={status.color}>{statusText}</Text>
        {pane.needsAttention && (
          <Text color={COLORS.warning}>{attentionText}</Text>
        )}
        {isDevSource && (
          <Text color={COLORS.accent}>{sourceText}</Text>
        )}
        {(isFileBrowserPane || isDesktopUsePane) && (
          <Text color={COLORS.accent}>{shellPrefixText}</Text>
        )}
        {editingName ? (
          <InlineNameEditor
            value={inlineRename.value}
            cursor={inlineRename.cursor}
            maxWidth={maxSlugWidth}
            color={paneSelectedColor}
          />
        ) : (
          <Text color={slugColor} bold={selected || isFileBrowserPane}>
            {slugText}
          </Text>
        )}
        {pane.hidden && (
          <Text color={COLORS.warning}>
            {hiddenText}
          </Text>
        )}
      </Box>
      <Box width={RIGHT_COLUMN_WIDTH} justifyContent="flex-end">
        {agentTag
          ? <Text color={shellTagColor}>{agentText}</Text>
          : <Text>{agentText}</Text>
        }
        {apTag
          ? <Text color={COLORS.success}>{autopilotText}</Text>
          : <Text>{autopilotText}</Text>
        }
      </Box>
    </Box>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.pane.id === nextProps.pane.id &&
    prevProps.pane.slug === nextProps.pane.slug &&
    prevProps.pane.displayName === nextProps.pane.displayName &&
    prevProps.pane.agentStatus === nextProps.pane.agentStatus &&
    prevProps.pane.needsAttention === nextProps.pane.needsAttention &&
    prevProps.pane.testStatus === nextProps.pane.testStatus &&
    prevProps.pane.devStatus === nextProps.pane.devStatus &&
    prevProps.pane.autopilot === nextProps.pane.autopilot &&
    prevProps.pane.hidden === nextProps.pane.hidden &&
    prevProps.pane.type === nextProps.pane.type &&
    prevProps.pane.shellType === nextProps.pane.shellType &&
    prevProps.pane.agent === nextProps.pane.agent &&
    prevProps.pane.colorTheme === nextProps.pane.colorTheme &&
    prevProps.isDevSource === nextProps.isDevSource &&
    prevProps.selected === nextProps.selected &&
    prevProps.themeName === nextProps.themeName &&
    prevProps.projectThemeName === nextProps.projectThemeName &&
    prevProps.inlineRename === nextProps.inlineRename
  );
});

export default PaneCard;
