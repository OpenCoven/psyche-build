import type {
  ProjectFieldValues,
} from './reconcile.mjs';

export interface GhRunOptions {
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}

export interface GhRunResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

export type GhRun = (
  command: string,
  args: readonly string[],
  options: GhRunOptions,
) => GhRunResult | Promise<GhRunResult>;

export interface ManagedLabel {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface ProjectContext {
  id: string;
  number: number;
  title: string;
  readme: string;
  public: boolean;
  closed?: boolean;
  url?: string;
}

export interface ProjectFieldContext {
  id: string;
  name: string;
  dataType: string;
  options: Map<string, string>;
}

export interface ProjectViewDefinition {
  readonly name: string;
  readonly layout: string;
  readonly filter: string;
}

export interface ProjectViewContext extends ProjectViewDefinition {
  id: string;
}

export interface ManagedIssueSnapshot {
  beadId: string;
  number: number;
  title: string | null;
  body: string | null;
  state: string;
  assignee: string | null;
  labels: string[];
  renderHash: string | null;
  projectItem: {
    id: string;
    archived: boolean;
    fields: ProjectFieldValues;
  } | null;
  parentIssueNumber: number | null;
  blockerIssueNumbers: number[];
  url?: string;
}

export interface IssueMutationResult {
  number?: number;
  id?: number;
  node_id?: string;
  html_url?: string;
  [key: string]: unknown;
}

export interface CreatedIssueResult extends IssueMutationResult {
  number: number;
}

export interface LabelIssueInput {
  issueNumber: number;
  labels: readonly string[];
}

export interface AssignIssueInput {
  issueNumber: number;
  assignee?: string | null;
  assignees?: readonly string[];
}

export interface SubIssueInput {
  parentIssueNumber: number;
  subIssueId: number;
}

export interface BlockedByInput {
  issueNumber: number;
  blockerIssueId: number;
}

export interface SetFieldValues extends ProjectFieldValues {
  beadId?: string | null;
  parentGoal?: string | null;
  sourceUpdated?: string | null;
}

export interface SetFieldsInput {
  itemId: string;
  fields: SetFieldValues;
  beadId?: string;
  type?: 'setFields';
  phase?: 'setFields';
}

export interface SyncParentInput {
  issueNumber: number;
  parentIssueNumber: number | null;
  currentParentIssueNumber: number | null;
  beadId?: string;
  parentBeadId?: string | null;
  type?: 'syncParent';
  phase?: 'syncParents';
}

export interface SyncBlockerInput {
  issueNumber: number;
  blockerIssueNumbers: number[];
  currentBlockerIssueNumbers: readonly number[];
  beadId?: string;
  blockerBeadIds?: string[];
  type?: 'syncBlocker';
  phase?: 'syncBlockers';
}

export interface ItemMutationInput {
  itemId: string;
  beadId?: string;
  type?: 'archiveItem' | 'restoreItem';
  phase?: 'archiveItems' | 'restoreItems';
}

export interface ProvisionedProject {
  project: ProjectContext;
  fields: Map<string, ProjectFieldContext>;
  views: ProjectViewContext[];
}

export class GhClientError extends Error {
  readonly kind: string;
  readonly status?: number;

  constructor(kind: string, message: string, status?: number);
}

export const PROJECT_README_MARKER: string;
export const LEGACY_PROJECT_README_MARKER: string;
export const PROJECT_VIEWS: readonly ProjectViewDefinition[];

export interface GhClient {
  verifyAccess(): Promise<{
    organization: Record<string, unknown>;
    repository: Record<string, unknown>;
  }>;
  listRepositoryIssues(): Promise<unknown[]>;
  listManagedIssues(): Promise<ManagedIssueSnapshot[]>;
  ensureLabels(): Promise<readonly ManagedLabel[]>;

  discoverProject(): Promise<ProjectContext | null>;
  ensureProject(input: { title: string; readme: string }): Promise<ProjectContext>;
  provisionProject(input: { title: string; readme: string }): Promise<ProvisionedProject>;

  discoverFields(): Promise<Map<string, ProjectFieldContext>>;
  ensureFields(): Promise<Map<string, ProjectFieldContext>>;
  setFieldContext(fields: Map<string, ProjectFieldContext>): void;

  discoverViews(): Promise<ProjectViewContext[]>;
  ensureViews(): Promise<ProjectViewContext[]>;

  createIssue(operation: {
    title: string;
    body: string;
    assignee?: string | null;
    beadId?: string;
    renderHash?: string;
    state?: 'open';
    type?: 'createIssue';
    phase?: 'createIssues';
  }): Promise<CreatedIssueResult>;
  updateIssue(operation: {
    issueNumber: number;
    title: string;
    body: string;
    state?: string;
    assignee?: string | null;
    beadId?: string;
    renderHash?: string;
    type?: 'updateIssue';
    phase?: 'updateIssues';
  }): Promise<IssueMutationResult>;
  closeIssue(operation: {
    issueNumber: number;
    beadId?: string;
    type?: 'closeIssue';
    phase?: 'closeIssues';
  } | number): Promise<IssueMutationResult>;
  reopenIssue(operation: { issueNumber: number } | number): Promise<IssueMutationResult>;
  labelIssue(operation: LabelIssueInput): Promise<IssueMutationResult>;
  assignIssue(operation: AssignIssueInput): Promise<IssueMutationResult>;

  ensureProjectItem(operation: {
    issueNumber: number;
    beadId?: string;
    type?: 'ensureProjectItem';
    phase?: 'ensureProjectItems';
  }): Promise<{ id: string }>;
  setFields(operation: SetFieldsInput): Promise<void>;

  addSubIssue(operation: SubIssueInput): Promise<unknown>;
  removeSubIssue(operation: SubIssueInput): Promise<unknown>;
  addBlockedBy(operation: BlockedByInput): Promise<unknown>;
  removeBlockedBy(operation: BlockedByInput): Promise<unknown>;
  syncParent(operation: SyncParentInput): Promise<void>;
  syncBlocker(operation: SyncBlockerInput): Promise<void>;

  archiveItem(operation: ItemMutationInput): Promise<void>;
  restoreItem(operation: ItemMutationInput): Promise<void>;
  unarchiveItem(operation: ItemMutationInput): Promise<void>;
  updateReadme(operation: {
    body: string;
    path?: string;
    renderHash?: string;
    type?: 'updateReadme';
    phase?: 'updateReadme';
  }): Promise<void>;
}

export function createGhClient(options: {
  run: GhRun;
  owner: string;
  repo: string;
  token: string;
  projectMarker?: string;
  issueMarker?: string;
  legacyProjectMarkers?: readonly string[];
  legacyIssueMarkers?: readonly string[];
}): GhClient;
