import type { BrowserTabSurface } from './surfaces.js';
import type { BrowserSemanticAction } from './types.js';

export type BrowserProviderOperation =
  | { kind: 'inspect'; includeScreenshot?: boolean }
  | { kind: 'action'; snapshotId?: string; action: BrowserSemanticAction }
  | { kind: 'script'; source: string; args?: unknown };

export type ProviderEffectResult =
  | { actionId: string; status: 'succeeded'; value?: unknown }
  | { actionId: string; status: 'failed'; code: string; message: string }
  | { actionId: string; status: 'unknown'; code?: string; message?: string };

export interface ProviderPush {
  version: 1;
  type: 'provider.effect.request';
  requestId: string;
  actionId: string;
  tabId: string;
  generation: number;
  operation: BrowserProviderOperation;
}

export interface BrowserProviderRegistration {
  readonly providerId: string;
  upsert(resource: BrowserTabSurface): Promise<void>;
  remove(id: string, generation: number): Promise<void>;
  complete(result: ProviderEffectResult): void;
  disconnect(): Promise<void>;
}

export interface BrowserProviderBrokerOptions {
  upsertResource?: (
    providerId: string,
    resource: BrowserTabSurface,
  ) => Promise<BrowserTabSurface | void>;
  removeResource?: (providerId: string, id: string, generation: number) => Promise<void>;
  removeProviderResources?: (providerId: string) => Promise<void>;
  maxProviders?: number;
  maxPending?: number;
  maxTimeoutMs?: number;
}

interface ProviderState {
  readonly id: string;
  readonly send: (frame: ProviderPush) => void;
  connected: boolean;
}

interface PendingEffect {
  readonly actionId: string;
  readonly providerId: string;
  readonly tabId: string;
  readonly generation: number;
  readonly timeout: NodeJS.Timeout;
  readonly resolve: (result: ProviderEffectResult) => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_MAX_PROVIDERS = 8;
const DEFAULT_MAX_PENDING = 128;
const DEFAULT_MAX_TIMEOUT_MS = 60_000;

/**
 * Correlates browser effects with one authenticated desktop provider.
 *
 * The broker owns only transport state. Resource mutations are delegated to
 * the runtime-backed callbacks so the control runtime remains the authority.
 */
export class BrowserProviderBroker {
  private readonly providers = new Map<string, ProviderState>();
  private readonly resources = new Map<string, BrowserTabSurface>();
  private readonly pending = new Map<string, PendingEffect>();
  private readonly pendingByTab = new Map<string, string>();
  private readonly disconnects = new Set<Promise<void>>();
  private disconnectFailure: unknown;
  private readonly maxProviders: number;
  private readonly maxPending: number;
  private readonly maxTimeoutMs: number;

  constructor(private readonly options: BrowserProviderBrokerOptions = {}) {
    this.maxProviders = options.maxProviders ?? DEFAULT_MAX_PROVIDERS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Wait until disconnect-triggered runtime revocations have completed. */
  async ready(): Promise<void> {
    if (this.disconnectFailure) throw this.disconnectFailure;
    if (this.disconnects.size > 0) await Promise.all([...this.disconnects]);
    if (this.disconnectFailure) throw this.disconnectFailure;
  }

  register(
    providerId: string,
    send: (frame: ProviderPush) => void,
  ): BrowserProviderRegistration {
    requireBoundedId(providerId, 'provider id');
    if (this.providers.has(providerId)) {
      throw brokerError('provider_already_registered', 'provider is already connected');
    }
    if (this.providers.size >= this.maxProviders) {
      throw brokerError('provider_limit', 'provider limit reached');
    }
    const state: ProviderState = { id: providerId, send, connected: true };
    this.providers.set(providerId, state);
    let disconnected = false;
    return {
      providerId,
      upsert: async (resource) => {
        this.requireLiveRegistration(state, disconnected);
        await this.upsert(state, resource);
      },
      remove: async (id, generation) => {
        this.requireLiveRegistration(state, disconnected);
        await this.remove(state, id, generation);
      },
      complete: (result) => {
        this.requireLiveRegistration(state, disconnected);
        this.complete(state, result);
      },
      disconnect: async () => {
        if (disconnected) return;
        disconnected = true;
        const cleanup = this.disconnect(state);
        this.disconnects.add(cleanup);
        try {
          await cleanup;
        } catch (error) {
          this.disconnectFailure = error;
          throw error;
        } finally {
          this.disconnects.delete(cleanup);
        }
      },
    };
  }

  dispatch(input: {
    actionId: string;
    tabId: string;
    generation: number;
    operation: BrowserProviderOperation;
    timeoutMs: number;
  }): Promise<ProviderEffectResult> {
    requireBoundedId(input.actionId, 'action id');
    requireBoundedId(input.tabId, 'tab id');
    const resource = this.resources.get(input.tabId);
    if (!resource) return Promise.reject(brokerError('provider_unavailable', 'browser provider is unavailable'));
    if (resource.generation !== input.generation) {
      return Promise.reject(brokerError('resource_replaced', 'browser tab generation was replaced'));
    }
    const provider = this.providers.get(resource.providerId);
    if (!provider?.connected) {
      return Promise.reject(brokerError('provider_unavailable', 'browser provider is unavailable'));
    }
    if (this.pending.has(input.actionId)) {
      return Promise.reject(brokerError('duplicate_action', 'browser action is already pending'));
    }
    if (this.pendingByTab.has(input.tabId)) {
      return Promise.reject(brokerError('provider_busy', 'browser tab already has an in-flight effect'));
    }
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(brokerError('provider_busy', 'provider pending effect limit reached'));
    }

    const timeoutMs = Math.max(1, Math.min(input.timeoutMs, this.maxTimeoutMs));
    return new Promise<ProviderEffectResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.settle(input.actionId);
        reject(ambiguousEffect('browser provider effect timed out'));
      }, timeoutMs);
      timeout.unref?.();
      const pending: PendingEffect = {
        actionId: input.actionId,
        providerId: provider.id,
        tabId: input.tabId,
        generation: input.generation,
        timeout,
        resolve,
        reject,
      };
      this.pending.set(input.actionId, pending);
      this.pendingByTab.set(input.tabId, input.actionId);
      try {
        provider.send({
          version: 1,
          type: 'provider.effect.request',
          requestId: input.actionId,
          actionId: input.actionId,
          tabId: input.tabId,
          generation: input.generation,
          operation: input.operation,
        });
      } catch {
        this.settle(input.actionId);
        reject(ambiguousEffect('browser provider effect delivery is unknown'));
      }
    });
  }

  private async upsert(state: ProviderState, resource: BrowserTabSurface): Promise<void> {
    if (resource.kind !== 'browser_tab' || resource.providerId !== state.id) {
      throw brokerError('provider_scope_mismatch', 'browser resource belongs to another provider');
    }
    requireGeneration(resource.generation);
    const current = this.resources.get(resource.id);
    if (current && current.providerId !== state.id) {
      throw brokerError('provider_scope_mismatch', 'browser resource belongs to another provider');
    }
    const canonical = await this.options.upsertResource?.(state.id, resource) ?? resource;
    if (canonical.id !== resource.id || canonical.providerId !== state.id) {
      throw brokerError('provider_scope_mismatch', 'runtime returned a mismatched browser resource');
    }
    this.resources.set(canonical.id, canonical);
  }

  private async remove(state: ProviderState, id: string, generation: number): Promise<void> {
    requireBoundedId(id, 'tab id');
    requireGeneration(generation);
    const resource = this.resources.get(id);
    if (!resource || resource.providerId !== state.id) {
      throw brokerError('provider_scope_mismatch', 'browser resource belongs to another provider');
    }
    if (resource.generation !== generation) {
      throw brokerError('resource_replaced', 'browser tab generation was replaced');
    }
    await this.options.removeResource?.(state.id, id, generation);
    this.resources.delete(id);
  }

  private complete(state: ProviderState, result: ProviderEffectResult): void {
    requireBoundedId(result.actionId, 'action id');
    const pending = this.pending.get(result.actionId);
    if (!pending || pending.providerId !== state.id) {
      throw brokerError('effect_not_pending', 'provider effect is not pending for this provider');
    }
    this.settle(result.actionId);
    pending.resolve(result);
  }

  private async disconnect(state: ProviderState): Promise<void> {
    state.connected = false;
    this.providers.delete(state.id);
    for (const pending of [...this.pending.values()]) {
      if (pending.providerId !== state.id) continue;
      this.settle(pending.actionId);
      pending.reject(ambiguousEffect('browser provider disconnected after effect dispatch'));
    }
    const owned = [...this.resources.values()].filter((resource) => resource.providerId === state.id);
    for (const resource of owned) this.resources.delete(resource.id);
    await this.options.removeProviderResources?.(state.id);
  }

  private settle(actionId: string): void {
    const pending = this.pending.get(actionId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(actionId);
    if (this.pendingByTab.get(pending.tabId) === actionId) this.pendingByTab.delete(pending.tabId);
  }

  private requireLiveRegistration(state: ProviderState, disconnected: boolean): void {
    if (disconnected || !state.connected || this.providers.get(state.id) !== state) {
      throw brokerError('provider_unavailable', 'browser provider is disconnected');
    }
  }
}

function requireBoundedId(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw brokerError('bad_request', `${label} is invalid`);
  }
}

function requireGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw brokerError('bad_request', 'browser resource generation is invalid');
  }
}

function brokerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function ambiguousEffect(message: string): Error & { code: 'effect_unknown'; ambiguous: true } {
  return Object.assign(new Error(message), { code: 'effect_unknown' as const, ambiguous: true as const });
}
