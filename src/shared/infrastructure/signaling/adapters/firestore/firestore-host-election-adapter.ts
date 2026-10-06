import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
  setDoc,
  type DocumentData,
  type Firestore,
} from "firebase/firestore";
import type { Unsubscribe } from "@/shared/kernel";
import type { HostDocument, HostElectionPort } from "../../ports/host-election-port";
import type { RoomId, SignalingPeerId } from "../../types";

export class FirestoreHostElectionAdapter implements HostElectionPort {
  constructor(private readonly client: Firestore) {}

  private hostRef(roomId: RoomId) {
    return doc(this.client, "rooms", roomId, "host", "current");
  }

  private candidatesRef(roomId: RoomId) {
    return collection(this.client, "rooms", roomId, "election-candidates");
  }

  private candidateRef(roomId: RoomId, peerId: SignalingPeerId) {
    return doc(this.client, "rooms", roomId, "election-candidates", peerId);
  }

  async getHost(roomId: RoomId): Promise<HostDocument | null> {
    const snapshot = await getDoc(this.hostRef(roomId));
    return snapshot.exists() ? toHost(snapshot.data()) : null;
  }

  async writeHost(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    await setDoc(this.hostRef(roomId), { signalingPeerId: peerId });
  }

  async clearHost(roomId: RoomId): Promise<void> {
    await deleteDoc(this.hostRef(roomId));
  }

  subscribeToHost(roomId: RoomId, onChange: (host: HostDocument | null) => void): Unsubscribe {
    return onSnapshot(this.hostRef(roomId), (snapshot) =>
      onChange(snapshot.exists() ? toHost(snapshot.data()) : null)
    );
  }

  async registerCandidate(
    roomId: RoomId,
    peerId: SignalingPeerId,
    deadHostPeerId: SignalingPeerId
  ): Promise<void> {
    await setDoc(this.candidateRef(roomId, peerId), { deadHostPeerId });
  }

  async removeCandidate(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    await deleteDoc(this.candidateRef(roomId, peerId));
  }

  async listCandidates(
    roomId: RoomId,
    deadHostPeerId: SignalingPeerId
  ): Promise<SignalingPeerId[]> {
    const snapshot = await getDocs(this.candidatesRef(roomId));
    return snapshot.docs
      .filter((document) => document.data().deadHostPeerId === deadHostPeerId)
      .map((document) => document.id);
  }

  async clearAllCandidates(roomId: RoomId): Promise<void> {
    const snapshot = await getDocs(this.candidatesRef(roomId));
    await Promise.all(snapshot.docs.map((document) => deleteDoc(document.ref)));
  }

  async claimHostIf(
    roomId: RoomId,
    expectedPeerId: SignalingPeerId,
    newPeerId: SignalingPeerId
  ): Promise<boolean> {
    return runTransaction(this.client, async (tx) => {
      const snapshot = await tx.get(this.hostRef(roomId));
      if (!snapshot.exists() || snapshot.data().signalingPeerId !== expectedPeerId) return false;
      tx.set(this.hostRef(roomId), { signalingPeerId: newPeerId });
      return true;
    });
  }
}

function toHost(data: DocumentData): HostDocument {
  return { signalingPeerId: data.signalingPeerId as SignalingPeerId };
}
