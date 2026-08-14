import type { EventEmitter } from 'node:events';

export type PaneOutputListener = (tmuxPaneId: string, data: Buffer) => void;
export interface PaneOutputSource extends Pick<EventEmitter, 'on' | 'off'> {}

/** Owns the daemon's sole tmux output subscription and fans it out in-process. */
export class PaneOutputFanout {
  private readonly subscribers = new Set<PaneOutputListener>();
  private closed = false;
  private readonly handler: PaneOutputListener;

  constructor(
    private readonly source: PaneOutputSource,
    observe: PaneOutputListener = () => {},
  ) {
    this.handler = (tmuxPaneId, data) => {
      observe(tmuxPaneId, data);
      for (const subscriber of this.subscribers) subscriber(tmuxPaneId, data);
    };
    source.on('output', this.handler);
  }

  subscribe(listener: PaneOutputListener): () => void {
    if (this.closed) throw new Error('pane output fanout is closed');
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    this.source.off('output', this.handler);
  }
}
