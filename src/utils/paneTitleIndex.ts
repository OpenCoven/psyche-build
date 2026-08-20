export interface TmuxPaneTitleRecord {
  paneId: string;
  title: string;
}

export function indexUniquePaneTitles(
  panes: readonly TmuxPaneTitleRecord[],
  excludedTitle?: string,
): {
  allPaneIds: string[];
  titleToId: Map<string, string>;
} {
  const allPaneIds: string[] = [];
  const titleToId = new Map<string, string>();
  const ambiguousTitles = new Set<string>();

  for (const pane of panes) {
    if (
      !pane.paneId
      || !pane.paneId.startsWith('%')
      || pane.title === excludedTitle
    ) {
      continue;
    }
    allPaneIds.push(pane.paneId);
    const title = pane.title.trim();
    if (!title || ambiguousTitles.has(title)) {
      continue;
    }
    if (titleToId.has(title)) {
      titleToId.delete(title);
      ambiguousTitles.add(title);
      continue;
    }
    titleToId.set(title, pane.paneId);
  }

  return { allPaneIds, titleToId };
}
