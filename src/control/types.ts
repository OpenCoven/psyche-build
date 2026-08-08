import type { OrchestrationTaskRequest } from '../orchestration/types.js';

export type ControlActorKind = 'human' | 'psyche' | 'compatibility';

export interface ControlActor {
  id: string;
  kind: ControlActorKind;
  clientId?: string;
}

export interface CommandBase<K extends string, P> {
  id: string;
  idempotencyKey: string;
  kind: K;
  projectRoot: string;
  actor: ControlActor;
  ownerEpoch: number;
  createdAt: string;
  expiresAt?: string;
  payload: P;
}

export interface PromptEnvelope {
  promptId: string;
  paneId: string;
  taskId?: string;
  harness?: string;
  utf8: string;
  contentHash: string;
  readinessRevision?: string;
  submitMode: 'text' | 'text-and-enter';
  leaseRevision: number;
}

export type ControlCommand =
  | CommandBase<'orchestration.execute', { request: OrchestrationTaskRequest }>
  | CommandBase<'pane.spawn', {
      cwd: string;
      agent?: string;
      title?: string;
      prompt?: string;
      branch?: string;
    }>
  | CommandBase<'pane.prompt', PromptEnvelope>
  | CommandBase<'pane.interrupt', {
      paneId: string;
      key: 'C-c' | 'Escape';
      leaseRevision: number;
    }>
  | CommandBase<'pane.delegate', {
      paneId: string;
      automationActorId: string;
      taskId: string;
      ttlMs: number;
    }>
  | CommandBase<'pane.takeover', { paneId: string }>
  | CommandBase<'pane.input', {
      paneId: string;
      dataBase64: string;
      leaseRevision: number;
    }>
  | CommandBase<'pane.terminal.open', { cwd: string; title?: string }>
  | CommandBase<'pane.resize', { paneId: string; cols: number; rows: number }>
  | CommandBase<'pane.focus', { paneId: string }>
  | CommandBase<'pane.kill', { paneId: string }>
  | CommandBase<'pane.respawn', { paneId: string; cwd: string; command: string }>
  | CommandBase<'pane.conflict.open', {
      sourcePaneId: string;
      targetRepoPath: string;
      targetBranch: string;
      agent?: string;
    }>
  | CommandBase<'pane.option.update', {
      paneId: string;
      option: string;
      value?: string;
    }>
  | CommandBase<'pane.meta.update', { paneId: string; title?: string; agent?: string }>
  | CommandBase<'ritual.launch', {
      projectId: string;
      ritualId: string;
      params: Record<string, string>;
    }>
  | CommandBase<'coven.session.launch', {
      harness: string;
      prompt: string;
      cwd?: string;
      title?: string;
    }>
  | CommandBase<'coven.session.open', { sessionId: string }>
  | CommandBase<'coven.desktop.action', { sessionId: string; action: string }>
  | CommandBase<'coven.capability.execute', {
      sessionId: string;
      capability: string;
      prompt: string;
      provider?: string;
      taskId: string;
      traceId?: string;
      idempotencyKey?: string;
    }>;

export type ControlCommandInput =
  ControlCommand extends infer Command
    ? Command extends ControlCommand
      ? Omit<Command, 'ownerEpoch' | 'actor'>
      : never
    : never;

export type CommandOutcome =
  | { status: 'rejected'; code: string; message: string }
  | { status: 'succeeded'; value?: unknown }
  | { status: 'failed'; code: string; message: string }
  | { status: 'unknown'; code: string; message: string };

export interface CommandRecord {
  command: ControlCommand;
  outcome: CommandOutcome;
  sequence: number;
}

export interface ControlSnapshot {
  ownerEpoch: number;
  sequence: number;
  commands: Record<string, CommandRecord>;
  leases: Record<string, {
    paneId: string;
    actorId: string;
    actorKind: 'human' | 'psyche';
    taskId?: string;
    revision: number;
    expiresAt: string;
  }>;
}
