import type { RenderContext } from './render.mjs';
import type { PublicBead } from './sanitize.mjs';

export type ReconciliationFieldValue = string | number | boolean | null;

export type ProjectFieldValues = Record<string, ReconciliationFieldValue>;

export interface ProjectItemSnapshotInput {
  id?: string;
  archived?: boolean;
  fields?: ProjectFieldValues;
}

export interface ProjectItemSnapshot {
  id: string;
  archived: boolean;
  fields: ProjectFieldValues;
}

export interface IssueSnapshotInput {
  number: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  assignee?: string | null;
  renderHash?: string | null;
  projectItem?: ProjectItemSnapshotInput | null;
  parentIssueNumber?: number | null;
  blockerIssueNumbers?: readonly number[] | null;
}

export interface IssueSnapshot {
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  assignee: string | null;
  renderHash: string | null;
  projectItem: ProjectItemSnapshot | null;
  parentIssueNumber: number | null;
  blockerIssueNumbers: number[];
}

export interface ManagedIssueSnapshot extends IssueSnapshot {
  beadId: string;
}

export interface ReadmeSnapshotInput {
  body?: string | null;
  renderHash?: string | null;
  path?: string | null;
}

export interface ReadmeSnapshot {
  body: string | null;
  renderHash: string | null;
  path: string;
}

export interface PlanReconciliationInput {
  inventory: readonly PublicBead[];
  existingIssues?: readonly IssueSnapshotInput[];
  readme?: ReadmeSnapshotInput | null;
  renderContext?: Omit<RenderContext, 'inventoryById' | 'mirroredIssueUrlsByBeadId'>;
}

export type ReconciliationPhase =
  | 'createIssues'
  | 'updateIssues'
  | 'closeIssues'
  | 'ensureProjectItems'
  | 'restoreItems'
  | 'setFields'
  | 'syncParents'
  | 'syncBlockers'
  | 'archiveItems'
  | 'updateReadme';

export interface CreateIssueOperation {
  type: 'createIssue';
  phase: 'createIssues';
  beadId: string;
  title: string;
  body: string;
  renderHash: string;
  assignee: string | null;
  state: 'open';
}

export interface UpdateIssueOperation {
  type: 'updateIssue';
  phase: 'updateIssues';
  beadId: string;
  issueNumber: number;
  title: string;
  body: string;
  renderHash: string;
  assignee: string | null;
  state: string;
}

export interface CloseIssueOperation {
  type: 'closeIssue';
  phase: 'closeIssues';
  beadId: string;
  issueNumber: number;
}

export interface EnsureProjectItemOperation {
  type: 'ensureProjectItem';
  phase: 'ensureProjectItems';
  beadId: string;
  issueNumber?: number;
}

export interface RestoreItemOperation {
  type: 'restoreItem';
  phase: 'restoreItems';
  beadId: string;
  itemId?: string;
}

export interface SetFieldsOperation {
  type: 'setFields';
  phase: 'setFields';
  beadId: string;
  itemId?: string;
  fields: ProjectFieldValues;
}

export interface SyncParentOperation {
  type: 'syncParent';
  phase: 'syncParents';
  beadId: string;
  parentBeadId: string | null;
  parentIssueNumber?: number | null;
  currentParentIssueNumber: number | null;
}

export interface SyncBlockerOperation {
  type: 'syncBlocker';
  phase: 'syncBlockers';
  beadId: string;
  blockerBeadIds: string[];
  blockerIssueNumbers?: number[];
  currentBlockerIssueNumbers: number[];
}

export interface ArchiveItemOperation {
  type: 'archiveItem';
  phase: 'archiveItems';
  beadId: string;
  itemId?: string;
}

export interface UpdateReadmeOperation {
  type: 'updateReadme';
  phase: 'updateReadme';
  path: string;
  body: string;
  renderHash: string;
}

export type ReconciliationOperation =
  | CreateIssueOperation
  | UpdateIssueOperation
  | CloseIssueOperation
  | EnsureProjectItemOperation
  | RestoreItemOperation
  | SetFieldsOperation
  | SyncParentOperation
  | SyncBlockerOperation
  | ArchiveItemOperation
  | UpdateReadmeOperation;

export interface ReconciliationOperationCounts {
  createIssue: number;
  updateIssue: number;
  closeIssue: number;
  ensureProjectItem: number;
  restoreItem: number;
  setFields: number;
  syncParent: number;
  syncBlocker: number;
  archiveItem: number;
  updateReadme: number;
}

export interface ReconciliationClosureCandidate {
  beadId: string;
  issueNumber: number;
  issueTitle: string | null;
}

export interface ReconciliationSummary {
  sourceTotal: number;
  sourceActive: number;
  sourceClosed: number;
  managedTotal: number;
  managedOpenCount: number;
  defaultMaxCloseCount: number;
  createIssueCount: number;
  updateIssueCount: number;
  closeIssueCount: number;
  ensureProjectItemCount: number;
  restoreItemCount: number;
  setFieldsCount: number;
  syncParentCount: number;
  syncBlockerCount: number;
  archiveItemCount: number;
  updateReadmeCount: number;
  operationCounts: ReconciliationOperationCounts;
  closureCandidates: ReconciliationClosureCandidate[];
}

export interface ReconciliationPlan {
  inventory: readonly PublicBead[];
  operations: readonly ReconciliationOperation[];
  managedIssuesByBeadId: ReadonlyMap<string, ManagedIssueSnapshot>;
  summary: ReconciliationSummary;
}

export interface ReconciliationSafetyLimits {
  maxCloseCount?: number;
}

export interface CreateIssueResult {
  number: number;
}

export interface EnsureProjectItemResult {
  id: string;
}

export type Awaitable<T> = T | PromiseLike<T>;

export interface ReconciliationAdapters {
  createIssue(operation: CreateIssueOperation): Awaitable<CreateIssueResult>;
  updateIssue(operation: UpdateIssueOperation): Awaitable<unknown>;
  closeIssue(operation: CloseIssueOperation): Awaitable<unknown>;
  ensureProjectItem(
    operation: EnsureProjectItemOperation & { issueNumber: number },
  ): Awaitable<EnsureProjectItemResult>;
  restoreItem(operation: RestoreItemOperation & { itemId: string }): Awaitable<unknown>;
  setFields(operation: SetFieldsOperation & { itemId: string }): Awaitable<unknown>;
  syncParent(
    operation: SyncParentOperation & {
      issueNumber: number;
      parentIssueNumber: number | null;
    },
  ): Awaitable<unknown>;
  syncBlocker(
    operation: SyncBlockerOperation & {
      issueNumber: number;
      blockerIssueNumbers: number[];
    },
  ): Awaitable<unknown>;
  archiveItem(operation: ArchiveItemOperation & { itemId: string }): Awaitable<unknown>;
  updateReadme(operation: UpdateReadmeOperation): Awaitable<unknown>;
}

export interface AppliedReconciliationOperation {
  operation: ReconciliationOperation;
  result: unknown;
}

export interface AppliedReconciliationResult {
  applied: AppliedReconciliationOperation[];
  issueNumbersByBeadId: Map<string, number>;
  projectItemIdsByBeadId: Map<string, string>;
}

export interface ReconciliationApplyErrorDetails {
  failingOperation: ReconciliationOperation;
  applied: readonly AppliedReconciliationOperation[];
  issueNumbersByBeadId: ReadonlyMap<string, number>;
  projectItemIdsByBeadId: ReadonlyMap<string, string>;
  cause?: unknown;
}

export class ReconciliationApplyError extends Error {
  readonly failingOperation: ReconciliationOperation;
  readonly applied: readonly AppliedReconciliationOperation[];
  readonly issueNumbersByBeadId: ReadonlyMap<string, number>;
  readonly projectItemIdsByBeadId: ReadonlyMap<string, string>;
  readonly cause: unknown;

  constructor(message: string, details: ReconciliationApplyErrorDetails);
}

export function planReconciliation(input: PlanReconciliationInput): ReconciliationPlan;

export function assertSafePlan(
  plan: ReconciliationPlan,
  limits?: ReconciliationSafetyLimits,
): void;

export function applyReconciliation(
  plan: ReconciliationPlan,
  adapters: ReconciliationAdapters,
): Promise<AppliedReconciliationResult>;
