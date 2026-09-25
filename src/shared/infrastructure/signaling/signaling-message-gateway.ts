import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";

import type { MessageId, RoomId, SignalingMessage, SignalingPeerId } from "./types";

interface FirestoreMessage {
  fromPeerId: string;
  timestamp: Timestamp;
  payload: unknown;
}

export class SignalingMessageGateway {
  public constructor(private readonly client: Firestore) {}

  private messagesRef(roomId: RoomId, peerId: SignalingPeerId) {
    return collection(this.client, "rooms", roomId, "signaling-peers", peerId, "messages");
  }

  private messageRef(roomId: RoomId, peerId: SignalingPeerId, messageId: MessageId) {
    return doc(this.client, "rooms", roomId, "signaling-peers", peerId, "messages", messageId);
  }

  async addMessage(roomId: RoomId, message: SignalingMessage): Promise<void> {
    await setDoc(this.messageRef(roomId, message.toPeerId, message.id), {
      fromPeerId: message.fromPeerId,
      timestamp: Timestamp.fromDate(message.timestamp),
      payload: message.payload,
    });
  }

  async deleteMessage(
    roomId: RoomId,
    peerId: SignalingPeerId,
    messageId: MessageId
  ): Promise<void> {
    await deleteDoc(this.messageRef(roomId, peerId, messageId));
  }

  async messageExists(
    roomId: RoomId,
    peerId: SignalingPeerId,
    messageId: MessageId
  ): Promise<boolean> {
    const snapshot = await getDoc(this.messageRef(roomId, peerId, messageId));
    return snapshot.exists();
  }

  subscribeToMessages(
    roomId: RoomId,
    peerId: SignalingPeerId,
    onMessage: (message: SignalingMessage) => void
  ): Unsubscribe {
    const messagesQuery = query(this.messagesRef(roomId, peerId), orderBy("timestamp", "asc"));

    return onSnapshot(messagesQuery, (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== "added") continue;

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

  async clearInbox(roomId: RoomId, peerId: SignalingPeerId): Promise<void> {
    const snapshot = await getDocs(this.messagesRef(roomId, peerId));
    await Promise.all(snapshot.docs.map((document) => deleteDoc(document.ref)));
  }
}
