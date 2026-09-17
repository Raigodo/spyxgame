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
  where,
  type Firestore,
  type Unsubscribe,
} from "firebase/firestore";

import type {
  MessageId,
  Participant,
  PeerId,
  RoomId,
  SignalingMessage,
} from "./types";

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

  private participantsRef(roomId: RoomId) {
    return collection(this.client, "rooms", roomId, "participants");
  }

  private participantRef(roomId: RoomId, peerId: PeerId) {
    return doc(this.client, "rooms", roomId, "participants", peerId);
  }

  private messagesRef(roomId: RoomId, peerId: PeerId) {
    return collection(
      this.client,
      "rooms",
      roomId,
      "participants",
      peerId,
      "messages",
    );
  }

  private messageRef(roomId: RoomId, peerId: PeerId, messageId: MessageId) {
    return doc(
      this.client,
      "rooms",
      roomId,
      "participants",
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

  async addParticipant(
    roomId: RoomId,
    peerId: PeerId,
    participant: Omit<Participant, "peerId">,
  ): Promise<void> {
    await setDoc(this.participantRef(roomId, peerId), {
      joinedAt: participant.joinedAt,
    });
  }

  async removeParticipant(roomId: RoomId, peerId: PeerId): Promise<void> {
    await deleteDoc(this.participantRef(roomId, peerId));
  }

  async getParticipants(roomId: RoomId): Promise<Participant[]> {
    const snapshot = await getDocs(this.participantsRef(roomId));

    return snapshot.docs.map((document) => {
      const data = document.data();

      return {
        peerId: document.id,
        joinedAt: data.joinedAt.toDate(),
      };
    });
  }

  async participantExists(roomId: RoomId, peerId: PeerId): Promise<boolean> {
    const snapshot = await getDoc(this.participantRef(roomId, peerId));

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
    peerId: PeerId,
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
    peerId: PeerId,
    messageId: MessageId,
  ): Promise<void> {
    await deleteDoc(this.messageRef(roomId, peerId, messageId));
  }

  public async messageExists(
    roomId: RoomId,
    participantId: PeerId,
    messageId: MessageId,
  ): Promise<boolean> {
    const snapshot = await getDoc(
      this.messageRef(roomId, participantId, messageId),
    );

    return snapshot.exists();
  }

  subscribeToParticipants(
    roomId: RoomId,
    onParticipants: (participants: Participant[]) => void,
  ): Unsubscribe {
    const participantsRef = collection(
      this.client,
      "rooms",
      roomId,
      "participants",
    );

    const participantsQuery = query(
      participantsRef,
      orderBy("joinedAt", "asc"),
    );

    return onSnapshot(participantsQuery, (snapshot) => {
      const participants: Participant[] = snapshot.docs.map((doc) => {
        const data = doc.data();

        return {
          peerId: doc.id,
          joinedAt: (data.joinedAt as Timestamp).toDate(),
        };
      });

      onParticipants(participants);
    });
  }
}
