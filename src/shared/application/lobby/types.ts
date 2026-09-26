import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RtcPeerStatus } from "@/shared/infrastructure/webrtc";
import type { FreeForAllLobbyService } from "./free-for-all-lobby-service";
import type { TeamLobbyService } from "./team-lobby-service";

// "self" for the local player — there's no RTC connection to introspect
// for your own row, you're just always there.
export type LobbyConnectionStatus = RtcPeerStatus | "self";

export interface LobbyPlayer {
  peerId: SignalingPeerId;
  playerId: string;
  nickname: string;
  ready: boolean;
  teamId?: string;
  connectionStatus: LobbyConnectionStatus;
  // True once this playerId has been seen leaving and rejoining this lobby's
  // lifetime. Only ever set authoritatively by whichever peer is host.
  returning: boolean;
}

export type LobbyMode = "free-for-all" | "teams";

export type Lobby = FreeForAllLobbyService | TeamLobbyService;

export type LobbyConfig = { mode: "free-for-all" } | { mode: "teams"; teamIds: string[] };
