import { SignalingPeerId } from "@/shared/infrastructure/signaling";

export interface LobbyPlayer {
  peerId: SignalingPeerId;
  nickname: string;
  ready: boolean;
  teamId?: string;
}

export type LobbyMode = "free-for-all" | "teams";
