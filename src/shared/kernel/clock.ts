export type Cancel = () => void;

export interface Clock {
  now(): number;
  /** Runs `fn` once after `ms`. The returned function cancels it; calling it again is harmless. */
  after(ms: number, fn: () => void): Cancel;
  /** Runs `fn` every `ms` until cancelled. */
  every(ms: number, fn: () => void): Cancel;
}

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
