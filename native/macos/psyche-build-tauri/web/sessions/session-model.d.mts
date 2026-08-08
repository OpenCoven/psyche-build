export type CovenSession = {
  id: string;
  projectRoot?: string;
  cwd?: string;
  title?: string;
  harness?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: unknown;
  archivedAt?: string;
};

export type LocalSession = {
  id?: string;
  projectId?: string;
  name?: string;
  title?: string;
  status?: string;
  worktreePath?: string;
  covenSessionId?: string | null;
};

export type CovenDiscoveryState = {
  phase: 'idle' | 'loading' | 'ready' | 'unavailable' | 'incompatible' | 'error';
  sessionsByProject: Map<string, CovenSession[]>;
  message: string | null;
  requestId: number;
  refreshedAt: number | null;
  stale: boolean;
};

export function isSafeCovenSessionId(id: unknown): id is string;
export function statusPresentation(status?: unknown): {
  tone: 'ok' | 'warn' | 'muted' | 'danger' | 'neutral';
  label: string;
  live: boolean;
};
export function sortCovenSessions<T extends CovenSession>(sessions: T[]): T[];
export function groupCovenSessions<T extends Partial<CovenSession>>(
  sessions: T[],
): Map<string, T[]>;
export function filterProjectSessions<L extends LocalSession, C extends CovenSession>(
  project: { name?: string },
  psycheSessions: L[],
  covenSessions: C[],
  query: string,
): {
  projectMatches: boolean;
  psycheSessions: L[];
  covenSessions: C[];
};
export type ProjectRailRow<L, C> = {
  key: string;
  source: 'psyche' | 'coven';
  id: string;
  title: string;
  status: string;
  needsAttention: boolean;
  worktreePath: string | null;
  value: L | C;
};
export type WorktreeRailInput = { path: string; branch?: string | null };
export function buildProjectRailModel<L extends LocalSession, C extends CovenSession>(
  project: {
    root?: string;
    name?: string;
    worktrees?: WorktreeRailInput[];
  },
  psycheSessions: L[],
  covenSessions: C[],
  query: string,
): {
  projectMatches: boolean;
  worktrees: Array<{
    worktree: WorktreeRailInput;
    matches: boolean;
    rows: Array<ProjectRailRow<L, C>>;
  }>;
  projectRows: Array<ProjectRailRow<L, C>>;
};
export function createCovenDiscoveryState(): CovenDiscoveryState;
export function beginCovenRequest(state: CovenDiscoveryState): {
  requestId: number;
  state: CovenDiscoveryState;
};
export function applyCovenResponse(
  state: CovenDiscoveryState,
  requestId: number,
  response: unknown,
  refreshedAt?: number,
): CovenDiscoveryState;
export function invalidateCovenRequests(state: CovenDiscoveryState): CovenDiscoveryState;
