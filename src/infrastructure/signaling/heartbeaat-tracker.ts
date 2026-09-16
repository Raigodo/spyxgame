/**
 * Generic periodic-tick helper. Knows nothing about Firestore or presence —
 * it just calls `onTick` on an interval until stopped, and remembers when it
 * last actually fired. That last part matters because browsers throttle or
 * fully suspend timers on backgrounded tabs: comparing "now" against the
 * last real tick is how a caller detects "I was paused for a while."
 */
export class HeartbeatTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: number | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: () => void,
  ) {}

  start(): void {
    this.stop();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      this.lastTickAt = Date.now();
      this.onTick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /** Ms since the last tick (or since start(), if none has fired yet). Null if never started. */
  msSinceLastTick(now: number = Date.now()): number | null {
    return this.lastTickAt === null ? null : now - this.lastTickAt;
  }
}
