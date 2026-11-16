export function createSupportBundleController(options: {
  elements: Record<string, any>;
  invoke: (command: string, args?: any) => Promise<any>;
  getProject: () => { root: string; panes: number } | null;
  getActiveElement?: () => any;
}): { open(returnFocus?: any): void; close(): void; dispose(): void };
