import type { KeyValueStore, ProfileConfig } from "@/shared/kernel";

// Remembers per-playerId local preferences (nickname today, room for more) so a returning
// visitor doesn't have to retype their name when they open the same playerId link.
//
// Backed by a cookie-like store with a fixed expiry on purpose: an abandoned playerId cleans
// itself up with no code to run. No sliding renewal on read or write: a deliberate simplification.

export interface LocalPlayerProfile {
  nickname: string;
  [key: string]: unknown;
}

const KEY_PREFIX = "player-profile:";

export interface PlayerProfileStoreDeps {
  store: KeyValueStore;
  config: ProfileConfig;
}

export class PlayerProfileStore {
  constructor(private readonly deps: PlayerProfileStoreDeps) {}

  load(playerId: string): LocalPlayerProfile | undefined {
    const raw = this.deps.store.get(KEY_PREFIX + playerId);
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isProfile(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  save(playerId: string, profile: LocalPlayerProfile): void {
    this.deps.store.set(KEY_PREFIX + playerId, JSON.stringify(profile), {
      ttlSeconds: this.deps.config.cookieMaxAgeSeconds,
    });
  }

  /** Updates the nickname and keeps whatever else was stored. */
  saveNickname(playerId: string, nickname: string): void {
    this.save(playerId, { ...this.load(playerId), nickname });
  }
}

function isProfile(value: unknown): value is LocalPlayerProfile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).nickname === "string"
  );
}
