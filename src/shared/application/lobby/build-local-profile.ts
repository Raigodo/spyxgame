import type { LocalProfileInput } from "@/shared/infrastructure/player";

// The one place that turns an externally supplied durable playerId + a
// nickname into what PlayerSession.join() expects. Two things live in
// metadata here that the rest of the lobby feature depends on:
//  - playerId: how returning-player and duplicate-session detection
//    recognize "this is the same person" across a fresh peerId.
//  - sessionStartedAt: frozen at join time, used only to decide which of
//    two concurrent duplicate sessions is older. It must never be
//    overwritten by a later updateLocalProfile() call — and since
//    PlayerSession only shallow-merges metadata patches, as long as
//    nothing else ever sets this same key again, it stays frozen
//    naturally without any extra guarding.
export function buildLocalProfileInput(playerId: string, nickname: string): LocalProfileInput {
  return {
    nickname,
    metadata: { playerId, sessionStartedAt: Date.now() },
  };
}
