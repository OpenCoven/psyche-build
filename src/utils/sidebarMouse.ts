import type { PsychePane } from '../types.js';
import type {
  ProjectActionItem,
  ProjectActionLayout,
} from './projectActions.js';

export interface SidebarMouseEvent {
  button: number;
  column: number;
  row: number;
  pressed: boolean;
}

export type SidebarMouseTarget =
  | {
      kind: 'project-header';
      projectRoot: string;
      projectName: string;
      selectIndex: number | null;
    }
  | {
      kind: 'pane';
      pane: PsychePane;
      index: number;
    }
  | {
      kind: 'project-action';
      action: ProjectActionItem;
    };

const SGR_MOUSE_PATTERN = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])/;

export function parseSgrMouseEvent(input: string): SidebarMouseEvent | null {
  const match = SGR_MOUSE_PATTERN.exec(input);
  if (!match) {
    return null;
  }

  const button = Number.parseInt(match[1]!, 10);
  const column = Number.parseInt(match[2]!, 10);
  const row = Number.parseInt(match[3]!, 10);
  if (
    !Number.isFinite(button)
    || !Number.isFinite(column)
    || !Number.isFinite(row)
  ) {
    return null;
  }

  return {
    button,
    column,
    row,
    pressed: match[4] === 'M',
  };
}

function getActionRowsByProject(layout: ProjectActionLayout) {
  const map = new Map<string, ProjectActionItem[]>();
  for (const action of layout.actionItems) {
    const actions = map.get(action.projectRoot) || [];
    actions.push(action);
    map.set(action.projectRoot, actions);
  }
  return map;
}

function getProjectSelectIndex(
  layout: ProjectActionLayout,
  projectRoot: string
): number | null {
  const group = layout.groups.find((candidate) => candidate.projectRoot === projectRoot);
  if (group?.panes[0]) {
    return group.panes[0].index;
  }

  return layout.actionItems.find((action) => action.projectRoot === projectRoot)?.index ?? null;
}

function pickActionByColumn(actions: ProjectActionItem[], column: number): ProjectActionItem {
  if (actions.length <= 1) {
    return actions[0]!;
  }

  const clampedColumn = Math.max(1, Math.min(40, column));
  const segmentWidth = Math.max(1, Math.floor(40 / actions.length));
  const index = Math.min(actions.length - 1, Math.floor((clampedColumn - 1) / segmentWidth));
  return actions[index]!;
}

export function resolveSidebarMouseTarget(
  layout: ProjectActionLayout,
  row: number,
  column: number,
  options: { isLoading?: boolean } = {}
): SidebarMouseTarget | null {
  if (row < 1 || column < 1 || column > 40) {
    return null;
  }

  const actionRowsByProject = getActionRowsByProject(layout);
  let currentRow = 1;

  for (let groupIndex = 0; groupIndex < layout.groups.length; groupIndex += 1) {
    const group = layout.groups[groupIndex]!;

    if (row === currentRow) {
      return {
        kind: 'project-header',
        projectRoot: group.projectRoot,
        projectName: group.projectName,
        selectIndex: getProjectSelectIndex(layout, group.projectRoot),
      };
    }
    currentRow += 1;

    for (const entry of group.panes) {
      if (row === currentRow) {
        return {
          kind: 'pane',
          pane: entry.pane,
          index: entry.index,
        };
      }
      currentRow += 1;
    }

    if (!options.isLoading && layout.multiProjectMode) {
      const actions = actionRowsByProject.get(group.projectRoot) || [];
      if (actions.length > 0) {
        if (row === currentRow) {
          return {
            kind: 'project-action',
            action: pickActionByColumn(actions, column),
          };
        }
        currentRow += 1;
      }
    }

    if (groupIndex < layout.groups.length - 1) {
      currentRow += 1;
    }
  }

  if (!options.isLoading && !layout.multiProjectMode && layout.actionItems.length > 0) {
    if (row === currentRow) {
      return {
        kind: 'project-action',
        action: pickActionByColumn(layout.actionItems, column),
      };
    }
  }

  return null;
}

export function isPrimaryMousePress(event: SidebarMouseEvent): boolean {
  return event.pressed && (event.button & 3) === 0 && event.button < 64;
}
