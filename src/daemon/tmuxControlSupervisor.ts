import type { EventEmitter } from 'node:events';

interface SupervisableTmuxControl extends EventEmitter {
  start(): void;
  stop(): void;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface TmuxControlSupervisorOptions {
  control: SupervisableTmuxControl;
  sessionExists: () => boolean;
  onConnect: () => Promise<(() => void) | void> | (() => void) | void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

/** Owns one restartable control object and supervises its subprocess lifecycle. */
export class TmuxControlSupervisor {
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private timer: TimerHandle | undefined;
  private backoffMs: number;
  private running = false;
  private connecting = false;
  private cleanupConnection: (() => void) | undefined;
  private generation = 0;
  private isConnected = false;

  constructor(private readonly options: TmuxControlSupervisorOptions) {
    this.initialBackoffMs = options.initialBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
    this.backoffMs = this.initialBackoffMs;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get connected(): boolean {
    return this.isConnected;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.control.on('exit', this.onControlExit);
    this.options.control.on('tmuxExit', this.onControlExit);
    this.schedule(0);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.options.control.off('exit', this.onControlExit);
    this.options.control.off('tmuxExit', this.onControlExit);
    this.cleanupConnection?.();
    this.cleanupConnection = undefined;
    const wasConnected = this.isConnected || this.connecting;
    this.isConnected = false;
    this.connecting = false;
    if (wasConnected) this.options.control.stop();
  }

  private readonly onControlExit = (): void => {
    if (!this.running || (!this.isConnected && !this.connecting)) return;
    this.generation += 1;
    this.cleanupConnection?.();
    this.cleanupConnection = undefined;
    this.isConnected = false;
    this.connecting = false;
    this.options.control.stop();
    this.backoffMs = this.initialBackoffMs;
    this.schedule(this.backoffMs);
  };

  private schedule(delayMs: number): void {
    if (!this.running || this.timer !== undefined) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.attempt();
    }, delayMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  private async attempt(): Promise<void> {
    if (!this.running || this.connecting || this.isConnected) return;
    if (!this.options.sessionExists()) {
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
      this.schedule(delay);
      return;
    }
    this.connecting = true;
    const generation = ++this.generation;
    try {
      this.options.control.start();
      if (!this.running || generation !== this.generation) return;
      const cleanup = await this.options.onConnect();
      if (!this.running || generation !== this.generation) {
        cleanup?.();
        return;
      }
      this.cleanupConnection = cleanup ?? undefined;
      this.isConnected = true;
      this.connecting = false;
      this.backoffMs = this.initialBackoffMs;
    } catch {
      if (generation !== this.generation) return;
      this.connecting = false;
      this.isConnected = false;
      this.options.control.stop();
      this.schedule(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    }
  }
}
