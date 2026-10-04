//presence/types.ts

import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";

// "self" for the local player — there's no RTC connection to introspect for
// your own row, you're just always there.
export type PresenceStatus = RtcPeerStatus | "self";

export interface PlayerPresence {
  status: PresenceStatus;
  returning: boolean;
}

// A player as seen through the shared presence/reconnection layer: live
// connection status and "has this playerId been here before" bookkeeping,
// layered on top of the raw PlayerProfile. Deliberately generic —
// domain-specific fields (ready, team, score, whatever a given app phase
// cares about) live in `metadata` and are interpreted by whoever consumes
// this. Lobby and game read the same RosterPlayer and project it into their
// own shapes; this module never needs to know either one exists.
export interface RosterPlayer {
  peerId: SignalingPeerId;
  playerId: string;
  nickname: string;
  metadata: Record<string, unknown>;
  connectionStatus: PresenceStatus;
  returning: boolean;
}
