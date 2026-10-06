import type { Unsubscribe } from "@/shared/kernel";
import type { MessageId, RoomId, SignalingMessage, SignalingPeerId } from "../types";

/** One inbox per peer. Messages are stored under the recipient (`message.toPeerId`). */
export interface SignalInboxPort {
  addMessage(roomId: RoomId, message: SignalingMessage): Promise<void>;
  deleteMessage(roomId: RoomId, peerId: SignalingPeerId, messageId: MessageId): Promise<void>;
  messageExists(roomId: RoomId, peerId: SignalingPeerId, messageId: MessageId): Promise<boolean>;
  /** Fires once per message added to `peerId`'s inbox, oldest first. */
  subscribeToMessages(
    roomId: RoomId,
    peerId: SignalingPeerId,
    onMessage: (message: SignalingMessage) => void
  ): Unsubscribe;
  clearInbox(roomId: RoomId, peerId: SignalingPeerId): Promise<void>;
}
