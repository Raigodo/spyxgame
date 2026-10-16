import type { Cancel, Clock } from "@/shared/kernel";

export interface AbsenceTimersDeps {
  clock: Clock;
  /** A timer ran out: the host should re-evaluate. */
  onExpired(): void;
}

// One game's debounce: a timer per absent participant. Local to the host, never replicated.
export class AbsenceTimers {
  private readonly timers = new Map<string, Cancel>();
  private readonly expired = new Set<string>();

  constructor(private readonly deps: AbsenceTimersDeps) {}

  /** Starts a timer for each newly absent player, and forgets everyone no longer absent. */
  sync(absent: ReadonlySet<string>, afterMs: number): void {
    for (const [id, cancel] of Array.from(this.timers)) {
      if (!absent.has(id)) {
        cancel();
        this.timers.delete(id);
      }
    }
    for (const id of Array.from(this.expired)) {
      if (!absent.has(id)) this.expired.delete(id);
    }
    for (const id of absent) {
      if (this.timers.has(id) || this.expired.has(id)) continue;
      this.timers.set(
        id,
        this.deps.clock.after(afterMs, () => {
          this.timers.delete(id);
          this.expired.add(id);
          this.deps.onExpired();
        })
      );
    }
  }

  getExpired(): ReadonlySet<string> {
    return this.expired;
  }

  clear(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.expired.clear();
  }
}
