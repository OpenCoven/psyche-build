export type FooterTier =
  | 'full'
  | 'no-session'
  | 'no-spend'
  | 'no-context'
  | 'core'
  | 'compact';

export type PaneFooterAction = 'copy' | 'reveal' | 'usage' | 'switch-model';

export interface PaneMetricsState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  provider: string;
  sessionId: string | null;
  model: string | null;
  contextUsed: number | null;
  contextLimit: number | null;
  spendUsd: number | null;
  cumulativeInputTokens?: number | null;
  cumulativeOutputTokens?: number | null;
  updatedAt: string | null;
  stale: boolean;
  error: string | null;
  canSwitchModel?: boolean;
}

export interface PaneFooterInput {
  kind: string;
  branch?: string | null;
  worktreeLabel?: string | null;
  worktreePath?: string | null;
  paneId: string;
  metrics?: PaneMetricsState | null;
}

export interface PaneFooterItem {
  key: string;
  label: string;
  value: string;
  fullValue: string;
  action: PaneFooterAction;
}

export interface PaneMetricsThread {
  id: string;
  metricsGeneration: number;
  launch?: { covenSessionId?: string | null };
}

export interface PaneMetricsResponseGuardInput {
  threadId: string;
  generation: number;
  sessionId: string | null;
}

export const FOOTER_TIERS: Readonly<{
  FULL: 'full';
  NO_SESSION: 'no-session';
  NO_SPEND: 'no-spend';
  NO_CONTEXT: 'no-context';
  CORE: 'core';
  COMPACT: 'compact';
}>;

export function isAgentPaneKind(kind: string): boolean;
export function footerTier(width: number): FooterTier;
export function hiddenFooterKeys(tier: FooterTier, isAgent: boolean): string[];
export function formatContext(used: number | null, limit: number | null): string;
export function formatSpend(value: number | null): string;
export function footerItems(state: PaneFooterInput): PaneFooterItem[];
export function shouldApplyMetricsResponse(
  thread: PaneMetricsThread,
  response: PaneMetricsResponseGuardInput,
): boolean;
