import fs from 'fs/promises';
import type { PaneLayout, PaneSplitDirection, PsycheConfig, PsychePane } from '../types.js';
import {
  applyPaneLayoutMutation,
  DEFAULT_SIDEBAR_WIDTH,
  type PaneLayoutMutation,
} from '../layout/PaneLayoutController.js';
import {
  adaptiveSplitDirection,
  resolvePaneInsertionTarget,
} from '../layout/PanePlacement.js';
import { seedPaneLayout } from '../layout/PaneLayoutTree.js';
import { TmuxService } from '../services/TmuxService.js';
import { atomicWriteJson } from './atomicWrite.js';
import { withPanesConfigFileWriteLock } from './panesConfigQueue.js';

export const SIDEBAR_WIDTH = DEFAULT_SIDEBAR_WIDTH;

export interface PaneInsertion {
  targetPaneId: string;
  targetTmuxPaneId: string;
  direction: PaneSplitDirection;
}

interface CapturePaneInsertionOptions {
  panesFile: string;
  panes: PsychePane[];
  focusedTmuxPaneId?: string | null;
  selectedPaneId?: string;
}

interface InsertPaneIntoStoredLayoutOptions {
  panesFile: string;
  panes: PsychePane[];
  pane: PsychePane;
  controlPaneId: string;
  insertion?: PaneInsertion;
  sidebarWidth?: number;
}

function paneBindingSignature(panes: PsychePane[]): string {
  return panes
    .map((pane) => `${pane.id}:${pane.paneId}:${pane.hidden === true}`)
    .sort()
    .join('|');
}

type ApplyStoredPaneLayoutOptions = {
  panesFile: string;
  panes: PsychePane[];
  /** Pane metadata that should be persisted only after tmux accepts the layout. */
  persistPanes?: PsychePane[];
  controlPaneId: string;
  terminalWidth: number;
  terminalHeight: number;
  sidebarWidth?: number;
  mutation: PaneLayoutMutation;
};

function appendMissingPanes(
  currentPanes: PsychePane[],
  panesToAppend: PsychePane[]
): PsychePane[] {
  const existingPaneIds = new Set(currentPanes.map((pane) => pane.id));
  return [
    ...currentPanes,
    ...panesToAppend.filter((pane) => !existingPaneIds.has(pane.id)),
  ];
}

async function applyStoredPaneLayoutWithConfigLockHeld(
  options: ApplyStoredPaneLayoutOptions
): Promise<PaneLayout> {
  const rawConfig = JSON.parse(await fs.readFile(options.panesFile, 'utf-8')) as PsycheConfig;
  if (Array.isArray(rawConfig)) {
    throw new Error('Pane layout requires an object-form config');
  }

  const tmuxService = TmuxService.getInstance();
  const persistedPanes = Array.isArray(rawConfig.panes) ? rawConfig.panes : [];
  const panes = options.persistPanes
    ? appendMissingPanes(persistedPanes, options.persistPanes)
    : options.panes;
  const hasVisibleContentPanes = panes.some((pane) => !pane.hidden);
  const sidebarWidth = options.sidebarWidth ?? SIDEBAR_WIDTH;

  await tmuxService.resizePane(options.controlPaneId, { width: sidebarWidth });

  const { layout } = await applyPaneLayoutMutation({
    paneLayout: rawConfig.paneLayout,
    panes,
    controlPaneId: options.controlPaneId,
    terminalWidth: options.terminalWidth,
    terminalHeight: options.terminalHeight,
    sidebarWidth,
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
  if (paneBindingSignature(latestPanes) !== paneBindingSignature(persistedPanes)) {
    throw new Error('Pane metadata changed while applying pane layout');
  }

  await atomicWriteJson(options.panesFile, {
    ...latestConfig,
    ...(options.persistPanes
      ? {
          panes: appendMissingPanes(latestPanes, options.persistPanes),
          lastUpdated: new Date().toISOString(),
        }
      : {}),
    paneLayout: layout,
  });

  return layout;
}

export async function applyStoredPaneLayout(
  options: ApplyStoredPaneLayoutOptions
): Promise<PaneLayout> {
  return withPanesConfigFileWriteLock(
    options.panesFile,
    () => applyStoredPaneLayoutWithConfigLockHeld(options)
  );
}

export async function applyStoredPaneLayoutWithinConfigWriteLock(
  options: ApplyStoredPaneLayoutOptions
): Promise<PaneLayout> {
  return applyStoredPaneLayoutWithConfigLockHeld(options);
}

/**
 * Captures the logical leaf and physical pane dimensions before tmux creates
 * another pane. If focus became stale while the panes were being inspected,
 * fall back through the selected and stored visible leaves that still exist.
 */
export async function capturePaneInsertion(
  options: CapturePaneInsertionOptions
): Promise<PaneInsertion | undefined> {
  let paneLayout: PsycheConfig['paneLayout'];
  try {
    const config = JSON.parse(await fs.readFile(options.panesFile, 'utf-8')) as PsycheConfig;
    if (!Array.isArray(config)) {
      paneLayout = config.paneLayout;
    }
  } catch {
    // The current in-memory panes still provide focus and selected targets.
  }

  const paneInfo = await TmuxService.getInstance().getAllPaneInfo('window');
  const unavailablePaneIds = new Set<string>();
  const targetLayout = paneLayout ?? seedPaneLayout(options.panes.map((pane) => pane.id));

  while (unavailablePaneIds.size < options.panes.length) {
    const targetPane = resolvePaneInsertionTarget({
      panes: options.panes.filter((pane) => !unavailablePaneIds.has(pane.id)),
      paneLayout: targetLayout,
      focusedTmuxPaneId: options.focusedTmuxPaneId,
      selectedPaneId: options.selectedPaneId,
    });
    if (!targetPane) {
      return undefined;
    }

    const physicalTarget = paneInfo.find((pane) => pane.paneId === targetPane.paneId);
    if (physicalTarget) {
      return {
        targetPaneId: targetPane.id,
        targetTmuxPaneId: targetPane.paneId,
        direction: adaptiveSplitDirection(physicalTarget),
      };
    }

    unavailablePaneIds.add(targetPane.id);
  }

  return undefined;
}

export async function insertPaneIntoStoredLayout(
  options: InsertPaneIntoStoredLayoutOptions
): Promise<PaneLayout> {
  const tmuxService = TmuxService.getInstance();
  const dimensions = await tmuxService.getTerminalDimensions();
  return applyStoredPaneLayout({
    panesFile: options.panesFile,
    panes: [...options.panes, options.pane],
    persistPanes: [options.pane],
    controlPaneId: options.controlPaneId,
    terminalWidth: dimensions.width,
    terminalHeight: dimensions.height,
    sidebarWidth: options.sidebarWidth,
    mutation: options.insertion
      ? {
          kind: 'insert',
          paneId: options.pane.id,
          targetPaneId: options.insertion.targetPaneId,
          direction: options.insertion.direction,
        }
      : { kind: 'reconcile' },
  });
}
