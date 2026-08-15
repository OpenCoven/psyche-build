import { connect, type Socket } from 'node:net';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import { controlEndpointForProject } from './endpoint.js';
import { encodeControlMessage, type ControlRequest, type ControlResponse } from './protocol.js';
import {
  isActionStatusReceipt,
} from './types.js';
import type {
  ActionReceipt,
  ControlCommand,
  ControlCommandInput,
  CommandOutcome,
  ControlSnapshot,
  ControlSnapshotScope,
} from './types.js';

type InputFor<K extends ControlCommand['kind']> = Extract<ControlCommandInput, { kind: K }>;
type HelperInput<K extends ControlCommand['kind']> = Omit<InputFor<K>, 'kind' | 'projectRoot'>;

export interface ControlClientPrincipal {
  id: string;
  kind: 'operator' | 'agent' | 'compatibility';
  capabilities: readonly string[];
}

export interface ControlClientTaskBinding {
  taskId: string;
  subjectId?: string;
}

export interface ControlClientOptions {
  projectRoot: string;
  token: string;
  clientName: string;
  endpoint?: string;
  signal?: AbortSignal;
}

interface PendingRequest {
  resolve: (response: ControlResponse) => void;
  reject: (error: Error) => void;
}

export class ControlResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlResponseError';
  }
}

/**
 * The canonical client for the host control plane.
 *
 * It derives its endpoint purely from the canonical project root, learns the
 * owner epoch and its server-assigned principal from the welcome frame, and
 * correlates every response by request id. A dropped connection rejects all
 * in-flight requests; a mutation is never retried automatically, so an
 * ambiguous send is surfaced to the caller instead of silently replayed.
 */
export class ControlClient {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = '';
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    readonly projectRoot: string,
    readonly ownerEpoch: number,
    readonly principal: ControlClientPrincipal,
    readonly taskBinding?: ControlClientTaskBinding,
  ) {}

  static async connect(options: ControlClientOptions): Promise<ControlClient> {
    const canonicalRoot = await canonicalizeProjectRoot(options.projectRoot);
    return ControlClient.connectCanonical({ ...options, projectRoot: canonicalRoot });
  }

  /**
   * Connect using a root already resolved by the trusted owner bootstrap.
   * Normal callers should use connect(), which canonicalizes defensively.
   */
  static async connectCanonical(options: ControlClientOptions): Promise<ControlClient> {
    const canonicalRoot = options.projectRoot;
    const endpoint = options.endpoint ?? controlEndpointForProject(canonicalRoot);

    const socket = connect(endpoint);
    socket.setEncoding('utf8');

    const welcome = await new Promise<Extract<ControlResponse, { type: 'welcome' }>>(
      (resolve, reject) => {
        let buffer = '';
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          reject(error);
        };
        const succeed = (message: Extract<ControlResponse, { type: 'welcome' }>): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(message);
        };
        const onAbort = (): void => fail(Object.assign(new Error('control connection aborted'), {
          name: 'AbortError', code: 'ABORT_ERR',
        }));
        const onError = (error: Error): void => {
          fail(error);
        };
        const onClose = (): void => {
          fail(new Error('control connection closed before welcome'));
        };
        const onAbort = (): void => {
          const error = Object.assign(new Error('control connection aborted'), {
            name: 'AbortError',
            code: 'ABORT_ERR',
          });
          rejectAndClose(error);
        };
        const onData = (chunk: string): void => {
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          let message: ControlResponse;
          try {
            message = JSON.parse(line) as ControlResponse;
          } catch {
            fail(new Error('invalid welcome frame'));
            return;
          }
          if (message.type === 'error') {
            fail(new Error(`${message.code}: ${message.message}`));
            return;
          }
          if (message.type !== 'welcome') {
            fail(new Error(`expected welcome, received ${message.type}`));
            return;
          }
          if (message.projectRoot !== canonicalRoot) {
            fail(new Error('welcome project root does not match the requested project'));
            return;
          }
          succeed(message);
        };
        const cleanup = (): void => {
          socket.off('data', onData);
          socket.off('error', onError);
          socket.off('close', onClose);
          options.signal?.removeEventListener('abort', onAbort);
        };
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        socket.on('data', onData);
        socket.once('error', onError);
        socket.once('close', onClose);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        socket.write(`${encodeControlMessage({
          version: 1,
          type: 'hello',
          requestId: 'hello',
          token: options.token,
          clientName: options.clientName,
          projectRoot: canonicalRoot,
        })}\n`);
      },
    );

    const client = new ControlClient(
      socket,
      canonicalRoot,
      welcome.ownerEpoch,
      welcome.principal,
      welcome.taskBinding,
    );
    client.attach();
    return client;
  }

  submit(command: ControlCommandInput): Promise<CommandOutcome> {
    return this.request({
      version: 1,
      type: 'command.submit',
      requestId: this.allocateRequestId(),
      command: { ...command, projectRoot: this.projectRoot },
    }).then((response) => {
      if (response.type === 'command.result') return response.outcome;
      throw responseError(response, 'command.submit');
    });
  }

  getState(scope: ControlSnapshotScope = {}): Promise<ControlSnapshot> {
    const effectiveScope = this.effectiveScope(scope);
    return this.request({
      version: 1,
      type: 'state.get',
      requestId: this.allocateRequestId(),
      ...(effectiveScope.taskId === undefined ? {} : { taskId: effectiveScope.taskId }),
    }).then((response) => {
      if (response.type === 'state.result') return response.snapshot;
      throw responseError(response, 'state.get');
    });
  }

  readEvents(afterSequence: number, limit?: number, scope: ControlSnapshotScope = {}): Promise<{
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  }> {
    const effectiveScope = this.effectiveScope(scope);
    return this.request({
      version: 1,
      type: 'events.read',
      requestId: this.allocateRequestId(),
      afterSequence,
      ...(limit === undefined ? {} : { limit }),
      ...(effectiveScope.taskId === undefined ? {} : { taskId: effectiveScope.taskId }),
    }).then((response) => {
      if (response.type === 'events.result') {
        return { events: response.events, nextSequence: response.nextSequence, gap: response.gap };
      }
      throw responseError(response, 'events.read');
    });
  }

  requestLease(input: HelperInput<'lease.request'>): Promise<CommandOutcome> {
    return this.submit({ ...input, kind: 'lease.request', projectRoot: this.projectRoot });
  }

  releaseLease(input: HelperInput<'lease.release'>): Promise<CommandOutcome> {
    return this.submit({ ...input, kind: 'lease.release', projectRoot: this.projectRoot });
  }

  resolveApproval(input: HelperInput<'approval.resolve'>): Promise<CommandOutcome> {
    return this.submit({ ...input, kind: 'approval.resolve', projectRoot: this.projectRoot });
  }

  async actionStatus(actionId: string): Promise<ActionReceipt | undefined> {
    return this.request({
      version: 1, type: 'action.status', requestId: this.allocateRequestId(), actionId,
    }).then((response) => {
      if (response.type === 'action.status.result') return response.receipt;
      throw responseError(response, 'action.status');
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.socket.destroy();
        done();
      }, 1000);
      timer.unref?.();
      this.socket.once('close', done);
      this.socket.end();
    });
  }

  private attach(): void {
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('close', () => this.rejectAll(new Error('control connection closed')));
    this.socket.on('error', (error: Error) => this.rejectAll(error));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.trim().length === 0) continue;
      let message: ControlResponse;
      try {
        message = JSON.parse(line) as ControlResponse;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: ControlResponse): void {
    if (message.type === 'error' && message.requestId === undefined) {
      this.rejectAll(new Error(`${message.code}: ${message.message}`));
      return;
    }
    const requestId = 'requestId' in message ? message.requestId : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.resolve(message);
  }

  private request(message: ControlRequest): Promise<ControlResponse> {
    if (this.closed) return Promise.reject(new Error('control client is closed'));
    return new Promise<ControlResponse>((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject });
      this.socket.write(`${encodeControlMessage(message)}\n`, (error) => {
        if (error) {
          this.pending.delete(message.requestId);
          reject(error);
        }
      });
    });
  }

  private rejectAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private allocateRequestId(): string {
    const id = `req-${this.nextRequestId}`;
    this.nextRequestId += 1;
    return id;
  }

  private effectiveScope(scope: ControlSnapshotScope = {}): ControlSnapshotScope {
    if (this.principal.kind === 'operator') return scope;
    if (this.taskBinding?.taskId) return { taskId: this.taskBinding.taskId };
    return {};
  }
}

function responseError(response: ControlResponse, context: string): Error {
  if (response.type === 'error') {
    return new ControlResponseError(response.code, `${response.code}: ${response.message}`);
  }
  return new Error(`unexpected ${response.type} response to ${context}`);
}

function eventActionReceipt(value: unknown): ActionStatusReceipt | undefined {
  return isActionStatusReceipt(value) ? value : undefined;
}
