/**
 * A timer source a test advances by hand.
 *
 * Deadline tests on a real socket cannot sleep for the deadline, and faking
 * the global timers would also freeze the I/O polling those tests rely on.
 * Production code that takes a `{ setTimeout, clearTimeout }` pair can be
 * handed this instead, so the test decides exactly when a deadline elapses.
 */
export class ManualScheduler {
  private nowMs = 0;
  private nextHandle = 0;
  private readonly tasks = new Map<number, { at: number; run: () => void }>();

  setTimeout = (run: () => void, delayMs: number): unknown => {
    this.nextHandle += 1;
    this.tasks.set(this.nextHandle, { at: this.nowMs + delayMs, run });
    return this.nextHandle;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  /** Timers armed and not yet fired or cleared. */
  get pending(): number {
    return this.tasks.size;
  }

  /** Move time forward, firing every timer that falls due, in due order. */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: { handle: number; at: number; run: () => void } | null = null;
      for (const [handle, task] of this.tasks) {
        if (task.at > target) continue;
        if (!next || task.at < next.at || (task.at === next.at && handle < next.handle)) {
          next = { handle, ...task };
        }
      }
      if (!next) break;
      this.tasks.delete(next.handle);
      this.nowMs = next.at;
      next.run();
    }
    this.nowMs = target;
  }
}
