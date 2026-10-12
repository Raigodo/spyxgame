// The spy game: players fill a word pool, one word and one spy are drawn, everyone talks about the
// word in an external voice call, and this game only coordinates who does what, when.
// Rules live in spy-rules.ts, parsing in spy-validation.ts. This file only wires them together.
// Spec: docs/games/spy.md

import { defineGame } from "@/shared/application/game";
import {
  applyAddWord,
  applyBegin,
  applyClaimVote,
  applyClaimWord,
  applyDecide,
  applyEndTurn,
  applyForceAdvance,
  applyGiveUp,
  applyRemoveWord,
  applyVote,
  initialSpyState,
  MIN_SPY_PLAYERS,
  type SpyState,
} from "./spy-rules";
import {
  parseAddWord,
  parseBegin,
  parseClaimVote,
  parseDecide,
  parseNoPayload,
  parseRemoveWord,
  parseVote,
  validateSpyConfig,
  validateSpyState,
  type SpyCommands,
  type SpyConfig,
} from "./spy-validation";

export const spyGame = defineGame<
  SpyConfig,
  SpyState,
  SpyCommands,
  Record<string, never>,
  "free-for-all"
>({
  id: "spy",
  modes: ["free-for-all"],
  minPlayers: MIN_SPY_PLAYERS,
  maxPlayers: 12,

  validateConfig: validateSpyConfig,
  validateState: validateSpyState,
  initialState: () => initialSpyState(),

  commands: {
    addWord: {
      validate: parseAddWord,
      reduce: ({ state, payload, config, sender }) =>
        applyAddWord(state, sender.playerId, payload.text, config.wordsPerPlayer),
    },
    removeWord: {
      validate: parseRemoveWord,
      reduce: ({ state, payload, sender }) =>
        applyRemoveWord(state, sender.playerId, payload.wordId),
    },
    begin: {
      allow: "host",
      validate: parseBegin,
      reduce: ({ state, payload, config, context }) =>
        applyBegin(state, context.participants, payload.seed, config.minWords),
    },
    endTurn: {
      validate: parseNoPayload,
      reduce: ({ state, sender }) => applyEndTurn(state, { playerId: sender.playerId }),
    },
    skipTurn: {
      allow: "host",
      validate: parseNoPayload,
      reduce: ({ state }) => applyEndTurn(state, "host"),
    },
    decide: {
      validate: parseDecide,
      reduce: ({ state, payload, sender }) => applyDecide(state, sender.playerId, payload.choice),
    },
    vote: {
      validate: parseVote,
      reduce: ({ state, payload, sender }) => applyVote(state, sender.playerId, payload.target),
    },
    claimWord: {
      validate: parseNoPayload,
      reduce: ({ state, sender }) => applyClaimWord(state, sender.playerId),
    },
    claimVote: {
      validate: parseClaimVote,
      reduce: ({ state, payload, sender }) =>
        applyClaimVote(state, sender.playerId, payload.correct),
    },
    giveUp: {
      validate: parseNoPayload,
      reduce: ({ state, sender }) => applyGiveUp(state, sender.playerId),
    },
    forceAdvance: {
      allow: "host",
      validate: parseNoPayload,
      reduce: ({ state }) => applyForceAdvance(state),
    },
  },

  // No onLateJoin: a player who arrives mid-game spectates.
});
