export interface BrowserAutomationSnapshot {
  schema: 'psyche.browser.snapshot/v1';
  snapshotId: string;
  url: string;
  viewport: { width: number; height: number };
  nodes: Array<Record<string, unknown> & { ref: string; role: string; name: string }>;
  truncated: boolean;
}

export interface BrowserAutomationApi {
  dispatch(request: Record<string, unknown> & { type: string }): any;
  invalidate(): void;
}

export function installBrowserAutomation(globalObject: object, options?: { now?: () => number }): BrowserAutomationApi;
export function dispatchBrowserAutomation(globalObject: object, request: Record<string, unknown> & { type: string }): any;
export function browserAutomationSource(): string;
