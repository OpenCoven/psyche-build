export function createSupportBundleController(options: {
  elements: Record<string, any>;
  invoke: (command: string, args?: any) => Promise<any>;
  getProject: () => { root: string; panes: number } | null;
  getActiveElement?: () => any;
  onVisibilityChange?: () => void;
}): { open(returnFocus?: any): void; close(): void; dispose(): void };
export function createHelpModalController(options: {
  dialog: any; trigger: any; action: any; close: any;
  getActiveElement: () => any;
  onVisibilityChange?: () => void;
}): { setOpen(open: boolean): void; dispose(): void };
