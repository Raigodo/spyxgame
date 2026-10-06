import type { KeyValueStore } from "@/shared/kernel";

export class SessionStorageAdapter implements KeyValueStore {
  get(key: string): string | undefined {
    try {
      return sessionStorage.getItem(key) ?? undefined;
    } catch {
      return undefined; // SSR, or storage blocked
    }
  }

  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // best-effort
    }
  }

  remove(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // best-effort
    }
  }
}
