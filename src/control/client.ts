import { connect, type Socket } from 'node:net';
import { canonicalizeProjectRoot } from './projectIdentity.js';
import { controlEndpointForProject } from './endpoint.js';
import { encodeControlMessage, type ControlRequest, type ControlResponse } from './protocol.js';
import type {
  ActionReceipt,
  ControlCommandInput,
  CommandOutcome,
  ControlSnapshot,
} from './types.js';

export interface ControlClientPrincipal {
  id: string;
  kind: 'operator' | 'agent' | 'compatibility';
  capabilities: readonly string[];
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
        const rejectAndClose = (error: Error): void => {
          cleanup();
          socket.destroy();
          reject(error);
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error('control connection closed before welcome'));
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
            rejectAndClose(new Error('invalid welcome frame'));
            return;
          }
          if (message.type === 'error') {
            rejectAndClose(new Error(`${message.code}: ${message.message}`));
            return;
          }
          if (message.type !== 'welcome') {
            rejectAndClose(new Error(`expected welcome, received ${message.type}`));
            return;
          }
          if (message.projectRoot !== canonicalRoot) {
            rejectAndClose(new Error('welcome project root does not match the requested project'));
            return;
          }
          cleanup();
          resolve(message);
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

    const client = new ControlClient(socket, canonicalRoot, welcome.ownerEpoch, welcome.principal);
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

  getState(): Promise<ControlSnapshot> {
    return this.request({
      version: 1,
      type: 'state.get',
      requestId: this.allocateRequestId(),
    }).then((response) => {
      if (response.type === 'state.result') return response.snapshot;
      throw responseError(response, 'state.get');
    });
  }

  readEvents(afterSequence: number, limit?: number): Promise<{
    events: unknown[];
    nextSequence: number;
    gap: boolean;
  }> {
    return this.request({
      version: 1,
      type: 'events.read',
      requestId: this.allocateRequestId(),
      afterSequence,
      ...(limit === undefined ? {} : { limit }),
    }).then((response) => {
      if (response.type === 'events.result') {
        return { events: response.events, nextSequence: response.nextSequence, gap: response.gap };
      }
      throw responseError(response, 'events.read');
    });
  }

  requestLease(command: Extract<ControlCommandInput, { kind: 'lease.request' }>): Promise<CommandOutcome> {
    return this.submit(command);
  }

  releaseLease(command: Extract<ControlCommandInput, { kind: 'lease.release' }>): Promise<CommandOutcome> {
    return this.submit(command);
  }

  resolveApproval(command: Extract<ControlCommandInput, { kind: 'approval.resolve' }>): Promise<CommandOutcome> {
    return this.submit(command);
  }

  async actionStatus(actionId: string): Promise<ActionReceipt | undefined> {
    const snapshot = await this.getState();
    const recent = snapshot.receipts.find((receipt) => receipt.actionId === actionId);
    if (recent) return recent;
    const pageLimit = 256;
    const historyLimit = 1_000;
    const maxPages = Math.ceil(historyLimit / pageLimit);
    let afterSequence = Math.max(0, snapshot.sequence - historyLimit);
    let found: ActionReceipt | undefined;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const remaining = historyLimit - pageNumber * pageLimit;
      const limit = Math.min(pageLimit, remaining);
      const page = await this.readEvents(afterSequence, limit);
      for (const event of page.events) {
        if (!event || typeof event !== 'object') continue;
        const payload = (event as { payload?: unknown }).payload;
        if (!payload || typeof payload !== 'object') continue;
        const receipt = (payload as { receipt?: unknown }).receipt;
        if (isActionReceipt(receipt) && receipt.actionId === actionId) found = receipt;
      }
      if (page.events.length < limit || page.nextSequence <= afterSequence) return found;
      afterSequence = page.nextSequence;
    }
    return found;
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
}

function responseError(response: ControlResponse, context: string): Error {
  if (response.type === 'error') return new Error(`${response.code}: ${response.message}`);
  return new Error(`unexpected ${response.type} response to ${context}`);
}

function isActionReceipt(value: unknown): value is ActionReceipt {
  return Boolean(value && typeof value === 'object'
    && (value as { schema?: unknown }).schema === 'psyche.control.receipt/v1'
    && typeof (value as { actionId?: unknown }).actionId === 'string');
}
