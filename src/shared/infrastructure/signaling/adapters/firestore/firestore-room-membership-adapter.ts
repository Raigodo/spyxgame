import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  type DocumentData,
  type Firestore,
} from "firebase/firestore";
import type { Logger, Unsubscribe } from "@/shared/kernel";
import type { RoomMembershipPort } from "../../ports/room-membership-port";
import { expiresAt, type Retention } from "./expiry";
import type { RoomId, SignalingPeer, SignalingPeerId } from "../../types";

export class FirestoreRoomMembershipAdapter implements RoomMembershipPort {
  constructor(
    private readonly client: Firestore,
    private readonly logger: Logger,
    private readonly retention: Retention
  ) {}

  private roomRef(roomId: RoomId) {
    return doc(this.client, "rooms", roomId);
  }

  private peersRef(roomId: RoomId) {
    return collection(this.client, "rooms", roomId, "signaling-peers");
  }

  private peerRef(roomId: RoomId, peerId: SignalingPeerId) {
    return doc(this.client, "rooms", roomId, "signaling-peers", peerId);
  }

  async createRoom(roomId: RoomId): Promise<void> {
    const { clock, config } = this.retention;
    await setDoc(
      this.roomRef(roomId),
      { createdAt: serverTimestamp(), expiresAt: expiresAt(clock, config.roomRetentionMs) },
      { merge: false }
    );
  }

  async roomExists(roomId: RoomId): Promise<boolean> {
    return (await getDoc(this.roomRef(roomId))).exists();
  }

  async addPeer(roomId: RoomId, peerId: SignalingPeerId, joinedAt: Date): Promise<void> {
    const { clock, config } = this.retention;
    await setDoc(this.peerRef(roomId, peerId), {
      joinedAt,
      expiresAt: expiresAt(clock, config.roomRetentionMs, joinedAt.getTime()),
    });
  }

  async removePeer(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    await deleteDoc(this.peerRef(roomId, peerId));
  }

  async peerExists(roomId: RoomId, peerId: SignalingPeerId): Promise<boolean> {
    return (await getDoc(this.peerRef(roomId, peerId))).exists();
  }

  async listPeers(roomId: RoomId): Promise<SignalingPeer[]> {
    const snapshot = await getDocs(this.peersRef(roomId));
    return snapshot.docs.map((document) => toPeer(document.id, document.data()));
  }

  subscribeToPeers(roomId: RoomId, onChange: (peers: SignalingPeer[]) => void): Unsubscribe {
    const peersQuery = query(this.peersRef(roomId), orderBy("joinedAt", "asc"));
    return onSnapshot(
      peersQuery,
      (snapshot) => onChange(snapshot.docs.map((document) => toPeer(document.id, document.data()))),
      (error) => this.logger.warn("Failed to subscribe to peers", error)
    );
  }
}

function toPeer(peerId: SignalingPeerId, data: DocumentData): SignalingPeer {
  return { peerId, joinedAt: (data.joinedAt as Timestamp).toDate() };
}
