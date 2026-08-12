import type {
  CovenSession,
  LocalSession,
  WorktreeRailInput,
} from './session-model.mjs';

export const SIDEBAR_FILTERS: readonly [
  'all',
  'agents',
  'shells',
  'active',
  'attention',
];
export type SidebarFilter = typeof SIDEBAR_FILTERS[number];

export const SIDEBAR_ACTIVE_WINDOW_MS: number;

export type SidebarStatusKey =
  | 'exited'
  | 'attention'
  | 'busy'
  | 'active'
  | 'idle';

export interface SidebarStatusPresentation {
  key: SidebarStatusKey;
  label: 'EXITED' | 'REPLY' | 'BUSY' | 'ACTIVE' | 'IDLE';
  icon: '×' | '!' | '↻' | '●' | '–';
  tooltip: string;
}

export interface SidebarLaunchSpec {
  command?: string;
  args?: unknown[];
  cwd?: string;
}

export interface LocalSidebarSession extends LocalSession {
  kind?: string;
  cwd?: string;
  needsAttention?: boolean;
  spawning?: boolean;
  isWorking?: boolean;
  tail?: string;
  lastOutputAt?: unknown;
  launch?: SidebarLaunchSpec;
}

export interface SidebarWorktreeInput extends WorktreeRailInput {
  is_main?: boolean;
  collapsed?: boolean;
  dirty?: boolean;
  missing?: boolean;
  virtual?: boolean;
}

export interface SidebarProjectInput {
  id?: string;
  name?: string;
  root?: string;
  collapsed?: boolean;
  selectedWorktreePath?: string;
  worktrees?: SidebarWorktreeInput[];
}

export interface SidebarSelectionRow {
  source?: 'coven' | 'psyche' | string;
  id?: string;
  projectRoot?: string;
  worktreePath?: string | null;
  kind?: string;
  baseTitle?: string;
  title?: string;
  discriminator?: string;
  command?: string;
}

export type SidebarMatchRange = [number, number];
export type SidebarRowType = 'agents' | 'shells';
export type SidebarRowSource = 'coven' | 'psyche';

export interface SidebarRowBase<T = unknown> {
  key: string;
  source: SidebarRowSource;
  id: string;
  projectRoot: string;
  worktreePath: string | null;
  kind: string;
  type: SidebarRowType;
  title: string;
  baseTitle: string;
  meta: string;
  command: string;
  discriminator: string;
  status: SidebarStatusPresentation;
  needsAttention: boolean;
  lastActiveAt: number;
  value: T;
  /**
   * Local rows include the live thread id as the final component so duplicate
   * panes remain distinct within the current runtime, even though PTYs are not
   * restored across relaunches.
   */
  selectionKey: string;
  searchText: string;
  titleMatches: SidebarMatchRange[];
  metaMatches: SidebarMatchRange[];
  statusMatches: SidebarMatchRange[];
}

export type SidebarRow<
  L extends LocalSidebarSession = LocalSidebarSession,
  C extends CovenSession = CovenSession,
> =
  | (SidebarRowBase<L> & {
    source: 'psyche';
    value: L;
  })
  | (SidebarRowBase<C> & {
    source: 'coven';
    kind: 'agent';
    type: 'agents';
    value: C;
  });

export interface SidebarCategory<
  L extends LocalSidebarSession = LocalSidebarSession,
  C extends CovenSession = CovenSession,
> {
  key: string;
  label: string;
  icon: string;
  count: number;
  labelMatches: SidebarMatchRange[];
  rows: Array<SidebarRow<L, C>>;
}

export interface SidebarBranchModel<
  L extends LocalSidebarSession = LocalSidebarSession,
  C extends CovenSession = CovenSession,
> {
  key: string;
  worktree: SidebarWorktreeInput;
  title: string;
  titleMatches: SidebarMatchRange[];
  count: number;
  attentionCount: number;
  expanded: boolean;
  autoExpanded: boolean;
  categories: Array<SidebarCategory<L, C>>;
}

export interface SidebarProjectModel<
  L extends LocalSidebarSession = LocalSidebarSession,
  C extends CovenSession = CovenSession,
> {
  key: string;
  project: SidebarProjectInput | undefined;
  title: string;
  titleMatches: SidebarMatchRange[];
  count: number;
  visibleCount: number;
  attentionCount: number;
  expanded: boolean;
  autoExpanded: boolean;
  branches: Array<SidebarBranchModel<L, C>>;
}

export function normalizeSidebarFilter(value?: unknown): SidebarFilter;
export function sidebarTailIsWorking(tail: string): boolean;
export function deriveLocalSidebarStatus(
  thread?: Partial<LocalSidebarSession>,
  now?: number,
  activeWindowMs?: number,
): SidebarStatusPresentation;
export function deriveCovenSidebarStatus(
  session?: Partial<CovenSession>,
): SidebarStatusPresentation;
export function sidebarSelectionKey(row: SidebarSelectionRow): string;
export function localSidebarSelectionKey(
  project: SidebarProjectInput,
  thread: Partial<LocalSidebarSession>,
): string;
export function matchTextRanges(
  value: unknown,
  query: unknown,
): SidebarMatchRange[];
export function buildSidebarProjectModel<
  L extends LocalSidebarSession = LocalSidebarSession,
  C extends CovenSession = CovenSession,
>(options?: {
  project?: SidebarProjectInput;
  localSessions?: L[];
  covenSessions?: C[];
  query?: string;
  filter?: string;
  selectedKey?: string;
  now?: number;
}): SidebarProjectModel<L, C>;
