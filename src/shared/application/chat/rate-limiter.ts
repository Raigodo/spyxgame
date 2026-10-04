// Token bucket, one bucket per key. Allows a burst, then a steady refill rate.
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Consumes one token if available. */
  tryTake(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((t - bucket.at) / 1000) * this.refillPerSecond
    );
    bucket.at = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return allowed;
  }
}
