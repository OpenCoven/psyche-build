import { TmuxControl } from "../tmuxControl.js";
import { PaneOutputBuffer } from "./PaneOutputBuffer.js";

/**
 * One TmuxControl subprocess per psyche session. As `%output` events arrive
 * from tmux for any pane, we fan them into per-pane PaneOutputBuffer
 * instances. Subscribers attach via bufferFor(paneId).subscribe(...) for
 * live tail; bufferFor(paneId).snapshot(sinceSeq?) gives the replay window.
 *
 * `sendInput` forwards raw bytes to a tmux pane via control-mode
 * `send-keys -H` (hex-encoded), which is lossless for control bytes.
 */
export class PaneStreamHub {
  private tmux: TmuxControl;
  private buffers = new Map<string, PaneOutputBuffer>();
  private started = false;

  constructor(public readonly sessionName: string, tmux?: TmuxControl) {
    this.tmux = tmux ?? new TmuxControl(sessionName);
    this.tmux.on("output", (paneId: string, payload: Buffer) => {
      this.bufferFor(paneId).write(payload);
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.tmux.start();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.tmux.stop();
  }

  bufferFor(paneId: string): PaneOutputBuffer {
    let buf = this.buffers.get(paneId);
    if (!buf) {
      buf = new PaneOutputBuffer();
      this.buffers.set(paneId, buf);
    }
    return buf;
  }

  /** Send raw bytes to a tmux pane via control-mode `send-keys -H`. */
  sendInput(paneId: string, data: Buffer): void | Promise<void> {
    return this.tmux.sendKeysHex(paneId, data);
  }

  /** Resize a tmux pane to the client's viewport. */
  resizePane(paneId: string, cols: number, rows: number): void {
    this.tmux.resizePane(paneId, cols, rows);
  }

  forgetPane(paneId: string): void {
    this.buffers.delete(paneId);
  }
}
