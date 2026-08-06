import fs from 'fs/promises';
import type { PaneLayout, PsycheConfig, PsychePane } from '../types.js';
import {
  applyPaneLayoutMutation,
  type PaneLayoutMutation,
} from '../layout/PaneLayoutController.js';
import { TmuxService } from '../services/TmuxService.js';
import { LogService } from '../services/LogService.js';
import { StateManager } from '../shared/StateManager.js';
import { atomicWriteJson } from './atomicWrite.js';

export const SIDEBAR_WIDTH = 40;

function paneBindingSignature(panes: PsychePane[]): string {
  return panes
    .map((pane) => `${pane.id}:${pane.paneId}:${pane.hidden === true}`)
    .sort()
    .join('|');
}

export async function applyStoredPaneLayout(options: {
  panesFile: string;
  panes: PsychePane[];
  controlPaneId: string;
  terminalWidth: number;
  terminalHeight: number;
  mutation: PaneLayoutMutation;
}): Promise<PaneLayout> {
  const rawConfig = JSON.parse(await fs.readFile(options.panesFile, 'utf-8')) as PsycheConfig;
  if (Array.isArray(rawConfig)) {
    throw new Error('Pane layout requires an object-form config');
  }

  const tmuxService = TmuxService.getInstance();
  const hasVisibleContentPanes = options.panes.some((pane) => !pane.hidden);

  await tmuxService.resizePane(options.controlPaneId, { width: SIDEBAR_WIDTH });

  const { layout } = await applyPaneLayoutMutation({
    paneLayout: rawConfig.paneLayout,
    panes: options.panes,
    controlPaneId: options.controlPaneId,
    terminalWidth: options.terminalWidth,
    terminalHeight: options.terminalHeight,
    mutation: options.mutation,
    selectLayout: async (compiledLayout) => {
      if (!hasVisibleContentPanes) {
        return true;
      }

      await tmuxService.selectLayout(compiledLayout);
      return true;
    },
  });

  await tmuxService.refreshClient();

  const latestConfig = JSON.parse(await fs.readFile(options.panesFile, 'utf-8')) as PsycheConfig;
  if (Array.isArray(latestConfig)) {
    throw new Error('Pane layout requires an object-form config');
  }
  const latestPanes = Array.isArray(latestConfig.panes) ? latestConfig.panes : [];
  if (paneBindingSignature(latestPanes) !== paneBindingSignature(options.panes)) {
    throw new Error('Pane metadata changed while applying pane layout');
  }

  await atomicWriteJson(options.panesFile, {
    ...latestConfig,
    paneLayout: layout,
  });

  return layout;
}

/**
 * Temporary compatibility bridge for Task 4 call sites. It deliberately only
 * reconciles the persisted layout and never recreates the legacy grid.
 */
export async function recalculateAndApplyLayout(
  controlPaneId: string,
  _contentPaneIds: string[],
  terminalWidth: number,
  terminalHeight: number,
  _legacyConfig?: unknown,
  _legacyOptions?: unknown
): Promise<void> {
  const state = StateManager.getInstance().getState();
  if (!state.panesFile) {
    LogService.getInstance().debug(
      'Skipping legacy layout reconciliation without a panes config path',
      'layout'
    );
    return;
  }

  let panes = state.panes;
  try {
    const config = JSON.parse(await fs.readFile(state.panesFile, 'utf-8')) as PsycheConfig;
    if (!Array.isArray(config) && Array.isArray(config.panes)) {
      panes = config.panes;
    }
  } catch {
    // applyStoredPaneLayout will report config read failures below.
  }

  try {
    await applyStoredPaneLayout({
      panesFile: state.panesFile,
      panes,
      controlPaneId,
      terminalWidth,
      terminalHeight,
      mutation: { kind: 'reconcile' },
    });
  } catch (error) {
    LogService.getInstance().error(
      'Temporary layout reconciliation failed',
      'layout',
      undefined,
      error instanceof Error ? error : undefined
    );
  }
}
