import { randomUUID } from 'node:crypto';
import type {
  ActionResult,
  RemoteActionResponse,
  RemoteActionResult,
} from './types.js';

interface PendingAction {
  ownerId: string;
  expiresAt: number;
  result: ActionResult;
  scope?: string;
}

export interface RemoteActionSessionsOptions {
  ttlMs: number;
  maxPending?: number;
}

const DEFAULT_MAX_PENDING = 64;
const REMOTE_CONTEXT_KEYS = [
  'host',
  'projectId',
  'projectTitle',
  'worktreePath',
  'sourceBranch',
  'targetBranch',
  'consequence',
] as const;

export class RemoteActionSessions {
  private readonly pending = new Map<string, PendingAction>();
  private readonly maxPending: number;

  constructor(private readonly options: RemoteActionSessionsOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new RangeError('ttlMs must be a positive safe integer');
    }
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) {
      throw new RangeError('maxPending must be a positive safe integer');
    }
  }

  start(ownerId: string, result: ActionResult, scope?: string): {
    sessionId?: string;
    result: RemoteActionResult;
  } {
    this.pruneExpired();
    const serialized = serializeActionResult(result);
    if (!requiresResponse(result)) return { result: serialized };
    if (this.pending.size >= this.maxPending) {
      throw actionSessionError('action_session_limit', 'too many pending action sessions');
    }

    const sessionId = randomUUID();
    this.pending.set(sessionId, {
      ownerId,
      expiresAt: Date.now() + this.options.ttlMs,
      result,
      scope,
    });
    return { sessionId, result: serialized };
  }

  async respond(
    ownerId: string,
    sessionId: string,
    response: RemoteActionResponse,
    beforeContinue?: (scope: string | undefined) => Promise<void> | void,
  ): Promise<{ sessionId?: string; result: RemoteActionResult }> {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.ownerId !== ownerId) {
      throw actionSessionError('action_session_not_found', 'action session not found');
    }
    if (pending.expiresAt <= Date.now()) {
      this.pending.delete(sessionId);
      throw actionSessionError('action_session_not_found', 'action session not found');
    }

    // Consume before every await, including scope validation, so concurrent
    // replies cannot both retain a reference and execute the same callback.
    // Failed validation remains consumed (fail closed).
    this.pending.delete(sessionId);
    await beforeContinue?.(pending.scope);
    const next = inheritRemoteContext(
      await continueAction(pending.result, response),
      pending.result,
    );
    return this.start(ownerId, next, pending.scope);
  }

  clearOwner(ownerId: string): void {
    for (const [sessionId, pending] of this.pending) {
      if (pending.ownerId === ownerId) this.pending.delete(sessionId);
    }
  }

  clearAll(): void {
    this.pending.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [sessionId, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(sessionId);
    }
  }
}

function requiresResponse(result: ActionResult): boolean {
  return result.type === 'confirm'
    || result.type === 'choice'
    || result.type === 'input'
    || result.type === 'pr_review';
}

export function serializeActionResult(result: ActionResult): RemoteActionResult {
  const {
    onConfirm: _onConfirm,
    onCancel: _onCancel,
    onSelect: _onSelect,
    onSubmit: _onSubmit,
    data,
    ...serializable
  } = result;
  const remoteData = toRemoteStringData(data);
  const relatedFiles = readRemoteFiles(data);

  return {
    ...serializable,
    ...(Object.keys(remoteData).length > 0 ? { data: remoteData } : {}),
    ...(relatedFiles ? { relatedFiles } : {}),
  };
}

export function toRemoteStringData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readRemoteFiles(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const files = (value as Record<string, unknown>).files;
  if (!Array.isArray(files)) return undefined;
  return files.filter((file): file is string => typeof file === 'string');
}

function inheritRemoteContext(next: ActionResult, previous: ActionResult): ActionResult {
  const previousData = toRemoteStringData(previous.data);
  const context = Object.fromEntries(
    REMOTE_CONTEXT_KEYS.flatMap((key) => previousData[key] ? [[key, previousData[key]]] : []),
  );
  const nextData = next.data && typeof next.data === 'object'
    ? next.data as Record<string, unknown>
    : {};
  const previousFiles = readRemoteFiles(previous.data);
  const inheritFiles = previousFiles !== undefined
    && !Object.prototype.hasOwnProperty.call(nextData, 'files');
  if (Object.keys(context).length === 0 && !inheritFiles) return next;
  return {
    ...next,
    data: {
      ...(inheritFiles ? { files: previousFiles } : {}),
      ...context,
      ...nextData,
    },
  };
}

async function continueAction(
  result: ActionResult,
  response: RemoteActionResponse,
): Promise<ActionResult> {
  if (response.kind === 'cancel') return cancelAction(result);
  if (result.type === 'confirm' && response.kind === 'confirm') {
    if (!response.confirmed) return cancelAction(result);
    if (!result.onConfirm) {
      throw actionSessionError('invalid_action_state', 'confirmation callback missing');
    }
    return result.onConfirm();
  }
  if (result.type === 'choice' && response.kind === 'choice') {
    if (!result.onSelect) {
      throw actionSessionError('invalid_action_state', 'choice callback missing');
    }
    return result.onSelect(response.optionId);
  }
  if ((result.type === 'input' || result.type === 'pr_review') && response.kind === 'input') {
    if (!result.onSubmit) {
      throw actionSessionError('invalid_action_state', 'input callback missing');
    }
    return result.onSubmit(response.value);
  }
  throw actionSessionError('invalid_action_response', 'response does not match action state');
}

function cancelAction(result: ActionResult): Promise<ActionResult> | ActionResult {
  return result.onCancel
    ? result.onCancel()
    : { type: 'info', message: 'Action cancelled', dismissable: true };
}

function actionSessionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
