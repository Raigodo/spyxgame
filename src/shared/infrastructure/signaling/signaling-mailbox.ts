import type { Clock, IdGenerator, Logger } from "@/shared/kernel";
import type { SignalInboxPort } from "./ports/signal-inbox-port";
import type { RoomId, SignalingMessage, SignalingPeerId } from "./types";

export interface SignalingMailboxDeps {
  inbox: SignalInboxPort;
  ids: IdGenerator;
  clock: Clock;
  logger: Logger;
  roomId: RoomId;
  localPeerId: SignalingPeerId;
}

export class SignalingMailbox {
  private unsubscribeFromMessages?: () => void;

  constructor(private readonly deps: SignalingMailboxDeps) {}

  async send<T>(
    message: Omit<SignalingMessage<T>, "timestamp" | "fromPeerId" | "id">
  ): Promise<SignalingMessage> {
    const enhancedMessage = {
      ...message,
      id: this.deps.ids.next(),
      timestamp: new Date(this.deps.clock.now()),
      fromPeerId: this.deps.localPeerId,
    };
    await this.deps.inbox.addMessage(this.deps.roomId, enhancedMessage);
    return enhancedMessage;
  }

  /** Calls `onMessage` for each incoming message, then deletes it. A throwing handler leaves it in place. */
  startReceivingFor(peerId: SignalingPeerId, onMessage: (message: SignalingMessage) => void): void {
    this.stopReceiving();

    this.unsubscribeFromMessages = this.deps.inbox.subscribeToMessages(
      this.deps.roomId,
      peerId,
      (message) => void this.handleReceivedMessage(peerId, onMessage, message)
    );
  }

  stopReceiving(): void {
    this.unsubscribeFromMessages?.();
    this.unsubscribeFromMessages = undefined;
  }

  async isMessageStillPending(
    message: Pick<SignalingMessage, "toPeerId" | "id">
  ): Promise<boolean> {
    return this.deps.inbox.messageExists(this.deps.roomId, message.toPeerId, message.id);
  }

  private async handleReceivedMessage(
    peerId: SignalingPeerId,
    onMessage: (message: SignalingMessage) => void,
    message: SignalingMessage
  ): Promise<void> {
    try {
      onMessage(message);
      await this.deps.inbox.deleteMessage(this.deps.roomId, peerId, message.id);
    } catch (error) {
      this.deps.logger.warn(`Failed to handle signaling message "${message.id}"`, error);
    }
  }
}
