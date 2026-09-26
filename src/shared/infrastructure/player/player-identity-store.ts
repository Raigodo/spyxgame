import type { StoredIdentity } from "./types";

const STORAGE_KEY = "player-identity";

export function loadOrCreateIdentity(defaultNickname: string): StoredIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
      if (parsed.peerId && parsed.playerId && parsed.nickname) {
        return parsed as StoredIdentity;
      }
      // Backfill: identity predates playerId, or is otherwise incomplete.
      const identity: StoredIdentity = {
        peerId: parsed.peerId ?? crypto.randomUUID(),
        playerId: parsed.playerId ?? crypto.randomUUID(),
        nickname: parsed.nickname ?? defaultNickname,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
      return identity;
    }
  } catch {
    // ignore — fall through to creating a fresh identity
  }

  const identity: StoredIdentity = {
    peerId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    nickname: defaultNickname,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export function saveNickname(nickname: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const existing: Partial<StoredIdentity> = raw ? JSON.parse(raw) : {};
    const identity: StoredIdentity = {
      peerId: existing.peerId ?? crypto.randomUUID(),
      playerId: existing.playerId ?? crypto.randomUUID(),
      nickname,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // best-effort — nickname just won't persist across reloads
  }
}
