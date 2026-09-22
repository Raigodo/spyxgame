import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  Timestamp,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";

import type { RoomId, SignalingPeerId } from "./types";

export interface HostDocument {
  signalingPeerId: SignalingPeerId;
  nominatedAt: Date;
}

export class HostElectionGateway {
  public constructor(private readonly client: Firestore) {}

  private hostRef(roomId: RoomId) {
    return doc(this.client, "rooms", roomId, "host", "current");
  }

  private candidatesRef(roomId: RoomId) {
    return collection(this.client, "rooms", roomId, "election-candidates");
  }

  private candidateRef(roomId: RoomId, peerId: SignalingPeerId) {
    return doc(this.client, "rooms", roomId, "election-candidates", peerId);
  }

  // ─── Host document ────────────────────────────────────────────────────────

  async getHost(roomId: RoomId): Promise<HostDocument | null> {
    const snapshot = await getDoc(this.hostRef(roomId));
    if (!snapshot.exists()) return null;
    const data = snapshot.data();
    return {
      signalingPeerId: data.signalingPeerId,
      nominatedAt: data.nominatedAt
        ? (data.nominatedAt as Timestamp).toDate()
        : new Date(),
    };
  }

  async writeHost(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    // Timestamp.now() (client-generated) is available immediately, even in
    // the local pending write — unlike serverTimestamp(), which resolves to
    // null until the server round-trip completes.
    await setDoc(this.hostRef(roomId), {
      signalingPeerId: peerId,
      nominatedAt: Timestamp.now(),
    });
  }

  async clearHost(roomId: RoomId): Promise<void> {
    await deleteDoc(this.hostRef(roomId));
  }

  subscribeToHost(
    roomId: RoomId,
    onChange: (host: HostDocument | null) => void,
  ): Unsubscribe {
    return onSnapshot(this.hostRef(roomId), (snapshot) => {
      if (!snapshot.exists()) {
        onChange(null);
        return;
      }
      const data = snapshot.data();
      onChange({
        signalingPeerId: data.signalingPeerId as SignalingPeerId,
        nominatedAt: data.nominatedAt
          ? (data.nominatedAt as Timestamp).toDate()
          : new Date(),
      });
    });
  }

  // ─── Election candidates ──────────────────────────────────────────────────

  // Doc id is the candidate's own peer id, so a later registration (for a
  // later death) always overwrites the previous one — no cleanup pass needed.
  async registerCandidate(
    roomId: RoomId,
    peerId: SignalingPeerId,
    deadHostPeerId: SignalingPeerId,
  ): Promise<void> {
    await setDoc(this.candidateRef(roomId, peerId), { deadHostPeerId });
  }

  async removeCandidate(
    roomId: RoomId,
    peerId: SignalingPeerId,
  ): Promise<void> {
    await deleteDoc(this.candidateRef(roomId, peerId));
  }

  // One-shot fetch — every client calling this around the same time sees
  // the same server snapshot, which is what makes election ordering
  // converge instead of diverging per-client.
  async listCandidates(
    roomId: RoomId,
    deadHostPeerId: SignalingPeerId,
  ): Promise<SignalingPeerId[]> {
    const snapshot = await getDocs(this.candidatesRef(roomId));
    return snapshot.docs
      .filter((document) => document.data().deadHostPeerId === deadHostPeerId)
      .map((document) => document.id as SignalingPeerId);
  }
}
