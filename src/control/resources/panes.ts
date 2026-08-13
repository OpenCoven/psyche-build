import {
  spawnBridgePane,
  type BridgeSpawnRequest,
  type BridgeSpawnResult,
} from '../../daemon/bridge.js';
import {
  createPane,
  type CreatePaneOptions,
  type CreatePaneResult,
} from '../../utils/paneCreation.js';
import { readProjectPaneConfig } from '../../services/ProjectPaneConfig.js';
import type { PaneSurface, SurfaceRegistry } from '../surfaces.js';
import { PaneObservationStore } from './paneObservation.js';
import type { PaneObservationResult } from '../types.js';

export type {
  BridgeSpawnRequest,
  BridgeSpawnResult,
  CreatePaneOptions,
  CreatePaneResult,
};

/**
 * Effect boundary for pane creation.
 *
 * The orchestration backends are pure policy/translation units; they must not
 * import pane-mutation effects directly. This module is the single place that
 * constructs those capabilities, so a backend can only reach a real effect
 * through an explicitly injected (or defaulted-from-here) capability.
 */
export const defaultSpawnPane = spawnBridgePane;
export const defaultCreatePane = createPane;

export interface PaneResourceProjection {
  readonly id: string;
  readonly tmuxPaneId: string;
  readonly worktreeRoot: string;
  readonly title?: string;
  readonly agent?: string;
  readonly writable: boolean;
}

export interface PaneResourceControllerOptions {
  surfaces: SurfaceRegistry;
  observations: PaneObservationStore;
  projectRoot: string;
  load?: (projectRoot: string) => Promise<readonly PaneResourceProjection[]>;
  onRemove?: (resource: PaneSurface) => void;
}

interface PaneOutputEmitter {
  on(event: 'output', listener: (paneId: string, data: Buffer) => void): unknown;
  on(event: 'paneSetChanged', listener: () => void): unknown;
  on(event: 'paneSetEmpty', listener: () => void): unknown;
  off(event: 'output', listener: (paneId: string, data: Buffer) => void): unknown;
  off(event: 'paneSetChanged', listener: () => void): unknown;
  off(event: 'paneSetEmpty', listener: () => void): unknown;
  listPaneIds(): Promise<readonly string[]>;
}

/** Owns the stable Psyche-pane projection and its native tmux effect binding. */
export class PaneResourceController {
  private readonly byTmuxPaneId = new Map<string, { id: string; generation: number }>();
  private readonly load: (projectRoot: string) => Promise<readonly PaneResourceProjection[]>;
  private paneSource?: PaneOutputEmitter;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconcileTail: Promise<readonly PaneSurface[]> = Promise.resolve(Object.freeze([]));
  private reconcileGeneration = 0;

  constructor(private readonly options: PaneResourceControllerOptions) {
    this.load = options.load ?? loadPaneResourceProjections;
  }

  upsert(input: PaneResourceProjection): PaneSurface {
    const previous = this.options.surfaces.get(input.id);
    const nativeOwner = this.byTmuxPaneId.get(input.tmuxPaneId);
    if (nativeOwner && nativeOwner.id !== input.id) {
      throw duplicateTmuxBinding(input.tmuxPaneId);
    }
    if (previous?.kind === 'pane' && previous.tmuxPaneId !== input.tmuxPaneId) {
      this.byTmuxPaneId.delete(previous.tmuxPaneId);
      this.options.observations.reset(previous.id);
      this.options.onRemove?.(previous);
    }
    const resource = this.options.surfaces.upsertPane({
      ...input,
      projectRoot: this.options.projectRoot,
      outputSequence: this.options.observations.sequence(input.id),
    });
    this.byTmuxPaneId.set(resource.tmuxPaneId, { id: resource.id, generation: resource.generation });
    return resource;
  }

  async refresh(): Promise<readonly PaneSurface[]> {
    const run = async (): Promise<readonly PaneSurface[]> => {
      const generation = this.reconcileGeneration;
      const source = this.paneSource;
      const configured = await this.load(this.options.projectRoot);
      if (generation !== this.reconcileGeneration) {
        return this.currentPanes();
      }
      assertProjectionBijection(configured);
      const liveIds = source ? new Set(await source.listPaneIds()) : undefined;
      if (generation !== this.reconcileGeneration) return this.currentPanes();
      const projections = liveIds
        ? configured.filter(({ tmuxPaneId }) => liveIds.has(tmuxPaneId))
        : configured;
      this.assertNoBindingCollisions(projections);
      const seen = new Set(projections.map(({ id }) => id));
      for (const existing of this.options.surfaces.list()) {
        if (existing.kind === 'pane' && existing.projectRoot === this.options.projectRoot && !seen.has(existing.id)) {
          this.remove(existing.id, existing.generation);
        }
      }
      return Object.freeze(projections.map((projection) => this.upsert(projection)));
    };
    const result = this.reconcileTail.then(run, run);
    this.reconcileTail = result;
    return result;
  }

  current(id: string): PaneSurface | undefined {
    const resource = this.options.surfaces.get(id);
    return resource?.kind === 'pane' ? resource : undefined;
  }

  resolve(id: string, generation: number): PaneSurface {
    const resource = this.options.surfaces.require(id, generation);
    if (resource.kind !== 'pane') {
      throw Object.assign(new Error(`surface resource ${id} is not a pane`), { code: 'resource_replaced' });
    }
    return resource;
  }

  observe(id: string, generation: number, afterSequence?: number): PaneObservationResult {
    this.resolve(id, generation);
    return this.options.observations.read(id, { afterSequence });
  }

  appendTmuxOutput(tmuxPaneId: string, data: Buffer): number | undefined {
    const binding = this.byTmuxPaneId.get(tmuxPaneId);
    if (!binding) return undefined;
    const current = this.current(binding.id);
    if (!current || current.generation !== binding.generation || current.tmuxPaneId !== tmuxPaneId) return undefined;
    const sequence = this.options.observations.append(binding.id, data);
    this.options.surfaces.upsertPane({ ...current, outputSequence: sequence });
    return sequence;
  }

  remove(id: string, generation: number): PaneSurface {
    const removed = this.options.surfaces.removePane(id, generation);
    const binding = this.byTmuxPaneId.get(removed.tmuxPaneId);
    if (binding?.id === removed.id && binding.generation === removed.generation) {
      this.byTmuxPaneId.delete(removed.tmuxPaneId);
    }
    this.options.observations.remove(removed.id);
    this.options.onRemove?.(removed);
    return removed;
  }

  removeByTmuxPaneId(tmuxPaneId: string): Readonly<{ id: string; generation: number }> | undefined {
    const binding = this.byTmuxPaneId.get(tmuxPaneId);
    if (!binding) return undefined;
    const current = this.current(binding.id);
    if (!current || current.generation !== binding.generation || current.tmuxPaneId !== tmuxPaneId) {
      this.byTmuxPaneId.delete(tmuxPaneId);
      return undefined;
    }
    this.remove(binding.id, binding.generation);
    return Object.freeze({ ...binding });
  }

  subscribe(tmux: PaneOutputEmitter): () => void {
    this.reconcileGeneration += 1;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = undefined;
    this.paneSource = tmux;
    const onOutput = (paneId: string, data: Buffer) => {
      this.appendTmuxOutput(paneId, data);
    };
    const onPaneSetChanged = () => {
      if (this.reconcileTimer) return;
      this.reconcileTimer = setTimeout(() => {
        this.reconcileTimer = undefined;
        void this.refresh().catch(() => undefined);
      }, 10);
      this.reconcileTimer.unref?.();
    };
    const onPaneSetEmpty = () => {
      if (this.paneSource !== tmux) return;
      this.reconcileGeneration += 1;
      if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
      this.reconcileTimer = undefined;
      if (this.paneSource === tmux) this.paneSource = undefined;
      for (const resource of this.options.surfaces.list()) {
        if (resource.kind === 'pane' && resource.projectRoot === this.options.projectRoot) {
          this.remove(resource.id, resource.generation);
        }
      }
    };
    tmux.on('output', onOutput);
    tmux.on('paneSetChanged', onPaneSetChanged);
    tmux.on('paneSetEmpty', onPaneSetEmpty);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.paneSource === tmux) {
        this.reconcileGeneration += 1;
        if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
        this.reconcileTimer = undefined;
        this.paneSource = undefined;
      }
      tmux.off('output', onOutput);
      tmux.off('paneSetChanged', onPaneSetChanged);
      tmux.off('paneSetEmpty', onPaneSetEmpty);
    };
  }

  private currentPanes(): readonly PaneSurface[] {
    return Object.freeze(
      this.options.surfaces.list().filter(
        (resource): resource is PaneSurface =>
          resource.kind === 'pane' && resource.projectRoot === this.options.projectRoot,
      ),
    );
  }

  private assertNoBindingCollisions(projections: readonly PaneResourceProjection[]): void {
    for (const projection of projections) {
      const owner = this.byTmuxPaneId.get(projection.tmuxPaneId);
      if (owner && owner.id !== projection.id) throw duplicateTmuxBinding(projection.tmuxPaneId);
    }
  }
}

function assertProjectionBijection(projections: readonly PaneResourceProjection[]): void {
  const owners = new Map<string, string>();
  for (const projection of projections) {
    if (owners.has(projection.tmuxPaneId)) throw duplicateTmuxBinding(projection.tmuxPaneId);
    owners.set(projection.tmuxPaneId, projection.id);
  }
}

function duplicateTmuxBinding(tmuxPaneId: string): Error & { code: string } {
  return Object.assign(new Error(`tmux pane ${tmuxPaneId} has multiple stable resources`), {
    code: 'duplicate_tmux_binding',
  });
}

export async function loadPaneResourceProjections(projectRoot: string): Promise<readonly PaneResourceProjection[]> {
  const config = await readProjectPaneConfig(projectRoot);
  const projections: PaneResourceProjection[] = [];
  for (const pane of config.panes ?? []) {
    const id = typeof pane.id === 'string' ? pane.id : '';
    const tmuxPaneId = typeof pane.paneId === 'string' ? pane.paneId : '';
    if (!id || !tmuxPaneId) continue;
    projections.push(Object.freeze({
      id,
      tmuxPaneId,
      worktreeRoot: stringField(pane, 'worktreePath')
        ?? stringField(pane, 'cwdReference')
        ?? projectRoot,
      title: stringField(pane, 'title') ?? stringField(pane, 'displayName') ?? stringField(pane, 'slug'),
      agent: stringField(pane, 'agent'),
      writable: true,
    }));
  }
  return Object.freeze(projections);
}

function stringField(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
