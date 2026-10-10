import type { Cancel, Clock } from "@/shared/kernel";

/** One tab's view of a shared FakeClock. kill() cancels everything the tab scheduled. */
export class ScopedClock implements Clock {
  private dead = false;
  private readonly cancels = new Set<Cancel>();

  constructor(private readonly base: Clock) {}

  now(): number {
    return this.base.now();
  }

  after(ms: number, fn: () => void): Cancel {
    if (this.dead) return () => {};
    const cancel = this.base.after(ms, fn);
    this.cancels.add(cancel);
    return cancel;
  }

  every(ms: number, fn: () => void): Cancel {
    if (this.dead) return () => {};
    const cancel = this.base.every(ms, fn);
    this.cancels.add(cancel);
    return cancel;
  }

  kill(): void {
    this.dead = true;
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }
}
