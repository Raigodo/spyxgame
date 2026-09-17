export type RoomId = string;
export type PeerId = string;
export type MessageId = string;

export interface Participant {
  peerId: PeerId;
  joinedAt: Date;
}

export interface SignalingMessage<T = unknown> {
  id: MessageId;
  fromPeerId: PeerId;
  toPeerId: PeerId;
  timestamp: Date;
  payload: T;
}

export interface SendMessageInput<T = unknown> {
  fromPeerId: PeerId;
  toPeerId: PeerId;
  payload: T;
}

export interface MessageHandler<T = unknown> {
  handle(message: SignalingMessage<T>): Promise<void>;
}

export type WebRtcSignal =
  | {
      type: "offer";
      sdp: string;
    }
  | {
      type: "answer";
      sdp: string;
    }
  | {
      type: "ice-candidate";
      candidate: RTCIceCandidateInit;
    };
