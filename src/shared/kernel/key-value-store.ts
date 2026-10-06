/**
 * Best-effort string storage. Implementations never throw: a failed read returns undefined and
 * a failed write is silently dropped (callers treat persistence as a convenience).
 */
export interface KeyValueStore {
  get(key: string): string | undefined;
  /** Without `ttlSeconds` the value lives as long as the underlying store keeps it. */
  set(key: string, value: string, options?: { ttlSeconds?: number }): void;
  remove(key: string): void;
}
