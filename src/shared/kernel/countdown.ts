import type { Cancel, Clock } from "./clock";

/** A restartable one-shot timer. start() replaces any running countdown. */
export class Countdown {
  private cancel?: Cancel;

  constructor(
    private readonly clock: Clock,
    private readonly onExpired: () => void
  ) {}

  start(durationMs: number): void {
    this.stop();
    this.cancel = this.clock.after(durationMs, () => {
      this.cancel = undefined;
      this.onExpired();
    });
  }

  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
  }
}
