// Tap race: first participant to reach `goal` taps wins. Supports both lobby
// modes (the UI computes team totals from context.teams), uses an ephemeral
// emote event, and admits late joiners in free-for-all but not in teams.

import { defineGame } from "@/shared/application/game";
import type { LobbyMode } from "@/shared/application/lobby";
import { isRecord } from "@/shared/kernel";

export interface TapConfig {
  goal: number;
}

export interface TapState {
  /** playerId -> taps */
  scores: Record<string, number>;
  /** playerId of the first to reach the goal */
  winner?: string;
}

type TapCommands = {
  tap: Record<string, never>;
};

type TapEvents = {
  emote: { emoji: string };
};

export const demoTap = defineGame<TapConfig, TapState, TapCommands, TapEvents, LobbyMode>({
  id: "demo-tap",
  modes: ["free-for-all", "teams"],
  minPlayers: 1,
  maxPlayers: 16,

  validateConfig: (raw) =>
    isRecord(raw) &&
    typeof raw.goal === "number" &&
    Number.isInteger(raw.goal) &&
    raw.goal >= 1 &&
    raw.goal <= 1000
      ? { goal: raw.goal }
      : undefined,

  validateState: (raw) => {
    if (!isRecord(raw) || !isRecord(raw.scores)) return undefined;
    const scores: Record<string, number> = {};
    for (const [playerId, n] of Object.entries(raw.scores)) {
      if (typeof n === "number" && Number.isFinite(n)) scores[playerId] = n;
    }
    return { scores, winner: typeof raw.winner === "string" ? raw.winner : undefined };
  },

  initialState: ({ context }) => ({
    scores: Object.fromEntries(context.participants.map((playerId) => [playerId, 0])),
  }),

  commands: {
    tap: {
      validate: () => ({}),
      reduce: ({ state, config, sender }) => {
        if (state.winner) return { ok: false, reason: "game-over" };
        const score = (state.scores[sender.playerId] ?? 0) + 1;
        return {
          ok: true,
          state: {
            scores: { ...state.scores, [sender.playerId]: score },
            winner: score >= config.goal ? sender.playerId : undefined,
          },
        };
      },
    },
  },

  events: {
    emote: {
      validate: (raw) =>
        isRecord(raw) &&
        typeof raw.emoji === "string" &&
        raw.emoji.length > 0 &&
        raw.emoji.length <= 8
          ? { emoji: raw.emoji }
          : undefined,
    },
  },

  // Free-for-all: let latecomers join with 0 taps. Teams: spectate (no team to put them on).
  onLateJoin: ({ state, context, playerId }) =>
    context.mode === "teams"
      ? undefined
      : { state: { ...state, scores: { ...state.scores, [playerId]: 0 } } },
});
