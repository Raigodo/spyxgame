export type Cancel = () => void;

export interface Clock {
  now(): number;
  /** Runs `fn` once after `ms`. The returned function cancels it; calling it again is harmless. */
  after(ms: number, fn: () => void): Cancel;
  /** Runs `fn` every `ms` until cancelled. */
  every(ms: number, fn: () => void): Cancel;
}
