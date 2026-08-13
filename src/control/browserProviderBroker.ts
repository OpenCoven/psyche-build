import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import type { LeaseTarget } from './capabilityLeases.js';
import type { BrowserProviderOperation, ProviderEffectResult, ProviderPush } from './protocol.js';
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
  complete(requestId: string, result: ProviderEffectResult): void;
  disconnect(): void;
}
interface ActiveProvider { id: string; token: symbol; send(frame: ProviderPush): boolean }
interface PendingEffect {
  providerId: string; requestId: string; actionId: string; tabId: string; sent: boolean;
  timer: ReturnType<typeof setTimeout>; timedOut: boolean;
  resolve(result: ProviderEffectResult): void; reject(error: unknown): void;
}
function codedError(code: string, message: string, ambiguous = false): Error {
  return Object.assign(new Error(message), { code, ...(ambiguous ? { ambiguous: true } : {}) });
}

/** Correlates effects for the single authenticated browser provider of one project owner. */
export class BrowserProviderBroker {
  private provider: ActiveProvider | undefined;
  private readonly pendingByTab = new Map<string, PendingEffect>();
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
      complete: (requestId, result) => this.complete(provider, requestId, result),
      disconnect: () => this.disconnect(provider),
    };
  }

  dispatch(input: BrowserProviderDispatch): Promise<ProviderEffectResult> {
    const provider = this.provider;
    const resource = this.options.surfaces.get(input.tabId);
    if (!provider || !resource || resource.kind !== 'browser_tab'
      || resource.providerId !== provider.id || resource.generation !== input.generation) {
      return Promise.reject(codedError('provider_unavailable', 'browser provider is unavailable'));
    }
    if (this.pendingByTab.has(input.tabId)) {
      return Promise.reject(codedError('effect_in_flight', 'a browser effect is already in flight for this tab'));
    }
    const requestId = randomUUID();
    return new Promise<ProviderEffectResult>((resolve, reject) => {
      const pending: PendingEffect = {
        providerId: provider.id, requestId, actionId: input.actionId, tabId: input.tabId, sent: false,
        timer: undefined as unknown as ReturnType<typeof setTimeout>, timedOut: false, resolve, reject,
      };
      pending.timer = setTimeout(() => {
        pending.timedOut = true;
        provider.send({ version: 1, type: 'provider.effect.cancel', requestId,
          actionId: input.actionId, reason: 'timeout' });
        reject(codedError('effect_unknown', 'browser provider effect outcome is unknown', true));
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
