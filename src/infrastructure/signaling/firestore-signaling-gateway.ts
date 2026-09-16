import {
  Firestore,
  collection,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  addDoc,
  getDocs,
  serverTimestamp,
  Timestamp,
  Unsubscribe,
} from "firebase/firestore";
import {
  ParticipantChange,
  StoredSignal,
  SignalType,
  SignalPayload,
} from "./types";

/** Strips `undefined` values — Firestore rejects them, but RTCIceCandidate/session objects can carry them. */
function sanitizeForFirestore<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function toMillis(value: unknown): number | null {
  return value instanceof Timestamp ? value.toMillis() : null;
}

/**
 * The only class that imports from `firebase/firestore`. Pure CRUD +
 * listeners — no opinion on what "joining", "leaving", or "stale" means.
 * That business logic lives in ParticipantTracker / HeartbeatTracker / the
 * root FirestoreSignalingService.
 */
export class FirestoreSignalingGateway {
  constructor(private readonly firestore: Firestore) {}

  private participantsRef(roomId: string) {
    return collection(this.firestore, "rooms", roomId, "participants");
  }

  private signalsRef(roomId: string) {
    return collection(this.firestore, "rooms", roomId, "signals");
  }

  /** Reads every participant currently on record, with their last known heartbeat. */
  async getParticipants(
    roomId: string,
  ): Promise<{ peerId: string; lastSeenMs: number | null }[]> {
    const snapshot = await getDocs(this.participantsRef(roomId));
    return snapshot.docs.map((d) => ({
      peerId: d.id,
      lastSeenMs: toMillis(d.data()?.lastSeen),
    }));
  }

  async registerParticipant(roomId: string, peerId: string): Promise<void> {
    await setDoc(doc(this.participantsRef(roomId), peerId), {
      peerId,
      joinedAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    });
  }

  async touchParticipant(roomId: string, peerId: string): Promise<void> {
    await updateDoc(doc(this.participantsRef(roomId), peerId), {
      lastSeen: serverTimestamp(),
    });
  }

  async removeParticipant(roomId: string, peerId: string): Promise<void> {
    await deleteDoc(doc(this.participantsRef(roomId), peerId));
  }

  watchParticipants(
    roomId: string,
    onChange: (change: ParticipantChange) => void,
  ): Unsubscribe {
    return onSnapshot(this.participantsRef(roomId), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        onChange({
          peerId: change.doc.id,
          type: change.type,
          lastSeenMs: toMillis(change.doc.data()?.lastSeen),
        });
      });
    });
  }

  async sendSignal(
    roomId: string,
    signal: {
      from: string;
      to: string;
      type: SignalType;
      payload: SignalPayload;
    },
  ): Promise<void> {
    await addDoc(this.signalsRef(roomId), {
      ...signal,
      payload: sanitizeForFirestore(signal.payload),
      createdAt: serverTimestamp(),
    });
  }

  /**
   * Listens for signals addressed to `peerId`. Each one is a one-time
   * mailbox message: it's deleted right after `onSignal` fires so the
   * collection doesn't grow forever.
   */
  watchSignalsFor(
    roomId: string,
    peerId: string,
    onSignal: (signal: StoredSignal) => void,
  ): Unsubscribe {
    const inbox = query(this.signalsRef(roomId), where("to", "==", peerId));

    return onSnapshot(inbox, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added") return;

        const data = change.doc.data();
        onSignal({
          id: change.doc.id,
          from: data.from,
          to: data.to,
          type: data.type,
          payload: data.payload,
        });

        deleteDoc(change.doc.ref).catch(() => {
          /* not critical if cleanup fails */
        });
      });
    });
  }

  /**
   * Deletes any undelivered signals addressed to `peerId` — used once
   * they've left or gone stale, so messages nobody will ever read (e.g. an
   * offer sent mid-handshake to a peer that crashed) don't linger forever.
   */
  async clearInboxFor(roomId: string, peerId: string): Promise<void> {
    const inbox = query(this.signalsRef(roomId), where("to", "==", peerId));
    const snapshot = await getDocs(inbox);
    await Promise.all(snapshot.docs.map((d) => deleteDoc(d.ref)));
  }
}
