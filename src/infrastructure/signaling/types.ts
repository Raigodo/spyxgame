export type SignalType = "offer" | "answer" | "candidate";

export interface SignalPayload {
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export interface IncomingSignal {
  from: string;
  type: SignalType;
  payload: SignalPayload;
}

export interface JoinRoomResult {
  roomId: string;
  peerId: string;
  /** Peers already present in the room when we joined — send offers to these. */
  existingParticipants: string[];
}

/**
 * A participant presence-doc change, as reported by Firestore's snapshot
 * listener. `lastSeenMs` is included on every change type (except it's
 * naturally absent/irrelevant for "removed") so staleness can be tracked
 * without a second read.
 */
export interface ParticipantChange {
  peerId: string;
  type: "added" | "removed" | "modified";
  lastSeenMs: number | null;
}

/** A signal document as stored in Firestore, including its doc id. */
export interface StoredSignal {
  id: string;
  from: string;
  to: string;
  type: SignalType;
  payload: SignalPayload;
}
