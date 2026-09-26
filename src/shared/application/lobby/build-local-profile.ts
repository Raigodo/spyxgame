import type { LocalProfileInput, StoredIdentity } from "@/shared/infrastructure/player";

// The Lobby layer recognizes returning players by metadata.playerId. This is
// the one piece of glue between a stored identity and the profile you pass
// to PlayerSession.join() — use it instead of building LocalProfileInput by
// hand, or returning-player detection silently won't work.
export function buildLocalProfileInput(
  identity: StoredIdentity,
  metadata: Record<string, unknown> = {}
): LocalProfileInput {
  return {
    nickname: identity.nickname,
    metadata: { ...metadata, playerId: identity.playerId },
  };
}
