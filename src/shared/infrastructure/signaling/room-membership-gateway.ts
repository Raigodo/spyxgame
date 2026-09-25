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
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";

import type { RoomId, SignalingPeer, SignalingPeerId } from "./types";

export class RoomMembershipGateway {
  public constructor(private readonly client: Firestore) {}

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
    await setDoc(this.roomRef(roomId), { createdAt: serverTimestamp() }, { merge: false });
  }

  async roomExists(roomId: RoomId): Promise<boolean> {
    const snapshot = await getDoc(this.roomRef(roomId));
    return snapshot.exists();
  }

  async addPeer(
    roomId: RoomId,
    peerId: SignalingPeerId,
    peer: Omit<SignalingPeer, "peerId">
  ): Promise<void> {
    await setDoc(this.peerRef(roomId, peerId), { joinedAt: peer.joinedAt });
  }

  async removePeer(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    await deleteDoc(this.peerRef(roomId, peerId));
  }

  async peerExists(roomId: RoomId, peerId: SignalingPeerId): Promise<boolean> {
    const snapshot = await getDoc(this.peerRef(roomId, peerId));
    return snapshot.exists();
  }

  // One-shot fetch — used wherever a fresh server snapshot matters more
  // than reactive updates (e.g. host election ordering, which needs every
  // client to see the same peer set at read time).
  async listPeers(roomId: RoomId): Promise<SignalingPeer[]> {
    const snapshot = await getDocs(this.peersRef(roomId));
    return snapshot.docs.map((document) => {
      const data = document.data();
      return {
        peerId: document.id,
        joinedAt: (data.joinedAt as Timestamp).toDate(),
      };
    });
  }

  subscribeToPeers(roomId: RoomId, onChange: (peers: SignalingPeer[]) => void): Unsubscribe {
    const peersQuery = query(this.peersRef(roomId), orderBy("joinedAt", "asc"));

    return onSnapshot(
      peersQuery,
      (snapshot) => {
        const peers: SignalingPeer[] = snapshot.docs.map((document) => {
          const data = document.data();
          return {
            peerId: document.id,
            joinedAt: (data.joinedAt as Timestamp).toDate(),
          };
        });
        onChange(peers);
      },
      (error) => {
        console.warn("[RoomMembershipGateway] Failed to subscribe to peers:", error);
      }
    );
  }
}
