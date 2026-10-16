import type { Clock, KeyValueStore } from "@/shared/kernel";

interface Stored {
  v: string;
  /** Epoch ms. Absent: no expiry. */
  exp?: number;
}

// localStorage has no expiry of its own, so each value carries one. An expired value is removed
// when it is next read. Best effort: never throws.
export class LocalStorageAdapter implements KeyValueStore {
  constructor(private readonly clock: Clock) {}

  get(key: string): string | undefined {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return undefined;
      const stored = JSON.parse(raw) as Partial<Stored>;
      if (typeof stored.v !== "string") return undefined;
      if (typeof stored.exp === "number" && stored.exp <= this.clock.now()) {
        localStorage.removeItem(key);
        return undefined;
      }
      return stored.v;
    } catch {
      return undefined; // SSR, blocked storage, or a foreign value
    }
  }

  set(key: string, value: string, options: { ttlSeconds?: number } = {}): void {
    try {
      const stored: Stored = {
        v: value,
        ...(options.ttlSeconds !== undefined && {
          exp: this.clock.now() + options.ttlSeconds * 1000,
        }),
      };
      localStorage.setItem(key, JSON.stringify(stored));
    } catch {
      // best-effort
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // best-effort
    }
  }
}
