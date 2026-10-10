import type { SignalingPeerId } from "@/shared/infrastructure/signaling";
import type { RosterPlayer } from "@/shared/application/presence";

export type LobbyMode = "free-for-all" | "teams";

export type LobbyConfig = { mode: "free-for-all" } | { mode: "teams"; teamIds: string[] };

// Everything a RosterPlayer already carries (connection status, returning
// flag, raw metadata), plus the two fields that are actually the lobby's
// own concern: ready state and team assignment, projected out of metadata
// for convenience. `metadata` stays on the object too, so nothing is lost —
// this is purely additive.
export interface LobbyPlayer extends RosterPlayer {
  ready: boolean;
  teamId?: string;
}

export interface LobbySnapshot {
  mode: LobbyMode;
  teamIds?: string[];
  hostPeerId?: SignalingPeerId;
  localPeerId?: SignalingPeerId;
  players: LobbyPlayer[];
}
