import { readFile } from 'fs/promises';
import { capturePaneContentAsync } from '../utils/paneCapture.js';
import {
  PaneStatusTracker,
  type PaneStatusEvent,
  type PaneStatusTrackerConfig,
  type AnalysisCompleteInput,
} from './PaneStatusTracker.js';

export interface PaneStatusPollerOptions {
  pollIntervalMs?: number;
  captureLines?: number;
  /** Swappable so a control-mode transport can replace per-tick tmux forks. */
  capture?: (tmuxPaneId: string, lines: number) => Promise<string>;
  readCodexEvent?: (file: string) => Promise<unknown>;
  now?: () => number;
}

export interface PaneStatusPollerListeners {
  onEvent: (paneId: string, event: PaneStatusEvent) => void;
  onPaneRemoved: (paneId: string, reason: string) => void;
  onError: (paneId: string, error: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_CAPTURE_LINES = 50;

function isMissingPaneError(message: string): boolean {
  return message.includes("can't find pane") || message.includes('no pane');
}

async function defaultReadCodexEvent(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

interface TrackedPane {
  tracker: PaneStatusTracker;
  pausedUntil: number;
}

/**
 * Drives every monitored pane's PaneStatusTracker from a single timer.
 *
 * This replaces a fleet of one worker thread per pane. The threads existed to
 * keep a synchronous capture off the render loop, not because the work needed
 * parallelism — so an async capture removes the reason for them, and with it a
 * V8 isolate per pane. Panes are polled concurrently within a tick and each is
 * isolated by its own catch, so one failing pane cannot stall the rest.
 */
export class PaneStatusPoller {
  private readonly panes = new Map<string, TrackedPane>();
  private readonly pollIntervalMs: number;
  private readonly captureLines: number;
  private readonly capture: (tmuxPaneId: string, lines: number) => Promise<string>;
  private readonly readCodexEvent: (file: string) => Promise<unknown>;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly listeners: PaneStatusPollerListeners,
    options: PaneStatusPollerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.captureLines = options.captureLines ?? DEFAULT_CAPTURE_LINES;
    this.capture = options.capture
      ?? ((tmuxPaneId, lines) => capturePaneContentAsync(tmuxPaneId, lines, 5, { silent: false }));
    this.readCodexEvent = options.readCodexEvent ?? defaultReadCodexEvent;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.panes.size;
  }

  has(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  tmuxPaneIdFor(paneId: string): string | undefined {
    return this.panes.get(paneId)?.tracker.tmuxPaneId;
  }

  statusFor(paneId: string): string | undefined {
    return this.panes.get(paneId)?.tracker.status;
  }

  add(config: PaneStatusTrackerConfig): void {
    this.panes.set(config.paneId, {
      tracker: new PaneStatusTracker(config),
      pausedUntil: 0,
    });
  }

  remove(paneId: string): void {
    this.panes.delete(paneId);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Applies the analyzer verdict and honours any cooldown it asked for. */
  onAnalysisComplete(paneId: string, input: AnalysisCompleteInput): void {
    const entry = this.panes.get(paneId);
    if (!entry) return;
    const result = entry.tracker.onAnalysisComplete(input);
    this.emit(paneId, result.events);
    if (result.pauseMs) entry.pausedUntil = this.now() + result.pauseMs;
  }

  onKeysSent(paneId: string): void {
    const entry = this.panes.get(paneId);
    if (!entry) return;
    this.emit(paneId, entry.tracker.onKeysSent(this.now()));
  }

  /**
   * Observes every unpaused pane once. Ticks never overlap: a slow tmux must
   * not queue captures behind each other.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = [...this.panes.entries()].filter(([, entry]) => entry.pausedUntil <= now);
      await Promise.all(due.map(([paneId, entry]) => this.observePane(paneId, entry, now)));
    } finally {
      this.ticking = false;
    }
  }

  private async observePane(paneId: string, entry: TrackedPane, now: number): Promise<void> {
    try {
      const output = await this.capture(entry.tracker.tmuxPaneId, this.captureLines);
      if (this.panes.get(paneId) !== entry) return;
      const codexEvent = entry.tracker.codexEventFile
        ? await this.readCodexEvent(entry.tracker.codexEventFile)
        : undefined;
      // The pane may have been dropped or rebound while its capture was in
      // flight. A replacement can retain the same Psyche pane id while
      // pointing at a different tmux pane, so presence alone is insufficient:
      // only the exact tracker that started this capture may publish its
      // result.
      if (this.panes.get(paneId) !== entry) return;
      this.emit(paneId, entry.tracker.observe(output, now, codexEvent));
    } catch (error) {
      if (this.panes.get(paneId) !== entry) return;
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingPaneError(message)) {
        this.panes.delete(paneId);
        this.listeners.onPaneRemoved(paneId, 'Pane no longer exists');
        return;
      }
      this.listeners.onError(paneId, `Capture error: ${message}`);
    }
  }

  private emit(paneId: string, events: readonly PaneStatusEvent[]): void {
    for (const event of events) this.listeners.onEvent(paneId, event);
  }
}
