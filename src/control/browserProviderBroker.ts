import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { LeaseTarget } from './capabilityLeases.js';
import { validProviderEffectResult, type BrowserProviderOperation, type ProviderEffectResult,
  type ProviderPush } from './protocol.js';
import { SurfaceRegistry, type BrowserTabSurface } from './surfaces.js';
import { AGENT_CONTROL_LIMITS } from './limits.js';

export interface BrowserProviderBrokerOptions {
  projectRoot: string;
  surfaces: SurfaceRegistry;
  revokeSurfaceAuthority(target: LeaseTarget): void;
  canonicalizePath?: (candidate: string, mode?: 'existing' | 'prospective') => string | Promise<string>;
}
export interface BrowserProviderDispatch {
  actionId: string; tabId: string; generation: number;
  operation: BrowserProviderOperation;
}
export interface BrowserProviderConnection {
  upsert(resource: BrowserTabSurface): Promise<BrowserTabSurface>;
  remove(id: string, generation: number): void;
  started(requestId: string, identity: ProviderEffectStarted): void;
  executing(requestId: string, identity: ProviderEffectStarted): void;
  complete(requestId: string, result: ProviderEffectResult): void;
  disconnect(): void;
}
export interface ProviderEffectStarted {
  actionId: string; tabId: string; generation: number; invocationId: string; documentToken: string;
}
interface ActiveProvider { id: string; token: symbol; send(frame: ProviderPush): boolean }
interface PendingEffect {
  providerId: string; requestId: string; actionId: string; tabId: string; generation: number; sent: boolean;
  timer: ReturnType<typeof setTimeout>; timedOut: boolean; script: boolean; prepared: boolean; executing: boolean;
  documentToken?: string;
  resolve(result: ProviderEffectResult): void; reject(error: unknown): void;
}
const EFFECT_TOMBSTONE_TIMEOUT_MS = 60_000;
function codedError(code: string, message: string, ambiguous = false, noRetry = false, durationMs?: number): Error {
  return Object.assign(new Error(message), { code, ...(ambiguous ? { ambiguous: true } : {}),
    ...(noRetry ? { noRetry: true } : {}), ...(durationMs === undefined ? {} : { durationMs }) });
}

/** Correlates effects for the single authenticated browser provider of one project owner. */
export class BrowserProviderBroker {
  private provider: ActiveProvider | undefined;
  private readonly pendingByTab = new Map<string, PendingEffect>();
  private readonly tabTails = new Map<string, Promise<void>>();
  private readonly pendingByRequest = new Map<string, PendingEffect>();
  private readonly canonicalizePath: NonNullable<BrowserProviderBrokerOptions['canonicalizePath']>;

  constructor(private readonly options: BrowserProviderBrokerOptions) {
    this.canonicalizePath = options.canonicalizePath ?? canonicalizeFilesystemPath;
  }

  register(providerId: string, send: (frame: ProviderPush) => boolean): BrowserProviderConnection {
    if (!providerId.trim()) throw codedError('bad_request', 'providerId is required');
    if (this.provider) this.disconnect(this.provider);
    const provider: ActiveProvider = { id: providerId, token: Symbol(providerId), send };
    this.provider = provider;
    return {
      upsert: (resource) => this.upsert(provider, resource),
      remove: (id, generation) => this.remove(provider, id, generation),
      started: (requestId, identity) => this.started(provider, requestId, identity),
      executing: (requestId, identity) => this.executing(provider, requestId, identity),
      complete: (requestId, result) => this.complete(provider, requestId, result),
      disconnect: () => this.disconnect(provider),
    };
  }

  dispatch(input: BrowserProviderDispatch): Promise<ProviderEffectResult> {
    const previous = this.tabTails.get(input.tabId);
    const result = previous ? previous.then(() => this.dispatchOne(input)) : this.dispatchOne(input);
    const tail = result.then(() => undefined, () => undefined);
    this.tabTails.set(input.tabId, tail);
    tail.finally(() => { if (this.tabTails.get(input.tabId) === tail) this.tabTails.delete(input.tabId); });
    return result;
  }

  private dispatchOne(input: BrowserProviderDispatch): Promise<ProviderEffectResult> {
    const provider = this.provider;
    const resource = this.options.surfaces.get(input.tabId);
    if (!provider || !resource || resource.kind !== 'browser_tab'
      || resource.providerId !== provider.id || resource.generation !== input.generation) {
      return Promise.reject(codedError('provider_unavailable', 'browser provider is unavailable'));
    }
    if (this.pendingByTab.has(input.tabId)) {
      return Promise.reject(codedError('effect_in_flight', 'an ambiguous browser effect still fences this tab'));
    }
    const requestId = randomUUID();
    return new Promise<ProviderEffectResult>((resolve, reject) => {
      const pending: PendingEffect = {
        providerId: provider.id, requestId, actionId: input.actionId, tabId: input.tabId,
        generation: input.generation, sent: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>, timedOut: false,
        script: input.operation.kind === 'script', prepared: input.operation.kind !== 'script',
        executing: input.operation.kind !== 'script',
        ...(input.operation.kind === 'script' ? { documentToken: input.operation.expectedContext.documentToken } : {}),
        resolve, reject,
      };
      pending.timer = setTimeout(() => {
        this.markTimedOut(provider, pending);
      }, AGENT_CONTROL_LIMITS.actionTimeoutMs);
      this.pendingByTab.set(input.tabId, pending);
      this.pendingByRequest.set(requestId, pending);
      try {
        const sent = provider.send({ version: 1, type: 'provider.effect.request', requestId,
          actionId: input.actionId, tabId: input.tabId, generation: input.generation,
          operation: input.operation });
        if (!sent) throw codedError('provider_unavailable', 'browser provider disconnected before dispatch');
        pending.sent = true;
      } catch {
        this.finishPending(pending);
        reject(codedError('provider_unavailable', 'browser provider disconnected before dispatch'));
      }
    });
  }
  private started(provider: ActiveProvider, requestId: string, identity: ProviderEffectStarted): void {
    this.assertCurrent(provider);
    const pending = this.pendingByRequest.get(requestId);
    if (!pending || pending.providerId !== provider.id || !pending.script
      || pending.actionId !== identity.actionId || pending.tabId !== identity.tabId
      || pending.generation !== identity.generation || identity.invocationId !== requestId
      || pending.documentToken !== identity.documentToken || pending.prepared) {
      throw codedError('request_correlation_mismatch', 'provider effect start correlation failed');
    }
    pending.prepared = true;
  }

  private executing(provider: ActiveProvider, requestId: string, identity: ProviderEffectStarted): void {
    this.assertCurrent(provider);
    const pending = this.pendingByRequest.get(requestId);
    if (!pending || pending.providerId !== provider.id || !pending.script || !pending.prepared
      || pending.actionId !== identity.actionId || pending.tabId !== identity.tabId
      || pending.generation !== identity.generation || identity.invocationId !== requestId
      || pending.documentToken !== identity.documentToken || pending.executing) {
      throw codedError('request_correlation_mismatch', 'provider effect execution correlation failed');
    }
    pending.executing = true;
    if (!pending.timedOut) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => this.markTimedOut(provider, pending), AGENT_CONTROL_LIMITS.scriptTimeoutMs);
    }
  }

  private assertCurrent(provider: ActiveProvider): void {
    if (this.provider?.token !== provider.token) throw codedError('provider_unavailable', 'provider is disconnected');
  }
  private async upsert(provider: ActiveProvider, resource: BrowserTabSurface): Promise<BrowserTabSurface> {
    this.assertCurrent(provider);
    let canonicalProject: string;
    let canonicalResource: string;
    let canonicalWorktree: string;
    try {
      [canonicalProject, canonicalResource, canonicalWorktree] = await Promise.all([
        this.canonicalizePath(this.options.projectRoot, 'prospective'),
        this.canonicalizePath(resource.projectRoot, 'prospective'),
        this.canonicalizePath(resource.worktreeRoot, 'prospective'),
      ]);
    } catch {
      throw codedError('filesystem_target_unavailable', 'provider resource paths could not be canonicalized');
    }
    if (resource.providerId !== provider.id || canonicalResource !== canonicalProject) {
      throw codedError('provider_mismatch', 'provider resource does not match its connection');
    }
    if (!isPathWithin(canonicalProject, canonicalWorktree)) {
      throw codedError('capability_denied', 'provider worktree escapes the canonical project');
    }
    this.assertCurrent(provider);
    const previous = this.options.surfaces.get(resource.id);
    if (previous && previous.kind !== 'browser_tab') {
      throw codedError('resource_collision', `surface resource ${resource.id} belongs to another kind`);
    }
    const bindingChanged = previous?.kind !== 'browser_tab'
      || previous.providerId !== resource.providerId
      || previous.webviewLabel !== resource.webviewLabel;
    if (previous && bindingChanged) {
      this.options.revokeSurfaceAuthority({ kind: previous.kind, id: previous.id, generation: previous.generation });
    }
    return this.options.surfaces.upsertBrowserTab({
      ...resource, projectRoot: canonicalProject, worktreeRoot: canonicalWorktree,
    });
  }
  private remove(provider: ActiveProvider, id: string, generation: number): void {
    this.assertCurrent(provider);
    const resource = this.options.surfaces.get(id);
    if (!resource || resource.kind !== 'browser_tab' || resource.providerId !== provider.id) {
      throw codedError('resource_missing', `browser tab ${id} is missing`);
    }
    const removed = this.options.surfaces.removeBrowserTab(id, generation);
    this.options.revokeSurfaceAuthority({ kind: 'browser_tab', id: removed.id, generation: removed.generation });
    const pending = this.pendingByTab.get(id);
    if (pending?.providerId === provider.id && pending.generation === removed.generation) {
      this.finishPending(pending);
      if (!pending.timedOut) {
        pending.reject(codedError(
          'effect_unknown', 'browser tab was removed after effect dispatch', true, pending.script,
        ));
      }
    }
  }
  private complete(provider: ActiveProvider, requestId: string, result: ProviderEffectResult): void {
    this.assertCurrent(provider);
    const pending = this.pendingByRequest.get(requestId);
    if (!pending || pending.providerId !== provider.id) {
      throw codedError('request_correlation_mismatch', 'provider effect request correlation failed');
    }
    if (pending.actionId !== result.actionId) {
      throw codedError('action_correlation_mismatch', 'provider effect action correlation failed');
    }
    if (!validProviderEffectResult(result)) {
      throw codedError('invalid_provider_result', 'provider effect result is semantically invalid');
    }
    if (pending.script && !pending.executing && result.status !== 'unknown_pending'
      && !(pending.prepared && pending.timedOut)) {
      throw codedError('request_correlation_mismatch', 'provider effect completed before execution');
    }
    if (result.status === 'timed_out_pending') {
      if (!pending.script) {
        throw codedError('request_correlation_mismatch', 'only browser scripts can remain pending after timeout');
      }
      this.markTimedOut(provider, pending);
      return;
    }
    if (result.status === 'unknown_pending') {
      if (!pending.prepared) {
        throw codedError('request_correlation_mismatch', 'provider effect became ambiguous before preparation');
      }
      this.markUnknownPending(provider, pending, result.durationMs ?? 0);
      return;
    }
    this.finishPending(pending);
    if (!pending.timedOut) pending.resolve(result);
  }
  private disconnect(provider: ActiveProvider): void {
    if (this.provider?.token !== provider.token) return;
    this.provider = undefined;
    for (const pending of [...this.pendingByRequest.values()]) {
      if (pending.providerId !== provider.id) continue;
      this.finishPending(pending);
      pending.reject(pending.sent
        ? codedError('effect_unknown', 'browser provider disconnected after dispatch', true)
        : codedError('provider_unavailable', 'browser provider disconnected before dispatch'));
    }
    for (const resource of this.options.surfaces.removeByProvider(provider.id)) {
      this.options.revokeSurfaceAuthority({ kind: 'browser_tab', id: resource.id, generation: resource.generation });
    }
  }
  private finishPending(pending: PendingEffect): void {
    clearTimeout(pending.timer);
    this.pendingByTab.delete(pending.tabId);
    this.pendingByRequest.delete(pending.requestId);
  }

  private markTimedOut(provider: ActiveProvider, pending: PendingEffect): void {
    if (pending.timedOut || this.pendingByRequest.get(pending.requestId) !== pending) return;
    if (pending.script && !pending.executing && !pending.prepared) {
      this.finishPending(pending);
      pending.reject(codedError('provider_unavailable', 'browser script evaluation did not start', false, false, 0));
      return;
    }
    if (pending.script && !pending.executing) {
      this.markUnknownPending(provider, pending, 0);
      return;
    }
    pending.timedOut = true;
    clearTimeout(pending.timer);
    provider.send({ version: 1, type: 'provider.effect.cancel', requestId: pending.requestId,
      actionId: pending.actionId, reason: 'timeout' });
    pending.reject(codedError(
      pending.script ? 'action_timeout' : 'effect_unknown',
      pending.script ? 'browser script exceeded the execution deadline' : 'browser provider effect outcome is unknown',
      true,
      pending.script, pending.script ? AGENT_CONTROL_LIMITS.scriptTimeoutMs : undefined,
    ));
    pending.timer = setTimeout(() => {
      if (this.pendingByRequest.get(pending.requestId) === pending) this.disconnect(provider);
    }, EFFECT_TOMBSTONE_TIMEOUT_MS);
  }

  private markUnknownPending(provider: ActiveProvider, pending: PendingEffect, durationMs: number): void {
    if (pending.timedOut || this.pendingByRequest.get(pending.requestId) !== pending) return;
    pending.timedOut = true;
    clearTimeout(pending.timer);
    provider.send({ version: 1, type: 'provider.effect.cancel', requestId: pending.requestId,
      actionId: pending.actionId, reason: 'timeout' });
    pending.reject(codedError(
      'effect_unknown', 'browser script outcome is unknown after native submission', true, true, durationMs,
    ));
    pending.timer = setTimeout(() => {
      if (this.pendingByRequest.get(pending.requestId) === pending) this.disconnect(provider);
    }, EFFECT_TOMBSTONE_TIMEOUT_MS);
  }
}

async function canonicalizeFilesystemPath(
  candidate: string,
  mode: 'existing' | 'prospective' = 'existing',
): Promise<string> {
  const resolved = path.resolve(candidate);
  if (mode === 'existing') return normalizePath(await realpath(resolved));
  const remainder: string[] = [];
  let ancestor = resolved;
  for (;;) {
    try {
      return normalizePath(path.resolve(await realpath(ancestor), ...remainder.reverse()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) throw error;
      } catch (lstatError) {
        if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') throw lstatError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      remainder.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function normalizePath(value: string): string {
  return process.platform === 'darwin' ? value.normalize('NFC') : value;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
