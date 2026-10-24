// The spy game: players fill a word pool, one word and one spy are drawn, everyone talks about the
// word in an external voice call, and this game only coordinates who does what, when.
// Rules live in rules.ts, parsing in schemas.ts. This file only wires them together.
// Spec: docs/games/spy.md

import { defineGame, type Outcome } from "@/game";
import { fail, ok } from "@/kernel";
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
  settle,
  settleState,
  type SpyOutcome,
} from "./rules";
import { MAX_PLAYERS, commandSchemas, settingsSchema, stateSchema, type SpyTypes } from "./schemas";

const toOutcome = (outcome: SpyOutcome): Outcome<SpyTypes> =>
  outcome.ok ? ok({ state: outcome.state }) : fail(outcome.reason);

export const spyGame = defineGame<SpyTypes>({
  id: "spy",
  modes: ["free-for-all"],
  players: { min: MIN_SPY_PLAYERS, max: MAX_PLAYERS },

  settings: settingsSchema,
  state: stateSchema,
  init: () => initialSpyState(),

  // Away players are skipped and not waited for. Below 3 present players the game pauses.
  presence: {
    minPresent: MIN_SPY_PLAYERS,
    belowMin: "pause",
    onChange: ({ state, away }) => {
      const next = settleState(state, away);
      return next === state ? undefined : { state: next };
    },
  },

  commands: {
    addWord: {
      schema: commandSchemas.addWord,
      reduce: (a, c) =>
        toOutcome(applyAddWord(a.state, a.sender.playerId, c.text, a.settings.wordsPerPlayer)),
    },
    removeWord: {
      schema: commandSchemas.removeWord,
      reduce: (a, c) => toOutcome(applyRemoveWord(a.state, a.sender.playerId, c.wordId)),
    },
    begin: {
      who: "host",
      schema: commandSchemas.begin,
      // The seed is the slot's, drawn once per round from the Entropy port (no client seed).
      reduce: (a) =>
        toOutcome(
          settle(applyBegin(a.state, a.setup.participants, a.seed, a.settings.minWords), a.away)
        ),
    },
    endTurn: {
      schema: commandSchemas.endTurn,
      reduce: (a) =>
        toOutcome(settle(applyEndTurn(a.state, { playerId: a.sender.playerId }), a.away)),
    },
    skipTurn: {
      who: "host",
      schema: commandSchemas.skipTurn,
      reduce: (a) => toOutcome(settle(applyEndTurn(a.state, "host"), a.away)),
    },
    decide: {
      schema: commandSchemas.decide,
      reduce: (a, c) =>
        toOutcome(settle(applyDecide(a.state, a.sender.playerId, c.choice), a.away)),
    },
    vote: {
      schema: commandSchemas.vote,
      reduce: (a, c) => toOutcome(settle(applyVote(a.state, a.sender.playerId, c.target), a.away)),
    },
    claimWord: {
      schema: commandSchemas.claimWord,
      reduce: (a) => toOutcome(applyClaimWord(a.state, a.sender.playerId)),
    },
    claimVote: {
      schema: commandSchemas.claimVote,
      reduce: (a, c) =>
        toOutcome(settle(applyClaimVote(a.state, a.sender.playerId, c.correct), a.away)),
    },
    giveUp: {
      schema: commandSchemas.giveUp,
      reduce: (a) => toOutcome(applyGiveUp(a.state, a.sender.playerId)),
    },
    forceAdvance: {
      who: "host",
      schema: commandSchemas.forceAdvance,
      reduce: (a) => toOutcome(settle(applyForceAdvance(a.state), a.away)),
    },
  },

  // No `late`: a player who arrives mid-game spectates.
});
