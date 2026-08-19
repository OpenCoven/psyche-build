export type FrameSchedulerCallback = () => void;
export type FrameSchedulerErrorSink = (error: unknown, key: string) => void;
export type FrameRequestCallback = (timestamp: number) => void;
export type FrameRequest = (callback: FrameRequestCallback) => number;

export interface FrameSchedulerSnapshot {
  coalescedVisualUpdates: number;
}

let activeFrameCallbacks = 0;

export function snapshotFrameSchedulerResources(): { frameCallbacks: number } {
  return { frameCallbacks: activeFrameCallbacks };
}

export class FrameScheduler {
  private pending = new Map<string, FrameSchedulerCallback>();
  private activeBatch: Map<string, FrameSchedulerCallback> | null = null;
  private frameRequested = false;
  private flushing = false;
  private coalescedVisualUpdates = 0;

  constructor(
    private readonly requestFrame: FrameRequest,
    private readonly reportError: FrameSchedulerErrorSink = (error, key) => {
      console.error(`Scheduled frame callback failed for ${key}`, error);
    },
  ) {}

  schedule(key: string, callback: FrameSchedulerCallback): void {
    if (this.pending.has(key)) {
      this.coalescedVisualUpdates += 1;
    } else {
      activeFrameCallbacks += 1;
    }
    this.pending.set(key, callback);
    this.requestPendingFrame();
  }

  cancelPrefix(prefix: string): void {
    for (const batch of [this.pending, this.activeBatch]) {
      if (!batch) continue;
      for (const key of batch.keys()) {
        if (key.startsWith(prefix)) {
          batch.delete(key);
          activeFrameCallbacks -= 1;
        }
      }
    }
  }

  snapshot(): FrameSchedulerSnapshot {
    return {
      coalescedVisualUpdates: this.coalescedVisualUpdates,
    };
  }

  private requestPendingFrame(): void {
    if (this.frameRequested || this.flushing || this.pending.size === 0) {
      return;
    }

    this.frameRequested = true;
    try {
      this.requestFrame(() => this.flush());
    } catch (error) {
      this.frameRequested = false;
      throw error;
    }
  }

  private flush(): void {
    this.frameRequested = false;
    this.flushing = true;
    const pending = this.pending;
    this.pending = new Map();
    this.activeBatch = pending;

    try {
      for (const [key, callback] of pending) {
        pending.delete(key);
        activeFrameCallbacks -= 1;
        try {
          callback();
        } catch (error) {
          try {
            this.reportError(error, key);
          } catch {
            // A failing error reporter must not block other scheduled work.
          }
        }
      }
    } finally {
      this.activeBatch = null;
      this.flushing = false;
      this.requestPendingFrame();
    }
  }
}
