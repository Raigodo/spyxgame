import type { Clock } from "@/shared/kernel";

export interface RateLimiterDeps {
  clock: Clock;
  capacity: number;
  refillPerSecond: number;
}

// Token bucket, one bucket per key. Allows a burst, then a steady refill rate.
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly deps: RateLimiterDeps) {}

  /** Consumes one token if available. */
  tryTake(key: string): boolean {
    const { clock, capacity, refillPerSecond } = this.deps;
    const t = clock.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, at: t };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((t - bucket.at) / 1000) * refillPerSecond);
    bucket.at = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return allowed;
  }
}
