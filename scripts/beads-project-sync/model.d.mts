export type BeadStatus = 'open' | 'in_progress' | 'closed' | (string & {});

export type BeadType = 'epic' | 'feature' | 'task' | (string & {});

export interface ParsedBead {
  id: string;
  title: string;
  description: string | null;
  design: string | null;
  specId: string | null;
  acceptanceCriteria: string | null;
  notes: string | null;
  status: BeadStatus;
  priority: number;
  type: BeadType;
  blocked: boolean;
  labels: string[];
  parentId: string | null;
  blockedByIds: string[];
  githubAssignee: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ParseBeadExportConfig {
  assigneeMap?: ReadonlyMap<string, string> | Record<string, string>;
}

export interface IndexableBead {
  id: string;
  parentId?: string | null;
  blockedByIds?: readonly string[] | null;
}

export interface BeadIndex<TBead extends IndexableBead = ParsedBead> {
  byId: Map<string, TBead>;
  childrenByParentId: Map<string, TBead[]>;
  dependentsByBlockerId: Map<string, TBead[]>;
}

export interface InventorySummary<
  TStatus extends string = BeadStatus,
  TType extends string = BeadType,
> {
  total: number;
  active: number;
  closed: number;
  blocked: number;
  inProgress: number;
  statusCounts: Partial<Record<TStatus, number>>;
  typeCounts: Partial<Record<TType, number>>;
}

export function parseBeadExport(
  jsonl: string,
  config?: ParseBeadExportConfig,
): ParsedBead[];

export function buildBeadIndex<TBead extends IndexableBead>(
  beads: readonly TBead[],
): BeadIndex<TBead>;

export function activeBeads<TBead extends { status: string }>(
  beads: readonly TBead[],
): TBead[];

export function summarizeInventory<
  TBead extends { status: string; type: string; blocked: boolean },
>(
  beads: readonly TBead[],
): InventorySummary<TBead['status'], TBead['type']>;
