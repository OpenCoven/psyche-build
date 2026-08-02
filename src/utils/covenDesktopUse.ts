import type { CovenSessionEvent, CovenSessionSummary } from '../daemon/protocol.js';
import type { PsychePane } from '../types.js';

export type DesktopUseQuickAction = 'screenshot' | 'inspect' | 'permissions' | 'approve' | 'deny' | 'test';

export interface DesktopUseActionSnapshot {
  id: string;
  label: string;
  status?: string;
  createdAt?: string;
  traceId?: string;
}

export interface DesktopUsePaneState {
  paneId: string;
  sessionId?: string;
  connected: boolean;
  session?: CovenSessionSummary;
  actions: DesktopUseActionSnapshot[];
  currentAction?: DesktopUseActionSnapshot;
  permissions?: Record<string, string>;
  accessibilitySummary?: string;
  screenSummary?: string;
  screenshotPath?: string;
  pendingApproval?: boolean;
  error?: string;
  updatedAt: string;
}

const MAX_ACTIONS = 5;
const SUMMARY_LIMIT = 120;

export function isDesktopUsePane(pane: PsychePane): boolean {
  return pane.type === 'desktop-use' || pane.shellType === 'desktop-use' || pane.shellType === 'computer-control';
}

export function getDesktopUseSessionId(pane: PsychePane): string | undefined {
  const desktopUse = pane.desktopUse;
  if (desktopUse?.sessionId) return desktopUse.sessionId;
  const covenSession = pane.covenSession;
  if (covenSession?.id) return covenSession.id;
  return undefined;
}

export function buildDesktopUseQuickInput(action: DesktopUseQuickAction): string {
  switch (action) {
    case 'screenshot':
      return 'Please run computer_use with {"action":"screenshot","format":"png"} and report the image path.\n';
    case 'inspect':
      return 'Please run computer_use with {"action":"inspect","mode":"frontmost"} and summarize the accessibility tree.\n';
    case 'permissions':
      return 'Please run computer_use with {"action":"doctor"} and summarize screen capture/accessibility permissions.\n';
    case 'approve':
      return 'Approve the pending computer_use action if it is safe and scoped to the current task.\n';
    case 'deny':
      return 'Deny the pending computer_use action and explain what safer observation is needed first.\n';
    case 'test':
      return 'Test the OpenSide bridge by running computer_use with {"action":"inspect","mode":"frontmost"}.\n';
  }
}

export function buildInitialDesktopUsePrompt(projectName: string): string {
  return [
    `You are the psyche desktop-use control lane for ${projectName}.`,
    'Use the computer_use tool for desktop observation/control through OpenSide.',
    'Start by running an inspect/frontmost observation, then wait for explicit approval before interactive actions.',
    'Report concise state updates so psyche can display current action, permissions, screenshots, and accessibility summaries.',
  ].join('\n');
}

export function buildDesktopUseStateFromEvents(
  paneId: string,
  sessionId: string | undefined,
  events: CovenSessionEvent[],
  session?: CovenSessionSummary,
): DesktopUsePaneState {
  const actions: DesktopUseActionSnapshot[] = [];
  let permissions: Record<string, string> | undefined;
  let accessibilitySummary: string | undefined;
  let screenSummary: string | undefined;
  let screenshotPath: string | undefined;
  let pendingApproval = false;

  for (const event of events) {
    const payload = parseEventPayload(event.payloadJson);
    const action = extractDesktopAction(payload, event);
    if (action) {
      actions.push(action);
    }

    const eventPermissions = extractPermissions(payload);
    if (eventPermissions) permissions = eventPermissions;

    const eventAccessibility = extractAccessibility(payload);
    if (eventAccessibility) accessibilitySummary = eventAccessibility;

    const eventScreen = extractScreenSummary(payload);
    if (eventScreen) screenSummary = eventScreen;

    const eventScreenshot = extractScreenshotPath(payload);
    if (eventScreenshot) screenshotPath = eventScreenshot;

    if (extractPendingApproval(payload)) pendingApproval = true;
  }

  const recentActions = actions.slice(-MAX_ACTIONS).reverse();
  return {
    paneId,
    sessionId,
    connected: true,
    session,
    actions: recentActions,
    currentAction: recentActions[0],
    permissions,
    accessibilitySummary,
    screenSummary,
    screenshotPath,
    pendingApproval,
    updatedAt: new Date().toISOString(),
  };
}

export function emptyDesktopUsePaneState(paneId: string, sessionId?: string, error?: string): DesktopUsePaneState {
  return {
    paneId,
    sessionId,
    connected: !error,
    actions: [],
    error,
    updatedAt: new Date().toISOString(),
  };
}

function parseEventPayload(payloadJson: string): unknown {
  try {
    return payloadJson ? JSON.parse(payloadJson) : null;
  } catch {
    return payloadJson;
  }
}

function extractDesktopAction(payload: unknown, event: CovenSessionEvent): DesktopUseActionSnapshot | null {
  const record = findDesktopRecord(payload);
  if (!record) return null;

  const action = stringValue(record.action)
    || stringValue(record.type)
    || stringValue(record.name)
    || stringValue(record.tool)
    || stringValue(record.toolName)
    || stringValue(record.tool_name)
    || stringValue(record.command);
  const nestedAction = actionFromNestedInput(record);
  const label = normalizeActionLabel(nestedAction || action || event.kind);
  if (!label || !isDesktopActionLabel(label, record)) return null;

  return {
    id: event.id,
    label,
    status: stringValue(record.status) || stringValue(record.state) || stringValue(record.result),
    createdAt: event.createdAt,
    traceId: stringValue(record.traceId) || stringValue(record.trace_id) || stringValue(record.requestId) || stringValue(record.request_id),
  };
}

function findDesktopRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (looksLikeDesktopRecord(value)) return value;

  for (const key of ['input', 'params', 'arguments', 'request', 'result', 'payload', 'data']) {
    const nested = value[key];
    if (isRecord(nested) && looksLikeDesktopRecord(nested)) {
      return nested;
    }
  }

  return null;
}

function looksLikeDesktopRecord(record: Record<string, unknown>): boolean {
  const tool = [record.tool, record.toolName, record.tool_name, record.name, record.source]
    .map(stringValue)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const action = [record.action, record.type, record.command]
    .map(stringValue)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /computer[_-]?use|desktop[_-]?use|openside|coven:desktop-use/.test(tool)
    || /screenshot|screen-capture|inspect|observe|doctor|permission|accessibility|click|type-text|keypress|scroll|focus/.test(action)
    || Boolean(record.permissions || record.accessibility || record.imagePath || record.image_path);
}

function actionFromNestedInput(record: Record<string, unknown>): string | undefined {
  for (const key of ['input', 'params', 'arguments', 'request']) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const action = stringValue(nested.action) || stringValue(nested.type) || stringValue(nested.command);
    if (action) return action;
  }
  return undefined;
}

function normalizeActionLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function isDesktopActionLabel(label: string, record: Record<string, unknown>): boolean {
  if (/computer[_-]?use|desktop[_-]?use|openside|coven:desktop-use/.test(label)) return true;
  if (/screenshot|screen-capture|inspect|observe|doctor|permission|accessibility|click|type-text|keypress|scroll|focus|approve|deny/.test(label)) return true;
  return Boolean(record.permissions || record.accessibility || record.imagePath || record.image_path);
}

function extractPermissions(payload: unknown): Record<string, string> | undefined {
  const found = findNestedRecord(payload, 'permissions');
  if (!found) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(found)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function extractAccessibility(payload: unknown): string | undefined {
  const found = findNestedValue(payload, 'accessibility');
  if (!found) return undefined;
  return summarizeUnknown(found);
}

function extractScreenSummary(payload: unknown): string | undefined {
  const focused = findNestedValue(payload, 'focused') || findNestedValue(payload, 'screenState') || findNestedValue(payload, 'screen_state');
  if (!focused) return undefined;
  return summarizeUnknown(focused);
}

function extractScreenshotPath(payload: unknown): string | undefined {
  return stringValue(findNestedValue(payload, 'imagePath'))
    || stringValue(findNestedValue(payload, 'image_path'))
    || stringValue(findNestedValue(payload, 'screenshotPath'))
    || stringValue(findNestedValue(payload, 'path'));
}

function extractPendingApproval(payload: unknown): boolean {
  const value = findNestedValue(payload, 'awaitingConfirmation')
    ?? findNestedValue(payload, 'awaiting_confirmation')
    ?? findNestedValue(payload, 'needsApproval')
    ?? findNestedValue(payload, 'needs_approval');
  return value === true;
}

function findNestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const nested = findNestedValue(value, key);
  return isRecord(nested) ? nested : undefined;
}

function findNestedValue(value: unknown, key: string, depth = 0): unknown {
  if (depth > 4 || !isRecord(value)) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const nested of Object.values(value)) {
    const found = findNestedValue(nested, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function summarizeUnknown(value: unknown): string {
  if (typeof value === 'string') return clip(value, SUMMARY_LIMIT);
  if (isRecord(value)) {
    const role = stringValue(value.role) || stringValue(value.type);
    const title = stringValue(value.title) || stringValue(value.name) || stringValue(value.focusedWindowTitle) || stringValue(value.focusedApp);
    if (role || title) return clip([role, title].filter(Boolean).join(' · '), SUMMARY_LIMIT);
  }
  return clip(JSON.stringify(value), SUMMARY_LIMIT);
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
