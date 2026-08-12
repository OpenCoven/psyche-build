import path from 'node:path';
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
import {
  projectRootFromPaneConfigPath,
  readProjectPaneConfig,
  transactProjectPaneConfig,
} from '../services/ProjectPaneConfig.js';
import { TmuxService } from '../services/TmuxService.js';

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
  resolveSidebarWidthFromConfig?: boolean;
}

interface InsertPanesIntoStoredLayoutOptions {
  panesFile: string;
  panes: PsychePane[];
  insertions: Array<{
    pane: PsychePane;
    insertion?: PaneInsertion;
  }>;
  controlPaneId: string;
  sidebarWidth?: number;
  resolveSidebarWidthFromConfig?: boolean;
}

export interface ApplyStoredPaneLayoutOptions {
  panesFile: string;
  panes: PsychePane[];
  /** New records that become durable with the accepted topology. */
  persistPanes?: PsychePane[];
  /** Records that become absent with the accepted topology. */
  removePersistedPaneIds?: string[];
  controlPaneId: string;
  terminalWidth: number;
  terminalHeight: number;
  sidebarWidth?: number;
  resolveSidebarWidthFromConfig?: boolean;
  mutation: PaneLayoutMutation;
}

function sessionProjectRoot(panesFile: string): string {
  return projectRootFromPaneConfigPath(panesFile)
    ?? path.dirname(path.dirname(panesFile));
}

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

function removePersistedPanes(
  currentPanes: PsychePane[],
  paneIdsToRemove: readonly string[]
): PsychePane[] {
  const paneIds = new Set(paneIdsToRemove);
  return currentPanes.filter((pane) => !paneIds.has(pane.id));
}

/**
 * Projects a logical tree into tmux and persists that exact accepted tree
 * under ProjectPaneConfig's cross-process lease. Pane ownership and topology
 * are therefore one registry mutation, rather than independent file locks.
 */
export async function applyStoredPaneLayout(
  options: ApplyStoredPaneLayoutOptions
): Promise<PaneLayout> {
  const projectRoot = sessionProjectRoot(options.panesFile);
  const tmuxService = TmuxService.getInstance();
  const mutation = await transactProjectPaneConfig(projectRoot, async ({ config, persist }) => {
    const rawConfig = config as unknown as PsycheConfig;
    const persistedPanes = Array.isArray(rawConfig.panes) ? rawConfig.panes : [];
    const panesAfterRemoval = options.removePersistedPaneIds
      ? removePersistedPanes(persistedPanes, options.removePersistedPaneIds)
      : persistedPanes;
    const panes = options.persistPanes
      ? appendMissingPanes(panesAfterRemoval, options.persistPanes)
      : options.removePersistedPaneIds
        ? panesAfterRemoval
        : options.panes;
    const sidebarWidth = options.resolveSidebarWidthFromConfig
      && typeof rawConfig.controlPaneSize === 'number'
      ? rawConfig.controlPaneSize
      : options.sidebarWidth ?? SIDEBAR_WIDTH;
    const hasVisibleContentPanes = panes.some((pane) => !pane.hidden);

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

    rawConfig.panes = panes;
    rawConfig.paneLayout = layout;
    rawConfig.lastUpdated = new Date().toISOString();
    await persist();
    return layout;
  });

  return mutation.result;
}

/**
 * Captures a placement target from the current logical topology. Reading is
 * intentionally non-destructive; the later mutation revalidates under the
 * ProjectPaneConfig lease.
 */
export async function capturePaneInsertion(
  options: CapturePaneInsertionOptions
): Promise<PaneInsertion | undefined> {
  let paneLayout: PsycheConfig['paneLayout'];
  try {
    const config = await readProjectPaneConfig(sessionProjectRoot(options.panesFile));
    paneLayout = (config as PsycheConfig).paneLayout;
  } catch {
    // The in-memory records provide a conservative fallback.
  }

  let paneInfo: Awaited<ReturnType<TmuxService['getAllPaneInfo']>>;
  try {
    paneInfo = await TmuxService.getInstance().getAllPaneInfo('window');
  } catch {
    return undefined;
  }
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
  return insertPanesIntoStoredLayout({
    panesFile: options.panesFile,
    panes: options.panes,
    insertions: [{ pane: options.pane, insertion: options.insertion }],
    controlPaneId: options.controlPaneId,
    sidebarWidth: options.sidebarWidth,
    resolveSidebarWidthFromConfig: options.resolveSidebarWidthFromConfig,
  });
}

export async function insertPanesIntoStoredLayout(
  options: InsertPanesIntoStoredLayoutOptions
): Promise<PaneLayout> {
  const dimensions = await TmuxService.getInstance().getTerminalDimensions();
  const insertedPanes = options.insertions.map(({ pane }) => pane);
  return applyStoredPaneLayout({
    panesFile: options.panesFile,
    panes: [...options.panes, ...insertedPanes],
    persistPanes: insertedPanes,
    controlPaneId: options.controlPaneId,
    terminalWidth: dimensions.width,
    terminalHeight: dimensions.height,
    sidebarWidth: options.sidebarWidth,
    resolveSidebarWidthFromConfig: options.resolveSidebarWidthFromConfig,
    mutation: {
      kind: 'batch',
      mutations: options.insertions.map(({ pane, insertion }) => insertion
        ? {
          kind: 'insert',
          paneId: pane.id,
          targetPaneId: insertion.targetPaneId,
          direction: insertion.direction,
        }
        : { kind: 'reconcile' }),
    },
  });
}

export async function removePaneFromStoredLayout(options: {
  panesFile: string;
  paneId: string;
  controlPaneId: string;
  sidebarWidth?: number;
  resolveSidebarWidthFromConfig?: boolean;
}): Promise<PaneLayout> {
  const dimensions = await TmuxService.getInstance().getTerminalDimensions();
  return applyStoredPaneLayout({
    panesFile: options.panesFile,
    panes: [],
    removePersistedPaneIds: [options.paneId],
    controlPaneId: options.controlPaneId,
    terminalWidth: dimensions.width,
    terminalHeight: dimensions.height,
    sidebarWidth: options.sidebarWidth,
    resolveSidebarWidthFromConfig: options.resolveSidebarWidthFromConfig,
    mutation: { kind: 'remove', paneId: options.paneId },
  });
}

/**
 * Compatibility entry point for lifecycle paths that need to re-project the
 * currently persisted records. It never writes an independent grid layout.
 */
export async function recalculateAndApplyLayout(
  controlPaneId: string,
  contentPaneIds: string[],
  terminalWidth: number,
  terminalHeight: number,
  panesFile = path.join(process.cwd(), '.psyche', 'psyche.config.json'),
): Promise<PaneLayout> {
  const projectRoot = sessionProjectRoot(panesFile);
  const config = await readProjectPaneConfig(projectRoot) as PsycheConfig;
  const visible = (Array.isArray(config.panes) ? config.panes : [])
    .filter((pane) => contentPaneIds.includes(pane.paneId));
  return applyStoredPaneLayout({
    panesFile,
    panes: visible,
    controlPaneId,
    terminalWidth,
    terminalHeight,
    sidebarWidth: typeof config.controlPaneSize === 'number'
      ? config.controlPaneSize
      : SIDEBAR_WIDTH,
    mutation: { kind: 'reconcile' },
  });
}
