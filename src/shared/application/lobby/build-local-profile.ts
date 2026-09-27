import type { LocalProfileInput } from "@/shared/infrastructure/player";

// The one place that turns an externally supplied durable playerId + a
// nickname into what PlayerSession.join() expects. metadata.playerId is
// how returning-player detection and duplicate-session arbitration both
// recognize "this is the same person" across a fresh peerId — skip it and
// both silently stop working.
export function buildLocalProfileInput(playerId: string, nickname: string): LocalProfileInput {
  return {
    nickname,
    metadata: { playerId },
  };
}
