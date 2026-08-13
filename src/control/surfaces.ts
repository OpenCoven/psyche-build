export type SurfaceKind = 'pane' | 'browser_tab';

export interface SurfaceBase<K extends SurfaceKind> {
  readonly id: string;
  readonly kind: K;
  readonly generation: number;
  readonly projectRoot: string;
  readonly worktreeRoot: string;
}

export interface PaneSurface extends SurfaceBase<'pane'> {
  readonly tmuxPaneId: string;
  readonly title?: string;
  readonly agent?: string;
  readonly writable: boolean;
  readonly outputSequence: number;
}

export interface BrowserTabSurface extends SurfaceBase<'browser_tab'> {
  readonly providerId: string;
  readonly webviewLabel: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
}

export type SurfaceResource = PaneSurface | BrowserTabSurface;

type SurfaceInput<T extends SurfaceResource> =
  Omit<T, 'kind' | 'generation'> & Partial<Pick<T, 'kind' | 'generation'>>;

export class SurfaceRegistry {
  private readonly resources = new Map<string, SurfaceResource>();
  private readonly generations = new Map<string, number>();

  upsertPane(input: SurfaceInput<PaneSurface>): PaneSurface {
    const previous = this.resources.get(input.id);
    if (previous && previous.kind !== 'pane') {
      throw Object.assign(new Error(`surface resource ${input.id} belongs to another kind`), {
        code: 'resource_collision',
      });
    }
    const generation = previous
      ? previous.generation + (previous.kind !== 'pane' || previous.tmuxPaneId !== input.tmuxPaneId ? 1 : 0)
      : (this.generations.get(input.id) ?? 0) + 1;
    const resource: PaneSurface = Object.freeze({ ...input, kind: 'pane', generation });
    this.resources.set(resource.id, resource);
    this.generations.set(resource.id, generation);
    return resource;
  }

  upsertBrowserTab(input: SurfaceInput<BrowserTabSurface>): BrowserTabSurface {
    const previous = this.resources.get(input.id);
    if (previous && previous.kind !== 'browser_tab') {
      throw Object.assign(new Error(`surface resource ${input.id} belongs to another kind`), {
        code: 'resource_collision',
      });
    }
    const bindingChanged = previous?.kind !== 'browser_tab'
      || previous.providerId !== input.providerId
      || previous.webviewLabel !== input.webviewLabel;
    const generation = previous
      ? previous.generation + (bindingChanged ? 1 : 0)
      : (this.generations.get(input.id) ?? 0) + 1;
    const resource: BrowserTabSurface = Object.freeze({
      ...input,
      kind: 'browser_tab',
      generation,
      viewport: Object.freeze({ ...input.viewport }),
    });
    this.resources.set(resource.id, resource);
    this.generations.set(resource.id, generation);
    return resource;
  }

  require(id: string, generation: number): SurfaceResource {
    const resource = this.resources.get(id);
    if (!resource) {
      throw Object.assign(new Error(`surface resource ${id} is missing`), { code: 'resource_missing' });
    }
    if (resource.generation !== generation) {
      throw Object.assign(new Error(`surface resource ${id} was replaced`), { code: 'resource_replaced' });
    }
    return resource;
  }

  get(id: string): SurfaceResource | undefined {
    return this.resources.get(id);
  }

  list(): readonly SurfaceResource[] {
    return Object.freeze([...this.resources.values()]);
  }

  removePane(id: string, expectedGeneration: number): PaneSurface {
    const resource = this.require(id, expectedGeneration);
    if (resource.kind !== 'pane') {
      throw Object.assign(new Error(`surface resource ${id} is not a pane`), { code: 'resource_replaced' });
    }
    this.resources.delete(id);
    return resource;
  }

  removeBrowserTab(id: string, expectedGeneration: number): BrowserTabSurface {
    const resource = this.require(id, expectedGeneration);
    if (resource.kind !== 'browser_tab') {
      throw Object.assign(new Error(`surface resource ${id} is not a browser tab`), { code: 'resource_replaced' });
    }
    this.resources.delete(id);
    return resource;
  }

  removeByProvider(providerId: string): readonly BrowserTabSurface[] {
    const removed: BrowserTabSurface[] = [];
    for (const [id, resource] of this.resources) {
      if (resource.kind === 'browser_tab' && resource.providerId === providerId) {
        removed.push(resource);
        this.resources.delete(id);
      }
    }
    return Object.freeze(removed);
  }
}
