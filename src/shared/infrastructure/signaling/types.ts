export type RoomId = string;
export type SignalingPeerId = string;
export type MessageId = string;

export interface SignalingPeer {
  peerId: SignalingPeerId;
  joinedAt: Date;
}

export interface SignalingMessage<T = unknown> {
  id: MessageId;
  fromPeerId: SignalingPeerId;
  toPeerId: SignalingPeerId;
  timestamp: Date;
  payload: T;
}

export interface SendMessageInput<T = unknown> {
  fromPeerId: SignalingPeerId;
  toPeerId: SignalingPeerId;
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
