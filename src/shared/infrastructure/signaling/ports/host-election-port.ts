import type { Unsubscribe } from "@/shared/kernel";
import type { RoomId, SignalingPeerId } from "../types";

export interface HostDocument {
  signalingPeerId: SignalingPeerId;
}

export interface HostElectionPort {
  getHost(roomId: RoomId): Promise<HostDocument | null>;
  /** Unconditional write: last writer wins. */
  writeHost(roomId: RoomId, peerId: SignalingPeerId): Promise<void>;
  clearHost(roomId: RoomId): Promise<void>;
  subscribeToHost(roomId: RoomId, onChange: (host: HostDocument | null) => void): Unsubscribe;

  /** Doc id is the candidate's own peer id, so a later death overwrites the earlier registration. */
  registerCandidate(
    roomId: RoomId,
    peerId: SignalingPeerId,
    deadHostPeerId: SignalingPeerId
  ): Promise<void>;
  removeCandidate(roomId: RoomId, peerId: SignalingPeerId): Promise<void>;
  /** One-shot read, so every client calling it around the same time sees the same snapshot. */
  listCandidates(roomId: RoomId, deadHostPeerId: SignalingPeerId): Promise<SignalingPeerId[]>;
  clearAllCandidates(roomId: RoomId): Promise<void>;

  /** Atomic: writes the host only if the document still names `expectedPeerId`. */
  claimHostIf(
    roomId: RoomId,
    expectedPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): Promise<boolean>;
}
