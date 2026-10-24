import { as, type ChannelId } from "@/kernel";

export const CHANNELS = {
  roster: as<ChannelId>("roster"),
  events: as<ChannelId>("roster-events"),
} as const;

/** Prefix for the remembered nickname, applied with `prefixed(storages.profile, ...)`. */
export const PROFILE_KEY_PREFIX = "player-profile:";

/** Event kinds on the `roster-events` channel. */
export const EVENT = { ping: "ping", pong: "pong" } as const;

export const MAX_NONCE_CHARS = 64;
