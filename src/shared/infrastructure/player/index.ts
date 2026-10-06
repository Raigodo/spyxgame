import { DEFAULT_CONFIG, type KeyValueStore, type ProfileConfig } from "@/shared/kernel";
import { CookieStorageAdapter } from "./adapters/browser/cookie-storage-adapter";
import { SessionStorageAdapter } from "./adapters/browser/session-storage-adapter";
import { HostClaimStore } from "./host-claim-store";
import { PlayerProfileStore } from "./player-profile-store";

export { PlayerSession } from "./player-session";
export type { PlayerProfile, LocalProfileInput } from "./types";
export type { HostClaimStore } from "./host-claim-store";
export type { LocalPlayerProfile, PlayerProfileStore } from "./player-profile-store";
// PlayerDirectory and the Envelope union stay internal.

export interface PlayerStores {
  hostClaims: HostClaimStore;
  profiles: PlayerProfileStore;
}

export interface PlayerStoresOverrides {
  /** Per-tab storage for the host-claim hint. */
  tabStore?: KeyValueStore;
  /** Longer-lived storage for the local profile. */
  profileStore?: KeyValueStore;
  profileConfig?: ProfileConfig;
}

export function createPlayerStores(overrides: PlayerStoresOverrides = {}): PlayerStores {
  return {
    hostClaims: new HostClaimStore({ store: overrides.tabStore ?? new SessionStorageAdapter() }),
    profiles: new PlayerProfileStore({
      store: overrides.profileStore ?? new CookieStorageAdapter(),
      config: overrides.profileConfig ?? DEFAULT_CONFIG.profile,
    }),
  };
}
