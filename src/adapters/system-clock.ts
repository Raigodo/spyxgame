import type { Cancel, Clock } from "@/kernel";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  after(ms: number, fn: () => void): Cancel {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  }
  every(ms: number, fn: () => void): Cancel {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  }
}
