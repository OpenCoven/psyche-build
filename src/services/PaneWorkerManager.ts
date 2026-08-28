import { randomUUID } from 'crypto';
import type { PsychePane } from '../types.js';
import type { WorkerMessageBus } from './WorkerMessageBus.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../workers/WorkerMessages.js';
import { LogService } from './LogService.js';
import { TmuxService } from './TmuxService.js';
import { PaneStatusPoller, type PaneStatusPollerOptions } from './PaneStatusPoller.js';

interface PaneInfo {
  paneId: string;
  tmuxPaneId: string;
  paneType?: PsychePane['type'];
  agent?: PsychePane['agent'];
  startTime: number;
}

export function shouldMonitorPaneForStatusTracking(
  pane: Pick<PsychePane, 'type' | 'agent'>
): boolean {
  return pane.type !== 'shell' && Boolean(pane.agent);
}

/**
 * Owns status monitoring for every agent pane.
 *
 * This used to spawn one worker thread per pane, each polling tmux with a
 * synchronous capture. The threads bought nothing but a place to block: the
 * per-pane logic is a small state machine (PaneStatusTracker) and the capture
 * is now async, so a single poller serves every pane and the isolates are
 * gone. The class keeps its original surface so the status pipeline above it
 * is unchanged.
 */
export class PaneWorkerManager {
  private panes = new Map<string, PaneInfo>();
  private messageBus: WorkerMessageBus;
  private isShuttingDown = false;
  private poller: PaneStatusPoller;
  private tmux = TmuxService.getInstance();

  constructor(messageBus: WorkerMessageBus, pollerOptions: PaneStatusPollerOptions = {}) {
    this.messageBus = messageBus;
    this.poller = new PaneStatusPoller({
      onEvent: (paneId, event) => {
        this.dispatch(paneId, event.type as OutboundMessage['type'], event.payload);
      },
      onPaneRemoved: (paneId, reason) => {
        this.panes.delete(paneId);
        if (this.panes.size === 0) this.poller.stop();
        this.dispatch(paneId, 'pane-removed', { reason });
      },
      onError: (paneId, error) => {
        this.dispatch(paneId, 'error', { error, recoverable: true });
      },
    }, pollerOptions);
  }

  /**
   * Begin monitoring a pane.
   */
  createWorker(pane: PsychePane): void {
    if (this.panes.has(pane.id) || this.isShuttingDown || !shouldMonitorPaneForStatusTracking(pane)) {
      return;
    }

    this.panes.set(pane.id, {
      paneId: pane.id,
      tmuxPaneId: pane.paneId,
      paneType: pane.type,
      agent: pane.agent,
      startTime: Date.now(),
    });
    this.poller.add({
      paneId: pane.id,
      tmuxPaneId: pane.paneId,
      agent: pane.agent,
      worktreePath: pane.worktreePath,
    });
    this.poller.start();
    this.dispatch(pane.id, 'ready', {});
  }

  /**
   * Send a request for a pane and resolve with its response.
   */
  async sendToWorker(
    paneId: string,
    message: Omit<InboundMessage, 'id'>
  ): Promise<OutboundMessage> {
    if (!this.panes.has(paneId)) {
      throw new Error(`No worker found for pane ${paneId}`);
    }

    const payload = await this.handleRequest(paneId, message);
    return {
      id: randomUUID(),
      type: `${message.type}-response` as OutboundMessage['type'],
      timestamp: Date.now(),
      paneId,
      payload,
    };
  }

  async sendKeysToExpectedPane(
    paneId: string,
    expectedTmuxPaneId: string,
    keys: string,
    signal?: AbortSignal,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    const ownsExpectedPane = () => (
      !signal?.aborted
      && this.panes.get(paneId)?.tmuxPaneId === expectedTmuxPaneId
      && (isCurrent?.() ?? true)
    );
    if (!ownsExpectedPane()) {
      return false;
    }

    const escapedKeys = keys.replace(/'/g, "'\\''");
    const sent = await this.tmux.sendKeys(expectedTmuxPaneId, `'${escapedKeys}'`, {
      signal,
      isCurrent: ownsExpectedPane,
    });
    if (!sent) {
      return false;
    }
    if (ownsExpectedPane()) {
      this.poller.onKeysSent(paneId);
    }
    return true;
  }

  /**
   * Deliver a message for a pane without waiting for a response.
   */
  notifyWorker(
    paneId: string,
    message: Omit<InboundMessage, 'id'>
  ): void {
    if (!this.panes.has(paneId)) {
      const msg = `No worker found for pane ${paneId}`;
      console.error(msg);
      LogService.getInstance().warn(msg, 'PaneWorkerManager', paneId);
      return;
    }

    void this.handleRequest(paneId, message).catch((error) => {
      const msg = `Failed to notify worker ${paneId}`;
      LogService.getInstance().error(
        msg, 'PaneWorkerManager', paneId, error instanceof Error ? error : undefined,
      );
    });
  }

  /**
   * Deliver a message for every monitored pane.
   */
  broadcastToWorkers(message: Omit<InboundMessage, 'id'>): void {
    for (const paneId of [...this.panes.keys()]) {
      this.notifyWorker(paneId, message);
    }
  }

  /**
   * Stop monitoring a pane.
   */
  async destroyWorker(paneId: string): Promise<void> {
    if (!this.panes.delete(paneId)) return;
    this.poller.remove(paneId);
    if (this.panes.size === 0) this.poller.stop();
  }

  /**
   * Update monitored panes to match the current set.
   */
  async updateWorkers(panes: PsychePane[]): Promise<void> {
    const monitoredPanes = panes.filter(shouldMonitorPaneForStatusTracking);
    const currentPaneIds = new Set(monitoredPanes.map(p => p.id));

    for (const pane of monitoredPanes) {
      const existing = this.panes.get(pane.id);
      if (!existing) {
        this.createWorker(pane);
      } else if (existing.tmuxPaneId !== pane.paneId) {
        // The tmux pane behind this psyche pane changed, so its accumulated
        // comparison history describes a pane that is no longer there.
        this.dispatch(pane.id, 'pane-reset', { reason: 'Pane was replaced' });
        await this.destroyWorker(pane.id);
        this.createWorker(pane);
      }
    }

    const removed = [...this.panes.keys()].filter((paneId) => !currentPaneIds.has(paneId));
    await Promise.all(removed.map(id => this.releaseWorker(id, 'Pane no longer monitored')));
  }

  private async releaseWorker(paneId: string, reason: string): Promise<void> {
    if (!this.panes.has(paneId)) return;
    this.dispatch(paneId, 'pane-removed', { reason });
    await this.destroyWorker(paneId);
  }

  private async handleRequest(
    paneId: string,
    message: Omit<InboundMessage, 'id'>
  ): Promise<Record<string, unknown>> {
    switch (message.type) {
      case 'send-keys':
        await this.sendKeys(paneId, message.payload?.keys);
        return { success: true };

      case 'resize':
        await this.resizePane(paneId, message.payload?.width, message.payload?.height);
        return { success: true };

      case 'analyze-complete':
        this.poller.onAnalysisComplete(paneId, message.payload ?? {});
        return { success: true };

      case 'get-status':
        return { status: this.poller.statusFor(paneId) };

      case 'shutdown':
        await this.destroyWorker(paneId);
        return { success: true };

      default:
        return { error: `Unknown message type: ${message.type}` };
    }
  }

  private async sendKeys(paneId: string, keys?: string): Promise<void> {
    if (!keys) return;
    const tmuxPaneId = this.panes.get(paneId)?.tmuxPaneId;
    if (!tmuxPaneId) return;

    // Escape single quotes in keys
    const escapedKeys = keys.replace(/'/g, "'\\''");
    await this.tmux.sendKeys(tmuxPaneId, `'${escapedKeys}'`);
    this.poller.onKeysSent(paneId);
  }

  private async resizePane(paneId: string, width?: number, height?: number): Promise<void> {
    if (!width && !height) return;
    const tmuxPaneId = this.panes.get(paneId)?.tmuxPaneId;
    if (!tmuxPaneId) return;

    await this.tmux.resizePane(tmuxPaneId, { width, height });

    // Refresh to ensure pane is painted correctly after resize
    await this.tmux.refreshClient();
  }

  private dispatch(paneId: string, type: OutboundMessage['type'], payload?: unknown): void {
    if (this.isShuttingDown) return;
    this.messageBus.handleWorkerMessage(paneId, {
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      paneId,
      payload,
    });
  }

  /**
   * Get monitoring statistics.
   */
  getStats(): {
    workerCount: number;
    workers: Array<{
      paneId: string;
      uptime: number;
      restartCount: number;
    }>;
  } {
    const workers = Array.from(this.panes.values()).map((info) => ({
      paneId: info.paneId,
      uptime: Date.now() - info.startTime,
      // Retained for the stats contract: a single poller has nothing to restart.
      restartCount: 0,
    }));

    return {
      workerCount: this.panes.size,
      workers
    };
  }

  /**
   * Stop monitoring every pane.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.poller.stop();
    this.panes.clear();
  }
}
