// Demo-tap: the types and schemas of the tap race. Every schema is network input (kernel schema),
// replacing the legacy hand-written validators.

import { s, type PlayerId, type Schema } from "@/kernel";
import type { GameTypes } from "@/game";

/** First participant to reach `goal` taps wins. */
export type TapSettings = { goal: number };

export type TapState = {
  /** playerId -> taps */
  scores: Record<string, number>;
  /** The first to reach the goal. */
  winner?: PlayerId;
};

export type TapCommand = { type: "tap" };
export type TapEvent = { type: "emote"; emoji: string };
export type TapReject = "game-over";

export type TapTypes = GameTypes & {
  settings: TapSettings;
  state: TapState;
  command: TapCommand;
  event: TapEvent;
  reject: TapReject;
};

export const MAX_PLAYERS = 16;
export const GOAL_RANGE = { min: 1, max: 1000 } as const;
export const MAX_EMOJI_CHARS = 8;
export const DEFAULT_SETTINGS: TapSettings = { goal: 20 };

export const settingsSchema: Schema<TapSettings> = s.object({ goal: s.int(GOAL_RANGE) });

export const stateSchema: Schema<TapState> = s.object({
  scores: s.record(s.int({ min: 0, max: GOAL_RANGE.max }), {
    maxKeys: MAX_PLAYERS,
    onInvalid: "reject",
  }),
  winner: s.optional(s.id("player")),
});

export const tapSchema: Schema<TapCommand> = s.object({ type: s.literal("tap") });

export const emoteSchema: Schema<TapEvent> = s.object({
  type: s.literal("emote"),
  emoji: s.string({ min: 1, max: MAX_EMOJI_CHARS }),
});
