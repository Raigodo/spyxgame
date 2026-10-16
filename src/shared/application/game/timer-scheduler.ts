import type { Cancel, Clock } from "@/shared/kernel";
import type { SlotTimers } from "./game-timers";

export interface TimerSchedulerDeps {
  clock: Clock;
  /** A running timer reached its deadline. */
  onDue(timerId: string): void;
}

// One game's local Clock timers, mirroring the slot's running timers. Never replicated: the slot
// is the truth, this only wakes the host up. Safe to call sync() any number of times.
export class TimerScheduler {
  private readonly armed = new Map<string, { deadlineAt: number; cancel: Cancel }>();

  constructor(private readonly deps: TimerSchedulerDeps) {}

  sync(timers: Readonly<SlotTimers>): void {
    for (const [id, entry] of Array.from(this.armed)) {
      const timer = timers[id];
      if (!timer || timer.frozenMs !== undefined || timer.deadlineAt !== entry.deadlineAt) {
        entry.cancel();
        this.armed.delete(id);
      }
    }
    const now = this.deps.clock.now();
    const missing = Object.entries(timers)
      .filter(([id, timer]) => timer.frozenMs === undefined && !this.armed.has(id))
      .sort(([, a], [, b]) => a.deadlineAt - b.deadlineAt); // overdue ones fire in deadline order
    for (const [id, timer] of missing) {
      const cancel = this.deps.clock.after(Math.max(0, timer.deadlineAt - now), () => {
        this.armed.delete(id);
        this.deps.onDue(id);
      });
      this.armed.set(id, { deadlineAt: timer.deadlineAt, cancel });
    }
  }

  clear(): void {
    for (const entry of this.armed.values()) entry.cancel();
    this.armed.clear();
  }
}
