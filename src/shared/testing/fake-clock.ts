import type { Cancel, Clock } from "@/shared/kernel";

interface Timer {
  at: number;
  fn: () => void;
  every?: number;
}

export class FakeClock implements Clock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  now(): number {
    return this.time;
  }
  after(ms: number, fn: () => void): Cancel {
    return this.schedule({ at: this.time + ms, fn });
  }
  every(ms: number, fn: () => void): Cancel {
    return this.schedule({ at: this.time + ms, fn, every: ms });
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let next: Timer | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      }
      if (nextId === undefined || !next) break;
      this.time = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(nextId);
      next.fn();
    }
    this.time = end;
  }

  private schedule(timer: Timer): Cancel {
    const id = ++this.seq;
    this.timers.set(id, timer);
    return () => {
      this.timers.delete(id);
    };
  }
}
