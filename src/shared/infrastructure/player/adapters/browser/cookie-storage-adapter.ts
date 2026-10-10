import type { KeyValueStore } from "@/shared/kernel";

// Names and values are URI-encoded, so a key containing `;`, `=` or spaces cannot break the
// cookie. Without ttlSeconds it is a session cookie.
export class CookieStorageAdapter implements KeyValueStore {
  get(key: string): string | undefined {
    if (typeof document === "undefined") return undefined; // SSR guard
    const prefix = `${encodeURIComponent(key)}=`;
    const raw = document.cookie
      .split("; ")
      .find((row) => row.startsWith(prefix))
      ?.slice(prefix.length);
    if (raw === undefined) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }

  set(key: string, value: string, options: { ttlSeconds?: number } = {}): void {
    if (typeof document === "undefined") return;
    try {
      const maxAge = options.ttlSeconds === undefined ? "" : `; max-age=${options.ttlSeconds}`;
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; path=/${maxAge}; samesite=lax`;
    } catch {
      // best-effort
    }
  }

  remove(key: string): void {
    if (typeof document === "undefined") return;
    try {
      document.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0; samesite=lax`;
    } catch {
      // best-effort
    }
  }
}
