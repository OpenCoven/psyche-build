export function runFocusedOperatorAction<T>(
  target: { focus?: () => void } | null,
  action: () => Promise<T>,
  onError?: (message: string) => void,
): Promise<T>;

export function renderAgentControlDrawer(
  container: any,
  model: any,
  callbacks?: Record<string, (...args: any[]) => Promise<unknown>>,
): { failures: Map<string, unknown> };

export function trapAgentControlFocus(
  event: { key?: string; shiftKey?: boolean; preventDefault: () => void },
  drawer: any,
): boolean;

export function installAgentControlUiLifecycle(options: {
  toggle: any;
  overlay: any;
  close: any;
  refresh: () => Promise<unknown>;
  setInterval?: (callback: () => unknown, delay: number) => unknown;
  clearInterval?: (timer: unknown) => void;
}): { dispose: () => void } | null;
