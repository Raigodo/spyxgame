// Every literal the game feature puts on the wire or in storage. Nothing else in game/ holds one.

import { as, type ChannelId } from "@/kernel";

export const GAME_CHANNEL = as<ChannelId>("game");
export const GAME_EVENTS_CHANNEL = as<ChannelId>("game-events");
export const GAME_PRIVATE_CHANNEL = as<ChannelId>("game-private");

/** Bounds of replicated integers (round, version, revisions) and of an Entropy seed. */
export const MAX_INT32 = 2_147_483_647;
export const MAX_UINT32 = 4_294_967_295;

export const LOBBY_MODES = ["free-for-all", "teams"] as const;

/** Commands on the `game` channel. */
export const COMMAND = {
  start: "start",
  play: "play",
  observe: "observe",
  fire: "fire",
  continue: "continue",
  end: "end",
} as const;

/** Effect types a reducer may return. */
export const EFFECT = {
  startTimer: "startTimer",
  cancelTimer: "cancelTimer",
  emit: "emit",
  end: "end",
} as const;

/** `slot.x[key]` of each slot feature. */
export const SLOT_KEY = {
  presence: "presence",
  timers: "timers",
  notices: "notices",
  private: "private",
} as const;

/** Device-only game state: `game-local:<roomId>:<gameId>:<round>:<playerId>:<id>` (see local-state.ts). */
export const LOCAL_KEY_PREFIX = "game-local:";
export const LOCAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
