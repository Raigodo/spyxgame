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

import type {
  MessageId,
  SignalingPeer,
  SignalingPeerId,
  RoomId,
  SignalingMessage,
} from "./types";
import { HostDocument } from "./firestore-host-service";

interface FirestoreMessage {
  fromPeerId: string;
  timestamp: Timestamp;
  payload: unknown;
}

export class FirestoreGateway {
  public constructor(private readonly client: Firestore) {}

  private roomRef(roomId: RoomId) {
    return doc(this.client, "rooms", roomId);
  }

  private signalingPeersRef(roomId: RoomId) {
    return collection(this.client, "rooms", roomId, "signaling-peers");
  }

  private signalingPeerRef(roomId: RoomId, peerId: SignalingPeerId) {
    return doc(this.client, "rooms", roomId, "signaling-peers", peerId);
  }

  private messagesRef(roomId: RoomId, peerId: SignalingPeerId) {
    return collection(
      this.client,
      "rooms",
      roomId,
      "signaling-peers",
      peerId,
      "messages",
    );
  }

  private messageRef(
    roomId: RoomId,
    peerId: SignalingPeerId,
    messageId: MessageId,
  ) {
    return doc(
      this.client,
      "rooms",
      roomId,
      "signaling-peers",
      peerId,
      "messages",
      messageId,
    );
  }

  async createRoom(roomId: RoomId): Promise<void> {
    await setDoc(
      this.roomRef(roomId),
      {
        createdAt: serverTimestamp(),
      },
      {
        merge: false,
      },
    );
  }

  async roomExists(roomId: RoomId): Promise<boolean> {
    const snapshot = await getDoc(this.roomRef(roomId));

    return snapshot.exists();
  }

  async addSignalingPeer(
    roomId: RoomId,
    peerId: SignalingPeerId,
    peer: Omit<SignalingPeer, "peerId">,
  ): Promise<void> {
    await setDoc(this.signalingPeerRef(roomId, peerId), {
      joinedAt: peer.joinedAt,
    });
  }

  async removeSignalingPeer(
    roomId: RoomId,
    peerId: SignalingPeerId,
  ): Promise<void> {
    await deleteDoc(this.signalingPeerRef(roomId, peerId));
  }

  async getSignalingPeers(roomId: RoomId): Promise<SignalingPeer[]> {
    const snapshot = await getDocs(this.signalingPeersRef(roomId));

    return snapshot.docs.map((document) => {
      const data = document.data();

      return {
        peerId: document.id,
        joinedAt: data.joinedAt.toDate(),
      };
    });
  }

  async signalingPeerExists(
    roomId: RoomId,
    peerId: SignalingPeerId,
  ): Promise<boolean> {
    const snapshot = await getDoc(this.signalingPeerRef(roomId, peerId));

    return snapshot.exists();
  }

  async addMessage(roomId: RoomId, message: SignalingMessage): Promise<void> {
    await setDoc(this.messageRef(roomId, message.toPeerId, message.id), {
      fromPeerId: message.fromPeerId,
      timestamp: Timestamp.fromDate(message.timestamp),
      payload: message.payload,
    });
  }

  subscribeToMessages(
    roomId: RoomId,
    peerId: SignalingPeerId,
    onMessage: (message: SignalingMessage) => void,
  ): Unsubscribe {
    const messagesQuery = query(
      this.messagesRef(roomId, peerId),
      orderBy("timestamp", "asc"),
    );

    return onSnapshot(messagesQuery, (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== "added") {
          continue;
        }

        const data = change.doc.data() as FirestoreMessage;

        onMessage({
          id: change.doc.id,
          fromPeerId: data.fromPeerId,
          toPeerId: peerId,
          timestamp: data.timestamp.toDate(),
          payload: data.payload,
        });
      }
    });
  }

  async deleteMessage(
    roomId: RoomId,
    peerId: SignalingPeerId,
    messageId: MessageId,
  ): Promise<void> {
    await deleteDoc(this.messageRef(roomId, peerId, messageId));
  }

  public async messageExists(
    roomId: RoomId,
    peerId: SignalingPeerId,
    messageId: MessageId,
  ): Promise<boolean> {
    const snapshot = await getDoc(this.messageRef(roomId, peerId, messageId));

    return snapshot.exists();
  }

  subscribeToSignalingPeers(
    roomId: RoomId,
    onSignalingPeers: (peer: SignalingPeer[]) => void,
  ): Unsubscribe {
    const signalingPeersRef = collection(
      this.client,
      "rooms",
      roomId,
      "signaling-peers",
    );

    const signalingPeersQuery = query(
      signalingPeersRef,
      orderBy("joinedAt", "asc"),
    );

    return onSnapshot(
      signalingPeersQuery,
      (snapshot) => {
        const peers: SignalingPeer[] = snapshot.docs.map((doc) => {
          const data = doc.data();

          return {
            peerId: doc.id,
            joinedAt: (data.joinedAt as Timestamp).toDate(),
          };
        });

        onSignalingPeers(peers);
      },
      (error) => {
        console.warn("Failed to subscribe to signaling peers:", error);
      },
    );
  }

  //Host

  async getHostCandidate(roomId: RoomId): Promise<HostDocument | null> {
    const snapshot = await getDoc(this.hostRef(roomId));
    if (!snapshot.exists()) return null;
    const data = snapshot.data();
    return {
      signalingPeerId: data.signalingPeerId,
      nominatedAt: (data.nominatedAt as Timestamp).toDate(),
    };
  }

  private hostRef(roomId: RoomId) {
    return doc(this.client, "rooms", roomId, "host", "current");
  }

  async writeHostCandidate(
    roomId: RoomId,
    peerId: SignalingPeerId,
  ): Promise<void> {
    await setDoc(this.hostRef(roomId), {
      signalingPeerId: peerId,
      nominatedAt: serverTimestamp(),
    });
  }

  async clearHostCandidate(roomId: RoomId): Promise<void> {
    await deleteDoc(this.hostRef(roomId));
  }

  subscribeToHostCandidate(
    roomId: RoomId,
    onChange: (host: HostDocument | null) => void,
  ): Unsubscribe {
    return onSnapshot(this.hostRef(roomId), (snapshot) => {
      if (!snapshot.exists()) {
        onChange(null);
        return;
      }
      const data = snapshot.data();

      if (!data.nominatedAt) {
        console.warn("host niminated at was null, short circuit returned");
        return;
      }

      onChange({
        signalingPeerId: data.signalingPeerId as SignalingPeerId,
        nominatedAt: (data.nominatedAt as Timestamp).toDate(),
      });
    });
  }
}
