// Demo-tap's pure rules. No framework imports beyond types: testable as plain functions.

import { fail, ok, type PlayerId, type Result } from "@/kernel";
import type { TapReject, TapState } from "./schemas";

export function initialState(participants: readonly PlayerId[]): TapState {
  return { scores: Object.fromEntries(participants.map((id) => [id, 0])) };
}

/** One tap. The first to reach `goal` wins and the race is over. */
export function tap(
  state: TapState,
  playerId: PlayerId,
  goal: number
): Result<TapState, TapReject> {
  if (state.winner) return fail("game-over");
  const score = (state.scores[playerId] ?? 0) + 1;
  return ok({
    scores: { ...state.scores, [playerId]: score },
    ...(score >= goal && { winner: playerId }),
  });
}

/** A late joiner (free-for-all only) starts with 0 taps. */
export function admitLate(state: TapState, playerId: PlayerId): TapState {
  return { ...state, scores: { ...state.scores, [playerId]: 0 } };
}
