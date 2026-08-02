#!/usr/bin/env node
/**
 * Keyboard Shortcuts Popup - Shows all available keyboard shortcuts
 */

import React from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { PopupWrapper, writeCancelAndExit, writeSuccessAndExit } from './shared/index.js';
import { POPUP_CONFIG } from './config.js';

interface ShortcutsPopupAppProps {
  resultFile: string;
  hasSidebarLayout: boolean;
  isDevMode: boolean;
}

interface ShortcutActionResult {
  action?: 'hooks';
}

export const ShortcutsPopupApp: React.FC<ShortcutsPopupAppProps> = ({
  resultFile,
  hasSidebarLayout,
  isDevMode,
}) => {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'g') {
      writeSuccessAndExit<ShortcutActionResult>(resultFile, { action: 'hooks' }, exit);
      return;
    }

    if (key.escape || input === 'q' || input === '?') {
      writeCancelAndExit(resultFile, exit);
    }
  });

  const shortcuts = [
    { key: 'Alt+Shift+M', description: 'Open the pane menu for the focused tmux pane' },
    { key: 'j', description: 'Jump to selected pane' },
    { key: 'm', description: 'Open pane menu' },
    { key: 'x', description: 'Close selected pane' },
    { key: 'h', description: 'Hide/show selected pane' },
    { key: 'H', description: 'Hide/show all other panes' },
    { key: 'P', description: 'Show only the selected project, then show all' },
    { key: 'a', description: 'Add agent to worktree' },
    { key: 'b', description: 'Create child worktree' },
    { key: 'f', description: 'Open read-only file browser' },
    { key: 'A', description: 'Add terminal to worktree' },
    { key: 'n', description: 'New agent pane in selected project' },
    { key: 't', description: 'New terminal pane in selected project' },
    { key: 'd', description: 'New desktop-use Coven pane' },
    { key: 'o', description: 'Open latest Coven session in selected project' },
    { key: 'g/o/v/y/X', description: 'Desktop-use quick actions when selected' },
    { key: 'u', description: 'Open or manage rituals' },
    { key: 'z', description: 'Show/hide side panel' },
    { key: 'click', description: 'Select a pane/thread/worktree row' },
    { key: 'top-left click', description: 'Show/hide side panel' },
    { key: 'e', description: 'Edit selected pane or project name inline' },
    { key: 'double-click', description: 'Edit a pane/thread/worktree or project name inline' },
    { key: 'p', description: 'Add project to sidebar' },
    { key: 'R', description: 'Remove selected empty project from sidebar' },
    { key: 'r', description: 'Reopen closed worktree' },
    ...(isDevMode
      ? [{ key: 'S', description: '[DEV] Toggle source pane' }]
      : []),
    { key: 'l', description: 'View logs' },
    { key: 's', description: 'Open settings' },
    { key: 'g', description: 'Manage hooks with AI (from this popup)' },
    ...(hasSidebarLayout ? [{ key: 'L', description: 'Reset sidebar layout' }] : []),
    { key: 'q', description: 'Quit psyche' },
    { key: '↑↓←→', description: 'Navigate panes' },
    { key: 'Enter', description: 'Select / open menu' },
    { key: 'Ctrl-b ←', description: 'Return focus from a pane to the psyche sidebar' },
    { key: 'macOS Option', description: 'Terminal: Use Option as Meta; iTerm2: Option Key = Esc+' },
    { key: 'Esc', description: 'Cancel / close' },
    { key: '?', description: 'Show this help' },
  ];

  return (
    <PopupWrapper resultFile={resultFile} allowEscapeToCancel={false}>
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color={POPUP_CONFIG.titleColor}>Keyboard Shortcuts</Text>
        </Box>

        {shortcuts.map((shortcut, index) => (
          <Box key={index} marginBottom={0}>
            <Box width={16}>
              <Text color={POPUP_CONFIG.titleColor} bold>[{shortcut.key}]</Text>
            </Box>
            <Text>{shortcut.description}</Text>
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor>Alt+Shift+M opens the focused pane menu when your terminal sends Alt/Meta. Press g for hooks, or Esc/? to close</Text>
        </Box>
      </Box>
    </PopupWrapper>
  );
};

// Main entry point
const main = async () => {
  const resultFile = process.argv[2];
  if (!resultFile) {
    console.error('Error: Result file path required');
    process.exit(1);
  }

  const dataFile = process.argv[3];
  if (!dataFile) {
    console.error('Error: Data file path required');
    process.exit(1);
  }

  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    render(<ShortcutsPopupApp
      resultFile={resultFile}
      hasSidebarLayout={data.hasSidebarLayout || false}
      isDevMode={data.isDevMode === true}
    />);
  } catch (error) {
    console.error('Failed to read data file:', error);
    process.exit(1);
  }
};

const entryPointHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPointHref) {
  void main();
}
