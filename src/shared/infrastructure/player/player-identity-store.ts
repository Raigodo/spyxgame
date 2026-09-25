import type { StoredIdentity } from "./types";

const STORAGE_KEY = "player-identity";

export function loadOrCreateIdentity(defaultNickname: string): StoredIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StoredIdentity;
  } catch {
    // ignore — fall through to creating a fresh identity
  }

  const identity: StoredIdentity = {
    peerId: crypto.randomUUID(),
    nickname: defaultNickname,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

export function saveNickname(nickname: string): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const identity: StoredIdentity = raw ? JSON.parse(raw) : { peerId: crypto.randomUUID() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...identity, nickname }));
  } catch {
    // best-effort — nickname just won't persist across reloads
  }
}
