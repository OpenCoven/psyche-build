type FunctionSource = (name: string) => string;

function compileExtractedFunction<T extends (...args: never[]) => unknown>(
  source: string,
  dependencies: Record<string, unknown>,
) {
  return Function(
    ...Object.keys(dependencies),
    `"use strict"; return (${source});`,
  )(...Object.values(dependencies)) as T;
}

export function withFilesScopeSelectionHelper(
  functionSource: FunctionSource,
  dependencies: Record<string, unknown>,
) {
  const syncFilesPanelScope = compileExtractedFunction<() => unknown>(
    functionSource('syncFilesPanelScope'),
    {
      invalidateFilesPanelRender:
        dependencies.invalidateFilesPanelRender ?? (() => 0),
      sidebarView: dependencies.sidebarView ?? 'sessions',
      renderFilesPanel: dependencies.renderFilesPanel ?? (() => false),
    },
  );
  const assignSelectedWorktreePath = compileExtractedFunction<
    (project: Record<string, unknown> | null, worktreePath: string) => boolean
  >(functionSource('assignSelectedWorktreePath'), {
    state: dependencies.state ?? { activeProjectId: null },
    syncFilesPanelScope,
  });

  return {
    ...dependencies,
    assignSelectedWorktreePath,
  };
}
