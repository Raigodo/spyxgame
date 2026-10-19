/**
 * Best-effort string storage. Implementations never throw: a failed read returns undefined and
 * a failed write is silently dropped (callers treat persistence as a convenience).
 */
export interface KeyValueStore {
  get(key: string): string | undefined;
  /** Without `ttlMs` the value lives as long as the underlying store keeps it. */
  set(key: string, value: string, options?: { ttlMs?: number }): void;
  remove(key: string): void;
}

/** A view of `store` where every key gets `prefix`. Each slice's `names.ts` supplies its prefix. */
export function prefixed(store: KeyValueStore, prefix: string): KeyValueStore {
  return {
    get: (key) => store.get(prefix + key),
    set: (key, value, options) => store.set(prefix + key, value, options),
    remove: (key) => store.remove(prefix + key),
  };
}
