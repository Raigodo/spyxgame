// Pure helpers the spy page needs for display: who the game is waiting for, and plain-language
// text for results and rejections. No React, no I/O.

import { nonSpyIds, type SpyReason, type SpyState } from "./spy-rules";

/** playerIds that still have to act before the game moves on. Empty when nothing is pending. */
export function waitingFor(state: SpyState): string[] {
  if (state.claim) return nonSpyIds(state).filter((id) => !(id in (state.claim?.votes ?? {})));
  switch (state.phase) {
    case "talking": {
      const speaker = state.order[state.turn];
      return speaker === undefined ? [] : [speaker];
    }
    case "deciding":
      return state.order.filter((id) => !(id in state.decisions));
    case "voting":
      return state.order.filter((id) => !(id in state.votes));
    case "lastChance":
      return state.spyId === undefined ? [] : [state.spyId];
    default:
      return [];
  }
}

/** True when the host's "force advance" has something to resolve. */
export function canForceAdvance(state: SpyState): boolean {
  return (
    state.claim !== undefined ||
    state.phase === "deciding" ||
    state.phase === "voting" ||
    state.phase === "lastChance"
  );
}

const RESULT_TEXT: Record<SpyReason, string> = {
  "spy-guessed": "The spy said the word and the players accepted it.",
  "spy-caught-guessed": "The spy was caught, but said the word and the players accepted it.",
  "spy-failed-guess": "The spy's guess was not accepted.",
  "wrong-accusation": "The players accused the wrong person.",
  "spy-caught": "The spy was caught and gave up.",
};

export const resultText = (reason: SpyReason): string => RESULT_TEXT[reason];

const REJECTION_TEXT: Record<string, string> = {
  "game-over": "The game is over.",
  "claim-pending": "The spy has claimed the word. Vote on the claim first.",
  "wrong-phase": "Not possible in this phase.",
  "not-your-turn": "It is not your turn.",
  "not-a-participant": "You are not playing this round.",
  "cannot-vote-self": "You cannot vote for yourself.",
  "unknown-target": "That player is not in this round.",
  "not-the-spy": "Only the spy can do that.",
  "not-eligible": "You cannot vote on this.",
  "no-claim": "There is no claim to vote on.",
  "invalid-word": "Words must be 1 to 40 characters.",
  "word-limit": "You have used all your words.",
  "duplicate-word": "That word is already in the pool.",
  "unknown-word": "That word no longer exists.",
  "not-your-word": "You can only remove your own words.",
  "too-few-players": "At least 3 players are needed.",
  "too-few-words": "Not enough words in the pool yet.",
  "nothing-to-advance": "Nothing to advance right now.",
  "host-only": "Only the host can do that.",
};

export const rejectionText = (reason: string): string =>
  REJECTION_TEXT[reason] ?? `Rejected: ${reason}`;
