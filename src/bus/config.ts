// Bus tuning. Plain values for now; wrapping them in the kernel's defineConfig descriptors is a
// one-line change per key once its final signature is fixed (plan open point 9).
// Relations that cross slices (commandTtlMs > failover budget) live in compose/relations.ts.

export interface BusConfig {
  /** Sender-side TTL of an unacked command. Must exceed the failover budget. */
  commandTtlMs: number;
  /** A recovering host finishes this long after the last offer (sliding window). */
  recoveryWindowMs: number;
  /** A recovering host finishes after this long whatever happens. Not below recoveryWindowMs. */
  recoveryMaxMs: number;
  /** After promotion, peers still linking are waited for this long; later only active links. Below recoveryMaxMs. */
  recoveryLinkGraceMs: number;
  /** A guest re-requests snapshots this often while unsynced. */
  resyncIntervalMs: number;
  /**
   * Largest serialized state (JSON characters) a commit may produce. A larger result is rejected
   * "too-large" so no state can become unsendable. Keep below transport's wire cap.
   */
  maxStateChars: number;
}

export const DEFAULT_BUS_CONFIG: BusConfig = {
  commandTtlMs: 30_000,
  recoveryWindowMs: 3_000,
  recoveryMaxMs: 10_000,
  recoveryLinkGraceMs: 2_000,
  resyncIntervalMs: 3_000,
  maxStateChars: 1_000_000,
};
