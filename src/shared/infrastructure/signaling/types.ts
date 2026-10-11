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
