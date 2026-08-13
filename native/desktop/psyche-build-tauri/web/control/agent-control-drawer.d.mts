export function runFocusedOperatorAction<T>(
  target: { focus?: () => void } | null,
  action: () => Promise<T>,
  onError?: (message: string) => void,
): Promise<T>;

export function renderAgentControlDrawer(
  container: any,
  model: any,
  callbacks?: Record<string, (...args: any[]) => Promise<unknown>>,
): { error: any };
