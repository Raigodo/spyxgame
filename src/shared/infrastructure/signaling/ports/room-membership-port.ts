import type { Unsubscribe } from "@/shared/kernel";
import type { RoomId, SignalingPeer, SignalingPeerId } from "../types";

export interface RoomMembershipPort {
  createRoom(roomId: RoomId): Promise<void>;
  roomExists(roomId: RoomId): Promise<boolean>;
  addPeer(roomId: RoomId, peerId: SignalingPeerId, joinedAt: Date): Promise<void>;
  removePeer(roomId: RoomId, peerId: SignalingPeerId): Promise<void>;
  peerExists(roomId: RoomId, peerId: SignalingPeerId): Promise<boolean>;
  /** One-shot read, ordered by nothing: used where a fresh server snapshot matters (elections). */
  listPeers(roomId: RoomId): Promise<SignalingPeer[]>;
  /** Fires with the full peer list, ordered by join time, on every change. */
  subscribeToPeers(roomId: RoomId, onChange: (peers: SignalingPeer[]) => void): Unsubscribe;
}
