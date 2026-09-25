import { SignalingPeerId } from "../signaling";

export interface PlayerProfile {
  peerId: SignalingPeerId;
  nickname: string;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface LocalProfileInput {
  nickname: string;
  metadata?: Record<string, unknown>;
}

export interface StoredIdentity {
  peerId: string;
  nickname: string;
}
